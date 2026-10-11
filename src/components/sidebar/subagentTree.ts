// The subagent rows a claude tab draws in the sidebar, as a FLAT ordered list.
//
// Flat on purpose: the rows render as one keyed list under the tab row and
// carry their nesting as an indent. When a `.meta.json` names an agent's
// parent after its row is already on screen, the row changes position in
// that list, and React moves the same DOM node rather than unmounting one
// subtree and mounting another. A nested tree of components would remount,
// which is a frame without the row.
//
// A workflow run is one row of its own, with its phases and agents after it
// in the same list, and starts collapsed: a run can hold hundreds of agents.

import type { SubagentRecord, SubagentState, TabSubagents } from "@/store/subagents";
import { subagentKind } from "@/lib/subagentKind";
import type { SubagentAutoCollapse, SubagentTypeFilter } from "@/lib/subagentPrefs";

/** Deeper agents still get a row, at this indent. */
export const MAX_SUBAGENT_INDENT_DEPTH = 3;

export interface SubagentLink {
  kind: "agent";
  agentId: string;
  parentAgentId: string | null;
}

/** A workflow run. Only an open run lists its phases and agents. */
export interface SubagentRunItem {
  kind: "run";
  runId: string;
  open: boolean;
}

export interface SubagentPhaseItem {
  kind: "phase";
  runId: string;
  index: number;
  title: string;
}

/** An agent of an open run. A null phase index is an agent whose sidecar
 *  names no phase, which sits under the run after its phases. */
export interface SubagentRunAgentItem {
  kind: "runAgent";
  runId: string;
  phaseIndex: number | null;
  agentId: string;
}

export type SubagentStructureItem = SubagentLink | SubagentRunItem | SubagentPhaseItem | SubagentRunAgentItem;

export interface SubagentAgentRow {
  kind: "agent";
  /** The agent id, which no run or phase key can equal. */
  key: string;
  agentId: string;
  /** Null for a plain agent. */
  runId: string | null;
  /** 1 is directly under the tab row, clamped to MAX_SUBAGENT_INDENT_DEPTH. */
  depth: number;
  hasChildren: boolean;
}

export interface SubagentRunRow {
  kind: "run";
  key: string;
  runId: string;
  depth: 0;
  open: boolean;
}

export interface SubagentPhaseRow {
  kind: "phase";
  key: string;
  runId: string;
  index: number;
  title: string;
  depth: 1;
}

export type SubagentTreeRow = SubagentAgentRow | SubagentRunRow | SubagentPhaseRow;

export const EMPTY_SUBAGENT_TREE: readonly SubagentTreeRow[] = Object.freeze([]);

export function runRowKey(runId: string): string {
  return `run:${runId}`;
}

/** The fold id of a phase, in the same list as the agents' fold ids. */
export function phaseRowKey(runId: string, index: number): string {
  return `phase:${runId}:${index}`;
}

/** The rows to draw, in spawn order with each child right after its parent.
 *  A run sits where its first shown agent started. An agent whose parent has
 *  no row (unknown, or a workflow agent) sits under the tab. The subtree of
 *  an agent in `folded`, and the agents of a phase in it, are left out. */
export function buildSubagentTree(
  items: readonly SubagentStructureItem[],
  folded: ReadonlySet<string>,
): readonly SubagentTreeRow[] {
  if (items.length === 0) return EMPTY_SUBAGENT_TREE;

  const links = items.filter((item): item is SubagentLink => item.kind === "agent");
  const known = new Set(links.map(link => link.agentId));
  const children = new Map<string, string[]>();
  const roots = new Set<string>();

  for (const link of links) {
    const parent = link.parentAgentId;
    const hasKnownParent = parent !== null && parent !== link.agentId && known.has(parent);
    if (!hasKnownParent) {
      roots.add(link.agentId);
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
        kind: "agent",
        key: agentId,
        agentId,
        runId: null,
        depth: Math.min(depth, MAX_SUBAGENT_INDENT_DEPTH),
        hasChildren: kids.length > 0,
      });
    }

    const kidsHidden = hidden || folded.has(agentId);
    for (const kid of kids) place(kid, depth + 1, kidsHidden);
  };

  let phaseHidden = false;
  for (const item of items) {
    switch (item.kind) {
      case "agent":
        if (roots.has(item.agentId)) place(item.agentId, 1, false);
        break;
      case "run":
        phaseHidden = false;
        rows.push({ kind: "run", key: runRowKey(item.runId), runId: item.runId, depth: 0, open: item.open });
        break;
      case "phase": {
        const key = phaseRowKey(item.runId, item.index);
        phaseHidden = folded.has(key);
        rows.push({ kind: "phase", key, runId: item.runId, index: item.index, title: item.title, depth: 1 });
        break;
      }
      case "runAgent": {
        const hasPhase = item.phaseIndex !== null;
        if (hasPhase && phaseHidden) break;

        rows.push({
          kind: "agent",
          key: item.agentId,
          agentId: item.agentId,
          runId: item.runId,
          depth: hasPhase ? 2 : 1,
          hasChildren: false,
        });
        break;
      }
    }
  }

  // Agents whose parent chain loops back on itself never hang off a root.
  // Bad metadata should not cost them their row.
  for (const link of links) place(link.agentId, 1, false);

  return rows;
}

/** The rows a tab draws for its structure key: every kind, so a tab whose
 *  only subagents are workflow agents has its run rows under the group
 *  chevron rather than a chevron with nothing under it. */
export function subagentRowsOfKey(structureKey: string, folded: ReadonlySet<string>): readonly SubagentTreeRow[] {
  return buildSubagentTree(parseSubagentStructureKey(structureKey), folded);
}

/** How far a row is indented. A run sits where a plain agent does, one
 *  step under the tab row, so everything inside it is one step deeper
 *  than its depth in the run. */
export function subagentRowIndent(row: SubagentTreeRow): number {
  const isPlainAgent = row.kind === "agent" && row.runId === null;
  const indent = isPlainAgent ? row.depth : row.depth + 1;
  return Math.min(indent, MAX_SUBAGENT_INDENT_DEPTH);
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
    const isWaiting = !!record && ENDED_STATES.has(record.state) && isDrawn(record, rules);
    if (!isWaiting) continue;

    const expiry = endedAt(record) + (rules.retentionMs as number);
    if (next === null || expiry < next) next = expiry;
  }
  return next;
}

/** A workflow agent a hook reported before any listing named its run. It
 *  has nowhere to sit until the next listing places it, and drawing it
 *  loose in the meantime would make it jump into its run a moment later. */
function isUnplacedWorkflow(record: SubagentRecord): boolean {
  return record.isWorkflow && record.workflowRunId === null;
}

/** Whether a record is drawn, inside a run or not. Without `rules` every
 *  placed agent counts. */
function isDrawn(record: SubagentRecord, rules: SubagentRowRules | undefined): boolean {
  if (isUnplacedWorkflow(record)) return false;

  return !rules || isSubagentRowShown(record, rules);
}

const NO_OPEN_RUNS: ReadonlySet<string> = new Set();

interface RunGroup {
  runId: string;
  agents: SubagentRecord[];
}

function encodeKeyPart(value: string): string {
  return encodeURIComponent(value);
}

/** A run's phases in the order the run declares them, then any phase the
 *  run file does not name, by when its earliest agent started. Each title
 *  maps to its index in that order, which is its fold id. */
function phaseIndexes(group: RunGroup, declared: readonly string[] | null | undefined): Map<string, number> {
  const indexes = new Map<string, number>();
  for (const title of declared ?? []) {
    if (!indexes.has(title)) indexes.set(title, indexes.size);
  }

  const firstSeen = new Map<string, number>();
  for (const record of group.agents) {
    const title = record.workflowPhase;
    const isUndeclared = title !== null && !indexes.has(title);
    if (!isUndeclared) continue;

    const seen = firstSeen.get(title);
    if (seen === undefined || record.startedAt < seen) firstSeen.set(title, record.startedAt);
  }

  const undeclared = [...firstSeen.keys()].sort((a, b) => (firstSeen.get(a) as number) - (firstSeen.get(b) as number));
  for (const title of undeclared) indexes.set(title, indexes.size);

  return indexes;
}

/** An open run's segments: the run, then each phase with its agents, then
 *  the agents with no phase. */
function openRunKey(group: RunGroup, entry: TabSubagents): string {
  const runPart = encodeKeyPart(group.runId);
  const indexes = phaseIndexes(group, entry.runs[group.runId]?.phases);

  const byPhase = new Map<number, string[]>();
  const unphased: string[] = [];
  for (const record of group.agents) {
    const index = record.workflowPhase === null ? undefined : indexes.get(record.workflowPhase);
    if (index === undefined) {
      unphased.push(record.agentId);
      continue;
    }

    const agents = byPhase.get(index);
    if (agents) agents.push(record.agentId);
    else byPhase.set(index, [record.agentId]);
  }

  let key = `run:${runPart}:open;`;
  for (const [title, index] of indexes) {
    const agents = byPhase.get(index);
    if (!agents) continue;

    key += `phase:${runPart}:${index}:${encodeKeyPart(title)};`;
    for (const agentId of agents) key += `wf:${runPart}:${index}:${agentId};`;
  }
  for (const agentId of unphased) key += `wf:${runPart}::${agentId};`;

  return key;
}

/** One string per tab that changes only when a row is added, removed, or
 *  moves to another parent. A running agent finishing leaves it as it was,
 *  which is what keeps a state change off the list component, unless
 *  `rules` hide finished rows. Without `rules` every placed agent counts.
 *
 *  A run not in `openRuns` is one `run:<id>` segment however many agents it
 *  has, so its agents starting and stopping never reach the list. A run
 *  sits where its first shown agent started, and a run whose agents are all
 *  hidden has no segment. */
export function subagentStructureKey(
  entry: TabSubagents | undefined,
  rules?: SubagentRowRules,
  openRuns: ReadonlySet<string> = NO_OPEN_RUNS,
): string {
  if (!entry) return "";

  const parts: (string | RunGroup)[] = [];
  const groups = new Map<string, RunGroup>();
  for (const agentId of entry.order) {
    const record = entry.agents[agentId];
    if (!record || !isDrawn(record, rules)) continue;

    if (!record.isWorkflow) {
      parts.push(`${agentId}>${record.parentAgentId ?? ""};`);
      continue;
    }

    const runId = record.workflowRunId as string;
    const group = groups.get(runId);
    if (group) {
      group.agents.push(record);
      continue;
    }

    const created: RunGroup = { runId, agents: [record] };
    groups.set(runId, created);
    parts.push(created);
  }

  let key = "";
  for (const part of parts) {
    if (typeof part === "string") {
      key += part;
      continue;
    }

    const isOpen = openRuns.has(part.runId);
    key += isOpen ? openRunKey(part, entry) : `run:${encodeKeyPart(part.runId)};`;
  }
  return key;
}

function parseKeyPart(part: string): SubagentStructureItem {
  const fields = part.split(":");
  switch (fields[0]) {
    case "run":
      return { kind: "run", runId: decodeURIComponent(fields[1]), open: fields[2] === "open" };
    case "phase":
      return {
        kind: "phase",
        runId: decodeURIComponent(fields[1]),
        index: Number(fields[2]),
        title: decodeURIComponent(fields[3]),
      };
    case "wf":
      return {
        kind: "runAgent",
        runId: decodeURIComponent(fields[1]),
        phaseIndex: fields[2] === "" ? null : Number(fields[2]),
        agentId: fields[3],
      };
  }

  const [agentId, parent] = part.split(">");
  return { kind: "agent", agentId, parentAgentId: parent || null };
}

/** Agent ids never hold a `:`, so a run, phase or run agent segment cannot
 *  be read as a plain agent. */
export function parseSubagentStructureKey(key: string): readonly SubagentStructureItem[] {
  if (!key) return [];

  return key.split(";").filter(Boolean).map(parseKeyPart);
}

/** A selector for one tab's structure key, cached on the tab's entry so
 *  a write to any other tab returns at once. */
export function createSubagentStructureSelector(
  tabId: string,
  rules?: SubagentRowRules,
  openRuns?: ReadonlySet<string>,
) {
  let lastEntry: TabSubagents | undefined;
  let lastKey = "";

  return (s: { byTab: Record<string, TabSubagents> }): string => {
    const entry = s.byTab[tabId];
    if (entry === lastEntry) return lastKey;

    lastEntry = entry;
    lastKey = subagentStructureKey(entry, rules, openRuns);
    return lastKey;
  };
}

export function createRetentionExpirySelector(tabId: string, rules: SubagentRowRules) {
  return (s: { byTab: Record<string, TabSubagents> }): number | null =>
    nextRetentionExpiry(s.byTab[tabId], rules);
}

/** Whether a tab's subagent group starts collapsed, before the user folds
 *  it by hand. Only the agents `rules` show count, run agents included. */
export function subagentGroupStartsCollapsed(
  entry: TabSubagents | undefined,
  mode: SubagentAutoCollapse,
  rules?: SubagentRowRules,
): boolean {
  if (mode === "never") return false;
  if (mode === "always") return true;
  if (!entry) return false;

  let agentCount = 0;
  for (const agentId of entry.order) {
    const record = entry.agents[agentId];
    if (!record || !isDrawn(record, rules)) continue;
    if (record.state === "running") return false;
    agentCount++;
  }
  return agentCount > 0;
}

/** A run row's counts as `running/total/failed`, over the agents `rules`
 *  show. A string, so the row re-renders only when a count moves and not on
 *  every write to its tab. */
export function workflowRunCounts(
  entry: TabSubagents | undefined,
  runId: string,
  rules?: SubagentRowRules,
): string {
  let running = 0;
  let total = 0;
  let failed = 0;
  for (const agentId of entry?.order ?? []) {
    const record = entry?.agents[agentId];
    const isInRun = !!record && record.workflowRunId === runId && isDrawn(record, rules);
    if (!isInRun) continue;

    total++;
    if (record.state === "running") running++;
    if (record.state === "failed") failed++;
  }
  return `${running}/${total}/${failed}`;
}

export function createWorkflowRunCountsSelector(tabId: string, runId: string, rules?: SubagentRowRules) {
  let lastEntry: TabSubagents | undefined;
  let lastCounts = workflowRunCounts(undefined, runId, rules);

  return (s: { byTab: Record<string, TabSubagents> }): string => {
    const entry = s.byTab[tabId];
    if (entry === lastEntry) return lastCounts;

    lastEntry = entry;
    lastCounts = workflowRunCounts(entry, runId, rules);
    return lastCounts;
  };
}

/** The run's name from its state file, or its id (with the `wf_` prefix
 *  kept) until that is read, so a run row is never blank. */
export function workflowRunName(entry: TabSubagents | undefined, runId: string): string {
  return entry?.runs[runId]?.name || runId;
}

export function selectWorkflowRunName(tabId: string, runId: string) {
  return (s: { byTab: Record<string, TabSubagents> }): string => workflowRunName(s.byTab[tabId], runId);
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

/** Whether the run `runId` draws a row: some agent of it is shown. */
function isRunDrawn(entry: Pick<TabSubagents, "agents">, runId: string, rules: SubagentRowRules): boolean {
  for (const record of Object.values(entry.agents)) {
    const isShownInRun = record.workflowRunId === runId && isSubagentRowShown(record, rules);
    if (isShownInRun) return true;
  }
  return false;
}

/** True when `agentId` is drawn under one of `tabIds`. A workflow agent
 *  counts while its run is drawn, collapsed or not, since the run row is
 *  where the selection shows. Without `rules` every placed agent counts. */
export function hasSubagentRow(
  byTab: Record<string, Pick<TabSubagents, "agents"> | undefined>,
  tabIds: readonly string[],
  agentId: string | null,
  rules?: SubagentRowRules,
): boolean {
  if (agentId === null) return false;

  return tabIds.some(tabId => {
    const entry = byTab[tabId];
    const record = entry?.agents[agentId];
    if (!entry || !record || isUnplacedWorkflow(record)) return false;
    if (!rules) return true;

    if (!record.isWorkflow) return isSubagentRowShown(record, rules);
    return isRunDrawn(entry, record.workflowRunId as string, rules);
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
