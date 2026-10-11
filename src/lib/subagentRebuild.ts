// Rebuilding a claude tab's subagent rows from the transcripts on disk.
//
// Nothing about a subagent is persisted, so after a relaunch the rows come
// back from `<sessionId>/subagents/` instead: on launch for every claude tab
// that names a session, when a tab spawns with `--resume`, and when claude
// reports a new session id. Hooks stay the live source; a scan only fills in
// what no hook reported (see `mergeScanned`).
//
// Launch scans wait for an idle moment after first paint and run two at a
// time, so a sidebar of claude tasks costs startup nothing. Hydration never
// awaits them.

import * as ipc from "@/lib/ipc";
import { builtinBaseId } from "@/lib/agents";
import type { SubagentSummary } from "@/lib/types";
import { subagentsEnabled } from "@/lib/subagentGate";
import { useApp } from "@/store/app";
import { useSubagents } from "@/store/subagents";

/** How many of a session's newest transcripts a rebuild reads. */
export const SUBAGENT_HISTORY_CAP = 50;

export const LAUNCH_REBUILD_CONCURRENCY = 2;

interface TabSessionNow {
  sessionId: string | null;
  parentLive: boolean;
}

function tabSessionNow(taskId: string, tabId: string): TabSessionNow | null {
  const state = useApp.getState();
  const tab = state.tabs[taskId]?.find(candidate => candidate.id === tabId);
  if (tab) {
    if (tab.type !== "terminal") return null;
    return { sessionId: tab.sessionId ?? null, parentLive: !!tab.ptyId };
  }

  const task = state.tasks.find(candidate => candidate.id === taskId);
  const persisted = task?.persisted_tabs?.find(candidate => candidate.id === tabId);
  const isGone = !task || task.archived || !persisted;
  if (isGone) return null;

  return { sessionId: persisted.session_id ?? null, parentLive: false };
}

export function isClaudeCli(cli: string): boolean {
  return builtinBaseId(cli, useApp.getState().agents) === "claude";
}

/** Scan one tab's session and fold the result into the subagent store.
 *  Resolves true when the result was applied, false when it was dropped
 *  because the tab moved on meanwhile: another session, closed, or its
 *  claude process stopped. */
export async function rebuildSubagentsForTab(
  taskId: string,
  tabId: string,
  sessionId: string,
): Promise<boolean> {
  if (!subagentsEnabled()) return false;

  const before = tabSessionNow(taskId, tabId);
  if (!before || before.sessionId !== sessionId) return false;

  let summaries: SubagentSummary[];
  try {
    summaries = await ipc.subagentList(taskId, sessionId, SUBAGENT_HISTORY_CAP);
  } catch {
    return false;
  }

  const after = tabSessionNow(taskId, tabId);
  if (!after || !subagentsEnabled()) return false;

  const sessionMoved = after.sessionId !== sessionId;
  const parentStopped = before.parentLive && !after.parentLive;
  if (sessionMoved || parentStopped) return false;

  useSubagents.getState().mergeScanned(taskId, tabId, sessionId, summaries, after.parentLive);
  return true;
}

interface LaunchTarget {
  taskId: string;
  tabId: string;
  sessionId: string;
}

/** Every claude tab that names a session. A task whose tabs are loaded
 *  answers from them, since a live tab may have moved to a newer session than
 *  the one persisted; any other task answers from what it persisted. */
function rebuildTargets(): LaunchTarget[] {
  const state = useApp.getState();
  const targets: LaunchTarget[] = [];
  for (const task of state.tasks) {
    if (task.archived) continue;

    const liveTabs = state.tabs[task.id];
    if (liveTabs) {
      for (const tab of liveTabs) {
        if (tab.type !== "terminal") continue;

        const sessionId = tab.sessionId;
        if (!sessionId || !isClaudeCli(tab.cli)) continue;
        targets.push({ taskId: task.id, tabId: tab.id, sessionId });
      }
      continue;
    }

    for (const persisted of task.persisted_tabs ?? []) {
      const sessionId = persisted.session_id;
      if (!sessionId || !isClaudeCli(persisted.cli)) continue;
      targets.push({ taskId: task.id, tabId: persisted.id, sessionId });
    }
  }
  return targets;
}

/** Every claude tab's scan, at most `LAUNCH_REBUILD_CONCURRENCY` in flight.
 *  Does nothing while the feature is switched off. */
export async function runLaunchRebuild(): Promise<void> {
  if (!subagentsEnabled()) return;

  const queue = rebuildTargets();

  const worker = async () => {
    for (let target = queue.shift(); target; target = queue.shift()) {
      await rebuildSubagentsForTab(target.taskId, target.tabId, target.sessionId);
    }
  };

  const workerCount = Math.min(LAUNCH_REBUILD_CONCURRENCY, queue.length);
  await Promise.all(Array.from({ length: workerCount }, worker));
}

function whenIdle(run: () => void): void {
  if (typeof window.requestIdleCallback === "function") {
    window.requestIdleCallback(run, { timeout: 2_000 });
    return;
  }
  setTimeout(run, 200);
}

let launchScheduled = false;

/** Once per app run, after the task list has loaded. Returns at once. */
export function scheduleLaunchRebuild(): void {
  if (launchScheduled) return;
  launchScheduled = true;

  whenIdle(() => { void runLaunchRebuild(); });
}
