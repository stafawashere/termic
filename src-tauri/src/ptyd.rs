// The PTY daemon: agent PTYs that outlive the app (docs/plans/pty-daemon.md).
//
// The same binary, started as `termic --ptyd <socket>`. It owns the PTYs the
// app hands it, keeps each one's last 4 MiB of output in a ring, and serves
// them over one local socket per data dir, so `termic`, `termic_dev` and every
// `TERMIC_DATA_DIR` get their own daemon. Quitting the app closes the
// connection and nothing else: the agents keep running, and the next launch
// subscribes again and gets the ring followed by live output.
//
// Wire format: a 4-byte big-endian length, one kind byte, then the payload.
// Control messages are JSON; PTY output and input are raw bytes behind a
// one-byte id length and the id, so nothing is JSON-escaped at firehose rates.
// Messages are additive only. An incompatible change bumps `PTYD_PROTO`, and an
// app that meets an older daemon leaves it running and starts its own on
// `ptyd-v<N>.sock`.

use crate::pty_core::{PtyPump, PtyRing, PtySink, PTY_COALESCE};
use crate::dlog;
use parking_lot::{Condvar, Mutex};
use portable_pty::{CommandBuilder, MasterPty, NativePtySystem, PtySize, PtySystem};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, SyncSender};
use std::sync::{Arc, Weak};
use std::thread;
use std::time::{Duration, Instant};
use termic_proto::local::{self, Listener, Stream};

/// Version of the daemon protocol, independent of termic-proto's
/// `PROTOCOL_VERSION` (the CLI's). Bump only for a change an older peer cannot
/// ignore; a new message or field does not need one.
pub(crate) const PTYD_PROTO: u32 = 1;

/// argv[1] that turns the app binary into the daemon.
pub(crate) const PTYD_ARG: &str = "--ptyd";

/// How long the daemon stays up with no PTY and no client before it exits.
const IDLE_GRACE: Duration = Duration::from_secs(30);

/// Anything larger is a corrupt length, not a frame. A full ring snapshot is
/// 4 MiB.
const MAX_FRAME: usize = 64 * 1024 * 1024;

/// Frames queued for one client. A client that stops reading for this many
/// frames is cut off rather than buffered without bound; reconnecting and
/// subscribing again gets it the ring.
const CONN_DEPTH: usize = 4096;

const HELLO_TIMEOUT: Duration = Duration::from_secs(10);
const CALL_TIMEOUT: Duration = Duration::from_secs(15);

const KIND_JSON: u8 = 0;
const KIND_DATA: u8 = 1;
const KIND_SNAPSHOT: u8 = 2;

pub(crate) fn socket_path(global: &Path) -> PathBuf {
    global.join("ptyd.sock")
}

/// Where this build's daemon lives when `ptyd.sock` is held by a daemon that
/// speaks another protocol.
pub(crate) fn versioned_socket_path(global: &Path) -> PathBuf {
    global.join(format!("ptyd-v{PTYD_PROTO}.sock"))
}

/// The daemon's per-launch credential, next to its socket. Required on every
/// connection: on Windows the transport is loopback TCP with no peer identity,
/// and a daemon that spawns processes must not take orders from another local
/// account.
pub(crate) fn token_path(socket: &Path) -> PathBuf {
    socket.with_extension("token")
}

// ───────────────────────────── framing ─────────────────────────────

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Frame {
    Json(Value),
    /// Daemon to app: PTY output. App to daemon: input for the PTY.
    Data { id: String, bytes: Vec<u8> },
    /// Daemon to app: the ring, sent once per subscribe, before its reply.
    Snapshot { id: String, bytes: Vec<u8> },
}

pub(crate) fn encode_frame(frame: &Frame) -> Vec<u8> {
    let mut body = Vec::new();
    match frame {
        Frame::Json(value) => {
            body.push(KIND_JSON);
            body.extend(serde_json::to_vec(value).unwrap_or_default());
        }
        Frame::Data { id, bytes } | Frame::Snapshot { id, bytes } => {
            let kind = if matches!(frame, Frame::Data { .. }) { KIND_DATA } else { KIND_SNAPSHOT };
            body.push(kind);
            body.push(id.len() as u8);
            body.extend(id.as_bytes());
            body.extend(bytes);
        }
    }
    let mut out = (body.len() as u32).to_be_bytes().to_vec();
    out.extend(body);
    out
}

fn invalid(msg: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, msg.to_string())
}

pub(crate) fn read_frame(reader: &mut impl Read) -> io::Result<Frame> {
    let mut len = [0u8; 4];
    reader.read_exact(&mut len)?;
    let len = u32::from_be_bytes(len) as usize;
    let is_bad_length = len == 0 || len > MAX_FRAME;
    if is_bad_length {
        return Err(invalid("bad frame length"));
    }
    let mut body = vec![0u8; len];
    reader.read_exact(&mut body)?;
    let kind = body[0];
    if kind == KIND_JSON {
        let value = serde_json::from_slice(&body[1..]).map_err(|_| invalid("bad json frame"))?;
        return Ok(Frame::Json(value));
    }
    let id_len = *body.get(1).ok_or_else(|| invalid("short frame"))? as usize;
    let id_end = 2 + id_len;
    if body.len() < id_end {
        return Err(invalid("short frame"));
    }
    let id = String::from_utf8(body[2..id_end].to_vec()).map_err(|_| invalid("bad id"))?;
    let bytes = body[id_end..].to_vec();
    match kind {
        KIND_DATA => Ok(Frame::Data { id, bytes }),
        KIND_SNAPSHOT => Ok(Frame::Snapshot { id, bytes }),
        _ => Err(invalid("unknown frame kind")),
    }
}

fn reply_ok(req: u64, mut fields: Value) -> Frame {
    if !fields.is_object() {
        fields = json!({});
    }
    fields["req"] = json!(req);
    fields["ok"] = json!(true);
    Frame::Json(fields)
}

fn reply_err(req: u64, error: impl Into<String>) -> Frame {
    Frame::Json(json!({ "req": req, "ok": false, "error": error.into() }))
}

// ───────────────────────────── spawn spec ─────────────────────────────

/// A finished spawn: the app has already resolved argv, env and cwd exactly as
/// it would for its own PTY, so the daemon decides nothing about the agent.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub(crate) struct SpawnSpec {
    /// Minted by the app, which names Docker containers after it before the
    /// spawn exists.
    pub id: String,
    pub argv: Vec<String>,
    pub cwd: String,
    /// The COMPLETE environment. The daemon's own is not inherited: it was
    /// whatever the app had when it launched the daemon, possibly days ago.
    pub env: Vec<(String, String)>,
    pub rows: u16,
    pub cols: u16,
    /// Export this PTY's slave path as `TERMIC_PTY`, which only the process
    /// that opened the PTY can know.
    #[serde(default)]
    pub set_termic_pty: bool,
    /// Report when sudo becomes the foreground job, for the Touch ID offer.
    #[serde(default)]
    pub sudo_watch: bool,
    /// Opaque to the daemon. The app stores what it needs to adopt the PTY
    /// again after a relaunch (task, tab, role) and reads it back from `list`.
    #[serde(default)]
    pub meta: Value,
}

// ───────────────────────────── daemon ─────────────────────────────

pub(crate) struct DaemonOptions {
    pub token: String,
}

#[derive(Default)]
struct Occupancy {
    clients: usize,
    live: usize,
}

impl Occupancy {
    fn busy(&self) -> bool {
        self.clients > 0 || self.live > 0
    }
}

pub(crate) struct Daemon {
    ptys: Mutex<HashMap<String, Arc<DaemonPty>>>,
    occupancy: Mutex<Occupancy>,
    occupancy_changed: Condvar,
    token: String,
    next_conn: AtomicU64,
}

struct DaemonPty {
    pid: Option<u32>,
    meta: Value,
    started_ms: u64,
    /// To this PTY's writer thread. A PTY whose foreground process stopped
    /// reading blocks its own writes and nobody else's.
    input: mpsc::Sender<Vec<u8>>,
    master: Mutex<Box<dyn MasterPty + Send>>,
    out: Arc<Mutex<PtyOutput>>,
    killed: AtomicBool,
}

struct PtyOutput {
    ring: PtyRing,
    subscribers: Vec<Arc<Conn>>,
    /// `Some(code)` once the process has exited. An exit nobody was
    /// subscribed for is kept until a client picks it up.
    exit: Option<Option<i32>>,
}

struct Conn {
    id: u64,
    tx: SyncSender<Frame>,
    stream: Stream,
}

impl Conn {
    /// Queue a frame. A client too far behind is disconnected instead of
    /// buffered: it learns from the EOF, and a resubscribe gets it the ring.
    fn send(&self, frame: Frame) -> bool {
        let queued = self.tx.try_send(frame).is_ok();
        if !queued {
            let _ = self.stream.shutdown(std::net::Shutdown::Both);
        }
        queued
    }
}

struct DaemonSink {
    id: String,
    out: Arc<Mutex<PtyOutput>>,
    daemon: Weak<Daemon>,
}

impl PtySink for DaemonSink {
    fn output(&self, data: Vec<u8>) {
        let mut out = self.out.lock();
        out.ring.push(&data);
        let id = &self.id;
        out.subscribers
            .retain(|conn| conn.send(Frame::Data { id: id.clone(), bytes: data.clone() }));
    }

    fn exit(&self, code: Option<i32>) {
        let delivered = {
            let mut out = self.out.lock();
            out.exit = Some(code);
            let event = json!({ "event": "exit", "id": self.id, "code": code });
            for conn in &out.subscribers {
                conn.send(Frame::Json(event.clone()));
            }
            let delivered = !out.subscribers.is_empty();
            out.subscribers.clear();
            delivered
        };
        if let Some(daemon) = self.daemon.upgrade() {
            daemon.pty_ended(&self.id, delivered);
        }
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

impl Daemon {
    fn new(token: String) -> Arc<Self> {
        Arc::new(Daemon {
            ptys: Mutex::new(HashMap::new()),
            occupancy: Mutex::new(Occupancy::default()),
            occupancy_changed: Condvar::new(),
            token,
            next_conn: AtomicU64::new(1),
        })
    }

    fn change_occupancy(&self, change: impl FnOnce(&mut Occupancy)) {
        let mut occupancy = self.occupancy.lock();
        change(&mut occupancy);
        self.occupancy_changed.notify_all();
    }

    /// Block until the daemon has had no PTY and no client for `grace`. One
    /// timer, armed when the daemon goes idle and abandoned the moment it is
    /// not; while busy this parks on the condvar and costs no wakeups.
    pub(crate) fn wait_until_idle(&self, grace: Duration) {
        let mut occupancy = self.occupancy.lock();
        loop {
            while occupancy.busy() {
                self.occupancy_changed.wait(&mut occupancy);
            }
            let deadline = Instant::now() + grace;
            while !occupancy.busy() {
                let now = Instant::now();
                if now >= deadline {
                    return;
                }
                self.occupancy_changed.wait_for(&mut occupancy, deadline - now);
            }
        }
    }

    fn pty_ended(&self, id: &str, delivered: bool) {
        {
            let mut ptys = self.ptys.lock();
            let killed = ptys.get(id).map(|p| p.killed.load(Ordering::Acquire)).unwrap_or(false);
            let nobody_needs_it = delivered || killed;
            if nobody_needs_it {
                ptys.remove(id);
            }
        }
        self.change_occupancy(|o| o.live = o.live.saturating_sub(1));
    }

    fn get(&self, id: &str) -> Result<Arc<DaemonPty>, String> {
        self.ptys.lock().get(id).cloned().ok_or_else(|| format!("no such pty: {id}"))
    }

    fn spawn(self: &Arc<Self>, spec: SpawnSpec) -> Result<Value, String> {
        let is_bad_id = spec.id.is_empty() || spec.id.len() > 255;
        if is_bad_id {
            return Err("bad pty id".into());
        }
        if self.ptys.lock().contains_key(&spec.id) {
            return Err(format!("pty {} already exists", spec.id));
        }
        let program = spec.argv.first().ok_or("empty argv")?;
        let pair = NativePtySystem::default()
            .openpty(PtySize { rows: spec.rows, cols: spec.cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| e.to_string())?;
        let mut cmd = CommandBuilder::new(program);
        for arg in &spec.argv[1..] {
            cmd.arg(arg);
        }
        cmd.env_clear();
        for (key, value) in &spec.env {
            cmd.env(key, value);
        }
        cmd.cwd(&spec.cwd);
        if spec.set_termic_pty {
            if let Some(path) = crate::pty_slave_path(&pair.master) {
                cmd.env("TERMIC_PTY", path);
            }
        }
        let mut child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
        let pid = child.process_id();
        drop(pair.slave);
        let master = pair.master;
        let reader = master.try_clone_reader().map_err(|e| e.to_string())?;
        let mut writer = master.take_writer().map_err(|e| e.to_string())?;
        dlog(&format!("[ptyd] spawned {} pid={pid:?} argv0={program}", spec.id));

        #[cfg(target_os = "macos")]
        let mut sudo_watch = if spec.sudo_watch {
            master.as_raw_fd().and_then(crate::sudo_touchid::SudoWatch::new)
        } else {
            None
        };
        #[cfg(not(target_os = "macos"))]
        let mut sudo_watch: Option<crate::sudo_touchid::SudoWatch> = None;

        let out = Arc::new(Mutex::new(PtyOutput {
            ring: PtyRing::with_cap(PtyRing::DAEMON_CAP),
            subscribers: Vec::new(),
            exit: None,
        }));
        let sink: Arc<dyn PtySink> = Arc::new(DaemonSink {
            id: spec.id.clone(),
            out: out.clone(),
            daemon: Arc::downgrade(self),
        });
        // The ring always listens, so there is no webview to wait for.
        let pump = PtyPump::new();
        pump.mark_attached();

        let (input, input_rx) = mpsc::channel::<Vec<u8>>();
        thread::spawn(move || {
            for bytes in input_rx {
                let written = writer.write_all(&bytes).and_then(|_| writer.flush());
                if written.is_err() {
                    break;
                }
            }
        });

        self.ptys.lock().insert(
            spec.id.clone(),
            Arc::new(DaemonPty {
                pid,
                meta: spec.meta.clone(),
                started_ms: now_ms(),
                input,
                master: Mutex::new(master),
                out: out.clone(),
                killed: AtomicBool::new(false),
            }),
        );
        self.change_occupancy(|o| o.live += 1);

        let pump_r = pump.clone();
        let sink_r = sink.clone();
        let out_r = out;
        let id_r = spec.id.clone();
        thread::spawn(move || {
            pump_r.run_reader(
                reader,
                sink_r.as_ref(),
                |chunk| {
                    if let Some(show) = sudo_watch.as_mut().and_then(|w| w.on_read(chunk.len())) {
                        let event = json!({ "event": "sudo", "id": id_r, "show": show });
                        for conn in &out_r.lock().subscribers {
                            conn.send(Frame::Json(event.clone()));
                        }
                    }
                },
                || {},
            );
        });
        pump.spawn_flusher(sink.clone(), PTY_COALESCE);

        let id_w = spec.id.clone();
        thread::spawn(move || {
            let status = child.wait().ok();
            let code = status.and_then(|s| i32::try_from(s.exit_code()).ok());
            dlog(&format!("[ptyd] {id_w} exited code={code:?}"));
            pump.wait_done();
            sink.exit(code);
        });

        Ok(json!({ "id": spec.id, "pid": pid }))
    }

    fn write(&self, id: &str, bytes: Vec<u8>) {
        if let Ok(pty) = self.get(id) {
            let _ = pty.input.send(bytes);
        }
    }

    fn list(&self) -> Value {
        let ptys = self.ptys.lock();
        let rows: Vec<Value> = ptys
            .iter()
            .map(|(id, pty)| {
                let exit = pty.out.lock().exit;
                json!({
                    "id": id,
                    "pid": pty.pid,
                    "meta": pty.meta,
                    "started_ms": pty.started_ms,
                    "alive": exit.is_none(),
                    "exit_code": exit.flatten(),
                })
            })
            .collect();
        json!({ "ptys": rows })
    }

    fn kill(&self, id: &str) {
        let Ok(pty) = self.get(id) else { return };
        pty.killed.store(true, Ordering::Release);
        let already_exited = pty.out.lock().exit.is_some();
        if already_exited {
            self.ptys.lock().remove(id);
            return;
        }
        if let Some(pid) = pty.pid {
            crate::proc_ctl::signal_pid(pid as i32, crate::proc_ctl::Sig::Kill);
        }
    }

    fn subscribe(&self, conn: &Arc<Conn>, req: u64, id: &str) {
        let pty = match self.get(id) {
            Ok(pty) => pty,
            Err(e) => {
                conn.send(reply_err(req, e));
                return;
            }
        };
        let exited = {
            let mut out = pty.out.lock();
            let (snapshot, truncated) = out.ring.tail(usize::MAX);
            // Snapshot, reply and registration under ONE lock with the sink's
            // ring append, so the client gets every byte exactly once.
            conn.send(Frame::Snapshot { id: id.to_string(), bytes: snapshot });
            conn.send(reply_ok(req, json!({ "truncated": truncated, "pid": pty.pid })));
            match out.exit {
                Some(code) => {
                    conn.send(Frame::Json(json!({ "event": "exit", "id": id, "code": code })));
                    true
                }
                None => {
                    let already = out.subscribers.iter().any(|c| c.id == conn.id);
                    if !already {
                        out.subscribers.push(conn.clone());
                    }
                    false
                }
            }
        };
        if exited {
            self.ptys.lock().remove(id);
        }
    }

    fn unsubscribe(&self, conn: &Conn, id: &str) {
        if let Ok(pty) = self.get(id) {
            pty.out.lock().subscribers.retain(|c| c.id != conn.id);
        }
    }

    fn forget_conn(&self, conn: &Conn) {
        let ptys: Vec<Arc<DaemonPty>> = self.ptys.lock().values().cloned().collect();
        for pty in ptys {
            pty.out.lock().subscribers.retain(|c| c.id != conn.id);
        }
    }

    fn resize(&self, id: &str, rows: u16, cols: u16) -> Result<(), String> {
        let pty = self.get(id)?;
        let master = pty.master.lock();
        master
            .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| e.to_string())
    }

    fn dispatch(self: &Arc<Self>, conn: &Arc<Conn>, msg: Value) {
        let req = msg["req"].as_u64().unwrap_or(0);
        let id = msg["id"].as_str().unwrap_or_default().to_string();
        match msg["op"].as_str().unwrap_or_default() {
            "spawn" => {
                let reply = serde_json::from_value::<SpawnSpec>(msg["spec"].clone())
                    .map_err(|e| format!("bad spawn spec: {e}"))
                    .and_then(|spec| self.spawn(spec));
                conn.send(match reply {
                    Ok(fields) => reply_ok(req, fields),
                    Err(e) => reply_err(req, e),
                });
            }
            "resize" => {
                let rows = msg["rows"].as_u64().unwrap_or(24) as u16;
                let cols = msg["cols"].as_u64().unwrap_or(80) as u16;
                conn.send(match self.resize(&id, rows, cols) {
                    Ok(()) => reply_ok(req, json!({})),
                    Err(e) => reply_err(req, e),
                });
            }
            "kill" => {
                self.kill(&id);
                conn.send(reply_ok(req, json!({})));
            }
            "list" => {
                conn.send(reply_ok(req, self.list()));
            }
            "subscribe" => self.subscribe(conn, req, &id),
            "unsubscribe" => {
                self.unsubscribe(conn, &id);
                conn.send(reply_ok(req, json!({})));
            }
            "ping" => {
                conn.send(reply_ok(req, json!({})));
            }
            other => {
                conn.send(reply_err(req, format!("unknown op: {other}")));
            }
        }
    }

    fn serve_conn(self: Arc<Self>, stream: Stream) {
        if !crate::cli_server::peer_is_current_user(&stream) {
            return;
        }
        let (Ok(mut reader), Ok(writer_stream)) = (stream.try_clone(), stream.try_clone()) else {
            return;
        };
        let (tx, rx) = mpsc::sync_channel::<Frame>(CONN_DEPTH);
        let conn = Arc::new(Conn { id: self.next_conn.fetch_add(1, Ordering::Relaxed), tx, stream });
        thread::spawn(move || {
            let mut out = io::BufWriter::new(writer_stream);
            while let Ok(frame) = rx.recv() {
                if out.write_all(&encode_frame(&frame)).is_err() {
                    return;
                }
                while let Ok(more) = rx.try_recv() {
                    if out.write_all(&encode_frame(&more)).is_err() {
                        return;
                    }
                }
                if out.flush().is_err() {
                    return;
                }
            }
        });

        let _ = reader.set_read_timeout(Some(HELLO_TIMEOUT));
        let Ok(Frame::Json(hello)) = read_frame(&mut reader) else { return };
        let req = hello["req"].as_u64().unwrap_or(0);
        let proto = hello["proto"].as_u64().unwrap_or(0) as u32;
        let is_hello = hello["op"].as_str() == Some("hello");
        if !is_hello {
            conn.send(reply_err(req, "expected hello"));
            return;
        }
        if proto != PTYD_PROTO {
            let mismatch = json!({ "req": req, "ok": false, "error": "protocol mismatch", "proto": PTYD_PROTO });
            conn.send(Frame::Json(mismatch));
            return;
        }
        if hello["token"].as_str() != Some(self.token.as_str()) {
            conn.send(reply_err(req, "bad token"));
            return;
        }
        let _ = reader.set_read_timeout(None);
        let build = env!("CARGO_PKG_VERSION");
        conn.send(reply_ok(req, json!({ "proto": PTYD_PROTO, "build": build, "pid": std::process::id() })));
        self.change_occupancy(|o| o.clients += 1);

        loop {
            match read_frame(&mut reader) {
                Ok(Frame::Data { id, bytes }) => self.write(&id, bytes),
                Ok(Frame::Json(msg)) => self.dispatch(&conn, msg),
                Ok(Frame::Snapshot { .. }) => {}
                Err(_) => break,
            }
        }
        self.forget_conn(&conn);
        self.change_occupancy(|o| o.clients = o.clients.saturating_sub(1));
    }
}

/// Start serving `listener` on a background thread.
pub(crate) fn serve(listener: Listener, options: DaemonOptions) -> Arc<Daemon> {
    let daemon = Daemon::new(options.token);
    let accepting = daemon.clone();
    thread::spawn(move || {
        for stream in listener.incoming() {
            match stream {
                Ok(stream) => {
                    let daemon = accepting.clone();
                    thread::spawn(move || daemon.serve_conn(stream));
                }
                Err(e) => {
                    dlog(&format!("[ptyd] accept failed: {e}"));
                    thread::sleep(Duration::from_millis(100));
                }
            }
        }
    });
    daemon
}

fn write_private(path: &Path, contents: &str) -> io::Result<()> {
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, contents)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600))?;
    }
    std::fs::rename(&tmp, path)
}

/// The daemon process. Returns when it has been idle for the grace period.
pub(crate) fn main(socket: &Path) -> i32 {
    // A live daemon already owns this socket: unlinking it would orphan that
    // daemon's PTYs from every future app.
    if local::connect(socket).is_ok() {
        return 0;
    }
    let _ = std::fs::remove_file(socket);
    let listener = match local::bind(socket) {
        Ok(listener) => listener,
        Err(e) => {
            dlog(&format!("[ptyd] bind {} failed: {e}", socket.display()));
            return 1;
        }
    };
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(socket, std::fs::Permissions::from_mode(0o600));
    }
    let token = uuid::Uuid::new_v4().simple().to_string();
    if let Err(e) = write_private(&token_path(socket), &token) {
        dlog(&format!("[ptyd] token write failed: {e}"));
        let _ = std::fs::remove_file(socket);
        return 1;
    }
    dlog(&format!("[ptyd] listening on {} pid={}", socket.display(), std::process::id()));
    let daemon = serve(listener, DaemonOptions { token: token.clone() });
    daemon.wait_until_idle(IDLE_GRACE);
    // Only remove what is still ours: a second daemon may have taken over the
    // path after a stale-socket race.
    let still_ours = std::fs::read_to_string(token_path(socket)).map(|t| t == token).unwrap_or(false);
    if still_ours {
        let _ = std::fs::remove_file(socket);
        let _ = std::fs::remove_file(token_path(socket));
    }
    dlog("[ptyd] idle, exiting");
    0
}

/// `Some(socket)` when this process was started as the daemon.
pub(crate) fn daemon_socket_arg(mut args: impl Iterator<Item = String>) -> Option<PathBuf> {
    let _program = args.next();
    match (args.next(), args.next()) {
        (Some(flag), Some(socket)) if flag == PTYD_ARG => Some(PathBuf::from(socket)),
        _ => None,
    }
}

// ───────────────────────────── client ─────────────────────────────

/// What the app hears from the daemon outside of replies.
pub(crate) trait PtydEvents: Send + Sync + 'static {
    fn data(&self, id: &str, bytes: Vec<u8>);
    /// A subscribe's ring snapshot, delivered in order with the live data on
    /// the reader thread (before the subscribe call returns it as well).
    fn snapshot(&self, _id: &str, _bytes: &[u8]) {}
    fn exit(&self, id: &str, code: Option<i32>);
    fn sudo(&self, id: &str, show: bool);
    /// The connection is gone. Every PTY it carried is gone with the daemon,
    /// or at least unreachable until a reconnect.
    fn disconnected(&self);
}

#[derive(Debug)]
pub(crate) enum ConnectError {
    Unreachable(String),
    /// The daemon on this socket speaks another protocol version.
    Mismatch(u32),
    Refused(String),
}

impl std::fmt::Display for ConnectError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ConnectError::Unreachable(e) => write!(f, "pty daemon unreachable: {e}"),
            ConnectError::Mismatch(p) => write!(f, "pty daemon speaks protocol {p}, this app {PTYD_PROTO}"),
            ConnectError::Refused(e) => write!(f, "pty daemon refused: {e}"),
        }
    }
}

pub(crate) struct PtydClient {
    writer: Mutex<Stream>,
    pending: Mutex<HashMap<u64, mpsc::Sender<Value>>>,
    snapshots: Mutex<HashMap<String, Vec<u8>>>,
    next_req: AtomicU64,
    alive: AtomicBool,
    pub(crate) daemon_pid: AtomicU64,
}

impl PtydClient {
    pub(crate) fn connect(socket: &Path, events: Arc<dyn PtydEvents>) -> Result<Arc<Self>, ConnectError> {
        Self::connect_as(socket, events, PTYD_PROTO)
    }

    fn connect_as(socket: &Path, events: Arc<dyn PtydEvents>, proto: u32) -> Result<Arc<Self>, ConnectError> {
        let stream = local::connect(socket).map_err(|e| ConnectError::Unreachable(e.to_string()))?;
        let token = std::fs::read_to_string(token_path(socket)).unwrap_or_default();
        let reader = stream.try_clone().map_err(|e| ConnectError::Unreachable(e.to_string()))?;
        let client = Arc::new(PtydClient {
            writer: Mutex::new(stream),
            pending: Mutex::new(HashMap::new()),
            snapshots: Mutex::new(HashMap::new()),
            next_req: AtomicU64::new(1),
            alive: AtomicBool::new(true),
            daemon_pid: AtomicU64::new(0),
        });
        let reading = client.clone();
        thread::spawn(move || reading.read_loop(reader, events));
        let hello = client.call(json!({ "op": "hello", "proto": proto, "token": token, "build": env!("CARGO_PKG_VERSION") }));
        match hello {
            Ok(reply) => {
                client.daemon_pid.store(reply["pid"].as_u64().unwrap_or(0), Ordering::Relaxed);
                Ok(client)
            }
            Err(reply) => {
                client.close();
                match reply.get("proto").and_then(Value::as_u64) {
                    Some(theirs) => Err(ConnectError::Mismatch(theirs as u32)),
                    None => Err(ConnectError::Refused(reply["error"].as_str().unwrap_or("connection lost").to_string())),
                }
            }
        }
    }

    fn read_loop(self: Arc<Self>, mut reader: Stream, events: Arc<dyn PtydEvents>) {
        loop {
            match read_frame(&mut reader) {
                Ok(Frame::Data { id, bytes }) => events.data(&id, bytes),
                Ok(Frame::Snapshot { id, bytes }) => {
                    events.snapshot(&id, &bytes);
                    self.snapshots.lock().insert(id, bytes);
                }
                Ok(Frame::Json(msg)) => {
                    if let Some(req) = msg["req"].as_u64() {
                        if let Some(waiter) = self.pending.lock().remove(&req) {
                            let _ = waiter.send(msg);
                        }
                        continue;
                    }
                    let id = msg["id"].as_str().unwrap_or_default();
                    match msg["event"].as_str().unwrap_or_default() {
                        "exit" => events.exit(id, msg["code"].as_i64().map(|c| c as i32)),
                        "sudo" => events.sudo(id, msg["show"].as_bool().unwrap_or(false)),
                        _ => {}
                    }
                }
                Err(_) => break,
            }
        }
        self.alive.store(false, Ordering::Release);
        self.pending.lock().clear();
        events.disconnected();
    }

    pub(crate) fn is_alive(&self) -> bool {
        self.alive.load(Ordering::Acquire)
    }

    fn send(&self, frame: &Frame) -> Result<(), String> {
        let mut writer = self.writer.lock();
        writer.write_all(&encode_frame(frame)).map_err(|e| e.to_string())
    }

    /// One request, one reply. `Err` carries the daemon's reply (or a
    /// synthesized one) so a caller can read fields off a refusal.
    fn call(&self, mut request: Value) -> Result<Value, Value> {
        if !self.is_alive() {
            return Err(json!({ "error": "pty daemon connection lost" }));
        }
        let req = self.next_req.fetch_add(1, Ordering::Relaxed);
        request["req"] = json!(req);
        let (tx, rx) = mpsc::channel();
        self.pending.lock().insert(req, tx);
        if let Err(e) = self.send(&Frame::Json(request)) {
            self.pending.lock().remove(&req);
            return Err(json!({ "error": e }));
        }
        let reply = rx.recv_timeout(CALL_TIMEOUT);
        self.pending.lock().remove(&req);
        match reply {
            Ok(reply) if reply["ok"].as_bool() == Some(true) => Ok(reply),
            Ok(reply) => Err(reply),
            Err(_) => Err(json!({ "error": "pty daemon did not answer" })),
        }
    }

    fn call_str(&self, request: Value) -> Result<Value, String> {
        self.call(request)
            .map_err(|reply| reply["error"].as_str().unwrap_or("pty daemon error").to_string())
    }

    pub(crate) fn spawn(&self, spec: &SpawnSpec) -> Result<Option<u32>, String> {
        let reply = self.call_str(json!({ "op": "spawn", "spec": spec }))?;
        Ok(reply["pid"].as_u64().map(|p| p as u32))
    }

    pub(crate) fn write(&self, id: &str, bytes: &[u8]) -> Result<(), String> {
        self.send(&Frame::Data { id: id.to_string(), bytes: bytes.to_vec() })
    }

    pub(crate) fn resize(&self, id: &str, rows: u16, cols: u16) -> Result<(), String> {
        self.call_str(json!({ "op": "resize", "id": id, "rows": rows, "cols": cols })).map(|_| ())
    }

    pub(crate) fn kill(&self, id: &str) -> Result<(), String> {
        self.call_str(json!({ "op": "kill", "id": id })).map(|_| ())
    }

    pub(crate) fn list(&self) -> Result<Vec<Value>, String> {
        let reply = self.call_str(json!({ "op": "list" }))?;
        Ok(reply["ptys"].as_array().cloned().unwrap_or_default())
    }

    /// Subscribe to a PTY: its ring now, then live output through
    /// `PtydEvents::data`. Returns the snapshot and whether older output was
    /// dropped from it.
    pub(crate) fn subscribe(&self, id: &str) -> Result<(Vec<u8>, bool), String> {
        let reply = self.call_str(json!({ "op": "subscribe", "id": id }))?;
        let snapshot = self.snapshots.lock().remove(id).unwrap_or_default();
        Ok((snapshot, reply["truncated"].as_bool().unwrap_or(false)))
    }

    pub(crate) fn unsubscribe(&self, id: &str) -> Result<(), String> {
        self.call_str(json!({ "op": "unsubscribe", "id": id })).map(|_| ())
    }

    pub(crate) fn close(&self) {
        let _ = self.writer.lock().shutdown(std::net::Shutdown::Both);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc::Receiver;

    #[derive(Debug, PartialEq)]
    enum Heard {
        Data(String, Vec<u8>),
        Exit(String, Option<i32>),
        Gone,
    }

    struct Ears(Mutex<mpsc::Sender<Heard>>);

    impl PtydEvents for Ears {
        fn data(&self, id: &str, bytes: Vec<u8>) {
            let _ = self.0.lock().send(Heard::Data(id.into(), bytes));
        }
        fn exit(&self, id: &str, code: Option<i32>) {
            let _ = self.0.lock().send(Heard::Exit(id.into(), code));
        }
        fn sudo(&self, _id: &str, _show: bool) {}
        fn disconnected(&self) {
            let _ = self.0.lock().send(Heard::Gone);
        }
    }

    fn ears() -> (Arc<dyn PtydEvents>, Receiver<Heard>) {
        let (tx, rx) = mpsc::channel();
        (Arc::new(Ears(Mutex::new(tx))), rx)
    }

    struct Fixture {
        dir: PathBuf,
        socket: PathBuf,
        daemon: Arc<Daemon>,
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    fn start() -> Fixture {
        static N: AtomicU64 = AtomicU64::new(0);
        let dir = std::env::temp_dir().join(format!(
            "ptyd-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let socket = socket_path(&dir);
        let listener = local::bind(&socket).unwrap();
        let token = "test-token".to_string();
        write_private(&token_path(&socket), &token).unwrap();
        let daemon = serve(listener, DaemonOptions { token });
        Fixture { dir, socket, daemon }
    }

    fn spec(id: &str, script: &str) -> SpawnSpec {
        SpawnSpec {
            id: id.into(),
            argv: vec!["/bin/sh".into(), "-c".into(), script.into()],
            cwd: std::env::temp_dir().to_string_lossy().into_owned(),
            env: std::env::vars().collect(),
            rows: 24,
            cols: 80,
            ..Default::default()
        }
    }

    /// Everything heard for `id` until its exit (or `until` returns true on
    /// the bytes so far), within `limit`.
    fn collect(rx: &Receiver<Heard>, id: &str, limit: Duration, until: impl Fn(&[u8]) -> bool) -> (Vec<u8>, Option<Option<i32>>) {
        let deadline = Instant::now() + limit;
        let mut bytes = Vec::new();
        loop {
            let now = Instant::now();
            if now >= deadline || until(&bytes) {
                return (bytes, None);
            }
            match rx.recv_timeout(deadline - now) {
                Ok(Heard::Data(i, b)) if i == id => bytes.extend(b),
                Ok(Heard::Exit(i, code)) if i == id => return (bytes, Some(code)),
                Ok(_) => {}
                Err(_) => return (bytes, None),
            }
        }
    }

    fn contains(haystack: &[u8], needle: &str) -> bool {
        String::from_utf8_lossy(haystack).contains(needle)
    }

    #[test]
    fn frames_round_trip_through_a_byte_stream() {
        let frames = vec![
            Frame::Json(json!({ "req": 7, "op": "list" })),
            Frame::Data { id: "a-pty".into(), bytes: vec![0, 1, 2, 255, b'\n'] },
            Frame::Snapshot { id: "b".into(), bytes: Vec::new() },
            Frame::Data { id: "c".into(), bytes: vec![b'x'; 70_000] },
        ];
        let mut wire = Vec::new();
        for frame in &frames {
            wire.extend(encode_frame(frame));
        }
        let mut cursor = io::Cursor::new(wire);
        for frame in &frames {
            assert_eq!(&read_frame(&mut cursor).unwrap(), frame);
        }
        assert!(read_frame(&mut cursor).is_err(), "a clean EOF after the last frame");

        let mut corrupt = io::Cursor::new(vec![0xff, 0xff, 0xff, 0xff, 0]);
        assert_eq!(read_frame(&mut corrupt).unwrap_err().kind(), io::ErrorKind::InvalidData);
    }

    #[test]
    fn spawn_subscribe_ring_and_exit() {
        let fx = start();
        let (events, heard) = ears();
        let client = PtydClient::connect(&fx.socket, events).unwrap();
        client.spawn(&spec("p1", "printf before; sleep 0.4; printf after; exit 3")).unwrap();
        thread::sleep(Duration::from_millis(200));

        let (snapshot, truncated) = client.subscribe("p1").unwrap();
        assert!(contains(&snapshot, "before"), "ring holds what was written before the subscribe: {snapshot:?}");
        assert!(!truncated);
        let (live, exit) = collect(&heard, "p1", Duration::from_secs(10), |_| false);
        assert!(contains(&live, "after"), "live output after the snapshot: {live:?}");
        assert!(!contains(&live, "before"), "the snapshot is not repeated live");
        assert_eq!(exit, Some(Some(3)));

        let listed = client.list().unwrap();
        assert!(listed.iter().all(|p| p["id"] != "p1"), "a delivered exit leaves the table: {listed:?}");
    }

    #[test]
    fn a_pty_survives_its_client_and_a_new_one_gets_ring_plus_live() {
        let fx = start();
        let (events, _heard) = ears();
        let first = PtydClient::connect(&fx.socket, events).unwrap();
        first.spawn(&spec("cat", "exec cat")).unwrap();
        first.subscribe("cat").unwrap();
        first.write("cat", b"one\n").unwrap();
        thread::sleep(Duration::from_millis(200));
        first.close();
        thread::sleep(Duration::from_millis(100));

        let (events, heard) = ears();
        let second = PtydClient::connect(&fx.socket, events).unwrap();
        let listed = second.list().unwrap();
        let alive = listed.iter().any(|p| p["id"] == "cat" && p["alive"] == true);
        assert!(alive, "the pty outlived the client that spawned it: {listed:?}");
        let (snapshot, _) = second.subscribe("cat").unwrap();
        assert!(contains(&snapshot, "one"), "ring: {snapshot:?}");
        second.write("cat", b"two\n").unwrap();
        let (live, _) = collect(&heard, "cat", Duration::from_secs(5), |b| contains(b, "two"));
        assert!(contains(&live, "two"), "live: {live:?}");
        second.kill("cat").unwrap();
    }

    #[test]
    fn an_idle_pty_sends_nothing() {
        let fx = start();
        let (events, heard) = ears();
        let client = PtydClient::connect(&fx.socket, events).unwrap();
        client.spawn(&spec("quiet", "exec sleep 5")).unwrap();
        client.subscribe("quiet").unwrap();
        let heard_anything = heard.recv_timeout(Duration::from_millis(600));
        assert!(heard_anything.is_err(), "an idle pty emitted: {heard_anything:?}");
        client.kill("quiet").unwrap();
    }

    #[test]
    fn the_daemon_exits_after_the_grace_with_nothing_to_do() {
        let untouched = start();
        let (untouched_tx, untouched_rx) = mpsc::channel();
        let untouched_daemon = untouched.daemon.clone();
        thread::spawn(move || {
            untouched_daemon.wait_until_idle(Duration::from_millis(400));
            let _ = untouched_tx.send(());
        });
        assert!(untouched_rx.recv_timeout(Duration::from_millis(200)).is_err(), "exited before the grace ran out");
        assert!(untouched_rx.recv_timeout(Duration::from_secs(5)).is_ok(), "never exited");

        let fx = start();
        let (events, _heard) = ears();
        let client = PtydClient::connect(&fx.socket, events).unwrap();
        let (done_tx, done_rx) = mpsc::channel();
        let daemon = fx.daemon.clone();
        thread::spawn(move || {
            daemon.wait_until_idle(Duration::from_millis(150));
            let _ = done_tx.send(());
        });
        assert!(done_rx.recv_timeout(Duration::from_millis(500)).is_err(), "exited with a client connected");
        client.spawn(&spec("short", "sleep 0.6")).unwrap();
        client.close();
        assert!(done_rx.recv_timeout(Duration::from_millis(300)).is_err(), "exited with a live pty");
        assert!(done_rx.recv_timeout(Duration::from_secs(5)).is_ok(), "did not exit once idle");
    }

    #[test]
    fn a_client_on_another_protocol_is_turned_away() {
        let fx = start();
        let (events, _heard) = ears();
        match PtydClient::connect_as(&fx.socket, events, PTYD_PROTO + 1) {
            Err(ConnectError::Mismatch(theirs)) => assert_eq!(theirs, PTYD_PROTO),
            other => panic!("expected a mismatch, got {:?}", other.err()),
        }
        let (events, _heard) = ears();
        assert!(PtydClient::connect(&fx.socket, events).is_ok(), "a matching client still gets in");
    }

    #[test]
    fn a_client_without_the_token_is_refused() {
        let fx = start();
        write_private(&token_path(&fx.socket), "wrong").unwrap();
        let (events, _heard) = ears();
        assert!(matches!(PtydClient::connect(&fx.socket, events), Err(ConnectError::Refused(_))));
    }

    #[test]
    fn the_daemon_flag_is_recognised_only_in_first_position() {
        let args = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>().into_iter();
        assert_eq!(daemon_socket_arg(args(&["termic", "--ptyd", "/x/ptyd.sock"])), Some(PathBuf::from("/x/ptyd.sock")));
        assert_eq!(daemon_socket_arg(args(&["termic"])), None);
        assert_eq!(daemon_socket_arg(args(&["termic", "termic://open", "--ptyd"])), None);
    }
}
