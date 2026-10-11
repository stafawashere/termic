// The shapes and stored forms of the Claude subagent settings
// (Settings > Tasks > Claude subagents). The store lives in store/prefs.ts;
// this is what the sidebar and the transcript view need to read it without
// knowing how it is kept.

import type { SubagentKind } from "@/lib/subagentKind";

export type SubagentTypeFilter = Readonly<Record<SubagentKind, boolean>>;

/** Workflow agents are recorded but never drawn yet, so their filter ships
 *  off and the settings page does not let it change. */
export const DEFAULT_SUBAGENT_TYPE_FILTER: SubagentTypeFilter = Object.freeze({
  builtIn: true,
  custom: true,
  fork: true,
  workflow: false,
});

export type SubagentRetention = "session" | "hour" | "tenMinutes" | "finished";

export const SUBAGENT_RETENTIONS: readonly SubagentRetention[] = ["session", "hour", "tenMinutes", "finished"];

export type SubagentAutoCollapse = "never" | "allFinished" | "always";

export const SUBAGENT_AUTO_COLLAPSES: readonly SubagentAutoCollapse[] = ["never", "allFinished", "always"];

export const DEFAULT_SUBAGENT_VIEW_TRUNCATE_LINES = 40;

/** How long a row that ended stays, or null for as long as the session. */
export function retentionWindowMs(retention: SubagentRetention): number | null {
  switch (retention) {
    case "session":
      return null;
    case "hour":
      return 60 * 60 * 1000;
    case "tenMinutes":
      return 10 * 60 * 1000;
    case "finished":
      return 0;
  }
}

export function parseSubagentRetention(raw: string): SubagentRetention {
  const isKnown = (SUBAGENT_RETENTIONS as readonly string[]).includes(raw);
  return isKnown ? (raw as SubagentRetention) : "session";
}

export function parseSubagentAutoCollapse(raw: string): SubagentAutoCollapse {
  const isKnown = (SUBAGENT_AUTO_COLLAPSES as readonly string[]).includes(raw);
  return isKnown ? (raw as SubagentAutoCollapse) : "never";
}

/** "1" and "0" are the only stored answers; anything else is the default. */
export function parseStoredFlag(raw: string | null, fallback: boolean): boolean {
  if (raw === "1") return true;
  if (raw === "0") return false;
  return fallback;
}

/** A whole number of lines, 0 meaning no truncation. */
export function parseTruncateLines(raw: string | null): number {
  if (raw === null || raw.trim() === "") return DEFAULT_SUBAGENT_VIEW_TRUNCATE_LINES;

  const lines = Number(raw);
  const isWholeCount = Number.isInteger(lines) && lines >= 0;
  return isWholeCount ? lines : DEFAULT_SUBAGENT_VIEW_TRUNCATE_LINES;
}

/** Each kind falls back on its own, so one bad field does not reset the
 *  others. */
export function parseSubagentTypeFilter(raw: string | null): SubagentTypeFilter {
  let parsed: unknown = null;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    parsed = null;
  }

  const isRecord = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
  if (!isRecord) return DEFAULT_SUBAGENT_TYPE_FILTER;

  const stored = parsed as Record<string, unknown>;
  const pick = (kind: SubagentKind): boolean => {
    const value = stored[kind];
    return typeof value === "boolean" ? value : DEFAULT_SUBAGENT_TYPE_FILTER[kind];
  };

  return Object.freeze({
    builtIn: pick("builtIn"),
    custom: pick("custom"),
    fork: pick("fork"),
    workflow: pick("workflow"),
  });
}
