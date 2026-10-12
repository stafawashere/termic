# File explorer upgrade

Status: approved 2026-10-12, not started. Promoted from an idea write-up the
same day. This is the implementation spec for the right panel's "All files"
view. Every item below is decided. Where a choice had alternatives, the
choice and the reason are stated so the implementer does not reopen it.

No `planned` issue tracks this plan: issues are disabled on the
stafawashere/termic fork it was written for. The item IDs below stand in
for one.

Read before starting: CLAUDE.md, docs/performance.md (traps 2, 8, 9, 14),
docs/ui.md "Right-panel tabs (All files / Git)" and "Pinned folders in the
file tree", docs/shortcuts.md, docs/i18n.md, and the `e2e` skill.

## How to work this plan

- Work in phase order. Phase 1 (fixes) is independent. Phase 2 (row model
  and file split) is a prerequisite for multi-select, keyboard work,
  compact folders, nesting and virtualization. Phases 3 to 6 can then go in
  any order, one item per PR.
- Each item has an ID (`FE-1.1` and so on). Put the ID in the commit
  subject and the PR title so progress can be traced back here.
- When an item ships, delete its section from this file in the same commit
  and fold anything still true (a measurement, a trap) into docs/ui.md or
  docs/performance.md. When the last item ships, delete this file.
- Every item lands with its tests in the same commit (unit, cargo, e2e as
  listed) and its i18n keys in both `en` and `zh-CN`
  (`src/locales/parity.test.ts` fails otherwise).
- Before opening each PR, ask the user whether they manually tested it
  (CLAUDE.md "Green suites are not a manual test"). Each item lists its
  manual checks. UI items need screenshots from an e2e `snap()`.

## Where things are today

Facts gathered 2026-10-12 against `main` at c7fe07d0. Line numbers drift.
Search by symbol name, not by line.

### Frontend

- `src/components/task/FileTree.tsx` (1171 lines) holds everything: the
  `FileTree` component, the recursive `TreeNode`, `PinnedSection`,
  `CreateRow`, `MatchedName`, `DirReadFailed`, `TreeSkeleton`.
- Props: `taskId, reloadToken, refreshToken, gitStatus, rootLabel`.
  RightPanel computes `reloadToken` as
  `fileTreeReload + fileTreeNonce + fsRevision + focusReload`.
- State: `rootEntries`, `children: Record<rel, FileEntry[]>`,
  `expanded: Set<rel>` (seeded from the module-level `expandedByTask` map so
  it survives remounts), `loading: Set`, `failed: Map<rel, msg>`,
  `selected: {rel, isDir} | null`, `revealedRel`, `creating`,
  `query`, `allFiles`.
- `TreeNode` recurses, rendering its own children with
  `rel={`${rel}/${child.name}`}`. It takes about 25 props (`NodeProps`).
- Keyboard: `onTreeKeyDown` handles arrows only. It runs
  `querySelectorAll("[data-tree-row]")` on every key press to find the
  visible order. Enter works because each row is a button.
- Refresh: the `reloadToken` effect re-reads every loaded dir and skips the
  state write when `sameChildren` says nothing changed. Helpers live in
  `src/lib/explorer/dirCache.ts` (tested in `dirCache.test.ts`).
- Look: `src/lib/explorer/treeLook.ts` exports `isQuietEntry`,
  `treeGitMarks`, `gitMarkColor`, `filteredListing`, `nameMatch`,
  `activeGuideLevel`. Tested in `treeLook.test.ts`. `treeGitMarks` prefixes
  member paths with `dir_name/`.
- Context menu: `@/components/ui/ContextMenu`. Row menu order is
  `CopyPathItems` (open in default app, reveal in Finder, copy relative,
  copy absolute), then Run / Add to run / Remove from run, Pin / Unpin,
  Rename, Remove.
- Rename and delete call `closeStaleTabs(rel)`, which CLOSES every edit,
  diff and dir tab at or under the path. Rename then remaps pins
  (`usePinnedFolders.getState().remap`), refetches the parent and calls
  `bumpGitRevision`. Errors go to `useUI.pushToast(msg, "error")`.
- Drag to terminal: `startPathDrag` in `src/lib/terminalDrop.ts`, a
  pointer drag (never HTML5 DnD), which calls `writePaths(ptyId, paths,
  taskId)` on drop. `writePaths` shell-escapes, adds a trailing space and
  does not submit.
- Reveal: `useApp.revealInTree(taskId, path, isDir)` sets `revealFile`
  with a nonce. It also un-hides the right panel. FileTree's effect expands
  ancestors, scrolls, ring-highlights and then calls `clearReveal()`.
- Toasts: `useUI.pushToast(msg, kind?, { action?, ttlMs?, sticky? })`
  returns an id. `Toaster.tsx` runs `action.onClick()` and then dismisses.

### Rust (`src-tauri/src/lib.rs`)

- `task_dir_list` (async, `spawn_blocking`) lists one dir. It applies
  `compile_exclude_patterns` (global Settings `file_tree_exclude`, the
  repo's `.termic.yaml` `exclude`, and `.DS_Store`) and resolves
  composition members itself. It does NOT consult `.gitignore`. Ignored
  files show today unless an exclude pattern hides them.
- `task_files` is sync and returns only the bare names of the task ROOT.
  Its only caller is the tree filter.
- `task_list_files_for_finder` (async) runs
  `git ls-files --cached --others --exclude-standard` per repo, applies the
  same excludes and prefixes member paths. It has no cap. ⌘P, Search
  Everywhere, Scratch Save and the Repository settings section use it
  through `taskListFilesForFinder`.
- `task_path_rename` and `task_path_delete` are SYNC commands.
  `task_path_create` is async. All three go through
  `resolve_task_git_path` (maps `dir_name/...` to a member repo) and
  `safe_task_path` / `safe_task_path_for_create`. `is_plain_name` validates
  names. Delete is `remove_dir_all` / `remove_file`, so it is permanent.
- `task_git_status` returns `GitStatus { repos: GitRepo[] }` with
  `GitFile { status, path, fp, added?, removed? }`. `fp` is
  `"mtime_nanos:len"`. `added` and `removed` are only filled by
  `task_git_compare`, never by status.
- `task_diff_stat` returns task-level totals only.
- `task_grep_start` takes `GrepOpts { regex, case_sensitive }` and has no
  path scope.
- `pty_spawn` takes `SpawnArgs.cwd`. No UI passes anything but the task
  root today.
- `notify = "8"` is already a dependency, used by
  `src-tauri/src/subagent_watch.rs`.
- No `trash` crate. No virtualization library in package.json.
  Hand-rolled virtual lists exist in `ComparePanel.tsx` (fixed row height,
  `OVERSCAN = 5`) and `HistoryPanel.tsx` (`ROW_H = 26`).

### Tests

- e2e: `e2e/specs/files.e2e.ts` is the tree spec (expand, re-read,
  settle reload, symlinks, preview, context menu, pins). NOTHING drives the
  filter: `file-filter-input` appears in no spec.
- Unit: `treeLook.test.ts`, `dirCache.test.ts`, `dirError.test.ts`.
- Rust: `safe_task_path`, `safe_task_path_for_create` and
  `resolve_task_git_path` have unit tests near the end of lib.rs.
- Perf gate: `src/store/selectorFanout.test.ts` counts selector runs and
  invalidations. Counts gate, timings do not (docs/perf-ci.md).

## Rules that apply to every item

- No `visibility: hidden`. The panel hides with `display: none`, which
  resets scroll offsets in WKWebView, so any new scroller registers with
  `attachHiddenScrollRestore` (`src/lib/hiddenScrollRestore.ts`).
- Every new store setter bails when the value is unchanged (trap 8).
- No `thread::sleep` or timed waits in Rust (trap 9). New watcher code gets
  the same source-scan test `subagent_watch.rs` has.
- IO in Tauri commands runs in `spawn_blocking`.
- Every path the frontend sends goes through `resolve_task_git_path` and
  `safe_task_path` (or `_for_create`) in Rust. Never trust a rel path.
- Composition tasks: members are top-level folders. A member ROOT can never
  be renamed, moved, deleted, trashed or duplicated. Check this in Rust,
  not only by hiding the menu item.
- Docker tasks: the worktree is a bind mount at the same absolute path on
  the host, so host file operations, `notify` and the trash all act on the
  real files. No Docker-specific branch is needed for anything here. Say so
  in the PR, since CLAUDE.md asks every file-location change to answer the
  Docker question.
- Windows: paths go through `src/lib/osPath.ts` helpers (`relUnder`,
  `baseName`). Never split on `/` for an absolute path.
- No hard-coded hex colours. New marks use theme tokens from `index.css`.
- i18n keys go in the `task` namespace under `fileTree.*`. Settings labels
  go in `settings`. Plurals use `_one` / `_other`.

## Phase 1: fixes

### FE-1.1 Filter searches the whole task

Problem: the filter header comment promises a whole-task search, but it
calls `task_files`, which returns root names only. `filteredListing` expects
full relative paths and builds ancestor folders from them, so nested files
never match.

Build:

- In FileTree, replace `taskFiles(taskId)` with
  `taskListFilesForFinder(taskId)`. Same lifecycle: fetched on first
  non-empty query, cleared on `reloadToken`.
- Delete the `task_files` command, its registration in the
  `generate_handler!` list and the `taskFiles` wrapper in `ipc.ts`. It has
  no other caller.
- Large repos: `git ls-files` on a big monorepo can return 200k+ paths.
  `filteredListing` runs on every keystroke. Debounce the query feeding
  `filteredListing` by 60 ms, and cap the rendered match set at 2,000 files,
  showing the existing count chip as "2,000+" when capped. Do not cap the
  fetch, because the count must be honest.
- Directories with no tracked files (an empty folder) will not appear in
  filter results. Accept that. ⌘P has the same behaviour.

Tests:

- e2e in `files.e2e.ts`, new `describe("filter")`: a nested file matches and
  its ancestors open; a top-level name still matches; Escape clears and
  restores the previous expanded set; a member path matches in a
  composition task; no match shows the empty state with a Clear button; the
  count chip shows the number of matched files.
- Break the fix (point it back at `task_files`), watch the nested case go
  red, restore.

Docs: fix the header comment in FileTree.tsx. Add the filter row to
docs/e2e-coverage.md.

Manual: type a nested filename in this repo and in a 50k-file repo; typing
must not stutter.

### FE-1.2 Rename and delete off the IPC thread

Make `task_path_rename` and `task_path_delete` `async fn` that wrap their
bodies in `tauri::async_runtime::spawn_blocking`, exactly as
`task_path_create` does. The TS wrappers do not change.

Test: none can catch the freeze in CI. The change is mechanical. Manual
check: delete a folder holding a copy of `node_modules`; the window keeps
repainting (the spinner turns, the tree scrolls) while it runs.

### FE-1.3 Delete moves to the Trash

Decision: use the `trash` crate (latest 5.x, pinned exactly). It supports
macOS (Finder trash), Linux (freedesktop trash) and Windows (Recycle Bin).

- Rename the command to `task_path_trash` and keep the same guards. Add a
  member-root refusal. On failure (some Linux mounts have no trash), return
  a distinct error string `"trash-unavailable"`. The frontend then offers a
  second confirm, "This volume has no Trash. Delete permanently?", which
  calls the old permanent path, kept as `task_path_delete` with the
  member-root guard added.
- Confirm dialog copy changes from delete wording to "Move to Trash". Keep
  the confirm: the crate does not return the trashed location on macOS, and
  restore is only supported on Linux and Windows, so an undo toast cannot be
  built portably. Do not build a partial undo.
- Context menu label: "Move to Trash" (macOS), "Move to Recycle Bin"
  (Windows), "Move to Trash" (Linux). Pick by platform the way
  `CopyPathItems` picks `FILE_MANAGER`.
- Keep pins on trash, matching today's delete behaviour.

Tests: cargo test that the guard refuses a member root and a path outside
the task (reuse the `safe_task_path` test fixtures). e2e: trash a file,
assert it is gone from the tree and its open tab closed. Do not assert the
OS trash contents in e2e.

Docs: docs/ui.md tree section, and docs/gotchas.md if the Linux fallback
bites during testing.

## Phase 2: foundation

### FE-2.1 Split FileTree.tsx

Pure refactor. No behaviour change. Land it alone so review is a diff of
moves.

Target layout under `src/components/task/fileTree/`:

- `FileTree.tsx` keeps the component shell, the header (filter, buttons)
  and the keyboard handler.
- `useTreeState.ts` holds `rootEntries`, `children`, `expanded`,
  `loading`, `failed`, `err`, `inFlight`, the reload effect, `toggle`,
  `refetchDir`, `retry`, and the `expandedByTask` cache. It returns a
  stable object of state and callbacks.
- `TreeRow.tsx` (successor of `TreeNode`), `PinnedSection.tsx`,
  `CreateRow.tsx`, `TreeParts.tsx` (`MatchedName`, `Guides`, `TreeIcon`,
  `TreeSkeleton`, `DirReadFailed`).
- `treeActions.ts` holds `closeStaleTabs`, rename, trash, create, and the
  follow-up calls (pin remap, refetch, `bumpGitRevision`), as plain
  functions taking `taskId` and the state handle.

Keep `FileTree` exported from the old path (re-export) until callers move,
then delete the shim in the same PR.

Tests: the existing `files.e2e.ts` must pass unchanged. Add
`useTreeState.test.ts` (vitest) for toggle, reload dedupe and failed-dir
retry, using a mocked `taskDirList`.

### FE-2.2 Flat row model

Replace the recursive render with one memoized array.

```ts
type TreeRowModel = {
   rel: string;
   name: string;
   depth: number;
   isDir: boolean;
   isOpen: boolean;
   state: "ok" | "loading" | "failed" | "empty-folder";
   compactChain?: string[];   // FE-6.1
   nestedUnder?: string;      // FE-6.2
};
```

- `buildRows(rootEntries, children, openSet, options)` in
  `src/lib/explorer/rows.ts`. Pure, unit-tested. Filter mode passes the
  filtered listing and its forced-open set, exactly as today.
- Placeholder rows (`loading`, `failed`, `empty-folder`) are rows in the
  array, so keyboard navigation and virtualization see the same list the
  user sees. The inline create row is also a row (`state: "create"`).
- `onTreeKeyDown` indexes this array by the selected rel. Delete the
  `querySelectorAll` walk.
- Each row renders through `React.memo(TreeRow)` with primitive props plus
  stable callbacks from `useTreeState`. A git status change must re-render
  only rows whose mark changed. Pass the row's own mark, not the whole
  marks map.

Tests: `rows.test.ts` covers ordering (folders first, then files, matching
`task_dir_list`'s sort), depth, placeholders, filter mode and a collapsed
dirty folder. Add a render-count test (vitest + React Testing Library if
present, else a counter in the row) that a status change to one file
re-renders one row. Prove it by removing `memo`, watching it fail, and
restoring.

### FE-2.3 Virtualize past a threshold

Measure first, then build. The measurement decides the threshold.

- Measure: create a fixture task with a 5,000-entry folder, expand it, and
  record the commit time in the React profiler and the DOM node count.
  Write both numbers into docs/performance.md under a new "File tree"
  heading.
- Build: when `rows.length > VIRTUALIZE_AT` (start at 400, adjust from the
  measurement), render only the visible window plus overscan, using the
  fixed-height slice pattern from `ComparePanel.tsx`. Rows are one fixed
  height today, which this relies on. Below the threshold render all rows,
  so small trees keep native scroll anchoring.
- The reveal effect must scroll by index (`index * ROW_H`) when
  virtualized, because the target row may not be in the DOM.
- Register the scroller with `attachHiddenScrollRestore`.

Tests: vitest count test that a 5,000-row model renders at most
`visible + 2 * overscan` row elements. e2e: expand a large fixture folder,
reveal a file near its end, assert it is visible and highlighted.

## Phase 3: agent-aware

### FE-3.1 "Touched this turn" marks

Show which files changed during the agent's most recent turn in this task.

Edges:

- In `setWorkState` (`src/store/app.ts`), after computing `effective`,
  compute whether ANY tab in the task is working before and after the
  write. On false to true call `emitTaskWorkEdge(taskId, "start")`; on true
  to false call `emitTaskWorkEdge(taskId, "settle")`. Emit via
  `queueMicrotask` so no listener runs inside `set`. The existing `settled`
  logic and `fsRevision` bump stay as they are.
- `src/lib/turnTouch.ts` registers the listener once (started from
  `App.tsx`). It is a module, not a hook, so background tasks are tracked
  even when their RightPanel is not mounted.

Snapshot and diff:

- On "start": `taskGitStatus(taskId)` and store a baseline
  `Map<path, fp>` covering staged and unstaged files of every repo,
  member paths prefixed with `dir_name/`.
- On "settle": fetch status again. A path is touched when it is absent from
  the baseline, or its `fp` differs. A baseline path that is now clean was
  reverted, so it is touched too and shows the deleted-or-reverted style.
- Store the result in a new store `src/store/turnTouch.ts`:
  `touched: Record<taskId, ReadonlySet<string>>` with a frozen empty set
  for absent tasks. The setter bails when the new set equals the old one.
- Clear a task's set on the next "start" and on task archive.
- Limits, stated in the tooltip and docs: gitignored files are invisible to
  git status, so they are never marked. A file edited and restored to the
  same mtime and length is missed. Both are acceptable.

Render: a small dot before the git status colour, token
`--color-tree-touched` added to `@theme` and to every built-in theme.
Collapsed folders that contain a touched file show the same dot. Tooltip:
"Changed during the last agent turn".

Tests: unit test for the diff function (new, changed fp, reverted,
unchanged, member prefix). Fan-out test in `selectorFanout.test.ts`: a
touch update for one task invalidates only that task's selector. e2e:
drive `setWorkState` through the e2e bridge to start a turn, write a file
in the worktree, settle, and assert the mark; start again and assert it
clears.

Manual: run a real claude turn that edits two files; both marked, nothing
else.

### FE-3.2 "Changed only" view

A toggle button in the filter row (icon: `GitCompare` from lucide) that
shows only changed files and their ancestors.

- Source: the current `gitStatus` (staged, unstaged, untracked), plus
  touched files from FE-3.1. Build a path list and feed it to the existing
  `filteredListing` path, so it renders through the same forced-open
  machinery as the text filter.
- Combines with the text filter (intersection).
- State persists per task in a module-level map, like `expandedByTask`.
- Empty state: "No changes in this task".
- Deleted files appear (they are in status) and open the diff tab, not the
  editor, because the file is gone.

Tests: e2e: modify a nested file, toggle on, only it and its ancestors
show; combine with a text filter; toggle off restores the full tree.

### FE-3.3 Per-file line counts

Show `+12 -3` at the right edge of changed file rows.

- New command `task_numstat(id) -> Vec<FileNumstat { path, added,
  removed, binary }>` that runs `git diff --numstat HEAD` per repo (host
  and members, member paths prefixed), async. Untracked files are not in
  the numstat. Show "new" for them instead of counting lines.
- Fetch ONLY while the tree is visible and either "Changed only" is on or
  the pref `fileTreeLineCounts` (default true) is on. Refresh on
  `fsRevision` / `gitRevision` changes and window focus, NOT on the 4 s
  poll, so idle cost stays flat.
- Cache in `src/store/numstat.ts` keyed by task, with the same bail-on-equal
  rule. Rows read their own entry by path.
- Folder rows show nothing. Totals belong to the Git tab.

Tests: cargo test against a temp repo (create, modify, binary file). Unit
test for the member prefixing. e2e: modify a file by a known line count and
assert the chip text.

### FE-3.4 Send to agent

Context menu item "Send to agent" on files and folders, and on a
multi-selection (FE-4.1).

- Target: `pickAgentTarget(taskId)` from `src/lib/sendComments.ts`
  (explicit tab, else the active tab if it is an agent, else the default
  agent, else the first live one).
- Write with `writePaths(ptyId, paths, taskId)` from
  `src/lib/terminalDrop.ts`, the same function the drag uses, so both
  routes insert identical text. It does not submit. Then activate and focus
  that tab so the user can keep typing.
- No live agent: error toast "No running agent in this task".
- When there are two or more live agents, the menu item becomes a submenu
  listing them by tab title, with the default target first.

Tests: e2e with a fake agent PTY (the existing e2e agent stub): send one
file and assert the PTY received the escaped path and no carriage return.

### FE-3.5 Open or compare in another task

Context menu submenu "Other tasks" on files, listing the other
non-archived tasks of the same project (`tasks.filter(t => t.project_id ===
pid && !t.archived && t.id !== taskId)`, memoized).

Each task gets two items:

- "Open <task name>'s copy" opens the sibling's absolute path as the
  read-only external tab (the same tab type a ⌘-click on an absolute path
  opens).
- "Compare with <task name>" opens a diff tab with a new scope
  `task:<otherTaskId>`. DiffPane, for that scope, reads the left side with
  `taskFileRead(otherTaskId, path)` and the right with
  `taskFileRead(taskId, path)` and feeds both to the existing MergeView.
  A missing side renders as empty with the label "(not in <task name>)".
  This diff is read-only and not commentable.

Limits: host-repo paths only. Paths under a composition member are not
offered, because siblings may not share the composition. The submenu is
hidden when the project has one task.

Tests: e2e with two tasks of one fixture project: compare a file that
differs, assert both sides' text; compare a file missing in the sibling.

## Phase 4: selection and keyboard

### FE-4.1 Multi-select

- State in `useTreeState`: `selection: ReadonlySet<rel>` and
  `anchor: rel | null`, replacing `selected`. The primary row is the
  anchor.
- Click selects one. ⌘-click toggles. Shift-click selects the range between
  anchor and target over the flat row array (FE-2.2). Placeholder rows are
  skipped. ⌘A while the tree has focus selects all visible rows.
- Opening (click without modifiers, Enter) acts on the primary row only.
- Bulk actions that accept a selection: Move to Trash (one confirm listing
  the count), Copy relative paths (newline-joined), Send to agent, drag to
  a terminal (`startPathDrag` already takes a path list in `writePaths`;
  extend its argument to an array).
- Right-click on a row outside the selection selects that row first, as
  Finder does.
- Selection drops paths that disappear after a reload.

Tests: unit tests for range selection over the row model. e2e: ⌘-click two
files, trash both with one confirm; shift-click a range across an expanded
folder.

### FE-4.2 Keyboard parity

Registered shortcuts (new `SHORTCUT_DEFS` entries, group "File tree",
labels in `shortcutCopy.ts` and `settings:shortcuts.defs.*`, en and
zh-CN):

| id                     | default    | action                       |
|------------------------|------------|------------------------------|
| `file-tree-rename`     | F2         | rename the primary row       |
| `file-tree-trash`      | ⌘Backspace | trash the selection          |
| `file-tree-new-file`   | none       | new file in selected folder  |
| `file-tree-new-folder` | none       | new folder in selected folder|

These are handled by a capture-phase listener on the tree container that
acts only when focus is inside the tree and not in an input, and calls
`stopPropagation` only when it handled the key. They must not go in the
global `useShortcuts` switch. ⌘D and ⌘⇧D are already taken globally, so
duplicate (FE-5.2) gets no default binding.
`src/lib/shortcuts.test.ts` must stay green (it fails on duplicate
chords).

Hard-coded, not rebindable (like the arrows today):

- Enter opens the primary row (already true).
- ⌘C with tree focus copies the selection's relative paths. macOS native
  ⌘C is untouched elsewhere.
- Type-ahead: printable keys build a buffer that resets after 700 ms; focus
  jumps to the next visible row whose name starts with the buffer
  (case-insensitive), wrapping around.
- Home and End jump to the first and last row.

Tests: e2e for F2, ⌘Backspace with confirm, type-ahead, Home/End. Unit test
for the type-ahead matcher.

Docs: docs/shortcuts.md group list.

## Phase 5: file operations

### FE-5.1 Move by drag inside the tree

- Rust: `task_path_move(id, from, to_dir) -> String` (async). Guards: both
  paths through `resolve_task_git_path` + `safe_task_path`; refuse a member
  root as source; refuse when `to_dir` is `from` or under it; refuse when
  the destination name exists; refuse moves between different repos (host
  to member, member to member), because `fs::rename` across repos silently
  moves files out of one repo's history. Returns the new rel path.
- Frontend: extend the existing pointer drag. While dragging over the tree,
  hit-test rows; a folder row (or the root band) is a drop target and gets
  the ring highlight; hovering a closed folder for 600 ms expands it.
  Dropping onto a terminal keeps today's insert-path behaviour. Escape
  cancels. A drop onto the source's own parent is a no-op.
- After a move: pin remap (generalize `remap` to accept any old and new
  rel), `refetchDir` on both parents, `bumpGitRevision`.
- Open tabs: rename and delete close tabs today, which can drop an unsaved
  buffer. For move, REMAP instead: add `remapTabPaths(taskId, oldRel,
  newRel)` to the app store that rewrites `tab.path` for edit, diff and dir
  tabs at or under the old path, preserving dirty buffers. Then switch
  rename to use it too, which fixes the same buffer loss there.
- Multi-selection drags move every selected row. Partial failure reports
  each failure in one toast and leaves the successful moves in place.

Tests: cargo tests for each guard. e2e: drag a file into a folder; drag a
folder with an open dirty editor tab and assert the tab path updated and
the buffer is still dirty; a refused cross-member move shows an error
toast.

### FE-5.2 Duplicate, cut and paste

- Rust: `task_path_copy(id, from, to_dir) -> String` (async). The new name
  follows Finder: `name copy.ext`, then `name copy 2.ext`. Directories copy
  recursively without following symlinks (copy the link itself). Same
  guards as move, except copying between repos is allowed.
- Context menu: Duplicate (copy into the same folder), Cut, Copy, Paste.
  Cut and Copy store `{ mode, paths, taskId }` in a module-level tree
  clipboard. Paste into the selected folder (or the parent of a selected
  file) runs move or copy. A pasted cut clears the clipboard. Pasting into
  another task is out of scope and the item is disabled there.
- No default bindings (⌘X/⌘V stay native for text). The four actions are
  registered without defaults so users can bind them.

Tests: cargo test for the name sequence and the symlink case. e2e:
duplicate a file twice, assert both names; cut and paste a file between
folders.

### FE-5.3 Find in folder

- Rust: add `include: Option<String>` (task-relative folder) to
  `GrepOpts`. Resolve it through `resolve_task_git_path` and search only
  under it. When it points into a member, search only that member.
- Store: `openFindInFiles(taskId, scope?: string)`. The dialog shows the
  scope as a removable chip ("in src/components").
- Context menu item on folders: "Find in folder".
- `CommandPalette.coverage.test.ts` checks `open*` actions; the existing
  palette entry keeps calling `openFindInFiles(taskId)` without a scope.

Tests: cargo test that a scoped search excludes a match outside the folder.
e2e: find in a folder, assert only results under it.

### FE-5.4 Terminal here

- Store: add optional `cwd` (task-relative) to `bottomTabs` entries and to
  `addBottomTab(taskId, { focus, cwd })`.
- `TaskView` passes `taskPath={cwd ? join(task.path, cwd) : task.path}` to
  `AuxTerminal` via the `osPath.ts` join helper. Members resolve through
  the wrapper symlink, which already works for `cd`.
- The tab title starts as the folder's base name.
- Context menu item on folders: "Open terminal here". Files get it for their
  parent folder.
- The bottom terminal is not sandboxed (CLAUDE.md), so no sandbox prompt.

Tests: e2e: open a terminal on a nested folder, run `pwd`, assert the
output ends with the folder path.

## Phase 6: display

### FE-6.1 Compact folders

Pref `fileTreeCompactFolders`, default true (VS Code's default, and it is
display-only). Settings toggle in the General section next to the exclude
editor.

- In `buildRows`, a folder whose loaded children are exactly one folder
  merges with it into one row named `a/b/c`, until a level has other
  entries or is not loaded.
- On expand, when the result is exactly one folder, chain-load the next
  level (cap 10 levels) so the chain resolves in one click.
- The `expanded` set keeps real paths. Expanding a compact row expands
  every folder in the chain.
- Actions on a compact row target the deepest folder in the chain. Reveal,
  pins and the filter work on real paths and render into the compact row.
- Filter mode and "Changed only" do not compact.

Tests: unit tests in `rows.test.ts`. e2e: a fixture with `a/b/c/file.ts`
renders one row `a/b/c`.

### FE-6.2 File nesting

Pref `fileTreeNesting`, default false, because it hides files. Rules are
editable in Settings as `parent pattern -> child patterns`, with these
defaults:

- `*.ts` -> `$(base).test.ts, $(base).spec.ts, $(base).d.ts`
- `*.tsx` -> `$(base).test.tsx, $(base).spec.tsx`
- `package.json` -> `package-lock.json, yarn.lock, pnpm-lock.yaml,
  bun.lockb, bun.lock`
- `Cargo.toml` -> `Cargo.lock`

- Pure function `nestEntries(entries, rules)` in
  `src/lib/explorer/nesting.ts`, applied per folder inside `buildRows`.
- A parent with nested children gets a chevron; nested rows render one
  level deeper with `nestedUnder` set. Nesting collapse state is part of
  the `expanded` set under the key `parentRel#nest`.
- A nested child's git mark and touched dot bubble to the parent row while
  collapsed.
- Filter mode and "Changed only" disable nesting.

Tests: unit tests for the matcher and default rules. e2e: with nesting on,
`Foo.test.ts` sits under `Foo.ts`.

### FE-6.3 Show excluded entries

The tree hides entries matched by the exclude patterns. Add a toggle to
show them dimmed.

- `task_dir_list` gains `include_excluded: bool`. When true it returns
  excluded entries with `excluded: true` on `FileEntry`. `.git` stays
  hidden always.
- Toggle in the tree header's overflow menu, persisted per machine as pref
  `fileTreeShowExcluded`, default false.
- Excluded rows render with the existing quiet-entry style.
- Rename the copy everywhere to "excluded", not "ignored": the tree does
  not read `.gitignore`, and calling these "ignored" would be wrong.

Tests: cargo test for the flag. e2e: an excluded `dist/` folder appears
dimmed when on and disappears when off.

### FE-6.4 Follow active editor

Pref `fileTreeFollowEditor`, default false. Toggle in the tree header's
overflow menu.

- When on, a change of the focused tab (via `focusedTabId(splitTree,
  activePaneId, activeTab)` from `src/lib/splitTree.ts`) to an edit tab
  reveals its path in the tree.
- Use a new `revealQuietly` path, not `revealInTree`: it must not un-hide
  the panel, switch the panel view, move focus, or ring-highlight. It
  expands ancestors, selects the row and scrolls with `block: "nearest"`.
- Skip the scroll when the user scrolled the tree in the last 1.5 s.
- Do nothing when the panel is hidden. Catch up on the next show.

Tests: e2e: with the pref on, open a nested file from ⌘P and assert the
row is selected and in view, and that focus is still in the editor.

Manual: switch tabs quickly with the shortcut; no flicker, no focus jump.

## Phase 7: live updates

### FE-7.1 Watch expanded folders

Today the tree refreshes on `fsRevision` bumps, window focus and the 4 s
status poll. External edits made while termic stays frontmost (another
editor, a script started outside termic) show up late.

Build `src-tauri/src/tree_watch.rs`, copying the structure of
`subagent_watch.rs`:

- `notify::recommended_watcher`, `RecursiveMode::NonRecursive` on each
  expanded directory (absolute path after member resolution), refcounted
  per directory across views and windows.
- Commands `tree_watch_set(task_id, dirs: Vec<rel>)` (replace the task's
  watched set) and `tree_watch_clear(task_id)`, both in
  `spawn_blocking`. The frontend calls `set` from `useTreeState` when the
  expanded set changes (debounced 100 ms) and `clear` when the tree
  unmounts or the panel hides.
- One worker thread blocking on the channel. Coalescing without timers:
  the worker drains every pending event with `try_recv` after the first,
  builds the set of affected task-relative dirs, and emits one
  `tree-watch://{task_id}` event `{ dirs: Vec<rel> }` per task per batch.
  Drop `EventKind::Access`. Skip events whose path matches the exclude
  patterns.
- Frontend: on the event, `refetchDir` each listed dir. `sameChildren`
  already turns a no-op event into no state write.
- Cleanup on task archive, task delete and window destroy, at the same
  call sites as `subagent_watch`'s `release_task` / `release_window`.
- Fallback: if the watcher cannot start (Linux out of inotify watches),
  log once and run without it. The existing triggers still work.
- Cap: at most 256 watched directories per task. Past that, stop adding
  and log once.
- Copy `subagent_watch`'s source-scan test that forbids sleep and timed
  waits.

Then, as a separate PR after one release with the watcher on, take
"Deferred 2" in `docs/plans/right-panel-refresh.md` (stretch the 4 s
poll), using the watcher as the soak signal.

Tests: cargo tests with the fake backend pattern (`DirWatcher` trait,
`WatcherFactory`): refcounting, coalescing into one emit, exclude skip,
release on task archive. e2e: with the window focused, write a file from
the test runner directly into an expanded folder and assert it appears
without any focus change.

Manual: Activity Monitor with the app idle and a large folder expanded:
no new idle wakeups compared with `main`. A `git checkout` of another
branch in the worktree from Terminal.app updates the tree.

Docs: docs/performance.md, new trap entry next to trap 14.

## Out of scope

- Editing files in another task (FE-3.5 is read-only).
- Pasting between tasks.
- Undo for trash and moves.
- Reading `.gitignore` in the tree. The tree's hiding is the exclude list
  by design, shared with ⌘P.
- An HTML5 drag-and-drop path. WKWebView and Tauri's file-drop break it
  (docs/ui.md).
