// How a subagent's tool calls read in the transcript view, worked out the way
// Claude Code prints them in its own terminal: the call as `Label(args)` and
// a one-line summary of the result hanging under it.
//
// Pure, and fed only untrusted strings, so nothing here builds markup.

import type { TranscriptRow } from "@/lib/subagentTranscript";

const ARGS_MAX = 160;
const LCS_CELL_CAP = 250_000;

type Fields = Record<string, unknown>;

function parseFields(raw: string): Fields | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    const isPlainObject = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
    return isPlainObject ? (parsed as Fields) : null;
  } catch {
    return null;
  }
}

function text(fields: Fields | null, key: string): string | null {
  const value = fields?.[key];
  return typeof value === "string" ? value : null;
}

function clipArgs(value: string): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  if (oneLine.length <= ARGS_MAX) return oneLine;
  return `${oneLine.slice(0, ARGS_MAX)}...`;
}

/** A path inside the task's worktree, relative to it; anything else as is. */
export function displayPath(path: string, worktreePath: string | null): string {
  if (!worktreePath) return path;

  const root = worktreePath.replace(/\/+$/, "");
  if (path === root) return ".";

  const prefix = `${root}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

function quoted(value: string): string {
  return JSON.stringify(value);
}

function scalarText(value: unknown): string | null {
  const isScalar = typeof value === "string" || typeof value === "number" || typeof value === "boolean";
  return isScalar ? String(value) : null;
}

function flatValues(raw: string, fields: Fields | null): string {
  if (!fields) return raw;

  const scalars = Object.values(fields).map(scalarText);
  const isFlat = scalars.every(value => value !== null);
  return isFlat ? scalars.join(", ") : raw;
}

function namedValues(fields: Fields | null): string {
  if (!fields) return "";

  return Object.entries(fields)
    .map(([key, value]) => `${key}: ${typeof value === "string" ? quoted(value) : JSON.stringify(value)}`)
    .join(", ");
}

function searchArgs(fields: Fields | null, worktreePath: string | null): string {
  const pattern = text(fields, "pattern") ?? "";
  const path = text(fields, "path");
  const parts = [`pattern: ${quoted(pattern)}`];
  if (path) parts.push(`path: ${quoted(displayPath(path, worktreePath))}`);
  return parts.join(", ");
}

export interface ToolDisplay {
  label: string;
  /** One line, already clipped. Empty when the tool prints no arguments. */
  args: string;
}

/** A tool call the way Claude Code heads it. */
export function toolDisplay(name: string, inputJson: string, worktreePath: string | null): ToolDisplay {
  const fields = parseFields(inputJson);
  const pathOf = (key: string) => displayPath(text(fields, key) ?? "", worktreePath);
  const shown = (label: string, args: string): ToolDisplay => ({ label, args: clipArgs(args) });

  switch (name) {
    case "Read":
      return shown("Read", pathOf("file_path"));
    case "Write":
      return shown("Write", pathOf("file_path"));
    case "Edit":
    case "MultiEdit":
      return shown("Update", pathOf("file_path"));
    case "Bash":
      return shown("Bash", text(fields, "command") ?? "");
    case "Grep":
    case "Glob":
      return shown("Search", searchArgs(fields, worktreePath));
    case "LS":
      return shown("List", pathOf("path"));
    case "WebFetch":
      return shown("Fetch", text(fields, "url") ?? "");
    case "WebSearch":
      return shown("Web Search", quoted(text(fields, "query") ?? ""));
    case "TodoWrite":
      return { label: "Update Todos", args: "" };
    case "Task":
    case "Agent":
      return shown("Task", text(fields, "description") ?? "");
    case "NotebookEdit":
      return shown("Edit Notebook", pathOf("notebook_path"));
    case "Skill":
      return shown("Skill", text(fields, "skill") ?? text(fields, "name") ?? "");
  }

  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  if (mcp) return shown(`${mcp[1]} - ${mcp[2]} (MCP)`, namedValues(fields));

  return shown(name, flatValues(inputJson, fields));
}

export type DiffLineKind = "add" | "remove" | "context";

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
  /** The line's number in the file, when the tool's output let it be found. */
  lineNumber: number | null;
}

/** A line diff of `before` against `after`, from their longest common
 *  subsequence. Past a size where that table gets expensive it falls back to
 *  every old line removed and every new line added. */
export function lineDiff(before: string, after: string): DiffLine[] {
  const oldLines = before === "" ? [] : before.split("\n");
  const newLines = after === "" ? [] : after.split("\n");
  const line = (kind: DiffLineKind, value: string): DiffLine => ({ kind, text: value, lineNumber: null });

  const tooLarge = oldLines.length * newLines.length > LCS_CELL_CAP;
  if (tooLarge) {
    return [...oldLines.map(value => line("remove", value)), ...newLines.map(value => line("add", value))];
  }

  const width = newLines.length + 1;
  const common = new Uint32Array((oldLines.length + 1) * width);
  for (let oldAt = oldLines.length - 1; oldAt >= 0; oldAt--) {
    for (let newAt = newLines.length - 1; newAt >= 0; newAt--) {
      const same = oldLines[oldAt] === newLines[newAt];
      const below = common[(oldAt + 1) * width + newAt];
      const right = common[oldAt * width + newAt + 1];
      common[oldAt * width + newAt] = same ? common[(oldAt + 1) * width + newAt + 1] + 1 : Math.max(below, right);
    }
  }

  const diff: DiffLine[] = [];
  let oldAt = 0;
  let newAt = 0;
  while (oldAt < oldLines.length && newAt < newLines.length) {
    if (oldLines[oldAt] === newLines[newAt]) {
      diff.push(line("context", newLines[newAt]));
      oldAt++;
      newAt++;
      continue;
    }

    const dropOld = common[(oldAt + 1) * width + newAt] >= common[oldAt * width + newAt + 1];
    if (dropOld) diff.push(line("remove", oldLines[oldAt++]));
    else diff.push(line("add", newLines[newAt++]));
  }
  while (oldAt < oldLines.length) diff.push(line("remove", oldLines[oldAt++]));
  while (newAt < newLines.length) diff.push(line("add", newLines[newAt++]));
  return diff;
}

// `cat -n` puts a tab after the number; Claude's Read puts an arrow there.
const NUMBERED_LINE = /^\s*(\d+)(?:\t|→)(.*)$/;

/** Number a diff from the snippet an Edit result prints, by finding where its
 *  first new-side line sits. Lines before the edit are assumed unshifted. */
function numberDiff(diff: DiffLine[], resultText: string): DiffLine[] {
  const firstNewSide = diff.find(entry => entry.kind !== "remove");
  if (!firstNewSide) return diff;

  let start: number | null = null;
  for (const resultLine of resultText.split("\n")) {
    const match = NUMBERED_LINE.exec(resultLine);
    const isFirstNewSide = match !== null && match[2] === firstNewSide.text;
    if (isFirstNewSide) {
      start = Number(match![1]);
      break;
    }
  }
  if (start === null) return diff;

  let oldNumber = start;
  let newNumber = start;
  return diff.map(entry => {
    if (entry.kind === "remove") return { ...entry, lineNumber: oldNumber++ };
    if (entry.kind === "add") return { ...entry, lineNumber: newNumber++ };

    oldNumber++;
    return { ...entry, lineNumber: newNumber++ };
  });
}

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface TodoItem {
  content: string;
  status: TodoStatus;
}

function todosOf(fields: Fields | null): TodoItem[] {
  const raw = fields?.todos;
  if (!Array.isArray(raw)) return [];

  return raw.flatMap(item => {
    const entry = typeof item === "object" && item !== null ? (item as Fields) : null;
    const content = text(entry, "content");
    if (content === null) return [];

    const status = text(entry, "status");
    const isKnown = status === "in_progress" || status === "completed";
    return [{ content, status: isKnown ? status : "pending" }];
  });
}

export type ToolSummary =
  | { kind: "pending" }
  | { kind: "error"; lines: string[] }
  | { kind: "readLines"; count: number }
  | { kind: "foundFiles"; count: number }
  | { kind: "wrote"; path: string; count: number; lines: string[] }
  | { kind: "updated"; path: string; additions: number; removals: number; diff: DiffLine[] }
  | { kind: "todos"; todos: TodoItem[] }
  | { kind: "output"; lines: string[] }
  | { kind: "noContent" };

function outputLines(value: string): string[] {
  const trimmed = value.replace(/\s+$/, "");
  return trimmed === "" ? [] : trimmed.split("\n");
}

function withoutReminders(value: string): string {
  const reminderAt = value.indexOf("<system-reminder>");
  return reminderAt < 0 ? value : value.slice(0, reminderAt);
}

function errorLines(value: string): string[] {
  const bare = value.replace(/<\/?tool_use_error>/g, "");
  const lines = outputLines(bare);
  return lines.length > 0 ? lines : [""];
}

function foundFiles(value: string): number {
  const lines = outputLines(value);
  const counted = /^Found (\d+)/.exec(lines[0] ?? "");
  if (counted) return Number(counted[1]);

  const saysNone = /^No (files|matches) found/.test(lines[0] ?? "");
  if (saysNone) return 0;

  return lines.filter(entry => entry.trim() !== "").length;
}

function editSummary(fields: Fields | null, resultText: string, worktreePath: string | null): ToolSummary | null {
  const editsField = fields?.edits;
  const edits: Fields[] = Array.isArray(editsField)
    ? editsField.filter((edit): edit is Fields => typeof edit === "object" && edit !== null)
    : fields ? [fields] : [];

  const diff = edits.flatMap(edit => {
    const before = text(edit, "old_string");
    const after = text(edit, "new_string");
    if (before === null || after === null) return [];
    return numberDiff(lineDiff(before, after), resultText);
  });
  if (diff.length === 0) return null;

  const additions = diff.filter(entry => entry.kind === "add").length;
  const removals = diff.filter(entry => entry.kind === "remove").length;
  const path = displayPath(text(fields, "file_path") ?? "", worktreePath);
  return { kind: "updated", path, additions, removals, diff };
}

/** What hangs under a call: a one-line summary for the tools Claude Code
 *  summarises, the output itself for the rest. */
export function toolSummary(
  name: string,
  inputJson: string,
  result: Pick<TranscriptRow, "text" | "isError"> | null,
  worktreePath: string | null,
): ToolSummary {
  if (!result) return { kind: "pending" };
  if (result.isError) return { kind: "error", lines: errorLines(result.text) };

  const fields = parseFields(inputJson);
  switch (name) {
    case "Read":
      return { kind: "readLines", count: outputLines(withoutReminders(result.text)).length };
    case "Grep":
    case "Glob":
      return { kind: "foundFiles", count: foundFiles(result.text) };
    case "TodoWrite":
      return { kind: "todos", todos: todosOf(fields) };
    case "Write": {
      const lines = outputLines(text(fields, "content") ?? "");
      const path = displayPath(text(fields, "file_path") ?? "", worktreePath);
      return { kind: "wrote", path, count: lines.length, lines };
    }
    case "Edit":
    case "MultiEdit": {
      const updated = editSummary(fields, result.text, worktreePath);
      if (updated) return updated;
      break;
    }
  }

  const lines = outputLines(result.text);
  return lines.length > 0 ? { kind: "output", lines } : { kind: "noContent" };
}

/** `42s`, `1m 3s`, `2h 5m`, as Claude Code prints an elapsed time. */
export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/** `950`, `3.1k`, `1.2m`. */
export function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  if (count < 1_000_000) return `${(count / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
}

export interface TranscriptStats {
  toolUses: number;
  outputTokens: number;
  model: string | null;
  firstAtMs: number | null;
  lastAtMs: number | null;
}

function timeOf(timestamp: string | null): number | null {
  if (!timestamp) return null;

  const parsed = Date.parse(timestamp);
  return Number.isNaN(parsed) ? null : parsed;
}

/** Counts over the rows the view holds, which is the whole transcript once
 *  every earlier page is loaded and its newest part before then. */
export function transcriptStats(rows: readonly TranscriptRow[]): TranscriptStats {
  let toolUses = 0;
  let outputTokens = 0;
  let model: string | null = null;
  let firstAtMs: number | null = null;
  let lastAtMs: number | null = null;

  for (const row of rows) {
    if (row.kind === "toolUse") toolUses++;
    outputTokens += row.outputTokens ?? 0;
    if (row.model) model = row.model;

    const at = timeOf(row.timestamp);
    if (at === null) continue;

    firstAtMs ??= at;
    lastAtMs = at;
  }
  return { toolUses, outputTokens, model, firstAtMs, lastAtMs };
}
