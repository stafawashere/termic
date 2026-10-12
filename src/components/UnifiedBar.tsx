// The title bar ("Focus title", docs/ui.md "Title bar contents"): icon
// buttons and the session strip on the left, the task title on the window's
// centre, the action wells on the right. The whole strip is a drag region so
// the window moves from any empty space, with `no-drag` opted in on every
// interactive child.

import { useTranslation } from "react-i18next";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useApp, useActiveTask } from "@/store/app";
import { useProfiles } from "@/store/profiles";
import { profileWashCss } from "@/lib/accents";
import { ProfileChip } from "@/components/ProfileChip";
import { Tip } from "@/components/ui/Tooltip";
import { Library } from "lucide-react";
import { effectiveSandboxMode } from "@/lib/types";
import { taskLabel } from "@/lib/taskLabel";
import { SandboxIcon, DockerSandboxIcon } from "@/components/SandboxIcon";
import { UpdaterBanner } from "@/components/UpdaterBanner";
import { WaitingAgentsPill } from "@/components/WaitingAgentsPill";
import { taskSendDiffToMain } from "@/lib/ipc";
import { OpenWithButton } from "@/components/OpenWithButton";
import { confirmAndArchive } from "@/lib/archiveTask";
import {
  DropdownRoot, DropdownTrigger, DropdownMenu, DropdownItem, DropdownSeparator,
} from "@/components/ui/Dropdown";
import { usePromptLibrary, promptTitle } from "@/store/prompts";
import { useUI } from "@/store/ui";
import { usePrefs } from "@/store/prefs";
import { bindingText } from "@/lib/shortcuts";
import { useIsFullscreen } from "@/hooks/useIsFullscreen";
import { RunControls } from "@/components/task/RunControls";
import { CommandPaletteButton } from "@/components/CommandPaletteButton";
import { IS_MAC, DRAWS_WINDOW_CONTROLS, appRegionStyle } from "@/lib/platform";
import { WindowControls } from "@/components/WindowControls";
import { TrafficLights } from "@/components/TrafficLights";
import {
  ArchiveGlyph, PromptsGlyph, SendUpGlyph, SidebarLeftGlyph, SidebarRightGlyph, TerminalGlyph,
} from "@/components/titlebar/titlebarIcons";
import { SessionStrip } from "@/components/titlebar/SessionStrip";
import { FocusTitle } from "@/components/titlebar/FocusTitle";

export function UnifiedBar() {
  const { t } = useTranslation("chrome");
  // The profile's accent as a wash across the left of the bar (GH #280).
  // Selected as the finished CSS string so this bar re-renders only when the
  // colour actually changes, not on every profile-store touch.
  const profileWash = useProfiles(s => {
    const me = s.profiles.find(p => p.slug === s.current);
    return profileWashCss(me?.accent, s.profiles.length > 0);
  });
  const compact = useApp(s => s.compactSidebar);
  const toggleCompact = useApp(s => s.toggleCompactSidebar);
  const toggleRP = useApp(s => s.toggleRightPanel);
  const task = useActiveTask();
  const proj = useApp(s => task ? s.projects.find(p => p.id === task.project_id) : null);
  const openSettings = useApp(s => s.openSettings);
  const enabledPrompts = usePromptLibrary(s => s.prompts).filter(p => p.enabled);
  // Picking a prompt opens the shared destination modal (running agents +
  // new-agent CLIs) — a modal, not a submenu, which flipped to the wrong
  // side near the window edge. Shared (not local state) so the ⌥⌘P prompt
  // palette's fallback path can open the same dialog.
  const openPromptFire = useUI(s => s.openPromptFire);
  // Breadcrumb label for the task: its typed name, or its branch when the
  // "use branch as task name" pref is on (GH #260).
  const useBranchAsTaskName = usePrefs(s => s.useBranchAsTaskName);
  const taskCrumb = task ? taskLabel(task, useBranchAsTaskName) : "";
  const isFullscreen = useIsFullscreen();
  const windowFocused = useUI(s => s.windowFocused);
  const terminalPanelOpen = useApp(s => {
    const taskId = s.activeTaskId;
    if (!taskId) return false;

    return !!s.terminalSplit[taskId] && !s.terminalSplitCollapsed[taskId];
  });
  // Tooltips that name a shortcut read it from the LIVE bindings, never a
  // hard-coded "⌥⌘P": every one of these is rebindable in settings, and a
  // tooltip naming a key that no longer does anything is worse than a
  // tooltip with no key at all.
  const binds = usePrefs(s => s.shortcuts);
  const tipWithKey = (text: string, id: import("@/lib/shortcuts").ShortcutId) => {
    const g = binds[id] ? bindingText(binds[id]) : "";
    return g ? `${text} (${g})` : text;
  };

  return (
    <header
      data-tauri-drag-region={IS_MAC || undefined}
      // Which task the chrome has actually RENDERED, which is not the same
      // fact as useApp's activeTaskId. The store setter is synchronous but
      // React 19 renders concurrently, so between the two the archive button
      // below still closes over the PREVIOUS task. A test that drives the
      // store and then clicks was archiving the wrong task on any machine
      // slow enough to lose that race (e2e/helpers.ts ensureActiveTask).
      data-active-task={task?.id ?? ""}
      // Imperative fallback: data-tauri-drag-region + -webkit-app-region: drag
      // both *should* work, but for whatever reason the WKWebView in this build
      // ignores both. onMouseDown → startDragging() is the bulletproof escape
      // hatch. Guarded so we only drag on a primary click that hits the bar
      // itself (or a non-interactive descendant like the breadcrumb text).
      // This bar IS the title bar everywhere: on macOS (hidden, overlay title
      // bar) and on Windows and Linux (no native frame, WindowControls draws
      // the buttons).
      //
      // Windows and Linux read a double click off the mousedown's click
      // count, not from onDoubleClick: startDragging hands the mouse to the
      // system's move loop, which swallows the mouseup a dblclick event needs.
      onMouseDown={(e) => {
        if (e.button !== 0) return;
        const t = e.target as HTMLElement;
        if (t.closest("[data-no-drag]") || t.closest("button") || t.closest("input")) return;
        if (DRAWS_WINDOW_CONTROLS && e.detail === 2) {
          getCurrentWindow().toggleMaximize().catch(() => {});
          return;
        }
        getCurrentWindow().startDragging().catch(() => {});
      }}
      onDoubleClick={(e) => {
        if (!IS_MAC) return;
        const t = e.target as HTMLElement;
        if (t.closest("[data-no-drag]") || t.closest("button") || t.closest("input")) return;
        // macOS convention: double-click title bar zooms the window.
        getCurrentWindow().toggleMaximize().catch(() => {});
      }}
      data-inactive={windowFocused ? undefined : ""}
      className="titlebar"
      style={{
        ...appRegionStyle("drag"),
        // The profile's accent, washed in from the left and gone by the first
        // third (GH #280). JetBrains tints this exact strip per project: the
        // bar is the one surface on screen in every window, so "which profile
        // is this" is answered by peripheral vision. A gradient rather than a
        // fill so the title and the toolbar keep their contrast. It rides a
        // custom property under the bar's own gradient (.titlebar), so the
        // shell and the wash are one background.
        "--titlebar-wash": profileWash,
      } as any}
    >
      {/* The traffic lights are reserved only while they are there:
          full-screen hides them, and nothing off macOS draws them at all.
          The reservation lives inside the left column, so the two side
          columns stay equal and the title stays on the window's centre. */}
      <div className="titlebar-side" data-side="left" style={{ paddingLeft: IS_MAC && !isFullscreen ? 16 : 12 }}>
      <div
        data-tauri-drag-region="false"
        className="flex min-w-0 items-center"
        style={appRegionStyle("no-drag")}
      >
        <TrafficLights />
        <Tip content={compact ? t("unifiedBar.expandSidebar") : t("unifiedBar.collapseSidebar")} side="bottom">
          <button type="button" className="titlebar-icon-btn" data-testid="titlebar-sidebar-toggle" onClick={() => {
            // Suppress the 220ms grid-template-columns transition for
            // this single toggle. Animating the column lerp makes the
            // toggle feel laggy — user clicked a button, they expect
            // instant. We restore the transition on the next frame so
            // RightPanel show/hide still animates normally.
            const root = document.documentElement;
            root.style.setProperty("--cols-transition", "none");
            toggleCompact();
            requestAnimationFrame(() => requestAnimationFrame(() => {
              root.style.removeProperty("--cols-transition");
            }));
          }}>
            <SidebarLeftGlyph className="titlebar-ink" />
          </button>
        </Tip>
        {/* Profiles: a bare icon until profiles exist, then the current one's
            dot and name, in the accent wash this bar already carries. */}
        <ProfileChip />
        <div className="titlebar-status">
        {task && <SessionStrip taskId={task.id} />}
        {/* Waiting-agents pill (issue #56): appears only when an agent needs
            you, jumps to the next on click, across every task. The strip
            beside it only speaks for the open one. */}
        <WaitingAgentsPill />
        {/* Build badge (DEV / E2E / BETA) or the update button. */}
        <UpdaterBanner />
        {/* YOLO is per-task only — controlled from the task's
            sidebar dropdown ("YOLO: on/off"), with a red ⚡ status badge
            on the sidebar row. No top-bar toggle (it had no global
            meaning and was redundant with the per-task control). */}
        </div>
      </div>

      </div>

      <FocusTitle task={task} project={proj} />

      <div className="titlebar-side" data-side="right" style={{ paddingRight: DRAWS_WINDOW_CONTROLS ? 0 : 12 }}>
      <div
        data-tauri-drag-region="false"
        className="flex items-center gap-[8px]"
        style={appRegionStyle("no-drag")}
      >
        {task && proj && (
          <>
            {/* Do: run and prompts. */}
            <div role="group" aria-label={t("unifiedBar.doGroup")} className="titlebar-well titlebar-action-well">
              {/* Popped-out run controls (GH #54): runs open as terminal tabs. */}
              <RunControls task={task} />
              <DropdownRoot>
                {/* The dropdown is the mouse path; the prompt palette shortcut
                    opens the searchable palette over the same list. The
                    tooltip names its live binding. */}
                <Tip content={tipWithKey(t("unifiedBar.prompts"), "prompt-palette")} side="bottom">
                  <DropdownTrigger asChild>
                    <button type="button" className="titlebar-seg" data-no-drag data-testid="prompts-menu" aria-label={t("unifiedBar.prompts")}>
                      <PromptsGlyph className="titlebar-ink" />
                    </button>
                  </DropdownTrigger>
                </Tip>
                {/* preventDefault on close keeps focus from snapping back to the
                    trigger, which would re-fire its focus-triggered tooltip and
                    leave it stuck open after picking a prompt. */}
                <DropdownMenu align="end" sideOffset={6} className="titlebar-menu w-[250px]" onCloseAutoFocus={(e) => e.preventDefault()}>
                  {enabledPrompts.length === 0 && (
                    <div className="titlebar-menu-note">{t("unifiedBar.promptsEmpty")}</div>
                  )}
                  {enabledPrompts.map(p => (
                    <DropdownItem key={p.id} onSelect={() => openPromptFire(p)}>
                      <span className="min-w-0 flex-1 truncate">{promptTitle(p, t)}</span>
                    </DropdownItem>
                  ))}
                  <DropdownSeparator />
                  <DropdownItem onSelect={() => openSettings("prompts")}>
                    <Library className="h-4 w-4" />
                    <span>{t("unifiedBar.managePrompts")}</span>
                  </DropdownItem>
                </DropdownMenu>
              </DropdownRoot>
            </div>

            {/* Manage: the bottom terminal, send to main, sandbox, archive,
                open folder. */}
            <div role="group" aria-label={t("unifiedBar.manageGroup")} className="titlebar-well titlebar-action-well">
              <Tip content={tipWithKey(t("unifiedBar.terminalPanel"), "toggle-terminal")} side="bottom">
                <button
                  type="button"
                  className="titlebar-seg"
                  data-no-drag
                  data-testid="toggle-terminal-panel"
                  data-active={terminalPanelOpen ? "" : undefined}
                  aria-label={t("unifiedBar.terminalPanel")}
                  aria-pressed={terminalPanelOpen}
                  onClick={() => {
                    const app = useApp.getState();
                    if (terminalPanelOpen) app.toggleTerminalSplitCollapsed(task.id);
                    else app.toggleBottomTerminal(task.id);
                  }}
                >
                  <TerminalGlyph className="titlebar-ink" />
                </button>
              </Tip>
              {/* Send-to-main: only on actual worktrees, not the repo-root
                  pseudo-task, which IS the main checkout. Hard-blocks on a
                  dirty main checkout rather than mix change sets; the error
                  comes back through the confirm below. */}
              {!task.is_main_checkout && (
                <Tip content={t("unifiedBar.sendToMainTip")} side="bottom">
                  <button type="button" className="titlebar-seg" data-no-drag data-testid="send-to-main" aria-label={t("unifiedBar.sendToMain")}
                    onClick={async () => {
                      const ok = await useUI.getState().askConfirm({
                        title: t("unifiedBar.sendToMainTitle", { name: taskCrumb }),
                        message: t("unifiedBar.sendToMainMessage", { path: proj.root_path }),
                        confirmLabel: t("unifiedBar.sendToMain"),
                      });
                      if (!ok) return;
                      try {
                        const r = await taskSendDiffToMain(task.id);
                        // A compact summary that quietly omits the zero
                        // halves, so it reads as a result.
                        const parts: string[] = [];
                        if (r.tracked_files)   parts.push(t(r.tracked_files === 1 ? "unifiedBar.trackedOne" : "unifiedBar.trackedMany", { count: r.tracked_files }));
                        if (r.untracked_files) parts.push(t(r.untracked_files === 1 ? "unifiedBar.untrackedOne" : "unifiedBar.untrackedMany", { count: r.untracked_files }));
                        const summary = parts.length ? parts.join(", ") : t("unifiedBar.noChanges");
                        useUI.getState().pushToast(t("unifiedBar.sentToast", { summary }), "success");
                      } catch (e) {
                        await useUI.getState().askConfirm({
                          title: t("unifiedBar.sendToMainFailed"),
                          message: String(e),
                          confirmLabel: t("ok", { ns: "common" }),
                          cancelLabel: "",
                          destructive: true,
                        });
                      }
                    }}>
                    <SendUpGlyph className="titlebar-ink" />
                  </button>
                </Tip>
              )}
              {(() => {
                if (task.docker_sandbox_enabled) {
                  return (
                    <Tip content={t("unifiedBar.sbDockerTip")} side="bottom">
                      <button type="button" className="titlebar-seg" data-no-drag data-testid="sandbox-button" data-active=""
                        aria-label={t("unifiedBar.sbDockerTip")}
                        onClick={() => useUI.getState().openSandbox(task.id)}
                      >
                        <DockerSandboxIcon className="titlebar-ink h-[16px] w-[16px]" />
                      </button>
                    </Tip>
                  );
                }
                const sbMode = effectiveSandboxMode(task);
                const tip = sbMode === "enforce" ? t("unifiedBar.sbEnforce")
                  : sbMode === "enforce-fs" ? t("unifiedBar.sbEnforceFs")
                  : sbMode === "monitor" ? t("unifiedBar.sbMonitor")
                  : t("unifiedBar.sbOff");
                const sandboxOn = sbMode !== "off";
                return (
                  <Tip content={tip} side="bottom">
                    <button type="button" className="titlebar-seg" data-no-drag data-testid="sandbox-button"
                      data-active={sandboxOn ? "" : undefined}
                      aria-label={tip}
                      onClick={() => useUI.getState().openSandbox(task.id)}
                    >
                      {/* Glyph, color and fill ALL come from SANDBOX_VISUALS,
                          so this agrees with the sidebar row, the footer chip
                          and the mode picker about what each mode looks like. */}
                      <SandboxIcon mode={sbMode} className="titlebar-ink h-[16px] w-[16px]" />
                    </button>
                  </Tip>
                );
              })()}
              <Tip content={t("unifiedBar.archiveTask")} side="bottom">
                {/* Copy, delete-branch checkbox and the "Show this every time"
                    opt-out all live in confirmAndArchive, shared with the
                    sidebar so the two prompts cannot drift. */}
                <button type="button" className="titlebar-seg" data-no-drag
                  aria-label={t("unifiedBar.archiveTask")}
                  onClick={() => { void confirmAndArchive(task); }}
                  data-testid="archive-task"
                ><ArchiveGlyph className="titlebar-ink" /></button>
              </Tip>
              <OpenWithButton task={task} />
            </div>
          </>
        )}
        {/* The command palette is never task-scoped: its global commands
            (new task, project picker, settings) work with nothing selected. */}
        <CommandPaletteButton />
        {task && proj && (
          <Tip content={tipWithKey(t("unifiedBar.toggleRightPanel"), "toggle-right-sidebar")} side="bottom">
            <button type="button" className="titlebar-icon-btn" onClick={toggleRP} data-testid="toggle-right-panel" aria-label={t("unifiedBar.toggleRightPanel")}>
              <SidebarRightGlyph className="titlebar-ink" />
            </button>
          </Tip>
        )}
      </div>
      {/* Windows and Linux: minimize / maximize / close, flush with the
          window's top-right corner. Nothing on macOS, where the system draws
          the traffic lights. */}
      {DRAWS_WINDOW_CONTROLS && (
        <div className="flex self-stretch">
          <WindowControls />
        </div>
      )}
      </div>
    </header>
  );
}

