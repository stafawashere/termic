// What the subagent view draws, worked out from the entries the transcript
// read and the live tail hand over.
//
// Every string in a transcript came from a model or a tool, so all of it is
// untrusted: it is rendered as React text and never as HTML, and ANSI escapes
// are stripped here a second time even though the host strips them, because a
// view must not depend on another layer having done it.

import type { TranscriptEntry, TranscriptEntryKind, TranscriptResultNote } from "@/lib/types";

export type TranscriptRowKind = TranscriptEntryKind | "unknown";

export interface TranscriptRow {
  /** Index of the entry in the whole transcript. Stable across prepends, so
   *  it doubles as the React key and the measured-height key. */
  index: number;
  kind: TranscriptRowKind;
  text: string;
  /** Tool name, on `toolUse` rows only. */
  toolName: string | null;
  isError: boolean;
  truncated: boolean;
  /** The kind as the entry spelled it, kept for an `unknown` row's label. */
  sourceKind: string;
  /** Links a `toolUse` row to the `toolResult` row that answers it. */
  toolUseId: string | null;
  /** How long the model thought, on `thinking` rows. */
  durationMs: number | null;
  /** Set on the first row of an assistant message only. */
  model: string | null;
  outputTokens: number | null;
  timestamp: string | null;
  version: string | null;
  /** Dim lines under a tool result, in the order Claude prints them. */
  notes: readonly TranscriptResultNote[];
  /** A result whose file diff pulls its call out of a collapsed group. */
  popsOut: boolean;
}

const KNOWN_KINDS: ReadonlySet<string> = new Set<TranscriptEntryKind>([
  "userText",
  "assistantText",
  "thinking",
  "redactedThinking",
  "toolUse",
  "toolResult",
  "error",
  "compactBoundary",
]);

// CSI (ESC [ ... final byte) and OSC (ESC ] ... BEL or ESC \) sequences, then
// any other two-byte escape, then a stray ESC on its own.
const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[@-Z\\-_]|\x1b/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

const RESULT_NOTES: ReadonlySet<string> = new Set<TranscriptResultNote>([
  "sharedRepo", "diffSkipped", "diffUnavailable", "autoClassifier",
]);

const NO_NOTES: readonly TranscriptResultNote[] = Object.freeze([]);

function notesField(value: unknown): readonly TranscriptResultNote[] {
  if (!Array.isArray(value)) return NO_NOTES;

  const known = value.filter((note): note is TranscriptResultNote => typeof note === "string" && RESULT_NOTES.has(note));
  return known.length > 0 ? known : NO_NOTES;
}

const SYSTEM_REMINDER = /<system-reminder>[\s\S]*?(?:<\/system-reminder>|$)/g;

/** A prompt without the system reminders Claude folds into it, which its
 *  own transcript never draws. */
export function withoutSystemReminders(text: string): string {
  if (!text.includes("<system-reminder>")) return text;

  return text.replace(SYSTEM_REMINDER, "").replace(/\n{3,}/g, "\n\n").trim();
}

function stringField(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function countField(value: unknown): number | null {
  const isCount = typeof value === "number" && Number.isFinite(value) && value >= 0;
  return isCount ? value : null;
}

/** One entry as a row. Anything the mapper does not recognise, including an
 *  entry that is not an object at all, becomes an `unknown` row rather than
 *  a throw, so one odd line cannot take the whole view down. */
export function toTranscriptRow(entry: unknown, index: number): TranscriptRow {
  const isObject = typeof entry === "object" && entry !== null;
  const fields = (isObject ? entry : {}) as Partial<Record<keyof TranscriptEntry, unknown>>;
  const sourceKind = stringField(fields.kind) ?? "";
  const isKnown = KNOWN_KINDS.has(sourceKind);
  const kind: TranscriptRowKind = isKnown ? (sourceKind as TranscriptEntryKind) : "unknown";
  const rawText = stringField(fields.text) ?? "";
  const isUserText = kind === "userText";

  return {
    index,
    kind,
    text: kind === "redactedThinking" ? "" : stripAnsi(isUserText ? withoutSystemReminders(rawText) : rawText),
    toolName: kind === "toolUse" ? stripAnsi(stringField(fields.name) ?? "") || null : null,
    isError: fields.isError === true,
    truncated: fields.truncated === true,
    sourceKind,
    toolUseId: stringField(fields.toolUseId),
    durationMs: countField(fields.durationMs),
    model: stringField(fields.model),
    outputTokens: countField(fields.outputTokens),
    timestamp: stringField(fields.timestamp),
    version: stringField(fields.version),
    notes: notesField(fields.notes),
    popsOut: fields.popsOut === true,
  };
}

export function toTranscriptRows(entries: readonly unknown[], start: number): TranscriptRow[] {
  return entries.map((entry, offset) => toTranscriptRow(entry, start + offset));
}

export interface TranscriptViewOptions {
  showThinking: boolean;
  showToolOutputs: boolean;
}

/** The rows the view draws under the Settings rendering options. Tool inputs
 *  and truncation change how a row draws, not whether it does, so they are
 *  applied by the row itself. Hands back `rows` itself when nothing is
 *  hidden. */
export function rowsForView<Row extends { kind: TranscriptRowKind }>(
  rows: readonly Row[],
  options: TranscriptViewOptions,
): readonly Row[] {
  const hidesNothing = options.showThinking && options.showToolOutputs;
  if (hidesNothing) return rows;

  return rows.filter(row => {
    const isThinking = row.kind === "thinking" || row.kind === "redactedThinking";
    const isToolOutput = row.kind === "toolResult";
    const hiddenThinking = isThinking && !options.showThinking;
    const hiddenOutput = isToolOutput && !options.showToolOutputs;
    return !hiddenThinking && !hiddenOutput;
  });
}

/** `text` cut to its first `maxLines` lines, and how many lines were cut.
 *  0 lines means no cut. */
export function truncateLines(text: string, maxLines: number): { text: string; cutLines: number } {
  if (maxLines <= 0) return { text, cutLines: 0 };

  const lines = text.split("\n");
  if (lines.length <= maxLines) return { text, cutLines: 0 };

  return { text: lines.slice(0, maxLines).join("\n"), cutLines: lines.length - maxLines };
}

/** Where entry `index` sits in `rows`, which hold ascending entry indices
 *  with gaps where the view hides some, or -1. */
export function positionOfEntry(rows: readonly { index: number }[], index: number): number {
  let low = 0;
  let high = rows.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const found = rows[middle].index;
    if (found === index) return middle;
    if (found < index) low = middle + 1;
    else high = middle - 1;
  }
  return -1;
}

export type ToolCallState = "pending" | "ok" | "error";

/** One thing the view draws. A `toolUse` row carries the result that answers
 *  it, which then draws under the call instead of as a row of its own. */
export interface ViewRow {
  index: number;
  kind: TranscriptRowKind;
  row: TranscriptRow;
  result: TranscriptRow | null;
  toolState: ToolCallState | null;
}

function toolStateOf(result: TranscriptRow | null): ToolCallState {
  if (!result) return "pending";
  return result.isError ? "error" : "ok";
}

/** Hang each tool result under the call whose id it answers, and drop a
 *  prompt that held nothing but system reminders. A result whose
 *  call is not in `rows` (it sits on a page not loaded yet, or the entry
 *  carries no id) stays a row of its own. Row indices are kept, so a row's
 *  key and measured height survive a result arriving. */
export function pairToolCalls(rows: readonly TranscriptRow[]): ViewRow[] {
  const callIds = new Set<string>();
  const resultsById = new Map<string, TranscriptRow>();

  for (const row of rows) {
    const id = row.toolUseId;
    if (id === null) continue;

    if (row.kind === "toolUse") callIds.add(id);

    const isResult = row.kind === "toolResult";
    const isFirstResult = isResult && !resultsById.has(id);
    if (isFirstResult) resultsById.set(id, row);
  }

  const paired: ViewRow[] = [];
  for (const row of rows) {
    const isBlankPrompt = row.kind === "userText" && row.text.trim() === "";
    if (isBlankPrompt) continue;

    const id = row.toolUseId;
    const isResult = row.kind === "toolResult";
    const callIsHeld = id !== null && callIds.has(id);
    const isTheAnswer = id !== null && resultsById.get(id) === row;
    const answersHeldCall = isResult && callIsHeld && isTheAnswer;
    if (answersHeldCall) continue;

    if (row.kind === "toolUse") {
      const result = id === null ? null : resultsById.get(id) ?? null;
      paired.push({ index: row.index, kind: row.kind, row, result, toolState: toolStateOf(result) });
      continue;
    }

    paired.push({ index: row.index, kind: row.kind, row, result: null, toolState: null });
  }
  return paired;
}

export type DisplayRowKind = TranscriptRowKind | "group";

/** What the windowed list mounts: a single entry, or a run of tool calls
 *  and thinking that Claude Code collapses into one summary line. A group's
 *  index is its first member's, so its key survives the run growing. */
export interface DisplayRow {
  index: number;
  kind: DisplayRowKind;
  entry: ViewRow | null;
  members: readonly ViewRow[];
}

const GROUPED_KINDS: ReadonlySet<TranscriptRowKind> = new Set<TranscriptRowKind>([
  "thinking", "redactedThinking", "toolUse", "toolResult",
]);

const NO_MEMBERS: readonly ViewRow[] = Object.freeze([]);

/** Fold every run of tool calls, lone results and thinking into one group
 *  row; everything else stays a row of its own, and so does a call whose
 *  result carries a file diff, which Claude draws in full. */
export function groupToolRuns(rows: readonly ViewRow[]): DisplayRow[] {
  const display: DisplayRow[] = [];
  let run: ViewRow[] | null = null;

  for (const row of rows) {
    const popsOut = row.result?.popsOut === true;
    if (!GROUPED_KINDS.has(row.kind) || popsOut) {
      run = null;
      display.push({ index: row.index, kind: row.kind, entry: row, members: NO_MEMBERS });
      continue;
    }

    if (run) {
      run.push(row);
      continue;
    }

    run = [row];
    display.push({ index: row.index, kind: "group", entry: null, members: run });
  }
  return display;
}

const TOOL_INPUT_MAX = 240;

function scalarText(value: unknown): string | null {
  const isScalar = typeof value === "string" || typeof value === "number" || typeof value === "boolean";
  return isScalar ? String(value) : null;
}

/** A tool call's input the way the Claude TUI prints it inside the
 *  parentheses: the values of a flat object, joined. Anything nested falls
 *  back to the JSON as written. */
export function formatToolInput(raw: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return clip(raw);
  }

  const isPlainObject = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
  if (!isPlainObject) return clip(raw);

  const values = Object.values(parsed as Record<string, unknown>);
  const scalars = values.map(scalarText);
  const isFlat = scalars.every(value => value !== null);
  if (!isFlat) return clip(raw);

  return clip(scalars.join(", "));
}

function clip(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (oneLine.length <= TOOL_INPUT_MAX) return oneLine;
  return `${oneLine.slice(0, TOOL_INPUT_MAX)}...`;
}

/** How close to the bottom still counts as "at the bottom". A row of text is
 *  about 18px, so this forgives a sub-row scroll offset. */
export const FOLLOW_TAIL_THRESHOLD_PX = 24;

/** Whether the view should keep following the tail: true while the user is at
 *  the bottom (or within `threshold` of it). */
export function shouldFollowTail(
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
  threshold = FOLLOW_TAIL_THRESHOLD_PX,
): boolean {
  const distanceFromBottom = scrollHeight - clientHeight - scrollTop;
  return distanceFromBottom <= threshold;
}

/** A contiguous slice of the transcript: `rows[0]` is entry `start`. */
export interface TranscriptWindow {
  start: number;
  rows: readonly TranscriptRow[];
}

export const EMPTY_WINDOW: TranscriptWindow = Object.freeze({ start: 0, rows: Object.freeze([]) as readonly TranscriptRow[] });

export type AppendResult =
  | { kind: "unchanged" }
  | { kind: "appended"; window: TranscriptWindow }
  /** The batch starts past the window's end, so entries in between are
   *  missing and the caller must read again. */
  | { kind: "gap" };

/** Merge a live batch that starts at entry `batchStart`. Entries the window
 *  already holds are skipped, so a batch overlapping the first page adds only
 *  what is new. */
export function appendBatch(
  current: TranscriptWindow,
  batchStart: number,
  entries: readonly unknown[],
): AppendResult {
  const end = current.start + current.rows.length;
  if (batchStart > end) return { kind: "gap" };

  const fresh = entries.slice(end - batchStart);
  if (fresh.length === 0) return { kind: "unchanged" };

  const rows = [...current.rows, ...toTranscriptRows(fresh, end)];
  return { kind: "appended", window: { start: current.start, rows } };
}

/** Put an earlier page in front of the window. A page that does not end where
 *  the window starts is dropped (the file was rewritten under it). */
export function prependPage(
  current: TranscriptWindow,
  pageStart: number,
  entries: readonly unknown[],
): TranscriptWindow {
  const pageEnd = pageStart + entries.length;
  const meetsWindow = pageEnd === current.start;
  if (!meetsWindow || entries.length === 0) return current;

  return { start: pageStart, rows: [...toTranscriptRows(entries, pageStart), ...current.rows] };
}

/** Running top offset of each row, plus the total height at the end:
 *  `offsets[i]` is where row `i` starts and `offsets[count]` the list height. */
export function rowOffsets(count: number, heightOf: (position: number) => number): Float64Array {
  const offsets = new Float64Array(count + 1);
  for (let position = 0; position < count; position++) {
    offsets[position + 1] = offsets[position] + heightOf(position);
  }
  return offsets;
}

/** The rows to mount for a viewport: every row that intersects
 *  [top - overscan, top + height + overscan], as a half-open [first, end). */
export function visibleRange(
  offsets: Float64Array,
  scrollTop: number,
  viewportHeight: number,
  overscanPx: number,
): { first: number; end: number } {
  const count = offsets.length - 1;
  if (count <= 0) return { first: 0, end: 0 };

  // A scrollTop read before the content shrank can point past the end; the
  // scroller has already clamped it, so clamp it here too.
  const deepest = Math.max(0, offsets[count] - viewportHeight);
  const reachable = Math.min(scrollTop, deepest);
  const top = Math.max(0, reachable - overscanPx);
  const bottom = reachable + viewportHeight + overscanPx;

  let low = 0;
  let high = count - 1;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (offsets[middle + 1] <= top) low = middle + 1;
    else high = middle;
  }

  let end = low;
  while (end < count && offsets[end] < bottom) end++;
  return { first: low, end: Math.max(end, low + 1) };
}
