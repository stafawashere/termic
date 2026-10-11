// The title bar's session strip: what the open task's agent is doing right
// now, in a recessed well (docs/ui.md "Title bar"). The well opens the agent,
// the stop button past the groove ends it. With no agent running or waiting
// it renders nothing, so the left cluster closes up.
//
// One store subscription for the pick, packed into a string by
// sessionStripKey, so output and live-title writes re-render nothing. The
// elapsed clock is its own component and ticks only while it is mounted and
// the window is visible, in local state, never through a store.

import { memo, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useApp } from "@/store/app";
import { usePrefs } from "@/store/prefs";
import { useUI } from "@/store/ui";
import { ptyKill } from "@/lib/ipc";
import { tabLabel } from "@/lib/agents";
import { focusMainTab } from "@/lib/tabFocus";
import { formatTerminalTitle } from "@/lib/terminalTitle";
import { resolveIconId } from "@/icons/cli";
import { formatClock, parseSessionStripKey, sessionStripKey } from "@/lib/sessionStrip";
import { useDocumentVisible } from "@/hooks/useDocumentVisible";
import { Tip } from "@/components/ui/Tooltip";
import { StopGlyph, WrenchGlyph } from "@/components/titlebar/titlebarIcons";
import type { TerminalTab } from "@/lib/types";

const TRACE_PATH = "M1 12h8l4-9 6 18 5-12 4 6 3-3h20";

function SessionTrace({ running }: { running: boolean }) {
  return (
    <svg
      width={30}
      height={14}
      viewBox="0 0 52 24"
      fill="none"
      stroke="var(--color-accent)"
      strokeWidth={2.2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className="shrink-0"
      data-testid="session-strip-trace"
      data-running={running || undefined}
    >
      <path d={TRACE_PATH} opacity={0.22} className="titlebar-trace-ghost" data-running={running || undefined} />
      {running && <path d={TRACE_PATH} strokeDasharray="12 36" className="titlebar-trace-pulse" />}
    </svg>
  );
}

function ElapsedClock({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [since]);

  return (
    <span data-testid="session-strip-elapsed" className="titlebar-session-meta titlebar-mono titlebar-ink">
      {formatClock(now - since)}
    </span>
  );
}

function focusSession(taskId: string, tabId: string) {
  useApp.getState().setActiveTabId(taskId, tabId);
  focusMainTab(tabId);
}

/** A running agent in the task other than the one the strip shows. */
function nextRunningTab(taskId: string, shownTabId: string): string | null {
  const tabs = useApp.getState().tabs[taskId] ?? [];
  const running = tabs.filter(tab => tab.type === "terminal" && tab.id !== shownTabId && (tab as TerminalTab).workState === "working" && !(tab as TerminalTab).runTab);

  return running[0]?.id ?? null;
}

export const SessionStrip = memo(function SessionStrip({ taskId }: { taskId: string }) {
  const { t } = useTranslation("chrome");
  const workingIndicator = usePrefs(s => s.workingIndicator);
  const key = useApp(s => sessionStripKey(s.tabs[taskId]));
  const pick = parseSessionStripKey(key);
  const pickedTabId = pick?.tabId ?? "";
  const name = useApp(s => {
    const tab = s.tabs[taskId]?.find(candidate => candidate.id === pickedTabId) as TerminalTab | undefined;
    if (!tab) return "";

    return formatTerminalTitle(tabLabel(tab), resolveIconId(tab.cli, s.agents), workingIndicator);
  });
  const visible = useDocumentVisible();

  if (!pick) return null;

  const isRunning = pick.state === "running";
  const showsClock = pick.since !== null;
  const hasMore = pick.otherRunning > 0;

  const stop = async () => {
    const tab = useApp.getState().tabs[taskId]?.find(candidate => candidate.id === pick.tabId) as TerminalTab | undefined;
    const ptyId = tab?.ptyId;
    if (!ptyId) return;

    const confirmed = await useUI.getState().askConfirm({
      title: t("sessionStrip.stopTitle", { name }),
      message: t("sessionStrip.stopMessage"),
      confirmLabel: t("sessionStrip.stop"),
      destructive: true,
    });
    if (confirmed) ptyKill(ptyId).catch(() => {});
  };

  return (
    <div data-testid="session-strip" data-state={pick.state} data-has-stop="" className="titlebar-well titlebar-session">
      <Tip content={t("sessionStrip.openAgent")} side="bottom">
        <button
          type="button"
          data-no-drag
          data-testid="session-strip-open"
          aria-label={t("sessionStrip.openAgent")}
          className="titlebar-session-main"
          onClick={() => focusSession(taskId, pick.tabId)}
        >
          <SessionTrace running={isRunning && visible} />
          <span className="titlebar-session-name titlebar-trunc titlebar-ink">{name}</span>
          <span data-testid="session-strip-state" data-state={pick.state} className="titlebar-session-state titlebar-ink">
            {t(`sessionStrip.${pick.state}`)}
          </span>
          {showsClock && (
            <>
              <span className="titlebar-rule" />
              {visible && <ElapsedClock since={pick.since!} />}
            </>
          )}
          {pick.tool && (
            <>
              <span className="titlebar-rule" />
              <span key={pick.tool} data-testid="session-strip-tool" className="titlebar-session-tool titlebar-session-meta titlebar-ink">
                <WrenchGlyph size={12} className="shrink-0" />
                <span>{t("sessionStrip.allow")}</span>
                <span className="titlebar-session-target titlebar-trunc titlebar-mono">{pick.tool}</span>
              </span>
            </>
          )}
        </button>
      </Tip>
      {hasMore && (
        <Tip content={t("sessionStrip.moreRunning", { count: pick.otherRunning })} side="bottom">
          <button
            type="button"
            data-no-drag
            data-testid="session-strip-more"
            className="titlebar-session-more"
            onClick={() => {
              const nextTabId = nextRunningTab(taskId, pick.tabId);
              if (nextTabId) focusSession(taskId, nextTabId);
            }}
          >
            +{pick.otherRunning}
          </button>
        </Tip>
      )}
      <span className="titlebar-groove" />
      <Tip content={t("sessionStrip.stopAria", { name })} side="bottom">
        <button
          type="button"
          data-no-drag
          data-testid="session-strip-stop"
          aria-label={t("sessionStrip.stopAria", { name })}
          className="titlebar-session-stop"
          onClick={() => { void stop(); }}
        >
          <StopGlyph size={14} className="titlebar-ink" />
        </button>
      </Tip>
    </div>
  );
});
