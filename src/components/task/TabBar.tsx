// The session bar: tabs in a recessed well, a + popover for new agents, and
// the pane tools (broadcast, split down, split right) in a second well.
// docs/ui.md "Session bar".

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Task, Tab, TerminalTab } from "@/lib/types";
import { useApp, useTaskTabs, useActiveTabId } from "@/store/app";
import { getAllLeaves } from "@/lib/splitTree";
import { useTabStripDrag } from "./useTabStripDrag";
import { DropdownRoot, DropdownTrigger, DropdownMenu } from "@/components/ui/Dropdown";
import { NewTabMenuItems } from "./NewTabMenuItems";
import { newScratchTab, openOrCreateScopedScratchTab } from "@/lib/scratchTabs";
import { CliIcon, CLI_BRAND_COLOR, CLI_LABEL, resolveIconId } from "@/icons/cli";
import { GitCompare, NotepadText, Bot, Bell, Pin, Repeat, RotateCw, Square, Play, AlertTriangle } from "lucide-react";
import { BroadcastGlyph, CloseGlyph, PlusGlyph, SplitDownGlyph, SplitRightGlyph, TabTrace } from "./sessionBarIcons";
import { useDocumentVisible } from "@/hooks/useDocumentVisible";
import { ptyKill } from "@/lib/ipc";
import { usePrefs } from "@/store/prefs";
import { Tip } from "@/components/ui/Tooltip";
import { useUI } from "@/store/ui";
import { requestCloseTab, requestCloseTabs } from "@/lib/closeTab";
import { TabContextMenu } from "./TabContextMenu";
import { focusMainTab } from "@/lib/tabFocus";
import { visibleCliIds, agentDisplayName, isTerminalEntry } from "@/lib/agents";
import { cn } from "@/lib/utils";
import { queueLoopRunning } from "@/lib/scheduledQueue";
import { delegatedTitle } from "@/lib/delegatedWork";
import { BackgroundRing } from "@/components/ui/BackgroundRing";
import { formatTerminalTitle } from "@/lib/terminalTitle";
import { fileIconUrl, folderIconUrl } from "@/lib/explorer/iconResolver";
import { kbd } from "@/lib/platform";

const CLIS = ["claude", "codex", "agy", "grok", "opencode"] as const;

/** Height of the session bar (.sessionbar in index.css), which split panes
 *  position their content below. */
export const SESSION_BAR_PX = 42;

export function TabBar({ task }: { task: Task }) {
  const { t } = useTranslation("task");
  const allTabsRaw = useTaskTabs(task.id);
  // Main strip shows only non-pane tabs (split-pane tabs live in SplitView).
  const tabs = allTabsRaw.filter(t => !(t as import("@/lib/types").TerminalTab).paneId);
  const activeId = useActiveTabId(task.id);
  const setActive = useApp(s => s.setActiveTabId);
  const addTab = useApp(s => s.addTab);
  const reorderTab = useApp(s => s.reorderTab);
  const renameTab = useApp(s => s.renameTab);
  const pinTab = useApp(s => s.pinTab);
  const unpinTab = useApp(s => s.unpinTab);
  const stripRef = useRef<HTMLDivElement>(null);

  // The + menu's own rows live in NewTabMenuItems (shared with the sidebar
  // task menu, GH #197); the registry is still needed here for tab titles.
  const registry = useApp(s => s.agents);
  const openBroadcast = useUI(s => s.openBroadcast);
  const closeBroadcast = useUI(s => s.closeBroadcast);
  const broadcastOpen = useUI(s => s.broadcastForTaskId === task.id);
  const windowFocused = useUI(s => s.windowFocused);
  const resumeClosedTab = useApp(s => s.resumeClosedTab);
  const setView = useApp(s => s.setView);
  const [open, setOpen] = useState(false);
  const suppressDropdownReturn = useRef(false);
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);

  // Main strip shows the accent underline on the active tab when the main
  // pane is focused (or there are no splits). When a secondary pane is
  // focused, the active tab keeps its chip and loses the underline, so only
  // one thing reads as "current" across the whole layout.
  const hasSplitTree = useApp(s => !!s.splitTree[task.id]);
  const activePaneId = useApp(s => s.activePaneId[task.id] ?? "");
  const mainPaneId = useApp(s => {
    const t = s.splitTree[task.id];
    if (!t) return "";
    return getAllLeaves(t).find(l => l.isMain)?.id ?? "";
  });
  const mainFocused = !hasSplitTree || !activePaneId || activePaneId === mainPaneId;

  const moveTabToPane = useApp(s => s.moveTabToPane);
  const moveTabToSplit = useApp(s => s.moveTabToSplit);
  // Move to Split only makes sense once another pane already exists to move
  // into or split off of; a bare main strip has nothing to offer.
  const paneCount = useApp(s => {
    const t = s.splitTree[task.id];
    return t ? getAllLeaves(t).length : 1;
  });

  const { dragId, dragTx, suppressClickRef, startDrag, startMenuMove } = useTabStripDrag({
    taskId: task.id, stripRef, stripTabs: tabs, allTabs: allTabsRaw, reorderTab,
    currentPaneId: null,
    onDropToPane: (tabId, toPaneId) => moveTabToPane(task.id, tabId, toPaneId),
    onDropToSplit: (tabId, toPaneId, zone) => useApp.getState().moveTabToSplit(task.id, tabId, toPaneId, zone),
  });

  // ⌘T from the main pane (handled in useShortcuts) opens this menu so
  // the user can keyboard-pick an agent / terminal. Scoped by taskId —
  // multiple tasks stay mounted, so only the targeted TabBar
  // reacts. Radix focuses the first item on open; arrow + Enter from
  // there. Listener identity is stable across renders → mount once.
  useEffect(() => {
    const onMenu = (e: Event) => {
      if ((e as CustomEvent<{ taskId?: string }>).detail?.taskId === task.id) setOpen(true);
    };
    window.addEventListener("termic-new-tab-menu", onMenu);
    return () => window.removeEventListener("termic-new-tab-menu", onMenu);
  }, [task.id]);

  function commitRename() {
    if (!renaming) return;
    renameTab(task.id, renaming.id, renaming.value);
    setRenaming(null);
  }


  // Add a freshly-built terminal tab. `addTab` self-focuses the new
  // terminal (see store) — all we do here is close the dropdown and
  // suppress Radix's focus-return so the closing menu doesn't yank
  // focus back to the '+' trigger before that focus call lands.
  function addAndFocusTab(tab: Tab) {
    suppressDropdownReturn.current = true;
    addTab(task.id, tab);
    setOpen(false);
  }

  function spawnTab(cli: string) {
    const displayName = agentDisplayName(cli, registry);
    addAndFocusTab({ id: crypto.randomUUID(), type: "terminal", title: displayName, cli });
  }

  // Reopen a closed tab with its original session id (see resumeClosedTab
  // in the store) — same dropdown-close/focus dance as addAndFocusTab,
  // just driven by the store action instead of a locally-built tab.
  function resumeAndFocus(entryId: string) {
    suppressDropdownReturn.current = true;
    resumeClosedTab(task.id, entryId);
    setOpen(false);
  }

  /** Plain login-shell tab. Always uncaged: only agents run inside the
   *  task's seatbelt (see ShellTerminalItem / TerminalPane spawn). */
  function spawnShellTab() {
    addAndFocusTab({
      id: crypto.randomUUID(),
      type: "terminal",
      title: "Terminal",
      cli: "shell",
    });
  }

  // The store keeps pinned tabs at the head of the strip, so splitting here
  // preserves the display order (and therefore the DOM order the drag code
  // reads back out of `stripRef`).
  const pinnedTabs = tabs.filter(t => t.pinned);
  const looseTabs = tabs.filter(t => !t.pinned);

  const renderPill = (t: Tab) => (
    <TabContextMenu
      key={t.id} tabs={tabs} tabId={t.id} pinned={!!t.pinned}
      onPin={() => pinTab(task.id, t.id)}
      onUnpin={() => unpinTab(task.id, t.id)}
      onClose={() => requestCloseTab(task.id, t.id)}
      onCloseMany={(ids) => requestCloseTabs(task.id, ids)}
      onSplitRight={() => moveTabToSplit(task.id, t.id, null, 'right')}
      onSplitDown={() => moveTabToSplit(task.id, t.id, null, 'bottom')}
      canSplitOut={tabs.length > 1}
      onMoveToSplit={paneCount > 1 && tabs.length > 1 ? () => startMenuMove(t.id) : undefined}
    >
      <TabPill
        task={task} tab={t} active={t.id === activeId} paneFocused={mainFocused}
        // focusMainTab: keyboard focus must follow the click into the tab's
        // content (terminal / editor) — otherwise the previously focused
        // pane keeps DOM focus and ⌘W acts on the wrong pane.
        onSelect={() => { if (suppressClickRef.current) return; setActive(task.id, t.id); focusMainTab(t.id); }}
        onClose={() => requestCloseTab(task.id, t.id)}
        onUnpin={() => unpinTab(task.id, t.id)}
        renaming={renaming?.id === t.id ? renaming.value : null}
        onStartRename={() => setRenaming({ id: t.id, value: t.title })}
        onChangeRename={(v) => setRenaming(r => r ? { ...r, value: v } : r)}
        onCommitRename={commitRename}
        onCancelRename={() => setRenaming(null)}
        dragging={dragId === t.id}
        dragTx={dragId === t.id ? dragTx : 0}
        onStartDrag={(e) => startDrag(t.id, e)}
      />
    </TabContextMenu>
  );

  const stripDragging = !!dragId;

  return (
    <div className="sessionbar" data-inactive={windowFocused ? undefined : ""}>
      <div
        ref={stripRef}
        data-main-strip=""
        className="sessionbar-main"
        // While dragging, lift the strip above the pane strips (later DOM
        // siblings that would otherwise paint over the pill) so the tab stays
        // visible as it crosses into another pane.
        style={stripDragging ? { position: "relative", zIndex: 30 } : undefined}
      >
        <div className="sessionbar-well" data-dragging={stripDragging ? "" : undefined}>
          {/* Pinned region: OUTSIDE the scroller, which is the whole point of
              pinning (issue #183). A pinned tab must stay in reach no matter
              how far the rest of the strip is scrolled. Capped so that many
              pinned tabs cannot strand the + button; past the cap this region
              scrolls on its own. */}
          {pinnedTabs.length > 0 && (
            <>
              <div data-pinned-strip="" className="sessionbar-pinned" onWheel={scrollSideways}>
                {pinnedTabs.map(renderPill)}
              </div>
              <span className="sessionbar-well-rule" />
            </>
          )}

          <div data-scroll-strip="" className="sessionbar-scroll" onWheel={scrollSideways}>
            {looseTabs.map(renderPill)}
          </div>
        </div>

        <DropdownRoot open={open} onOpenChange={setOpen}>
          <Tip content={t("tabBar.newTip", { combo: kbd("⌘T") })} side="bottom">
            <DropdownTrigger asChild>
              <button type="button" data-testid="tab-strip-new" aria-label={t("tabBar.newAria")} className="sessionbar-new">
                <PlusGlyph size={15} />
              </button>
            </DropdownTrigger>
          </Tip>
          <DropdownMenu
            align="start"
            onCloseAutoFocus={(e) => {
              if (suppressDropdownReturn.current) {
                suppressDropdownReturn.current = false;
                e.preventDefault();
              }
            }}
          >
            <NewTabMenuItems
              taskId={task.id}
              onSpawnCli={spawnTab}
              onSpawnShell={spawnShellTab}
              onScratchpad={(scope) => {
                setOpen(false);
                void newScratchTab(task.id, {
                  scope: scope === "global" || scope === "profile" || scope === "project" ? scope : "task",
                  projectId: scope === "project" ? task.project_id : undefined,
                });
              }}
              onResume={resumeAndFocus}
              onMore={() => { setOpen(false); setView("history", { projectId: task.project_id }); }}
            />
          </DropdownMenu>
        </DropdownRoot>
      </div>

      <div className="sessionbar-well sessionbar-tools">
        <Tip content={t("tabBar.broadcastTip", { combo: kbd("⇧⌘B") })} side="bottom">
          <button
            type="button"
            data-testid="tab-strip-broadcast"
            aria-label={t("tabBar.broadcastAria")}
            aria-pressed={broadcastOpen}
            className="sessionbar-seg"
            onClick={() => broadcastOpen ? closeBroadcast() : openBroadcast(task.id)}
          >
            <BroadcastGlyph />
          </button>
        </Tip>
        <SplitToggle taskId={task.id} direction="h" />
        <SplitToggle taskId={task.id} direction="v" />
      </div>
    </div>
  );
}

/** Mouse wheels scroll vertically; the strips only scroll sideways. A
 *  trackpad's own horizontal swipe is left alone. */
export function scrollSideways(e: React.WheelEvent<HTMLElement>) {
  const isVerticalWheel = Math.abs(e.deltaY) > Math.abs(e.deltaX);
  if (isVerticalWheel) e.currentTarget.scrollLeft += e.deltaY;
}

/** Split the focused pane below (h, ⇧⌘D) or to the right (v, ⌘D). */
function SplitToggle({ taskId, direction }: { taskId: string; direction: "h" | "v" }) {
  const { t } = useTranslation("task");
  const hasSplit = useApp(s => !!s.splitTree[taskId]);
  const splitPane = useApp(s => s.splitPane);
  const isDown = direction === "h";
  const tip = isDown
    ? t("tabBar.splitBelowTip", { combo: kbd("⇧⌘D") })
    : t("tabBar.splitRightTip", { combo: kbd("⌘D") });

  return (
    <Tip content={tip} side="bottom">
      <button
        type="button"
        data-testid={isDown ? "tab-strip-split-down" : "tab-strip-split-right"}
        aria-label={isDown ? t("tabBar.splitBelowAria") : t("tabBar.splitRightAria")}
        data-split={hasSplit ? "" : undefined}
        className="sessionbar-seg"
        onClick={() => splitPane(taskId, direction)}
      >
        {isDown ? <SplitDownGlyph /> : <SplitRightGlyph />}
      </button>
    </Tip>
  );
}

/** Mounted only while a tab is working, so the visibility listener and the
 *  animation exist only then. The pulse stops while the window is hidden. */
function WorkingTrace() {
  const visible = useDocumentVisible();

  return <TabTrace running={visible} />;
}

export function TabPill({ task, tab, active, paneFocused, compact, onSelect, onClose, onUnpin, renaming, onStartRename, onChangeRename, onCommitRename, onCancelRename, dragging, dragTx, onStartDrag }: {
  task: Task; tab: Tab; active: boolean;
  /** True when this pill's pane is the focused one. The active tab keeps its
   *  raised chip regardless, but only shows the accent underline when its
   *  pane is focused, so across a split only ONE tab reads as fully active. */
  paneFocused: boolean;
  /** Pane and shell strips: a narrower fixed width for a pinned pill. */
  compact?: boolean;
  onSelect: () => void; onClose: () => void;
  /** A PINNED pill trades its close × for a pin that unpins on click, so the
   *  tab the user marked as important is never one stray click from a dead
   *  PTY. ⌘W and the context menu's Close stay as the ways out. */
  onUnpin: () => void;
  renaming: string | null;  // current draft value while renaming, else null
  onStartRename: () => void;
  onChangeRename: (v: string) => void;
  onCommitRename: () => void;
  onCancelRename: () => void;
  // Drag-to-reorder wiring (issue #6) — pointer-based.
  dragging: boolean;        // this pill is the one being dragged
  dragTx: number;           // live translateX (px) while dragging, else 0
  onStartDrag: (e: React.PointerEvent) => void;
}) {
  const isUnread = !!tab.unread;
  // iTerm2-parity status indicator on the tab.
  //   attention (bell) → agent explicitly blocked on user.
  //   done (green dot) → agent finished a turn; clears on input.
  //   working (trace)  → the agent's turn is running.
  const reason = tab.unread?.reason;
  const workState = tab.type === "terminal" ? tab.workState : undefined;
  const { t } = useTranslation("task");
  const { t: tChrome } = useTranslation("chrome");
  const queueRunning = tab.type === "terminal" && queueLoopRunning(tab);
  const agents = useApp(s => s.agents);
  // Experimental work-in-progress spinner — opt-in (Settings → Notifications).
  // The "working" state is force-cleared by TerminalPane's demoters /
  // absolute ceiling, so the spinner can't spin forever.
  const workingIndicator = usePrefs(s => s.workingIndicator);
  // Its own opt-out (Settings -> Notifications). Off falls back to the
  // background-work ring, because the turn is still not over.
  const partialDoneIndicator = usePrefs(s => s.partialDoneIndicator);
  // The tab strip used to draw done and the bell whatever these said, so
  // turning them off quietened the sidebar and left the strip lit.
  const settledHighlight = usePrefs(s => s.settledHighlight);
  const attentionIndicator = usePrefs(s => s.attentionIndicator);
  // Failed run/setup tab (GH #54 + exit-code plumbing): the script exited
  // non-zero. Outranks everything else — a red flag on a background setup
  // tab is the whole point of surfacing it without stealing focus.
  const showFailed  = tab.type === "terminal" && !!(tab as TerminalTab).runTab?.failed;
  const showBell    = attentionIndicator && !showFailed && reason === "attention";
  const showDone    = settledHighlight && !showFailed && !showBell && workState === "done";
  const showWorking = workingIndicator && !showFailed && !showBell && !showDone && workState === "working";
  // Work the agent delegated and has not finished (lib/delegatedWork.ts). It
  // qualifies the badge rather than replacing it: with `working` it says the
  // model loop has STOPPED and the spinner is waiting on a subagent, not
  // thinking; with `done` it says the turn ended and left a shell running.
  const delegated = tab.type === "terminal" ? tab.delegatedWork : null;
  const delegatedText = delegated ? delegatedTitle(delegated, tChrome) : "";
  // Some of it came back, the rest runs on. Outranks done (it is the more
  // accurate statement about the same moment) but never a bell.
  const showPartial = workingIndicator && partialDoneIndicator && !showFailed && !showBell && !!delegated?.partial;
  // The turn is over and something it started is still running. Lowest
  // priority in the chain below: it draws only in a slot nothing else wanted,
  // and it is a hollow ring rather than the done bullet because the done was
  // already announced. Without it the decoration is invisible in the common
  // case, since a done on the tab you are WATCHING is acknowledged straight to
  // idle and idle draws no badge at all.
  const showDelegated = workingIndicator && !showFailed && !showBell && !showDone && !showWorking && !!delegated;
  // The ring stands in for the spinner whenever the agent is only WAITING on
  // delegated work: its own loop has stopped, so a spinner claims a model is
  // running. See `BackgroundRing`.
  const ringInsteadOfSpinner = showWorking && !!delegated && !showPartial;
  // Something already occupies the trailing slot at rest, so the action button
  // (close ×, or the pin on a pinned tab) waits for hover.
  const slotTaken = showFailed || showBell || showDone || showWorking || showDelegated || showPartial || !!tab.dirty;
  const iconId = tab.type === "terminal" ? resolveIconId(tab.cli, agents) : "";
  const color = tab.type === "terminal" ? CLI_BRAND_COLOR[iconId] : "text-[var(--color-fg-dim)]";
  const isRenaming = renaming !== null;
  const rawTitle = tab.customTitle ? tab.title : (tab.liveTitle || tab.title);
  const visibleTitle =
    tab.type === "terminal" && !tab.customTitle
      ? formatTerminalTitle(rawTitle, iconId, workingIndicator)
      : rawTitle;

  // Reveal the pill when it becomes active — keyboard tab switches (⇧⌘[/],
  // ⌘1..9, cross-pane cycling) can land on a tab scrolled out of the strip's
  // viewport. inline:'nearest' only scrolls the horizontal strip when needed;
  // block:'nearest' keeps ancestors from scrolling vertically.
  const pillRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (active && !dragging) {
      pillRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }, [active, dragging]);

  let fileIcon: string | null = null;
  if ((tab.type === "edit" || tab.type === "diff" || tab.type === "external") && (tab as any).path) {
    const path = (tab as any).path;
    const name = path.split("/").pop() || tab.title;
    fileIcon = fileIconUrl(name);
  }
  // Folder tabs (issue #151) get the tree's folder icon, matching how the
  // same directory reads in the sidebar. The task root has an empty path,
  // so fall back to the tab title for its name-based icon lookup.
  if (tab.type === "dir") {
    fileIcon = folderIconUrl((tab as any).path.split("/").pop() || tab.title, true);
  }

  const hasIndicator = showFailed || showBell || showDone || showWorking || showDelegated || showPartial;
  const showUnderline = active && paneFocused && !dragging;
  const unpinShown = !!tab.pinned && !slotTaken;
  const brandClass = tab.type === "terminal" ? color : undefined;

  return (
    <div
      ref={pillRef}
      data-tab-id={tab.id}
      // The selected state as a DOM fact, so a spec can assert what the user
      // sees (which pill is lit) rather than the store field behind it.
      data-active={active ? "" : undefined}
      data-dragging={dragging ? "" : undefined}
      {...(tab.pinned ? { "data-pinned": "" } : null)}
      // Start a pointer-drag for reordering, except while renaming (so the
      // inline input handles text selection / caret normally).
      onPointerDown={(e) => { if (!isRenaming) onStartDrag(e); }}
      onClick={() => { if (!isRenaming) onSelect(); }}
      // Middle click closes the tab, as in browsers and VS Code (GH #369).
      // Through the same `onClose` the × uses, so a running agent still gets
      // its close confirm. A pinned tab ignores it for the reason it has no ×:
      // pinning means "do not lose this". The mousedown half stops the
      // middle button's own defaults, autoscroll and (on Linux) pasting the
      // primary selection into whatever is under the pointer.
      onMouseDown={(e) => { if (e.button === 1) e.preventDefault(); }}
      onAuxClick={(e) => {
        if (e.button !== 1 || isRenaming || tab.pinned) return;
        e.stopPropagation();
        onClose();
      }}
      onDoubleClick={(e) => {
        e.stopPropagation();
        if (tab.preview) {
          useApp.getState().persistTab(task.id, tab.id);
        } else {
          onStartRename();
        }
      }}
      style={{
        // Tabs size to their content between the min and max widths in CSS,
        // then shrink toward the min before the strip scrolls. A PINNED pill
        // gets an outright FIXED width instead: it lives in the strip's
        // shrink-to-fit region, so a content-sized one re-measures on every
        // OSC title the agent emits, resizing itself and shoving the whole
        // scrolling remainder sideways.
        ...(tab.pinned ? { flex: "0 0 auto", width: compact ? 180 : 200 } : null),
        // While dragging this pill rides the cursor via translateX and
        // floats above its neighbours. z-index needs the inline value so
        // it beats sibling stacking contexts. pointer-events: none lets
        // elementFromPoint (cross-pane drop detection) see the pane under
        // the cursor instead of the dragged pill itself.
        ...(dragging ? { transform: `translateX(${dragTx}px)`, zIndex: 30, pointerEvents: "none" as const } : null),
      }}
      className="sessionbar-tab"
    >
      <span className="sessionbar-tab-label">
        {/* Terminals get CLI brand icons, edit/diff tabs file icons when a path is known. */}
        {(tab.type === "terminal" || fileIcon || tab.type === "diff" || tab.type === "scratch" || tab.type === "subagent") && (
          <span className={cn("sessionbar-tab-glyph", brandClass)} data-brand={brandClass ? "" : undefined}>
            {tab.type === "terminal" && <CliIcon cli={iconId} />}
            {(tab.type === "edit" || tab.type === "dir" || tab.type === "external") && fileIcon && <img src={fileIcon} alt="" className="file-icon" />}
            {tab.type === "diff" && (fileIcon ? <img src={fileIcon} alt="" className="file-icon" /> : <GitCompare />)}
            {tab.type === "scratch" && <NotepadText />}
            {tab.type === "subagent" && <Bot />}
          </span>
        )}
        {/* Running message queue (ralph loop): subtle accent marker. */}
        {queueRunning && (
          <Repeat className="h-3 w-3 shrink-0 text-[var(--color-accent)]" aria-label={t("tabBar.queueRunningAria")} />
        )}
        {isRenaming ? (
          <input
            autoFocus
            value={renaming!}
            // `size` is the input width in characters. Clamping to [4, 28]
            // keeps it from collapsing to nothing or eating the whole bar.
            size={Math.min(28, Math.max(4, renaming!.length + 1))}
            onChange={e => onChangeRename(e.target.value)}
            onBlur={onCommitRename}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); onCommitRename(); }
              else if (e.key === "Escape") { e.preventDefault(); onCancelRename(); }
              e.stopPropagation();
            }}
            onClick={e => e.stopPropagation()}
            onDoubleClick={e => e.stopPropagation()}
            autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
            className="sessionbar-rename"
          />
        ) : (
          // Manual rename wins (customTitle locked at rename time).
          // Otherwise show the live OSC 0/2 title the agent set, falling
          // back to the static cli/type label when none arrived yet.
          // The work state rides the TITLE, not the badge, and that is not a
          // convenience. The badge sits in a slot the close button takes over
          // on hover, so its own tooltip can never be reached by a pointer:
          // you hover the mark and get "Close tab". The name is the one part
          // of the pill nothing covers.
          <span
            className={cn("sessionbar-tab-name", tab.preview && "italic")}
            title={[
              tab.type === "scratch" && tab.scope === "global"
                ? "[Global]"
                : tab.type === "scratch" && tab.scope === "profile"
                ? "[Profile]"
                : tab.type === "scratch" && tab.scope === "project"
                ? "[Project]"
                : "",
              tab.liveTitle && !tab.customTitle ? tab.liveTitle : "",
              delegatedText,
            ].filter(Boolean).join("\n") || undefined}
          >
            {tab.type === "scratch" && tab.scope === "global" && (
              <span className="shrink-0 text-[10px] font-semibold text-[var(--color-accent)] opacity-80">[G]</span>
            )}
            {tab.type === "scratch" && tab.scope === "profile" && (
              <span className="shrink-0 text-[10px] font-semibold text-[var(--color-accent)] opacity-80">[Pr]</span>
            )}
            {tab.type === "scratch" && tab.scope === "project" && (
              <span className="shrink-0 text-[10px] font-semibold text-[var(--color-accent)] opacity-80">[P]</span>
            )}
            <span>{visibleTitle}</span>
          </span>
        )}
      </span>
      {/* Run tabs (GH #54): inline run controls, always visible, the pill IS
          the run toolbar. ptyId is cleared on process exit, so its presence
          means "running": running → restart + red stop; stopped → a single
          play. <button> elements are skipped by the drag guards, so these
          never start a tab drag. */}
      {!isRenaming && tab.type === "terminal" && (tab as TerminalTab).runTab && (() => {
        const running = !!(tab as TerminalTab).ptyId;
        const rerun = (e: React.MouseEvent) => {
          e.stopPropagation();
          window.dispatchEvent(new CustomEvent("termic-run-tab-restart", { detail: { tabId: tab.id } }));
        };
        return (
          <span className="sessionbar-run">
            {running ? (
              <>
                <button title={t("tabBar.restartRunTip")} onClick={rerun}><RotateCw className="h-3 w-3" /></button>
                <button
                  title={t("tabBar.stopTip")}
                  data-stop=""
                  onClick={(e) => {
                    e.stopPropagation();
                    const ptyId = (tab as TerminalTab).ptyId;
                    if (ptyId) ptyKill(ptyId).catch(() => {});
                  }}
                ><Square className="h-3 w-3" fill="currentColor" /></button>
              </>
            ) : (
              <button title={t("tabBar.runTip")} onClick={rerun}><Play className="h-3 w-3" /></button>
            )}
          </span>
        );
      })()}
      {/* Trailing slot: the state indicator by default, the action button
          (close ×, or the unpin pin on a pinned tab) when the pointer is on
          the tab's right end. One fixed cell, so the pill never jiggles.
          Priority: failed > attention > partial > done > working > delegated,
          then the unseen pad ring, then the dirty dot. */}
      {!isRenaming && (
        <span className="sessionbar-slot">
          <span className="sessionbar-slot-hit" />
          <span className="sessionbar-ind">
            {hasIndicator ? (
              <span
                // DOM hook for the e2e suite. The badge is the user-visible
                // proof of a tab's work state, so specs assert on this instead
                // of reading `tab.workState` out of the store. Keep the value
                // in sync with the priority chain above.
                data-testid="work-badge"
                data-work-state={
                  showFailed ? "failed" : showBell ? "attention" : showPartial ? "partial"
                    : showDone ? "done" : showWorking ? "working" : "delegated"
                }
                // Separate attribute, not a fifth `data-work-state`: it can
                // accompany either of two states and specs assert on both.
                data-delegated={delegated ? delegated.label : undefined}
                className="flex items-center"
              >
                {showFailed && (
                  <span className="text-[var(--color-err)]" title={t("tabBar.failedTip")}>
                    <AlertTriangle className="h-3.5 w-3.5" />
                  </span>
                )}
                {showBell && (
                  <span className="text-[var(--color-warn)]" title={tChrome("taskWorkBadge.attention")}>
                    <Bell className="h-3.5 w-3.5" strokeWidth={2.5} />
                  </span>
                )}
                {showPartial && (
                  <span className="sessionbar-ring" title={delegatedText} aria-label={delegatedText} />
                )}
                {!showPartial && showDone && (
                  <span
                    className="sessionbar-dot"
                    title={delegatedText
                      ? tChrome("taskWorkBadge.doneDelegatedRunning", { held: delegatedText })
                      : tChrome("taskWorkBadge.done")}
                    aria-label={tChrome("taskWorkBadge.doneAria")}
                  />
                )}
                {showDelegated && !showPartial && (
                  <span className="text-[var(--sidebar-muted)]" title={delegatedText} aria-label={delegatedText}>
                    <BackgroundRing size={12} />
                  </span>
                )}
                {showWorking && !showPartial && (
                  <span
                    className="flex text-[var(--sidebar-muted)]"
                    title={ringInsteadOfSpinner ? delegatedText : tChrome("taskWorkBadge.working")}
                    aria-label={ringInsteadOfSpinner ? delegatedText : tChrome("taskWorkBadge.workingAria")}
                  >
                    {/* The ring, not the trace, whenever the model has stopped
                        and only delegated work is outstanding. A turn waiting
                        on a monitoring agent can run for hours, and a moving
                        trace claims a model is running. */}
                    {ringInsteadOfSpinner ? <BackgroundRing size={12} /> : <WorkingTrace />}
                  </span>
                )}
              </span>
            ) : tab.type === "scratch" && tab.unseen ? (
              // Written by an agent since you last looked. A pad is dirty for
              // its whole life, so the grey dot says nothing; this ring (the
              // partial-done shape, in the done colour) replaces it until the
              // tab is shown.
              <span
                data-testid="pad-unseen"
                title={t("tabBar.unseenTip")}
                aria-label={t("tabBar.unseenTip")}
                className="sessionbar-ring"
              />
            ) : tab.dirty && (
              <span aria-hidden title={t("tabBar.dirtyTip")} className="sessionbar-dirty" />
            )}
          </span>
          {tab.pinned ? (
            // No close × on a pinned tab: the affordance would contradict the
            // intent, and one stray click would kill a live PTY (a secondary
            // agent tab is forgotten for good, see closeTab.ts). The pin is
            // always on show when nothing outranks it, so pinned state can
            // never hide behind a status badge.
            <button
              type="button"
              title={t("tabBar.unpinTip")}
              data-kind="unpin"
              data-shown={unpinShown ? "" : undefined}
              className="sessionbar-close"
              onClick={(e) => { e.stopPropagation(); onUnpin(); }}
            ><Pin className="h-3 w-3" /></button>
          ) : (
            <button
              type="button"
              title={t("tabBar.closeTip")}
              className="sessionbar-close"
              onClick={(e) => { e.stopPropagation(); onClose(); }}
            ><CloseGlyph size={11} /></button>
          )}
        </span>
      )}
      {showUnderline && <span className="sessionbar-tab-underline" />}
    </div>
  );
}
