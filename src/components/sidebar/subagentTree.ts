// The subagent rows a claude tab draws in the sidebar, as a FLAT ordered list.
//
// Flat on purpose: the rows render as one keyed list under the tab row and
// carry their nesting as an indent. When a `.meta.json` names an agent's
// parent after its row is already on screen, the row changes position in
// that list, and React moves the same DOM node rather than unmounting one
// subtree and mounting another. A nested tree of components would remount,
// which is a frame without the row.

import type { SubagentRecord, SubagentState, TabSubagents } from "@/store/subagents";
import { subagentKind } from "@/lib/subagentKind";
import type { SubagentAutoCollapse, SubagentTypeFilter } from "@/lib/subagentPrefs";

/** Deeper agents still get a row, at this indent. */
export const MAX_SUBAGENT_INDENT_DEPTH = 3;

export interface SubagentLink {
  agentId: string;
  parentAgentId: string | null;
}

export interface SubagentTreeRow {
  agentId: string;
  /** 1 is directly under the tab row, clamped to MAX_SUBAGENT_INDENT_DEPTH. */
  depth: number;
  hasChildren: boolean;
}

export const EMPTY_SUBAGENT_TREE: readonly SubagentTreeRow[] = Object.freeze([]);

/** The rows to draw, in spawn order with each child right after its parent.
 *  `links` is in spawn order and already excludes workflow agents. An agent
 *  whose parent has no row (unknown, or a workflow agent) sits under the tab.
 *  The subtree of an agent in `folded` is left out. */
export function buildSubagentTree(
  links: readonly SubagentLink[],
  folded: ReadonlySet<string>,
): readonly SubagentTreeRow[] {
  if (links.length === 0) return EMPTY_SUBAGENT_TREE;

  const known = new Set(links.map(link => link.agentId));
  const children = new Map<string, string[]>();
  const roots: string[] = [];

  for (const link of links) {
    const parent = link.parentAgentId;
    const hasKnownParent = parent !== null && parent !== link.agentId && known.has(parent);
    if (!hasKnownParent) {
      roots.push(link.agentId);
      continue;
    }

    const siblings = children.get(parent);
    if (siblings) siblings.push(link.agentId);
    else children.set(parent, [link.agentId]);
  }

  const rows: SubagentTreeRow[] = [];
  const placed = new Set<string>();

  const place = (agentId: string, depth: number, hidden: boolean) => {
    if (placed.has(agentId)) return;
    placed.add(agentId);

    const kids = children.get(agentId) ?? [];
    if (!hidden) {
      rows.push({
        agentId,
        depth: Math.min(depth, MAX_SUBAGENT_INDENT_DEPTH),
        hasChildren: kids.length > 0,
      });
    }

    const kidsHidden = hidden || folded.has(agentId);
    for (const kid of kids) place(kid, depth + 1, kidsHidden);
  };

  for (const root of roots) place(root, 1, false);

  // Agents whose parent chain loops back on itself never hang off a root.
  // Bad metadata should not cost them their row.
  for (const link of links) place(link.agentId, 1, false);

  return rows;
}

/** What the settings decide about which rows show. `retentionMs` is how
 *  long an ended row stays (null for the whole session, 0 for not at all),
 *  measured against `now`. */
export interface SubagentRowRules {
  typeFilter: SubagentTypeFilter;
  retentionMs: number | null;
  now: number;
}

/** The states retention counts as ended. `unknown` is not one: it is what a
 *  stop leaves before the transcript says how it ended, and also what a scan
 *  makes of an agent that may still be running, so it cannot be timed out. */
const ENDED_STATES: ReadonlySet<SubagentState> = new Set(["done", "failed", "interrupted"]);

/** When an ended record ended. A record scanned from disk without an
 *  outcome has no end time, and its transcript's last write stands in. */
function endedAt(record: SubagentRecord): number {
  return record.endedAt ?? record.startedAt;
}

/** Whether retention has taken an ended row away. A running row never goes,
 *  and neither does an expired one (its transcript was deleted, which the
 *  row says itself) or one whose end is not known yet. */
export function isPastRetention(record: SubagentRecord, retentionMs: number | null, now: number): boolean {
  const hasEnded = ENDED_STATES.has(record.state);
  if (retentionMs === null || !hasEnded) return false;
  if (retentionMs === 0) return true;

  return now >= endedAt(record) + retentionMs;
}

export function isSubagentRowShown(record: SubagentRecord, rules: SubagentRowRules): boolean {
  if (record.isWorkflow) return false;

  const kind = subagentKind(record.agentType, { isWorkflow: record.isWorkflow });
  if (!rules.typeFilter[kind]) return false;

  return !isPastRetention(record, rules.retentionMs, rules.now);
}

/** The next moment retention takes a shown row away, or null when no row is
 *  waiting on one. What schedules the sidebar's one timer. */
export function nextRetentionExpiry(entry: TabSubagents | undefined, rules: SubagentRowRules): number | null {
  const hasWindow = rules.retentionMs !== null && rules.retentionMs > 0;
  if (!entry || !hasWindow) return null;

  let next: number | null = null;
  for (const agentId of entry.order) {
    const record = entry.agents[agentId];
    const isWaiting = !!record && ENDED_STATES.has(record.state) && isSubagentRowShown(record, rules);
    if (!isWaiting) continue;

    const expiry = endedAt(record) + (rules.retentionMs as number);
    if (next === null || expiry < next) next = expiry;
  }
  return next;
}

/** One string per tab that changes only when a row is added, removed, or
 *  moves to another parent. A running agent finishing leaves it as it was,
 *  which is what keeps a state change off the list component, unless
 *  `rules` hide finished rows. Without `rules` every non-workflow agent
 *  counts. */
export function subagentStructureKey(entry: TabSubagents | undefined, rules?: SubagentRowRules): string {
  if (!entry) return "";

  let key = "";
  for (const agentId of entry.order) {
    const record = entry.agents[agentId];
    if (!record || record.isWorkflow) continue;

    const isHidden = !!rules && !isSubagentRowShown(record, rules);
    if (isHidden) continue;

    key += `${agentId}>${record.parentAgentId ?? ""};`;
  }
  return key;
}

export function parseSubagentStructureKey(key: string): readonly SubagentLink[] {
  if (!key) return [];

  return key
    .split(";")
    .filter(Boolean)
    .map(part => {
      const [agentId, parent] = part.split(">");
      return { agentId, parentAgentId: parent || null };
    });
}

/** A selector for one tab's structure key, cached on the tab's entry so
 *  a write to any other tab returns at once. */
export function createSubagentStructureSelector(tabId: string, rules?: SubagentRowRules) {
  let lastEntry: TabSubagents | undefined;
  let lastKey = "";

  return (s: { byTab: Record<string, TabSubagents> }): string => {
    const entry = s.byTab[tabId];
    if (entry === lastEntry) return lastKey;

    lastEntry = entry;
    lastKey = subagentStructureKey(entry, rules);
    return lastKey;
  };
}

export function createRetentionExpirySelector(tabId: string, rules: SubagentRowRules) {
  return (s: { byTab: Record<string, TabSubagents> }): number | null =>
    nextRetentionExpiry(s.byTab[tabId], rules);
}

/** Whether a tab's subagent group starts collapsed, before the user folds
 *  it by hand. */
export function subagentGroupStartsCollapsed(
  entry: TabSubagents | undefined,
  mode: SubagentAutoCollapse,
): boolean {
  if (mode === "never") return false;
  if (mode === "always") return true;
  if (!entry) return false;

  let agentCount = 0;
  for (const agentId of entry.order) {
    const record = entry.agents[agentId];
    if (!record || record.isWorkflow) continue;
    if (record.state === "running") return false;
    agentCount++;
  }
  return agentCount > 0;
}

/** One row's own record, or null. Another agent's state change hands back
 *  the same object, since the store only replaces the record it changed. */
export function selectSubagentRecord(tabId: string, agentId: string) {
  return (s: { byTab: Record<string, TabSubagents> }): SubagentRecord | null =>
    s.byTab[tabId]?.agents[agentId] ?? null;
}

/** The fields the header predicate reads off a tab. A subagent tab is
 *  matched by its type string, so this holds before that tab type exists. */
export interface SelectableTab {
  id: string;
  type: string;
  subagentAgentId?: string | null;
}

export function subagentIdOfTab(tab: SelectableTab | null | undefined): string | null {
  const isSubagentTab = tab?.type === "subagent";
  if (!isSubagentTab) return null;

  return tab.subagentAgentId ?? null;
}

/** True when `agentId` has a row under one of `tabIds`. Workflow agents
 *  never get one. */
export function hasSubagentRow(
  byTab: Record<string, Pick<TabSubagents, "agents"> | undefined>,
  tabIds: readonly string[],
  agentId: string | null,
): boolean {
  if (agentId === null) return false;

  return tabIds.some(tabId => {
    const record = byTab[tabId]?.agents[agentId];
    return !!record && !record.isWorkflow;
  });
}

/** Whether a child row under the task header draws the selection, so the
 *  header must not draw it as well: a terminal tab row, or the row of a
 *  subagent this task renders. Anything else (an editor or diff tab, a
 *  subagent of another task, nothing active) leaves it on the header. */
export function childRowCarriesSelection(
  activeTab: SelectableTab | null | undefined,
  terminalTabIds: readonly string[],
  subagentRowIds: ReadonlySet<string>,
): boolean {
  if (!activeTab) return false;

  const isTerminalChild = terminalTabIds.includes(activeTab.id);
  const subagentId = subagentIdOfTab(activeTab);
  const isSubagentChild = subagentId !== null && subagentRowIds.has(subagentId);
  return isTerminalChild || isSubagentChild;
}
