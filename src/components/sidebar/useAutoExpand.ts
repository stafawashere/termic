// Opens what is folded when there is news inside it: a task whose agent goes
// busy, a subagent group that gets a new subagent. Both are opt-in prefs.
//
// A fold the user made by hand is never reopened. For a task that is an
// explicit `collapsedTasks` entry of true, for a subagent group a fold entry
// for the tab's current session. Auto-expand only acts on a fold nobody has
// touched, and a write here records it as expanded, so a collapse made after
// it is the user's and sticks.
//
// This runs inside store subscriptions, which fire on every write, so each
// handler bails on reference equality before reading anything and writes only
// on the edge itself (docs/performance.md bear trap 8).

import { useEffect } from "react";
import { useApp } from "@/store/app";
import { usePrefs } from "@/store/prefs";
import { useSubagents, type TabSubagents } from "@/store/subagents";
import { useSubagentFold } from "@/components/sidebar/SubagentRows";
import { subagentGroupStartsCollapsed } from "@/components/sidebar/subagentTree";
import type { SubagentAutoCollapse } from "@/lib/subagentPrefs";
import type { Tab, TerminalTab } from "@/lib/types";

type TaskExpandMode = "chevron" | "click" | "always";

function isAgentTab(tab: Tab): tab is TerminalTab {
  return tab.type === "terminal" && tab.cli !== "shell" && tab.cli !== "custom";
}

/** Whether a task row is folded, by the same rule the row uses: the user's
*  own entry wins, else the expand mode's default. */
export function isTaskFolded(
  explicit: boolean | undefined,
  mode: TaskExpandMode,
  terminalTabCount: number,
): boolean {
  if (explicit !== undefined) return explicit;
  if (mode === "always") return false;
  if (mode === "chevron") return true;
  return terminalTabCount <= 1;
}

/** Whether auto-expand may open this task: it is folded and the user has not
*  folded it themselves. */
export function shouldAutoExpandTask(
  explicit: boolean | undefined,
  mode: TaskExpandMode,
  terminalTabCount: number,
): boolean {
  const foldedByUser = explicit === true;
  if (foldedByUser) return false;

  return isTaskFolded(explicit, mode, terminalTabCount);
}

/** True when `tabs` holds an agent tab that is working now and was not before. */
export function hasBusyEdge(prevTabs: readonly Tab[], tabs: readonly Tab[]): boolean {
  for (const tab of tabs) {
    if (!isAgentTab(tab) || tab.workState !== "working") continue;

    const before = prevTabs.find(candidate => candidate.id === tab.id);
    const wasWorking = before !== undefined && isAgentTab(before) && before.workState === "working";
    if (!wasWorking) return true;
  }

  return false;
}

/** The hook-reported subagents `next` holds that `prev` did not. Records a
*  disk scan rebuilt at launch are history, not a spawn. */
export function spawnedSubagentIds(prev: TabSubagents | undefined, next: TabSubagents): string[] {
  const sameSession = prev?.sessionId === next.sessionId;
  const known = sameSession ? prev.agents : {};

  return next.order.filter(agentId => {
    const record = next.agents[agentId];
    const isNew = !(agentId in known);
    return isNew && record?.source === "hook" && record.state === "running";
  });
}

/** Whether the spawn should open the tab's subagent group: nothing folded it
*  by hand for this session, and it would otherwise show folded. */
export function shouldAutoExpandSubagents(
  entry: TabSubagents,
  manual: { sessionId: string; collapsed: boolean } | undefined,
  mode: SubagentAutoCollapse,
): boolean {
  const manualHolds = manual !== undefined && manual.sessionId === entry.sessionId;
  if (manualHolds) return false;

  return subagentGroupStartsCollapsed(entry, mode);
}

function expandBusyTasks(state: ReturnType<typeof useApp.getState>, prev: ReturnType<typeof useApp.getState>) {
  if (state.tabs === prev.tabs) return;
  if (!usePrefs.getState().autoExpandActiveAgents) return;

  const mode = usePrefs.getState().taskExpandMode;
  for (const taskId of Object.keys(state.tabs)) {
    const tabs = state.tabs[taskId];
    const prevTabs = prev.tabs[taskId];
    if (tabs === prevTabs) continue;
    if (!tabs || !hasBusyEdge(prevTabs ?? [], tabs)) continue;

    const terminalTabCount = tabs.filter(tab => tab.type === "terminal").length;
    const explicit = state.collapsedTasks[taskId];
    if (!shouldAutoExpandTask(explicit, mode, terminalTabCount)) continue;

    state.setTaskCollapsed(taskId, false);
  }
}

function expandSpawnedGroups(
  state: ReturnType<typeof useSubagents.getState>,
  prev: ReturnType<typeof useSubagents.getState>,
) {
  if (state.byTab === prev.byTab) return;

  const prefs = usePrefs.getState();
  if (!prefs.autoExpandSubagents) return;

  for (const tabId of Object.keys(state.byTab)) {
    const entry = state.byTab[tabId];
    const before = prev.byTab[tabId];
    if (entry === before) continue;
    if (spawnedSubagentIds(before, entry).length === 0) continue;

    const manual = useSubagentFold.getState().groupByTab[tabId];
    if (!shouldAutoExpandSubagents(entry, manual, prefs.subagentAutoCollapse)) continue;

    useSubagentFold.getState().setGroupCollapsed(tabId, entry.sessionId, false);
  }
}

export function useAutoExpand() {
  useEffect(() => {
    const stopApp = useApp.subscribe(expandBusyTasks);
    const stopSubagents = useSubagents.subscribe(expandSpawnedGroups);

    return () => {
      stopApp();
      stopSubagents();
    };
  }, []);
}
