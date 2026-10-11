// What the subagent view draws, worked out from the entries the transcript
// read and the live tail hand over.
//
// Every string in a transcript came from a model or a tool, so all of it is
// untrusted: it is rendered as React text and never as HTML, and ANSI escapes
// are stripped here a second time even though the host strips them, because a
// view must not depend on another layer having done it.

import type { TranscriptEntry, TranscriptEntryKind } from "@/lib/types";

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

function stringField(value: unknown): string | null {
  return typeof value === "string" ? value : null;
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

  return {
    index,
    kind,
    text: kind === "redactedThinking" ? "" : stripAnsi(rawText),
    toolName: kind === "toolUse" ? stripAnsi(stringField(fields.name) ?? "") || null : null,
    isError: fields.isError === true,
    truncated: fields.truncated === true,
    sourceKind,
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
export function rowsForView(rows: readonly TranscriptRow[], options: TranscriptViewOptions): readonly TranscriptRow[] {
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
export function positionOfEntry(rows: readonly TranscriptRow[], index: number): number {
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

  const top = Math.max(0, scrollTop - overscanPx);
  const bottom = scrollTop + viewportHeight + overscanPx;

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
