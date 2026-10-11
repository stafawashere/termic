// The sidebar toolbar's agent readout (docs/ui.md "The agent activity
// readout"): how many agent tabs are mid-turn across every task, and the
// lines its tooltip lists. Pure and store-free, like sidebarStatus.ts.
//
// The signal is the status section's Working bucket (taskWorking), counted
// per tab instead of per task, so two agents working in one task read as two.

import type { Tab, Task } from "./types";

const isWorkingTerminal = (tab: Tab) => tab.type === "terminal" && tab.workState === "working";

/** Working terminal tabs across every task. The readout's one store
 *  subscription, so it returns a number: a write that leaves the count alone
 *  re-renders nothing. */
export function countWorkingAgentTabs(state: { tabs: Record<string, Tab[]> }): number {
  let working = 0;

  for (const taskTabs of Object.values(state.tabs)) {
    for (const tab of taskTabs) {
      if (isWorkingTerminal(tab)) working += 1;
    }
  }

  return working;
}

export interface WorkingAgentLine {
  tabId: string;
  taskId: string;
  taskName: string;
  /** When the tab went working, or null when nothing stamped it. */
  since: number | null;
}

/** One tooltip line per working tab, longest running first. Read while the
 *  tooltip is open, never subscribed. */
export function workingAgentLines(tabs: Record<string, Tab[]>, tasks: readonly Task[]): WorkingAgentLine[] {
  const taskNames = new Map(tasks.map(task => [task.id, task.name]));
  const lines: WorkingAgentLine[] = [];

  for (const [taskId, taskTabs] of Object.entries(tabs)) {
    for (const tab of taskTabs) {
      if (!isWorkingTerminal(tab) || tab.type !== "terminal") continue;

      lines.push({ tabId: tab.id, taskId, taskName: taskNames.get(taskId) ?? taskId, since: tab.workingSince ?? null });
    }
  }

  return lines.sort((a, b) => (a.since ?? Infinity) - (b.since ?? Infinity));
}

/** "45s", "2m 59s", "1h 4m". Seconds drop off past the hour. */
export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}
