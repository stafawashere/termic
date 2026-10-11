// A live, read-only view of one claude subagent's transcript, drawn the way
// Claude Code draws its own terminal transcript (subagentView/EntryRow.tsx)
// in the terminal's font, so flipping between the claude tab and this one
// reads as the same screen.
//
// A plain React list, windowed by hand: only the rows in and near the
// viewport are mounted, measured in a layout effect so a corrected height
// lands before the frame is painted. Row keys are entry indices in the whole
// transcript, so loading an earlier page keeps every mounted row (and its
// measured height) where it was. A tool result draws under its call, inside
// the call's row, so a result arriving grows one row rather than adding one.
//
// The Settings rendering options (thinking, tool inputs and outputs,
// truncation, auto-scroll) apply to the entries already held, so changing
// one redraws the view without reading the transcript again. Switching the
// feature off stops the read and keeps what was read on screen.
//
// Every string in a transcript is untrusted and is rendered as React text.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SubagentTab, Task } from "@/lib/types";
import {
  EMPTY_WINDOW, pairToolCalls, positionOfEntry, rowOffsets, rowsForView, shouldFollowTail, visibleRange,
} from "@/lib/subagentTranscript";
import { transcriptStats } from "@/lib/subagentCliView";
import { openTranscriptSession, type TranscriptSession, type TranscriptSnapshot } from "@/store/subagentPreview";
import { currentTerminalStack, usePrefs } from "@/store/prefs";
import { useSubagents, type SubagentState } from "@/store/subagents";
import { EntryRow, type EntryRowOptions } from "./subagentView/EntryRow";
import { Footer, type FooterState } from "./subagentView/Footer";
import { Header } from "./subagentView/Header";
import { GLYPH } from "./subagentView/glyphs";

const ESTIMATED_ROW_PX = 28;
const OVERSCAN_PX = 600;
/** Close to the cell height xterm gives the same font. */
const LINE_HEIGHT = 1.2;

const INITIAL: TranscriptSnapshot = { status: "loading", window: EMPTY_WINDOW, loadingEarlier: false };

const FOOTER_STATES: ReadonlySet<SubagentState> = new Set<SubagentState>(["running", "done", "failed", "interrupted"]);

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
  const terminalFontId = usePrefs(s => s.terminalFontId);
  const terminalFontSize = usePrefs(s => s.terminalFontSize);
  const fontFamily = useMemo(() => currentTerminalStack(), [terminalFontId]);

  const agentOf = (s: ReturnType<typeof useSubagents.getState>) => s.byTab[tab.parentTabId]?.agents[tab.subagentAgentId];
  const agentState = useSubagents(s => agentOf(s)?.state ?? null);
  const agentStartedAt = useSubagents(s => agentOf(s)?.startedAt ?? null);
  const agentEndedAt = useSubagents(s => agentOf(s)?.endedAt ?? null);
  const agentType = useSubagents(s => agentOf(s)?.agentType ?? null);
  const agentDescription = useSubagents(s => agentOf(s)?.description ?? null);
  const workflowPhase = useSubagents(s => agentOf(s)?.workflowPhase ?? null);

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
  const pairedRows = useMemo(() => pairToolCalls(heldRows), [heldRows]);
  const rows = useMemo(
    () => rowsForView(pairedRows, { showThinking, showToolOutputs }),
    [pairedRows, showThinking, showToolOutputs],
  );
  const stats = useMemo(() => transcriptStats(heldRows), [heldRows]);

  const rowOptions = useMemo<EntryRowOptions>(
    () => ({
      showToolInput: showToolInputs,
      showToolOutput: showToolOutputs,
      maxOutputLines,
      worktreePath: task.path,
    }),
    [showToolInputs, showToolOutputs, maxOutputLines, task.path],
  );

  useEffect(() => {
    if (heldRows.length === 0) heightsRef.current.clear();
  }, [heldRows.length]);

  // A rendering option changes what a mounted row draws, and so its height.
  useEffect(() => {
    heightsRef.current.clear();
    setLayoutVersion(version => version + 1);
  }, [showToolInputs, showToolOutputs, maxOutputLines, fontFamily, terminalFontSize]);

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

  const title = agentDescription || agentType || tab.title;
  const hasFooter = agentState !== null && FOOTER_STATES.has(agentState);
  const footerState = hasFooter ? (agentState as FooterState) : null;

  // The transcript's own timestamps are exact; a record rebuilt from disk
  // only knows the file's mtime, so it is the fallback.
  const holdsTranscriptStart = transcript.start === 0;
  const knowsFirstTime = stats.firstAtMs !== null;
  const startedAt = holdsTranscriptStart && knowsFirstTime ? stats.firstAtMs! : agentStartedAt ?? 0;
  const endedAt = stats.lastAtMs ?? agentEndedAt;
  const endsAfterStart = endedAt !== null && endedAt > startedAt;
  const durationMs = endsAfterStart ? endedAt - startedAt : null;

  return (
    <div
      data-testid="subagent-pane"
      data-subagent-status={status}
      data-agent-id={tab.subagentAgentId}
      data-transcript-start={transcript.start}
      data-entry-count={rows.length}
      aria-label={t("subagentView.ariaLabel")}
      className="relative flex h-full w-full flex-col bg-[var(--color-bg)] text-[var(--color-fg)]"
      style={{ fontFamily, fontSize: terminalFontSize, lineHeight: LINE_HEIGHT }}
    >
      <Header
        title={title}
        agentType={agentType}
        model={stats.model}
        workflowPhase={workflowPhase}
        t={t}
      />

      {isExpired && (
        <div data-testid="subagent-expired" className="shrink-0 px-3 pt-[0.6em] text-[var(--color-fg-dim)]">
          <span className="font-bold">{t("subagentView.expired")}</span>
          <span className="text-[var(--color-fg-faint)]"> {GLYPH.middot} {t("subagentView.expiredHint")}</span>
        </div>
      )}

      {stoppedNote && (
        <div data-testid="subagent-stopped" className="shrink-0 px-3 pt-[0.6em] text-[var(--color-fg-dim)]">
          {stoppedNote}
        </div>
      )}

      {hasEarlier && (
        <div className="shrink-0 px-3" style={{ paddingBottom: `${LINE_HEIGHT}em` }}>
          <button
            type="button"
            data-testid="subagent-load-earlier"
            disabled={loadingEarlier}
            onClick={() => sessionRef.current?.loadEarlier()}
            className="text-left text-[var(--color-fg-faint)] hover:text-[var(--color-fg-dim)] disabled:hover:text-[var(--color-fg-faint)]"
          >
            {GLYPH.up} {loadingEarlier ? t("subagentView.loadingEarlier") : t("subagentView.loadEarlier")}
          </button>
        </div>
      )}

      <div
        ref={scrollerRef}
        data-testid="subagent-scroller"
        onScroll={onScroll}
        className="relative min-h-0 flex-1 overflow-y-auto"
      >
        {placeholder && (
          <div data-testid="subagent-placeholder" className="px-3 text-[var(--color-fg-faint)]">{placeholder}</div>
        )}
        <div style={{ height: totalHeight, position: "relative" }}>
          {rows.slice(range.first, range.end).map((viewRow, offset) => {
            const position = range.first + offset;
            return (
              <div
                key={viewRow.index}
                ref={bindRow(viewRow.index)}
                data-testid="subagent-entry"
                data-entry-kind={viewRow.kind}
                data-entry-index={viewRow.index}
                className="absolute left-0 right-0 px-3"
                style={{ top: offsets[position], paddingBottom: `${LINE_HEIGHT}em` }}
              >
                <EntryRow
                  row={viewRow.row}
                  result={viewRow.result}
                  toolState={viewRow.toolState}
                  expanded={expanded.has(viewRow.index)}
                  onToggle={toggleExpanded}
                  options={rowOptions}
                  t={t}
                />
              </div>
            );
          })}
        </div>
      </div>

      {footerState && (
        <Footer
          state={footerState}
          startedAt={startedAt}
          durationMs={durationMs}
          toolUses={stats.toolUses}
          outputTokens={stats.outputTokens}
          t={t}
        />
      )}

      {!following && rows.length > 0 && (
        <button
          type="button"
          data-testid="subagent-jump-latest"
          onClick={jumpToLatest}
          className="absolute bottom-10 right-4 rounded border border-[var(--color-border)] bg-[var(--color-bg-1)] px-[1ch] text-[var(--color-fg-dim)] hover:text-[var(--color-fg)]"
        >
          {GLYPH.down} {t("subagentView.jumpToLatest")}
        </button>
      )}
    </div>
  );
}
