import { useEffect, useState } from "react";
import type { TFunction } from "i18next";
import { cn } from "@/lib/utils";
import { formatElapsed, formatTokens } from "@/lib/subagentCliView";
import { GLYPH, SPINNER_FRAMES } from "./glyphs";

export type FooterState = "running" | "done" | "failed" | "interrupted";

/** The glyph that cycles while the agent works: one line of a strip of
 *  frames, moved by a CSS animation so no script runs per frame. */
function Spinner() {
  return (
    <span aria-hidden className="inline-block h-[1lh] w-[2ch] shrink-0 overflow-hidden align-top text-[var(--color-cli-claude)]">
      <span className="termic-cli-spinner block">
        {SPINNER_FRAMES.map((frame, position) => <span key={position} className="block h-[1lh]">{frame}</span>)}
      </span>
    </span>
  );
}

/** Seconds since `since`, ticking once a second while mounted. */
function useElapsed(since: number): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  return Math.max(0, now - since);
}

function Working({ since, outputTokens, t }: { since: number; outputTokens: number; t: TFunction<"task"> }) {
  const elapsed = useElapsed(since);
  const stats = [formatElapsed(elapsed), `${GLYPH.down} ${t("subagentView.tokens", { value: formatTokens(outputTokens) })}`];

  return (
    <div className="flex">
      <Spinner />
      <span className="text-[var(--color-cli-claude)]">{t("subagentView.working")}{GLYPH.ellipsis}</span>
      <span className="pl-[1ch] text-[var(--color-fg-dim)]">({stats.join(` ${GLYPH.middot} `)})</span>
    </div>
  );
}

/** The status line under the transcript, as Claude Code draws it under a
 *  Task call: working while the agent runs, a summary once it stops. */
export function Footer({ state, startedAt, durationMs, toolUses, outputTokens, t }: {
  state: FooterState;
  startedAt: number;
  durationMs: number | null;
  toolUses: number;
  outputTokens: number;
  t: TFunction<"task">;
}) {
  const isRunning = state === "running";
  const isFailed = state === "failed";
  const isInterrupted = state === "interrupted";

  const stats = [
    t("subagentView.toolUses", { count: toolUses }),
    t("subagentView.tokens", { value: formatTokens(outputTokens) }),
    ...(durationMs === null ? [] : [formatElapsed(durationMs)]),
  ].join(` ${GLYPH.middot} `);
  const verdict = isFailed ? t("subagentView.footerFailed") : t("subagentView.footerDone");

  return (
    <div
      data-testid="subagent-footer"
      data-footer-state={state}
      className={cn(
        "shrink-0 px-3 pt-[0.3em] pb-[0.6em]",
        isFailed && "text-[var(--color-err)]",
        !isFailed && "text-[var(--color-fg-dim)]",
      )}
    >
      {isRunning && <Working since={startedAt} outputTokens={outputTokens} t={t} />}
      {!isRunning && (
        <div className="flex">
          <span aria-hidden className="w-[3ch] shrink-0">{GLYPH.hook}</span>
          <span className="min-w-0 flex-1 truncate">
            {isInterrupted ? t("subagentView.footerInterrupted") : `${verdict} (${stats})`}
          </span>
        </div>
      )}
    </div>
  );
}
