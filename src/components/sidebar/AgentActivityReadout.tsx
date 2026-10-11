// The toolbar's agent readout: a heart-monitor trace in a recessed well
// (docs/ui.md "The agent activity readout"). No visible text: the count is
// its accessible name, and the tooltip lists what is running. Informational
// only, no click and no hover state.
//
// One subscription, a number (countWorkingAgentTabs), so it re-renders when
// the count moves and never on output. The trace is a CSS animation that
// stops at zero, while the window is hidden, under reduced motion, and in
// an instance the caller says is not on screen (`animate`).

import { memo, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useApp } from "@/store/app";
import { usePrefs } from "@/store/prefs";
import { useSubagents } from "@/store/subagents";
import { Tip } from "@/components/ui/Tooltip";
import { countWorkingAgentTabs, formatElapsed, workingAgentLines } from "@/lib/agentActivity";
import { cn } from "@/lib/utils";

const TRACE_PATH = "M1 12h8l4-9 6 18 5-12 4 6 3-3h20";

function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(() => document.visibilityState !== "hidden");

  useEffect(() => {
    const onChange = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);

  return visible;
}

export function ActivityTrace({ running, width = 30, height = 14 }: { running: boolean; width?: number; height?: number }) {
  return (
    <svg
      data-testid="agent-activity-trace"
      data-running={running || undefined}
      width={width}
      height={height}
      viewBox="0 0 52 24"
      fill="none"
      stroke="var(--color-accent)"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className="shrink-0"
    >
      <path d={TRACE_PATH} opacity={0.22} />
      {running && <path d={TRACE_PATH} strokeDasharray="12 36" className="sidebar-trace-pulse" />}
    </svg>
  );
}

/** Mounted only while the tooltip is open, so its one-second tick runs
 *  only then. */
function ActivityTip() {
  const { t } = useTranslation("sidebar");
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const { tabs, tasks } = useApp.getState();
  const lines = workingAgentLines(tabs, tasks);
  const subagentsByTab = useSubagents.getState().byTab;

  if (lines.length === 0) return <span>{t("activity.idle")}</span>;

  const runningSubagentsOf = (tabId: string) =>
    Object.values(subagentsByTab[tabId]?.agents ?? {}).filter(agent => agent.state === "running").length;

  return (
    <div data-testid="agent-activity-tip" className="flex flex-col gap-0.5">
      {lines.map(line => {
        const subagents = runningSubagentsOf(line.tabId);
        const elapsed = line.since === null ? null : formatElapsed(now - line.since);

        return (
          <div key={line.tabId} className="flex flex-col">
            <span>
              {elapsed === null
                ? t("activity.lineNoTime", { task: line.taskName })
                : t("activity.line", { task: line.taskName, elapsed })}
            </span>
            {subagents > 0 && (
              <span className="pl-3 text-[12px] text-[var(--color-fg-dim)]">
                {t("activity.subagents", { count: subagents })}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

export const AgentActivityReadout = memo(function AgentActivityReadout({ animate = true, compact = false }: {
  animate?: boolean;
  /** The icon rail's form: a narrower well. */
  compact?: boolean;
}) {
  const { t } = useTranslation("sidebar");
  const workingIndicator = usePrefs(s => s.workingIndicator);
  const rawCount = useApp(countWorkingAgentTabs);
  const visible = useDocumentVisible();

  const count = workingIndicator ? rawCount : 0;
  const isRunning = count > 0 && visible && animate;
  const label = t("activity.agents", { count });

  return (
    <Tip content={<ActivityTip />} side={compact ? "right" : "bottom"}>
      <div
        data-testid="sidebar-agent-activity"
        data-count={count}
        tabIndex={0}
        role="status"
        aria-label={label}
        className={cn(
          "flex shrink-0 select-none items-center justify-center rounded-[8px] bg-[var(--sidebar-well-bg)] shadow-[var(--sidebar-well-shadow)]",
          compact ? "h-[28px] w-[40px]" : "h-[32px] px-[12px]",
        )}
      >
        <ActivityTrace running={isRunning} width={compact ? 26 : 30} height={compact ? 12 : 14} />
      </div>
    </Tip>
  );
});
