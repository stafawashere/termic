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

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import type { SubagentTab, Task } from "@/lib/types";
import {
  EMPTY_WINDOW, groupToolRuns, pairToolCalls, positionOfEntry, rowOffsets, rowsForView, shouldFollowTail, visibleRange,
  type DisplayRow,
} from "@/lib/subagentTranscript";
import { spinnerMessage, toolDisplay, transcriptStats } from "@/lib/subagentCliView";
import { isAnsiTheme, paletteStyle, resolveClaudePalette, STALL_RED } from "@/lib/claudePalette";
import { TERMINAL_FONT_WEIGHT } from "@/lib/terminalCell";
import { useClaudeTheme } from "@/store/claudeTheme";
import { isSubagentVerboseChord } from "@/lib/shortcuts";
import { openTranscriptSession, type TranscriptSession, type TranscriptSnapshot } from "@/store/subagentPreview";
import { currentTerminalStack, currentTerminalTheme, usePrefs, useResolvedThemeFull } from "@/store/prefs";
import { useSubagents, type SubagentState } from "@/store/subagents";
import { EntryRow, GroupRow, type EntryRowOptions } from "./subagentView/EntryRow";
import { useTerminalCell } from "./subagentView/useTerminalCell";
import { Footer, type FooterState } from "./subagentView/Footer";
import { Header } from "./subagentView/Header";
import { BottomBar } from "./subagentView/BottomBar";
import { GLYPH } from "./subagentView/glyphs";

const ESTIMATED_ROW_PX = 28;

// xterm's own padding around the grid (index.css `.xterm`) and its
// scrollbar, so this view's columns land where the terminal's do.
const XTERM_PADDING = "8px 6px 8px 10px";
const XTERM_PADDING_X_PX = 16;
const XTERM_SCROLLBAR_PX = 8;
const OVERSCAN_PX = 600;

const INITIAL: TranscriptSnapshot = { status: "loading", window: EMPTY_WINDOW, loadingEarlier: false };

const FOOTER_STATES: ReadonlySet<SubagentState> = new Set<SubagentState>(["running", "done", "failed", "interrupted"]);

export function SubagentPane({ task, tab }: { task: Task; tab: SubagentTab }) {
  const { t } = useTranslation("task");
  const [snapshot, setSnapshot] = useState<TranscriptSnapshot>(INITIAL);
  const sessionRef = useRef<TranscriptSession | null>(null);

  const scrollerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const rootRef = useRef<HTMLDivElement>(null);
  const [paneWidth, setPaneWidth] = useState(0);
  const [following, setFollowing] = useState(true);
  const followingRef = useRef(true);
  const anchorRef = useRef<{ index: number; delta: number } | null>(null);

  const heightsRef = useRef(new Map<number, number>());
  const rowElementsRef = useRef(new Map<number, HTMLElement>());
  const [layoutVersion, setLayoutVersion] = useState(0);
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(() => new Set());
  const [unfoldedGroups, setUnfoldedGroups] = useState<ReadonlySet<number>>(() => new Set());
  const [verbose, setVerbose] = useState(false);

  const subagentsEnabled = usePrefs(s => s.subagentsEnabled);
  const showThinking = usePrefs(s => s.subagentViewShowThinking);
  const showToolInputs = usePrefs(s => s.subagentViewShowToolInputs);
  const showToolOutputs = usePrefs(s => s.subagentViewShowToolOutputs);
  const maxOutputLines = usePrefs(s => s.subagentViewTruncateLines);
  const autoScroll = usePrefs(s => s.subagentViewAutoScroll);
  const terminalFontId = usePrefs(s => s.terminalFontId);
  const terminalFontSize = usePrefs(s => s.terminalFontSize);
  const terminalLetterSpacing = usePrefs(s => s.terminalLetterSpacing);
  const fontFamily = useMemo(() => currentTerminalStack(), [terminalFontId]);
  const cell = useTerminalCell(fontFamily, terminalFontSize, terminalLetterSpacing);

  const termicTheme = useResolvedThemeFull();
  const claudeTheme = useClaudeTheme(task.id, tab.sessionId);
  const paneStyle = useMemo<CSSProperties>(() => {
    const terminal = currentTerminalTheme();
    const palette = resolveClaudePalette(claudeTheme, terminal);
    return {
      ...paletteStyle(palette),
      "--cc-dim": palette.inactive,
      "--cc-stall": isAnsiTheme(claudeTheme) ? palette.error : STALL_RED,
      "--cell": `${cell.width}px`,
      "--row": `${cell.height}px`,
      fontFamily,
      fontSize: terminalFontSize,
      fontWeight: TERMINAL_FONT_WEIGHT,
      lineHeight: `${cell.height}px`,
      letterSpacing: `${terminalLetterSpacing}px`,
      background: terminal.background,
      color: palette.text,
    } as CSSProperties;
    // termicTheme stands in for the terminal palette currentTerminalTheme reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [claudeTheme, termicTheme, cell, fontFamily, terminalFontSize, terminalLetterSpacing]);

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
    setUnfoldedGroups(new Set());
    setSnapshot(INITIAL);

    const isAgentRunning = () => {
      const agent = useSubagents.getState().byTab[tab.parentTabId]?.agents[tab.subagentAgentId];
      return agent?.state === "running";
    };
    const session = openTranscriptSession(
      {
        taskId: task.id,
        viewTabId: tab.id,
        sessionId: tab.sessionId,
        agentId: tab.subagentAgentId,
        workflowRunId: tab.workflowRunId ?? null,
        isAgentRunning,
      },
      setSnapshot,
    );
    sessionRef.current = session;

    return () => {
      session.dispose();
      if (sessionRef.current === session) sessionRef.current = null;
    };
  }, [task.id, tab.id, tab.sessionId, tab.subagentAgentId, tab.parentTabId, tab.workflowRunId, subagentsEnabled]);

  const { window: transcript, status, loadingEarlier } = snapshot;
  const heldRows = transcript.rows;
  const pairedRows = useMemo(() => pairToolCalls(heldRows), [heldRows]);
  const rows = useMemo<DisplayRow[]>(
    () => groupToolRuns(rowsForView(pairedRows, { showThinking, showToolOutputs })),
    [pairedRows, showThinking, showToolOutputs],
  );
  const stats = useMemo(() => transcriptStats(heldRows), [heldRows]);

  const rowOptions = useMemo<EntryRowOptions>(
    () => ({
      showToolInput: showToolInputs,
      showToolOutput: showToolOutputs,
      maxOutputLines,
      worktreePath: task.path,
      verbose,
    }),
    [showToolInputs, showToolOutputs, maxOutputLines, task.path, verbose],
  );

  useEffect(() => {
    if (heldRows.length === 0) heightsRef.current.clear();
  }, [heldRows.length]);

  // A rendering option changes what a mounted row draws, and so its height.
  useEffect(() => {
    heightsRef.current.clear();
    setLayoutVersion(version => version + 1);
  }, [showToolInputs, showToolOutputs, maxOutputLines, cell, verbose]);

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

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const observer = new ResizeObserver(() => setPaneWidth(root.clientWidth));
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  const gridWidth = paneWidth - XTERM_PADDING_X_PX - XTERM_SCROLLBAR_PX;
  const columns = cell.width > 0 ? Math.max(1, Math.floor(gridWidth / cell.width)) : 0;
  const contentWidth = columns > 0 ? `${columns * cell.width}px` : "100%";

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

  const toggleGroup = useCallback((index: number) => {
    setUnfoldedGroups(current => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }, []);

  // ctrl+o, as in Claude Code: every group unfolds into its calls, or folds
  // back to its summary line.
  const toggleVerbose = useCallback(() => {
    setVerbose(current => !current);
    setUnfoldedGroups(new Set());
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!isSubagentVerboseChord(event)) return;

    event.preventDefault();
    toggleVerbose();
  };

  const bindRow = (index: number) => (element: HTMLElement | null) => {
    if (element) rowElementsRef.current.set(index, element);
    else rowElementsRef.current.delete(index);
  };

  const hasEarlier = status === "live" && transcript.start > 0;
  const isGone = status === "missing" || status === "expired";
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

  const isRunning = agentState === "running";
  const lastRow = rows[rows.length - 1];
  const pendingCall = lastRow?.kind === "group"
    ? [...lastRow.members].reverse().find(member => member.toolState === "pending") ?? null
    : null;
  const activeGroupIndex = isRunning && pendingCall ? lastRow.index : null;
  const pendingDisplay = pendingCall ? toolDisplay(pendingCall.row.toolName ?? "?", pendingCall.row.text, task.path) : null;
  const pendingActivity = pendingDisplay
    ? pendingDisplay.args ? `${pendingDisplay.label}(${pendingDisplay.args})` : pendingDisplay.label
    : null;
  const activity = isRunning ? agentDescription || pendingActivity : null;
  const spinnerMessageText = useMemo(() => spinnerMessage(heldRows), [heldRows]);
  const newestKind = heldRows[heldRows.length - 1]?.kind;
  const newestIsThinking = newestKind === "thinking" || newestKind === "redactedThinking";
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

  const modeLine = <BottomBar verbose={verbose} onToggleVerbose={toggleVerbose} t={t} />;

  const goneTitle =
    status === "expired" ? t("subagentView.expired")
      : isRunning ? t("subagentView.missing")
        : t("subagentView.missingDone");
  const goneHint =
    status === "expired" ? t("subagentView.expiredHint")
      : isRunning ? t("subagentView.missingHint")
        : t("subagentView.missingDoneHint");

  return (
    <div
      ref={rootRef}
      data-testid="subagent-pane"
      data-subagent-status={status}
      data-agent-id={tab.subagentAgentId}
      data-transcript-start={transcript.start}
      data-entry-count={rows.length}
      data-claude-theme={claudeTheme}
      data-verbose={verbose}
      data-columns={columns}
      aria-label={t("subagentView.ariaLabel")}
      tabIndex={0}
      onKeyDown={onKeyDown}
      className="relative flex h-full w-full flex-col outline-none"
      style={{ ...paneStyle, padding: XTERM_PADDING, "--content": contentWidth } as CSSProperties}
    >
      <div className="shrink-0 w-[var(--content)]">
        <Header
          agentType={agentType}
          description={agentDescription}
          model={stats.model}
          version={stats.version}
          workflowPhase={workflowPhase}
          t={t}
        />

        {isGone && (
          <div data-testid="subagent-expired" data-gone={status} className="pb-[var(--row)] text-[var(--cc-dim)]">
            {goneTitle} {GLYPH.middot} {goneHint}
          </div>
        )}

        {stoppedNote && (
          <div data-testid="subagent-stopped" className="pb-[var(--row)] text-[var(--cc-dim)]">
            {stoppedNote}
          </div>
        )}

        {hasEarlier && (
          <div className="pb-[var(--row)]">
            <button
              type="button"
              data-testid="subagent-load-earlier"
              disabled={loadingEarlier}
              onClick={() => sessionRef.current?.loadEarlier()}
              className="text-left text-[var(--cc-dim)] hover:text-[var(--cc-inactive)] disabled:hover:text-[var(--cc-dim)]"
            >
              {GLYPH.up} {loadingEarlier ? t("subagentView.loadingEarlier") : t("subagentView.loadEarlier")}
            </button>
          </div>
        )}
      </div>

      <div
        ref={scrollerRef}
        data-testid="subagent-scroller"
        onScroll={onScroll}
        className="relative min-h-0 flex-1 overflow-y-auto"
      >
        {placeholder && (
          <div data-testid="subagent-placeholder" className="text-[var(--cc-dim)]">{placeholder}</div>
        )}
        <div style={{ height: totalHeight, position: "relative" }}>
          {rows.slice(range.first, range.end).map((displayRow, offset) => {
            const position = range.first + offset;
            const entry = displayRow.entry;
            return (
              <div
                key={displayRow.index}
                ref={bindRow(displayRow.index)}
                data-testid="subagent-entry"
                data-entry-kind={displayRow.kind}
                data-entry-index={displayRow.index}
                className="absolute left-0 w-[var(--content)] pb-[var(--row)]"
                style={{ top: offsets[position] }}
              >
                {entry ? (
                  <EntryRow
                    row={entry.row}
                    result={entry.result}
                    toolState={entry.toolState}
                    expanded={expanded.has(entry.index)}
                    onToggle={toggleExpanded}
                    options={rowOptions}
                    t={t}
                  />
                ) : (
                  <GroupRow
                    index={displayRow.index}
                    members={displayRow.members}
                    unfolded={verbose || unfoldedGroups.has(displayRow.index)}
                    active={activeGroupIndex === displayRow.index}
                    expandedEntries={expanded}
                    onToggleGroup={toggleGroup}
                    onToggleEntry={toggleExpanded}
                    options={rowOptions}
                    t={t}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>

      {footerState && (
        <div className="shrink-0 w-[var(--content)]">
          <Footer
            state={footerState}
            agentType={agentType ?? tab.title}
            activity={activity}
            message={spinnerMessageText}
            toolRunning={pendingCall !== null}
            thinking={newestIsThinking}
            lastAtMs={stats.lastAtMs}
            stallStepped={isAnsiTheme(claudeTheme)}
            startedAt={startedAt}
            durationMs={durationMs}
            toolUses={stats.toolUses}
            outputTokens={stats.outputTokens}
            modeLine={modeLine}
            t={t}
          />
        </div>
      )}

      {!footerState && <div className="shrink-0 w-[var(--content)]">{modeLine}</div>}

      {!following && rows.length > 0 && (
        <button
          type="button"
          data-testid="subagent-jump-latest"
          onClick={jumpToLatest}
          className="absolute bottom-[calc(var(--row)*4)] right-[calc(var(--cell)*2)] bg-[var(--cc-userMessageBackground)] px-[var(--cell)] text-[var(--cc-inactive)] hover:text-[var(--cc-text)]"
        >
          {GLYPH.down} {t("subagentView.jumpToLatest")}
        </button>
      )}
    </div>
  );
}
