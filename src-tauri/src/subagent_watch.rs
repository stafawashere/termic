//! Live tails of the subagent transcripts a view has open.
//!
//! A transcript is watched only while a view holds it. Each open adds a
//! holder (window, task, tab) to the file's entry and each close removes one,
//! so two views on one agent share a single tail, and the last close drops it.
//! Closing a task or destroying a window drops every holder it had.
//!
//! The tail keeps a byte offset and a carry buffer and reads to EOF on every
//! event, so it never depends on how many events the OS delivered or how it
//! coalesced them. Only complete lines are parsed; the fragment after the last
//! newline waits in the carry for the write that finishes it. A file that
//! shrinks or whose inode changes was rewritten, so the tail starts over and
//! tells the view with a `reset`. A file that disappears sends `expired` and
//! releases its watch.
//!
//! One notify backend serves every entry, watching each transcript's parent
//! directory non-recursively (a file watch would not survive the file being
//! deleted and recreated). Its callback only forwards paths to a worker thread
//! that blocks on the channel, so there is no polling and no file IO on the
//! OS event thread. When the backend or a watch cannot be created (inotify out
//! of watches or instances on Linux), the open still succeeds with
//! `live: false` and the file is read only when a hook pokes it.
//!
//! Measured on Docker Desktop 4.89.0 (VirtioFS): writes made inside a
//! container to a bind-mounted dir do reach the macOS host as FSEvents, so
//! Docker tasks are watched like host ones. See `docs/ideas/claude-subagents.md`.

use crate::subagent_transcripts::{self as transcripts, ResolveError, TranscriptEntry};
use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::io::{self, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, OnceLock};
use tauri::AppHandle;

/// Bytes pulled per read. A read loops to EOF in steps of this size, parsing
/// and emitting as it goes, so a large append never sits in memory whole.
const READ_CHUNK: u64 = 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Holder {
    pub window: String,
    pub task_id: String,
    pub tab_id: String,
}

#[derive(Debug, Default, Clone)]
pub(crate) struct TranscriptTail {
    offset: u64,
    inode: Option<u64>,
    carry: Vec<u8>,
    /// Entries parsed from the file so far, which is the index the next
    /// batch starts at.
    entries_seen: usize,
}

struct WatchEntry {
    session_id: String,
    agent_id: String,
    dir: PathBuf,
    holders: Vec<Holder>,
    tail: TranscriptTail,
    live: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TailEventKind {
    Entries,
    Reset,
    Expired,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TailEvent {
    pub kind: TailEventKind,
    pub session_id: String,
    pub agent_id: String,
    /// Index of `entries[0]` in the whole transcript.
    pub start: usize,
    pub entries: Vec<TranscriptEntry>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchOpened {
    /// False when the file is read only on hook pokes.
    pub live: bool,
    /// Entries in the transcript when the tail started. The first batch the
    /// view receives starts at this index.
    pub total: usize,
}

pub(crate) trait DirWatcher: Send {
    fn watch(&mut self, dir: &Path) -> Result<(), String>;
    fn unwatch(&mut self, dir: &Path);
}

pub(crate) type WatcherFactory = Box<dyn Fn() -> Result<Box<dyn DirWatcher>, String> + Send>;
pub(crate) type Emitter = Box<dyn Fn(&str, &str, &TailEvent) + Send>;

pub(crate) fn topic(session_id: &str, agent_id: &str) -> String {
    format!("subagent-watch://{session_id}/{agent_id}")
}

#[cfg(unix)]
fn inode_of(meta: &fs::Metadata) -> Option<u64> {
    use std::os::unix::fs::MetadataExt;
    Some(meta.ino())
}

#[cfg(not(unix))]
fn inode_of(_meta: &fs::Metadata) -> Option<u64> {
    None
}

/// The starting tail for a file: positioned after its last complete line,
/// with the entries before that point counted.
pub(crate) fn prime(path: &Path) -> io::Result<TranscriptTail> {
    let mut file = fs::File::open(path)?;
    let inode = inode_of(&file.metadata()?);
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;

    let complete_len = bytes.iter().rposition(|b| *b == b'\n').map_or(0, |last| last + 1);
    let carry = bytes.split_off(complete_len);
    let entries_seen = transcripts::parse_transcript(&String::from_utf8_lossy(&bytes)).entries.len();

    Ok(TranscriptTail {
        offset: (complete_len + carry.len()) as u64,
        inode,
        carry,
        entries_seen,
    })
}

/// The bare agent id and its canonical transcript path, confined to the
/// session's `subagents/` dir by the same resolver the reads use.
pub(crate) fn resolve_target(
    subagents_dir: &Path,
    agent_id: &str,
    workflow_run_id: Option<&str>,
) -> Result<(String, PathBuf), ResolveError> {
    let bare = transcripts::validate_agent_id(agent_id)?.to_string();
    let file = transcripts::resolve_agent_file(subagents_dir, agent_id, workflow_run_id)?;
    Ok((bare, file))
}

pub(crate) struct Registry {
    entries: HashMap<PathBuf, WatchEntry>,
    dir_refs: HashMap<PathBuf, usize>,
    backend: Option<Box<dyn DirWatcher>>,
    factory: WatcherFactory,
    emit: Emitter,
    logged_failure: bool,
    reads: usize,
}

impl Registry {
    pub(crate) fn new(factory: WatcherFactory, emit: Emitter) -> Self {
        Registry {
            entries: HashMap::new(),
            dir_refs: HashMap::new(),
            backend: None,
            factory,
            emit,
            logged_failure: false,
            reads: 0,
        }
    }

    #[cfg(test)]
    fn watch_count(&self) -> usize {
        self.entries.len()
    }

    fn log_failure_once(&mut self, why: &str) {
        if self.logged_failure {
            return;
        }

        self.logged_failure = true;
        crate::dlog(&format!("[subagent-watch] no live watch, falling back to hook pokes: {why}"));
    }

    fn add_dir_watch(&mut self, dir: &Path) -> bool {
        if let Some(count) = self.dir_refs.get_mut(dir) {
            *count += 1;
            return true;
        }

        if self.backend.is_none() {
            match (self.factory)() {
                Ok(backend) => self.backend = Some(backend),
                Err(e) => {
                    self.log_failure_once(&e);
                    return false;
                }
            }
        }

        let Some(backend) = self.backend.as_mut() else { return false };
        if let Err(e) = backend.watch(dir) {
            self.log_failure_once(&e);
            return false;
        }
        self.dir_refs.insert(dir.to_path_buf(), 1);
        true
    }

    fn release_dir_watch(&mut self, dir: &Path) {
        let Some(count) = self.dir_refs.get_mut(dir) else { return };
        *count -= 1;
        if *count > 0 {
            return;
        }

        self.dir_refs.remove(dir);
        if let Some(backend) = self.backend.as_mut() {
            backend.unwatch(dir);
        }
    }

    pub(crate) fn open(
        &mut self,
        holder: Holder,
        session_id: &str,
        agent_id: &str,
        file: PathBuf,
        tail: TranscriptTail,
    ) -> WatchOpened {
        if let Some(entry) = self.entries.get_mut(&file) {
            entry.holders.push(holder);
            return WatchOpened { live: entry.live, total: entry.tail.entries_seen };
        }

        let dir = file.parent().map(Path::to_path_buf).unwrap_or_default();
        let live = self.add_dir_watch(&dir);
        let total = tail.entries_seen;
        self.entries.insert(
            file,
            WatchEntry {
                session_id: session_id.to_string(),
                agent_id: agent_id.to_string(),
                dir,
                holders: vec![holder],
                tail,
                live,
            },
        );
        WatchOpened { live, total }
    }

    fn key_for(&self, session_id: &str, agent_id: &str) -> Option<PathBuf> {
        self.entries
            .iter()
            .find(|(_, e)| e.session_id == session_id && e.agent_id == agent_id)
            .map(|(path, _)| path.clone())
    }

    fn drop_entry(&mut self, key: &Path) {
        let Some(entry) = self.entries.remove(key) else { return };
        if entry.live {
            self.release_dir_watch(&entry.dir);
        }

        if self.entries.is_empty() {
            self.backend = None;
        }
    }

    fn drop_emptied(&mut self) {
        let emptied: Vec<PathBuf> = self
            .entries
            .iter()
            .filter(|(_, e)| e.holders.is_empty())
            .map(|(path, _)| path.clone())
            .collect();
        for key in emptied {
            self.drop_entry(&key);
        }
    }

    pub(crate) fn close(&mut self, holder: &Holder, session_id: &str, agent_id: &str) {
        let Some(key) = self.key_for(session_id, agent_id) else { return };
        let Some(entry) = self.entries.get_mut(&key) else { return };
        if let Some(index) = entry.holders.iter().position(|h| h == holder) {
            entry.holders.remove(index);
        }
        self.drop_emptied();
    }

    pub(crate) fn release_task(&mut self, task_id: &str) {
        for entry in self.entries.values_mut() {
            entry.holders.retain(|h| h.task_id != task_id);
        }
        self.drop_emptied();
    }

    pub(crate) fn release_window(&mut self, window: &str) {
        for entry in self.entries.values_mut() {
            entry.holders.retain(|h| h.window != window);
        }
        self.drop_emptied();
    }

    pub(crate) fn poke(&mut self, session_id: &str, agent_id: &str) {
        if let Some(key) = self.key_for(session_id, agent_id) {
            self.read_to_eof(&key);
        }
    }

    /// Read every entry an OS event names. The event may name the file, or
    /// only its directory when the OS coalesced a burst into a rescan.
    pub(crate) fn on_paths(&mut self, paths: &[PathBuf]) {
        let touched: Vec<PathBuf> = self
            .entries
            .iter()
            .filter(|(file, entry)| paths.iter().any(|p| names_entry(p, file, &entry.dir)))
            .map(|(file, _)| file.clone())
            .collect();
        for key in touched {
            self.read_to_eof(&key);
        }
    }

    fn send(&self, entry: &WatchEntry, kind: TailEventKind, start: usize, entries: Vec<TranscriptEntry>) {
        let event = TailEvent {
            kind,
            session_id: entry.session_id.clone(),
            agent_id: entry.agent_id.clone(),
            start,
            entries,
        };
        let topic = topic(&entry.session_id, &entry.agent_id);
        let mut windows: Vec<&str> = entry.holders.iter().map(|h| h.window.as_str()).collect();
        windows.sort_unstable();
        windows.dedup();
        for window in windows {
            (self.emit)(window, &topic, &event);
        }
    }

    fn read_to_eof(&mut self, key: &Path) {
        self.reads += 1;
        let meta = match fs::metadata(key) {
            Ok(meta) => meta,
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                if let Some(entry) = self.entries.get(key) {
                    self.send(entry, TailEventKind::Expired, 0, Vec::new());
                }
                self.drop_entry(key);
                return;
            }
            Err(_) => return,
        };

        let Some(mut entry) = self.entries.remove(key) else { return };
        let inode = inode_of(&meta);
        let was_replaced = entry.tail.inode.is_some() && inode != entry.tail.inode;
        let has_shrunk = meta.len() < entry.tail.offset;
        if was_replaced || has_shrunk {
            entry.tail = TranscriptTail { inode, ..TranscriptTail::default() };
            self.send(&entry, TailEventKind::Reset, 0, Vec::new());
        }

        if let Ok(mut file) = fs::File::open(key) {
            self.drain(&mut file, &mut entry);
        }
        self.entries.insert(key.to_path_buf(), entry);
    }

    fn drain(&self, file: &mut fs::File, entry: &mut WatchEntry) {
        if file.seek(SeekFrom::Start(entry.tail.offset)).is_err() {
            return;
        }

        let mut chunk = Vec::new();
        loop {
            chunk.clear();
            let read = match file.by_ref().take(READ_CHUNK).read_to_end(&mut chunk) {
                Ok(read) => read,
                Err(_) => return,
            };
            if read == 0 {
                return;
            }

            entry.tail.offset += read as u64;
            entry.tail.carry.extend_from_slice(&chunk);
            let Some(last_break) = entry.tail.carry.iter().rposition(|b| *b == b'\n') else { continue };

            let complete: Vec<u8> = entry.tail.carry.drain(..=last_break).collect();
            let parsed = transcripts::parse_transcript(&String::from_utf8_lossy(&complete));
            if parsed.entries.is_empty() {
                continue;
            }

            let start = entry.tail.entries_seen;
            entry.tail.entries_seen += parsed.entries.len();
            self.send(entry, TailEventKind::Entries, start, parsed.entries);
        }
    }
}

fn names_entry(event_path: &Path, file: &Path, dir: &Path) -> bool {
    if event_path == file || event_path == dir {
        return true;
    }

    let same_name = event_path.file_name().is_some() && event_path.file_name() == file.file_name();
    if !same_name {
        return false;
    }

    event_path
        .parent()
        .is_some_and(|parent| parent == dir || fs::canonicalize(parent).is_ok_and(|p| p == dir))
}

// ---------------------------------------------------------------------------
// the process-wide registry and its notify backend

static APP: OnceLock<AppHandle> = OnceLock::new();
static REGISTRY: OnceLock<Mutex<Registry>> = OnceLock::new();

struct NotifyWatcher(notify::RecommendedWatcher);

impl DirWatcher for NotifyWatcher {
    fn watch(&mut self, dir: &Path) -> Result<(), String> {
        use notify::Watcher;
        self.0.watch(dir, notify::RecursiveMode::NonRecursive).map_err(|e| e.to_string())
    }

    fn unwatch(&mut self, dir: &Path) {
        use notify::Watcher;
        let _ = self.0.unwatch(dir);
    }
}

/// The notify callback runs on the OS event thread and only forwards paths.
/// The worker blocks on the channel and exits when the watcher is dropped.
fn notify_backend() -> Result<Box<dyn DirWatcher>, String> {
    let (tx, rx) = std::sync::mpsc::channel::<notify::Result<notify::Event>>();
    let watcher = notify::recommended_watcher(tx).map_err(|e| e.to_string())?;
    std::thread::Builder::new()
        .name("subagent-watch".into())
        .spawn(move || {
            for event in rx.iter().flatten() {
                let is_our_own_read = matches!(event.kind, notify::EventKind::Access(_));
                if is_our_own_read {
                    continue;
                }
                registry().on_paths(&event.paths);
            }
        })
        .map_err(|e| e.to_string())?;
    Ok(Box::new(NotifyWatcher(watcher)))
}

fn emit_to_holder(window: &str, topic: &str, event: &TailEvent) {
    if let Some(app) = APP.get() {
        crate::emit_to_window(app, Some(window), topic, event.clone());
    }
}

fn registry() -> MutexGuard<'static, Registry> {
    REGISTRY
        .get_or_init(|| Mutex::new(Registry::new(Box::new(notify_backend), Box::new(emit_to_holder))))
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}

/// Drop every watch a task holds. Does nothing if no view was ever opened.
pub(crate) fn release_task(task_id: &str) {
    if let Some(registry) = REGISTRY.get() {
        registry.lock().unwrap_or_else(|e| e.into_inner()).release_task(task_id);
    }
}

/// Drop every watch a window holds. Does nothing if no view was ever opened.
pub(crate) fn release_window(window: &str) {
    if let Some(registry) = REGISTRY.get() {
        registry.lock().unwrap_or_else(|e| e.into_inner()).release_window(window);
    }
}

// ---------------------------------------------------------------------------
// commands

/// Start tailing one subagent's transcript for the calling window. Batches
/// arrive on `subagent-watch://<sessionId>/<agentId>`.
#[tauri::command]
pub async fn subagent_watch_open(
    app: AppHandle,
    window: tauri::Window,
    task_id: String,
    tab_id: String,
    session_id: String,
    agent_id: String,
    workflow_run_id: Option<String>,
) -> Result<WatchOpened, String> {
    let _ = APP.set(app);
    let label = window.label().to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let dir = transcripts::subagents_dir_for(&task_id, &session_id)?;
        let (bare, file) = resolve_target(&dir, &agent_id, workflow_run_id.as_deref()).map_err(|e| e.to_string())?;
        let tail = prime(&file).map_err(|e| format!("subagent transcript unreadable: {e}"))?;
        let holder = Holder { window: label, task_id, tab_id };
        Ok(registry().open(holder, &session_id, &bare, file, tail))
    })
    .await
    .map_err(|e| format!("subagent watch open failed: {e}"))?
}

#[tauri::command]
pub async fn subagent_watch_close(
    window: tauri::Window,
    task_id: String,
    tab_id: String,
    session_id: String,
    agent_id: String,
) -> Result<(), String> {
    let label = window.label().to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let bare = transcripts::validate_agent_id(&agent_id).map_err(|e| e.to_string())?;
        let holder = Holder { window: label, task_id, tab_id };
        registry().close(&holder, &session_id, bare);
        Ok(())
    })
    .await
    .map_err(|e| format!("subagent watch close failed: {e}"))?
}

/// Read a watched transcript to EOF now. For hook events, which flush a view
/// even where file events never arrive. A file no view holds is not read.
#[tauri::command]
pub async fn subagent_watch_poke(session_id: String, agent_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let bare = transcripts::validate_agent_id(&agent_id).map_err(|e| e.to_string())?;
        registry().poke(&session_id, bare);
        Ok(())
    })
    .await
    .map_err(|e| format!("subagent watch poke failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::sync::{Arc, Mutex as StdMutex};

    const SESSION: &str = "0b1c2d3e-0000-4000-8000-000000000001";
    const TASK_PATH: &str = "/Users/u/dev/acme";

    type Sent = Arc<StdMutex<Vec<(String, String, TailEvent)>>>;

    struct FakeBackend {
        watched: Arc<StdMutex<Vec<PathBuf>>>,
        /// Refuse any directory whose path contains this, the way inotify
        /// refuses once `max_user_watches` is spent.
        refuse: Option<&'static str>,
    }

    impl DirWatcher for FakeBackend {
        fn watch(&mut self, dir: &Path) -> Result<(), String> {
            let is_refused = self.refuse.is_some_and(|needle| dir.to_string_lossy().contains(needle));
            if is_refused {
                return Err("No space left on device (os error 28)".into());
            }
            self.watched.lock().unwrap().push(dir.to_path_buf());
            Ok(())
        }

        fn unwatch(&mut self, dir: &Path) {
            self.watched.lock().unwrap().retain(|d| d != dir);
        }
    }

    struct Harness {
        registry: Registry,
        sent: Sent,
        watched: Arc<StdMutex<Vec<PathBuf>>>,
        _tmp: tempfile::TempDir,
        dir: PathBuf,
    }

    fn harness_with(factory: impl Fn(Arc<StdMutex<Vec<PathBuf>>>) -> WatcherFactory) -> Harness {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("projects");
        let dir = transcripts::session_subagents_dir(&root, TASK_PATH, SESSION).unwrap();
        fs::create_dir_all(&dir).unwrap();
        let dir = fs::canonicalize(&dir).unwrap();

        let sent: Sent = Arc::default();
        let sink = sent.clone();
        let watched: Arc<StdMutex<Vec<PathBuf>>> = Arc::default();
        let emit: Emitter = Box::new(move |window, topic, event| {
            sink.lock().unwrap().push((window.to_string(), topic.to_string(), event.clone()));
        });
        let registry = Registry::new(factory(watched.clone()), emit);
        Harness { registry, sent, watched, _tmp: tmp, dir }
    }

    fn harness() -> Harness {
        harness_with(|watched| {
            Box::new(move || {
                let backend = FakeBackend { watched: watched.clone(), refuse: None };
                Ok(Box::new(backend) as Box<dyn DirWatcher>)
            })
        })
    }

    fn holder(window: &str, task: &str, tab: &str) -> Holder {
        Holder { window: window.into(), task_id: task.into(), tab_id: tab.into() }
    }

    fn line(text: &str) -> String {
        serde_json::json!({
            "type": "assistant",
            "message": { "role": "assistant", "content": [{ "type": "text", "text": text }], "stop_reason": "end_turn" },
        })
        .to_string()
    }

    fn append(path: &Path, raw: &str) {
        let mut file = fs::OpenOptions::new().create(true).append(true).open(path).unwrap();
        file.write_all(raw.as_bytes()).unwrap();
    }

    impl Harness {
        fn transcript(&self, agent: &str, raw: &str) -> PathBuf {
            let path = self.dir.join(format!("agent-{agent}.jsonl"));
            fs::write(&path, raw).unwrap();
            fs::canonicalize(path).unwrap()
        }

        fn open(&mut self, who: Holder, agent: &str) -> WatchOpened {
            let (bare, file) = resolve_target(&self.dir, agent, None).unwrap();
            let tail = prime(&file).unwrap();
            self.registry.open(who, SESSION, &bare, file, tail)
        }

        fn take(&self) -> Vec<(String, String, TailEvent)> {
            std::mem::take(&mut *self.sent.lock().unwrap())
        }

        fn texts(&self) -> Vec<String> {
            self.take()
                .into_iter()
                .filter(|(_, _, e)| e.kind == TailEventKind::Entries)
                .flat_map(|(_, _, e)| e.entries.into_iter().map(|entry| entry.text))
                .collect()
        }
    }

    #[test]
    fn subagent_watch_delivers_appended_lines_to_the_opening_window() {
        let mut h = harness();
        let file = h.transcript("a1", &format!("{}\n", line("before")));
        let opened = h.open(holder("main", "t1", "tab1"), "a1");
        assert_eq!(opened, WatchOpened { live: true, total: 1 });

        append(&file, &format!("{}\n{}\n", line("one"), line("two")));
        h.registry.on_paths(&[file.clone()]);
        let sent = h.take();
        assert_eq!(sent.len(), 1);
        let (window, topic, event) = &sent[0];
        assert_eq!(window, "main");
        assert_eq!(topic, &format!("subagent-watch://{SESSION}/a1"));
        assert_eq!(event.start, 1);
        let texts: Vec<&str> = event.entries.iter().map(|e| e.text.as_str()).collect();
        assert_eq!(texts, ["one", "two"]);

        h.registry.on_paths(&[file.clone()]);
        assert!(h.take().is_empty(), "a second event with nothing new emits nothing");

        append(&file, &format!("{}\n", line("three")));
        h.registry.on_paths(&[h.dir.clone()]);
        let sent = h.take();
        assert_eq!(sent.len(), 1);
        assert_eq!(sent[0].2.start, 3);
    }

    #[test]
    fn subagent_watch_shares_one_entry_and_drops_it_on_the_last_close() {
        let mut h = harness();
        h.transcript("a1", "");
        let view = holder("main", "t1", "tab1");

        h.open(view.clone(), "a1");
        assert_eq!(h.registry.watch_count(), 1);
        h.open(view.clone(), "a1");
        assert_eq!(h.registry.watch_count(), 1);
        assert_eq!(h.watched.lock().unwrap().len(), 1, "one directory watch for both views");

        h.registry.close(&view, SESSION, "a1");
        assert_eq!(h.registry.watch_count(), 1);
        h.registry.close(&view, SESSION, "a1");
        assert_eq!(h.registry.watch_count(), 0);
        assert!(h.watched.lock().unwrap().is_empty());
        assert!(h.registry.backend.is_none(), "the backend goes with the last watch");
    }

    #[test]
    fn subagent_watch_releases_everything_a_task_holds() {
        let mut h = harness();
        h.transcript("a1", "");
        h.transcript("a2", "");
        h.open(holder("main", "t1", "tab1"), "a1");
        h.open(holder("main", "t1", "tab2"), "a2");
        h.open(holder("main", "t2", "tab3"), "a2");
        assert_eq!(h.registry.watch_count(), 2);

        h.registry.release_task("t1");
        assert_eq!(h.registry.watch_count(), 1);
        h.registry.release_task("t2");
        assert_eq!(h.registry.watch_count(), 0);
    }

    #[test]
    fn subagent_watch_releases_everything_a_window_holds() {
        let mut h = harness();
        h.transcript("a1", "");
        h.transcript("a2", "");
        h.open(holder("main", "t1", "tab1"), "a1");
        h.open(holder("main", "t1", "tab1"), "a2");
        h.open(holder("profile-acme", "t9", "tab9"), "a2");

        h.registry.release_window("main");
        assert_eq!(h.registry.watch_count(), 1);
        h.registry.release_window("profile-acme");
        assert_eq!(h.registry.watch_count(), 0);
    }

    #[test]
    fn subagent_watch_emits_once_per_window_however_many_views_it_has() {
        let mut h = harness();
        let file = h.transcript("a1", "");
        h.open(holder("main", "t1", "tab1"), "a1");
        h.open(holder("main", "t1", "tab1"), "a1");
        h.open(holder("profile-acme", "t9", "tab9"), "a1");

        append(&file, &format!("{}\n", line("hi")));
        h.registry.on_paths(&[file]);
        let windows: Vec<String> = h.take().into_iter().map(|(w, _, _)| w).collect();
        assert_eq!(windows, ["main", "profile-acme"]);
    }

    #[test]
    fn subagent_watch_carries_a_line_split_across_two_writes() {
        let mut h = harness();
        let file = h.transcript("a1", "");
        h.open(holder("main", "t1", "tab1"), "a1");

        let whole = line("split in two");
        let (head, rest) = whole.split_at(whole.len() / 2);
        append(&file, head);
        h.registry.on_paths(&[file.clone()]);
        assert!(h.take().is_empty(), "half a line is never parsed");

        append(&file, &format!("{rest}\n"));
        h.registry.on_paths(&[file.clone()]);
        assert_eq!(h.texts(), ["split in two"]);

        h.registry.on_paths(&[file]);
        assert!(h.take().is_empty());
    }

    #[test]
    fn subagent_watch_primes_past_an_unfinished_line() {
        let mut h = harness();
        let whole = line("finished later");
        let (head, rest) = whole.split_at(10);
        let file = h.transcript("a1", &format!("{}\n{head}", line("done")));
        assert_eq!(h.open(holder("main", "t1", "tab1"), "a1").total, 1);

        append(&file, &format!("{rest}\n"));
        h.registry.on_paths(&[file]);
        assert_eq!(h.texts(), ["finished later"]);
    }

    #[test]
    fn subagent_watch_resets_when_the_file_shrinks() {
        let mut h = harness();
        let file = h.transcript("a1", &format!("{}\n{}\n", line("one"), line("two")));
        h.open(holder("main", "t1", "tab1"), "a1");

        fs::OpenOptions::new().write(true).open(&file).unwrap().set_len(0).unwrap();
        append(&file, &format!("{}\n", line("fresh")));
        h.registry.on_paths(&[file.clone()]);

        let sent = h.take();
        let kinds: Vec<TailEventKind> = sent.iter().map(|(_, _, e)| e.kind).collect();
        assert_eq!(kinds, [TailEventKind::Reset, TailEventKind::Entries]);
        assert_eq!(sent[1].2.start, 0);
        assert_eq!(sent[1].2.entries[0].text, "fresh");
        let tail = &h.registry.entries[&file].tail;
        assert!(tail.carry.is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn subagent_watch_resets_when_the_inode_changes() {
        let mut h = harness();
        let file = h.transcript("a1", &format!("{}\n", line("old")));
        h.open(holder("main", "t1", "tab1"), "a1");

        let replacement = h.dir.join("agent-a1.jsonl.tmp");
        fs::write(&replacement, format!("{}\n{}\n{}\n", line("new one"), line("new two"), line("new three"))).unwrap();
        fs::rename(&replacement, &file).unwrap();
        h.registry.on_paths(&[file]);

        let sent = h.take();
        let kinds: Vec<TailEventKind> = sent.iter().map(|(_, _, e)| e.kind).collect();
        assert_eq!(kinds, [TailEventKind::Reset, TailEventKind::Entries]);
        assert_eq!(sent[1].2.start, 0);
        assert_eq!(sent[1].2.entries.len(), 3);
    }

    #[test]
    fn subagent_watch_expires_and_releases_a_deleted_file() {
        let mut h = harness();
        let file = h.transcript("a1", "");
        h.open(holder("main", "t1", "tab1"), "a1");

        fs::remove_file(&file).unwrap();
        h.registry.on_paths(&[file]);
        let sent = h.take();
        assert_eq!(sent.len(), 1);
        assert_eq!(sent[0].2.kind, TailEventKind::Expired);
        assert_eq!(sent[0].2.agent_id, "a1");
        assert_eq!(h.registry.watch_count(), 0);
        assert!(h.watched.lock().unwrap().is_empty());
    }

    #[test]
    fn subagent_watch_refuses_a_traversal_agent_id() {
        let h = harness();
        for bad in ["../../etc/passwd", "a/b", "..", "a b"] {
            assert!(matches!(resolve_target(&h.dir, bad, None), Err(ResolveError::InvalidId(_))), "{bad}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn subagent_watch_refuses_a_symlink_out_of_the_subagents_dir() {
        let h = harness();
        let outside = h._tmp.path().join("secret.jsonl");
        fs::write(&outside, format!("{}\n", line("not yours"))).unwrap();
        std::os::unix::fs::symlink(&outside, h.dir.join("agent-aZZZ.jsonl")).unwrap();

        assert_eq!(resolve_target(&h.dir, "aZZZ", None), Err(ResolveError::Escapes));
    }

    #[test]
    fn subagent_watch_falls_back_to_pokes_when_the_backend_cannot_start() {
        let mut h = harness_with(|_| Box::new(|| Err("Too many open files (os error 24)".to_string())));
        let file = h.transcript("a1", "");
        let opened = h.open(holder("main", "t1", "tab1"), "a1");
        assert_eq!(opened, WatchOpened { live: false, total: 0 });
        assert!(h.registry.logged_failure);

        append(&file, &format!("{}\n", line("via poke")));
        h.registry.poke(SESSION, "a1");
        assert_eq!(h.texts(), ["via poke"]);
    }

    #[test]
    fn subagent_watch_survives_a_watch_that_cannot_be_added() {
        let mut h = harness_with(|watched| {
            Box::new(move || {
                let backend = FakeBackend { watched: watched.clone(), refuse: Some("workflows") };
                Ok(Box::new(backend) as Box<dyn DirWatcher>)
            })
        });
        let plain = h.transcript("a1", "");
        assert!(h.open(holder("main", "t1", "tab1"), "a1").live);

        // A workflow agent sits in a directory of its own, so it needs a
        // second directory watch, which the backend refuses here.
        let run_dir = h.dir.join("workflows").join("wf_r1");
        fs::create_dir_all(&run_dir).unwrap();
        fs::write(run_dir.join("agent-w1.jsonl"), "").unwrap();
        let (bare, file) = resolve_target(&h.dir, "w1", Some("wf_r1")).unwrap();
        let tail = prime(&file).unwrap();
        let opened = h.registry.open(holder("main", "t1", "tab1"), SESSION, &bare, file, tail);
        assert_eq!(opened, WatchOpened { live: false, total: 0 });
        assert_eq!(h.registry.watch_count(), 2);

        append(&plain, &format!("{}\n", line("still live")));
        h.registry.on_paths(&[plain]);
        assert_eq!(h.texts(), ["still live"]);
        assert_eq!(h.watched.lock().unwrap().len(), 1);
    }

    #[test]
    fn subagent_watch_poke_without_a_view_reads_nothing() {
        let mut h = harness();
        h.transcript("a1", &format!("{}\n", line("unwatched")));
        h.registry.poke(SESSION, "a1");
        assert_eq!(h.registry.reads, 0);
        assert!(h.take().is_empty());

        h.open(holder("main", "t1", "tab1"), "a1");
        h.registry.poke(SESSION, "a1");
        assert_eq!(h.registry.reads, 1);
    }

    #[test]
    fn subagent_watch_source_has_no_sleep_or_timed_wait() {
        let src = include_str!("subagent_watch.rs");
        let banned = [concat!("thread", "::sleep"), concat!("recv", "_timeout"), concat!("wait", "_timeout")];
        for needle in banned {
            assert!(!src.contains(needle), "subagent_watch.rs must not use {needle}");
        }
    }
}
