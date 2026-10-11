// Lazy-loading file tree for the "All files" panel.
// - Initial render fetches the task root only.
// - Clicking a dir expands it and fetches its entries on demand (cached by rel-path).
// - Clicking a file opens/selects an edit tab in the task.
// - The filter above it searches the whole task (task_files), not just the
//   folders that happen to be loaded, and forces every match's folders open
//   without touching the expanded set, so clearing it restores the tree.
// - Rows follow the refined family (docs/ui.md "Right panel"): guide lines
//   per level, folders tinted by role, names coloured by git status.

import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Pencil, Trash2, Play, Plus, Minus, Pin, PinOff, X } from "lucide-react";
import type { FileEntry, GitStatus } from "@/lib/types";
import { taskDirList, taskPathRename, taskPathDelete, taskPathCreate, taskFiles } from "@/lib/ipc";
import { useApp } from "@/store/app";
import { useUI } from "@/store/ui";
import { usePinnedFolders, EMPTY_PINS } from "@/store/pinnedFolders";
import { cn } from "@/lib/utils";
import { fileIconUrl, folderIconUrl } from "@/lib/explorer/iconResolver";
import {
  activeGuideLevel, filteredListing, gitMarkColor, isQuietEntry, nameMatch, treeGitMarks, type TreeGitMark,
} from "@/lib/explorer/treeLook";
import { bindingText } from "@/lib/shortcuts";
import { usePrefs } from "@/store/prefs";
import { Tip } from "@/components/ui/Tooltip";
import { TreeChevron, DotsHorizontalGlyph } from "@/components/sidebar/sidebarIcons";
import {
  FilePlusGlyph, NewFolderGlyph, CollapseInGlyph, PinGlyph, MagnifierGlyph, ReturnKeyGlyph, AlertGlyph, EmptyFolderGlyph,
} from "./panelIcons";
import { ROOT, sameChildren, mergeReload, dirsNeedingLoad, without, withoutKey } from "@/lib/explorer/dirCache";
import { explainDirError } from "@/lib/explorer/dirError";
import { ContextMenuRoot, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuSeparator } from "@/components/ui/ContextMenu";
import { CopyPathItems } from "./CopyPathItems";
import { startPathDrag } from "@/lib/terminalDrop";
import { absUnder } from "@/lib/osPath";
import { launchCustomRun } from "@/lib/runTabs";
import { resolveCustomCommands, removeCommandByCommand, defaultCommandFor } from "@/lib/runCommands";

interface Props {
  taskId: string;
  /** Bump to force a re-read from disk (e.g. the header refresh button).
   *  Preserves the expanded folder set: root + every open dir is
   *  re-fetched, the rest of the cache is dropped. */
  reloadToken?: number;
  /** The manual-refresh counter alone (a subset of `reloadToken`). When it
   *  changes, the root re-read also restores any missing repo-root member
   *  symlink. Agent-settle reloads bump `reloadToken` but not this, so they
   *  skip the heal. */
  refreshToken?: number;
  /** The Git tab's status poll, for the marks on changed rows. */
  gitStatus?: GitStatus | null;
  /** The eyebrow over the tree: the project's name. */
  rootLabel?: string;
}

/** A pending New file / New folder row: where it goes and what it makes. */
interface Creating {
  parent: string;
  isDir: boolean;
}

const ROW_STEP = 16;
const ROW_INSET = 8;

// Expanded folders, kept per task across switches. FileTree is a single
// shared instance (lives under RightPanel, not per-task), so its local
// `expanded` state would be wiped every time `taskId` changes. This module-level
// map survives the swap so re-selecting a task restores its open folders.
const expandedByTask = new Map<string, Set<string>>();

// One automatic retry before a directory read is called failed (GH #159).
// The common failure is transient: the dir is momentarily gone while a build
// or a generator rewrites it, and `task_dir_list` canonicalizes the path.
const RETRY_DELAY_MS = 200;

export function FileTree({ taskId, reloadToken = 0, refreshToken = 0, gitStatus = null, rootLabel = "" }: Props) {
  const { t } = useTranslation("task");
  // Absolute task root, used to build the "Copy path" (absolute) item.
  // Tree `rel` paths are task-root-relative, so absolute = root/rel.
  const root = useApp(s => s.tasks.find(w => w.id === taskId)?.path ?? "");
  const projectId = useApp(s => s.tasks.find(w => w.id === taskId)?.project_id ?? "");
  // Commands already saved to this repo's Run-scripts list (personal +
  // committed), as a Set of command strings. Drives the per-file "Add" vs
  // "Remove" toggle in the context menu (GH #124).
  const [savedCmds, setSavedCmds] = useState<Set<string>>(new Set());
  const reloadCmds = useCallback(() => {
    if (!projectId) return;
    resolveCustomCommands(projectId)
      .then(cmds => setSavedCmds(new Set(cmds.map(c => c.command))))
      .catch(() => {});
  }, [projectId]);
  // Re-resolve when the personal list changes (store) and when the Run
  // commands dialog closes (which may have edited the committed list).
  const projectRunScripts = useApp(s => s.tasks.find(w => w.id === taskId) && s.projects.find(p => p.id === projectId)?.run_scripts);
  const rcDialogOpen = useUI(s => !!s.runCommandsDialog);
  useEffect(() => { reloadCmds(); }, [reloadCmds, projectRunScripts, rcDialogOpen]);
  const [rootEntries, setRootEntries] = useState<FileEntry[] | null>(null);
  // Per-dir cache of children, keyed by rel-path ("" = root).
  const [children, setChildren] = useState<Record<string, FileEntry[]>>({});
  // Expanded set keyed by rel-path. Seeded from (and mirrored back to) the
  // per-task map so switching away and back keeps the tree open.
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(expandedByTask.get(taskId)));
  // Tracks in-flight dir loads so we don't double-fetch.
  const [loading, setLoading] = useState<Set<string>>(() => new Set());
  // Dirs whose read failed twice, mapped to the error that failed them. They
  // render a retry row instead of a "Loading…" that would never resolve, and
  // the reconcile effect leaves them alone so a genuinely unreadable dir isn't
  // re-read on every render. The message is kept (not just the fact of the
  // failure) because a row saying only "Couldn't read this folder" is not
  // reportable: that is #250.
  const [failed, setFailed] = useState<Map<string, string>>(() => new Map());
  const [err, setErr] = useState<string | null>(null);

  // Dirs with a read in flight, tracked imperatively. `loading` is state (the
  // rows read it), and state lags: `toggle` starts a load from inside a
  // setExpanded updater, so the reconcile effect below can run against a
  // `loading` that doesn't have it yet and fire a duplicate read.
  const inFlight = useRef<Set<string>>(new Set());

  // A late `taskDirList` resolve must not write into the next task's cache.
  const taskIdRef = useRef(taskId);
  taskIdRef.current = taskId;

  // Mirror the expanded set in a ref so the reload effect can re-fetch
  // currently-open dirs without depending on `expanded` (which would
  // make it re-run on every expand/collapse).
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  // Mirror children too: the reload effect (driven by an agent settling)
  // compares the fresh listing against this to avoid a setState (and the
  // whole-tree re-render it triggers) when nothing on disk actually changed.
  const childrenRef = useRef(children);
  childrenRef.current = children;

  const treeRef = useRef<HTMLDivElement>(null);
  // Path briefly highlighted after a reveal-in-tree.
  const [revealedRel, setRevealedRel] = useState<string | null>(null);
  const revealFile = useApp(s => s.revealFile);
  const clearReveal = useApp(s => s.clearReveal);

  // Folders pinned for this task's project. The record slice is ref-stable
  // (EMPTY_PINS for a project with no pins), so the memo, and every row,
  // only sees a new Set when a pin actually changes.
  const pinRecord = usePinnedFolders(s => s.byProject[projectId] ?? EMPTY_PINS);
  const togglePin = usePinnedFolders(s => s.toggle);
  const pins = useMemo(() => new Set(pinRecord), [pinRecord]);
  const sectionCollapsed = usePinnedFolders(s => s.sectionCollapsed);
  const setSectionCollapsed = usePinnedFolders(s => s.setSectionCollapsed);

  // The highlighted row: the last one clicked, following the active editor
  // tab whenever that changes.
  const activeEditPath = useApp(s => {
    const activeId = s.activeTab[taskId];
    const activeTab = (s.tabs[taskId] || []).find(tab => tab.id === activeId);

    return activeTab?.type === "edit" ? activeTab.path : null;
  });
  const [selected, setSelected] = useState<{ rel: string; isDir: boolean } | null>(
    activeEditPath ? { rel: activeEditPath, isDir: false } : null,
  );
  useEffect(() => { if (activeEditPath) setSelected({ rel: activeEditPath, isDir: false }); }, [activeEditPath]);
  const selectedRel = selected?.rel ?? null;
  const select = useCallback((rel: string, isDir: boolean) => setSelected({ rel, isDir }), []);

  const { marks: gitMarks, dirty: dirtyDirs } = useMemo(() => treeGitMarks(gitStatus), [gitStatus]);

  // The filter. Its listing comes from every file in the task, read once
  // per task (and again after a reload) while the field has text.
  const [query, setQuery] = useState("");
  const [allFiles, setAllFiles] = useState<string[] | null>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const filtering = query.trim() !== "";
  useEffect(() => { setAllFiles(null); }, [taskId, reloadToken]);
  useEffect(() => {
    if (!filtering || allFiles) return;
    let alive = true;
    taskFiles(taskId).then(list => { if (alive) setAllFiles(list); }).catch(() => { if (alive) setAllFiles([]); });
    return () => { alive = false; };
  }, [filtering, allFiles, taskId]);
  const filtered = useMemo(() => (filtering && allFiles ? filteredListing(allFiles, query) : null), [filtering, allFiles, query]);
  const filteredOpen = useMemo(() => new Set(filtered ? Object.keys(filtered) : []), [filtered]);
  const matchCount = useMemo(() => {
    if (!filtered) return 0;

    let files = 0;

    for (const entries of Object.values(filtered)) {
      for (const entry of entries) if (!entry.is_dir) files++;
    }

    return files;
  }, [filtered]);

  const filterFocusPending = useUI(s => s.fileFilterFocusPending);
  useEffect(() => {
    if (!filterFocusPending) return;
    useUI.getState().consumeFileFilterFocus();
    filterRef.current?.focus();
    filterRef.current?.select();
  }, [filterFocusPending]);
  const filterBinding = usePrefs(s => s.shortcuts["focus-file-filter"]);

  const [creating, setCreating] = useState<Creating | null>(null);

  // Load root on mount / taskId change. Restore this task's previously
  // expanded folders (empty on first visit) and re-fetch them so they show
  // their contents; the stale cache for the old task is dropped.
  useEffect(() => {
    const saved = new Set(expandedByTask.get(taskId));
    setRootEntries(null); setChildren({}); setExpanded(saved); setFailed(new Map()); setErr(null);
    let alive = true;
    // Launch is an intentional moment, so heal missing member symlinks here.
    const toLoad = ["", ...saved];
    Promise.all(toLoad.map(rel =>
      taskDirList(taskId, rel, rel === "")
        .then(list => [rel, list, ""] as const)
        .catch(e => [rel, null, String(e)] as const),
    )).then(results => {
      if (!alive) return;
      const patch: Record<string, FileEntry[]> = {};
      for (const [rel, list] of results) if (list) patch[rel] = list;
      // Show WHY the root read failed, not just that it did (GH #250).
      if (!patch[""]) { setErr(results.find(r => r[0] === "")?.[2] || "unknown error"); return; }
      setRootEntries(patch[""]);
      // Merge (not replace) so a reveal-in-tree that expanded ancestor dirs
      // while this load was in flight doesn't get its children clobbered.
      // The synchronous reset above already dropped stale entries.
      setChildren(c => ({ ...c, ...patch }));
    });
    return () => { alive = false; };
  }, [taskId]);

  // Manual refresh: re-read root + every expanded dir from disk, keeping
  // the expansion state. Skips the initial render (token starts at 0).
  const firstRef = useRef(true);
  const prevRefresh = useRef(refreshToken);
  useEffect(() => {
    if (firstRef.current) { firstRef.current = false; return; }
    let alive = true;
    // Heal member symlinks only when THIS reload was the manual refresh
    // button (refreshToken bumped), not an agent-settle / settings re-read.
    const heal = refreshToken !== prevRefresh.current;
    prevRefresh.current = refreshToken;
    const toLoad = ["", ...Array.from(expandedRef.current)];
    Promise.all(toLoad.map(rel =>
      taskDirList(taskId, rel, heal && rel === "").then(list => [rel, list] as const).catch(() => [rel, null] as const),
    )).then(results => {
      if (!alive) return;
      const fresh: Record<string, FileEntry[]> = {};
      for (const [rel, list] of results) if (list) fresh[rel] = list;
      // A dir whose read just failed gets another chance: clear it from
      // `failed` so the reconcile effect picks it up again.
      setFailed(f => (f.size ? new Map() : f));
      // Skip the update (and the tree-wide re-render) if every re-fetched
      // dir is byte-identical to what we already have. The common case after
      // an agent turn is "nothing in the visible tree changed".
      if (sameChildren(childrenRef.current, fresh)) return;
      // Merge, never replace: a failed read must not take the cached listing
      // with it, and a folder expanded while this was in flight must survive
      // (GH #159). `expandedRef` is read HERE, not when the effect started.
      const merged = mergeReload(childrenRef.current, fresh, expandedRef.current);
      setChildren(merged);
      setRootEntries(merged[ROOT] ?? []);
    });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadToken]);

  const ensureLoaded = useCallback(async (rel: string) => {
    if (children[rel] || inFlight.current.has(rel)) return;
    inFlight.current.add(rel);
    setLoading(s => { const n = new Set(s); n.add(rel); return n; });
    setFailed(f => withoutKey(f, rel));
    try {
      let list: FileEntry[];
      try {
        list = await taskDirList(taskId, rel);
      } catch (first) {
        // One retry: the usual cause is the dir being briefly absent while
        // something rewrites it, which is gone by the next read (GH #159).
        console.warn("dir list failed, retrying", rel, first);
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
        list = await taskDirList(taskId, rel);
      }
      if (taskIdRef.current !== taskId) return;
      setChildren(c => ({ ...c, [rel]: list }));
    } catch (e) {
      console.error("dir list failed", rel, e);
      if (taskIdRef.current !== taskId) return;
      // Mark it failed rather than leaving an expanded dir with no listing:
      // that state renders "Loading…" with nothing coming (GH #159). The
      // message rides along so the row can show it (GH #250).
      setFailed(f => { const n = new Map(f); n.set(rel, String(e)); return n; });
    }
    finally { inFlight.current.delete(rel); setLoading(s => without(s, rel)); }
  }, [taskId, children, loading]);

  // Force a re-read of one dir from disk + update the cache. Used after a
  // context-menu rename/delete mutates that directory's contents, and on
  // re-expand so a reopened folder reflects on-disk changes. "" = root.
  // Diff against the cache first: an unchanged dir keeps its array refs so its
  // rows don't re-render (sidebar re-render churn is a real regression).
  const refetchDir = useCallback(async (rel: string) => {
    try {
      const list = await taskDirList(taskId, rel);
      if (sameChildren(childrenRef.current, { [rel]: list })) return;
      setChildren(c => ({ ...c, [rel]: list }));
      if (rel === "") setRootEntries(list);
    } catch (e) { console.error("refetch dir failed", rel, e); }
  }, [taskId]);

  // Invariant: every expanded dir has a listing, a read in flight, or a
  // failed mark. Anything else renders a "Loading…" row that never resolves.
  // Restoring the invariant here heals a dropped listing whatever dropped it,
  // which matters because #159 had three candidate causes and no repro.
  useEffect(() => {
    for (const rel of dirsNeedingLoad(expanded, children, loading, failed)) ensureLoaded(rel);
  }, [expanded, children, loading, failed, ensureLoaded]);

  const collapseAll = useCallback(() => {
    const none = new Set<string>();
    expandedByTask.set(taskId, none);
    setExpanded(none);
  }, [taskId]);

  // New file / New folder land in the selected folder, or beside the
  // selected file, or at the root.
  const startCreate = (isDir: boolean) => {
    const parentOfSelected = selectedRel?.includes("/") ? selectedRel.slice(0, selectedRel.lastIndexOf("/")) : "";
    const parent = !selected ? "" : selected.isDir ? selected.rel : parentOfSelected;

    if (parent && !expandedRef.current.has(parent)) toggle(parent);
    setQuery("");
    setCreating({ parent, isDir });
  };

  const finishCreate = async (name: string) => {
    const pending = creating;
    setCreating(null);

    const trimmed = name.trim();
    if (!pending || !trimmed) return;

    const rel = pending.parent ? `${pending.parent}/${trimmed}` : trimmed;

    try {
      await taskPathCreate(taskId, rel, pending.isDir);
      await refetchDir(pending.parent);
      useApp.getState().bumpGitRevision(taskId);
      setSelected({ rel, isDir: pending.isDir });

      if (!pending.isDir) useApp.getState().openPreviewTab(taskId, { type: "edit", path: rel, title: trimmed });
    } catch (e) {
      useUI.getState().pushToast(String(e), "error");
    }
  };

  const toggle = useCallback((rel: string) => {
    // Collapsing clears the failed mark, so re-opening always retries.
    if (expandedRef.current.has(rel)) setFailed(f => withoutKey(f, rel));
    setExpanded(s => {
      const n = new Set(s);
      if (n.has(rel)) n.delete(rel);
      else {
        n.add(rel);
        // First open loads (with a spinner); re-opening an already-cached dir
        // silently re-reads it from disk so it reflects on-disk changes.
        (childrenRef.current[rel] ? refetchDir : ensureLoaded)(rel);
      }
      expandedByTask.set(taskId, n);
      return n;
    });
  }, [ensureLoaded, refetchDir, taskId]);

  // Reveal-in-tree: expand the path's ancestors, scroll to it, highlight it.
  // Driven by the store (set by the editor breadcrumb / locate button) so it
  // works even after the panel is un-hidden and switched to the files view.
  useEffect(() => {
    if (!revealFile || revealFile.taskId !== taskId || !revealFile.path) return;
    let alive = true;
    const { path, isDir } = revealFile;
    (async () => {
      const parts = path.split("/").filter(Boolean);
      const upto = isDir ? parts.length : parts.length - 1;
      const dirs: string[] = [];
      for (let i = 0; i < upto; i++) dirs.push(parts.slice(0, i + 1).join("/"));
      const patch: Record<string, FileEntry[]> = {};
      await Promise.all(dirs.map(async d => {
        try { patch[d] = await taskDirList(taskId, d); } catch {}
      }));
      if (!alive) return;
      if (Object.keys(patch).length) setChildren(c => ({ ...c, ...patch }));
      setExpanded(s => { const n = new Set(s); dirs.forEach(d => n.add(d)); expandedByTask.set(taskId, n); return n; });
      setRevealedRel(path);
      // Two rAFs so the freshly-expanded rows have laid out before scrolling.
      requestAnimationFrame(() => requestAnimationFrame(() => {
        treeRef.current
          ?.querySelector<HTMLElement>(`[data-path="${CSS.escape(path)}"]`)
          ?.scrollIntoView({ block: "center" });
      }));
      clearReveal();
    })();
    return () => { alive = false; };
  }, [revealFile, taskId, clearReveal]);

  // Fade the reveal highlight after a moment.
  useEffect(() => {
    if (!revealedRel) return;
    const t = setTimeout(() => setRevealedRel(null), 1600);
    return () => clearTimeout(t);
  }, [revealedRel]);

  // Arrow keys walk the visible rows; right and left open and close
  // folders (left on a closed one goes to its parent). Enter is the row
  // button's own click.
  const onTreeKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const isArrow = e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "ArrowLeft" || e.key === "ArrowRight";
    const fromInput = (e.target as HTMLElement).tagName === "INPUT";
    if (!isArrow || fromInput) return;

    const rows = Array.from(treeRef.current?.querySelectorAll<HTMLElement>("[data-tree-row]") ?? []);
    if (rows.length === 0) return;

    e.preventDefault();
    const at = rows.findIndex(row => row.dataset.path === selectedRel);
    const current = at >= 0 ? rows[at] : null;
    const currentIsDir = current?.dataset.dir === "true";
    const currentOpen = current?.dataset.open === "true";

    const focusRow = (row: HTMLElement | undefined) => {
      if (!row) return;
      select(row.dataset.path ?? "", row.dataset.dir === "true");
      row.focus();
      row.scrollIntoView({ block: "nearest" });
    };

    if (e.key === "ArrowDown") return focusRow(rows[Math.min(rows.length - 1, at + 1)]);
    if (e.key === "ArrowUp") return focusRow(rows[Math.max(0, at - 1)]);
    if (!current || !selectedRel) return focusRow(rows[0]);

    const opensFolder = e.key === "ArrowRight" && currentIsDir && !currentOpen;
    const closesFolder = e.key === "ArrowLeft" && currentIsDir && currentOpen;

    if (opensFolder || closesFolder) {
      if (!filtering) toggle(selectedRel);
      return;
    }

    if (e.key === "ArrowLeft" && selectedRel.includes("/")) {
      const parent = selectedRel.slice(0, selectedRel.lastIndexOf("/"));
      focusRow(rows.find(row => row.dataset.path === parent));
    }
  };

  let body: React.ReactNode;

  if (err) {
    // The raw message under the headline, not only in a tooltip: this panel is
    // where a user copies the errno into a bug report (GH #250).
    const { short, detail } = explainDirError(err);
    body = (
      <div data-testid="tree-root-failed" className="rp-tree-error">
        <AlertGlyph size={15} className="rp-tree-error-glyph" />
        <div className="min-w-0 flex-1">
          <div className="rp-tree-error-title">{t("fileTree.rootFailed", { short })}</div>
          {detail !== short && <div className="rp-tree-error-detail">{detail}</div>}
        </div>
      </div>
    );
  } else if (!rootEntries || (filtering && !filtered)) {
    body = <TreeSkeleton label={t("fileTree.loading")} />;
  } else if (rootEntries.length === 0 && !creating) {
    body = (
      <div className="rp-tree-state">
        <span className="rp-tree-state-well"><EmptyFolderGlyph size={18} /></span>
        <span className="rp-tree-state-title">{t("fileTree.empty")}</span>
        <button type="button" className="ui-raised" data-size="sm" onClick={() => startCreate(false)}>
          <FilePlusGlyph size={13} />
          {t("fileTree.newFile")}
        </button>
      </div>
    );
  } else if (filtered && filtered[""].length === 0) {
    body = (
      <div data-testid="tree-no-matches" className="rp-tree-state">
        <span className="rp-tree-state-well"><MagnifierGlyph size={17} /></span>
        <span className="rp-tree-state-title">{t("fileTree.noMatches")}</span>
        <span className="rp-tree-state-query">{query.trim()}</span>
        <button type="button" className="ui-raised" data-size="sm" onClick={() => { setQuery(""); filterRef.current?.focus(); }}>
          {t("fileTree.filterClear")}
        </button>
      </div>
    );
  } else {
    const listing = filtered ?? children;
    const topLevel = filtered ? filtered[""] : rootEntries;
    const openSet = filtered ? filteredOpen : expanded;
    const selectionOpensFolder = !!selected?.isDir && openSet.has(selected.rel);
    const parentOfSelection = selectedRel?.includes("/") ? selectedRel.slice(0, selectedRel.lastIndexOf("/")) : "";
    const activeGuide = !selected ? null : selectionOpensFolder ? selected.rel : parentOfSelection;
    const shared = {
      taskId, root, toggle, revealed: revealedRel, refetch: refetchDir, loading, failed, retry: ensureLoaded,
      projectId, pins, togglePin, savedCmds, reloadCmds, selected: selectedRel, select, gitMarks, dirtyDirs,
      creating, finishCreate, filtering, activeGuide, needle: filtered ? query : "",
    };
    body = (
      <>
        {pinRecord.length > 0 && !filtered && (
          <PinnedSection
            taskId={taskId} projectId={projectId} pins={pinRecord}
            collapsed={sectionCollapsed}
            onToggleCollapsed={() => setSectionCollapsed(!sectionCollapsed)}
          />
        )}
        {creating?.parent === "" && <CreateRow depth={0} isDir={creating.isDir} onDone={finishCreate} guideLevel={-1} />}
        {topLevel.map(e => (
          <TreeNode key={e.name} {...shared} entry={e} depth={0} rel={e.name} expanded={openSet} children_={listing} />
        ))}
      </>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 px-[10px] pb-[4px] pt-[8px]">
        <label className="ui-field rp-filter" data-testid="file-filter" data-active={filtering}>
          <MagnifierGlyph size={13} className="rp-filter-glyph" />
          <input
            ref={filterRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Escape" && query) { e.preventDefault(); e.stopPropagation(); setQuery(""); }
              if (e.key === "ArrowDown") {
                e.preventDefault();
                treeRef.current?.querySelector<HTMLElement>("[data-tree-row]")?.focus();
              }
            }}
            placeholder={t("fileTree.filterPlaceholder")}
            data-testid="file-filter-input"
            autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
          />
          {query ? (
            <>
              {filtered && (
                <span
                  className="rp-filter-count"
                  data-testid="file-filter-count"
                  data-empty={matchCount === 0}
                  title={t("fileTree.matchCount", { count: matchCount })}
                >
                  {matchCount}
                </span>
              )}
              <button
                type="button"
                aria-label={t("fileTree.filterClear")}
                data-testid="file-filter-clear"
                onClick={() => { setQuery(""); filterRef.current?.focus(); }}
                className="rp-filter-clear"
              >
                <X className="h-3 w-3" strokeWidth={2.4} />
              </button>
            </>
          ) : (
            <kbd className="ui-keycap" aria-hidden data-testid="file-filter-keycap">{bindingText(filterBinding)}</kbd>
          )}
        </label>
      </div>
      <div className="ui-section-head rp-files-head" data-testid="file-tree-header">
        <span className="ui-eyebrow flex-1" title={root}>{rootLabel}</span>
        <div className="rp-files-tools">
          <Tip content={t("fileTree.newFile")} side="bottom">
            <button type="button" className="ui-icon-btn" data-size="sm" aria-label={t("fileTree.newFile")} data-testid="file-tree-new-file" onClick={() => startCreate(false)}>
              <FilePlusGlyph size={15} />
            </button>
          </Tip>
          <Tip content={t("fileTree.newFolder")} side="bottom">
            <button type="button" className="ui-icon-btn" data-size="sm" aria-label={t("fileTree.newFolder")} data-testid="file-tree-new-folder" onClick={() => startCreate(true)}>
              <NewFolderGlyph size={15} />
            </button>
          </Tip>
          <Tip content={t("fileTree.collapseAll")} side="bottom">
            <button type="button" className="ui-icon-btn" data-size="sm" aria-label={t("fileTree.collapseAll")} data-testid="file-tree-collapse-all" onClick={collapseAll}>
              <CollapseInGlyph size={15} />
            </button>
          </Tip>
        </div>
      </div>
      <div
        ref={treeRef}
        onKeyDown={onTreeKeyDown}
        data-testid="file-tree"
        className="ui-scroll rp-tree-scroll min-h-0 flex-1 select-none pb-[10px] pl-[6px] pr-[2px]"
      >
        {body}
      </div>
    </div>
  );
}

// The tree's Pinned section: an eyebrow header that folds, then one plain row
// per pin. Rows are JUMP links, not tree nodes: a click asks the reveal
// mechanism to expand the path, scroll to the real row and ring it, so the
// section adds no navigation state of its own beyond the fold, and carries
// `data-pin-path` (never `data-path`) so the reveal's row lookup cannot land
// here instead of in the tree.
function PinnedSection({ taskId, projectId, pins, collapsed, onToggleCollapsed }: {
  taskId: string;
  projectId: string;
  pins: readonly string[];
  collapsed: boolean;
  onToggleCollapsed: () => void;
}) {
  const { t } = useTranslation("task");
  const unpin = usePinnedFolders(s => s.unpin);
  return (
    <div className="rp-pins" data-testid="pinned-section" data-collapsed={collapsed}>
      <button
        type="button"
        onClick={onToggleCollapsed}
        aria-expanded={!collapsed}
        data-testid="pinned-section-header"
        data-collapsed={collapsed}
        className="rp-pins-head"
      >
        <TreeChevron open={!collapsed} className="ui-chevron" />
        <span className="ui-eyebrow">{t("fileTree.pinnedSectionLabel")}</span>
        <span className="ui-count">{pins.length}</span>
      </button>
      {!collapsed && pins.map(rel => {
        const name = rel.split("/").pop() ?? rel;
        const parent = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";

        return (
          <ContextMenuRoot key={rel}>
            <ContextMenuTrigger asChild>
              <button
                type="button"
                data-testid="pinned-row"
                data-pin-path={rel}
                title={rel}
                onClick={() => useApp.getState().revealInTree(taskId, rel, true)}
                className="ui-row rp-pin-row w-full"
              >
                <TreeIcon url={folderIconUrl(name, false)} />
                <span className="rp-pin-name">{name}</span>
                <span className="ui-row-meta min-w-0 flex-1">{parent}</span>
                <span
                  role="button"
                  tabIndex={-1}
                  aria-label={t("fileTree.unpinFolder")}
                  title={t("fileTree.unpinFolder")}
                  data-testid="pinned-row-unpin"
                  onPointerDown={e => e.stopPropagation()}
                  onClick={e => { e.stopPropagation(); unpin(projectId, rel); }}
                  className="rp-pin-toggle"
                >
                  <PinGlyph size={13} />
                </span>
              </button>
            </ContextMenuTrigger>
            <ContextMenuContent className="sidebar-menu">
              <ContextMenuItem onSelect={() => unpin(projectId, rel)}>
                <PinOff /> {t("fileTree.unpinFolder")}
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenuRoot>
        );
      })}
    </div>
  );
}

interface NodeProps {
  taskId: string;
  entry: FileEntry;
  depth: number;
  rel: string;
  /** Absolute task root, for the "Copy path" context item. */
  root: string;
  expanded: Set<string>;
  children_: Record<string, FileEntry[]>;
  toggle: (rel: string) => void;
  revealed: string | null;
  /** Re-read a directory after a rename/delete mutates its contents. */
  refetch: (rel: string) => void;
  /** Dir reads in flight, and dirs whose read failed twice (GH #159). An open
   *  dir with no listing is only "Loading…" when it is in one of these. */
  loading: Set<string>;
  failed: Map<string, string>;
  /** Retry a failed dir read (the retry row's click handler). */
  retry: (rel: string) => void;
  /** Project id, for the "Add to Run scripts" actions (GH #124). */
  projectId: string;
  /** Rel paths pinned for this project; drives the folder pin affordance. */
  pins: Set<string>;
  /** Flip one pin (zustand action, ref-stable). */
  togglePin: (projectId: string, rel: string) => void;
  /** Commands already saved to the repo's Run-scripts list. */
  savedCmds: Set<string>;
  /** Refresh `savedCmds` after an add/remove. */
  reloadCmds: () => void;
  selected: string | null;
  select: (rel: string, isDir: boolean) => void;
  gitMarks: Map<string, TreeGitMark>;
  /** Folders with a change somewhere below them. */
  dirtyDirs: Set<string>;
  creating: Creating | null;
  finishCreate: (name: string) => void;
  /** The filter is on: every folder shown is forced open. */
  filtering: boolean;
  /** The folder holding the selection, whose indent guide lights up. */
  activeGuide: string | null;
  /** The filter text to mark in each name, or "" when not filtering. */
  needle: string;
}

/** The app's file icon theme, unchanged: one glyph per file type and folder. */
function TreeIcon({ url }: { url: string | null }) {
  return url ? <img src={url} alt="" className="h-4 w-4 shrink-0 file-icon" /> : <span className="h-4 w-4 shrink-0" />;
}

function Guides({ depth, activeLevel = -1 }: { depth: number; activeLevel?: number }) {
  return (
    <>
      {Array.from({ length: depth }, (_, level) => (
        <span
          key={level}
          className="ui-guide"
          data-active={level === activeLevel || undefined}
          style={{ left: ROW_INSET + level * ROW_STEP + 4 }}
        />
      ))}
    </>
  );
}

/** A name with the filter's match picked out. */
function MatchedName({ name, needle }: { name: string; needle: string }) {
  const span = nameMatch(name, needle);

  if (!span) return <>{name}</>;

  const [start, end] = span;

  return (
    <>
      {name.slice(0, start)}
      <mark className="rp-match">{name.slice(start, end)}</mark>
      {name.slice(end)}
    </>
  );
}

const SKELETON_WIDTHS = [62, 48, 74, 40, 56, 68, 44, 52];

/** The root's first read: placeholder rows in the tree's own geometry. */
function TreeSkeleton({ label }: { label: string }) {
  return (
    <div role="status" aria-label={label} className="rp-skeleton">
      {SKELETON_WIDTHS.map((width, index) => (
        <div key={index} className="rp-skeleton-row" style={{ animationDelay: `${index * 70}ms` }}>
          <span className="rp-skeleton-icon" />
          <span className="rp-skeleton-bar" style={{ width: `${width}%` }} />
        </div>
      ))}
    </div>
  );
}

function TreeNode(props: NodeProps) {
  const {
    taskId, entry, depth, rel, root, expanded, children_, toggle, revealed, refetch, loading, failed, retry,
    projectId, pins, togglePin, savedCmds, reloadCmds, selected, select, gitMarks, dirtyDirs, creating, finishCreate, filtering,
    activeGuide, needle,
  } = props;
  const { t } = useTranslation("task");
  const isOpen = expanded.has(rel);
  const kids = children_[rel];

  // Inline rename state. While renaming the row swaps to a text input.
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(entry.name);
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  // Mirrors `renaming` for the menu's onCloseAutoFocus handler, whose closure
  // was captured on the last render BEFORE the rename flipped the flag.
  const renamingRef = useRef(false);
  useEffect(() => { renamingRef.current = renaming; }, [renaming]);
  useEffect(() => {
    if (!renaming) return;
    const el = renameInputRef.current;
    if (el) { el.focus(); el.select(); }
  }, [renaming]);

  // The directory this entry lives in (re-read after a mutation).
  const parentRel = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";

  // Close any open edit/diff tabs pointing at a path that just moved or was
  // deleted (the entry itself, or anything beneath it when it's a folder).
  // Read from the store at the moment of the mutation: a subscription here
  // would re-render every row on every tab switch.
  function closeStaleTabs(p: string) {
    const app = useApp.getState();
    for (const tab of app.tabs[taskId] || []) {
      // "dir" included (issue #151): a folder listing is just as stale as an
      // editor once its folder is renamed or deleted, and leaving it open
      // parks the tab on a path that no longer resolves.
      if ((tab.type === "edit" || tab.type === "diff" || tab.type === "dir")
          && (tab.path === p || tab.path.startsWith(`${p}/`))) {
        app.closeTab(taskId, tab.id);
      }
    }
  }

  // Enter and the input's onBlur both fire submit; this guard keeps the
  // rename from running twice (the second call would hit the old, now
  // missing path and toast a spurious error).
  const submittingRef = useRef(false);
  async function submitRename() {
    if (submittingRef.current) return;
    const name = draft.trim();
    if (!name || name === entry.name) { setRenaming(false); return; }
    submittingRef.current = true;
    setRenaming(false);
    try {
      await taskPathRename(taskId, rel, name);
      closeStaleTabs(rel);
      // A pinned folder follows its rename (pin + every pin beneath it), so
      // the chip keeps pointing at the folder the user marked.
      if (entry.is_dir && projectId) {
        usePinnedFolders.getState().remap(projectId, rel, parentRel ? `${parentRel}/${name}` : name);
      }
      refetch(parentRel);
      // The tree just refetched itself; git status still shows the old
      // path until the Git tab hears about it.
      useApp.getState().bumpGitRevision(taskId);
    } catch (e) {
      useUI.getState().pushToast(String(e), "error");
      submittingRef.current = false;
    }
  }

  async function remove() {
    const ok = await useUI.getState().askConfirm({
      title: t("fileTree.deleteTitle", { name: entry.name }),
      message: entry.is_dir
        ? t("fileTree.deleteDirMessage")
        : t("fileTree.deleteFileMessage"),
      confirmLabel: t("common:delete"),
      destructive: true,
    });
    if (!ok) return;
    try {
      await taskPathDelete(taskId, rel);
      closeStaleTabs(rel);
      // Any pin on a deleted folder is kept on purpose: the common delete is
      // a build output dir that comes straight back, and a chip pointing at a
      // missing folder reveal-no-ops silently. See store/pinnedFolders.ts.
      refetch(parentRel);
      // Same as rename: tree is fresh, tell the Git tab.
      useApp.getState().bumpGitRevision(taskId);
    } catch (e) {
      useUI.getState().pushToast(String(e), "error");
    }
  }

  // ── Custom run commands (GH #124). Right-clicking a file offers "Run"
  // (one-off) plus an Add/Remove toggle onto the repo's Run-scripts list.
  // The seeded command runs the file relative to the repo root; editable
  // afterward in Settings. Membership is detected by that exact command,
  // so editing the text in settings makes the file show "Add" again. ──
  const cmdString = defaultCommandFor(rel);
  const isSavedCmd = savedCmds.has(cmdString);
  function runOnce() {
    launchCustomRun(taskId, { label: entry.name, command: cmdString });
  }
  // Open the Run commands manager with this file pre-filled as a new personal
  // command (./file, editable + testable there before saving).
  function addRun() {
    useUI.getState().openRunCommands(projectId, { label: entry.name, command: cmdString });
  }
  async function removeRun() {
    try { await removeCommandByCommand(projectId, cmdString); reloadCmds(); }
    catch (e) { useUI.getState().pushToast(String(e), "error"); }
  }

  const isSelected = selected === rel;

  function onClick() {
    select(rel, entry.is_dir);
    if (entry.is_dir) {
      if (!filtering) toggle(rel);
    } else {
      useApp.getState().openPreviewTab(taskId, { type: "edit", path: rel, title: entry.name });
    }
  }

  // Double-click pins the preview tab, the Sublime/VS Code/JetBrains gesture
  // (single click = temporary preview, double = keep). Opening the file in its
  // OS default app lives in the right-click menu instead (CopyPathItems), where
  // every one of those editors also puts it. See the discussion on GH #147.
  function onDoubleClick() {
    if (entry.is_dir) return;
    const app = useApp.getState();
    const existing = (app.tabs[taskId] || []).find(tab => tab.type === "edit" && tab.path === rel);
    if (existing) {
      app.persistTab(taskId, existing.id);
    }
  }

  // The tray's More opens the row's own context menu under the button, so
  // the two cannot offer different actions.
  function openMenuFrom(e: React.MouseEvent<HTMLElement>) {
    e.stopPropagation();
    const row = e.currentTarget.closest<HTMLElement>("[data-tree-row]");
    const box = e.currentTarget.getBoundingClientRect();
    row?.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true, cancelable: true, clientX: box.left, clientY: box.bottom + 2,
    }));
  }

  const mark = gitMarks.get(rel);
  const quiet = isQuietEntry(entry.name);
  const showsDirtyDot = entry.is_dir && !isOpen && dirtyDirs.has(rel);
  const isPinned = entry.is_dir && pins.has(rel);
  const gitTint = mark ? ({ "--rp-git": gitMarkColor(mark) } as React.CSSProperties) : undefined;
  const icon = <TreeIcon url={entry.is_dir ? folderIconUrl(entry.name, isOpen) : fileIconUrl(entry.name)} />;
  const pad = ROW_INSET + depth * ROW_STEP;
  const childCreating = entry.is_dir && isOpen && creating?.parent === rel;
  const rowGuideLevel = activeGuideLevel(activeGuide, parentRel);
  const childGuideLevel = activeGuideLevel(activeGuide, rel);

  return (
    <>
      {renaming ? (
        <div className="ui-row rp-edit-row" style={{ paddingLeft: pad }}>
          <Guides depth={depth} activeLevel={rowGuideLevel} />
          <span className="w-[10px] shrink-0" />
          {icon}
          <input
            ref={renameInputRef}
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Enter") { e.preventDefault(); submitRename(); }
              else if (e.key === "Escape") { e.preventDefault(); setRenaming(false); setDraft(entry.name); }
            }}
            onBlur={submitRename}
            autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
            className="rp-inline-input min-w-0 flex-1"
          />
        </div>
      ) : (
      <ContextMenuRoot>
      <ContextMenuTrigger asChild>
      <button
        type="button"
        onClick={onClick}
        onDoubleClick={onDoubleClick}
        // Drag a row onto a terminal to type its path at the prompt (GH #136),
        // the same affordance as dragging a file in from Finder. Pointer-based,
        // not HTML5 DnD; see the note in lib/terminalDrop.
        onPointerDown={e => startPathDrag(e, { taskId, rel, abs: absUnder(root, rel) }, entry.name)}
        title={rel}
        data-path={rel}
        data-tree-row=""
        data-dir={entry.is_dir}
        data-open={entry.is_dir ? isOpen : undefined}
        data-selected={isSelected}
        data-git={mark}
        data-quiet={quiet || undefined}
        data-revealed={rel === revealed || undefined}
        className="ui-row rp-tree-row group w-full cursor-pointer"
        style={{ paddingLeft: pad, ...gitTint }}
      >
        <Guides depth={depth} activeLevel={rowGuideLevel} />
        {entry.is_dir
          ? <TreeChevron open={isOpen} className={cn("shrink-0", isSelected ? "text-[var(--sidebar-sel-chevron)]" : "text-[var(--sidebar-chevron)]")} />
          : <span className="w-[10px] shrink-0" />}
        {icon}
        <span className="ui-row-name">{needle ? <MatchedName name={entry.name} needle={needle} /> : entry.name}</span>
        {showsDirtyDot && <span data-testid="tree-dirty-dot" className="rp-dirty-dot" />}
        {mark && <span className="ui-status-letter rp-git-letter">{mark}</span>}
        {isPinned && <PinGlyph size={13} className="rp-row-pin" />}
        <span className="ui-tray">
          {entry.is_dir && projectId && (
            // Not a <button>: nested buttons are invalid HTML, and the row's
            // own handlers own keyboard focus anyway (the context menu is the
            // keyboard path to pinning). Every handler stops propagation:
            // onPointerDown especially, or the row's drag-to-type
            // (startPathDrag) fires before click ever does.
            <span
              role="button"
              tabIndex={-1}
              aria-label={isPinned ? t("fileTree.unpinFolder") : t("fileTree.pinFolder")}
              data-testid="pin-folder"
              data-path={rel}
              data-pinned={isPinned}
              title={isPinned ? t("fileTree.unpinFolder") : t("fileTree.pinFolder")}
              onPointerDown={e => e.stopPropagation()}
              onDoubleClick={e => e.stopPropagation()}
              onClick={e => { e.stopPropagation(); togglePin(projectId, rel); }}
              className="sidebar-tray-btn"
            >
              <PinGlyph size={12} strokeWidth={2} />
            </span>
          )}
          <span
            role="button"
            tabIndex={-1}
            aria-label={t("fileTree.more")}
            title={t("fileTree.more")}
            data-testid="tree-row-more"
            onPointerDown={e => e.stopPropagation()}
            onDoubleClick={e => e.stopPropagation()}
            onClick={openMenuFrom}
            className="sidebar-tray-btn"
          >
            <DotsHorizontalGlyph size={12} />
          </span>
        </span>
      </button>
      </ContextMenuTrigger>
      <ContextMenuContent
        className="sidebar-menu"
        // Renaming from the menu mounts the inline input in the same tick the
        // menu unmounts, and Radix's close-time focus restore would then land
        // on the pre-menu element (the terminal, usually), blurring the
        // input, whose onBlur cancels the rename outright. While the flag is
        // up, keep focus in the input instead.
        onCloseAutoFocus={(e) => { if (renamingRef.current) e.preventDefault(); }}
      >
        <CopyPathItems rel={rel} root={root} isDir={entry.is_dir} />
        {!entry.is_dir && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={runOnce}>
              <Play /> {t("fileTree.run")}
            </ContextMenuItem>
            {isSavedCmd ? (
              <ContextMenuItem onSelect={removeRun}>
                <Minus /> {t("fileTree.removeFromRun")}
              </ContextMenuItem>
            ) : (
              <ContextMenuItem onSelect={addRun}>
                <Plus /> {t("fileTree.addToRun")}
              </ContextMenuItem>
            )}
          </>
        )}
        {entry.is_dir && projectId && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={() => togglePin(projectId, rel)}>
              {isPinned ? <PinOff /> : <Pin />} {isPinned ? t("fileTree.unpinFolder") : t("fileTree.pinFolder")}
            </ContextMenuItem>
          </>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => { setDraft(entry.name); setRenaming(true); }}>
          <Pencil /> {t("common:rename")}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem destructive onSelect={remove}>
          <Trash2 /> {t("common:remove")}
        </ContextMenuItem>
      </ContextMenuContent>
      </ContextMenuRoot>
      )}
      {childCreating && <CreateRow depth={depth + 1} isDir={creating.isDir} onDone={finishCreate} guideLevel={childGuideLevel} />}
      {entry.is_dir && isOpen && kids && kids.map(c => (
        <TreeNode key={c.name} {...props} entry={c} depth={depth + 1} rel={`${rel}/${c.name}`} />
      ))}
      {entry.is_dir && isOpen && kids && kids.length === 0 && !childCreating && (
        <div className="ui-row pointer-events-none" style={{ paddingLeft: pad + ROW_STEP }}>
          <Guides depth={depth + 1} activeLevel={childGuideLevel} />
          <span data-testid="tree-empty-folder" className="rp-tree-note">{t("fileTree.emptyFolder")}</span>
        </div>
      )}
      {entry.is_dir && isOpen && !kids && (
        failed.has(rel) ? (
          <DirReadFailed rel={rel} depth={depth} raw={failed.get(rel) ?? ""} retry={retry} />
        ) : (
          <div className="ui-row pointer-events-none" style={{ paddingLeft: pad + ROW_STEP }}>
            <Guides depth={depth + 1} activeLevel={childGuideLevel} />
            <span className="rp-tree-note" data-loading="">
              <span className="rp-spinner" aria-hidden />
              {t("fileTree.loading")}
            </span>
          </div>
        )
      )}
    </>
  );
}

/** The inline name field a New file / New folder click opens in the tree.
 *  Enter creates, Escape or an empty blur gives up. */
function CreateRow({ depth, isDir, onDone, guideLevel }: {
  depth: number;
  isDir: boolean;
  onDone: (name: string) => void;
  guideLevel: number;
}) {
  const { t } = useTranslation("task");
  const [name, setName] = useState("");
  const doneRef = useRef(false);
  const finish = (value: string) => {
    if (doneRef.current) return;
    doneRef.current = true;
    onDone(value);
  };

  return (
    <div className="ui-row rp-edit-row" style={{ paddingLeft: ROW_INSET + depth * ROW_STEP }} data-testid="tree-create-row">
      <Guides depth={depth} activeLevel={guideLevel} />
      <span className="w-[10px] shrink-0" />
      <TreeIcon url={isDir ? folderIconUrl(name || "folder", false) : fileIconUrl(name || "file")} />
      <input
        autoFocus
        value={name}
        onChange={e => setName(e.target.value)}
        onKeyDown={e => {
          if (e.key === "Enter") { e.preventDefault(); finish(name); }
          else if (e.key === "Escape") { e.preventDefault(); finish(""); }
        }}
        onBlur={() => finish(name)}
        placeholder={isDir ? t("fileTree.newFolderPlaceholder") : t("fileTree.newFilePlaceholder")}
        data-testid="tree-create-input"
        autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
        className="rp-inline-input min-w-0 flex-1"
      />
      <kbd className="ui-keycap rp-create-hint" title={t("fileTree.createHint")} aria-hidden>
        <ReturnKeyGlyph size={11} strokeWidth={2.2} />
      </kbd>
    </div>
  );
}

/** The row an expanded directory shows when its read failed twice: the actual
 *  error, not a generic sentence (GH #250). Split out of TreeNode so the
 *  message formatting stays out of the hot render path every row runs. */
function DirReadFailed(
  { rel, depth, raw, retry }: { rel: string; depth: number; raw: string; retry: (rel: string) => void },
) {
  const { t } = useTranslation("task");
  const { short, detail } = explainDirError(raw);
  return (
    <div
      data-testid="dir-read-failed"
      data-dir={rel}
      data-reason={short}
      onClick={() => retry(rel)}
      role="button"
      tabIndex={0}
      onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); retry(rel); } }}
      className="rp-dir-failed"
      style={{ marginLeft: ROW_INSET + (depth + 1) * ROW_STEP }}
      title={t("fileTree.retryTip", { detail })}
    >
      <AlertGlyph size={13} className="rp-dir-failed-glyph" />
      <div className="min-w-0 flex-1">
        <span className="break-words">{short}.</span>{" "}
        <span className="rp-retry">{t("common:retry")}</span>
        {detail !== short && <div className="rp-dir-failed-detail">{detail}</div>}
      </div>
    </div>
  );
}
