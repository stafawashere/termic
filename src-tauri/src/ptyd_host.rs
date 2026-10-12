// The app's side of the PTY daemon (ptyd.rs, docs/plans/pty-daemon.md).
//
// A daemon-owned PTY still gets a `PtySlot` in the `PtyManager`, so the CLI,
// the Activity monitor, the quit prompt and every `pty_*` command find it the
// way they find an app-owned one. What differs is where the bytes come from:
// the daemon connection's reader thread pushes them into the slot's pump,
// whose flusher emits `pty://<id>` with the same attach gate as a local PTY.
// The daemon has already coalesced, so the app adds no second 8 ms window.

use crate::ptyd::{self, PtydClient, PtydEvents, SpawnSpec};
use crate::{
    dlog, emit_to_window, global_dir, next_pty_seq, sandbox, sudo_touchid, window_for_task,
    PtyFeed, PtyManager, PtyOwner, PtyPump, PtyRole, PtySink, PtySlot, WindowSink,
};
use parking_lot::Mutex;
use portable_pty::CommandBuilder;
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::io::{self, Write};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Manager};

/// The live connection, if any. Replaced on reconnect.
static CLIENT: Mutex<Option<Arc<PtydClient>>> = Mutex::new(None);

/// One launch attempt at a time: a second spawn while the daemon is still
/// coming up must not start a second daemon.
static LAUNCHING: AtomicBool = AtomicBool::new(false);

/// What the reader thread needs to deliver one daemon PTY's events. Kept
/// apart from the `PtySlot`, which `pty_kill` removes at once: the exit that
/// follows a kill still has to reach the webview, the way a local PTY's
/// waiter still emits after its slot is gone.
struct Route {
    pump: PtyPump,
    sink: Arc<dyn PtySink>,
    feed: Option<Arc<PtyFeed>>,
    out_bytes: Arc<AtomicU64>,
    window: Option<String>,
    task_id: Option<String>,
    pid: Option<u32>,
    /// A fresh spawn's ring snapshot is output nobody has seen yet, so it goes
    /// down the pump like live output. A reattach's snapshot is handed to the
    /// webview to replay instead, and must not be emitted a second time.
    snapshot_to_pump: bool,
}

static ROUTES: Mutex<Option<HashMap<String, Arc<Route>>>> = Mutex::new(None);

fn route(id: &str) -> Option<Arc<Route>> {
    ROUTES.lock().as_ref().and_then(|m| m.get(id).cloned())
}

fn set_route(id: &str, route: Arc<Route>) {
    ROUTES.lock().get_or_insert_with(HashMap::new).insert(id.to_string(), route);
}

fn take_route(id: &str) -> Option<Arc<Route>> {
    ROUTES.lock().as_mut().and_then(|m| m.remove(id))
}

struct AppEvents {
    app: AppHandle,
}

impl PtydEvents for AppEvents {
    fn data(&self, id: &str, bytes: Vec<u8>) {
        let Some(route) = route(id) else { return };
        route.out_bytes.fetch_add(bytes.len() as u64, Ordering::Relaxed);
        if let Some(feed) = &route.feed {
            feed.push(&bytes);
        }
        route.pump.push(&bytes);
    }

    fn snapshot(&self, id: &str, bytes: &[u8]) {
        let Some(route) = route(id) else { return };
        if route.snapshot_to_pump {
            route.out_bytes.fetch_add(bytes.len() as u64, Ordering::Relaxed);
            route.pump.push(bytes);
            if let Some(feed) = &route.feed {
                feed.push(bytes);
            }
        } else if let Some(feed) = &route.feed {
            feed.seed(bytes);
        }
    }

    fn exit(&self, id: &str, code: Option<i32>) {
        let Some(route) = take_route(id) else { return };
        let manager = self.app.state::<PtyManager>().inner.clone();
        let id = id.to_string();
        // Off the connection's reader thread: the final drain can wait out the
        // attach grace, and every other PTY's output queues behind this one.
        std::thread::spawn(move || {
            if let Some(feed) = &route.feed {
                feed.send_detach_final("exited");
            }
            route.pump.finish(route.sink.as_ref());
            route.pump.wait_done();
            route.sink.exit(code);
            if let (Some(pid), Some(task)) = (route.pid, route.task_id.as_deref()) {
                sandbox::unregister_root_pid(task, pid);
            }
            manager.lock().remove(&id);
        });
    }

    fn sudo(&self, id: &str, show: bool) {
        let Some(route) = route(id) else { return };
        emit_to_window(
            &self.app,
            route.window.as_deref(),
            &format!("pty-sudo-touchid://{id}"),
            sudo_touchid::SudoOffer { show },
        );
    }

    fn disconnected(&self) {
        dlog("[ptyd] connection lost");
        CLIENT.lock().take();
        let ids: Vec<String> = ROUTES.lock().as_ref().map(|m| m.keys().cloned().collect()).unwrap_or_default();
        for id in ids {
            self.exit(&id, None);
        }
    }
}

/// The live connection, without starting anything.
pub(crate) fn connected() -> Option<Arc<PtydClient>> {
    CLIENT.lock().as_ref().filter(|c| c.is_alive()).cloned()
}

/// Connect to a daemon that is already running. Never launches one, so it is
/// cheap enough for a startup probe and for "is this tab's agent still alive".
pub(crate) fn connect_existing(app: &AppHandle) -> Option<Arc<PtydClient>> {
    if let Some(client) = connected() {
        return Some(client);
    }
    let global = global_dir().ok()?;
    let events: Arc<dyn PtydEvents> = Arc::new(AppEvents { app: app.clone() });
    let primary = ptyd::socket_path(&global);
    let client = match PtydClient::connect(&primary, events.clone()) {
        Ok(client) => client,
        Err(ptyd::ConnectError::Mismatch(_)) => {
            PtydClient::connect(&ptyd::versioned_socket_path(&global), events).ok()?
        }
        Err(_) => return None,
    };
    *CLIENT.lock() = Some(client.clone());
    Some(client)
}

/// Connect, launching the daemon first when there is none. Blocks for as long
/// as a cold daemon takes to bind its socket, so it never runs on a command
/// thread: `warm` calls it in the background.
fn connect_or_launch(app: &AppHandle) -> Result<Arc<PtydClient>, String> {
    if let Some(client) = connect_existing(app) {
        return Ok(client);
    }
    let global = global_dir().map_err(|e| e.to_string())?;
    let events: Arc<dyn PtydEvents> = Arc::new(AppEvents { app: app.clone() });
    let primary = ptyd::socket_path(&global);
    let socket = match PtydClient::connect(&primary, events.clone()) {
        Err(ptyd::ConnectError::Mismatch(theirs)) => {
            dlog(&format!("[ptyd] ptyd.sock speaks protocol {theirs}, starting this build's daemon beside it"));
            ptyd::versioned_socket_path(&global)
        }
        _ => primary,
    };
    launch(&socket)?;
    // The daemon binds within milliseconds of starting; this is bounded and
    // only ever runs on a background thread.
    for _ in 0..100 {
        std::thread::sleep(Duration::from_millis(50));
        if let Ok(client) = PtydClient::connect(&socket, events.clone()) {
            *CLIENT.lock() = Some(client.clone());
            return Ok(client);
        }
    }
    Err("the pty daemon did not come up".into())
}

/// Start the daemon detached from this process: its own session, no stdio,
/// so quitting the app (or its terminal, under `tauri dev`) does not take it
/// down.
fn launch(socket: &std::path::Path) -> Result<(), String> {
    let exe = daemon_executable()?;
    let mut cmd = std::process::Command::new(exe);
    cmd.arg(ptyd::PTYD_ARG)
        .arg(socket)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // SAFETY: setsid is async-signal-safe and touches no Rust state.
        unsafe {
            cmd.pre_exec(|| {
                libc::setsid();
                Ok(())
            });
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW);
    }
    let mut child = cmd.spawn().map_err(|e| format!("start pty daemon: {e}"))?;
    dlog(&format!("[ptyd] launched pid={} socket={}", child.id(), socket.display()));
    // Reap it if it exits while we are still running, so it is not left a
    // zombie. Blocks in wait(), no polling.
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

/// The binary the daemon runs from.
fn daemon_executable() -> Result<std::path::PathBuf, String> {
    std::env::current_exe().map_err(|e| e.to_string())
}

/// Bring the daemon up in the background so a spawn finds it connected.
pub(crate) fn warm(app: &AppHandle) {
    if connected().is_some() || LAUNCHING.swap(true, Ordering::AcqRel) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        if let Err(e) = connect_or_launch(&app) {
            dlog(&format!("[ptyd] warm failed: {e}"));
        }
        LAUNCHING.store(false, Ordering::Release);
    });
}

/// Whether a spawn with these properties goes to the daemon.
pub(crate) fn wants_daemon(enabled: bool, is_agent: bool) -> bool {
    enabled && is_agent
}

/// Writes keystrokes to the daemon. The daemon queues them per PTY, so a
/// wedged foreground process cannot stall this write.
struct DaemonWriter {
    client: Arc<PtydClient>,
    id: String,
}

impl Write for DaemonWriter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.client
            .write(&self.id, buf)
            .map_err(|e| io::Error::new(io::ErrorKind::BrokenPipe, e))?;
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// What the daemon keeps about a PTY for the app that adopts it after a
/// relaunch. Read back from `list`.
#[derive(Clone, Debug, Default, PartialEq, Serialize, serde::Deserialize)]
pub(crate) struct PtyMeta {
    #[serde(default)]
    pub task_id: Option<String>,
    #[serde(default)]
    pub role_task_id: Option<String>,
    #[serde(default)]
    pub tab_id: Option<String>,
    #[serde(default)]
    pub role_kind: Option<String>,
    #[serde(default)]
    pub is_default: bool,
    #[serde(default)]
    pub owner_task_id: Option<String>,
    #[serde(default)]
    pub owner_tab_id: Option<String>,
    #[serde(default)]
    pub owner_kind: Option<String>,
    #[serde(default)]
    pub account: Option<String>,
    #[serde(default)]
    pub docker_container: Option<String>,
}

impl PtyMeta {
    pub(crate) fn of(
        task_id: Option<&String>,
        role: Option<&PtyRole>,
        owner: Option<&PtyOwner>,
        account: Option<&String>,
        docker_container: Option<&String>,
    ) -> Self {
        PtyMeta {
            task_id: task_id.cloned(),
            role_task_id: role.map(|r| r.task_id.clone()),
            tab_id: role.and_then(|r| r.tab_id.clone()),
            role_kind: role.map(|r| r.kind.clone()),
            is_default: role.map(|r| r.is_default).unwrap_or(false),
            owner_task_id: owner.and_then(|o| o.task_id.clone()),
            owner_tab_id: owner.and_then(|o| o.tab_id.clone()),
            owner_kind: owner.map(|o| o.kind.clone()),
            account: account.cloned(),
            docker_container: docker_container.cloned(),
        }
    }

    fn role(&self) -> Option<PtyRole> {
        Some(PtyRole {
            task_id: self.role_task_id.clone()?,
            tab_id: self.tab_id.clone(),
            kind: self.role_kind.clone()?,
            is_default: self.is_default,
        })
    }

    fn owner(&self) -> Option<PtyOwner> {
        Some(PtyOwner {
            task_id: self.owner_task_id.clone(),
            tab_id: self.owner_tab_id.clone(),
            kind: self.owner_kind.clone()?,
        })
    }

    /// Is this the agent PTY of `tab_id` in `task_id`?
    pub(crate) fn is_tab(&self, task_id: &str, tab_id: &str) -> bool {
        let same_task = self.role_task_id.as_deref() == Some(task_id);
        let same_tab = self.tab_id.as_deref() == Some(tab_id);
        let is_agent = self.role_kind.as_deref() == Some("agent");
        same_task && same_tab && is_agent
    }
}

/// Build the daemon's spawn spec from the finished command `pty_spawn` would
/// have run itself.
pub(crate) fn spec_from(
    cmd: &CommandBuilder,
    id: &str,
    rows: u16,
    cols: u16,
    sudo_watch: bool,
    meta: &PtyMeta,
) -> SpawnSpec {
    let argv = cmd.get_argv().iter().map(|a| a.to_string_lossy().into_owned()).collect();
    let env = cmd
        .iter_full_env_as_str()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
    let cwd = cmd
        .get_cwd()
        .map(|c| c.to_string_lossy().into_owned())
        .unwrap_or_default();
    SpawnSpec {
        id: id.to_string(),
        argv,
        cwd,
        env,
        rows,
        cols,
        set_termic_pty: true,
        sudo_watch,
        meta: serde_json::to_value(meta).unwrap_or(Value::Null),
    }
}

/// Register a daemon PTY in this app: a route for its events and a slot for
/// everything else. `fresh` is a spawn this app just made, whose ring
/// snapshot is new output; otherwise it is an adoption after a relaunch.
fn register(
    app: &AppHandle,
    client: &Arc<PtydClient>,
    id: &str,
    pid: Option<u32>,
    meta: &PtyMeta,
    window: Option<String>,
    fresh: bool,
) -> PtyPump {
    let pump = PtyPump::new();
    let sink: Arc<dyn PtySink> = Arc::new(WindowSink { app: app.clone(), window: window.clone(), id: id.to_string() });
    let role = meta.role();
    let feed = role.as_ref().map(|_| Arc::new(PtyFeed::new()));
    let out_bytes = Arc::new(AtomicU64::new(0));
    set_route(
        id,
        Arc::new(Route {
            pump: pump.clone(),
            sink: sink.clone(),
            feed: feed.clone(),
            out_bytes: out_bytes.clone(),
            window,
            task_id: meta.task_id.clone(),
            pid,
            snapshot_to_pump: fresh,
        }),
    );
    pump.spawn_flusher(sink, Duration::ZERO);
    let writer: Box<dyn Write + Send> = Box::new(DaemonWriter { client: client.clone(), id: id.to_string() });
    app.state::<PtyManager>().inner.lock().insert(
        id.to_string(),
        PtySlot {
            writer: Arc::new(Mutex::new(writer)),
            master: None,
            child_pid: pid,
            sandbox: None,
            task_id: meta.task_id.clone(),
            role,
            feed,
            owner: meta.owner(),
            docker_container: meta.docker_container.clone(),
            out_bytes,
            seq: next_pty_seq(),
            pump: pump.clone(),
            daemon: Some(client.clone()),
        },
    );
    pump
}

/// Spawn in the daemon. `Ok(None)` when no daemon is connected yet: the
/// caller spawns locally and this kicks the daemon awake for next time, so a
/// spawn never waits on a cold daemon.
pub(crate) fn spawn(
    app: &AppHandle,
    cmd: &CommandBuilder,
    id: &str,
    rows: u16,
    cols: u16,
    sudo_watch: bool,
    meta: &PtyMeta,
    window: Option<String>,
) -> Result<Option<Option<u32>>, String> {
    let Some(client) = connected() else {
        warm(app);
        return Ok(None);
    };
    let spec = spec_from(cmd, id, rows, cols, sudo_watch, meta);
    let pid = client.spawn(&spec)?;
    register(app, &client, id, pid, meta, window, true);
    if let Err(e) = client.subscribe(id) {
        take_route(id);
        app.state::<PtyManager>().inner.lock().remove(id);
        let _ = client.kill(id);
        return Err(e);
    }
    dlog(&format!("[ptyd] spawned {id} pid={pid:?} in the daemon"));
    Ok(Some(pid))
}

/// One daemon PTY that a tab can attach to.
#[derive(Clone, Debug, Serialize)]
pub struct LivePty {
    pub id: String,
    pub pid: Option<u32>,
    pub account: Option<String>,
}

fn live_from(row: &Value) -> Option<(LivePty, PtyMeta)> {
    let alive = row["alive"].as_bool().unwrap_or(false);
    if !alive {
        return None;
    }
    let meta: PtyMeta = serde_json::from_value(row["meta"].clone()).ok()?;
    let live = LivePty {
        id: row["id"].as_str()?.to_string(),
        pid: row["pid"].as_u64().map(|p| p as u32),
        account: meta.account.clone(),
    };
    Some((live, meta))
}

/// The daemon PTY still running a tab's agent, if there is one.
pub(crate) fn find(app: &AppHandle, task_id: &str, tab_id: &str) -> Option<LivePty> {
    let client = connect_existing(app)?;
    let rows = client.list().ok()?;
    rows.iter()
        .filter_map(live_from)
        .find(|(_, meta)| meta.is_tab(task_id, tab_id))
        .map(|(live, _)| live)
}

/// What a tab gets back when it attaches.
#[derive(Clone, Debug, Serialize)]
pub struct AttachResult {
    pub id: String,
    pub pid: Option<u32>,
    pub account: Option<String>,
    /// The ring, base64: the output the tab replays before going live.
    pub snapshot: String,
    pub truncated: bool,
}

/// Attach a tab to a running daemon PTY: adopt it into this app (or reset an
/// adoption a reloaded webview left behind), then subscribe. The snapshot
/// comes back to the caller to replay; everything after it flows through the
/// pump once the tab sends `pty_attached`.
pub(crate) fn attach(app: &AppHandle, id: &str, rows: u16, cols: u16) -> Result<AttachResult, String> {
    let client = connect_existing(app).ok_or("the pty daemon is not running")?;
    let row = client
        .list()?
        .into_iter()
        .find(|r| r["id"].as_str() == Some(id))
        .ok_or("that terminal is no longer running")?;
    let (live, meta) = live_from(&row).ok_or("that terminal has exited")?;
    let already_adopted = route(id).is_some();
    if already_adopted {
        client.unsubscribe(id)?;
        if let Some(existing) = route(id) {
            existing.pump.buf.0.lock().clear();
            existing.pump.attached.store(false, Ordering::Release);
        }
    } else {
        let window = meta.task_id.as_deref().or(meta.role_task_id.as_deref()).and_then(window_for_task);
        register(app, &client, id, live.pid, &meta, window, false);
    }
    let (snapshot, truncated) = client.subscribe(id)?;
    let _ = client.resize(id, rows, cols);
    use base64::Engine as _;
    Ok(AttachResult {
        id: live.id,
        pid: live.pid,
        account: live.account,
        snapshot: base64::engine::general_purpose::STANDARD.encode(snapshot),
        truncated,
    })
}

/// Resize a daemon PTY.
pub(crate) fn resize(client: &PtydClient, id: &str, rows: u16, cols: u16) -> Result<(), String> {
    client.resize(id, rows, cols)
}

/// Kill a daemon PTY. Its exit arrives through the connection like any other.
pub(crate) fn kill(client: Arc<PtydClient>, id: String) {
    std::thread::spawn(move || {
        if let Err(e) = client.kill(&id) {
            dlog(&format!("[ptyd] kill {id} failed: {e}"));
        }
    });
}

/// Kill every PTY the daemon holds (the quit prompt's "Stop agents").
pub(crate) fn kill_all(app: &AppHandle) {
    let Some(client) = connect_existing(app) else { return };
    let rows = client.list().unwrap_or_default();
    for row in rows {
        if let Some(id) = row["id"].as_str() {
            let _ = client.kill(id);
        }
    }
}

/// Every live daemon PTY, for callers that must leave them alone (quit-time
/// cleanup) or count them.
pub(crate) fn live_ids(app: &AppHandle) -> Vec<String> {
    let Some(client) = connect_existing(app) else { return Vec::new() };
    client
        .list()
        .unwrap_or_default()
        .iter()
        .filter(|row| row["alive"].as_bool() == Some(true))
        .filter_map(|row| row["id"].as_str().map(String::from))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn only_agent_spawns_go_to_the_daemon_and_only_when_enabled() {
        assert!(wants_daemon(true, true));
        assert!(!wants_daemon(true, false));
        assert!(!wants_daemon(false, true));
    }

    #[test]
    fn meta_round_trips_role_and_owner() {
        let role = PtyRole { task_id: "t1".into(), tab_id: Some("tab".into()), kind: "agent".into(), is_default: true };
        let owner = PtyOwner { task_id: Some("t1".into()), tab_id: Some("tab".into()), kind: "agent".into() };
        let meta = PtyMeta::of(Some(&"t1".to_string()), Some(&role), Some(&owner), None, None);
        let back: PtyMeta = serde_json::from_value(serde_json::to_value(&meta).unwrap()).unwrap();
        assert_eq!(back, meta);
        let role_back = back.role().unwrap();
        assert_eq!(role_back.tab_id.as_deref(), Some("tab"));
        assert!(role_back.is_default);
        assert!(back.is_tab("t1", "tab"));
        assert!(!back.is_tab("t1", "other"));
        assert!(!back.is_tab("t2", "tab"));
    }

    #[test]
    fn an_exited_pty_is_not_offered_for_attach() {
        let meta = json!({ "role_task_id": "t", "tab_id": "a", "role_kind": "agent" });
        let alive = json!({ "id": "p", "pid": 7, "alive": true, "meta": meta });
        let dead = json!({ "id": "q", "pid": 8, "alive": false, "exit_code": 0, "meta": meta });
        assert_eq!(live_from(&alive).map(|(l, _)| l.id), Some("p".to_string()));
        assert!(live_from(&dead).is_none());
    }

    #[test]
    fn the_spec_carries_the_finished_command() {
        let mut cmd = CommandBuilder::new("claude");
        cmd.arg("--resume");
        cmd.arg("abc");
        cmd.env_clear();
        cmd.env("TERM", "xterm-256color");
        cmd.cwd("/tmp/task");
        let spec = spec_from(&cmd, "id-1", 30, 100, false, &PtyMeta::default());
        assert_eq!(spec.argv, vec!["claude", "--resume", "abc"]);
        assert_eq!(spec.cwd, "/tmp/task");
        assert_eq!(spec.env, vec![("TERM".to_string(), "xterm-256color".to_string())]);
        assert!(spec.set_termic_pty);
        assert_eq!((spec.rows, spec.cols), (30, 100));
    }
}
