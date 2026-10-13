// Left sidebar: traffic-light spacer, toggle, primary nav, projects tree, footer.
// Two layout flavors: full (220px) vs compact (56px, icon-only with tooltips).

import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type FocusEvent as ReactFocusEvent } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { logWorkState } from "@/lib/workStateLog";
import { useApp, useActiveTabId } from "@/store/app";
import { useRowTabs, useSidebarTabFacts } from "@/store/sidebarTabs";
import { usePrefs, scheduledNavVisible, taskLocationIconShown } from "@/store/prefs";
import { Tip } from "@/components/ui/Tooltip";
import { Spinner } from "@/components/ui/Spinner";
import { History, CalendarClock, FolderPlus, Settings, Plus, Archive, Layers, Moon, Cog, MoreVertical, GitBranch, GitBranchPlus, FolderGit2, ChevronRight, Zap, X, Pencil, Copy, Check, AudioWaveform, Radio, SquareChevronRight, CircleStop, Trash2, Folder, FolderMinus, FolderOpen, Megaphone, Activity, Waypoints, Square, Play, GitPullRequest } from "lucide-react";
import { DropdownRoot, DropdownTrigger, DropdownMenu, DropdownItem, DropdownSeparator, DropdownLabel, DropdownSub, DropdownSubTrigger, DropdownSubContent } from "@/components/ui/Dropdown";
import { ContextMenuRoot, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuLabel, ContextMenuSub, ContextMenuSubTrigger, ContextMenuSubContent } from "@/components/ui/ContextMenu";
import { ProjectActionsMenuItems } from "./ProjectActionsMenuItems";
import { NewTabMenuItems } from "@/components/task/NewTabMenuItems";
import { newScratchTab, openOrCreateScopedScratchTab } from "@/lib/scratchTabs";
import { UpdateCard } from "./UpdateCard";
import { CliIcon, CLI_BRAND_COLOR, resolveIconId } from "@/icons/cli";
import { useUI } from "@/store/ui";
import { usePendingTasks } from "@/store/pendingTasks";
import { useIsArchiving } from "@/store/archivingTasks";
import { cn } from "@/lib/utils";
import { formatTerminalTitle } from "@/lib/terminalTitle";
import { requestCloseTab } from "@/lib/closeTab";
import { taskRename, taskReorder, taskGroupJoin, taskGroupLeave, taskGroupNew, projectRename, openPath, projectReorder, taskSetYolo, projectRemove, projectUpdate, projectSetGroup, procmonOpenWindow, ptyKill } from "@/lib/ipc";
import { copyToClipboard } from "@/lib/clipboard";
import { copyAgentBriefing } from "@/lib/agentBriefing";
import { groupDisplayName, groupOf, projectSections } from "@/lib/projectGroups";
import { createQuickTask, derivedBranch, type NewTaskMode } from "@/lib/quickTask";
import { withCreateLock } from "@/lib/createLock";
import { confirmAndArchive } from "@/lib/archiveTask";
import { startSpotlight, stopSpotlight } from "@/lib/spotlight";
import { ResizeHandle } from "@/components/ui/ResizeHandle";
import type { Tab, Task, TaskGroup, TerminalTab } from "@/lib/types";
import { agentDisplayName, builtinBaseId, workDoneCapable } from "@/lib/agents";
import { effectiveSandboxMode, isSandboxEnforced, isTaskCaged } from "@/lib/types";
import { SandboxIcon, sandboxModeText, DockerSandboxIcon } from "@/components/SandboxIcon";
import { TaskLocationIcon } from "@/components/TaskLocationIcon";
import { taskLabel, useTaskLabel } from "@/lib/taskLabel";
import { TaskLabelText } from "@/components/TaskLabelText";
import { useProfilesSync } from "@/components/ProfileChip";
import { useProfiles } from "@/store/profiles";
import { accentCss, profileSidebarWashCss } from "@/lib/accents";
import { TaskWorkBadge } from "@/components/TaskWorkBadge";
import { TaskPrBadge } from "@/components/TaskPrBadge";
import { GroupActionsMenuItems } from "./GroupActionsMenuItems";
import { ProjectFilterBar, ProjectFilterToggle } from "./ProjectTaskFilter";
import { filterTasks, isFilterActive } from "@/lib/taskFilter";
import { collectTaskProps, collectedText } from "@/lib/tabProps";
import { TaskGroupBlock } from "./TaskGroupBlock";
import { SubagentGroupToggle, SubagentRows, useSubagentFold, useSubagentHasRow } from "./SubagentRows";
import { childRowCarriesSelection, subagentIdOfTab } from "./subagentTree";
import { StatusChips } from "./StatusChips";
import { ChecklistGlyph, CritterGlyph, CollapseAllGlyph, DashedFolderGlyph, DotsHorizontalGlyph, ExpandAllGlyph, FolderGlyph, FolderPlusGlyph, HistoryGlyph, KanbanGlyph, ListOptionsGlyph, PlusGlyph, ScheduleGlyph, SwapGlyph, TintedFolderGlyph, TreeChevron } from "./sidebarIcons";
import { STATUS_BUCKETS } from "@/lib/sidebarStatus";
import { StatusSection, StatusViewCount } from "./StatusSection";
import { RollupMarks } from "./RollupMarks";
import { BoardFilterBar } from "@/components/views/BoardFilterBar";
import { useTaskQuery } from "@/hooks/useTaskQuery";
import { setTreeFold, treeFoldKey, type TreeFold } from "@/lib/treeFold";
import { SpawnedFromMark, SpawnLinksOverlay } from "./SpawnLinks";
import { crossProjectStrays, flattenSegments, groupColorCss as taskGroupColorCss, groupLabel, layoutTaskList, liveGroups, nextGroupColor } from "@/lib/taskGroups";
import { taskNeedsAttention, taskWorkDone, taskWorking, taskDelegated } from "@/lib/taskWorkState";
import { delegatedTitle } from "@/lib/delegatedWork";
import { FILE_MANAGER } from "@/lib/openExternal";
import { kbd } from "@/lib/platform";
import { SidebarFooter } from "./SidebarFooter";

/** Pick a default name for a freshly-created task (repo-root OR worktree).
 *  Format: "<agent>-N" where N is the next unused index for that CLI among
 *  ALL of the project's existing rows. "shell" → "terminal". The user can
 *  edit before pressing Enter.
 *
 *  Repo-root and worktree rows share one counter on purpose: they share a
 *  namespace (a worktree's branch derives from its name, and the sidebar
 *  rejects a duplicate name either way), so counting only one kind hands
 *  out a name the other kind already took. */
function defaultTaskName(cli: string, taskList: Task[]): string {
  const slug = cli === "shell" ? "terminal" : cli.toLowerCase();
  const prefix = `${slug}-`;
  const used = new Set<number>();
  for (const w of taskList) {
    if (w.name === slug) { used.add(1); continue; }
    if (!w.name.startsWith(prefix)) continue;
    const tail = w.name.slice(prefix.length);
    const n = Number(tail);
    if (Number.isInteger(n) && n > 0) used.add(n);
  }
  let n = 1;
  while (used.has(n)) n += 1;
  return `${slug}-${n}`;
}

// Group folder accent resolution. Shared with profiles (GH #280) and therefore
// lifted into @/lib/accents; the alias below keeps this file's call sites
// reading the way they always did. (The palette itself, GROUP_COLORS, moved
// with the swatch row into GroupActionsMenuItems.)
const groupColorCss = accentCss;

// `compact` is normally read from the store, but the Arc-style hover reveal
// (App.tsx) renders TWO instances at once: the 56px icon rail (`compact`)
// plus a full-width overlay (`compact={false}`) that slides in on hover. The
// optional prop lets that overlay force full mode regardless of the store.
/** Left padding of a tree row at `depth`: a 6px gutter, then 18px a level
 *  (the design's grid: folder 6, project 24, task 42, session 60). */
export const treeIndent = (depth: number) => 6 + depth * 18;

/** Where a level's vertical guide runs: under the chevron of the row that
 *  owns it. */
export const treeGuideLeft = (depth: number) => treeIndent(depth) + 4;

export function Sidebar({ compact: compactProp }: {
  compact?: boolean;
} = {}) {
  const { t } = useTranslation("sidebar");
  const compactStore = useApp(s => s.compactSidebar);
  const compact = compactProp ?? compactStore;
  const openSettings = useApp(s => s.openSettings);
  // Whether the compact rail's list has more below the fold. Written only when
  // it FLIPS, so scrolling costs no re-render of the sidebar per frame.
  const projectsScrollRef = useRef<HTMLDivElement | null>(null);
  const [moreBelow, setMoreBelow] = useState(false);
  useEffect(() => {
    const el = projectsScrollRef.current;
    if (!el || !compact) { setMoreBelow(false); return; }
    const check = () => {
      const more = el.scrollTop + el.clientHeight < el.scrollHeight - 2;
      setMoreBelow(prev => (prev === more ? prev : more));
    };
    check();
    el.addEventListener("scroll", check, { passive: true });
    const ro = new ResizeObserver(check);
    ro.observe(el);
    // The list grows without the scroller resizing (a task or project added),
    // which only a child-list observer sees. `check` is O(1) and writes
    // nothing unless the answer flips.
    const mo = new MutationObserver(check);
    mo.observe(el, { childList: true, subtree: true });
    return () => { el.removeEventListener("scroll", check); ro.disconnect(); mo.disconnect(); };
  }, [compact]);
  // GH #280: keeps this window's registry view fresh, and decides whether the
  // strip exists at all.
  useProfilesSync();
  const projects = useApp(s => s.projects);
  const sidebarWidth = useApp(s => s.sidebarWidth);
  const setSidebarWidth = useApp(s => s.setSidebarWidth);
  const tasks = useApp(s => s.tasks);
  const activeTask = useApp(s => s.activeTaskId);
  const setActive = useApp(s => s.setActiveTask);
  const setView = useApp(s => s.setView);
  const currentView = useApp(s => s.view.page);
  // NOT the `tabs` map: that re-rendered the whole sidebar, every row with
  // it, on each `lastOutputAt` stamp of each streaming terminal. The body
  // reads only these per-task facts (src/store/sidebarTabs.ts); rows
  // subscribe to their own tabs.
  const tabFacts = useSidebarTabFacts();
  const agents = useApp(s => s.agents);
  const taskFilters = useUI(s => s.taskFilters);
  const setTaskFilterText = useUI(s => s.setTaskFilterText);
  const toggleTaskFilterBell = useUI(s => s.toggleTaskFilterBell);
  const mountedTasks = useApp(s => s.mountedTasks);
  const loadAll = useApp(s => s.loadAll);
  const openNewProject = useUI(s => s.openNewProject);
  const openNewTask = useUI(s => s.openNewTask);
  const collapsedProjects = useApp(s => s.collapsedProjects);
  const collapsedGroups = useApp(s => s.collapsedGroups);
  const collapsedTaskGroups = useApp(s => s.collapsedTaskGroups);
  const groupColors = useApp(s => s.groupColors);
  const setGroupColor = useApp(s => s.setGroupColor);
  const setAllTasksCollapsed = useApp(s => s.setAllTasksCollapsed);
  const setAllGroupsCollapsed = useApp(s => s.setAllGroupsCollapsed);
  // Tasks mid-creation (GH #242): no real Task yet, so they can't come from
  // `tasks` above — rendered as synthetic rows in the same list, filtered by
  // project inside renderProject below (a plain object filter, not a hook
  // call, since renderProject runs per-project inside a loop).
  const pendingTasksById = usePendingTasks(s => s.pending);
  const pendingTaskList = Object.values(pendingTasksById);
  // (agents subscription lives inside ProjectActionsMenuItems now —
  // Sidebar itself doesn't need the registry.)

  // If the user disabled the settled highlight (Settings → Notifications),
  // isWorkDone() below returns false and the rollup dots stay calm
  // regardless of agent activity.
  const settledHighlight = usePrefs(s => s.settledHighlight);
  const branchPrefix = usePrefs(s => s.branchPrefix);
  const taskExpandMode = usePrefs(s => s.taskExpandMode);
  const setTaskExpandMode = usePrefs(s => s.setTaskExpandMode);
  const hideInactiveProjects = usePrefs(s => s.hideInactiveProjects);
  const setHideInactiveProjects = usePrefs(s => s.setHideInactiveProjects);
  const showStatusSection = usePrefs(s => s.showStatusSection);
  const taskLocationIcon = usePrefs(s => s.taskLocationIcon);
  const setTaskLocationIcon = usePrefs(s => s.setTaskLocationIcon);
  const taskPrBadge = usePrefs(s => s.taskPrBadge);
  const setTaskPrBadge = usePrefs(s => s.setTaskPrBadge);
  const showBoard = usePrefs(s => s.showBoard);
  const scheduledNav = usePrefs(s => s.scheduledNav);
  // A boolean out of the selector, so a task write that leaves the answer
  // alone re-renders nothing here.
  const hasSchedule = useApp(s => s.tasks.some(x => !!x.schedule && !x.archived));
  const showScheduled = scheduledNavVisible(scheduledNav, hasSchedule);
  // The profile's accent carried down from the title bar, opt-in. Selected as
  // the finished CSS string (or undefined) so the sidebar re-renders only when
  // the colour itself changes, not on every profile-store touch.
  const sidebarWashOn = usePrefs(s => s.profileSidebarWash);
  const sidebarWash = useProfiles(s => {
    if (!sidebarWashOn) return undefined;
    const me = s.profiles.find(p => p.slug === s.current);
    return profileSidebarWashCss(me?.accent, s.profiles.length > 0);
  });
  const setShowStatusSection = usePrefs(s => s.setShowStatusSection);
  const sidebarView = usePrefs(s => s.sidebarView);
  const setSidebarView = usePrefs(s => s.setSidebarView);
  const statusView = sidebarView === "status" && !compact;
  // What the header's expand toggle does next. Not derived from the folds:
  // reading every task's fold to draw one glyph would subscribe the body to
  // all of them. It starts on expand, the glyph the design draws at rest.
  const [nextExpandAll, setNextExpandAll] = useState(true);
  // Each view keeps its own scroll offset across a swap.
  const viewScrollTop = useRef<Record<string, number>>({});
  // Temporary, non-persisted reveal of the hidden inactive projects. Reset
  // whenever the hide pref flips off so the "Show N inactive" row starts
  // collapsed next time the user re-enables hiding.
  const [showInactive, setShowInactive] = useState(false);

  // The sidebar's filter bar (docs/ui.md "The sidebar's filter bar"): the
  // board's bar and query engine over every task the tree lists. Absent on
  // the icon rail, so a query typed in the full sidebar filters nothing
  // there, and neither does a menu left open when ⌘B folded the bar away.
  // With no query every subscription below holds a constant (useTaskQuery),
  // so this costs the body nothing.
  const sidebarQuery = useUI(s => s.sidebarQuery);
  const setSidebarQuery = useUI(s => s.setSidebarQuery);
  const [filterMenuOpen, setFilterMenuOpen] = useState(false);
  const queryText = compact ? "" : sidebarQuery;
  const filterWorkingIndicator = usePrefs(s => s.workingIndicator);
  const filterAttentionIndicator = usePrefs(s => s.attentionIndicator);
  const filterWorkPrefs = useMemo(
    () => ({ settledHighlight, workingIndicator: filterWorkingIndicator, attentionIndicator: filterAttentionIndicator }),
    [settledHighlight, filterWorkingIndicator, filterAttentionIndicator],
  );
  // What the tree can list: unarchived, in a project of this profile.
  const queryLiveTasks = useMemo(() => {
    const ids = new Set(projects.map(p => p.id));
    return tasks.filter(w => !w.archived && ids.has(w.project_id));
  }, [tasks, projects]);
  const taskQuery = useTaskQuery({
    text: queryText, menuOpen: !compact && filterMenuOpen, live: queryLiveTasks, workPrefs: filterWorkPrefs, facts: tabFacts,
  });
  /** Ids the query lets through, or null while nothing is filtering. */
  const queryMatchIds = useMemo(
    () => (taskQuery.filtering ? new Set(queryLiveTasks.filter(taskQuery.matches).map(w => w.id)) : null),
    [taskQuery.filtering, taskQuery.matches, queryLiveTasks],
  );
  const queryOn = queryMatchIds !== null;
  // While filtering, matching projects, folders and task groups render open
  // whatever their stored fold says: results behind a chevron read as
  // "nothing matched". Their chevrons still work, through the throwaway
  // folds every write reaches via setTreeFold, so a filter never rewrites
  // the user's layout and clearing it puts every fold back as it was.
  const queryFolds = useUI(s => s.sidebarQueryFolds);
  /** A fold as the tree draws it: the throwaway one while the query filters
   *  (open unless folded during this query), else `stored`. */
  const foldOf = (kind: TreeFold, id: string, stored: boolean) =>
    queryOn ? queryFolds[treeFoldKey(kind, id)] === true : stored;
  // Expand / collapse all: folders go through setTreeFold like every other
  // fold, so under a query they fold the throwaway way too.
  const setAllFolders = (folded: boolean) => {
    if (!queryOn) { setAllGroupsCollapsed(folded); return; }
    for (const g of new Set(projects.map(groupOf))) if (g) setTreeFold("folder", g, folded, compact);
  };

  // Expand / collapse all agents, from the header toggle and the list
  // options. In the STATUS view the same press opens or folds the buckets.
  const setTreeExpanded = (expanded: boolean) => {
    setNextExpandAll(!expanded);

    if (statusView) {
      const setBucketCollapsed = usePrefs.getState().setStatusBucketCollapsed;
      for (const bucket of STATUS_BUCKETS) setBucketCollapsed(bucket, !expanded);
      return;
    }

    if (!queryOn) setAllTasksCollapsed(!expanded);
    setAllFolders(!expanded);
    useSubagentFold.getState().setAllCollapsed(!expanded);
  };

  const swapView = () => {
    const scroller = projectsScrollRef.current;
    if (scroller) viewScrollTop.current[sidebarView] = scroller.scrollTop;
    setSidebarView(sidebarView === "status" ? "tree" : "status");
  };

  useLayoutEffect(() => {
    const scroller = projectsScrollRef.current;
    if (scroller) scroller.scrollTop = viewScrollTop.current[sidebarView] ?? 0;
  }, [sidebarView]);

  /** True if ANY tab in the task just transitioned to settled/idle
   *  (work-done signal — agent stopped producing output, waiting on
   *  user). Gated on the same `settledHighlight` pref so the check
   *  disappears entirely when the user disables the work-done UI. */
  const isWorkDone = (taskId: string) =>
    settledHighlight && !!tabFacts[taskId]?.done;
  // Distinct from work-done: the agent is explicitly blocked on the
  // user (Gemini ✋ Action Required, Codex Waiting, OSC 1337
  // RequestAttention). Different sidebar icon (bell vs check).
  const needsAttention = (taskId: string) => !!tabFacts[taskId]?.attention;

  // Inline rename state for PROJECTS and GROUPS (for groups, `id` is the
  // group NAME — groups are derived from Project.group labels and have no
  // id). Task rename is managed inside TaskRow so it can co-exist with
  // per-tab rename state.
  const [renaming, setRenaming] = useState<{ kind: "proj" | "group"; id: string; value: string } | null>(null);
  // Radix menus close AFTER onSelect and asynchronously restore focus to the
  // trigger; autoFocus on the freshly-mounted input loses that race (worse for
  // groups, whose header is focusable and reclaims it). Re-focus + select on
  // the next two frames to land after Radix's restore tick. Same workaround as
  // the task rename input (see TaskRow). Keyed on which rename so switching
  // targets re-focuses, but typing (value change) doesn't re-select.
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (!renaming) return;
    let cancelled = false;
    const r1 = requestAnimationFrame(() => {
      const r2 = requestAnimationFrame(() => {
        if (cancelled) return;
        // Focus + select unconditionally (same as PendingRepoRootRow's
        // name prompt): when the rename starts AFTER the menu's
        // focus-restore already settled (e.g. new-group, where async IPC
        // delays setRenaming), autoFocus wins — but the suggested name
        // must still be selected so typing replaces it.
        const el = renameInputRef.current;
        if (el) { el.focus(); el.select(); }
      });
      if (cancelled) cancelAnimationFrame(r2);
    });
    return () => { cancelled = true; cancelAnimationFrame(r1); };
  }, [renaming?.kind, renaming?.id]);
  // Project whose `+` dropdown is currently open. Used to keep the row
  // visually "hovered" (bg + Cog visible) while the menu is open;
  // otherwise the menu trigger looks like it un-selected its parent.
  const [menuOpenProjectId, setMenuOpenProjectId] = useState<string | null>(null);
  // Projects whose filter bar the user opened (GH #324), valued by a counter
  // that bumps on every open so the bar's input re-takes focus.
  const [filterInputs, setFilterInputs] = useState<Record<string, number>>({});
  // a sidebar query closes every open bar: one holding a filter comes back on
  // its own when the query clears (it is still set), an empty one has nothing
  // to come back for
  useEffect(() => {
    if (queryOn) setFilterInputs(prev => Object.keys(prev).length === 0 ? prev : {});
  }, [queryOn]);
  // Inline name-prompt state for repo-root task creation. When the
  // user picks an agent from the project's `+` menu, we stash the choice
  // here and render a focused input row under the project — Enter creates
  // the task with the typed name, Esc cancels. This is the
  // low-friction alternative to a modal dialog.
  // Inline "new task" name prompt. For a worktree it also carries the
  // auto-derived (but editable) branch; `branchEdited` freezes auto-derive
  // once the user touches the branch field.
  const [pendingRepoRoot, setPendingRepoRoot] =
    useState<{
      projectId: string;
      cli: string;
      mode: NewTaskMode;
      value: string;
      branch: string;
      branchEdited: boolean;
    } | null>(null);
  // Guards the inline commit against a double Enter while the (multi-second)
  // create IPC is in flight — otherwise two tasks / a swallowed error.
  const inlineCreatingRef = useRef(false);
  // Drag-to-reorder PROJECTS. Pointer-event based (WKWebView's HTML5
  // DnD is unreliable in Tauri). The row physically moves during the
  // drag — we mutate the live `projects` order in the app store on
  // every pointermove, so the item being dragged actually shifts
  // past siblings instead of just showing a drop-target ring.
  //
  // CRITICAL: pointermove + pointerup listeners go on `document`,
  // NOT the per-row React element. When the array reorders mid-drag,
  // React detaches + reattaches the moved DOM node, which kills any
  // pointer capture held on it — subsequent moves fire on whatever
  // element sits under the cursor, and per-row handlers bail because
  // they check `armed.id !== p.id`. Document-level listeners survive
  // every reorder.
  //
  // Flow:
  //   onPointerDown (per-row) → arm dragArmed.current + add document
  //     pointermove/pointerup listeners
  //   document pointermove past 4px → enter dragging
  //   document pointermove while dragging → hit-test, splice store
  //   document pointerup → IPC project_reorder + clean up listeners
  const [dragProjectId, setDragProjectId] = useState<string | null>(null);
  // translateY applied to the dragged header so it follows the cursor (the
  // smooth feel, same as the prompt library); the list still reorders live.
  const [dragTy, setDragTy] = useState(0);
  const dragArmed = useRef<
    { id: string; x: number; y: number; started: boolean; grabOffsetY: number; appliedTy: number; pointerY: number; origGroup: string; fromFold: boolean } | null
  >(null);
  const dragListenersRef = useRef<{ move: (e: PointerEvent) => void; up: (e: PointerEvent) => void } | null>(null);
  // Folder header the cursor is currently over while dragging a project —
  // "drop INTO this group". State drives the header highlight; the ref is
  // what the document-level pointerup reads (the listener closure would
  // otherwise see a stale state value).
  const [dragOverGroup, setDragOverGroup] = useState<string | null>(null);
  const dragOverGroupRef = useRef<string | null>(null);
  // Clicking a group header to dismiss its open rename input must NOT also
  // toggle collapse: the input's blur (→ commitRename → renaming=null) fires
  // on mousedown, BEFORE the click event, so a state check in onClick sees
  // rename already closed. Captured on pointerdown instead, when the input
  // is still mounted. Also set after a completed group drag so the click
  // that follows pointerup doesn't collapse the folder that was just moved.
  const suppressGroupToggle = useRef(false);
  const projectClickSuppressed = useRef(false);

  // ── Task drag-to-reorder ──────────────────────────────────────────────
  // Same document-level pointer pattern as project rows (see the long note
  // above for why the listeners can't live on the row), with one difference
  // that shapes the whole hit-test: a task NEVER leaves its project. Only
  // sibling rows are candidates, so a cursor dragged over another project
  // finds no midpoint below it and the row simply clamps to the top or
  // bottom of its own list instead of defecting.
  //
  // Persistence differs from projects too: projects.json is one array whose
  // order IS the order, while tasks are a file each, so the drop writes an
  // explicit index per task via `task_reorder`.
  const [dragTaskId, setDragTaskId] = useState<string | null>(null);
  const [dragTaskTy, setDragTaskTy] = useState(0);
  const taskDragArmed = useRef<
    { id: string; projectId: string; x: number; y: number; started: boolean; grabOffsetY: number; appliedTy: number; pointerY: number; origGroupId: string | null } | null
  >(null);
  // Task GROUP the dragged row is over (src/lib/taskGroups.ts). `undefined`
  // until the drag has hit-tested once, so a drag that never moved keeps its
  // own group; `null` = outside every group block. The row wears this group
  // while dragging, so the block grows and shrinks under it before the drop
  // commits a join or a leave. Mirrored in a ref for endTaskDrag, which runs
  // from a document listener holding a stale closure.
  const [dragTaskGroup, setDragTaskGroupState] = useState<TaskGroup | null | undefined>(undefined);
  const dragTaskGroupRef = useRef<TaskGroup | null | undefined>(undefined);
  const setDragTaskGroup = (g: TaskGroup | null | undefined) => {
    dragTaskGroupRef.current = g;
    setDragTaskGroupState(g);
  };
  // Pre-link data: a group spanning projects draws its lone members as plain
  // rows (taskGroups.ts crossProjectStrays).
  const groupStrays = useMemo(() => crossProjectStrays(tasks), [tasks]);
  const groupFor = (t: Task): TaskGroup | null =>
    t.id === dragTaskId && dragTaskGroup !== undefined
      ? dragTaskGroup
      : groupStrays.has(t.id) ? null : t.group ?? null;
  const taskDragListenersRef = useRef<{ move: (e: PointerEvent) => void; up: (e: PointerEvent) => void } | null>(null);
  // A completed drop still fires a click on the row (pointerup lands on the
  // same element), which would activate the task the user only meant to
  // move. Set on drop; consumed by the row's click handler, and cleared on a
  // timer regardless (see endTaskDrag) for the drops whose click never lands.
  const taskClickSuppressed = useRef(false);

  const computeTaskTy = (clientY: number): number => {
    const armed = taskDragArmed.current;
    const el = armed && dragRoot().querySelector<HTMLElement>(`[data-sidebar-task-id="${CSS.escape(armed.id)}"]`);
    if (!armed || !el) return 0;
    const layoutTop = el.getBoundingClientRect().top - armed.appliedTy;
    const ty = (clientY - armed.grabOffsetY) - layoutTop;
    armed.appliedTy = ty;
    return ty;
  };

  const endTaskDrag = (commit: boolean) => {
    const ls = taskDragListenersRef.current;
    if (ls) {
      document.removeEventListener("pointermove", ls.move);
      document.removeEventListener("pointerup", ls.up);
      document.removeEventListener("pointercancel", ls.up);
      taskDragListenersRef.current = null;
    }
    const armed = taskDragArmed.current;
    const wasStarted = armed?.started ?? false;
    const target = dragTaskGroupRef.current;
    taskDragArmed.current = null;
    setDragTaskId(null);
    setDragTaskTy(0);
    setDragTaskGroup(undefined);
    if (commit && wasStarted && armed) {
      taskClickSuppressed.current = true;
      // Clear on the next tick whether or not the click lands: `click` fires
      // on the common ancestor of down and up, so releasing over another
      // project (or off the window) never reaches the row's handler, and a
      // flag left standing would swallow the user's NEXT click on any task —
      // one ref is shared by every row. Same pattern as suppressGroupToggle.
      setTimeout(() => { taskClickSuppressed.current = false; }, 0);
      // Only this project's visible rows: task_reorder numbers exactly the
      // ids it is handed, so passing the whole task list would stamp an
      // order on every other project too.
      //
      // A changed task group is applied to the store FIRST, in the same
      // update the drag state clears in, so the row stays where it was
      // dropped instead of snapping back to its old group for the frames
      // until the IPC round-trip lands. The ids are then taken in DISPLAY
      // order (groups gathered into blocks), so what is stored is what the
      // user saw.
      const joining = target !== undefined && (target?.id ?? null) !== armed.origGroupId;
      let all = useApp.getState().tasks;
      if (joining) {
        all = all.map(t => (t.id === armed.id ? { ...t, group: target ?? undefined } : t));
        useApp.setState({ tasks: all });
      }
      const projectRows = all.filter(t => t.project_id === armed.projectId && !t.archived);
      const finalIds = flattenSegments(layoutTaskList(projectRows)).map(t => t.id);
      const reorder = taskReorder(finalIds);
      if (joining) {
        // Join through a LIVE member, not the group id: that is the lead's
        // task id, and the lead may be archived or gone entirely.
        // In THIS project: a group that spans projects from before groups stayed
        // in one has members elsewhere, and Rust refuses a join across.
        const via = target && all.find(t => t.group?.id === target.id && t.id !== armed.id && !t.archived && t.project_id === armed.projectId)?.id;
        // Dropped into a collapsed group: open it, or the task you just
        // placed disappears from view the moment you let go.
        if (target) setTreeFold("taskGroup", target.id, false, compact);
        // AFTER the reorder, not beside it: task_reorder re-saves every task
        // whose order moved, the dropped one included, from a list it loaded
        // before the join landed, so a concurrent join could be written and
        // then overwritten with the old group. Lost on the Windows runner.
        const armedId = armed.id;
        void reorder.catch(() => {})
          .then(() => (via ? taskGroupJoin(armedId, via) : taskGroupLeave(armedId)))
          .catch(() => {})
          .then(() => useApp.getState().loadAll());
      } else {
        reorder.catch(() => { void useApp.getState().loadAll(); });
      }
    }
  };

  const onTaskDragPointerMove = (e: PointerEvent) => {
    const armed = taskDragArmed.current;
    if (!armed) return;
    if (!armed.started) {
      const dx = e.clientX - armed.x;
      const dy = e.clientY - armed.y;
      if (dx * dx + dy * dy < 16) return;
      armed.started = true;
      setDragTaskId(armed.id);
    }
    // Stashed for the post-reorder re-anchor effect, which has no event to
    // read the cursor from. Set BEFORE the hit-test, which has early returns.
    armed.pointerY = e.clientY;
    setDragTaskTy(computeTaskTy(e.clientY));
    const dragId = armed.id;
    const all = useApp.getState().tasks;
    if (!all.some(t => t.id === dragId)) return;

    // Candidates are this project's OTHER visible rows, in document order.
    // First midpoint below the cursor wins; none = past the last sibling,
    // so the row lands at the bottom of its own project.
    const rows = Array.from(dragRoot().querySelectorAll<HTMLElement>("[data-sidebar-task-id]"))
      .filter(el => el.dataset.sidebarTaskProjectId === armed.projectId && el.dataset.sidebarTaskId !== dragId);
    let beforeId: string | null = null;
    for (const el of rows) {
      const r = el.getBoundingClientRect();
      if (e.clientY < (r.top + r.bottom) / 2) { beforeId = el.dataset.sidebarTaskId!; break; }
    }

    const rest = all.filter(t => t.id !== dragId);
    let insertAt: number;
    if (beforeId) {
      insertAt = rest.findIndex(t => t.id === beforeId);
      if (insertAt === -1) return;
    } else {
      // Index just past this project's last visible row in the GLOBAL array
      // — the sidebar filters one shared list, so the dragged task has to
      // stay inside its own project's span of it.
      let last = -1;
      rest.forEach((t, i) => { if (t.project_id === armed.projectId && !t.archived) last = i; });
      insertAt = last + 1;
    }
    const next = [...rest];
    next.splice(insertAt, 0, all.find(t => t.id === dragId)!);
    hitTestTaskGroup(e.clientY, armed.projectId, dragId);
    if (next.every((t, i) => t.id === all[i].id)) return; // no visible change
    useApp.setState({ tasks: next });
  };

  // Which of this project's drawn group blocks the cursor is inside, the
  // header included. Stable at the edges without hysteresis: inside a block
  // the row becomes a member, which keeps the block under the cursor; past
  // its edge the row leaves, which shrinks the block further away.
  const hitTestTaskGroup = (clientY: number, projectId: string, dragId: string) => {
    let hit: string | null = null;
    for (const el of Array.from(dragRoot().querySelectorAll<HTMLElement>("[data-task-group-id]"))) {
      if (el.dataset.taskGroupProjectId !== projectId) continue;
      const r = el.getBoundingClientRect();
      if (clientY >= r.top && clientY <= r.bottom) { hit = el.dataset.taskGroupId!; break; }
    }
    if (hit === (dragTaskGroupRef.current === undefined ? undefined : dragTaskGroupRef.current?.id ?? null)) return;
    // The lead's copy is the canonical one (layoutTaskList's rule); any
    // other member's is identical unless a write is mid-flight.
    const all = useApp.getState().tasks;
    const g = hit === null
      ? null
      : (all.find(t => t.id === hit && t.group?.id === hit) ?? all.find(t => t.id !== dragId && t.group?.id === hit))?.group ?? null;
    setDragTaskGroup(g);
  };

  // ── Task GROUP block drag-to-reorder ──────────────────────────────────
  // The task-level twin of the project folder drag below: grab a group's
  // caption and the whole block moves through its project's rows as one
  // contiguous run. Top-level boundaries only (loose rows and OTHER blocks),
  // since a block never nests; like a task, it never leaves its project.
  const [dragBlockId, setDragBlockId] = useState<string | null>(null);
  const [dragBlockTy, setDragBlockTy] = useState(0);
  const blockDragArmed = useRef<
    { groupId: string; projectId: string; x: number; y: number; started: boolean; grabOffsetY: number; appliedTy: number; pointerY: number } | null
  >(null);
  const blockDragListenersRef = useRef<{ move: (e: PointerEvent) => void; up: (e: PointerEvent) => void } | null>(null);
  const blockClickSuppressed = useRef(false);
  const blockSel = (a: { groupId: string; projectId: string }) =>
    `[data-task-group-id="${CSS.escape(a.groupId)}"][data-task-group-project-id="${CSS.escape(a.projectId)}"]`;

  const computeBlockTy = (clientY: number): number => {
    const armed = blockDragArmed.current;
    const el = armed && dragRoot().querySelector<HTMLElement>(blockSel(armed));
    if (!armed || !el) return 0;
    const layoutTop = el.getBoundingClientRect().top - armed.appliedTy;
    const ty = (clientY - armed.grabOffsetY) - layoutTop;
    armed.appliedTy = ty;
    return ty;
  };

  const endBlockDrag = (commit: boolean) => {
    const ls = blockDragListenersRef.current;
    if (ls) {
      document.removeEventListener("pointermove", ls.move);
      document.removeEventListener("pointerup", ls.up);
      document.removeEventListener("pointercancel", ls.up);
      blockDragListenersRef.current = null;
    }
    const armed = blockDragArmed.current;
    blockDragArmed.current = null;
    setDragBlockId(null);
    setDragBlockTy(0);
    if (commit && armed?.started) {
      // The drop's trailing click lands on the caption, which toggles now:
      // swallow it, and clear on the next tick for the drops whose click
      // never arrives (same pattern as the task row drag).
      blockClickSuppressed.current = true;
      setTimeout(() => { blockClickSuppressed.current = false; }, 0);
      // Display order, as the task drop does: what is stored is what was seen.
      const projectRows = useApp.getState().tasks.filter(t => t.project_id === armed.projectId && !t.archived);
      taskReorder(flattenSegments(layoutTaskList(projectRows)).map(t => t.id))
        .catch(() => { void useApp.getState().loadAll(); });
    }
  };

  const onBlockDragPointerMove = (e: PointerEvent) => {
    const armed = blockDragArmed.current;
    if (!armed) return;
    if (!armed.started) {
      const dx = e.clientX - armed.x;
      const dy = e.clientY - armed.y;
      if (dx * dx + dy * dy < 16) return;
      armed.started = true;
      setDragBlockId(armed.groupId);
    }
    armed.pointerY = e.clientY;
    setDragBlockTy(computeBlockTy(e.clientY));
    const { groupId, projectId } = armed;
    const all = useApp.getState().tasks;
    const inBlock = (t: Task) => t.project_id === projectId && !t.archived && t.group?.id === groupId;
    const members = all.filter(inBlock);
    if (members.length === 0) return;
    const rest = all.filter(t => !inBlock(t));
    // Loose rows and other blocks of THIS project, in document order; the
    // first midpoint below the cursor is the slot.
    const boundaries = Array.from(
      dragRoot().querySelectorAll<HTMLElement>("[data-sidebar-task-id], [data-task-group-id]"),
    ).filter(el => el.dataset.taskGroupId !== undefined
      ? el.dataset.taskGroupProjectId === projectId && el.dataset.taskGroupId !== groupId
      : el.dataset.sidebarTaskProjectId === projectId && !el.closest("[data-task-group-id]"));
    let beforeId: string | null = null;
    for (const el of boundaries) {
      const r = el.getBoundingClientRect();
      if (e.clientY < (r.top + r.bottom) / 2) {
        beforeId = el.dataset.taskGroupId !== undefined
          ? rest.find(t => t.project_id === projectId && !t.archived && t.group?.id === el.dataset.taskGroupId)?.id ?? null
          : el.dataset.sidebarTaskId!;
        break;
      }
    }
    let insertAt = beforeId ? rest.findIndex(t => t.id === beforeId) : -1;
    if (insertAt === -1) {
      // Past the last slot: just after this project's last visible row.
      let last = -1;
      rest.forEach((t, i) => { if (t.project_id === projectId && !t.archived) last = i; });
      insertAt = last + 1;
    }
    const next = [...rest.slice(0, insertAt), ...members, ...rest.slice(insertAt)];
    if (next.every((t, i) => t === all[i])) return;
    useApp.setState({ tasks: next });
  };

  const onBlockDragPointerDown = (e: React.PointerEvent, groupId: string, projectId: string) => {
    if (compact || e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest('button, input, a, [data-no-drag], [role="menu"], [role="dialog"]')) return;
    const el = e.currentTarget.closest<HTMLElement>("[data-task-group-id]");
    blockDragArmed.current = {
      groupId, projectId, x: e.clientX, y: e.clientY, started: false,
      grabOffsetY: e.clientY - (el ?? (e.currentTarget as HTMLElement)).getBoundingClientRect().top,
      appliedTy: 0, pointerY: e.clientY,
    };
    const onUp = () => endBlockDrag(true);
    blockDragListenersRef.current = { move: onBlockDragPointerMove, up: onUp };
    document.addEventListener("pointermove", onBlockDragPointerMove);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onUp);
  };

  const onTaskDragPointerDown = (e: React.PointerEvent, w: Task) => {
    if (compact) return;
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    // Same bail-out set as the project header: real controls, plus anything
    // inside a portaled Radix menu/dialog (those bubble synthetic pointer
    // events back up the React tree to this row).
    if (target.closest('button, input, a, [data-no-drag], [role="menu"], [role="dialog"]')) return;
    taskDragArmed.current = {
      id: w.id, projectId: w.project_id, x: e.clientX, y: e.clientY, started: false,
      grabOffsetY: e.clientY - (e.currentTarget as HTMLElement).getBoundingClientRect().top,
      appliedTy: 0, pointerY: e.clientY, origGroupId: w.group?.id ?? null,
    };
    const onUp = () => endTaskDrag(true);
    taskDragListenersRef.current = { move: onTaskDragPointerMove, up: onUp };
    document.addEventListener("pointermove", onTaskDragPointerMove);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onUp);
  };
  // Rows are memoized (TaskRowSlot), and a handler re-created per render
  // would defeat that for every row on every sidebar render. One stable
  // function that calls whatever the last committed render built.
  const taskDragPointerDownRef = useRef(onTaskDragPointerDown);
  useLayoutEffect(() => { taskDragPointerDownRef.current = onTaskDragPointerDown; });
  const onTaskDragPointerDownStable = useCallback(
    (e: React.PointerEvent, w: Task) => taskDragPointerDownRef.current(e, w), []);

  // ── Group header drag-to-reorder ──────────────────────────────────────
  // Same pointer pattern as project rows, but the unit is the whole folder:
  // its members move through the array as one contiguous block (labels
  // never change), and the section container follows the cursor.
  const [dragGroupName, setDragGroupName] = useState<string | null>(null);
  const [dragGroupTy, setDragGroupTy] = useState(0);
  const groupDragArmed = useRef<
    { name: string; x: number; y: number; started: boolean; grabOffsetY: number; appliedTy: number; pointerY: number } | null
  >(null);
  const groupDragListenersRef = useRef<{ move: (e: PointerEvent) => void; up: (e: PointerEvent) => void } | null>(null);

  // All drag hit-testing is scoped to THIS instance's DOM — the Arc-style
  // hover reveal renders two Sidebars at once (compact rail + full overlay),
  // and a document-wide query would also match the other instance's rows.
  const dragRoot = (): ParentNode => asideRef.current ?? document;

  // translateY that keeps the dragged header under the cursor, self-correcting
  // against the live layout after each reorder (reads the header's real rect
  // minus the transform already applied to recover its untranslated slot).
  const computeProjectTy = (clientY: number): number => {
    const armed = dragArmed.current;
    const el = armed && dragRoot().querySelector<HTMLElement>(`[data-project-id="${CSS.escape(armed.id)}"]`);
    if (!armed || !el) return 0;
    const layoutTop = el.getBoundingClientRect().top - armed.appliedTy;
    const ty = (clientY - armed.grabOffsetY) - layoutTop;
    armed.appliedTy = ty;
    return ty;
  };

  // Tear-down helper, used by both pointerup and pointercancel.
  const endDrag = (commit: boolean) => {
    const ls = dragListenersRef.current;
    if (ls) {
      document.removeEventListener("pointermove", ls.move);
      document.removeEventListener("pointerup", ls.up);
      document.removeEventListener("pointercancel", ls.up);
      dragListenersRef.current = null;
    }
    const armed = dragArmed.current;
    const wasStarted = armed?.started ?? false;
    const hoverGroup = dragOverGroupRef.current;
    dragArmed.current = null;
    dragOverGroupRef.current = null;
    setDragOverGroup(null);
    setDragProjectId(null);
    setDragTy(0);
    if (commit && wasStarted && armed) {
      const list = [...useApp.getState().projects];
      const idx = list.findIndex(x => x.id === armed.id);
      if (idx === -1) return;
      let dragged = list[idx];
      if (hoverGroup) {
        // Dropped on a folder header → become the group's first member
        // (that's where the cursor is). Update the local order optimistically
        // and expand the folder so the drop is visible.
        dragged = { ...dragged, group: hoverGroup };
        list.splice(idx, 1);
        // First member of the group in array order. Grouped rows never fold
        // under "Hide inactive projects" (only loose rows do), so every member
        // is visible; the shown() guard just keeps this in lockstep with the
        // render's shownInline.
        const hideInactive = usePrefs.getState().hideInactiveProjects;
        const wss = useApp.getState().tasks;
        const firstIdx = list.findIndex(x =>
          groupOf(x) === hoverGroup
          && (!hideInactive || !!groupOf(x) || wss.some(w => w.project_id === x.id && !w.archived)),
        );
        // -1 = dragged is the folder's SOLE (visible) member (dropped on
        // its own header): keep its slot instead of teleporting the
        // folder to the end of the list.
        list.splice(firstIdx === -1 ? idx : firstIdx, 0, dragged);
        useApp.setState({ projects: list });
        setTreeFold("folder", hoverGroup, false, compact);
      }
      // Group changed during the drag (live adoption between rows, or the
      // header drop above) → persist it before the reorder. projectSetGroup
      // touches ONLY the group field, so a stale snapshot of the dragged
      // project can't clobber concurrent edits to its other fields.
      const newGroup = groupOf(dragged);
      const groupChanged = newGroup !== armed.origGroup;
      const finalIds = list.map(x => x.id);
      (async () => {
        try {
          if (groupChanged) await projectSetGroup([dragged.id], newGroup || null);
          await projectReorder(finalIds);
        } catch {
          void useApp.getState().loadAll();
        }
      })();
    }
  };

  // Single shared pointermove handler — keyed off armed.id (the
  // dragged project) rather than any per-row closure. Survives the
  // dragged element being reparented during reorder.
  const onDragPointerMove = (e: PointerEvent) => {
    const armed = dragArmed.current;
    if (!armed) return;
    if (!armed.started) {
      const dx = e.clientX - armed.x;
      const dy = e.clientY - armed.y;
      if (dx * dx + dy * dy < 16) return;
      armed.started = true;
      setDragProjectId(armed.id);
    }
    // Follow the cursor every move (before the reorder hit-test, which has
    // early returns), so the header tracks smoothly even when no swap happens.
    armed.pointerY = e.clientY;
    setDragTy(computeProjectTy(e.clientY));
    const dragId = armed.id;
    const all = useApp.getState().projects;
    const fromIdx = all.findIndex(x => x.id === dragId);
    if (fromIdx === -1) return;

    // Anchors below resolve against the projects the user can SEE. Grouped
    // rows never fold under "Collapse inactive ungrouped projects" (only loose
    // rows do), so shown() mirrors the render's shownInline: grouped always
    // visible, loose visible only when active. getState (not the render
    // closure): the document-level listener is captured once at pointerdown and
    // would otherwise read stale values.
    const hideInactive = usePrefs.getState().hideInactiveProjects;
    const wss = useApp.getState().tasks;
    const shown = (x: typeof all[number]) =>
      !hideInactive || !!groupOf(x) || wss.some(w => w.project_id === x.id && !w.archived);
    // First VISIBLE member of group `g` in array order (skipping the
    // dragged row) — matches the first row rendered inside the folder.
    const firstIdOfGroup = (g: string): string | null =>
      all.find(x => x.id !== dragId && shown(x) && groupOf(x) === g)?.id ?? null;
    // Id of the project that FOLLOWS group `g`'s last VISIBLE member in
    // array order (null = end of array) — "insert at the end of the folder".
    const idAfterGroup = (g: string): string | null => {
      let last = -1;
      all.forEach((x, i) => { if (x.id !== dragId && shown(x) && groupOf(x) === g) last = i; });
      for (let i = last + 1; i < all.length; i++) if (all[i].id !== dragId) return all[i].id;
      return null;
    };
    // Project following the dragged row itself — the "stay at this index"
    // slot, used when the dragged row is a folder's SOLE member (the
    // group-relative anchors above have nothing to anchor to then).
    const idAfterSelf = (): string | null => {
      for (let i = fromIdx + 1; i < all.length; i++) if (all[i].id !== dragId) return all[i].id;
      return null;
    };

    // Zone-based target: where the cursor is decides both the slot AND the
    // dragged project's group.
    //   inside a folder's rendered container:
    //     header top half    → before the folder, ungrouped
    //     header bottom half → INTO the folder (highlight; assign on drop)
    //     members area       → before the member under the cursor, in-group;
    //                          past the last member (but still inside the
    //                          container) stays at the folder's end — so
    //                          hovering the tail of your own folder doesn't
    //                          eject you.
    //   outside any folder: walk loose headers + whole folder sections in
    //   document order; first midpoint below the cursor wins, ungrouped.
    let hovered: string | null = null;
    let slot: { beforeId: string | null; group: string } | null = null;
    const curGroup = groupOf(all[fromIdx]);
    // The revealed inactive fold is its own drag domain: rows there render
    // flat in a separate section regardless of their group label, so a
    // reorder across it must NOT rewrite the dragged project's group —
    // neither stripping a grouped inactive row nor silently adopting a
    // group when an inactive row passes an active folder's y-range. That
    // cuts BOTH ways: a drag that ORIGINATES in the fold keeps its group
    // everywhere (fold rows render flat, so an adoption or strip would be
    // invisible until hide-inactive is toggled off) — sections are plain
    // reorder boundaries for it, never drop targets.
    const fold = dragRoot().querySelector<HTMLElement>("[data-inactive-fold]");
    const foldRect = fold?.getBoundingClientRect();
    const inFold = !!foldRect && e.clientY >= foldRect.top && e.clientY <= foldRect.bottom;
    let inSection: HTMLElement | null = null;
    if (!inFold && !armed.fromFold) {
      for (const sec of Array.from(dragRoot().querySelectorAll<HTMLElement>("[data-group-section]"))) {
        const r = sec.getBoundingClientRect();
        if (e.clientY >= r.top && e.clientY <= r.bottom) { inSection = sec; break; }
      }
    }
    if (inFold && fold) {
      slot = { beforeId: null, group: curGroup };
      for (const el of Array.from(fold.querySelectorAll<HTMLElement>("[data-project-id]"))) {
        if (el.dataset.projectId === dragId) continue;
        const r = el.getBoundingClientRect();
        if (e.clientY < (r.top + r.bottom) / 2) {
          slot = { beforeId: el.dataset.projectId!, group: curGroup };
          break;
        }
      }
    } else if (inSection) {
      const g = inSection.dataset.groupSection!;
      const header = inSection.querySelector<HTMLElement>("[data-group-name]");
      const hr = header?.getBoundingClientRect();
      if (hr && e.clientY < (hr.top + hr.bottom) / 2) {
        // ?? idAfterSelf(): dragged is the folder's sole member — pulling
        // it out above the header keeps its index, just ungroups it.
        slot = { beforeId: firstIdOfGroup(g) ?? idAfterSelf(), group: "" };
      } else if (hr && e.clientY <= hr.bottom) {
        hovered = g;
      } else if (!firstIdOfGroup(g)) {
        // Members area of a folder whose only member IS the dragged row:
        // nothing to reorder against — stay put.
        slot = null;
      } else {
        slot = { beforeId: idAfterGroup(g), group: g };
        for (const el of Array.from(inSection.querySelectorAll<HTMLElement>("[data-project-id]"))) {
          if (el.dataset.projectId === dragId) continue;
          const r = el.getBoundingClientRect();
          if (e.clientY < (r.top + r.bottom) / 2) {
            slot = { beforeId: el.dataset.projectId!, group: g };
            break;
          }
        }
      }
    } else {
      // Fold-origin drags keep their label (see the fold-domain note above);
      // everything else dropped at top level becomes ungrouped.
      slot = { beforeId: null, group: armed.fromFold ? curGroup : "" };
      const boundaries = Array.from(
        dragRoot().querySelectorAll<HTMLElement>("[data-project-id], [data-group-section]"),
      ).filter(el =>
        el.dataset.groupSection !== undefined
          ? true
          : el.dataset.projectId !== dragId
            && !el.closest("[data-group-section]")
            && !el.closest("[data-inactive-fold]"));
      for (const el of boundaries) {
        const r = el.getBoundingClientRect();
        if (e.clientY < (r.top + r.bottom) / 2) {
          slot.beforeId = el.dataset.groupSection !== undefined
            ? (firstIdOfGroup(el.dataset.groupSection) ?? idAfterSelf())
            : el.dataset.projectId!;
          break;
        }
      }
    }
    if (hovered !== dragOverGroupRef.current) {
      dragOverGroupRef.current = hovered;
      setDragOverGroup(hovered);
    }
    if (hovered || !slot) return;

    const { beforeId, group: targetGroup } = slot;
    const nextIds = all.map(x => x.id).filter(id => id !== dragId);
    const insertAt = beforeId
      ? nextIds.findIndex(id => id === beforeId)
      : nextIds.length;
    const targetIdx = insertAt === -1 ? nextIds.length : insertAt;
    if (targetIdx === fromIdx && targetGroup === curGroup) return;
    nextIds.splice(targetIdx, 0, dragId);
    useApp.setState(s => ({
      projects: nextIds
        .map(id => s.projects.find(x => x.id === id)!)
        .filter(Boolean)
        // Live group adoption: the row visually slides into / out of the
        // folder as it crosses the boundary; persisted on drop by endDrag.
        .map(p => p.id === dragId && groupOf(p) !== targetGroup
          ? { ...p, group: targetGroup || undefined }
          : p),
    }));
  };

  // translateY for the dragged SECTION (group drag) — same self-correcting
  // scheme as computeProjectTy, measured on the section container.
  const computeGroupTy = (clientY: number): number => {
    const armed = groupDragArmed.current;
    const el = armed && dragRoot().querySelector<HTMLElement>(`[data-group-section="${CSS.escape(armed.name)}"]`);
    if (!armed || !el) return 0;
    const layoutTop = el.getBoundingClientRect().top - armed.appliedTy;
    const ty = (clientY - armed.grabOffsetY) - layoutTop;
    armed.appliedTy = ty;
    return ty;
  };

  const endGroupDrag = (commit: boolean) => {
    const ls = groupDragListenersRef.current;
    if (ls) {
      document.removeEventListener("pointermove", ls.move);
      document.removeEventListener("pointerup", ls.up);
      document.removeEventListener("pointercancel", ls.up);
      groupDragListenersRef.current = null;
    }
    const wasStarted = groupDragArmed.current?.started ?? false;
    groupDragArmed.current = null;
    setDragGroupName(null);
    setDragGroupTy(0);
    if (commit && wasStarted) {
      const finalIds = useApp.getState().projects.map(x => x.id);
      projectReorder(finalIds).catch(() => { void useApp.getState().loadAll(); });
    }
  };

  const onGroupDragPointerMove = (e: PointerEvent) => {
    const armed = groupDragArmed.current;
    if (!armed) return;
    if (!armed.started) {
      const dx = e.clientX - armed.x;
      const dy = e.clientY - armed.y;
      if (dx * dx + dy * dy < 16) return;
      armed.started = true;
      setDragGroupName(armed.name);
    }
    armed.pointerY = e.clientY;
    setDragGroupTy(computeGroupTy(e.clientY));
    const name = armed.name;
    const all = useApp.getState().projects;
    const members = all.filter(x => groupOf(x) === name);
    if (members.length === 0) return;
    const rest = all.filter(x => groupOf(x) !== name);
    const hideInactive = usePrefs.getState().hideInactiveProjects;
    const wss = useApp.getState().tasks;
    const shown = (x: typeof all[number]) =>
      !hideInactive || !!groupOf(x) || wss.some(w => w.project_id === x.id && !w.archived);
    // Top-level boundaries only: loose rows + OTHER folder sections in
    // document order. A folder can't nest, so its drop slots are always
    // between top-level items; first midpoint below the cursor wins.
    const boundaries = Array.from(
      dragRoot().querySelectorAll<HTMLElement>("[data-project-id], [data-group-section]"),
    ).filter(el =>
      el.dataset.groupSection !== undefined
        ? el.dataset.groupSection !== name
        : !el.closest("[data-group-section]") && !el.closest("[data-inactive-fold]"));
    let beforeId: string | null = null;
    for (const el of boundaries) {
      const r = el.getBoundingClientRect();
      if (e.clientY < (r.top + r.bottom) / 2) {
        beforeId = el.dataset.groupSection !== undefined
          ? rest.find(x => shown(x) && groupOf(x) === el.dataset.groupSection)?.id ?? null
          : el.dataset.projectId!;
        break;
      }
    }
    const at = beforeId ? rest.findIndex(x => x.id === beforeId) : rest.length;
    const insertAt = at === -1 ? rest.length : at;
    const next = [...rest.slice(0, insertAt), ...members, ...rest.slice(insertAt)];
    if (next.every((x, i) => x === all[i])) return;
    useApp.setState({ projects: next });
  };

  // After a live reorder re-renders the list, the dragged header sits in a new
  // slot — re-derive its transform from the new layout BEFORE paint so it
  // doesn't jump for a frame. `tasks` is a dep for the same reason `projects`
  // is: a task drag splices that array, and without the re-anchor the row
  // paints a row-height out of place until the NEXT pointermove corrects it
  // (visible whenever the user pauses or releases right at a swap point).
  useLayoutEffect(() => {
    if (dragArmed.current?.started) setDragTy(computeProjectTy(dragArmed.current.pointerY));
    if (groupDragArmed.current?.started) setDragGroupTy(computeGroupTy(groupDragArmed.current.pointerY));
    if (taskDragArmed.current?.started) setDragTaskTy(computeTaskTy(taskDragArmed.current.pointerY));
    if (blockDragArmed.current?.started) setDragBlockTy(computeBlockTy(blockDragArmed.current.pointerY));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects, tasks]);

  async function commitRename() {
    if (!renaming) return;
    const { kind, id, value } = renaming;
    setRenaming(null);
    const trimmed = value.trim();
    if (!trimmed) return;
    try {
      if (kind === "proj") {
        await projectRename(id, trimmed);
      } else {
        // Group rename = relabel every member in ONE atomic write (groups
        // are derived from Project.group, there is no group entity).
        // Renaming onto an existing group's name merges the two.
        // Uppercase again at commit (belt to the input's braces) — a
        // lowercase label on disk would diverge from what groupOf renders.
        const label = trimmed.toUpperCase();
        if (label === id) return;
        const memberIds = useApp.getState().projects
          .filter(p => groupOf(p) === id).map(p => p.id);
        await projectSetGroup(memberIds, label);
        useApp.getState().renameGroupState(id, label);
      }
      await loadAll();
    } catch (e) {
      console.error("rename failed", e);
      // Resync from disk — the UI may be showing optimistic state.
      void loadAll();
    }
  }

  // ── Project groups (UI-only folders in this list) ──────────────────────
  // A group exists iff ≥1 project carries its label; ordered by first
  // appearance in the (user-orderable) projects array. Includes groups
  // whose members are currently folded into the inactive section so the
  // "Move to group" menu can still target them.
  const allGroups: string[] = [];
  for (const p of projects) {
    const g = groupOf(p);
    if (g && !allGroups.includes(g)) allGroups.push(g);
  }

  const moveToGroup = async (p: typeof projects[number], group: string | null): Promise<boolean> => {
    try {
      // Filing INTO an existing folder also repositions the project to the
      // folder's end in the array. Without this a project that sits earlier
      // in the array than the folder would drag the whole folder up to its
      // old position (a section renders at its FIRST member's index).
      let reorderIds: string[] | null = null;
      if (group) {
        const all = useApp.getState().projects;
        if (all.some(x => x.id !== p.id && groupOf(x) === group)) {
          const list = all.filter(x => x.id !== p.id);
          let last = -1;
          list.forEach((x, i) => { if (groupOf(x) === group) last = i; });
          list.splice(last + 1, 0, { ...p, group });
          useApp.setState({ projects: list });
          reorderIds = list.map(x => x.id);
        }
      }
      await projectSetGroup([p.id], group);
      if (reorderIds) await projectReorder(reorderIds);
      // Expand the destination so the project doesn't silently vanish
      // into a collapsed folder.
      if (group) setTreeFold("folder", group, false, compact);
      await loadAll();
      return true;
    } catch (e) {
      console.error("move to group failed", e);
      void loadAll();
      return false;
    }
  };

  const createGroupWith = async (p: typeof projects[number]) => {
    const names = new Set(allGroups);
    let name = "NEW GROUP";
    for (let n = 2; names.has(name); n += 1) name = `NEW GROUP ${n}`;
    const ok = await moveToGroup(p, name);
    // Immediately offer the real name — but only when the fresh folder
    // actually renders an editable header: full mode (compact has no inline
    // rename, matching project rename) AND a visible member (a hidden
    // inactive project renders no folder, which would strand the rename
    // state with no input to commit or escape it).
    if (ok && !compact && shownInline(p)) {
      setRenaming({ kind: "group", id: name, value: groupDisplayName(name) });
    }
  };

  const dissolveGroup = async (name: string) => {
    const ids = useApp.getState().projects.filter(p => groupOf(p) === name).map(p => p.id);
    try {
      await projectSetGroup(ids, null);
      await loadAll();
    } catch (e) {
      console.error("ungroup failed", e);
      void loadAll();
    }
  };

  const asideRef = useRef<HTMLElement>(null);

  // Inactive = no active (non-archived) tasks. When the hide pref is on we
  // split the list into two groups that each KEEP the original project order:
  // active rows render in place, inactive rows fold into a group below the
  // "Show N inactive" toggle. Membership is purely "does it have a task" —
  // a project only graduates to the active group once an actual task
  // exists, NOT while its repo-name prompt is still open (the prompt renders in
  // place within the revealed inactive group). Because both groups preserve
  // order, a folded project that gains a task pops back to its rightful
  // position among the active rows.
  //
  // GROUPED projects are EXEMPT from the fold: a project inside a folder stays
  // in that folder regardless of activity, so hide-inactive never yanks a
  // grouped project out to the flat bottom fold (that read as a bug — you
  // grouped it on purpose). Only LOOSE (ungrouped) inactive projects fold. So
  // the fold is "declutter the loose top-level list"; folders stay intact and
  // are the user's own organization to prune.
  const projectIsActive = (pid: string) =>
    tasks.some(w => w.project_id === pid && !w.archived);
  const shownInline = (p: typeof projects[number]) =>
    !hideInactiveProjects || projectIsActive(p.id) || !!groupOf(p);
  // While filtering: a project shows when a task of its matches (the open
  // task counts, the tree keeps it listed), or when `project:` names it, so
  // an empty project can still be found to start a task in. The inactive
  // fold is not drawn: the filter already removed the clutter it hides.
  const queryProjectIds = queryMatchIds && new Set(
    queryLiveTasks.filter(w => queryMatchIds.has(w.id) || w.id === activeTask).map(w => w.project_id),
  );
  const queryNamed = queryOn
    ? new Set(taskQuery.query.clauses.filter(c => c.key === "project" && !c.negated).flatMap(c => c.values))
    : null;
  const activeProjects = queryProjectIds
    ? projects.filter(p => queryProjectIds.has(p.id) || !!queryNamed?.has(p.name.toLowerCase()))
    : projects.filter(shownInline);
  const inactiveProjects = projects.filter(p => !shownInline(p));
  const inactiveCount = inactiveProjects.length;
  // If hiding is disabled (or nothing is hidden), keep the reveal latch off so
  // re-enabling starts collapsed.
  if (showInactive && inactiveCount === 0) setShowInactive(false);

  return (
    // The aside clips (`overflow-hidden`), so the resize handle is its SIBLING
    // inside this wrapper rather than its child: the outer half of a grab strip
    // that leaves the aside's box is clipped out of existence, hit testing
    // included, which is how the divider shipped grabbable across one pixel.
    // The wrapper is the grid cell now; it does not clip, and the 5px that
    // overhang the sidebar land on the main area, a sibling.
    <div className="relative flex h-full min-w-0">
    <aside
      ref={asideRef}
      data-profile-wash={sidebarWash ? "" : undefined}
      style={sidebarWash ? { "--sidebar-panel-wash": sidebarWash } as React.CSSProperties : undefined}
      className="sidebar-panel relative flex h-full min-w-0 flex-1 flex-col overflow-hidden"
    >
      {/* The sidebar's head. Full mode: the toolbar (view switcher and the
          agent readout), then the filter and the chips. The rail keeps a
          column of view buttons. */}
      <div className="flex shrink-0 flex-col">
      {compact ? (
        <div className="flex flex-col items-center gap-[8px] border-b border-[var(--sidebar-head-rule)] px-[8px] pb-[10px] pt-[10px]">
          <nav data-testid="sidebar-rail-views" className="flex flex-col gap-[2px] rounded-[8px] bg-[var(--sidebar-well-bg)] p-[3px] shadow-[var(--sidebar-well-shadow)]">
            <ViewSegment icon={<FolderGlyph />} label={t("navDashboard")} side="right"
              active={currentView === "dashboard" && !activeTask}
              onClick={() => setView("dashboard")}
            />
            <ViewSegment icon={<HistoryGlyph />} label={t("navHistory")} side="right"
              active={currentView === "history" && !activeTask}
              onClick={() => setView("history")}
            />
            {showBoard && (
              <ViewSegment icon={<KanbanGlyph />} label={t("navBoard")} side="right"
                active={currentView === "board" && !activeTask}
                onClick={() => setView("board")} testId="nav-board"
              />
            )}
            {showScheduled && (
              <ViewSegment icon={<ScheduleGlyph />} label={t("navScheduled")} side="right"
                active={currentView === "scheduled" && !activeTask}
                onClick={() => setView("scheduled")} testId="nav-scheduled"
              />
            )}
          </nav>
        </div>
      ) : (
        // Same band as .sessionbar (height, fill, rule), so the two read as one strip.
        <div
          data-testid="sidebar-toolbar"
          className="sidebar-toolbar-band flex shrink-0 items-center justify-center px-[10px]"
        >
          <nav data-testid="sidebar-view-switcher" className="flex gap-[2px] rounded-[8px] bg-[var(--sidebar-well-bg)] p-[3px] shadow-[var(--titlebar-well-shadow)]">
            <ViewSegment icon={<FolderGlyph />} label={t("navDashboard")}
              active={currentView === "dashboard" && !activeTask}
              onClick={() => setView("dashboard")} testId="nav-dashboard"
            />
            <ViewSegment icon={<HistoryGlyph />} label={t("navHistory")}
              active={currentView === "history" && !activeTask}
              onClick={() => setView("history")} testId="nav-history"
            />
            {showBoard && (
              <ViewSegment icon={<KanbanGlyph />} label={t("navBoard")}
                active={currentView === "board" && !activeTask}
                onClick={() => setView("board")} testId="nav-board"
              />
            )}
            {showScheduled && (
              <ViewSegment icon={<ScheduleGlyph />} label={t("navScheduled")}
                active={currentView === "scheduled" && !activeTask}
                onClick={() => setView("scheduled")} testId="nav-scheduled"
              />
            )}
          </nav>
        </div>
      )}
      {/* The filter and the chips sit between two rules, the toolbar's and
          this one, which parts the head from the list, with the same room
          on both sides of each rule (--sidebar-head-pad). A hidden chips row
          takes its gap with it. */}
      <div className={cn("flex flex-col", !compact && "gap-[var(--sidebar-filter-gap)] border-b border-[var(--sidebar-head-rule)] py-[var(--sidebar-head-pad)]")}>

      {/* The filter bar: above STATUS and PROJECTS, outside their scroller,
          because it scopes both and must not scroll away from them. */}
      {!compact && (
        <BoardFilterBar
          variant="sidebar"
          text={sidebarQuery}
          onTextChange={setSidebarQuery}
          shown={queryMatchIds?.size ?? queryLiveTasks.length}
          total={queryLiveTasks.length}
          unknownKeys={taskQuery.query.unknownKeys}
          valuesFor={taskQuery.valuesFor}
          sections={taskQuery.sections}
          menuOpen={filterMenuOpen}
          onMenuOpenChange={setFilterMenuOpen}
        />
      )}
      {/* One row under the bar: the status chips, and nothing else. The
          filter's count used to share this line, and with six chips it did
          not fit: the row scrolled and the count covered the last chip, which
          is the one a click had just turned on. The count is at the foot of
          the tree now, with the note about hidden projects. The chips stand
          in for the STATUS section while it is off; with it on they would
          count the same buckets the section lists. `empty:hidden` drops the
          row when the section is on; with the chips it is always there, at
          one height, so the tree below never shifts. No rule under it: one
          was tried and read as too harsh against the sidebar. */}
      {!compact && (
        <div className="flex shrink-0 items-center gap-2 px-[10px] empty:hidden">
          {!showStatusSection && <StatusChips />}
        </div>
      )}
      </div>
      </div>

      {/* The section header: what the list below is (PROJECTS, or STATUS
          with its count when swapped), and the buttons that act on it. Out
          of the scroller, so it never scrolls away from the list. */}
      {!compact && (
        <div
          data-testid="projects-section-header"
          className="mt-[var(--sidebar-head-pad)] flex h-[28px] shrink-0 select-none items-center gap-[8px] px-[14px]"
        >
          <span data-testid="sidebar-section-eyebrow" className="truncate text-[11px] font-bold uppercase tracking-[0.8px] text-[var(--sidebar-eyebrow)]">
            {statusView ? t("statusHeader") : t("projectsHeader")}
          </span>
          {statusView && <StatusViewCount matchIds={queryMatchIds} />}
          <div className="flex-1" />
          <HeaderButton
            testId="sidebar-swap-view"
            label={statusView ? t("swapToProjects") : t("swapToStatus")}
            onClick={swapView}
          >
            <SwapGlyph size={14} />
          </HeaderButton>
          <HeaderButton
            testId="sidebar-expand-toggle"
            label={nextExpandAll ? t("expandAll") : t("collapseAll")}
            onClick={() => setTreeExpanded(nextExpandAll)}
          >
            {nextExpandAll ? <ExpandAllGlyph size={14} /> : <CollapseAllGlyph size={14} />}
          </HeaderButton>
          <DropdownRoot>
            <Tip content={t("listOptionsTip")}>
              <DropdownTrigger asChild>
                <HeaderButton testId="sidebar-list-options" label={t("listOptionsTip")} ownTip={false}>
                  <ListOptionsGlyph size={14} />
                </HeaderButton>
              </DropdownTrigger>
            </Tip>
            {/* preventDefault on close keeps focus from snapping back to the
                trigger, which would otherwise re-fire its (focus-triggered)
                tooltip and leave it stuck open after selecting an item. */}
            <DropdownMenu side="right" align="start" sideOffset={4} className="sidebar-menu w-[280px]" onCloseAutoFocus={(e) => e.preventDefault()}>
              {/* Both actions cover group folders too — expanding agents
                  under a still-collapsed folder would look like a no-op,
                  and "collapse all" means the whole tree tidies up. Task rows
                  have no throwaway fold, so while the query filters they are
                  left alone rather than rewriting the stored layout. */}
              <DropdownItem onSelect={() => setTreeExpanded(true)}>
                <ExpandAllGlyph size={14} strokeWidth={2} className="shrink-0 text-[var(--sidebar-ink)]" />
                <span>{t("expandAll")}</span>
              </DropdownItem>
              <DropdownItem onSelect={() => setTreeExpanded(false)}>
                <CollapseAllGlyph size={14} strokeWidth={2} className="shrink-0 text-[var(--sidebar-ink)]" />
                <span>{t("collapseAll")}</span>
              </DropdownItem>
              <DropdownSeparator />
              <DropdownLabel>{t("defaultExpand")}</DropdownLabel>
              {([
                ["chevron", "expandChevron", "expandChevronHint"],
                ["click",   "expandClick",   "expandClickHint"],
                ["always",  "expandAlways",  "expandAlwaysHint"],
              ] as const).map(([id, labelKey, hintKey]) => {
                const isActive = taskExpandMode === id;
                return (
                  <DropdownItem
                    key={id}
                    onSelect={() => setTaskExpandMode(id)}
                    className={isActive
                      ? "bg-[var(--sidebar-menu-checked-bg)]"
                      : undefined}
                  >
                    {isActive
                      ? <Check className="h-[14px] w-[14px] shrink-0 text-[var(--color-accent)]" />
                      : <span className="w-[14px] shrink-0" />}
                    <div className="flex min-w-0 flex-col gap-0.5">
                      <span className={isActive ? "font-medium text-[var(--sidebar-menu-checked-ink)]" : undefined}>{t(labelKey)}</span>
                      <span className="text-[12px] leading-[1.35] text-[var(--sidebar-muted)]">{t(hintKey)}</span>
                    </div>
                  </DropdownItem>
                );
              })}
              {/* Mirrored in Settings > Appearance > Sidebar, which writes
                  the same pref. */}
              <DropdownSub>
                <DropdownSubTrigger data-testid="sidebar-task-git-icon" className="justify-between">
                  <span className="flex items-center gap-[10px]">
                    <span className="w-[14px] shrink-0" />
                    {t("taskGitIcon")}
                  </span>
                  {/* The current choice, as the glyphs it draws: the row
                      says what is on without opening the submenu. */}
                  <span className="flex items-center gap-2">
                    <TaskLocationSamples value={taskLocationIcon} />
                    <TreeChevron open={false} className="shrink-0 text-[var(--sidebar-meta)]" />
                  </span>
                </DropdownSubTrigger>
                <DropdownSubContent className="sidebar-menu">
                  {([
                    ["both",     "taskGitIconBoth"],
                    ["main",     "taskGitIconMain"],
                    ["worktree", "taskGitIconWorktree"],
                    ["none",     "taskGitIconNone"],
                  ] as const).map(([id, labelKey]) => (
                    <DropdownItem key={id} data-value={id} onSelect={() => setTaskLocationIcon(id)} className="items-center">
                      <Check className={cn("h-[14px] w-[14px] shrink-0 text-[var(--color-accent)]", taskLocationIcon === id ? "opacity-100" : "opacity-0")} />
                      <span className={cn("flex-1", taskLocationIcon === id && "font-medium text-[var(--sidebar-menu-checked-ink)]")}>{t(labelKey)}</span>
                      <span className="ml-4 flex items-center"><TaskLocationSamples value={id} /></span>
                    </DropdownItem>
                  ))}
                </DropdownSubContent>
              </DropdownSub>
              {/* The same shape for the row's PR mark. Mirrored in Settings
                  > Appearance > Sidebar, which writes the same pref. */}
              <DropdownSub>
                <DropdownSubTrigger data-testid="sidebar-task-pr-badge" className="justify-between">
                  <span className="flex items-center gap-[10px]">
                    <span className="w-[14px] shrink-0" />
                    {t("taskPrBadge")}
                  </span>
                  <span className="flex items-center gap-2">
                    <TaskPrSamples value={taskPrBadge} />
                    <TreeChevron open={false} className="shrink-0 text-[var(--sidebar-meta)]" />
                  </span>
                </DropdownSubTrigger>
                <DropdownSubContent className="sidebar-menu">
                  {([
                    ["both",   "taskPrBadgeBoth"],
                    ["icon",   "taskPrBadgeIcon"],
                    ["number", "taskPrBadgeNumber"],
                    ["none",   "taskPrBadgeNone"],
                  ] as const).map(([id, labelKey]) => (
                    <DropdownItem key={id} data-pr-value={id} onSelect={() => setTaskPrBadge(id)} className="items-center">
                      <Check className={cn("h-[14px] w-[14px] shrink-0 text-[var(--color-accent)]", taskPrBadge === id ? "opacity-100" : "opacity-0")} />
                      <span className={cn("flex-1", taskPrBadge === id && "font-medium text-[var(--sidebar-menu-checked-ink)]")}>{t(labelKey)}</span>
                      <span className="ml-4 flex items-center"><TaskPrSamples value={id} /></span>
                    </DropdownItem>
                  ))}
                </DropdownSubContent>
              </DropdownSub>
              <DropdownSeparator />
              <DropdownItem
                onSelect={() => setHideInactiveProjects(!hideInactiveProjects)}
                className={hideInactiveProjects
                  ? "bg-[var(--sidebar-menu-checked-bg)]"
                  : undefined}
              >
                {/* Checkmark when on, empty slot when off — same pattern as
                    the expand-mode rows above (no stray icon). */}
                {hideInactiveProjects
                  ? <Check className="h-[14px] w-[14px] shrink-0 text-[var(--color-accent)]" />
                  : <span className="w-[14px] shrink-0" />}
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className={hideInactiveProjects ? "font-medium text-[var(--sidebar-menu-checked-ink)]" : undefined}>{t("collapseInactive")}</span>
                  <span className="text-[12px] leading-[1.35] text-[var(--sidebar-muted)]">{t("collapseInactiveHint")}</span>
                </div>
              </DropdownItem>
              {/* Same check-row shape. Mirrored in Settings > Appearance >
                  Sidebar, which writes the same pref. */}
              <DropdownItem
                data-testid="sidebar-toggle-status-section"
                onSelect={() => setShowStatusSection(!showStatusSection)}
                className={showStatusSection
                  ? "bg-[var(--sidebar-menu-checked-bg)]"
                  : undefined}
              >
                {showStatusSection
                  ? <Check className="h-[14px] w-[14px] shrink-0 text-[var(--color-accent)]" />
                  : <span className="w-[14px] shrink-0" />}
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className={showStatusSection ? "font-medium text-[var(--sidebar-menu-checked-ink)]" : undefined}>{t("showStatusSection")}</span>
                  <span className="text-[12px] leading-[1.35] text-[var(--sidebar-muted)]">{t("showStatusSectionHint")}</span>
                </div>
              </DropdownItem>
            </DropdownMenu>
          </DropdownRoot>
          {/* The ONE Add project button (GH #280 removed the footer copy):
              it belongs next to the list it acts on. */}
          <HeaderButton testId="sidebar-add-project" label={t("addProjectTip")} onClick={openNewProject}>
            <FolderPlusGlyph size={15} />
          </HeaderButton>
        </div>
      )}

      {/* Projects section */}
      <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={projectsScrollRef}
        data-testid="sidebar-scroll"
        className={cn("relative min-h-0 flex-1", compact ? "no-scrollbar overflow-y-auto px-1.5 py-1.5" : "sidebar-scroll")}
      >
        {/* Lines to the hovered task's parent and the tasks it spawned. The
            icon rail has no room for them. */}
        {!compact && <SpawnLinksOverlay containerRef={projectsScrollRef} />}
        {/* STATUS above PROJECTS, in the same scroller (docs/ui.md "The
            sidebar's status section"). Not on the icon rail: the hover
            overlay is a full sidebar and shows it there instead. */}
        {!statusView && !compact && showStatusSection && <StatusSection matchIds={queryMatchIds} />}
        {compact && (
          <div data-testid="projects-section-header" className="flex flex-col gap-1.5 py-1">
            {/* The ONE Add project button (GH #280 removed the footer copy):
                it belongs next to the list it acts on. */}
            <Tip content={t("addProjectTip")} side="right">
              <button type="button" aria-label={t("addProjectTip")} data-testid="sidebar-add-project" className="sidebar-rail-tile" onClick={openNewProject}>
                <FolderPlusGlyph size={17} />
              </button>
            </Tip>
          </div>
        )}

        {/* The STATUS view lists the buckets in the tree's place. */}
        {statusView && !compact ? (
          <StatusSection asView matchIds={queryMatchIds} />
        ) : (
        <div className="flex flex-col gap-0.5">
          {(() => {
          // `depth`: 0 for a loose project, 1 inside a folder or the Inactive
          // fold. Everything under the row indents from it on the 18px grid.
          const renderProject = (p: typeof projects[number], depth = 0) => {
            const taskList = tasks.filter(w => w.project_id === p.id && !w.archived);
            const pendingForProject = pendingTaskList.filter(t => t.projectId === p.id);
            // Empty projects default to collapsed (no point pinning a blank
            // expanded row). User overrides stick: explicit true / false
            // wins; undefined falls back to emptiness-based default.
            const explicit = collapsedProjects[p.id];
            // Task filter (GH #324). Turning one on expands the project once
            // (ProjectFilterBar's onActivate): results behind a chevron read
            // as "nothing matched". Once, not for as long as it is on, or the
            // chevron would stop working while a filter is up.
            const filter = taskFilters[p.id];
            // A non-empty sidebar query takes over: the project's own filter
            // is kept but not applied, its bar hidden and its icon slashed,
            // and comes back as it was when the query clears.
            const filterSet = !compact && isFilterActive(filter);
            const filterOn = filterSet && !queryOn;
            const filterPaused = filterSet && queryOn;
            const queryTasks = queryMatchIds
              ? taskList.filter(w => queryMatchIds.has(w.id) || w.id === activeTask)
              : taskList;
            const visibleTasks = filterOn ? filterTasks(queryTasks, filter, tabFacts, agents, activeTask) : queryTasks;
            // "No matching tasks" only when the filter left the list EMPTY. The
            // active task is kept on screen even when it does not match, and a
            // hint saying nothing matched under a visible row contradicts it.
            const noMatches = (filterOn || queryOn) && taskList.length > 0 && visibleTasks.length === 0;
            const notifCount = compact ? 0 : taskList.filter(w => tabFacts[w.id]?.notification).length;
            // An active filter keeps its bar on screen on its own; otherwise
            // the bar is open only while the user put it there.
            const filterBarOpen = !compact && !queryOn && (filterSet || filterInputs[p.id] !== undefined);
            const closeFilterBar = () => setFilterInputs(prev => {
              if (prev[p.id] === undefined) return prev;
              const next = { ...prev };
              delete next[p.id];
              return next;
            });
            // Render-only fold while THIS project is being dragged: the
            // translateY rides on the header alone, so expanded task rows
            // would sit frozen in place while their header floats away.
            // Folding for the drag's duration makes the header read as
            // "picking the project up"; persisted collapse state is
            // untouched, so the rows return on drop exactly as they were.
            const collapsed = dragProjectId === p.id
              || foldOf("project", p.id, explicit !== undefined ? explicit : taskList.length === 0 && pendingForProject.length === 0);
            // Compact + collapsed: surface aggregated activity on the
            // project monogram so a collapsed project still signals that
            // something underneath wants attention (attention > done).
            const projAttention = compact && collapsed && taskList.some(w => needsAttention(w.id));
            const projDone = compact && collapsed && !projAttention && taskList.some(w => isWorkDone(w.id));
            const isMulti = (p.type ?? "single") === "multi";
            const hasRows = taskList.length > 0 || pendingForProject.length > 0;
            const showsChevron = hasRows || !collapsed;
            const isOpen = !collapsed && hasRows;
            const trayPinned = menuOpenProjectId === p.id || filterBarOpen || filterPaused;
            const rowIndent = treeIndent(depth);
            return (
              <div
                key={p.id}
                className="relative rounded-md"
                style={compact ? undefined : {
                  "--sb-task-pad": `${treeIndent(depth + 1)}px`,
                  "--sb-member-pad": `${treeIndent(depth + 2)}px`,
                } as React.CSSProperties}
              >
                {/* The project's guide, from under its row to its last child. */}
                {!compact && isOpen && (
                  <span
                    aria-hidden
                    className="pointer-events-none absolute bottom-0 top-[var(--sidebar-row-h)] w-px bg-[var(--sidebar-guide)]"
                    style={{ left: treeGuideLeft(depth) }}
                  />
                )}
                <ContextMenuRoot>
                <ContextMenuTrigger className="contents">
                <Tip content={compact ? p.name : ""}>
                  <div
                    // data-project-id lives on the HEADER (not the
                    // wrapper) because the wrapper includes all the
                    // nested task rows — its bounding rect can
                    // be 6× the header's height, putting the midpoint
                    // far below the visible row. Hit-testing against
                    // headers means the cursor only has to traverse
                    // a single header's height to trigger a swap,
                    // matching what the user sees.
                    data-project-id={p.id}
                    // Compact mode has no drag-to-reorder (the pointer
                    // handler below bails), so a plain click handles the
                    // collapse toggle the monogram represents.
                    onClick={compact ? () => setTreeFold("project", p.id, !collapsed, compact) : (e) => {
                      // The toggle rides the click, not the pointerup, so a
                      // double-click (click, click, dblclick) toggles once.
                      if (projectClickSuppressed.current) { projectClickSuppressed.current = false; return; }
                      if (e.detail > 1) return;
                      const target = e.target as HTMLElement;
                      if (target.closest('button, input, a, [data-no-drag], [role="menu"], [role="dialog"]')) return;
                      setTreeFold("project", p.id, !collapsed, compact);
                    }}
                    // Project header is the drag handle. Pointer-down
                    // arms it (doesn't commit to "we're dragging" yet);
                    // a pointer-move past the threshold flips into
                    // dragging mode. Plain click → collapse toggle
                    // still fires because pointerup before threshold
                    // hits the click path normally.
                    onPointerDown={(e) => {
                      if (compact) return;
                      if (e.button !== 0) return;
                      const target = e.target as HTMLElement;
                      // Bail on interactive controls AND anything inside a
                      // portaled menu/dialog: those render to document.body but
                      // still bubble synthetic pointer events up the React tree
                      // to this header, so grabbing the `+` menu's content
                      // would otherwise start a project drag.
                      if (target.closest('button, input, a, [data-no-drag], [role="menu"], [role="dialog"]')) return;
                      dragArmed.current = {
                        id: p.id, x: e.clientX, y: e.clientY, started: false,
                        grabOffsetY: e.clientY - (e.currentTarget as HTMLElement).getBoundingClientRect().top,
                        appliedTy: 0, pointerY: e.clientY,
                        origGroup: groupOf(p),
                        // Fold rows are ungrouped inactive projects, so a drag
                        // that STARTS there must never rewrite the group: the
                        // change would be invisible until the fold is revealed
                        // (see the fold-domain note in onDragPointerMove).
                        fromFold: !!(e.currentTarget as HTMLElement).closest("[data-inactive-fold]"),
                      };
                      // Attach document-level listeners so drag
                      // tracking survives the dragged DOM node being
                      // reparented mid-drag (React reorders kill
                      // element-level pointer capture).
                      const onUp = (ev: PointerEvent) => {
                        const armed = dragArmed.current;
                        const wasStarted = armed?.started ?? false;
                        endDrag(true);
                        // The click that follows a completed drag must not
                        // toggle the project that was just moved.
                        if (wasStarted) {
                          projectClickSuppressed.current = true;
                          setTimeout(() => { projectClickSuppressed.current = false; }, 0);
                        }
                      };
                      dragListenersRef.current = { move: onDragPointerMove, up: onUp };
                      document.addEventListener("pointermove", onDragPointerMove);
                      document.addEventListener("pointerup", onUp);
                      document.addEventListener("pointercancel", onUp);
                    }}
                    data-open={isOpen || undefined}
                    style={dragProjectId === p.id
                      ? { transform: `translateY(${dragTy}px)`, position: "relative", zIndex: 20, paddingLeft: compact ? undefined : rowIndent }
                      : compact ? undefined : { paddingLeft: rowIndent }}
                    className={cn(
                      "group flex items-center cursor-pointer",
                      compact
                        ? cn(
                          "justify-center py-[1px]",
                        )
                        : cn(
                          // An open project keeps the hover fill, so its rows read as hung from it.
                          "h-[var(--sidebar-row-h)] gap-[8px] rounded-[6px] pr-[6px] text-[13px] transition-[color,background-color] duration-[120ms] hover:bg-[var(--sidebar-row-hover)]",
                          taskList.length === 0 ? "text-[var(--sidebar-muted)]" : "text-[var(--sidebar-ink)]",
                          (isOpen || menuOpenProjectId === p.id) && "bg-[var(--sidebar-row-hover)]",
                        ),
                      dragProjectId === p.id && "bg-[var(--sidebar-drag-lift-bg)] shadow-[var(--sidebar-drag-lift-shadow)]",
                    )}
                  >
                    {compact ? (
                      // Compact mode: a project monogram tile (initials) —
                      // distinguishable at a glance, unlike a stack of
                      // identical chevrons. Dimmed when collapsed; carries
                      // an aggregated activity dot so collapsed projects
                      // still signal work underneath.
                      <div
                        data-folded={collapsed || undefined}
                        data-empty={taskList.length === 0 || undefined}
                        className="sidebar-rail-tile sidebar-rail-monogram"
                      >
                        {projectMonogram(p.name)}
                        {(projAttention || projDone) && (
                          <span
                            className="sidebar-rail-dot"
                            style={{ backgroundColor: projAttention ? "var(--color-warn)" : "var(--color-info)" }}
                          />
                        )}
                      </div>
                    ) : (
                      <>
                        {showsChevron
                          ? <TreeChevron open={!collapsed} className="shrink-0 text-[var(--sidebar-chevron)]" />
                          : <span aria-hidden className="w-[10px] shrink-0" />}
                        <FolderGlyph className="shrink-0" />
                        {renaming && renaming.kind === "proj" && renaming.id === p.id ? (
                          <input
                            ref={renameInputRef}
                            autoFocus
                            value={renaming.value}
                            onChange={e => setRenaming({ ...renaming, value: e.target.value })}
                            onBlur={commitRename}
                            onKeyDown={e => {
                              if (e.key === "Enter") commitRename();
                              else if (e.key === "Escape") setRenaming(null);
                            }}
                            onClick={e => e.stopPropagation()}
                            autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
                            className="sidebar-inline-input min-w-0 flex-1"
                          />
                        ) : (
                          <span className="min-w-0 truncate">{p.name}</span>
                        )}
                        {/* Multi-repo marker sits AFTER the name so
                            project names stay vertically aligned
                            regardless of type (no snake-indent). */}
                        {isMulti && (
                          <Tip content={t("multiRepoTip")}>
                            <Layers className="h-3 w-3 shrink-0 text-[var(--color-accent)]" />
                          </Tip>
                        )}
                        <div className="flex-1" />
                        {/* Collapsed, the row carries its task count, unless a
                            hidden task is calling for the user: then the
                            marks its hidden rows would draw take the slot. */}
                        {collapsed && taskList.length > 0 && (
                          <RollupMarks ids={taskList.map(w => w.id).join(",")} testId="project-marks" />
                        )}
                        {collapsed && taskList.length > 0 && (
                          <span data-testid={`project-count-${p.id}`} className="sidebar-rest-count shrink-0 text-[11px] tabular-nums text-[var(--sidebar-meta)]">{taskList.length}</span>
                        )}
                        {/* The hover tray: filter (GH #324), the menu and `+`
                            (docs/ui.md "One glyph per meaning"). Hover or
                            keyboard focus shows it; an open menu, an open
                            filter bar or an active filter holds it. */}
                        <div
                          data-testid={`project-tray-${p.id}`}
                          data-pinned={trayPinned || filterOn || undefined}
                          className={cn(
                            "sidebar-tray flex shrink-0 items-center gap-[2px] rounded-[5px] border border-[var(--sidebar-tray-border)] bg-[var(--sidebar-tray-bg)] p-px",
                            trayPinned || filterOn ? "opacity-100" : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100",
                          )}
                        >
                          <ProjectFilterToggle
                            projectId={p.id}
                            active={filterOn}
                            paused={filterPaused}
                            revealed={trayPinned}
                            // Open (or re-focus) the bar; an open bar with
                            // nothing filtering closes instead.
                            onToggle={() => {
                              if (filterBarOpen && !filterOn) closeFilterBar();
                              else setFilterInputs(prev => ({ ...prev, [p.id]: (prev[p.id] ?? 0) + 1 }));
                            }}
                          />
                          <Tip content={t("projectMenuTip")}>
                            <button
                              data-testid={`project-menu-${p.id}`}
                              aria-label={t("projectMenuTip")}
                              className="sidebar-tray-btn"
                              // The row's right-click menu IS the project
                              // menu; open that one at the button rather
                              // than keeping a second copy of its items.
                              onClick={(e) => {
                                e.stopPropagation();
                                const r = e.currentTarget.getBoundingClientRect();
                                e.currentTarget.dispatchEvent(new MouseEvent("contextmenu", {
                                  bubbles: true, cancelable: true, clientX: r.left, clientY: r.bottom,
                                }));
                              }}
                            ><DotsHorizontalGlyph /></button>
                          </Tip>
                          {/* Single `+` trigger → instant dropdown with the
                              two project-level actions. Replaces the two
                              separate icons (FolderGit2 + GitBranchPlus) we
                              used to show side by side — less visual noise
                              on the row, clearer affordance (the universal
                              "+" = "create / open something here"). */}
                          <DropdownRoot
                            onOpenChange={(o) => setMenuOpenProjectId(o ? p.id : null)}
                          >
                            <Tip content={t("newTaskForProjectTip")}>
                              <DropdownTrigger asChild>
                                <button
                                  onClick={e => e.stopPropagation()}
                                  // Icon-only, so there's no text for e2e to
                                  // match on. Keyed by project id because the
                                  // sidebar renders one per project.
                                  data-testid={`project-new-task-${p.id}`}
                                  aria-label={t("newTaskForProjectTip")}
                                  className="sidebar-tray-btn"
                                ><PlusGlyph size={13} /></button>
                              </DropdownTrigger>
                            </Tip>
                            {/* Don't hand focus back to the "+" on close, the
                                same decline the list-options and task-row menus
                                already make. Here it is not cosmetic: every item
                                in this menu either arms the inline quick-create
                                row or opens a dialog, and BOTH take focus of
                                their own. The row cancels on blur, so Radix
                                returning focus to this trigger after the row has
                                focused its input cancels the row the user just
                                asked for, and the whole gesture silently does
                                nothing.

                                The row hedges against that with a two-frame
                                delay ("matches the Radix dropdown close timing"),
                                but two frames is a bet on ordering, not a
                                barrier: a CI run with 125 tasks in the store lost
                                it, three whole-gesture retries in a row, leaving
                                no menu, no row and focus parked on this button
                                (projects.e2e "applies the YOLO default to a
                                quick-created agent task"). Declining the return
                                removes the race rather than out-running it. */}
                            <DropdownMenu
                              side="right"
                              align="start"
                              sideOffset={4}
                              className="sidebar-menu w-[276px]"
                              onCloseAutoFocus={(e) => e.preventDefault()}
                            >
                              <ProjectActionsMenuItems
                                projectId={p.id}
                                onPick={(cli, mode) => {
                                  // The inline name prompt only renders under an
                                  // expanded project, so expand first or the row
                                  // would be invisible on a collapsed one.
                                  setTreeFold("project", p.id, false, compact);
                                  const value = defaultTaskName(cli, taskList);
                                  setPendingRepoRoot({
                                    projectId: p.id,
                                    cli,
                                    mode,
                                    value,
                                    branch: mode === "worktree" ? derivedBranch(value, branchPrefix) : "",
                                    branchEdited: false,
                                  });
                                }}
                              />
                            </DropdownMenu>
                          </DropdownRoot>
                        </div>
                      </>
                    )}
                  </div>
                </Tip>
                </ContextMenuTrigger>
                <ContextMenuContent className="sidebar-menu">
                  <ContextMenuLabel>{p.name}</ContextMenuLabel>
                  <ContextMenuSeparator />
                  <ContextMenuItem
                    disabled={!!p.non_git}
                    onSelect={() => requestAnimationFrame(() => openNewTask(p.id))}
                  >
                    <Plus />
                    {t("ctxNewTask")}
                  </ContextMenuItem>
                  {/* Broadcast to the MAIN agent of every task in this
                      project. Count = live main agents; disabled when there is
                      nothing to fan out to (0 or 1). Computed here so it only
                      runs when the menu is actually open. */}
                  {(() => {
                    const n = taskList.filter(w => tabFacts[w.id]?.liveDefault).length;
                    return (
                      <ContextMenuItem
                        disabled={n <= 1}
                        onSelect={() => requestAnimationFrame(() => useUI.getState().openProjectBroadcast(p.id))}
                      >
                        <Megaphone />
                        {t("broadcast", { count: n })}
                      </ContextMenuItem>
                    );
                  })()}
                  {/* Stop every live task in this project without archiving
                      (GH #119) — the issue's original ask. */}
                  {(() => {
                    const live = taskList.filter(w => mountedTasks.has(w.id));
                    if (live.length === 0) return null;
                    return (
                      <ContextMenuItem
                        onSelect={() => {
                          const st = useApp.getState();
                          for (const w of live) st.stopTask(w.id);
                          useUI.getState().pushToast(
                            live.length === 1 ? t("stoppedOne", { name: live[0].name }) : t("stoppedMany", { count: live.length }),
                            "success",
                          );
                        }}
                      >
                        <CircleStop />
                        {t("stopAll", { count: live.length })}
                      </ContextMenuItem>
                    );
                  })()}
                  <ContextMenuSeparator />
                  <ContextMenuItem onSelect={() => openSettings("repositories", p.id)}>
                    <Cog />
                    {t("ctxSettings")}
                  </ContextMenuItem>
                  {!compact && (
                    <ContextMenuItem onSelect={() => {
                      setTreeFold("project", p.id, false, compact);
                      setRenaming({ kind: "proj", id: p.id, value: p.name });
                    }}>
                      <Pencil />
                      {t("rename", { ns: "common" })}
                    </ContextMenuItem>
                  )}
                  <ContextMenuSub>
                    <ContextMenuSubTrigger>
                      <Folder />
                      {t("moveToGroup")}
                    </ContextMenuSubTrigger>
                    <ContextMenuSubContent className="sidebar-menu">
                      {allGroups.map(g => (
                        <ContextMenuItem
                          key={g}
                          onSelect={() => { if (g !== groupOf(p)) moveToGroup(p, g); }}
                        >
                          {groupOf(p) === g
                            ? <Check className="text-[var(--color-accent)]" />
                            : <span className="h-3.5 w-3.5 shrink-0" />}
                          <span className="truncate">{g}</span>
                        </ContextMenuItem>
                      ))}
                      {allGroups.length > 0 && <ContextMenuSeparator />}
                      <ContextMenuItem onSelect={() => createGroupWith(p)}>
                        <FolderPlus />
                        {t("newGroup")}
                      </ContextMenuItem>
                      {!!groupOf(p) && (
                        <ContextMenuItem onSelect={() => moveToGroup(p, null)}>
                          <FolderMinus />
                          {t("removeFromGroup")}
                        </ContextMenuItem>
                      )}
                    </ContextMenuSubContent>
                  </ContextMenuSub>
                  {isMulti && (
                    <ContextMenuItem onSelect={async () => {
                      await projectUpdate({ ...p, spotlight_enabled: !p.spotlight_enabled });
                      await loadAll();
                    }}>
                      <Radio />
                      {p.spotlight_enabled ? t("spotlightDisable") : t("spotlightEnable")}
                    </ContextMenuItem>
                  )}
                  <ContextMenuItem onSelect={() => openPath(p.root_path).catch(() => {})}>
                    <FolderOpen />
                    {t("revealInFinder", { manager: FILE_MANAGER })}
                  </ContextMenuItem>
                  <ContextMenuItem onSelect={() => copyToClipboard(p.root_path, "path")}>
                    <Copy />
                    {t("copyPath")}
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem destructive onSelect={async () => {
                    const ui = useUI.getState();
                    const ok = await ui.askConfirm({
                      title: t("removeProjectTitle", { name: p.name }),
                      message: t("removeProjectMessage"),
                      confirmLabel: t("remove", { ns: "common" }),
                      destructive: true,
                    });
                    const confirmed = typeof ok === "boolean" ? ok : ok.confirmed;
                    if (!confirmed) return;
                    ui.setBusy(t("removingBusy", { name: p.name }));
                    try {
                      await projectRemove(p.id);
                      await loadAll();
                    } finally {
                      ui.setBusy(null);
                    }
                  }}>
                    <Trash2 />
                    {t("removeProject")}
                  </ContextMenuItem>
                </ContextMenuContent>
                </ContextMenuRoot>
                {/* The filter bar's own line (GH #324), under the header and
                    above the rows it filters. Shown collapsed or not: the
                    first filter to go on expands the project. */}
                {filterBarOpen && (
                  <ProjectFilterBar
                    projectId={p.id}
                    notifCount={notifCount}
                    focusKey={filterInputs[p.id] ?? 0}
                    onClose={closeFilterBar}
                    onActivate={() => { if (collapsed) setTreeFold("project", p.id, false, compact); }}
                  />
                )}

                {/* Empty expanded project — single placeholder CTA that
                    opens the SAME dropdown as the row's `+` icon (one
                    "Open repo with <agent>" per registered agent plus a
                    New worktree action). One affordance instead of two
                    cramped side-by-side buttons that had to ellipsis at
                    narrow widths. */}
                {!collapsed && taskList.length === 0 && !compact && pendingRepoRoot?.projectId !== p.id && pendingForProject.length === 0 && (
                  <div
                    className="mb-[4px] ml-[var(--sb-task-pad)] mr-[8px] mt-[2px]"
                    onClick={e => e.stopPropagation()}
                  >
                    <DropdownRoot>
                      <DropdownTrigger asChild>
                        <button
                          data-testid={`project-empty-new-task-${p.id}`}
                          className="flex h-[var(--sidebar-row-h)] w-full items-center justify-center gap-[6px] rounded-[6px] border border-[var(--sidebar-newtask-border)] bg-[var(--sidebar-newtask-bg)] px-2 text-[13px] text-[var(--sidebar-newtask-ink)] transition-[color,background-color] duration-[120ms] hover:bg-[var(--sidebar-row-hover)] hover:text-[var(--sidebar-btn-hover-ink)] data-[state=open]:bg-[var(--sidebar-row-hover)] data-[state=open]:text-[var(--sidebar-btn-hover-ink)]"
                        >
                          <PlusGlyph size={12} className="shrink-0" />
                          <span>{t("ctxNewTask")}</span>
                        </button>
                      </DropdownTrigger>
                      <DropdownMenu side="right" align="start" sideOffset={4} className="sidebar-menu w-[276px]">
                        <ProjectActionsMenuItems
                                projectId={p.id}
                                onPick={(cli, mode) => {
                                  // The inline name prompt only renders under an
                                  // expanded project, so expand first or the row
                                  // would be invisible on a collapsed one.
                                  setTreeFold("project", p.id, false, compact);
                                  const value = defaultTaskName(cli, taskList);
                                  setPendingRepoRoot({
                                    projectId: p.id,
                                    cli,
                                    mode,
                                    value,
                                    branch: mode === "worktree" ? derivedBranch(value, branchPrefix) : "",
                                    branchEdited: false,
                                  });
                                }}
                              />
                      </DropdownMenu>
                    </DropdownRoot>
                  </div>
                )}

                {/* Store order IS display order. Rust sorts the task list by
                    manual `order` then `created` (so a project nobody has
                    dragged still reads oldest-first, and new tasks append at
                    the bottom), and a live drag splices the same array — an
                    extra sort here would fight the drag. */}
                {!collapsed && layoutTaskList(visibleTasks, groupFor).map(seg => {
                  const row = (w: Task) => (
                    <TaskRowSlot
                      key={w.id}
                      w={w}
                      compact={compact}
                      dragging={dragTaskId === w.id}
                      // Only the dragged row reads it; a shared value would
                      // re-render every memoized row on every pointermove.
                      dragTy={dragTaskId === w.id ? dragTaskTy : 0}
                      onDragPointerDown={onTaskDragPointerDownStable}
                      clickSuppressed={taskClickSuppressed}
                    />
                  );
                  // Task groups (src/lib/taskGroups.ts): a drawn group is one
                  // contiguous block at its first member's position.
                  if (seg.kind === "task") return row(seg.task);
                  // Collapse is ignored on the icon rail, which has no caption
                  // to expand it from. A collapsed group still shows the row
                  // of the task you are on, whatever route got you there.
                  // A filter shows its matches even inside a collapsed group:
                  // otherwise searching for a task that sits in one would
                  // leave the match hidden behind the caption. (The layout
                  // already runs over the FILTERED rows, so a group with no
                  // matches is not drawn at all.) The sidebar query does it
                  // the way it opens projects, through foldOf: the group
                  // draws open unless folded during this query.
                  //
                  // Two facts, kept apart: `groupCollapsed` is the fold the
                  // chevron shows and toggles (stored, or the query's);
                  // `rowsHidden` is whether this render hides members. For
                  // the per-project filter they differ. Folding the filter into
                  // the first made the chevron point "expanded" while filtering,
                  // so a click collapsed the group invisibly and it snapped shut
                  // the moment the filter cleared, looking like lost tasks.
                  const groupCollapsed = !compact && foldOf("taskGroup", seg.group.id, !!collapsedTaskGroups[seg.group.id]);
                  const rowsHidden = groupCollapsed && !filterOn;
                  // (And the row being dragged: it must not vanish from under
                  // the cursor while it hovers a collapsed group.)
                  const shown = rowsHidden
                    ? seg.tasks.filter(t => t.id === activeTask || t.id === dragTaskId)
                    : seg.tasks;
                  return (
                    <TaskGroupBlock
                      key={`group:${seg.group.id}`}
                      group={seg.group}
                      projectId={p.id}
                      label={groupLabel(seg.group, tasks, t)}
                      compact={compact}
                      count={seg.tasks.length}
                      memberIds={seg.tasks.map(t => t.id)}
                      collapsed={groupCollapsed}
                      summarized={rowsHidden}
                      onToggleCollapsed={() => {
                        if (blockClickSuppressed.current) { blockClickSuppressed.current = false; return; }
                        const id = seg.group.id;
                        setTreeFold("taskGroup", id, !foldOf("taskGroup", id, !!useApp.getState().collapsedTaskGroups[id]), compact);
                      }}
                      dragging={dragBlockId === seg.group.id && blockDragArmed.current?.projectId === p.id}
                      dragTy={dragBlockTy}
                      onDragPointerDown={onBlockDragPointerDown}
                    >
                      {shown.map(row)}
                    </TaskGroupBlock>
                  );
                })}
                {!collapsed && noMatches && (
                  <div
                    data-testid={`project-filter-empty-${p.id}`}
                    className="mt-[2px] flex h-[var(--sidebar-task-row-h)] items-center justify-center gap-[6px] pl-[var(--sb-task-pad,42px)] pr-[8px] text-[13px] text-[var(--sidebar-faint)]"
                  >
                    <span className="truncate">{t("taskFilter.noMatches")}</span>
                    <button
                      className="sidebar-text-btn"
                      onClick={() => {
                        // The project's own filter is the nearer cause when
                        // both are on; clear that first.
                        if (!filterOn) { setSidebarQuery(""); return; }
                        setTaskFilterText(p.id, "");
                        if (filter?.bell) toggleTaskFilterBell(p.id);
                        closeFilterBar();
                      }}
                    >{t("taskFilter.clear")}</button>
                  </div>
                )}
                {/* Tasks mid-creation (GH #242) — a real Task doesn't exist
                    yet, so these come from pendingTaskList, not taskList.
                    Rendered after the real rows, compact mode excluded (same
                    as TaskRow's own compact branch: no room for a labeled
                    row on the icon rail). */}
                {!collapsed && !compact && pendingForProject.map(t => (
                  <PendingTaskRow key={t.id} pending={t} />
                ))}
                {/* Inline name prompt renders at the BOTTOM — that's
                    where a newly-created repo-root task lands in
                    the sort order, so the row physically appears in
                    the spot it'll occupy after Enter. */}
                {!collapsed && pendingRepoRoot?.projectId === p.id && (
                  <PendingRepoRootRow
                    mode={pendingRepoRoot.mode}
                    cli={pendingRepoRoot.cli}
                    value={pendingRepoRoot.value}
                    branch={pendingRepoRoot.branch}
                    onChange={(v) => setPendingRepoRoot(prev => {
                      if (!prev) return prev;
                      // Keep the branch in lock-step with the name until the
                      // user takes over the branch field.
                      const branch = prev.branchEdited ? prev.branch : derivedBranch(v, branchPrefix);
                      return { ...prev, value: v, branch };
                    })}
                    onBranchChange={(b) => setPendingRepoRoot(prev => prev && { ...prev, branch: b, branchEdited: true })}
                    onCancel={() => setPendingRepoRoot(null)}
                    onCommit={async () => {
                      if (inlineCreatingRef.current) return; // double-Enter guard
                      const pr = pendingRepoRoot;
                      const name = pr.value.trim();
                      // Empty name: keep the row open (don't silently cancel);
                      // the user can type or press Esc.
                      if (!name) return;
                      const ui = useUI.getState();
                      inlineCreatingRef.current = true;
                      if (pr.mode === "worktree") {
                        // Same non-blocking shape as NewTaskDialog (GH #242):
                        // pre-generate the id, subscribe to its progress
                        // channel, register the pending row, THEN close the
                        // inline row and fire the create in the background —
                        // no modal, no locked window while worktree add +
                        // copy runs.
                        const id = crypto.randomUUID();
                        const uOut = await listen<{ line: string }>(`setup-output://${id}`, ev => {
                          usePendingTasks.getState().appendLine(id, ev.payload.line);
                        });
                        usePendingTasks.getState().add({
                          id, projectId: pr.projectId, name, cli: pr.cli,
                        });
                        setActive(id);
                        setPendingRepoRoot(null);
                        try {
                          await createQuickTask({
                            id, projectId: pr.projectId, mode: "worktree", cli: pr.cli,
                            name, branch: pr.branch.trim(),
                          });
                          usePendingTasks.getState().remove(id);
                        } catch (err) {
                          usePendingTasks.getState().fail(id, String(err));
                        } finally {
                          uOut();
                          inlineCreatingRef.current = false;
                        }
                      } else {
                        // Main checkout is instant. On failure, toast and KEEP the
                        // row open so the user can fix the name and retry.
                        try {
                          await createQuickTask({ projectId: pr.projectId, mode: "repo_root", cli: pr.cli, name });
                          setPendingRepoRoot(null);
                        } catch (err) {
                          ui.pushToast(String(err), "error");
                        } finally {
                          inlineCreatingRef.current = false;
                        }
                      }
                    }}
                  />
                )}
              </div>
            );
          };
          // Collapsible group folder wrapping its member projects. Groups
          // are pure UI (a label on Project) — this renders the header +
          // indented members, with collapse state keyed by group NAME.
          const renderGroup = (name: string, members: typeof projects) => {
            // Object.hasOwn: the record round-trips through JSON.parse, so a
            // group named "toString"/"constructor" would otherwise read an
            // inherited function off the prototype and render collapsed.
            const collapsed = foldOf("folder", name, Object.hasOwn(collapsedGroups, name) && collapsedGroups[name] === true);
            const toggleGroup = () => setTreeFold("folder", name, !collapsed, compact);
            // Count ALL members (hidden inactive ones included) — the header
            // count is also what Rename/Ungroup operate on, so it must not
            // understate the group while "Hide inactive projects" is on.
            const totalCount = projects.filter(x => groupOf(x) === name).length;
            // Aggregated activity for a collapsed folder, so hidden members
            // can still call for the user. The rail has room for one corner
            // dot (attention > done), the signal the compact project
            // monogram carries; the full header carries the marks.
            const memberIds = new Set(members.map(m => m.id));
            const grpWs = collapsed
              ? tasks.filter(w => memberIds.has(w.project_id) && !w.archived)
              : [];
            const grpAttention = compact && collapsed && grpWs.some(w => needsAttention(w.id));
            const grpDone = compact && collapsed && !grpAttention && grpWs.some(w => isWorkDone(w.id));
            // User-assigned accent (Object.hasOwn: JSON-parsed record, see
            // `collapsed` above). Unknown keys resolve to undefined = default.
            const accent = groupColorCss(
              Object.hasOwn(groupColors, name) ? groupColors[name] : undefined,
            );
            if (compact) {
              // Compact rail: a chevron-only divider row (no room for a
              // label — the tooltip carries name + count). Members render
              // as regular monogram tiles below, hidden when collapsed.
              return (
                <div key={`group:${name}`}>
                  <Tip content={`${name} (${totalCount})`}>
                    <button
                      type="button"
                      aria-expanded={!collapsed}
                      onClick={() => setTreeFold("folder", name, !collapsed, compact)}
                      // Inline color deliberately beats the hover class — a
                      // colored folder stays its color under the cursor.
                      style={accent ? { color: accent } : undefined}
                      className="sidebar-rail-tile h-[22px] text-[var(--sidebar-chevron)]"
                    >
                      <TreeChevron open={!collapsed} />
                      {(grpAttention || grpDone) && (
                        <span
                          className="sidebar-rail-dot"
                          style={{ backgroundColor: grpAttention ? "var(--color-warn)" : "var(--color-info)" }}
                        />
                      )}
                    </button>
                  </Tip>
                  {!collapsed && members.map(member => renderProject(member, 1))}
                </div>
              );
            }
            const isGroupRenaming = renaming?.kind === "group" && renaming.id === name;
            return (
              <div
                key={`group:${name}`}
                data-group-section={name}
                style={dragGroupName === name ? { transform: `translateY(${dragGroupTy}px)`, position: "relative", zIndex: 20 } : undefined}
              >
                <ContextMenuRoot>
                  <ContextMenuTrigger className="contents">
                    <div
                      data-group-name={name}
                      role="button"
                      tabIndex={0}
                      aria-expanded={!collapsed}
                      // The rename input's blur (→ commitRename → renaming
                      // cleared) fires between pointerdown and click, so a
                      // click that merely dismisses the input would ALSO
                      // toggle collapse if we checked state in onClick.
                      // Capture "was renaming" at pointerdown instead.
                      // The header doubles as the folder's DRAG HANDLE —
                      // same arm-on-pointerdown / start-past-threshold
                      // pattern as project rows, so a plain click still
                      // toggles collapse.
                      onPointerDown={(ev) => {
                        if (ev.button !== 0) return;
                        suppressGroupToggle.current = isGroupRenaming;
                        if (isGroupRenaming) return;
                        const target = ev.target as HTMLElement;
                        if (target.closest("button, input, a, [data-no-drag]")) return;
                        const section = (ev.currentTarget as HTMLElement).closest("[data-group-section]");
                        if (!section) return;
                        groupDragArmed.current = {
                          name, x: ev.clientX, y: ev.clientY, started: false,
                          grabOffsetY: ev.clientY - section.getBoundingClientRect().top,
                          appliedTy: 0, pointerY: ev.clientY,
                        };
                        const onUp = () => {
                          const wasStarted = groupDragArmed.current?.started ?? false;
                          endGroupDrag(true);
                          if (wasStarted) {
                            // The click that follows pointerup must not
                            // collapse the folder that was just dragged.
                            // Reset on a macrotask in case no click fires
                            // (pointerup landed off the header).
                            suppressGroupToggle.current = true;
                            setTimeout(() => { suppressGroupToggle.current = false; }, 0);
                          }
                        };
                        groupDragListenersRef.current = { move: onGroupDragPointerMove, up: onUp };
                        document.addEventListener("pointermove", onGroupDragPointerMove);
                        document.addEventListener("pointerup", onUp);
                        document.addEventListener("pointercancel", onUp);
                      }}
                      onClick={(ev) => {
                        if (suppressGroupToggle.current) { suppressGroupToggle.current = false; return; }
                        if (ev.detail > 1) return;
                        toggleGroup();
                      }}
                      onKeyDown={(ev) => {
                        if (ev.key === "Enter" || ev.key === " ") {
                          ev.preventDefault();
                          toggleGroup();
                        }
                      }}
                      // Accent yields to the drag/drop states below — their
                      // classes lose to an inline style, so skip it while
                      // this header is a drop target or being dragged.
                      className={cn(
                        // The name is always the group ink; the folder glyph
                        // carries the folder's colour (its picked accent, or
                        // the plain icon grey, the Default swatch).
                        "flex h-[var(--sidebar-row-h)] cursor-pointer items-center gap-[8px] rounded-[6px] px-[6px] text-[13px] font-semibold text-[var(--sidebar-ink-group)] transition-[color,background-color] duration-[120ms] hover:bg-[var(--sidebar-row-hover)]",
                        // Drop target while a project drag hovers this header.
                        dragOverGroup === name && "bg-[var(--sidebar-row-hover)] shadow-[inset_0_0_0_1px_var(--sidebar-drop-ring)]",
                        // The folder itself is being dragged.
                        dragGroupName === name && "bg-[var(--sidebar-drag-lift-bg)] shadow-[var(--sidebar-drag-lift-shadow)]",
                      )}
                    >
                      <TreeChevron open={!collapsed} className="shrink-0 text-[var(--sidebar-chevron)]" />
                      <TintedFolderGlyph size={15} color={accent ?? "var(--sidebar-icon)"} className="shrink-0" />
                      {renaming?.kind === "group" && renaming.id === name ? (
                        <input
                          ref={renameInputRef}
                          autoFocus
                          value={renaming.value}
                          // Edited in the sentence case it is shown in;
                          // commitRename uppercases it for the data layer,
                          // which keys collapse and colour state by it.
                          onChange={e => setRenaming({ ...renaming, value: e.target.value })}
                          onBlur={commitRename}
                          onKeyDown={e => {
                            if (e.key === "Enter") commitRename();
                            else if (e.key === "Escape") setRenaming(null);
                            // Don't leak Enter/Space to the header's own
                            // keydown toggle.
                            e.stopPropagation();
                          }}
                          onClick={e => e.stopPropagation()}
                          onPointerDown={e => e.stopPropagation()}
                          autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
                          className="sidebar-inline-input min-w-0 flex-1 font-normal"
                        />
                      ) : (
                        <span className="min-w-0 truncate">{groupDisplayName(name)}</span>
                      )}
                      <div className="flex-1" />
                      {/* One of each mark its hidden rows would draw, the
                          collapsed project's own rule. It used to be one dot
                          (attention, else done), which said nothing about an
                          agent still working in there. */}
                      {collapsed && grpWs.length > 0 && (
                        <RollupMarks ids={grpWs.map(w => w.id).join(",")} testId="folder-marks" />
                      )}
                      {!isGroupRenaming && (
                        <span data-testid="group-count" className="sidebar-badge">{totalCount}</span>
                      )}
                    </div>
                  </ContextMenuTrigger>
                  <ContextMenuContent className="sidebar-menu">
                    <GroupActionsMenuItems
                      name={name}
                      accent={accent}
                      onSetColor={key => setGroupColor(name, key)}
                      onUngroup={() => dissolveGroup(name)}
                      onRename={() => setRenaming({ kind: "group", id: name, value: groupDisplayName(name) })}
                    />
                  </ContextMenuContent>
                </ContextMenuRoot>
                {/* Indented members with a tree guide line — reads as
                    "inside the folder" without stealing much width. */}
                {!collapsed && (
                  <div className="relative flex flex-col">
                    <span
                      aria-hidden
                      className="pointer-events-none absolute bottom-0 top-0 w-px bg-[var(--sidebar-guide)]"
                      style={{ left: treeGuideLeft(0) }}
                    />
                    {members.map(member => renderProject(member, 1))}
                  </div>
                )}
              </div>
            );
          };
          // Section the inline-shown projects (shownInline: active, plus ANY
          // grouped project since folders never fold). Ungrouped active
          // projects render in place; a group renders as one folder at its
          // FIRST member's position with all its members. Only ungrouped
          // inactive projects drop to the flat fold below. Keyboard nav
          // (useShortcuts) walks the same visualProjectOrder.
          const sections = projectSections(activeProjects);
          return (
            <>
              {/* Active projects render in place (original order). */}
              {sections.map(s => s.kind === "loose" ? renderProject(s.p, 0) : renderGroup(s.name, s.members))}
              {/* The Inactive fold's row, under a rule at the foot of the
                  tree. Clicking it toggles the fold; the inactive projects
                  render BELOW it so revealing never reshuffles the active
                  rows. */}
              {!queryOn && hideInactiveProjects && inactiveCount > 0 && (
                <button
                  key="inactive-header"
                  type="button"
                  data-testid="sidebar-inactive-header"
                  aria-expanded={showInactive}
                  onClick={() => setShowInactive(v => !v)}
                  title={compact ? t(inactiveCount === 1 ? "inactiveTipOne" : "inactiveTipMany", { count: inactiveCount }) : undefined}
                  className={cn(
                    "flex items-center",
                    compact
                      ? "sidebar-rail-tile mt-[4px] h-auto flex-col gap-[2px] border-t border-[var(--sidebar-divider)] py-[4px] text-[11px] text-[var(--sidebar-muted)]"
                      : "mt-[6px] h-[var(--sidebar-row-h)] gap-[8px] rounded-[6px] border-t border-[var(--sidebar-divider)] px-[6px] text-[13px] text-[var(--sidebar-muted)] transition-[color,background-color] duration-[120ms] hover:bg-[var(--sidebar-row-hover)]",
                  )}
                >
                  {compact ? (
                    <>
                      <DashedFolderGlyph size={15} className="shrink-0 text-[var(--sidebar-faint)]" />
                      <span className="tabular-nums">{inactiveCount}</span>
                    </>
                  ) : (
                    <>
                      <TreeChevron open={showInactive} className="shrink-0 text-[var(--sidebar-chevron)]" />
                      <DashedFolderGlyph size={15} className="shrink-0 text-[var(--sidebar-faint)]" />
                      <span className="truncate">{t("inactiveHeader")}</span>
                      <div className="flex-1" />
                      <span className="sidebar-badge">{inactiveCount}</span>
                    </>
                  )}
                </button>
              )}
              {/* data-inactive-fold marks this as a separate drag domain:
                  rows here are ungrouped inactive projects, so drags across
                  the fold reorder only and never touch group labels. */}
              {!queryOn && hideInactiveProjects && showInactive && (
                <div data-inactive-fold className="relative flex flex-col">
                  {!compact && (
                    <span
                      aria-hidden
                      className="pointer-events-none absolute bottom-0 top-0 w-px bg-[var(--sidebar-guide)]"
                      style={{ left: treeGuideLeft(0) }}
                    />
                  )}
                  {inactiveProjects.map(inactive => renderProject(inactive, 1))}
                </div>
              )}
              {/* What the filter took away, said once at the bottom instead
                  of as a row of empty project headers. */}
              {queryOn && activeProjects.length === 0 && (
                <div
                  data-testid="sidebar-filter-empty"
                  className="flex h-[var(--sidebar-task-row-h)] items-center justify-center gap-[6px] px-[8px] text-[13px] text-[var(--sidebar-faint)]"
                >
                  <span className="truncate">{t("filterBar.noMatches")}</span>
                  <button
                    className="sidebar-text-btn"
                    onClick={() => setSidebarQuery("")}
                  >{t("filterBar.clear")}</button>
                </div>
              )}
              {/* How much of the list the filter left, and how many projects
                  it folded away. Down here rather than beside the chips: see
                  the note on the chips row. */}
              {queryOn && activeProjects.length > 0 && (
                <div className="flex flex-col gap-0.5 px-[8px] pt-[6px] text-[11.5px] tabular-nums text-[var(--sidebar-faint)]">
                  <span data-testid="sidebar-filter-count">
                    {t("filterBar.count", { shown: queryMatchIds?.size ?? 0, total: queryLiveTasks.length })}
                  </span>
                  {projects.length > activeProjects.length && (
                    <span data-testid="sidebar-filter-hidden">
                      {t("filterBar.hidden", { count: projects.length - activeProjects.length })}
                    </span>
                  )}
                </div>
              )}
            </>
          );
          })()}
        </div>
        )}
      </div>
        {/* The compact rail scrolls with no visible bar (a 10px bar is a sixth
            of a 56px rail), so the fade is what says there is more below. */}
        {compact && moreBelow && (
          <div
            aria-hidden
            data-testid="sidebar-more-below"
            className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-[var(--sidebar-bg-bottom)] to-transparent"
          />
        )}
      </div>

      {/* The bottom stack: profile strip (conditional) + footer, in ONE
          positioned container so UpdateCard can anchor to its top edge.
          Deliberately NOT `bottom-[calc(var(--bottom-bar-h)*2)]` or similar:
          the strip is conditional, so any arithmetic offset is wrong half the
          time, and it would silently drift the moment either bar changed
          height. `bottom-full` is the same answer in both states. */}
      <div className="relative">
        {/* UpdateCard floats above the bottom stack so it stays visible
            regardless of scroll position. Renders nothing in compact mode or
            when there's no pending update / unseen release. */}
        <div className="pointer-events-none absolute inset-x-0 bottom-full z-20">
          <div className="pointer-events-auto">
            <UpdateCard />
          </div>
        </div>

        {/* The profile indicator, above the footer and below the project
            list. Renders nothing until a profile exists. */}

        <SidebarFooter compact={compact} />
      </div>

      </aside>

      {/* Drag handle on the sidebar's right edge — disabled in compact mode
          (compact has a fixed 56px width that's the whole point of the mode). */}
      {!compact && (
        <ResizeHandle
          direction="x"
          label="sidebar-width"
          anchor="right"
          onDrag={(dx) => {
            // Read the CURRENTLY RENDERED width via DOM measurement, not
            // the stored preferred — when the window is narrow the clamp
            // in App.tsx caps the visual width below preferred, and
            // dragging from the preferred would feel disconnected.
            // Measuring from the actual element keeps the drag responsive.
            // The user's new value becomes the preferred (their ceiling
            // until the next manual drag).
            const cur = asideRef.current?.getBoundingClientRect().width
              ?? useApp.getState().sidebarWidth;
            const next = Math.round(Math.max(160, Math.min(800, cur + dx)));
            useApp.getState().setSidebarWidth(next);
          }}
        />
      )}
    </div>
  );
}

/** Tailwind size class for sidebar icons, beefier in compact mode where the
 *  56px column has the budget for it (and the icons need to be readable
 *  without text labels). */
/** Two-character monogram for the compact-rail project tile — just the
 *  first two letters of the name (`termic` → TE, `my-app` → MY). The
 *  tooltip still carries the full name. */
function projectMonogram(name: string): string {
  const cleaned = name.trim();
  return cleaned ? cleaned.slice(0, 2).toUpperCase() : "?";
}

// Tiny status badge reused on both the task header (aggregated, when
// collapsed) and on each tab child row.
//   done      → solid blue bullet (work finished, untouched until input)
//   attention → orange bell (agent explicitly blocked on user)
// The "working" spinner is opt-in (Settings → Notifications → Work-in-progress
// indicator) and OFF by default — it can misfire on noisy TUIs (Claude
// Code's continuous redraws, Codex's status counter). The internal
// workState=="working" is always tracked so the done detector fires on
// busy→idle transitions; this badge just surfaces it when enabled.
// `data-testid="work-badge"` + `data-work-state` are the DOM hook the e2e
// suite asserts on: this badge is what a user actually sees, so specs read it
// instead of peeking at `tab.workState` in the store.
/** Picks the row a real task gets: the normal one, or the inert "Archiving…"
 *  placeholder while its background archive runs (GH #246). A component, not
 *  a branch inside the project section's map, so the archiving subscription is
 *  per row: one archive re-renders one row, not every task in the project.
 *
 *  Memoized so a sidebar render re-renders only the rows whose props changed:
 *  every prop is a primitive, a stable ref, or the Task object, which keeps
 *  its identity until `tasks` is reloaded. A row's own tab writes reach it
 *  through its own subscription (useRowTabs), not through here. */
const TaskRowSlot = memo(function TaskRowSlot(props: React.ComponentProps<typeof TaskRow>) {
  const archiving = useIsArchiving(props.w.id);
  if (archiving) return <ArchivingTaskRow w={props.w} compact={props.compact} />;
  return <TaskRow {...props} />;
});

/** A task with an archive in flight (GH #246). The Task is still in the store
 *  (it only leaves on the post-archive loadAll), but its worktree is being
 *  torn down and its agents killed, so the row is inert: no click, no menu,
 *  no tab children, nothing to drag. It reads as "on its way out" rather than
 *  disappearing the moment the user confirms, which would leave a multi-second
 *  gap where the archive silently might not have worked. */
function ArchivingTaskRow({ w, compact }: { w: Task; compact: boolean }) {
  const { t } = useTranslation("sidebar");
  const label = useTaskLabel(w);
  if (compact) {
    return (
      <Tip content={t("archivingTask", { name: label })} side="right">
        <div
          data-sidebar-task-id={w.id}
          data-task-archiving="true"
          className="sidebar-rail-tile text-[var(--sidebar-faint)] opacity-60"
        >
          <Spinner size={14} />
        </div>
      </Tip>
    );
  }
  return (
    <div className="mb-px" data-sidebar-task-row={w.id}>
      <div
        data-sidebar-task-id={w.id}
        data-sidebar-task-project-id={w.project_id}
        data-task-archiving="true"
        className="mt-[2px] flex h-[var(--sidebar-task-row-h)] items-center gap-[8px] rounded-[6px] pl-[var(--sb-task-pad,42px)] pr-[8px] text-[13px] select-none text-[var(--sidebar-faint)] opacity-70"
      >
        <span className="w-[10px] shrink-0" />
        <ChecklistGlyph size={15} className="shrink-0" />
        <div className="flex min-w-0 flex-1 items-center gap-[6px]">
          <span className="min-w-0 truncate font-medium line-through">{label}</span>
        </div>
        <Tip content={t("archiving")}>
          <span
            data-testid="archiving-badge"
            aria-label={t("archivingAria")}
            className="relative flex h-[20px] w-[20px] shrink-0 items-center justify-center text-[var(--sidebar-faint)]"
          >
            <Spinner size={12} />
          </span>
        </Tip>
      </div>
    </div>
  );
}

/** Sidebar row for a task still being created (GH #242). No real Task
 *  exists yet — clicking it just activates the pending id, which MainArea
 *  resolves to CreatingTaskPane (see usePendingTask there). No tabs, no
 *  chevron, no menu: there's nothing to expand or act on until the worktree
 *  is ready and the real TaskRow takes over (same id, so the click target
 *  doesn't move under the user). */
function PendingTaskRow({ pending }: { pending: import("@/store/pendingTasks").PendingTask }) {
  const { t } = useTranslation("sidebar");
  const activeTaskId = useApp(s => s.activeTaskId);
  const setActive = useApp(s => s.setActiveTask);
  const isActive = activeTaskId === pending.id;
  const isError = pending.phase === "error";
  return (
    <div className="mb-px" data-sidebar-task-row={pending.id}>
      <div
        data-sidebar-task-id={pending.id}
        data-sidebar-task-project-id={pending.projectId}
        data-pending-task-phase={pending.phase}
        onClick={() => setActive(pending.id)}
        className={cn(
          "mt-[2px] flex h-[var(--sidebar-task-row-h)] items-center gap-[8px] rounded-[6px] pl-[var(--sb-task-pad,42px)] pr-[8px] text-[13px] cursor-pointer select-none transition-[color,background-color] duration-[120ms]",
          isActive
            ? "sidebar-selected text-[var(--sidebar-sel-ink)]"
            : "text-[var(--sidebar-muted)] hover:bg-[var(--sidebar-row-hover)]",
        )}
      >
        <span className="w-[10px] shrink-0" />
        <ChecklistGlyph size={15} className={cn("shrink-0", isActive ? "text-[var(--sidebar-sel-icon)]" : "text-[var(--sidebar-icon)]")} />
        <div className="flex min-w-0 flex-1 items-center gap-[6px]">
          <span className="min-w-0 truncate font-medium">{pending.name}</span>
        </div>
        <Tip content={isError ? (pending.err ?? t("creationFailed")) : t("creatingWorktree")}>
          <span className="relative flex h-[20px] w-[20px] shrink-0 items-center justify-center">
            {isError ? <TaskWorkBadge reason="attention" /> : <TaskWorkBadge reason="working" />}
          </span>
        </Tip>
      </div>
    </div>
  );
}

/** The two controls a run tab carries in the sidebar tree (GH #54): a red Stop
 *  while its PTY is up, a quiet Play once it is not. `ptyId`, which
 *  TerminalPane clears on process exit, is what "running" means here and in
 *  the tab pill alike.
 *
 *  One component, two places: the run tab's own child row, and the task header
 *  row while it is COLLAPSED, where that child row is not rendered and a live
 *  run would otherwise be invisible (and unstoppable) from anywhere but the
 *  task that owns it. Only ever ONE of the two is on screen for a given tab,
 *  so the testids stay unique.
 *
 *  Actions come from `useApp.getState()` inside the handlers rather than
 *  subscriptions: this renders once per run row, and a store action's identity
 *  never changes anyway. `isMounted` is a prop because the caller already
 *  subscribes to it. */
function RunTabControl({ taskId, tab, title, isMounted }: {
  taskId: string;
  tab: TerminalTab;
  title: string;
  isMounted: boolean;
}) {
  if (tab.ptyId) {
    return (
      // An instant Tip, not a native `title`: on the collapsed header the
      // button is the ONLY thing naming the process it kills, and a tooltip
      // that arrives a second later is no use to a cursor already on its way
      // to the click. `delay` defaults to 0, hence no wait.
      //
      // The tab's name and nothing else. A verb in front reads "Run Run" on
      // the tab that is actually called Run, and the icon (red square vs
      // triangle) already says which of the two this is.
      <Tip content={title} side="right">
        <button
          data-no-drag
          data-testid={`sidebar-run-stop-${tab.id}`}
          onClick={(e) => {
            e.stopPropagation();
            const ptyId = tab.ptyId;
            if (ptyId) ptyKill(ptyId).catch(() => {});
          }}
          className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[4px] text-[var(--color-err)] transition-[color,background-color] duration-[120ms] hover:bg-[var(--sidebar-tray-hover)]"
        >
          <Square className="h-2.5 w-2.5" fill="currentColor" />
        </button>
      </Tip>
    );
  }
  return (
    <Tip content={title} side="right">
    <button
      data-no-drag
      data-testid={`sidebar-run-play-${tab.id}`}
      onClick={(e) => {
        e.stopPropagation();
        // RunPane owns the restart and only exists under a mounted TaskView,
        // so bring the task up first and put the run tab in front, exactly as
        // clicking the row would. Fronting the tab is also what makes this
        // safe from the COLLAPSED header: the run the user just started is on
        // screen, not hidden behind a chevron they never opened.
        const wasMounted = isMounted;
        const app = useApp.getState();
        app.setActiveTask(taskId);
        app.setActiveTabId(taskId, tab.id);
        // An already-mounted task needs the event: its RunPane is sitting on a
        // finished run and only a remount respawns it. A task that was NOT
        // mounted spawns the run as RunPane mounts, so firing as well would
        // kill that spawn and redo it. The exception is a tab restored idle,
        // whose pane shows a play placeholder and waits for exactly this
        // event. Deferred to a macrotask so a just-mounted listener is
        // attached first, and a timer rather than rAF because rAF is frozen on
        // an occluded window (docs/gotchas.md).
        if (wasMounted || tab.runTab?.idle) {
          window.setTimeout(() => {
            window.dispatchEvent(new CustomEvent(
              "termic-run-tab-restart", { detail: { tabId: tab.id } },
            ));
          }, 0);
        }
      }}
      className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[4px] text-[var(--sidebar-icon)] transition-[color,background-color] duration-[120ms] hover:bg-[var(--sidebar-tray-hover)] hover:text-[var(--sidebar-btn-hover-ink)]"
    >
      <Play className="h-2.5 w-2.5" />
    </button>
    </Tip>
  );
}

/** How many run buttons a COLLAPSED task header will carry inline. Three fits
 *  next to a name in a narrow sidebar; past that the row reads as a toolbar,
 *  and the task expands to reach them instead. */
const COLLAPSED_RUN_BUTTON_CAP = 3;

const NO_SUBAGENT_ROWS: ReadonlySet<string> = new Set();

// ─── TaskRow ────────────────────────────────────────────────────────────
// Extracted component so each task subscribes only to its own tab state
// (isolated re-renders). Handles expand/collapse, task rename, tab rename, and
// shows all terminal tabs as indented children.

function TaskRow({ w, compact, dragging = false, dragTy = 0, onDragPointerDown, clickSuppressed }: {
  w: Task;
  compact: boolean;
  /** This row is the one being dragged: it follows the cursor and folds. */
  dragging?: boolean;
  dragTy?: number;
  onDragPointerDown?: (e: React.PointerEvent, w: Task) => void;
  /** Set by the drop so the click that follows pointerup doesn't also
   *  activate the task the user was only moving. Read + cleared here. */
  clickSuppressed?: React.RefObject<boolean>;
}) {
  const { t } = useTranslation("sidebar");
  // Sandbox mode names live in the chrome namespace (SandboxIcon's table).
  const { t: tChrome } = useTranslation("chrome");
  // Its own tabs, but not re-rendered for the timestamps a streaming agent
  // rewrites and no row draws (ROW_HIDDEN_TAB_FIELDS).
  const tabs = useRowTabs(w.id);
  const activeTabId = useActiveTabId(w.id);
  // a boolean out of the selector, so flipping the pref re-renders only the
  // rows whose glyph comes or goes
  const showLocation = usePrefs(s => taskLocationIconShown(s.taskLocationIcon, w.is_main_checkout));
  const prBadgeMode = usePrefs(s => s.taskPrBadge);
  const activeTaskId = useApp(s => s.activeTaskId);
  const setActive = useApp(s => s.setActiveTask);
  const setActiveTabId = useApp(s => s.setActiveTabId);
  const loadAll = useApp(s => s.loadAll);
  const taskProjectType = useApp(s => s.projects.find(p => p.id === w.project_id)?.type ?? "single");
  const terminalTabCount = useApp(s => (s.tabs[w.id] ?? []).filter(t => t.type === "terminal").length);
  const agents = useApp(s => s.agents);
  const expandMode = usePrefs(s => s.taskExpandMode);
  // Default collapsed state varies with the user's chosen expand mode.
  // The user can still override per-row via the chevron — once they
  // explicitly toggle, `collapsedTasks[w.id]` holds and the mode
  // default is ignored for that task.
  //   chevron → start collapsed; row click never toggles.
  //   click   → legacy behavior: collapsed when ≤1 tab, auto-expanded at 2+.
  //   always  → start expanded; chevron-collapsed sticks.
  const defaultCollapsed =
    expandMode === "always"  ? false :
    expandMode === "chevron" ? true  :
    /* click */                terminalTabCount <= 1;
  const storeCollapsed = useApp(s => s.collapsedTasks[w.id] ?? defaultCollapsed);
  // Render-only fold while THIS row is dragged: the translateY rides on the
  // header alone, so expanded tab rows would sit frozen in place while their
  // header floats away. Persisted collapse state is untouched, so the tabs
  // come back on drop exactly as they were. Same trick as the project drag.
  const collapsed = dragging || storeCollapsed;
  const setTaskCollapsed = useApp(s => s.setTaskCollapsed);
  const setTaskYolo = useApp(s => s.setTaskYolo);
  const ensureDefaultTab = useApp(s => s.ensureDefaultTab);
  const addTab = useApp(s => s.addTab);
  const resumeClosedTab = useApp(s => s.resumeClosedTab);
  const setView = useApp(s => s.setView);
  const renameTab = useApp(s => s.renameTab);
  const clearTabCustomTitle = useApp(s => s.clearTabCustomTitle);
  const settledHighlight = usePrefs(s => s.settledHighlight);
  const workingIndicator = usePrefs(s => s.workingIndicator);
  const attentionIndicator = usePrefs(s => s.attentionIndicator);
  // Row label: the typed name, or the branch when the pref is on (GH #260).
  // The typed name is still what rename edits and what the row tooltip shows,
  // so switching the pref on never hides which task this is.
  const useBranchAsTaskName = usePrefs(s => s.useBranchAsTaskName);
  const label = taskLabel(w, useBranchAsTaskName);
  const labelIsBranch = label !== w.name;

  const project = useApp(s => s.projects.find(p => p.id === w.project_id) ?? null);
  const spotlightTaskId = useApp(s => s.spotlightTaskId[w.project_id] ?? null);
  const isSpotlighted = spotlightTaskId === w.id;
  // Spotlight is worktree-only: non-repo-root, single-repo, git, spotlight_enabled.
  const spotlightAvailable = !w.is_main_checkout && !!project?.spotlight_enabled && project?.type !== "multi" && !project?.non_git;

  const isActive = activeTaskId === w.id;
  // Live this session = mounted (its TaskView is rendered and owns PTYs).
  // Gates the Stop menu item; a never-visited or already-stopped task has
  // nothing to stop.
  const isMounted = useApp(s => s.mountedTasks.has(w.id));
  const stopTask = useApp(s => s.stopTask);
  // Sidebar only shows main-pane terminal tabs; split-pane tabs live in SplitView.
  const terminalTabs = tabs.filter((t): t is TerminalTab => t.type === "terminal" && !t.paneId);
  const collectedProps = collectTaskProps(tabs);
  const isLoaded = terminalTabs.some(t => t.ptyId);
  // The run controls the COLLAPSED header row carries, mirroring the child rows
  // that are not rendered while collapsed: one button per run tab, each with
  // the same Stop-while-live / Play-once-finished pair its own row would have
  // had. Capped at 3, because a task can hold more than one run (a multi-repo
  // task runs one per member, custom run commands add their own, and a setup
  // tab is a third kind) and a header row that fills with icons stops being a
  // name. Past the cap the task expands to reach them, which is what the tab
  // strip makes it do anyway.
  const runRowTabs = terminalTabs.filter(t => !!t.runTab);
  const collapsedRunTabs = runRowTabs.length <= COLLAPSED_RUN_BUTTON_CAP ? runRowTabs : [];
  // The sidebar renders terminal tabs and the subagents of claude tabs as
  // child rows; edit/diff tabs are transient file views with no row. When
  // the active tab is one of those (or there's no active tab), no child row
  // carries the selection, so the task HEADER must show it instead.
  const terminalTabIds = terminalTabs.map(t => t.id);
  const activeTab = tabs.find(t => t.id === activeTabId);
  const activeSubagentId = subagentIdOfTab(activeTab);
  // A boolean, so a subagent starting or finishing re-renders no task row.
  const activeSubagentHasRow = useSubagentHasRow(terminalTabIds, activeSubagentId);
  const subagentRowIds = activeSubagentHasRow && activeSubagentId !== null
    ? new Set([activeSubagentId])
    : NO_SUBAGENT_ROWS;
  const activeChildCarriesSelection = childRowCarriesSelection(activeTab, terminalTabIds, subagentRowIds);
  const selectedSubagentId = isActive && activeSubagentHasRow ? activeSubagentId : null;
  const isSelectedRow = isActive && (collapsed || !activeChildCarriesSelection);

  // Task actions menu — controlled so a right-click on the row can
  // open the same menu the kebab button triggers.
  const [menuOpen, setMenuOpen] = useState(false);
  // Task rename
  const [taskRenaming, setTaskRenaming] = useState<string | null>(null);
  const taskRenameInputRef = useRef<HTMLInputElement | null>(null);
  const clickToggledRef = useRef(false);
  // External rename trigger (⇧⌘P command palette → "Rename task"). The
  // palette can't reach into this row's local state, so it bumps a nonce on
  // the UI store; we start the inline rename when it targets us, then clear
  // it so a later collapse/expand re-mount doesn't re-fire. The palette
  // expands the row's project first, so by the time we mount this runs.
  const renameReq = useUI(s => s.renameRequest);
  useEffect(() => {
    if (renameReq && renameReq.taskId === w.id) {
      setTaskRenaming(w.name);
      useUI.setState({ renameRequest: null });
    }
  }, [renameReq?.nonce, w.id, w.name]);
  // Radix DropdownMenu closes AFTER onSelect fires and asynchronously
  // restores focus; autoFocus on the freshly-mounted input loses the race.
  // Re-focus on the next two frames to land after Radix's restore tick.
  useEffect(() => {
    if (taskRenaming === null) return;
    let cancelled = false;
    const r1 = requestAnimationFrame(() => {
      const r2 = requestAnimationFrame(() => {
        if (cancelled) return;
        const el = taskRenameInputRef.current;
        if (el && document.activeElement !== el) {
          el.focus();
          el.select();
        }
      });
      if (cancelled) cancelAnimationFrame(r2);
    });
    return () => { cancelled = true; cancelAnimationFrame(r1); };
  }, [taskRenaming !== null]);
  // Tab rename — per-tab id + draft value
  const [tabRenaming, setTabRenaming] = useState<{ id: string; value: string } | null>(null);

  // Auto-expand rules per mode:
  //   "click"  — auto-expand 1→2+ (legacy behavior).
  //   "always" — on wake (0→1+), clear any prior chevron-collapse so
  //              the mode default (expanded) wins again. Users who
  //              collapse a task and then put it to sleep
  //              shouldn't return to a still-collapsed row when they
  //              wake the agent — that contradicts "Auto open".
  //   "chevron"— never auto-expand (the whole point: predictability).
  // Auto-collapse on going to 0 stays in all modes — an empty
  // task has nothing to expand.
  const prevCountRef = useRef(terminalTabCount);
  useEffect(() => {
    const prev = prevCountRef.current;
    prevCountRef.current = terminalTabCount;
    if (expandMode === "click" && prev <= 1 && terminalTabCount >= 2) {
      setTaskCollapsed(w.id, false);
    } else if (expandMode === "always" && prev === 0 && terminalTabCount > 0) {
      setTaskCollapsed(w.id, false);
    } else if (prev > 0 && terminalTabCount === 0) {
      setTaskCollapsed(w.id, true);
    }
  }, [terminalTabCount, w.id, setTaskCollapsed, expandMode]);

  // Aggregated work status shown on the row header when collapsed.
  // Priority: attention > done. ("working" intentionally not surfaced.)
  // Shared with the dashboard (src/lib/taskWorkState.ts) so the two surfaces
  // showing one task can never disagree about its badge.
  const workPrefs = { settledHighlight, workingIndicator, attentionIndicator };
  const hasAttention = taskNeedsAttention(tabs, workPrefs);
  const hasDone = !hasAttention && taskWorkDone(tabs, workPrefs);
  // Working aggregate is independent of settledHighlight (it's its own
  // opt-in pref) but yields to attention/done — a finished or blocked agent
  // is more actionable than one still chugging.
  const hasWorking = !hasAttention && !hasDone && taskWorking(tabs, workPrefs);
  // Lowest rung: something the agent started is still running, and nothing
  // else wanted the slot. `rowDelegated` is the report itself, for the
  // tooltip; the first tab that has one speaks for the row, which matches how
  // every other aggregate here works.
  const hasDelegated = !hasAttention && !hasDone && !hasWorking
    && taskDelegated(tabs, workPrefs);
  const restBadgeShown = collapsed && (hasAttention || hasDone || hasWorking || hasDelegated);
  const trailingSlotTaken = restBadgeShown || isSelectedRow;
  const rowDelegated = (tabs.find(
    t => t.type === "terminal" && !!(t as TerminalTab).delegatedWork,
  ) as TerminalTab | undefined)?.delegatedWork;
  // Why no badge is drawn, which the work-state trace cannot answer: it records
  // DETECTION, and a correct `working` can still render nothing here. Four
  // independent ways that happens (the pref is off, attention or done outranks
  // it, or the row is expanded and delegates to per-tab badges) and they are
  // indistinguishable from the outside. Logged on CHANGE only, so this is a
  // handful of lines per session and not a per-render cost.
  const badgeInputs = `${collapsed}|${hasAttention}|${hasDone}|${hasWorking}|${workingIndicator}|${settledHighlight}`;
  useEffect(() => {
    logWorkState("row-badge", `task=${JSON.stringify(w.name)}`
      + ` drawn=${collapsed && (hasAttention || hasDone || hasWorking)}`
      + ` collapsed=${collapsed} attention=${hasAttention} done=${hasDone}`
      + ` working=${hasWorking} prefWorking=${workingIndicator}`
      + ` prefSettled=${settledHighlight}`
      + ` states=[${tabs.filter(t => t.type === "terminal").map(t => t.workState ?? "idle").join(",")}]`);
    // Deliberately keyed on the joined string: the individual flags are the
    // whole point, and re-running per render would flood the log.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [badgeInputs]);

  async function commitTaskRename() {
    if (taskRenaming === null) return;
    const trimmed = taskRenaming.trim();
    setTaskRenaming(null);
    // Empty → reset to the branch name (clears any custom label).
    const next = trimmed || w.branch;
    if (next === w.name) return;
    // Behind the create lock: task_rename's duplicate check is
    // load-then-save, and a create landing inside that window could
    // mint the twin the check refuses.
    try { await withCreateLock(async () => { await taskRename(w.id, next); await loadAll(); }); }
    // task_rename refuses duplicates within the project; without a toast
    // the input just snaps back to the old name with no explanation.
    catch (e) { useUI.getState().pushToast(String(e), "error"); }
  }

  // ─ New terminal / agent, from the row's own menu (GH #197) ─
  // People kept right-clicking the sidebar row hunting for "add another agent
  // to this task" and never found the tab strip's "+". Same menu, same rows
  // (NewTabMenuItems), one difference: picking here also ACTIVATES the task,
  // because an unmounted task has no TaskView and so nothing would spawn the
  // PTY the user just asked for. `addTab` self-focuses the new terminal, and
  // the menu's onCloseAutoFocus already declines Radix's focus-return, so the
  // focus lands in the new tab rather than snapping back to the kebab.
  //
  // ensureDefaultTab FIRST, exactly like the row-click path: on a task that
  // was never opened (or was stopped) the seed/restore is what brings its
  // persisted agent tabs back, and it bails the moment a main tab exists — so
  // adding ours first would silently cost the user their restored session.
  function spawnIntoTask(tab: Tab) {
    setActive(w.id);
    ensureDefaultTab(w.id, w.cli || "claude");
    addTab(w.id, tab);
    setMenuOpen(false);
  }

  function commitTabRename() {
    if (!tabRenaming) return;
    const trimmed = tabRenaming.value.trim();
    if (trimmed) renameTab(w.id, tabRenaming.id, trimmed);
    else clearTabCustomTitle(w.id, tabRenaming.id);
    setTabRenaming(null);
  }

  // Compact mode: render a minimal icon-only row (no tree, no children).
  if (compact) {
    const railIconId = resolveIconId(w.cli, agents);
    const railMarkIsCritter = railIconId === "claude";
    return (
      <Tip content={<CompactTaskTip name={labelIsBranch ? `${label} (${w.name})` : w.name} tabs={terminalTabs} />} side="right" align="start" pointer>
        <div
          data-rail-task-id={w.id}
          onClick={() => setActive(w.id)}
          data-selected={isActive || undefined}
          className={cn(
            "sidebar-rail-tile cursor-pointer",
            isActive && "sidebar-selected",
            !isLoaded && "opacity-60",
          )}
        >
          {railMarkIsCritter
            ? <CritterGlyph size={16} className="text-[var(--color-accent)]" />
            : <CliIcon cli={railIconId} className={cn("h-4 w-4", CLI_BRAND_COLOR[railIconId])} />}
          {/* Activity dot in the corner — the compact rail has no room
              for the full bell/check badge, so color carries meaning:
              warm = needs you, blue = work done. The ring lifts it off
              the icon regardless of the tile's background. */}
          {(hasAttention || hasDone) ? (
            <span
              className="sidebar-rail-dot"
              style={{ backgroundColor: hasAttention ? "var(--color-warn)" : "var(--color-info)" }}
            />
          ) : hasWorking ? (
            // No room for a full spinner on the rail; a faint pulsing dot
            // carries "still working" without competing with the bold
            // attention/done colors.
            <span className="sidebar-rail-dot animate-pulse bg-[var(--color-info)]" />
          ) : null}
        </div>
      </Tip>
    );
  }

  return (
    // `data-sidebar-task-row` spans the header AND every expanded tab row, so
    // an e2e spec can scope "the work badge the sidebar shows for this task"
    // with one selector regardless of collapse state. Deliberately a distinct
    // attribute from `data-sidebar-task-id` below, which the reorder drag
    // hit-tests and must stay on the header alone.
    <div className="mb-px" data-sidebar-task-row={w.id}>
      {/* Task header row. Also the drag handle and the hit-test target:
          data-sidebar-task-id lives HERE, not on the wrapper, because the wrapper
          spans every expanded tab row — its midpoint can sit far below the
          visible header, so swaps would trigger nowhere near the cursor.
          NOT `data-task-id`: MainArea already puts that on the mounted
          TaskView container, and every visited task stays mounted. */}
      <div
        data-sidebar-task-id={w.id}
        data-sidebar-task-project-id={w.project_id}
        style={dragging ? { transform: `translateY(${dragTy}px)`, position: "relative", zIndex: 20 } : undefined}
        onPointerDown={onDragPointerDown ? (e) => onDragPointerDown(e, w) : undefined}
        onClick={(e) => {
          // The click that trails a drop is not a selection.
          if (clickSuppressed?.current) { clickSuppressed.current = false; return; }
          setActive(w.id);
          if (terminalTabs.length === 0) {
            // No terminals yet — wake the task through the store's
            // restore/seed path. MUST be ensureDefaultTab, not an inline
            // addTab: the durable agent tabs (persisted_tabs) are keyed by
            // tab id, so minting a fresh id here would orphan every stored
            // session and break auto-resume (it also no-ops ensureDefaultTab
            // in TaskView, which mounts after this click).
            ensureDefaultTab(w.id, w.cli || "claude");
          } else {
            if (activeTabId) setActiveTabId(w.id, activeTabId);
            // Only the "click" mode treats a row click on the already
            // active task as a collapse toggle. The other modes
            // require the explicit chevron, which removed the "random
            // expand" feel users complained about.
            // The second click of a double-click is left to onDoubleClick.
            if (e.detail <= 1) {
              const togglesOnClick = isActive && expandMode === "click";
              clickToggledRef.current = togglesOnClick;
              if (togglesOnClick) setTaskCollapsed(w.id, !collapsed);
            }
          }
        }}
        onDoubleClick={(e) => {
          const target = e.target as HTMLElement;
          if (target.closest("button, input, a, [data-no-drag]")) return;
          const hasTabs = terminalTabs.length > 0;
          const alreadyToggled = clickToggledRef.current;
          clickToggledRef.current = false;
          if (taskRenaming !== null || !hasTabs || alreadyToggled) return;
          setTaskCollapsed(w.id, !collapsed);
        }}
        // Right-click anywhere on the row opens the same actions menu as
        // the kebab button (which it anchors to).
        onContextMenu={(e) => { e.preventDefault(); setMenuOpen(true); }}
        data-selected={isSelectedRow || undefined}
        className={cn(
          // Fixed height rather than padding around a line box: the line box
          // is the system's to decide, and the rows have to stay level with
          // each other and with the empty-project placeholder. The indent is
          // the project's (--sb-task-pad, set per depth on its wrapper).
          "group/wsrow mt-[2px] flex h-[var(--sidebar-task-row-h)] items-center gap-[8px] rounded-[6px] pl-[var(--sb-task-pad,42px)] pr-[8px] text-[13px] cursor-pointer select-none transition-[color,background-color] duration-[120ms]",
          // The selected look on the header when active AND no child row
          // carries it: collapsed (children hidden) OR the active tab is an
          // edit/diff view (no row). Expanded with an active terminal tab
          // delegates the highlight to that child row instead.
          isSelectedRow
            ? "sidebar-selected text-[var(--sidebar-sel-ink)]"
            : "text-[var(--sidebar-ink)] hover:bg-[var(--sidebar-row-hover)]",
          !isLoaded && "opacity-60",
          // Lifted look while dragging, mirroring the project header.
          dragging && "bg-[var(--sidebar-drag-lift-bg)] shadow-[var(--sidebar-drag-lift-shadow)]",
        )}
      >
        {terminalTabs.length === 0
          ? <span aria-hidden className="w-[10px] shrink-0" />
          : <button
              type="button"
              aria-label={collapsed ? t("expandTask") : t("collapseTask")}
              onClick={(e) => { e.stopPropagation(); setTaskCollapsed(w.id, !collapsed); }}
              className="flex h-[20px] w-[10px] shrink-0 items-center justify-center"
              data-no-drag
            >
              <TreeChevron open={!collapsed} className={isSelectedRow ? "text-[var(--sidebar-sel-chevron)]" : "text-[var(--sidebar-chevron)]"} />
            </button>
        }
        <ChecklistGlyph size={15} className={cn("shrink-0", isSelectedRow ? "text-[var(--sidebar-sel-icon)]" : "text-[var(--sidebar-icon)]")} />

        <div className="flex min-w-0 flex-1 items-center gap-[6px]">
          {taskRenaming !== null ? (
            <input
              ref={taskRenameInputRef}
              autoFocus
              value={taskRenaming}
              onChange={e => setTaskRenaming(e.target.value)}
              onBlur={commitTaskRename}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitTaskRename();
                else if (e.key === "Escape") setTaskRenaming(null);
                e.stopPropagation();
              }}
              onClick={e => e.stopPropagation()}
              onDoubleClick={e => e.stopPropagation()}
              autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
              className="sidebar-inline-input min-w-0 flex-1"
            />
          ) : (
            <>
              {/* Branch-labelled rows keep the typed name reachable: it is the
                  one thing the pref would otherwise hide, and it is still what
                  a rename edits. A plain `title`, not a Radix Tip: a tooltip
                  per row would add a provider each and put its own pointer
                  handlers between the row and the drag that starts on it.
                  Mono matches how a branch reads everywhere else. */}
              <TaskLabelText
                task={w}
                useBranch={useBranchAsTaskName}
                title={labelIsBranch ? t("taskNameTitle", { name: w.name }) : undefined}
                className={cn("font-medium", labelIsBranch && "font-mono text-[12px]")}
              />
              {/* Asleep: no terminal this session. After the name, so the
                  chevron column stays the fold's alone. */}
              {terminalTabs.length === 0 && (
                <Moon
                  data-testid="task-asleep-mark"
                  className={cn("ml-[2px] h-3 w-3 shrink-0 opacity-60", isSelectedRow ? "text-[var(--sidebar-sel-chevron)]" : "text-[var(--sidebar-chevron)]")}
                />
              )}
              {w.spawned_by && <SpawnedFromMark task={w} />}
              {/* The task's tab properties, collected (GH #358): after the
                  name on the LEFT, never in the trailing badge/kebab slot.
                  Gives up all its width before the name loses any; the title lists every value
                  with the tab it came from. */}
              {collectedProps.length > 0 && (
                <span
                  data-testid="task-props"
                  title={tabs
                    .filter((x): x is TerminalTab => x.type === "terminal" && !!x.props?.length)
                    .flatMap(x => x.props!.map(p => `${p.key}: ${p.value} (${x.title || x.cli})`))
                    .join("\n")}
                  className="min-w-0 shrink-[1000] truncate text-[11px] text-[var(--color-fg-dim)]"
                >{collectedText(collectedProps)}</span>
              )}
            </>
          )}
          {/* Spotlight active indicator: just the animated wave icon.
              No branch text — avoids any truncation of the task name. */}
          {!taskRenaming && isSpotlighted ? (
            <Tip content={t("spotlightTip", { branch: project?.base_branch?.replace(/^[^/]+\//, "") ?? "main" })} delay={0}>
              <AudioWaveform className="termic-spotlight-wave h-3 w-3 shrink-0 text-[var(--color-accent)]" />
            </Tip>
          ) : (
            /* Terminal count — only shown when >1. Was fg-faint which
               vanished on warm-dark surfaces; bump to fg-dim + tabular
               nums so the digit stays legible at small sizes. */
            !taskRenaming && terminalTabs.length > 1 && (
              <span className={cn("shrink-0 text-[11px] font-medium tabular-nums", isSelectedRow ? "text-[var(--sidebar-sel-meta)]" : "text-[var(--sidebar-meta)]")}>
                ({terminalTabs.length})
              </span>
            )
          )}
          {/* Collapsed rows carry each run tab's own control, inline after the
              name and count. A collapsed task hides the child rows that would
              otherwise offer them, which is precisely when a run is hardest to
              notice and to stop. NOT in the trailing slot: that column is the
              badge and the kebab, and a third icon there reads as one of them.
              Expanded rows leave it to the child rows instead of showing it
              twice. Each carries an instant tooltip naming its tab, since the
              icon alone cannot say which run of several it belongs to. */}
          {!taskRenaming && collapsed && collapsedRunTabs.map(rt => (
            <RunTabControl
              key={rt.id}
              taskId={w.id}
              tab={rt}
              title={rt.customTitle ? rt.title : (rt.liveTitle || rt.title)}
              isMounted={isMounted}
            />
          ))}
        </div>

        {/* PR/MR state, right-aligned and carrying its number so it reads
            as a link and not one more icon. Falls back to the persisted
            pr_url for tasks not visited this session. Click opens the PR. */}
        {!taskRenaming && prBadgeMode !== "none" && (
          <TaskPrBadge task={w} showNumber={prBadgeMode !== "icon"} showIcon={prBadgeMode !== "number"} />
        )}

        {/* Two trailing slots (docs/ui.md "One glyph per meaning"): mode
            (sandbox, docker, dangerous YOLO; absent when there is none), then
            ONE fixed slot that is work state at rest (the badge while
            collapsed; expanded rows put it on their children) and the task
            menu on hover. The menu used to get a slot of its own, reserved
            and empty at rest: every row paid 22px of nothing for a button
            that only exists under the pointer. The slot is always rightmost,
            so state lines up down the tree, and nothing shifts on hover. */}
        {(() => {
          const wMode = effectiveSandboxMode(w);
          const isLaunched = terminalTabs.length > 0;
          // A LIVE pty, not merely "this task has tabs": a tab outlives its
          // process, and the YOLO mark must not warn about an agent that is
          // gone. The board's badge uses the same signal.
          const hasLivePty = terminalTabs.some(t => t.ptyId);
          // Docker stores sandbox_mode as off (the cages are exclusive), so
          // it is checked first or a Docker task would show no mark.
          const mark = w.docker_sandbox_enabled
            ? <DockerSandboxIcon active={isLaunched} className="h-3.5 w-3.5" />
            : !!w.yolo && !isSandboxEnforced(wMode) && hasLivePty
              ? <Zap data-testid="task-yolo-badge" className="h-3.5 w-3.5 text-[var(--color-err)]" fill="none" />
              : wMode !== "off" ? <SandboxIcon mode={wMode} active={isLaunched} className="h-3.5 w-3.5" /> : null;
          return mark && (
            <span data-testid="task-mode-slot" className="flex h-[18px] w-[18px] shrink-0 items-center justify-center">{mark}</span>
          );
        })()}
        {/* Where the task lives, rightmost: the location glyph the
            taskLocationIcon pref picks (docs/ui.md "One glyph per meaning")
            and the branch in mono, unless the label already is the branch.
            While the slot after it is empty it runs over that slot to the
            row's edge, and it fades on hover to give the menu its place. */}
        {!taskRenaming && showLocation && (
          <span
            data-testid="task-branch-chip"
            className={cn(
              "flex min-w-0 max-w-[40%] shrink items-center gap-[4px] font-mono text-[11px] transition-opacity duration-[120ms] group-hover/wsrow:opacity-0",
              isSelectedRow ? "text-[var(--sidebar-sel-meta)]" : "text-[var(--sidebar-meta)]",
              !trailingSlotTaken && "-mr-[28px]",
              menuOpen && "opacity-0",
            )}
          >
            <TaskLocationIcon isMainCheckout={w.is_main_checkout} size="h-[11px] w-[11px]" className="text-current" />
            {!labelIsBranch && w.branch && <span className="truncate">{w.branch}</span>}
          </span>
        )}
        <span className="relative flex h-[20px] w-[20px] shrink-0 items-center justify-center">
          <DropdownRoot open={menuOpen} onOpenChange={setMenuOpen}>
            <Tip content={t("taskMenu")}>
            <DropdownTrigger asChild>
              <button
                data-no-drag
                data-testid="task-menu-trigger"
                onClick={(e) => e.stopPropagation()}
                aria-label={t("taskMenu")}
                className={cn(
                  // The project row's hover tray, holding one button: the same
                  // box, border, glyph and hover, so the two menus read alike.
                  "absolute inset-0 flex items-center justify-center rounded-[5px] border bg-[var(--sidebar-tray-bg)] transition-[color,background-color] duration-[120ms] hover:bg-[var(--sidebar-tray-hover)] hover:text-[var(--sidebar-btn-hover-ink)] data-[state=open]:bg-[var(--sidebar-tray-hover)]",
                  isSelectedRow
                    ? "border-[var(--sidebar-sel-menu-border)] text-[var(--sidebar-sel-meta)]"
                    : "border-[var(--sidebar-tray-border)] text-[var(--sidebar-icon)]",
                  // The selected row keeps its menu in view, as the design draws it.
                  menuOpen || isSelectedRow
                    ? "opacity-100"
                    : "opacity-0 group-hover/wsrow:opacity-100 pointer-events-none group-hover/wsrow:pointer-events-auto",
                  taskRenaming !== null && "pointer-events-none",
                )}
              >
                <DotsHorizontalGlyph />
              </button>
            </DropdownTrigger>
            </Tip>
            <DropdownMenu className="sidebar-menu"
              side="right"
              align="start"
              // Don't return focus to the trigger on close — the user
              // walks away from the cog after picking an item; leaving
              // the trigger highlighted with a focus ring is just noise.
              onCloseAutoFocus={(e) => e.preventDefault()}
            >
              {/* Leads the menu: "what else can I put in this task" is the
                  question people bring to a task row (GH #197). A submenu,
                  not a flat section, so the row's own actions stay one
                  glance tall. */}
              <DropdownSub>
                <DropdownSubTrigger className="justify-between">
                  <span className="flex items-center gap-2">
                    <Plus className="h-4 w-4" />
                    <span>{t("menuNew")}</span>
                  </span>
                  <ChevronRight className="h-3.5 w-3.5 text-[var(--color-fg-faint)]" />
                </DropdownSubTrigger>
                <DropdownSubContent className="sidebar-menu">
                  <NewTabMenuItems
                    taskId={w.id}
                    onSpawnCli={(cli) => spawnIntoTask({
                      id: crypto.randomUUID(),
                      type: "terminal",
                      title: agentDisplayName(cli, agents),
                      cli,
                    })}
                    onSpawnShell={() => spawnIntoTask({
                      id: crypto.randomUUID(),
                      type: "terminal",
                      title: t("terminalTabTitle"),
                      cli: "shell",
                    })}
                    onScratchpad={(scope) => {
                      // Same activate-first rule as spawnIntoTask: an
                      // unmounted task has no TaskView, so nothing would
                      // restore its other pads or render this one.
                      setActive(w.id);
                      ensureDefaultTab(w.id, w.cli || "claude");
                      if (scope === "global" || scope === "profile" || scope === "project") {
                        void openOrCreateScopedScratchTab(w.id, scope, scope === "project" ? w.project_id : undefined);
                      } else {
                        void newScratchTab(w.id);
                      }
                      setMenuOpen(false);
                    }}
                    onResume={(entryId) => {
                      setActive(w.id);
                      ensureDefaultTab(w.id, w.cli || "claude");
                      resumeClosedTab(w.id, entryId);
                      setMenuOpen(false);
                    }}
                    onMore={() => { setMenuOpen(false); setView("history", { projectId: w.project_id }); }}
                  />
                </DropdownSubContent>
              </DropdownSub>
              <DropdownSeparator />
              {spotlightAvailable && (
                <DropdownItem
                  className="items-center [&>svg]:mt-0"
                  onSelect={async () => {
                    if (isSpotlighted) {
                      try { await stopSpotlight(w.id); }
                      catch (e) { useUI.getState().pushToast(String(e), "error"); }
                    } else {
                      try {
                        await startSpotlight(w.project_id, w.id);
                        setActive(w.id);
                      } catch (e) { useUI.getState().pushToast(String(e), "error"); }
                    }
                  }}
                >
                  <AudioWaveform className={cn("h-4 w-4", isSpotlighted && "text-[var(--color-accent)]")} />
                  <span>{isSpotlighted ? t("stopSpotlight") : t("startSpotlight")}</span>
                </DropdownItem>
              )}
              <DropdownItem
                // items-center + no top-nudge: these rows are single-line
                // so the default two-line layout offsets the icon visually.
                className="items-center [&>svg]:mt-0"
                onSelect={() => useUI.getState().openSandbox(w.id)}
              >
                {w.docker_sandbox_enabled
                  ? <DockerSandboxIcon className="h-4 w-4" />
                  : <SandboxIcon mode={effectiveSandboxMode(w)} className="h-4 w-4" />}
                <span>
                  {w.docker_sandbox_enabled ? t("dockerContainer")
                    : effectiveSandboxMode(w) === "off" ? t("sandboxSettings")
                    : sandboxModeText(effectiveSandboxMode(w), tChrome).shortLabel}
                </span>
              </DropdownItem>
              {/* Per-task YOLO toggle. Disabled (auto-on) under Enforcing
                  OR Docker mode - whichever cage mechanism, it's the real
                  boundary there. Red when on without EITHER cage
                  (dangerous). */}
              <DropdownItem
                className="items-center [&>svg]:mt-0"
                disabled={isTaskCaged(w)}
                onSelect={() => {
                  if (isTaskCaged(w)) return;
                  const next = !w.yolo;
                  setTaskYolo(w.id, next);
                  void taskSetYolo(w.id, next);
                }}
              >
                <Zap
                  className={cn(
                    "h-4 w-4 text-[var(--color-fg-faint)]",
                    (!!w.yolo && !isTaskCaged(w)) && "text-[var(--color-err)]",
                    effectiveSandboxMode(w) === "enforce" && "text-[var(--color-ok)]",
                    effectiveSandboxMode(w) === "enforce-fs" && "text-[var(--color-ok)]",
                    w.docker_sandbox_enabled && "text-[var(--color-ok)]",
                  )}
                  fill="none"
                />
                <span>
                  {w.docker_sandbox_enabled
                    ? t("yoloAutoDocker")
                    : effectiveSandboxMode(w) === "enforce"
                    ? t("yoloAutoEnforce")
                    : effectiveSandboxMode(w) === "enforce-fs"
                    ? t("yoloAutoEnforceFs")
                    : w.yolo ? t("yoloOn") : t("yoloOff")}
                </span>
              </DropdownItem>
              <DropdownItem
                className="items-center [&>svg]:mt-0"
                onSelect={() => setTaskRenaming(w.name)}
              >
                <Pencil className="h-4 w-4" />
                <span>{t("rename", { ns: "common" })}</span>
              </DropdownItem>
              {/* Custom-command tasks carry an editable launch
                  script (agent / shell tasks resolve their command
                  from the registry, so there's nothing to edit). */}
              {w.cli === "custom" && (
                <DropdownItem
                  className="items-center [&>svg]:mt-0"
                  onSelect={() => useUI.getState().openEditCommand(w.id)}
                >
                  <SquareChevronRight className="h-4 w-4" />
                  <span>{t("editCommand")}</span>
                </DropdownItem>
              )}
              {/* Member composition editing is a multi-repo-only thing —
                  single-repo tasks have nothing but the name to edit,
                  which Rename above already covers. */}
              {taskProjectType === "multi" && (
                <DropdownItem
                  className="items-center [&>svg]:mt-0"
                  data-testid={`task-edit-${w.id}`}
                  onSelect={() => requestAnimationFrame(() => useUI.getState().openEditTask(w.id))}
                >
                  <Layers className="h-4 w-4" />
                  <span>{t("editTask")}</span>
                </DropdownItem>
              )}
              {/* Resume override: only for agent tasks (shell / custom
                  tabs don't resume an agent session). Lets a task
                  resume a named session instead of termic's auto-managed
                  uuid, e.g. `--resume {WORKSPACE_NAME}`. */}
              {w.cli !== "custom" && w.cli !== "shell" && (
                <DropdownItem
                  className="items-center [&>svg]:mt-0"
                  onSelect={() => useUI.getState().openResumeOverride(w.id)}
                >
                  <History className={cn("h-4 w-4", w.resume_override && "text-[var(--color-accent)]")} />
                  <span>{w.resume_override ? t("resumeOverrideOn") : t("resumeOverride")}</span>
                </DropdownItem>
              )}
              {w.branch && (
                <DropdownItem
                  className="items-center [&>svg]:mt-0"
                  onSelect={() => copyToClipboard(w.branch, `"${w.branch}"`)}
                >
                  <Copy className="h-4 w-4" />
                  <span>{t("copyBranch")}</span>
                </DropdownItem>
              )}
              {/* Paste-ready briefing that teaches ANOTHER agent to drive
                  THIS task over the CLI, so two agents can hand each other
                  work. See lib/agentBriefing for why the block steers both
                  sides off `--wait` and onto prompting each other. */}
              <DropdownItem
                className="items-center [&>svg]:mt-0"
                onSelect={() => { void copyAgentBriefing(w, project?.name); }}
              >
                <Waypoints className="h-4 w-4" />
                <span>{t("copyBriefing")}</span>
              </DropdownItem>
              {/* Schedule (GH #300): this task becomes a schedule's parent, or
                  edits the one it already is. Only for an agent that can say
                  it finished, or a run could never end. Disabled on a Docker
                  task rather than hidden, with the reason on it: its runs must
                  never quietly fall back to the host. */}
              {workDoneCapable(w.cli) && (w.schedule ? (
                <DropdownItem
                  className="items-center [&>svg]:mt-0"
                  data-testid={`task-schedule-${w.id}`}
                  onSelect={() => requestAnimationFrame(() => useUI.getState().openScheduleDialog({ parentTaskId: w.id, edit: true }))}
                >
                  <CalendarClock className="h-4 w-4" />
                  <span>{t("editSchedule")}</span>
                </DropdownItem>
              ) : (
                <DropdownItem
                  className="items-center [&>svg]:mt-0"
                  data-testid={`task-schedule-${w.id}`}
                  disabled={!!w.docker_sandbox_enabled}
                  onSelect={() => requestAnimationFrame(() => useUI.getState().openScheduleDialog({ parentTaskId: w.id }))}
                >
                  <CalendarClock className="h-4 w-4" />
                  <span className="flex flex-col">
                    <span>{t("scheduleTask")}</span>
                    {w.docker_sandbox_enabled && (
                      <span className="text-[11px] text-[var(--color-fg-faint)]" data-testid={`task-schedule-docker-${w.id}`}>
                        {t("scheduleDocker")}
                      </span>
                    )}
                  </span>
                </DropdownItem>
              ))}
              {/* Move to group: the project row's menu, for tasks. The group
                  list is READ while the menu is open rather than subscribed:
                  a subscription here would re-render every row on every task
                  change, for a menu nobody has open. */}
              {menuOpen && (() => {
                const all = useApp.getState().tasks;
                const strays = crossProjectStrays(all);
                const groups = liveGroups(all.filter(t => t.project_id === w.project_id && !strays.has(t.id)));
                const run = (p: Promise<void>) => { void p.finally(() => loadAll()); };
                return (
                  <DropdownSub>
                    <DropdownSubTrigger className="justify-between" data-testid={`task-move-to-group-${w.id}`}>
                      <span className="flex items-center gap-2">
                        <Folder className="h-4 w-4" />
                        <span>{t("taskGroup.moveToGroup")}</span>
                      </span>
                      <ChevronRight className="h-3.5 w-3.5 text-[var(--color-fg-faint)]" />
                    </DropdownSubTrigger>
                    <DropdownSubContent className="sidebar-menu max-h-80 overflow-y-auto">
                      {groups.map(g => {
                        // Join through a live member, not the group id: that is
                        // the lead's task id, and the lead may be archived.
                        const via = all.find(t => !t.archived && t.id !== w.id && t.group?.id === g.id && t.project_id === w.project_id)?.id;
                        const current = w.group?.id === g.id;
                        return (
                          <DropdownItem
                            key={g.id}
                            className="items-center [&>svg]:mt-0"
                            data-testid={`task-move-to-group-${w.id}-${g.id}`}
                            onSelect={() => {
                              if (current || !via) return;
                              // Open it so the moved task stays in view.
                              setTreeFold("taskGroup", g.id, false, compact);
                              run(taskGroupJoin(w.id, via));
                            }}
                          >
                            {current
                              ? <Check className="h-3.5 w-3.5 text-[var(--color-accent)]" />
                              : <span className="block h-2.5 w-2.5 shrink-0 rounded-full mx-0.5" style={{ backgroundColor: taskGroupColorCss(g) }} />}
                            <span className="truncate">{groupLabel(g, all, t)}</span>
                          </DropdownItem>
                        );
                      })}
                      {groups.length > 0 && <DropdownSeparator />}
                      <DropdownItem
                        className="items-center [&>svg]:mt-0"
                        data-testid={`task-new-group-${w.id}`}
                        onSelect={() => {
                          void taskGroupNew(w.id, nextGroupColor(all))
                            .then(() => loadAll())
                            .then(() => {
                              // Offer the real name straight away, like a new
                              // project folder. The id is read back because a
                              // task already leading a group gets a fresh one.
                              // The draft starts as the label the group shows:
                              // the task's name either way (followed or stored).
                              const gid = useApp.getState().tasks.find(t => t.id === w.id)?.group?.id;
                              if (gid && !compact) useUI.setState({ groupRenaming: { groupId: gid, value: w.name } });
                            })
                            .catch(() => loadAll());
                        }}
                      >
                        <FolderPlus className="h-4 w-4" />
                        <span>{t("taskGroup.newGroup")}</span>
                      </DropdownItem>
                      {w.group && (
                        <DropdownItem
                          className="items-center [&>svg]:mt-0"
                          data-testid={`task-leave-group-${w.id}`}
                          onSelect={() => run(taskGroupLeave(w.id))}
                        >
                          <FolderMinus className="h-4 w-4" />
                          <span>{t("taskGroup.removeFromGroup")}</span>
                        </DropdownItem>
                      )}
                    </DropdownSubContent>
                  </DropdownSub>
                );
              })()}
              {/* Duplicate: only for worktree tasks (the repo-root
                  entry IS the project's checkout, can't be branched
                  off cleanly). Pre-fills the New worktree dialog with
                  the source branch as the `base` so the new worktree
                  branches off this one's current tip. */}
              {!w.is_main_checkout && w.branch && (
                <DropdownItem
                  className="items-center [&>svg]:mt-0"
                  // Defer one frame so the dropdown's focus-teardown
                  // doesn't steal focus from the dialog's autofocused name
                  // input (see ProjectActionsMenuItems for the full why).
                  onSelect={() => requestAnimationFrame(() => useUI.getState().openNewTask(w.project_id, {
                    baseBranch: w.branch,
                    // Keep the member subset too — the dialog defaults
                    // all-in. Legacy composition records predate repo_path:
                    // a member that can't be pinned must not silently
                    // uncheck, so bail to the default if any is missing.
                    memberPaths: (w.composition ?? []).every(m => m.repo_path)
                      ? (w.composition ?? []).map(m => m.repo_path!)
                      : undefined,
                  }))}
                >
                  <GitBranchPlus className="h-4 w-4" />
                  <span>{t("duplicateWorktree")}</span>
                </DropdownItem>
              )}
              <DropdownSeparator />
              {/* Stop without archiving (GH #119): kill the agents, free
                  the memory, keep the session. Opening the task again
                  respawns with resume — same lifecycle as restarting
                  termic, scoped to one task. */}
              {isMounted && (
                <DropdownItem
                  className="items-center [&>svg]:mt-0"
                  onSelect={() => {
                    stopTask(w.id);
                    useUI.getState().pushToast(t("stoppedOne", { name: label }), "success");
                  }}
                >
                  <CircleStop className="h-4 w-4" />
                  <span>{t("stopTask")}</span>
                </DropdownItem>
              )}
              <DropdownItem
                className="items-center [&>svg]:mt-0"
                onSelect={async () => {
                  if (taskRenaming !== null) return;
                  await confirmAndArchive(w);
                }}
              >
                <Archive className="h-4 w-4" />
                <span>{t("archiveTask")}</span>
              </DropdownItem>
            </DropdownMenu>
          </DropdownRoot>
          {/* `translate3d(0,0,0)` pins it to its own compositing layer for
              good. Without it the layer exists only WHILE the opacity
              transition runs, and WebKit pixel-snaps a layer, so the badge
              jumped on hover and back on leave. */}
          <span
            data-testid="task-state-slot"
            className={cn(
              // pointer-events-none is load-bearing: this sits OVER the menu
              // trigger in the same box, and an invisible element still takes
              // the click. Without it the three dots could not be pressed.
              "pointer-events-none absolute inset-0 flex items-center justify-center transition-opacity group-hover/wsrow:opacity-0 [transform:translate3d(0,0,0)]",
              (menuOpen || isSelectedRow) && "opacity-0",
            )}
          >
          {collapsed && (hasAttention ? <TaskWorkBadge reason="attention" />
            : hasDone ? <TaskWorkBadge reason="done" delegated={rowDelegated} />
            : hasWorking ? <TaskWorkBadge reason="working" delegated={rowDelegated} />
            : hasDelegated ? <TaskWorkBadge reason="delegated" delegated={rowDelegated} />
            : null)}
          </span>
        </span>
      </div>

      {/* Session rows: terminal tabs only; edit/diff are transient file views.
          Each block draws its own stretch of the guide, so the line stops at
          the last session's elbow instead of running past its subagents. */}
      {!collapsed && terminalTabs.length > 0 && (
      <div className="mb-[4px] mt-[2px]">
      {terminalTabs.map((tab, tabIndex) => {
        const isTabActive = isActive && tab.id === activeTabId;
        const isTabHot = isTabActive;
        const showBell    = attentionIndicator && tab.unread?.reason === "attention";
        const showDone    = settledHighlight && !showBell && tab.workState === "done";
        const showWorking = workingIndicator && !showBell && !showDone && tab.workState === "working";
        // An idle tab that still has something running. Lowest priority: it
        // only ever draws in the slot nothing else wanted.
        const showDelegated = workingIndicator && !showBell && !showDone && !showWorking
          && !!tab.delegatedWork;
        const rawTitle = tab.customTitle ? tab.title : (tab.liveTitle || tab.title);
        const title = tab.customTitle
          ? rawTitle
          : formatTerminalTitle(rawTitle, resolveIconId(tab.cli, agents), workingIndicator);
        const isTabRenaming = tabRenaming?.id === tab.id;
        const isClaudeTab = builtinBaseId(tab.cli, agents) === "claude";
        const isFirstSession = tabIndex === 0;
        const isLastSession = tabIndex === terminalTabs.length - 1;

        return (
          <div key={tab.id} className="relative">
            <span
              aria-hidden
              className={cn(
                "pointer-events-none absolute w-px bg-[var(--sidebar-connector)]",
                isFirstSession ? "top-[-2px]" : "top-0",
                isLastSession ? "h-[16px]" : "bottom-0",
                isFirstSession && isLastSession && "h-[16px]",
              )}
              style={{ left: "calc(var(--sb-task-pad, 42px) + 4px)" }}
            />
            <div
              onClick={() => {
                setActive(w.id);
                setActiveTabId(w.id, tab.id);
              }}
              onDoubleClick={(e) => {
                e.stopPropagation();
                if (!isTabRenaming) setTabRenaming({ id: tab.id, value: title });
              }}
              data-sidebar-tab-id={tab.id}
              data-selected={isTabHot || undefined}
              className={cn(
                "group/tab relative flex h-[var(--sidebar-row-h)] items-center gap-[8px] rounded-[6px] pl-[calc(var(--sb-task-pad,42px)+18px)] pr-[8px] text-[13px] cursor-pointer select-none transition-[color,background-color] duration-[120ms]",
                isTabHot
                  ? "sidebar-selected text-[var(--sidebar-sel-ink)]"
                  : "text-[var(--sidebar-ink)] hover:bg-[var(--sidebar-row-hover)]",
              )}
            >
              <span
                aria-hidden
                className="pointer-events-none absolute top-[14px] h-px w-[9px] bg-[var(--sidebar-connector)]"
                style={{ left: "calc(var(--sb-task-pad, 42px) + 4px)" }}
              />
              {/* The subagent fold leads, in the chevron column a task row
                  has, and holds its width when there is nothing to fold so
                  the marks line up. Then the agent's mark; the work state
                  trails at the end of the row, iTerm2's tab-bullet placement.
                  Claude draws the critter in the accent, every other agent
                  its own icon. */}
              <span className="flex w-[10px] shrink-0 items-center justify-center">
                {isClaudeTab && !isTabRenaming && <SubagentGroupToggle tabId={tab.id} />}
              </span>
              {isClaudeTab ? (
                <CritterGlyph data-testid="session-agent-mark" size={16} className="shrink-0 text-[var(--color-accent)]" />
              ) : (
                <span data-testid="session-agent-mark" className={cn("shrink-0", CLI_BRAND_COLOR[resolveIconId(tab.cli, agents)] || "text-[var(--sidebar-icon)]")}>
                  <CliIcon cli={resolveIconId(tab.cli, agents)} className="h-[15px] w-[15px]" />
                </span>
              )}

              {isTabRenaming ? (
                <input
                  autoFocus
                  value={tabRenaming!.value}
                  onChange={e => setTabRenaming(r => r ? { ...r, value: e.target.value } : r)}
                  onBlur={commitTabRename}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") { e.preventDefault(); commitTabRename(); }
                    else if (e.key === "Escape") { e.preventDefault(); setTabRenaming(null); }
                    e.stopPropagation();
                  }}
                  onClick={e => e.stopPropagation()}
                  onDoubleClick={e => e.stopPropagation()}
                  autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
                  // No `py-*`: the parent row already has py-[3px]; doubling
                  // pads the input up to a taller row than the static span
                  // (the row jumped a few px when entering rename mode).
                  // `leading-tight` keeps the text vertically centred against
                  // the surrounding non-renaming rows.
                  className="sidebar-inline-input min-w-0 flex-1"
                />
              ) : (
                // Same reason as the tab pill: the badge slot is taken over by
                // the row's kebab on hover, so the state has to be on the name
                // to be reachable at all.
                <span
                  className="min-w-0 flex-1 truncate"
                  title={tab.delegatedWork ? delegatedTitle(tab.delegatedWork, tChrome) : undefined}
                >{title}</span>
              )}
              {/* This tab's own properties (GH #358), so it is visible which
                  agent set what; the task row above shows them collected. */}
              {!isTabRenaming && !!tab.props?.length && (
                <span
                  data-testid="tab-props"
                  title={tab.props.map(p => `${p.key}: ${p.value}`).join("\n")}
                  className="min-w-0 max-w-[45%] shrink truncate text-[11px] text-[var(--sidebar-meta)]"
                >{tab.props.map(p => p.value).join(" · ")}</span>
              )}
              {/* Run tabs (GH #54): the same two controls the tab pill carries,
                  because a run is otherwise invisible (and unstoppable) from
                  anywhere but the task that owns it. The collapsed task header
                  renders the identical control (see `collapsedRunTabs`), so this
                  pair lives in one component. */}
              {!isTabRenaming && tab.runTab && (
                <RunTabControl taskId={w.id} tab={tab} title={title} isMounted={isMounted} />
              )}
              {/* Trailing slot: the state as a word (running, done) or its
                  mark. Close only appears when hovering the slot itself,
                  not the whole row, so row hover keeps the state visible. */}
              <span className="group/badge relative flex h-[20px] min-w-[20px] shrink-0 items-center justify-end">
                {(showBell || showDone || showWorking || showDelegated) && (
                  // Pinned to its own layer, same reason as the task row's
                  // badge above: a transition-only layer gets snapped into
                  // existence and the mark jumps a pixel on hover.
                  <span className="flex items-center justify-end transition-opacity group-hover/badge:opacity-0 [transform:translate3d(0,0,0)]">
                    {showBell ? <TaskWorkBadge reason="attention" />
                      : showDone ? <TaskWorkBadge reason="done" delegated={tab.delegatedWork} worded />
                      : showWorking ? <TaskWorkBadge reason="working" delegated={tab.delegatedWork} worded />
                      : <TaskWorkBadge reason="delegated" delegated={tab.delegatedWork} />}
                  </span>
                )}
                <button
                  title={t("closeTab")}
                  aria-label={t("closeTab")}
                  onClick={(e) => { e.stopPropagation(); requestCloseTab(w.id, tab.id); }}
                  className={cn(
                    // A bare glyph tinted toward the error colour, since closing ends the
                    // session; no box around it.
                    "absolute right-0 top-0 flex h-[20px] w-[20px] items-center justify-center text-[color-mix(in_srgb,var(--color-err)_70%,var(--sidebar-icon))] transition-[color] duration-[120ms] hover:text-[var(--color-err)]",
                    (showBell || showDone || showWorking || showDelegated)
                      // Badge visible: X only on badge-slot hover
                      ? "opacity-0 group-hover/badge:opacity-100 pointer-events-none group-hover/badge:pointer-events-auto"
                      // No badge: X on row hover (original behaviour)
                      : "opacity-0 group-hover/tab:opacity-100 pointer-events-none group-hover/tab:pointer-events-auto",
                  )}
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            </div>
            {isClaudeTab && <SubagentRows taskId={w.id} tabId={tab.id} selectedAgentId={selectedSubagentId} />}
          </div>
        );
      })}
      </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

/** The glyphs a `taskLocationIcon` choice puts on task rows, as a sample
 *  beside the option that picks it: link for the main checkout, branch for a
 *  worktree, both split by a hairline. A drawn rule and not a "/" character,
 *  so the row's text stays its label alone (specs and screen readers match on
 *  it). "none" draws nothing, which is the sample. */
function TaskLocationSamples({ value }: { value: "both" | "main" | "worktree" | "none" }) {
  if (value === "none") return null;
  return (
    <span data-testid="task-location-samples" data-value={value} className="flex shrink-0 items-center gap-1.5">
      {value !== "worktree" && <TaskLocationIcon isMainCheckout size="h-3.5 w-3.5" />}
      {value === "both" && <span aria-hidden className="h-3 w-px bg-[var(--color-border)]" />}
      {value !== "main" && <TaskLocationIcon isMainCheckout={false} size="h-3.5 w-3.5" />}
    </span>
  );
}

/** The same for a `taskPrBadge` choice: the glyph, the number, or both, drawn
 *  the way a row draws them. The number is a sample, not a real PR, and it is
 *  generated content for the reason above: the row's text stays its label. */
function TaskPrSamples({ value }: { value: "both" | "icon" | "number" | "none" }) {
  if (value === "none") return null;
  return (
    <span data-testid="task-pr-samples" data-value={value} aria-hidden className="flex shrink-0 items-center gap-0.5 text-[var(--color-fg-dim)]">
      {value !== "number" && <GitPullRequest className="h-3 w-3" />}
      {value !== "icon" && <span className="text-[11px] tabular-nums leading-none after:content-['#12']" />}
    </span>
  );
}

/** A 24px icon button in the section header. `ownTip` false when a wrapping
 *  trigger (a menu's) already draws the tooltip. */
function HeaderButton({ testId, label, ownTip = true, children, ...rest }: {
  testId: string; label: string; ownTip?: boolean; children: React.ReactNode;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const button = (
    <button
      type="button"
      data-testid={testId}
      aria-label={label}
      className="flex h-[24px] w-[24px] shrink-0 items-center justify-center rounded-[5px] text-[var(--sidebar-icon)] transition-[color,background-color] duration-[120ms] hover:bg-[var(--sidebar-row-hover)] hover:text-[var(--sidebar-btn-hover-ink)] data-[state=open]:bg-[var(--sidebar-row-hover)] data-[state=open]:text-[var(--sidebar-btn-hover-ink)]"
      {...rest}
    >
      {children}
    </button>
  );

  return ownTip ? <Tip content={label} side="bottom">{button}</Tip> : button;
}

/** One segment of the toolbar's recessed view switcher. The active one is a
 *  raised chip; the label is the tooltip and stays in the DOM for screen
 *  readers and for specs that find the view by name. */
function ViewSegment({ icon, label, active, onClick, testId, side = "bottom" }: {
  icon: React.ReactNode; label: string; active: boolean; onClick: () => void; testId?: string;
  side?: "bottom" | "right";
}) {
  return (
    <Tip content={label} side={side}>
      <button
        type="button"
        onClick={onClick}
        data-testid={testId}
        data-active={active || undefined}
        aria-label={label}
        aria-pressed={active}
        className={cn(
          "flex h-[26px] w-[34px] items-center justify-center rounded-[6px] transition-[color,background-color] duration-[120ms]",
          active
            ? "bg-[linear-gradient(180deg,var(--sidebar-chip-top),var(--sidebar-chip-bottom))] text-[var(--sidebar-icon-active)] shadow-[var(--sidebar-chip-shadow)]"
            : "text-[var(--sidebar-icon)] hover:bg-[var(--sidebar-seg-hover)]",
        )}
      >
        {icon}
        <span className="sr-only">{label}</span>
      </button>
    </Tip>
  );
}

/** Inline name-prompt row rendered above the task list while the
 *  user is creating a new repo-root task. Mirrors the geometry of
 *  the rename input (py-[3px], no border, accent ring) so the row
 *  doesn't jump vertically when the input mounts. Auto-focused +
 *  pre-selected so the user can hit Enter to accept the default
 *  ("claude-1") or just start typing to replace. */
function PendingRepoRootRow({ mode, cli, value, branch, onChange, onBranchChange, onCommit, onCancel }: {
  mode: NewTaskMode;
  cli: string;
  value: string;
  branch: string;
  onChange: (v: string) => void;
  onBranchChange: (v: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation("sidebar");
  const ref = useRef<HTMLInputElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const isWorktree = mode === "worktree";
  // Show the picked agent's brand icon (or the terminal glyph for a shell) as
  // the leading marker, so the row confirms which CLI is about to launch.
  const agents = useApp(s => s.agents);
  const iconId = resolveIconId(cli, agents);
  useEffect(() => {
    // Two-frame focus matches the Radix dropdown close timing — same
    // workaround used by the task rename input. autoFocus alone
    // races the menu's focus restoration.
    let cancelled = false;
    const r1 = requestAnimationFrame(() => {
      const r2 = requestAnimationFrame(() => {
        if (cancelled) return;
        const el = ref.current;
        if (el) { el.focus(); el.select(); }
      });
      if (cancelled) cancelAnimationFrame(r2);
    });
    return () => { cancelled = true; cancelAnimationFrame(r1); };
  }, []);
  const keyHandler = (e: ReactKeyboardEvent) => {
    if (e.key === "Enter") { e.preventDefault(); onCommit(); }
    else if (e.key === "Escape") { e.preventDefault(); onCancel(); }
    e.stopPropagation();
  };
  // Cancel only when focus leaves the WHOLE row — tabbing name → branch must
  // not dismiss it (single-field rows never had a second focus target).
  const handleBlur = (e: ReactFocusEvent) => {
    if (!containerRef.current?.contains(e.relatedTarget as Node | null)) onCancel();
  };
  const inputCls = "sidebar-inline-input min-w-0 flex-1";
  return (
    <div
      ref={containerRef}
      onBlur={handleBlur}
      className="flex flex-col gap-[4px] py-[4px] pl-[var(--sb-task-pad,42px)] pr-[8px]"
    >
      {/* Both rows share an identical leading-icon column (same glyph box +
          same gap) so the name and branch inputs left-align exactly. */}
      <div className="flex items-center gap-1.5">
        <span className={cn("shrink-0", CLI_BRAND_COLOR[iconId] || "text-[var(--sidebar-icon)]")}>
          <CliIcon cli={iconId} className="h-3.5 w-3.5" />
        </span>
        <input
          ref={ref}
          value={value}
          onChange={e => onChange(e.target.value)}
          onKeyDown={keyHandler}
          placeholder={t("taskNamePlaceholder")}
          autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
          className={inputCls}
        />
      </div>
      {isWorktree && (
        // Auto-derived branch, editable. Indented by one icon column (pl-5 =
        // name icon 14px + gap 6px) so the GitBranch glyph lines up with the
        // START of the name input above it, reading as a child of the name.
        <div className="flex items-center gap-1.5 pl-5">
          <GitBranch className="h-3.5 w-3.5 shrink-0 text-[var(--sidebar-faint)]" />
          <input
            value={branch}
            onChange={e => onBranchChange(e.target.value)}
            onKeyDown={keyHandler}
            placeholder={t("branchPlaceholder")}
            autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
            className={cn(inputCls, "border-[var(--sidebar-input-border)] font-mono text-[12px] text-[var(--sidebar-meta)]")}
          />
        </div>
      )}
    </div>
  );
}


/** Tiny PR/MR state glyph on a task row. Live state when this session
 *  has polled the task (colored), otherwise the persisted identity only
 *  (muted glyph - "there is a PR, state unknown"). Click opens it on the
 *  forge; that's the sidebar's link-out (issue #21). */

/** The compact rail's tooltip for one task: its name, then every terminal it
 *  holds (agents, shells, run tabs) with the title the expanded tree would
 *  show and its state. The rail is one icon per task, so without this a task
 *  running claude AND codex AND a shell read as just "claude-1", and the user
 *  could not tell which task they were about to open. */
function CompactTaskTip({ name, tabs }: { name: string; tabs: TerminalTab[] }) {
  const { t } = useTranslation("sidebar");
  const agents = useApp(s => s.agents);
  const workingIndicator = usePrefs(s => s.workingIndicator);
  return (
    <div data-testid="compact-task-tip" className="flex max-w-[320px] flex-col gap-1">
      <div className="truncate font-medium">{name}</div>
      {tabs.map(tab => {
        const rawTitle = tab.customTitle ? tab.title : (tab.liveTitle || tab.title);
        const title = tab.customTitle ? rawTitle : formatTerminalTitle(rawTitle, resolveIconId(tab.cli, agents), workingIndicator);
        // A KEY, not the rendered word: the colour logic below compares it.
        const stateKey = tab.unread?.reason === "attention" ? "compactNeedsYou"
          : tab.workState === "done" ? "compactDone"
          : tab.workState === "working" ? "compactWorking"
          : "";
        return (
          <div key={tab.id} data-testid="compact-task-tip-tab" className="flex min-w-0 items-center gap-1.5 text-[12.5px] text-[var(--color-fg-dim)]">
            <CliIcon cli={resolveIconId(tab.cli, agents)} className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">{title}</span>
            {stateKey && (
              <span className={cn("ml-auto shrink-0 pl-2",
                stateKey === "compactNeedsYou" ? "text-[var(--color-warn)]" : "text-[var(--color-fg-faint)]")}>
                {t(stateKey)}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
