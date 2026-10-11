// A live, read-only view of one claude subagent's transcript, drawn after
// the Claude TUI: bulleted assistant text, tool calls as `Name(input)` with
// their results hanging underneath, thinking in italics.
//
// A plain React list, windowed by hand: only the rows in and near the
// viewport are mounted, measured in a layout effect so a corrected height
// lands before the frame is painted. Row keys are entry indices in the whole
// transcript, so loading an earlier page keeps every mounted row (and its
// measured height) where it was.
//
// The Settings rendering options (thinking, tool inputs and outputs,
// truncation, auto-scroll) apply to the entries already held, so changing
// one redraws the view without reading the transcript again. Switching the
// feature off stops the read and keeps what was read on screen.
//
// Every string in a transcript is untrusted and is rendered as React text.

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { ArrowDown, ChevronDown, ChevronRight, Clock3, Eye } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SubagentTab, Task } from "@/lib/types";
import {
  EMPTY_WINDOW, formatToolInput, positionOfEntry, rowOffsets, rowsForView, shouldFollowTail, truncateLines,
  visibleRange, type TranscriptRow,
} from "@/lib/subagentTranscript";
import { openTranscriptSession, type TranscriptSession, type TranscriptSnapshot } from "@/store/subagentPreview";
import { usePrefs } from "@/store/prefs";

const ESTIMATED_ROW_PX = 28;
const OVERSCAN_PX = 600;
/** Bodies longer than this start collapsed behind "Show more". */
const COLLAPSE_CHARS = 600;
const COLLAPSE_LINES = 8;

const INITIAL: TranscriptSnapshot = { status: "loading", window: EMPTY_WINDOW, loadingEarlier: false };

function isLong(text: string): boolean {
  const lineCount = text.split("\n", COLLAPSE_LINES + 1).length;
  return text.length > COLLAPSE_CHARS || lineCount > COLLAPSE_LINES;
}

function Bullet({ className }: { className: string }) {
  return <span aria-hidden className={cn("mt-[6px] h-1.5 w-1.5 shrink-0 rounded-full", className)} />;
}

/** The corner the TUI hangs a tool result from. */
function Hook() {
  return (
    <span
      aria-hidden
      className="mt-[3px] ml-[2px] h-2 w-2 shrink-0 rounded-bl-sm border-b border-l border-[var(--color-fg-faint)]"
    />
  );
}

function Body({ text, expanded, collapsible, className }: {
  text: string;
  expanded: boolean;
  collapsible: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "min-w-0 whitespace-pre-wrap break-words",
        collapsible && !expanded && "line-clamp-6",
        className,
      )}
    >
      {text}
    </div>
  );
}

function ExpandToggle({ expanded, onToggle, t }: {
  expanded: boolean;
  onToggle: () => void;
  t: TFunction<"task">;
}) {
  return (
    <button
      data-testid="subagent-entry-expand"
      onClick={onToggle}
      className="mt-0.5 text-[11.5px] text-[var(--color-accent)] hover:underline"
    >
      {expanded ? t("subagentView.showLess") : t("subagentView.showMore")}
    </button>
  );
}

const EntryRow = memo(function EntryRow({ row, expanded, onToggle, showToolInput, maxOutputLines, t }: {
  row: TranscriptRow;
  expanded: boolean;
  onToggle: (index: number) => void;
  showToolInput: boolean;
  /** Tool output past this many lines is cut; 0 never cuts. */
  maxOutputLines: number;
  t: TFunction<"task">;
}) {
  const toggle = () => onToggle(row.index);
  const collapsible = isLong(row.text);
  const truncatedNote = row.truncated
    ? <span className="ml-1 text-[11px] text-[var(--color-fg-faint)]">({t("subagentView.truncated")})</span>
    : null;

  switch (row.kind) {
    case "userText":
      return (
        <div className="flex gap-2 rounded bg-[var(--color-bg-2)] px-2 py-1 text-[var(--color-fg-dim)]">
          <span aria-hidden className="shrink-0 text-[var(--color-fg-faint)]">&gt;</span>
          <div className="min-w-0 flex-1">
            <Body text={row.text} expanded={expanded} collapsible={collapsible} />
            {collapsible && <ExpandToggle expanded={expanded} onToggle={toggle} t={t} />}
          </div>
        </div>
      );

    case "assistantText":
      return (
        <div className="flex gap-2 text-[var(--color-fg)]">
          <Bullet className="bg-[var(--color-fg)]" />
          <div className="min-w-0 flex-1">
            <Body text={row.text} expanded={expanded} collapsible={collapsible} />
            {collapsible && <ExpandToggle expanded={expanded} onToggle={toggle} t={t} />}
          </div>
        </div>
      );

    case "thinking":
      return (
        <div className="flex gap-2 italic text-[var(--color-fg-faint)]">
          <Bullet className="bg-[var(--color-fg-faint)]" />
          <div className="min-w-0 flex-1">
            <div className="not-italic text-[11.5px] uppercase tracking-wide">{t("subagentView.thinking")}</div>
            <Body text={row.text} expanded={expanded} collapsible={collapsible} />
            {collapsible && <ExpandToggle expanded={expanded} onToggle={toggle} t={t} />}
          </div>
        </div>
      );

    case "redactedThinking":
      return (
        <div data-testid="subagent-redacted-thinking" className="flex gap-2 italic text-[var(--color-fg-faint)]">
          <Bullet className="bg-[var(--color-fg-faint)]" />
          <span>{t("subagentView.redactedThinking")}</span>
        </div>
      );

    case "toolUse": {
      const input = showToolInput ? formatToolInput(row.text) : null;
      return (
        <div className="flex gap-2 text-[var(--color-fg)]">
          <Bullet className="bg-[var(--color-ok)]" />
          <div className="min-w-0 flex-1 break-words">
            <span data-testid="subagent-tool-name" className="font-semibold">{row.toolName ?? "?"}</span>
            {input !== null && (
              <span data-testid="subagent-tool-input" className="text-[var(--color-fg-dim)]">({input})</span>
            )}
            {input !== null && truncatedNote}
          </div>
        </div>
      );
    }

    case "toolResult": {
      const output = truncateLines(row.text, maxOutputLines);
      const outputCollapsible = isLong(output.text);
      return (
        <div className={cn("ml-3 flex gap-2", row.isError ? "text-[var(--color-err)]" : "text-[var(--color-fg-dim)]")}>
          <Hook />
          <div className="min-w-0 flex-1">
            {row.isError && <div className="text-[11.5px]">{t("subagentView.toolError")}</div>}
            <Body text={output.text} expanded={expanded} collapsible={outputCollapsible} />
            {outputCollapsible && <ExpandToggle expanded={expanded} onToggle={toggle} t={t} />}
            {output.cutLines > 0 && (
              <div data-testid="subagent-lines-cut" className="text-[11px] text-[var(--color-fg-faint)]">
                {t("subagentView.linesCut", { count: output.cutLines })}
              </div>
            )}
            {truncatedNote}
          </div>
        </div>
      );
    }

    case "error":
      return (
        <div className="flex gap-2 text-[var(--color-err)]">
          <Bullet className="bg-[var(--color-err)]" />
          <div className="min-w-0 flex-1">
            <div className="text-[11.5px]">{t("subagentView.error")}</div>
            <Body text={row.text} expanded={expanded} collapsible={collapsible} />
            {collapsible && <ExpandToggle expanded={expanded} onToggle={toggle} t={t} />}
          </div>
        </div>
      );

    case "compactBoundary":
      return (
        <div
          data-testid="subagent-compact-divider"
          role="separator"
          className="flex items-center gap-3 py-1 text-[11.5px] text-[var(--color-fg-faint)]"
        >
          <span className="h-px flex-1 bg-[var(--color-border)]" />
          <span>{t("subagentView.compacted")}</span>
          <span className="h-px flex-1 bg-[var(--color-border)]" />
        </div>
      );

    case "unknown":
      return (
        <div className="text-[var(--color-fg-faint)]">
          <button
            data-testid="subagent-entry-expand"
            onClick={toggle}
            aria-expanded={expanded}
            className="flex items-center gap-1 hover:text-[var(--color-fg-dim)]"
          >
            {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            <span>{t("subagentView.unknownEntry", { kind: row.sourceKind || "?" })}</span>
          </button>
          {expanded && row.text && <Body text={row.text} expanded collapsible={false} className="ml-4" />}
        </div>
      );
  }
});

export function SubagentPane({ task, tab }: { task: Task; tab: SubagentTab }) {
  const { t } = useTranslation("task");
  const [snapshot, setSnapshot] = useState<TranscriptSnapshot>(INITIAL);
  const sessionRef = useRef<TranscriptSession | null>(null);

  const scrollerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [following, setFollowing] = useState(true);
  const followingRef = useRef(true);
  const anchorRef = useRef<{ index: number; delta: number } | null>(null);

  const heightsRef = useRef(new Map<number, number>());
  const rowElementsRef = useRef(new Map<number, HTMLElement>());
  const [layoutVersion, setLayoutVersion] = useState(0);
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(() => new Set());

  const subagentsEnabled = usePrefs(s => s.subagentsEnabled);
  const showThinking = usePrefs(s => s.subagentViewShowThinking);
  const showToolInputs = usePrefs(s => s.subagentViewShowToolInputs);
  const showToolOutputs = usePrefs(s => s.subagentViewShowToolOutputs);
  const maxOutputLines = usePrefs(s => s.subagentViewTruncateLines);
  const autoScroll = usePrefs(s => s.subagentViewAutoScroll);

  useEffect(() => {
    // Switched off: the session was already let go of, and what it read stays
    // on screen. A view that never got to read says so instead of loading.
    if (!subagentsEnabled) {
      setSnapshot(current => (current.status === "loading" ? { ...current, status: "closed" } : current));
      return;
    }

    heightsRef.current.clear();
    anchorRef.current = null;
    followingRef.current = true;
    setFollowing(true);
    setExpanded(new Set());
    setSnapshot(INITIAL);

    const session = openTranscriptSession(
      {
        taskId: task.id,
        viewTabId: tab.id,
        sessionId: tab.sessionId,
        agentId: tab.subagentAgentId,
        workflowRunId: tab.workflowRunId ?? null,
      },
      setSnapshot,
    );
    sessionRef.current = session;

    return () => {
      session.dispose();
      if (sessionRef.current === session) sessionRef.current = null;
    };
  }, [task.id, tab.id, tab.sessionId, tab.subagentAgentId, tab.workflowRunId, subagentsEnabled]);

  const { window: transcript, status, loadingEarlier } = snapshot;
  const heldRows = transcript.rows;
  const rows = useMemo(
    () => rowsForView(heldRows, { showThinking, showToolOutputs }),
    [heldRows, showThinking, showToolOutputs],
  );

  useEffect(() => {
    if (heldRows.length === 0) heightsRef.current.clear();
  }, [heldRows.length]);

  // A rendering option changes what a mounted row draws, and so its height.
  useEffect(() => {
    heightsRef.current.clear();
    setLayoutVersion(version => version + 1);
  }, [showToolInputs, maxOutputLines]);

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;

    const observer = new ResizeObserver(() => {
      setViewport(current => {
        const width = scroller.clientWidth;
        const height = scroller.clientHeight;
        const unchanged = current.width === width && current.height === height;
        return unchanged ? current : { width, height };
      });
    });
    observer.observe(scroller);
    return () => observer.disconnect();
  }, []);

  const offsets = useMemo(
    () => rowOffsets(rows.length, position => heightsRef.current.get(rows[position].index) ?? ESTIMATED_ROW_PX),
    // layoutVersion and the viewport width stand in for the measured heights,
    // which live in a ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, layoutVersion, viewport.width],
  );
  const totalHeight = offsets[rows.length];
  const range = visibleRange(offsets, scrollTop, viewport.height, OVERSCAN_PX);

  // Measure what is mounted. Runs after every render, before paint, so a row
  // whose real height differs from the estimate is placed right in the same
  // frame. A hidden pane measures nothing: its rows are all zero high.
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    const isHidden = !scroller || scroller.clientHeight === 0;
    if (isHidden) return;

    let changed = false;
    for (const [index, element] of rowElementsRef.current) {
      const height = element.offsetHeight;
      const known = heightsRef.current.get(index);
      const moved = known === undefined || Math.abs(known - height) > 0.5;
      if (height > 0 && moved) {
        heightsRef.current.set(index, height);
        changed = true;
      }
    }
    if (changed) setLayoutVersion(version => version + 1);
  });

  // Hold the view in place: at the bottom while following, otherwise on the
  // entry the user was reading, so a page loaded above it does not move it.
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller || scroller.clientHeight === 0) return;

    if (followingRef.current && autoScroll) {
      scroller.scrollTop = scroller.scrollHeight;
      return;
    }

    const anchor = anchorRef.current;
    if (!anchor) return;

    const position = positionOfEntry(rows, anchor.index);
    if (position < 0) return;

    const target = offsets[position] + anchor.delta;
    if (Math.abs(scroller.scrollTop - target) > 0.5) scroller.scrollTop = target;
  }, [offsets, rows, viewport.height, autoScroll]);

  const onScroll = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller || scroller.clientHeight === 0) return;

    const top = scroller.scrollTop;
    setScrollTop(top);

    const atBottom = shouldFollowTail(top, scroller.scrollHeight, scroller.clientHeight);
    followingRef.current = atBottom;
    setFollowing(atBottom);

    const firstShown = visibleRange(offsets, top, 0, 0).first;
    const row = rows[firstShown];
    anchorRef.current = row ? { index: row.index, delta: top - offsets[firstShown] } : null;
  }, [offsets, rows]);

  const jumpToLatest = () => {
    const scroller = scrollerRef.current;
    if (!scroller) return;

    followingRef.current = true;
    setFollowing(true);
    scroller.scrollTop = scroller.scrollHeight;
  };

  const toggleExpanded = useCallback((index: number) => {
    setExpanded(current => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }, []);

  const bindRow = (index: number) => (element: HTMLElement | null) => {
    if (element) rowElementsRef.current.set(index, element);
    else rowElementsRef.current.delete(index);
  };

  const hasEarlier = status === "live" && transcript.start > 0;
  const isExpired = status === "expired";
  const isEmpty = rows.length === 0;
  const placeholder =
    !isEmpty ? null
      : status === "loading" ? t("subagentView.loading")
        : status === "live" ? t("subagentView.empty")
          : null;
  const stoppedNote =
    status === "unreadable" ? t("subagentView.unreadable")
      : status === "closed" && !subagentsEnabled ? t("subagentView.switchedOff")
        : status === "closed" ? t("subagentView.closed")
          : null;

  return (
    <div
      data-testid="subagent-pane"
      data-subagent-status={status}
      data-agent-id={tab.subagentAgentId}
      data-transcript-start={transcript.start}
      data-entry-count={rows.length}
      aria-label={t("subagentView.ariaLabel")}
      className="relative flex h-full w-full flex-col bg-[var(--color-bg)] font-mono text-[12.5px] leading-[18px]"
    >
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-[var(--color-border-soft)] bg-[var(--color-bg-1)] px-3 text-[11.5px] text-[var(--color-fg-dim)]">
        <Eye className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">{tab.title}</span>
        <span className="shrink-0 rounded bg-[var(--color-bg-2)] px-1.5 py-0.5 text-[10.5px] text-[var(--color-fg-faint)]">
          {t("subagentView.readOnly")}
        </span>
        <span className="flex-1" />
        {hasEarlier && (
          <button
            data-testid="subagent-load-earlier"
            disabled={loadingEarlier}
            onClick={() => sessionRef.current?.loadEarlier()}
            className="shrink-0 rounded px-1.5 py-0.5 text-[var(--color-accent)] hover:bg-[var(--color-hover)] disabled:text-[var(--color-fg-faint)]"
          >
            {loadingEarlier ? t("subagentView.loadingEarlier") : t("subagentView.loadEarlier")}
          </button>
        )}
      </div>

      {isExpired && (
        <div
          data-testid="subagent-expired"
          className="flex shrink-0 items-center gap-2 border-b border-[var(--color-border-soft)] bg-[var(--color-bg-1)] px-3 py-1.5 text-[var(--color-fg-dim)]"
        >
          <Clock3 className="h-3.5 w-3.5 shrink-0 text-[var(--color-fg-faint)]" />
          <span className="font-semibold">{t("subagentView.expired")}</span>
          <span className="truncate text-[var(--color-fg-faint)]">{t("subagentView.expiredHint")}</span>
        </div>
      )}

      {stoppedNote && (
        <div
          data-testid="subagent-stopped"
          className="shrink-0 border-b border-[var(--color-border-soft)] bg-[var(--color-bg-1)] px-3 py-1.5 text-[var(--color-fg-dim)]"
        >
          {stoppedNote}
        </div>
      )}

      <div ref={scrollerRef} data-testid="subagent-scroller" onScroll={onScroll} className="relative min-h-0 flex-1 overflow-y-auto">
        {placeholder && (
          <div data-testid="subagent-placeholder" className="px-4 py-3 text-[var(--color-fg-faint)]">{placeholder}</div>
        )}
        <div style={{ height: totalHeight, position: "relative" }}>
          {rows.slice(range.first, range.end).map((row, offset) => {
            const position = range.first + offset;
            return (
              <div
                key={row.index}
                ref={bindRow(row.index)}
                data-testid="subagent-entry"
                data-entry-kind={row.kind}
                data-entry-index={row.index}
                className="absolute left-0 right-0 px-4 py-1"
                style={{ top: offsets[position] }}
              >
                <EntryRow
                  row={row}
                  expanded={expanded.has(row.index)}
                  onToggle={toggleExpanded}
                  showToolInput={showToolInputs}
                  maxOutputLines={maxOutputLines}
                  t={t}
                />
              </div>
            );
          })}
        </div>
      </div>

      {!following && rows.length > 0 && (
        <button
          data-testid="subagent-jump-latest"
          onClick={jumpToLatest}
          className="absolute bottom-3 right-4 flex items-center gap-1 rounded-full border border-[var(--color-border)] bg-[var(--color-bg-2)] px-2.5 py-1 text-[11.5px] text-[var(--color-fg)] shadow-md hover:bg-[var(--color-hover)]"
        >
          <ArrowDown className="h-3 w-3" />
          {t("subagentView.jumpToLatest")}
        </button>
      )}
    </div>
  );
}
