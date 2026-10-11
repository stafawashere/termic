// The subagents each claude tab has spawned, as the sidebar draws them.
//
// Its own store rather than a field on TerminalTab, for the same reason as
// useAgentUsage: a workflow can start and stop dozens of agents in a few
// seconds, and every write on useApp copies its whole state and re-runs every
// mounted tab bar's and sidebar row's selector (docs/performance.md bear traps
// 5 and 8). Here a write wakes only the one tab's subagent list.
//
// In memory only. A relaunch rebuilds what it can from the transcripts on
// disk, and nothing a subagent was asked to do is ever persisted.
//
// A subagent is information about its parent, never state for it: nothing in
// this file badges a tab, rings, or ends a turn.

import { create } from "zustand";
import * as ipc from "@/lib/ipc";
import type { SubagentSummary } from "@/lib/types";
import {
  normalizeAgentId, sessionMatches, setSubagentEventSink,
  type SubagentEventOrigin, type SubagentHookEvent,
} from "@/lib/subagentHooks";

export type SubagentState = "running" | "done" | "failed" | "interrupted" | "unknown" | "expired";

/** Where a running record can go. `unknown` is what a stop hook leaves, since
 *  SubagentStop carries no outcome; the transcript read upgrades it. */
export type SubagentEndState = Exclude<SubagentState, "running">;

/** The agent type claude gives every agent a workflow runs. */
export const WORKFLOW_AGENT_TYPE = "workflow-subagent";

export interface SubagentRecord {
  agentId: string;
  agentType: string;
  isWorkflow: boolean;
  state: SubagentState;
  startedAt: number;
  endedAt: number | null;
  /** Who created the record. A rebuild from disk must never overwrite what a
   *  hook reported live. */
  source: "hook" | "scan";
  description?: string | null;
  spawnDepth?: number | null;
  parentAgentId?: string | null;
}

export interface TabSubagents {
  taskId: string;
  sessionId: string;
  agents: Record<string, SubagentRecord>;
  /** Agent ids in the order they started. */
  order: string[];
}

interface SubagentsState {
  byTab: Record<string, TabSubagents>;
  start: (taskId: string, tabId: string, sessionId: string, rawAgentId: string, agentType: string) => void;
  stop: (tabId: string, rawAgentId: string, end: SubagentEndState) => void;
  /** The tab's process died: whatever was still running never finished. */
  markInterrupted: (tabId: string) => void;
  /** The tab now runs `sessionId`. Records from any other session go. */
  setSession: (tabId: string, sessionId: string | null) => void;
  forget: (tabId: string) => void;
  /** Fold in what `subagent_list` read from disk for this tab's session. */
  applySummaries: (tabId: string, sessionId: string, summaries: SubagentSummary[]) => void;
  /** Rebuild a tab's records from a directory scan. Creates the records a
   *  hook never reported; a record a hook did report keeps its state except
   *  for the `unknown` a stop leaves, which a final outcome upgrades.
   *  `parentLive` is whether the tab's claude process is running now. */
  mergeScanned: (
    taskId: string, tabId: string, sessionId: string, summaries: SubagentSummary[], parentLive: boolean,
  ) => void;
}

const FINISHED_STATES: ReadonlySet<SubagentState> = new Set(["done", "failed"]);

export const EMPTY_SUBAGENTS: readonly SubagentRecord[] = Object.freeze([]);

function withRecord(entry: TabSubagents, record: SubagentRecord): TabSubagents {
  return { ...entry, agents: { ...entry.agents, [record.agentId]: record } };
}

function metaChanged(record: SubagentRecord, summary: SubagentSummary): boolean {
  const descriptionMoved = (record.description ?? null) !== summary.description;
  const depthMoved = (record.spawnDepth ?? null) !== summary.spawnDepth;
  const parentMoved = (record.parentAgentId ?? null) !== summary.parentAgentId;
  return descriptionMoved || depthMoved || parentMoved;
}

function scannedState(summary: SubagentSummary, parentLive: boolean): SubagentState | null {
  switch (summary.outcome) {
    case "done":
    case "failed":
      return summary.outcome;
    case "none":
      return parentLive ? "unknown" : "interrupted";
    default:
      return null;
  }
}

function scannedRecord(summary: SubagentSummary, state: SubagentState): SubagentRecord {
  const isFinished = FINISHED_STATES.has(state);
  const agentType = summary.agentType ?? (summary.isWorkflow ? WORKFLOW_AGENT_TYPE : "subagent");

  return {
    agentId: summary.agentId,
    agentType,
    isWorkflow: summary.isWorkflow || agentType === WORKFLOW_AGENT_TYPE,
    state,
    startedAt: summary.mtimeMs,
    endedAt: isFinished ? summary.mtimeMs : null,
    source: "scan",
    description: summary.description,
    spawnDepth: summary.spawnDepth,
    parentAgentId: summary.parentAgentId,
  };
}

/** What a scan makes of a record that already exists, or the same object
 *  when it changes nothing. */
function rescanned(current: SubagentRecord, summary: SubagentSummary, parentLive: boolean): SubagentRecord {
  let record = current;
  if (metaChanged(record, summary)) {
    record = {
      ...record,
      description: summary.description,
      spawnDepth: summary.spawnDepth,
      parentAgentId: summary.parentAgentId,
    };
  }

  const scanned = scannedState(summary, parentLive);
  const isFinal = scanned === "done" || scanned === "failed";
  const isFinished = FINISHED_STATES.has(record.state);
  const hookLeftUnknown = record.source === "hook" && record.state === "unknown";
  const scanMayMove = record.source === "scan" && !isFinished && scanned !== null;
  const shouldMove = (hookLeftUnknown && isFinal) || scanMayMove;

  const target = shouldMove ? scanned : null;
  if (target && target !== record.state) {
    record = { ...record, state: target, endedAt: isFinal ? summary.mtimeMs : record.endedAt };
  }
  return record;
}

export const useSubagents = create<SubagentsState>((set, get) => ({
  byTab: {},

  start: (taskId, tabId, sessionId, rawAgentId, agentType) => {
    const agentId = normalizeAgentId(rawAgentId);
    if (!agentId) return;

    const entry = get().byTab[tabId];
    const isForeignSession = !!entry && entry.sessionId !== sessionId;
    const isKnownAgent = !!entry?.agents[agentId];
    if (isForeignSession || isKnownAgent) return;

    const record: SubagentRecord = {
      agentId,
      agentType,
      isWorkflow: agentType === WORKFLOW_AGENT_TYPE,
      state: "running",
      startedAt: Date.now(),
      endedAt: null,
      source: "hook",
    };
    const base: TabSubagents = entry ?? { taskId, sessionId, agents: {}, order: [] };
    const next = { ...withRecord(base, record), order: [...base.order, agentId] };

    set(s => ({ byTab: { ...s.byTab, [tabId]: next } }));
  },

  stop: (tabId, rawAgentId, end) => {
    const agentId = normalizeAgentId(rawAgentId);
    if (!agentId) return;

    const entry = get().byTab[tabId];
    const record = entry?.agents[agentId];
    if (!entry || !record) return;

    const isRepeat = record.state === end;
    const wouldDowngrade = FINISHED_STATES.has(record.state) && !FINISHED_STATES.has(end);
    if (isRepeat || wouldDowngrade) return;

    const ended: SubagentRecord = {
      ...record,
      state: end,
      endedAt: record.endedAt ?? Date.now(),
      source: "hook",
    };

    set(s => ({ byTab: { ...s.byTab, [tabId]: withRecord(entry, ended) } }));
  },

  markInterrupted: tabId => {
    const entry = get().byTab[tabId];
    if (!entry) return;

    const running = entry.order.filter(id => entry.agents[id].state === "running");
    if (running.length === 0) return;

    const now = Date.now();
    const agents = { ...entry.agents };
    for (const agentId of running) {
      agents[agentId] = { ...agents[agentId], state: "interrupted", endedAt: now };
    }

    set(s => ({ byTab: { ...s.byTab, [tabId]: { ...entry, agents } } }));
  },

  setSession: (tabId, sessionId) => {
    const entry = get().byTab[tabId];
    if (!entry || entry.sessionId === sessionId) return;

    get().forget(tabId);
  },

  forget: tabId => {
    if (!(tabId in get().byTab)) return;

    set(s => {
      const byTab = { ...s.byTab };
      delete byTab[tabId];
      return { byTab };
    });
  },

  applySummaries: (tabId, sessionId, summaries) => {
    const entry = get().byTab[tabId];
    if (!entry || entry.sessionId !== sessionId) return;

    let agents: Record<string, SubagentRecord> | null = null;
    for (const summary of summaries) {
      const current: SubagentRecord | undefined = (agents ?? entry.agents)[summary.agentId];
      if (!current) continue;

      let record: SubagentRecord = current;
      if (metaChanged(record, summary)) {
        record = {
          ...record,
          description: summary.description,
          spawnDepth: summary.spawnDepth,
          parentAgentId: summary.parentAgentId,
        };
      }

      const outcomeIsFinal = summary.outcome === "done" || summary.outcome === "failed";
      const canUpgrade = record.state === "unknown" && outcomeIsFinal;
      if (canUpgrade) {
        record = { ...record, state: summary.outcome as SubagentEndState };
      }

      if (record === current) continue;
      agents = { ...(agents ?? entry.agents), [record.agentId]: record };
    }
    if (!agents) return;

    const changed = agents;
    set(s => ({ byTab: { ...s.byTab, [tabId]: { ...entry, agents: changed } } }));
  },

  mergeScanned: (taskId, tabId, sessionId, summaries, parentLive) => {
    const existing = get().byTab[tabId];
    const isForeignSession = !!existing && existing.sessionId !== sessionId;
    if (isForeignSession) get().forget(tabId);

    const entry: TabSubagents = existing && !isForeignSession
      ? existing
      : { taskId, sessionId, agents: {}, order: [] };

    let agents: Record<string, SubagentRecord> | null = null;
    const added: SubagentRecord[] = [];
    for (const summary of summaries) {
      const current: SubagentRecord | undefined = (agents ?? entry.agents)[summary.agentId];
      if (!current) {
        const state = scannedState(summary, parentLive);
        if (state) added.push(scannedRecord(summary, state));
        continue;
      }

      const record = rescanned(current, summary, parentLive);
      if (record === current) continue;
      agents = { ...(agents ?? entry.agents), [record.agentId]: record };
    }

    const nothingChanged = !agents && added.length === 0;
    if (nothingChanged) return;

    const merged = { ...(agents ?? entry.agents) };
    for (const record of added) merged[record.agentId] = record;

    let order = entry.order;
    if (added.length > 0) {
      const byStart = (a: string, b: string) => merged[a].startedAt - merged[b].startedAt;
      order = [...entry.order, ...added.map(record => record.agentId)].sort(byStart);
    }

    const next: TabSubagents = { ...entry, agents: merged, order };
    set(s => ({ byTab: { ...s.byTab, [tabId]: next } }));
  },
}));

function sameRecords(a: readonly SubagentRecord[], b: readonly SubagentRecord[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((record, index) => record === b[index]);
}

function createTabSelector(
  tabId: string,
  keep: (record: SubagentRecord) => boolean,
): (s: { byTab: Record<string, TabSubagents> }) => readonly SubagentRecord[] {
  let lastEntry: TabSubagents | undefined;
  let lastList: readonly SubagentRecord[] = EMPTY_SUBAGENTS;

  return s => {
    const entry = s.byTab[tabId];
    if (!entry) {
      lastEntry = undefined;
      lastList = EMPTY_SUBAGENTS;
      return EMPTY_SUBAGENTS;
    }
    if (entry === lastEntry) return lastList;

    lastEntry = entry;
    const list = entry.order.map(id => entry.agents[id]).filter(keep);
    if (list.length === 0) {
      lastList = EMPTY_SUBAGENTS;
    } else if (!sameRecords(list, lastList)) {
      lastList = Object.freeze(list);
    }
    return lastList;
  };
}

/** Every subagent of one tab, in start order. Stable by reference until that
 *  tab's records change; EMPTY_SUBAGENTS when it has none. */
export function selectTabSubagents(tabId: string) {
  return createTabSelector(tabId, () => true);
}

/** What the sidebar draws as rows: workflow agents are grouped under their
 *  run instead, so they never get a plain row. */
export function selectTabSubagentRows(tabId: string) {
  return createTabSelector(tabId, record => !record.isWorkflow);
}

// One `subagent_list` in flight per tab. A workflow starts its agents in a
// burst, and each start asking the disk again would queue a read per agent
// for an answer the first read already carries.
const refreshing = new Set<string>();
const refreshAgain = new Set<string>();

async function refreshFromTranscripts(tabId: string): Promise<void> {
  if (refreshing.has(tabId)) {
    refreshAgain.add(tabId);
    return;
  }
  refreshing.add(tabId);

  try {
    do {
      refreshAgain.delete(tabId);
      const entry = useSubagents.getState().byTab[tabId];
      if (!entry) return;

      let summaries: SubagentSummary[];
      try {
        summaries = await ipc.subagentList(entry.taskId, entry.sessionId);
      } catch {
        return;
      }
      useSubagents.getState().applySummaries(tabId, entry.sessionId, summaries);
    } while (refreshAgain.has(tabId));
  } finally {
    refreshing.delete(tabId);
    refreshAgain.delete(tabId);
  }
}

/** Where TerminalPane's accepted hook reports land. */
export function receiveSubagentEvent(origin: SubagentEventOrigin, event: SubagentHookEvent): void {
  if (!sessionMatches(event, origin.tabSessionId)) return;

  const store = useSubagents.getState();
  store.setSession(origin.tabId, event.sessionId);
  if (event.phase === "start") {
    store.start(origin.taskId, origin.tabId, event.sessionId, event.agentId, event.agentType);
  } else {
    store.stop(origin.tabId, event.agentId, "unknown");
  }

  void refreshFromTranscripts(origin.tabId);
}

setSubagentEventSink(receiveSubagentEvent);
