// What one subagent view draws, remembered per agent across loads. Settings
// holds the defaults; a view's bottom bar records only what was changed in
// that view, so a default changed later still reaches every toggle the view
// never touched.

export interface SubagentViewConfig {
  verbose: boolean;
  showThinking: boolean;
  showToolInputs: boolean;
  showToolOutputs: boolean;
  /** Lines of tool output before the cut; 0 never cuts. */
  truncateLines: number;
  autoScroll: boolean;
}

export type SubagentViewOverrides = Partial<SubagentViewConfig>;

interface StoredOverrides {
  at: number;
  overrides: SubagentViewOverrides;
}

const LS_SUBAGENT_VIEW_CONFIGS = "subagentViewConfigs";

/** Views remembered at most; the least recently changed go first. */
export const SUBAGENT_VIEW_CONFIGS_CAP = 200;

const FLAG_KEYS = ["verbose", "showThinking", "showToolInputs", "showToolOutputs", "autoScroll"] as const;

export function subagentViewKey(sessionId: string, agentId: string): string {
  return `${sessionId}/${agentId}`;
}

function parseOverrides(value: unknown): SubagentViewOverrides {
  const isObject = typeof value === "object" && value !== null && !Array.isArray(value);
  if (!isObject) return {};

  const fields = value as Record<string, unknown>;
  const overrides: SubagentViewOverrides = {};
  for (const key of FLAG_KEYS) {
    if (typeof fields[key] === "boolean") overrides[key] = fields[key];
  }

  const lines = fields.truncateLines;
  const isWholeCount = typeof lines === "number" && Number.isInteger(lines) && lines >= 0;
  if (isWholeCount) overrides.truncateLines = lines;
  return overrides;
}

/** Every remembered view in `raw`. A malformed store or entry reads as
 *  nothing rather than throwing. */
export function parseViewConfigs(raw: string | null): Record<string, StoredOverrides> {
  if (!raw) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }

  const isObject = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
  if (!isObject) return {};

  const configs: Record<string, StoredOverrides> = {};
  for (const [key, entry] of Object.entries(parsed as Record<string, unknown>)) {
    const fields = typeof entry === "object" && entry !== null ? (entry as Record<string, unknown>) : null;
    const at = typeof fields?.at === "number" ? fields.at : 0;
    const overrides = parseOverrides(fields?.overrides);
    if (Object.keys(overrides).length > 0) configs[key] = { at, overrides };
  }
  return configs;
}

/** `configs` with `key`'s overrides merged with `patch`, stamped `now`, and
 *  only the newest `cap` views kept. */
export function withViewOverrides(
  configs: Record<string, StoredOverrides>,
  key: string,
  patch: SubagentViewOverrides,
  now: number,
  cap = SUBAGENT_VIEW_CONFIGS_CAP,
): Record<string, StoredOverrides> {
  const merged = { ...configs[key]?.overrides, ...patch };
  const next = { ...configs, [key]: { at: now, overrides: merged } };

  const newestFirst = Object.entries(next).sort(([, a], [, b]) => b.at - a.at);
  return Object.fromEntries(newestFirst.slice(0, cap));
}

export function resolveViewConfig(defaults: SubagentViewConfig, overrides: SubagentViewOverrides): SubagentViewConfig {
  return { ...defaults, ...overrides };
}

export function readViewOverrides(key: string): SubagentViewOverrides {
  try {
    return parseViewConfigs(localStorage.getItem(LS_SUBAGENT_VIEW_CONFIGS))[key]?.overrides ?? {};
  } catch {
    return {};
  }
}

export function writeViewOverrides(key: string, patch: SubagentViewOverrides): void {
  try {
    const configs = parseViewConfigs(localStorage.getItem(LS_SUBAGENT_VIEW_CONFIGS));
    const next = withViewOverrides(configs, key, patch, Date.now());
    localStorage.setItem(LS_SUBAGENT_VIEW_CONFIGS, JSON.stringify(next));
  } catch {}
}
