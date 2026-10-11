// Expand / Collapse all agents, as it reaches the subagent folds: a pure
// function over the fold store's slice and the subagents the store holds, so
// the bulk press can bail without a write when nothing would change.

import type { TabSubagents } from "@/store/subagents";

const EMPTY_FOLD: readonly string[] = Object.freeze([]);

/** A fold of a tab's whole subagent group, made by hand. It holds for the
 *  session it was made in and gives way to auto-collapse after that. */
export interface GroupFold {
  sessionId: string;
  collapsed: boolean;
}

export interface FoldSlice {
  groupByTab: Record<string, GroupFold>;
  openRunsByTab: Record<string, readonly string[]>;
}

/** The folds `setAllCollapsed` leaves, or null when it changes nothing.
 *  Collapsed folds every group and closes every run; expanded opens both. */
export function foldAllSubagents(
  state: FoldSlice,
  subagentsByTab: Record<string, TabSubagents>,
  collapsed: boolean,
): FoldSlice | null {
  const groupByTab = { ...state.groupByTab };
  const openRunsByTab = { ...state.openRunsByTab };
  let changed = false;

  for (const [tabId, entry] of Object.entries(subagentsByTab)) {
    const group = groupByTab[tabId];
    const groupMatches = group?.sessionId === entry.sessionId && group.collapsed === collapsed;
    if (!groupMatches) {
      groupByTab[tabId] = { sessionId: entry.sessionId, collapsed };
      changed = true;
    }

    const wantedRuns = collapsed ? EMPTY_FOLD : Object.keys(entry.runs);
    const currentRuns = openRunsByTab[tabId] ?? EMPTY_FOLD;
    const runsMatch = currentRuns.length === wantedRuns.length && wantedRuns.every(runId => currentRuns.includes(runId));
    if (!runsMatch) {
      openRunsByTab[tabId] = Object.freeze([...wantedRuns]);
      changed = true;
    }
  }

  return changed ? { groupByTab, openRunsByTab } : null;
}
