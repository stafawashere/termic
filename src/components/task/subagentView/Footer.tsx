import { useEffect, useState } from "react";
import type { TFunction } from "i18next";
import { cn } from "@/lib/utils";
import { formatElapsed, formatTokens } from "@/lib/subagentCliView";
import { GLYPH, SPINNER_FRAMES } from "./glyphs";

export type FooterState = "running" | "done" | "failed" | "interrupted";

/** The glyph that cycles while the agent works: one row of a strip of
 *  frames, moved by a CSS animation so no script runs per frame. */
function Spinner() {
  return (
    <span aria-hidden className="inline-block h-[var(--row)] w-[calc(var(--cell)*2)] shrink-0 overflow-hidden align-top">
      <span className="termic-cli-spinner block">
        {SPINNER_FRAMES.map((frame, position) => <span key={position} className="block h-[var(--row)]">{frame}</span>)}
      </span>
    </span>
  );
}

/** Milliseconds since `since`, ticking once a second while `live`. */
function useElapsed(since: number, live: boolean): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!live) return;

    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [live]);

  return Math.max(0, now - since);
}

const STATE_DOT: Record<FooterState, string> = {
  running: "",
  done: "text-[var(--cc-success)]",
  failed: "text-[var(--cc-error)]",
  interrupted: "",
};

/** The bottom of Claude Code's screen for one agent: a working line while it
 *  runs, then the agent's row with what it is doing on the left and the
 *  elapsed time and output tokens on the right. */
export function Footer({ state, agentType, activity, startedAt, durationMs, toolUses, outputTokens, t }: {
  state: FooterState;
  agentType: string;
  /** What the running agent is doing: the call in flight, else its
   *  description, else null. */
  activity: string | null;
  startedAt: number;
  durationMs: number | null;
  toolUses: number;
  outputTokens: number;
  t: TFunction<"task">;
}) {
  const isRunning = state === "running";
  const isFailed = state === "failed";
  const isDone = state === "done";
  const elapsed = useElapsed(startedAt, isRunning);
  const shownTime = isRunning ? elapsed : durationMs;

  const toolCount = t("subagentView.toolUses", { count: toolUses });
  const working = `${t("subagentView.working")}${GLYPH.ellipsis}`;
  const statusText =
    isRunning ? activity ?? ""
      : isFailed ? `${t("subagentView.footerFailed")} (${toolCount})`
        : isDone ? `${t("subagentView.footerDone")} (${toolCount})`
          : t("subagentView.footerInterrupted");

  const right = [
    ...(shownTime === null ? [] : [formatElapsed(shownTime)]),
    `${GLYPH.down} ${t("subagentView.tokens", { value: formatTokens(outputTokens) })}`,
  ].join(` ${GLYPH.middot} `);

  return (
    <div data-testid="subagent-footer" data-footer-state={state} className="shrink-0 px-[var(--cell)] text-[var(--cc-dim)]">
      {isRunning && (
        <div data-testid="subagent-working" className="flex">
          <Spinner />
          <span>{working}</span>
        </div>
      )}
      <div className="flex pt-[var(--row)]">
        <span className="min-w-0 flex-1 truncate whitespace-pre">
          <span aria-hidden className={STATE_DOT[state]}>{isRunning ? GLYPH.ring : GLYPH.bullet}</span>
          {` ${agentType}  `}
          <span className={cn(isFailed && "text-[var(--cc-error)]")}>{statusText}</span>
        </span>
        <span data-testid="subagent-footer-stats" className="shrink-0 pl-[calc(var(--cell)*2)]">{right}</span>
      </div>
    </div>
  );
}
