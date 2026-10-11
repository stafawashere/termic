import { useEffect, useRef, useState, type CSSProperties, type RefObject } from "react";
import type { TFunction } from "i18next";
import { cn } from "@/lib/utils";
import { formatElapsed, formatTokens, spinnerSuffix } from "@/lib/subagentCliView";
import { GLYPH, MESSAGE_BULLET, SPINNER_FRAMES } from "./glyphs";

export type FooterState = "running" | "done" | "failed" | "interrupted";

const SHIMMER_MS_PER_CELL = 200;
const SHIMMER_PAD_CELLS = 20;
const STALL_STARTS_MS = 10_000;
const STALL_RAMP_MS = 10_000;

/** True while `ref` has pixels. A pane hidden with display:none reports
 *  false, which stops the second tick below. */
function useOnScreen(ref: RefObject<HTMLElement | null>): boolean {
  const [onScreen, setOnScreen] = useState(true);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    const observer = new IntersectionObserver(([entry]) => setOnScreen(entry.isIntersecting));
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);

  return onScreen;
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

/** The glyph: a one-row window over the strip of frames, moved by the
 *  cosine keyframes in index.css. Reduced motion shows a still dot. */
function SpinnerGlyph() {
  return (
    <span aria-hidden className="inline-block h-[var(--row)] w-[calc(var(--cell)*2)] shrink-0 overflow-hidden align-top">
      <span data-testid="subagent-spinner-glyph" className="termic-cli-spinner termic-cli-spinner-strip block">
        {SPINNER_FRAMES.map((frame, position) => <span key={position} className="block h-[var(--row)]">{frame}</span>)}
      </span>
      <span className="termic-cli-reduced-motion">{GLYPH.bullet}</span>
    </span>
  );
}

/** The message in the claude colour with claude's three-cell shimmer
 *  sweeping right to left, or the whole message pulsing while a tool
 *  runs. Both stop once the row has stalled. */
function SpinnerMessage({ message, toolRunning, stallStyle, stallDelayMs }: {
  message: string;
  toolRunning: boolean;
  stallStyle: CSSProperties | undefined;
  stallDelayMs: number;
}) {
  const width = message.length;
  const steps = width + SHIMMER_PAD_CELLS;
  const parked = stallStyle ? `, termic-cli-park 0s linear ${stallDelayMs}ms forwards` : "";
  const sweep = `${steps * SHIMMER_MS_PER_CELL}ms steps(${steps}, end) infinite`;
  const windowStyle = {
    "--shimmer-width": width,
    animation: `termic-cli-shimmer-window ${sweep}${parked}`,
  } as CSSProperties;

  return (
    <span
      data-testid="subagent-spinner-message"
      className={cn("relative whitespace-pre", toolRunning && "termic-cli-pulse", stallStyle && "termic-cli-stalls")}
      style={stallStyle}
    >
      {message}
      {!toolRunning && (
        <span
          aria-hidden
          data-testid="subagent-shimmer"
          className="termic-cli-shimmer absolute left-0 top-0 h-[var(--row)] w-[calc(var(--cell)*3)] overflow-hidden"
          style={windowStyle}
        >
          <span
            className="block whitespace-pre text-[var(--cc-claudeShimmer)]"
            style={{ "--shimmer-width": width, animation: `termic-cli-shimmer-text ${sweep}` } as CSSProperties}
          >
            {message}
          </span>
        </span>
      )}
    </span>
  );
}

const STATE_DOT: Record<FooterState, string> = {
  running: "",
  done: "text-[var(--cc-success)]",
  failed: "text-[var(--cc-error)]",
  interrupted: "",
};

/** The bottom of Claude Code's screen for one agent: the spinner row while
 *  it runs, then the agent's row with what it is doing on the left and the
 *  elapsed time and output tokens on the right. */
export function Footer({
  state, agentType, activity, message, toolRunning, thinking, lastAtMs, stallStepped, startedAt, durationMs, toolUses,
  outputTokens, t,
}: {
  state: FooterState;
  agentType: string;
  /** What the running agent is doing: the call in flight, else its
   *  description, else null. */
  activity: string | null;
  /** The spinner's message, ellipsis included. */
  message: string;
  toolRunning: boolean;
  thinking: boolean;
  /** When the newest entry was written; the stall clock starts there. */
  lastAtMs: number | null;
  /** An ansi theme switches to red halfway instead of blending. */
  stallStepped: boolean;
  startedAt: number;
  durationMs: number | null;
  toolUses: number;
  outputTokens: number;
  t: TFunction<"task">;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const onScreen = useOnScreen(rootRef);
  const isRunning = state === "running";
  const isFailed = state === "failed";
  const isDone = state === "done";
  const elapsed = useElapsed(startedAt, isRunning && onScreen);
  const shownTime = isRunning ? elapsed : durationMs;

  const toolCount = t("subagentView.toolUses", { count: toolUses });
  const statusText =
    isRunning ? activity ?? ""
      : isFailed ? `${t("subagentView.footerFailed")} (${toolCount})`
        : isDone ? `${t("subagentView.footerDone")} (${toolCount})`
          : t("subagentView.footerInterrupted");

  const right = [
    ...(shownTime === null ? [] : [formatElapsed(shownTime)]),
    `${GLYPH.down} ${t("subagentView.tokens", { value: formatTokens(outputTokens) })}`,
  ].join(` ${GLYPH.middot} `);

  // The stall clock does not run while a tool works or the agent thinks.
  // A CSS animation's clock starts when it is first applied, so the delay
  // is measured from then: a newer entry moves the ramp later without
  // restarting the animation, and the spinner and shimmer keep their phase.
  const stalls = isRunning && !toolRunning && !thinking && lastAtMs !== null;
  const stallAppliedAtRef = useRef<number | null>(null);
  if (!stalls) stallAppliedAtRef.current = null;
  else if (stallAppliedAtRef.current === null) stallAppliedAtRef.current = Date.now();
  const stallDelay = stalls ? lastAtMs + STALL_STARTS_MS - stallAppliedAtRef.current! : 0;
  const stallTiming = stallStepped ? "steps(2, jump-none)" : "steps(8, end)";
  const stallStyle: CSSProperties | undefined = stalls
    ? { animation: `termic-cli-stall ${STALL_RAMP_MS}ms ${stallTiming} ${stallDelay}ms both` }
    : undefined;
  const suffix = isRunning ? spinnerSuffix(elapsed, outputTokens, thinking) : null;

  return (
    <div
      ref={rootRef}
      data-testid="subagent-footer"
      data-footer-state={state}
      className="shrink-0 px-[var(--cell)] text-[var(--cc-dim)]"
    >
      {isRunning && (
        <div data-testid="subagent-working" className="flex text-[var(--cc-claude)]">
          <span className={cn(stalls && "termic-cli-stalls")} style={stallStyle}>
            <SpinnerGlyph />
          </span>
          <span className="min-w-0 flex-1 truncate whitespace-pre">
            <SpinnerMessage message={message} toolRunning={toolRunning} stallStyle={stallStyle} stallDelayMs={stallDelay} />
            {suffix && " "}
            {suffix && <span data-testid="subagent-spinner-suffix" className="text-[var(--cc-dim)]">{suffix}</span>}
          </span>
        </div>
      )}
      <div className="flex pt-[var(--row)]">
        <span className="min-w-0 flex-1 truncate whitespace-pre">
          <span aria-hidden className={STATE_DOT[state]}>{isRunning ? GLYPH.ring : MESSAGE_BULLET}</span>
          {` ${agentType}  `}
          <span className={cn(isFailed && "text-[var(--cc-error)]")}>{statusText}</span>
        </span>
        <span data-testid="subagent-footer-stats" className="shrink-0 pl-[calc(var(--cell)*2)]">{right}</span>
      </div>
    </div>
  );
}
