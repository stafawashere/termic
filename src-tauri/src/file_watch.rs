//! Change events for the files an editor tab has open.
//!
//! The editor used to learn about an agent's write only when a turn finished
//! or the window regained focus. A tab that opens a file now registers it
//! here, and the frontend gets `editor-file-changed { taskId, path }` shortly
//! after the file is touched, then re-reads it itself. Nothing in this module
//! reads file content.
//!
//! Each file is held by a refcount, so two tabs on one file share one entry.
//! The watch is placed on the file's PARENT directory, non-recursively,
//! because an editor that saves by renaming a temp file over the target
//! replaces the inode and a watch on the file itself would go deaf. Entries
//! in one directory share that directory's single watch.
//!
//! The notify callback only forwards events to a worker thread. The worker
//! blocks on the channel with a timeout equal to the next debounce deadline,
//! so a burst of events for one file becomes one emit and an idle app holds no
//! timers (docs/performance.md bear trap 9).

use serde::Serialize;
use std::collections::HashMap;
use std::hash::Hash;
use std::path::{Path, PathBuf};
use std::sync::mpsc::RecvTimeoutError;
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};
use tauri::AppHandle;

const DEBOUNCE: Duration = Duration::from_millis(75);
const CHANGED_TOPIC: &str = "editor-file-changed";

#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FileChanged {
    pub task_id: String,
    pub path: String,
}

trait DirWatcher: Send {
    fn watch(&mut self, dir: &Path) -> Result<(), String>;
    fn unwatch(&mut self, dir: &Path);
}

struct Entry {
    rel: String,
    canon: PathBuf,
    refs: usize,
}

struct Registry {
    watcher: Box<dyn DirWatcher>,
    entries: HashMap<(String, PathBuf), Entry>,
    dir_refs: HashMap<PathBuf, usize>,
}

impl Registry {
    fn new(watcher: Box<dyn DirWatcher>) -> Self {
        Self { watcher, entries: HashMap::new(), dir_refs: HashMap::new() }
    }

    fn watch(&mut self, task_id: &str, rel: &str, abs: &Path) -> Result<(), String> {
        let key = (task_id.to_string(), abs.to_path_buf());
        if let Some(entry) = self.entries.get_mut(&key) {
            entry.refs += 1;
            return Ok(());
        }

        let dir = abs.parent().ok_or("path has no parent directory")?.to_path_buf();
        let dir_is_new = !self.dir_refs.contains_key(&dir);
        if dir_is_new {
            self.watcher.watch(&dir)?;
        }
        *self.dir_refs.entry(dir.clone()).or_insert(0) += 1;

        let canon = canonical_target(abs);
        self.entries.insert(key, Entry { rel: rel.to_string(), canon, refs: 1 });
        Ok(())
    }

    /// `abs` is None when the path no longer resolves (the file or its
    /// folder was deleted), in which case the entry is found by the string
    /// the tab registered it under.
    fn unwatch(&mut self, task_id: &str, rel: &str, abs: Option<&Path>) {
        let key = self
            .entries
            .iter()
            .find(|((entry_task, entry_abs), entry)| {
                let same_task = entry_task == task_id;
                let same_target = match abs {
                    Some(abs) => entry_abs == abs,
                    None => entry.rel == rel,
                };
                same_task && same_target
            })
            .map(|(key, _)| key.clone());
        let Some(key) = key else { return };

        let remaining = match self.entries.get_mut(&key) {
            Some(entry) => {
                entry.refs -= 1;
                entry.refs
            }
            None => return,
        };
        if remaining == 0 {
            self.entries.remove(&key);
            self.release_dir(&key.1);
        }
    }

    fn release_task(&mut self, task_id: &str) {
        let keys: Vec<(String, PathBuf)> =
            self.entries.keys().filter(|(entry_task, _)| entry_task == task_id).cloned().collect();
        for key in keys {
            self.entries.remove(&key);
            self.release_dir(&key.1);
        }
    }

    fn release_dir(&mut self, abs: &Path) {
        let Some(dir) = abs.parent() else { return };
        let Some(count) = self.dir_refs.get_mut(dir) else { return };
        *count -= 1;
        if *count == 0 {
            self.dir_refs.remove(dir);
            self.watcher.unwatch(dir);
        }
    }

    fn matching(&self, event_paths: &[PathBuf]) -> Vec<FileChanged> {
        let mut changed = Vec::new();
        for ((task_id, abs), entry) in &self.entries {
            let is_hit = event_paths.iter().any(|p| p == abs || *p == entry.canon);
            if is_hit {
                changed.push(FileChanged { task_id: task_id.clone(), path: entry.rel.clone() });
            }
        }
        changed
    }
}

/// FSEvents reports the resolved path (`/private/var/...` for `/var/...`), so
/// the registry also remembers the file under its parent's canonical form.
fn canonical_target(abs: &Path) -> PathBuf {
    let canon_parent = abs.parent().and_then(|p| std::fs::canonicalize(p).ok());
    match (canon_parent, abs.file_name()) {
        (Some(parent), Some(name)) => parent.join(name),
        _ => abs.to_path_buf(),
    }
}

/// Coalesces repeated keys into one release per window. The deadline is fixed
/// by the FIRST event of a burst, so a file written continuously still
/// reports every `window` instead of never.
struct Debouncer<K> {
    window: Duration,
    pending: HashMap<K, Instant>,
}

impl<K: Hash + Eq + Clone> Debouncer<K> {
    fn new(window: Duration) -> Self {
        Self { window, pending: HashMap::new() }
    }

    fn push(&mut self, key: K, now: Instant) {
        let window = self.window;
        self.pending.entry(key).or_insert(now + window);
    }

    fn next_deadline(&self) -> Option<Instant> {
        self.pending.values().min().copied()
    }

    fn drain_all(&mut self) -> Vec<K> {
        self.pending.drain().map(|(key, _)| key).collect()
    }

    fn drain_due(&mut self, now: Instant) -> Vec<K> {
        let due: Vec<K> = self.pending.iter().filter(|(_, deadline)| **deadline <= now).map(|(k, _)| k.clone()).collect();
        for key in &due {
            self.pending.remove(key);
        }
        due
    }
}

fn is_read_only_event(event: &notify::Event) -> bool {
    matches!(event.kind, notify::EventKind::Access(_))
}

fn run_worker(
    rx: std::sync::mpsc::Receiver<notify::Result<notify::Event>>,
    matcher: impl Fn(&[PathBuf]) -> Vec<FileChanged>,
    emit: impl Fn(&FileChanged),
) {
    let mut debouncer: Debouncer<FileChanged> = Debouncer::new(DEBOUNCE);
    loop {
        let received = match debouncer.next_deadline() {
            Some(deadline) => rx.recv_timeout(deadline.saturating_duration_since(Instant::now())),
            None => rx.recv().map_err(|_| RecvTimeoutError::Disconnected),
        };

        match received {
            Ok(Ok(event)) if !is_read_only_event(&event) => {
                let now = Instant::now();
                for changed in matcher(&event.paths) {
                    debouncer.push(changed, now);
                }
            }
            Ok(_) => {}
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => {
                for changed in debouncer.drain_all() {
                    emit(&changed);
                }
                break;
            }
        }

        for changed in debouncer.drain_due(Instant::now()) {
            emit(&changed);
        }
    }
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

fn notify_backend() -> Result<Box<dyn DirWatcher>, String> {
    let (tx, rx) = std::sync::mpsc::channel::<notify::Result<notify::Event>>();
    let watcher = notify::recommended_watcher(tx).map_err(|e| e.to_string())?;
    std::thread::Builder::new()
        .name("editor-file-watch".into())
        .spawn(move || {
            let matcher = |paths: &[PathBuf]| registry().map(|r| r.matching(paths)).unwrap_or_default();
            run_worker(rx, matcher, emit_changed);
        })
        .map_err(|e| e.to_string())?;
    Ok(Box::new(NotifyWatcher(watcher)))
}

fn emit_changed(changed: &FileChanged) {
    if let Some(app) = APP.get() {
        crate::emit_scoped_by_id(app, &changed.task_id, CHANGED_TOPIC, changed.clone());
    }
}

/// Builds the registry on first use. Err when notify cannot start; the editor
/// then keeps its turn-end and focus reloads.
fn registry() -> Result<MutexGuard<'static, Registry>, String> {
    if REGISTRY.get().is_none() {
        let backend = notify_backend()?;
        let _ = REGISTRY.set(Mutex::new(Registry::new(backend)));
    }
    let registry = REGISTRY.get().ok_or("file watcher unavailable")?;
    Ok(registry.lock().unwrap_or_else(|e| e.into_inner()))
}

/// Drop every file watch a task holds. Does nothing if none was ever opened.
pub(crate) fn release_task(task_id: &str) {
    if let Some(registry) = REGISTRY.get() {
        registry.lock().unwrap_or_else(|e| e.into_inner()).release_task(task_id);
    }
}

fn resolve_abs(task_id: &str, path: &str) -> Result<PathBuf, String> {
    let task = crate::load_tasks_all().into_iter().find(|t| t.id == task_id).ok_or("no task")?;
    let (cwd, rel) = crate::resolve_task_git_path(&task, path)?;
    crate::safe_task_read_path(&task, &cwd, &rel)
}

/// Start (or share) a watch on one file of a task. Same containment as
/// `task_file_read`, so a path outside the checkout is refused.
#[tauri::command]
pub async fn editor_watch_file(app: AppHandle, id: String, path: String) -> Result<(), String> {
    let _ = APP.set(app);
    tauri::async_runtime::spawn_blocking(move || {
        let abs = resolve_abs(&id, &path)?;
        registry()?.watch(&id, &path, &abs)
    })
    .await
    .map_err(|e| format!("editor watch failed: {e}"))?
}

#[tauri::command]
pub async fn editor_unwatch_file(id: String, path: String) -> Result<(), String> {
    if REGISTRY.get().is_none() {
        return Ok(());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let abs = resolve_abs(&id, &path).ok();
        if let Ok(mut registry) = registry() {
            registry.unwatch(&id, &path, abs.as_deref());
        }
    })
    .await
    .map_err(|e| format!("editor unwatch failed: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex as StdMutex};

    #[derive(Default)]
    struct Calls {
        watched: Vec<PathBuf>,
        unwatched: Vec<PathBuf>,
    }

    struct FakeWatcher(Arc<StdMutex<Calls>>);

    impl DirWatcher for FakeWatcher {
        fn watch(&mut self, dir: &Path) -> Result<(), String> {
            self.0.lock().unwrap().watched.push(dir.to_path_buf());
            Ok(())
        }

        fn unwatch(&mut self, dir: &Path) {
            self.0.lock().unwrap().unwatched.push(dir.to_path_buf());
        }
    }

    fn registry_with_calls() -> (Registry, Arc<StdMutex<Calls>>) {
        let calls = Arc::new(StdMutex::new(Calls::default()));
        (Registry::new(Box::new(FakeWatcher(calls.clone()))), calls)
    }

    #[test]
    fn two_tabs_on_one_file_share_one_watch_until_the_last_closes() {
        let (mut registry, calls) = registry_with_calls();
        let file = PathBuf::from("/Users/u/repo/src/a.ts");

        registry.watch("t1", "src/a.ts", &file).unwrap();
        registry.watch("t1", "src/a.ts", &file).unwrap();
        assert_eq!(calls.lock().unwrap().watched.len(), 1);

        registry.unwatch("t1", "src/a.ts", Some(&file));
        assert!(calls.lock().unwrap().unwatched.is_empty());
        assert_eq!(registry.matching(&[file.clone()]).len(), 1);

        registry.unwatch("t1", "src/a.ts", Some(&file));
        assert_eq!(calls.lock().unwrap().unwatched, vec![PathBuf::from("/Users/u/repo/src")]);
        assert!(registry.matching(&[file]).is_empty());
    }

    #[test]
    fn files_in_one_directory_share_the_directory_watch() {
        let (mut registry, calls) = registry_with_calls();
        let first = PathBuf::from("/Users/u/repo/src/a.ts");
        let second = PathBuf::from("/Users/u/repo/src/b.ts");

        registry.watch("t1", "src/a.ts", &first).unwrap();
        registry.watch("t1", "src/b.ts", &second).unwrap();
        assert_eq!(calls.lock().unwrap().watched.len(), 1);

        registry.unwatch("t1", "src/a.ts", Some(&first));
        assert!(calls.lock().unwrap().unwatched.is_empty());

        registry.unwatch("t1", "src/b.ts", Some(&second));
        assert_eq!(calls.lock().unwrap().unwatched.len(), 1);
    }

    #[test]
    fn events_for_other_files_in_the_directory_are_filtered_out() {
        let (mut registry, _calls) = registry_with_calls();
        let file = PathBuf::from("/Users/u/repo/src/a.ts");
        registry.watch("t1", "src/a.ts", &file).unwrap();

        let sibling = PathBuf::from("/Users/u/repo/src/b.ts");
        let directory = PathBuf::from("/Users/u/repo/src");
        assert!(registry.matching(&[sibling, directory]).is_empty());

        let hits = registry.matching(&[file]);
        assert_eq!(hits, vec![FileChanged { task_id: "t1".into(), path: "src/a.ts".into() }]);
    }

    #[test]
    fn unwatch_falls_back_to_the_registered_string_when_the_path_no_longer_resolves() {
        let (mut registry, calls) = registry_with_calls();
        let file = PathBuf::from("/Users/u/repo/src/a.ts");
        registry.watch("t1", "src/a.ts", &file).unwrap();

        registry.unwatch("t1", "src/a.ts", None);

        assert_eq!(calls.lock().unwrap().unwatched.len(), 1);
        assert!(registry.entries.is_empty());
    }

    #[test]
    fn release_task_drops_only_that_tasks_watches() {
        let (mut registry, calls) = registry_with_calls();
        let first = PathBuf::from("/Users/u/one/a.ts");
        let second = PathBuf::from("/Users/u/two/a.ts");
        registry.watch("t1", "a.ts", &first).unwrap();
        registry.watch("t1", "a.ts", &first).unwrap();
        registry.watch("t2", "a.ts", &second).unwrap();

        registry.release_task("t1");

        assert_eq!(calls.lock().unwrap().unwatched, vec![PathBuf::from("/Users/u/one")]);
        assert!(registry.matching(&[first]).is_empty());
        assert_eq!(registry.matching(&[second]).len(), 1);
    }

    #[test]
    fn debouncer_coalesces_a_burst_into_one_release() {
        let start = Instant::now();
        let mut debouncer: Debouncer<&str> = Debouncer::new(Duration::from_millis(75));

        debouncer.push("a", start);
        debouncer.push("a", start + Duration::from_millis(20));
        debouncer.push("a", start + Duration::from_millis(60));

        assert!(debouncer.drain_due(start + Duration::from_millis(74)).is_empty());
        assert_eq!(debouncer.drain_due(start + Duration::from_millis(75)), vec!["a"]);
        assert!(debouncer.drain_due(start + Duration::from_millis(500)).is_empty());
        assert_eq!(debouncer.next_deadline(), None);
    }

    #[test]
    fn debouncer_keeps_files_independent_and_reports_the_earliest_deadline() {
        let start = Instant::now();
        let mut debouncer: Debouncer<&str> = Debouncer::new(Duration::from_millis(75));

        debouncer.push("a", start);
        debouncer.push("b", start + Duration::from_millis(50));
        assert_eq!(debouncer.next_deadline(), Some(start + Duration::from_millis(75)));

        assert_eq!(debouncer.drain_due(start + Duration::from_millis(80)), vec!["a"]);
        assert_eq!(debouncer.next_deadline(), Some(start + Duration::from_millis(125)));
    }

    #[test]
    fn debouncer_starts_a_new_window_after_a_release() {
        let start = Instant::now();
        let mut debouncer: Debouncer<&str> = Debouncer::new(Duration::from_millis(75));

        debouncer.push("a", start);
        assert_eq!(debouncer.drain_due(start + Duration::from_millis(75)).len(), 1);

        debouncer.push("a", start + Duration::from_millis(80));
        assert_eq!(debouncer.next_deadline(), Some(start + Duration::from_millis(155)));
    }

    #[test]
    fn worker_emits_once_for_a_burst_and_exits_when_the_channel_closes() {
        let (tx, rx) = std::sync::mpsc::channel::<notify::Result<notify::Event>>();
        let file = PathBuf::from("/Users/u/repo/a.ts");
        let emitted: Arc<StdMutex<Vec<FileChanged>>> = Arc::new(StdMutex::new(Vec::new()));

        let match_file = file.clone();
        let matcher = move |paths: &[PathBuf]| {
            let is_hit = paths.iter().any(|p| *p == match_file);
            if is_hit {
                vec![FileChanged { task_id: "t1".into(), path: "a.ts".into() }]
            } else {
                Vec::new()
            }
        };
        let sink = emitted.clone();
        let handle = std::thread::spawn(move || run_worker(rx, matcher, move |c| sink.lock().unwrap().push(c.clone())));

        for _ in 0..5 {
            let event = notify::Event::new(notify::EventKind::Modify(notify::event::ModifyKind::Any)).add_path(file.clone());
            tx.send(Ok(event)).unwrap();
        }
        let access = notify::Event::new(notify::EventKind::Access(notify::event::AccessKind::Any)).add_path(file.clone());
        tx.send(Ok(access)).unwrap();
        drop(tx);
        handle.join().unwrap();

        let seen = emitted.lock().unwrap();
        assert_eq!(seen.len(), 1);
    }
}
