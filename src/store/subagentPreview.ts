// The subagent transcript view's data: opening it into a task's preview slot,
// the read-plus-tail session behind each open view, and letting go of both
// when the task is archived.
//
// The entries live in the session and reach the view as snapshots, never in
// useApp: a tailing agent can append several entries a second, and a write
// there re-runs every mounted tab bar and sidebar row (docs/performance.md
// bear trap 8). Nothing here is persisted.

import * as ipc from "@/lib/ipc";
import { i18n } from "@/lib/i18n";
import { subagentWatchOpen, type SubagentWatchDispose } from "@/lib/subagentWatch";
import { subagentsEnabled } from "@/lib/subagentGate";
import {
  appendBatch, EMPTY_WINDOW, prependPage, toTranscriptRows, type TranscriptWindow,
} from "@/lib/subagentTranscript";
import type { SubagentTab, SubagentTailEvent, Tab, Task } from "@/lib/types";
import { useApp } from "@/store/app";
import { useSubagents } from "@/store/subagents";

/** Open the transcript of `agentId`, a subagent of the claude tab
 *  `parentTabId`, in the task's preview slot. A no-op when the store holds no
 *  such agent: the row was drawn from a record, so a missing one means it was
 *  forgotten between the draw and the click. */
export function openSubagentPreview(taskId: string, parentTabId: string, agentId: string, permanent = false): void {
  const entry = useSubagents.getState().byTab[parentTabId];
  const record = entry?.agents[agentId];
  if (!entry || !record) return;

  const title = record.description || record.agentType || i18n.t("task:subagentView.tabTitleFallback");
  useApp.getState().openPreviewTab(taskId, {
    type: "subagent",
    title,
    parentTabId,
    sessionId: entry.sessionId,
    subagentAgentId: agentId,
    workflowRunId: null,
    permanent,
  });
}

export type TranscriptStatus = "loading" | "live" | "expired" | "unreadable" | "closed";

export interface TranscriptSnapshot {
  status: TranscriptStatus;
  window: TranscriptWindow;
  /** True while a "load earlier" read is in flight. */
  loadingEarlier: boolean;
}

export interface SubagentPreviewTarget {
  taskId: string;
  /** The tab the view sits in, which is what the host counts as a holder. */
  viewTabId: string;
  sessionId: string;
  agentId: string;
  workflowRunId?: string | null;
}

export interface TranscriptSession {
  loadEarlier: () => void;
  dispose: () => void;
}

const LOADING: TranscriptSnapshot = Object.freeze({ status: "loading", window: EMPTY_WINDOW, loadingEarlier: false });

/** Sessions still holding a watch, per task, so an archive can let go of
 *  every one at once. */
const liveSessions = new Map<string, Set<() => void>>();

function isTaskArchived(taskId: string): boolean {
  const task = useApp.getState().tasks.find(t => t.id === taskId);
  return !task || task.archived;
}

/** Read the last page of a subagent's transcript and tail it from there.
 *  `onChange` gets a fresh snapshot after every change and never one that
 *  equals the last. */
export function openTranscriptSession(
  target: SubagentPreviewTarget,
  onChange: (snapshot: TranscriptSnapshot) => void,
): TranscriptSession {
  let snapshot = LOADING;
  let disposed = false;
  let stopWatch: SubagentWatchDispose | null = null;
  // Batches that arrive before the first page lands; applied on top of it.
  let pending: SubagentTailEvent[] | null = [];
  // Bumped by a reset, so a page read before it is not stitched onto entries
  // that restarted from zero after it.
  let generation = 0;

  const publish = (next: TranscriptSnapshot) => {
    if (disposed || next === snapshot) return;
    snapshot = next;
    onChange(next);
  };

  const releaseWatch = () => {
    stopWatch?.();
    stopWatch = null;
    liveSessions.get(target.taskId)?.delete(release);
  };

  const finish = (status: "expired" | "unreadable" | "closed") => {
    releaseWatch();
    publish({ ...snapshot, status, loadingEarlier: false });
  };

  const release = () => finish("closed");

  const readNewest = async () => {
    const readGeneration = generation;
    let page;
    try {
      page = await ipc.subagentTranscriptRead(target.taskId, target.sessionId, target.agentId, target.workflowRunId ?? null);
    } catch {
      finish("unreadable");
      return;
    }
    if (disposed || readGeneration !== generation) return;

    const isExpired = page.outcome === "expired" && page.entries.length === 0;
    if (isExpired) {
      finish("expired");
      return;
    }

    const newest = { start: page.start, rows: toTranscriptRows(page.entries, page.start) };
    publish({ status: "live", window: newest, loadingEarlier: snapshot.loadingEarlier });

    const queued = pending ?? [];
    pending = null;
    for (const event of queued) applyEvent(event);
  };

  const applyEvent = (event: SubagentTailEvent) => {
    if (disposed) return;
    if (pending) {
      pending.push(event);
      return;
    }

    if (event.kind === "expired") {
      finish("expired");
      return;
    }

    if (event.kind === "reset") {
      generation++;
      publish({ status: "live", window: EMPTY_WINDOW, loadingEarlier: false });
      return;
    }

    const merged = appendBatch(snapshot.window, event.start, event.entries);
    if (merged.kind === "appended") {
      publish({ ...snapshot, window: merged.window });
      return;
    }

    if (merged.kind === "gap") {
      pending = [event];
      void readNewest();
    }
  };

  const loadEarlier = () => {
    const canLoad = snapshot.status === "live" && snapshot.window.start > 0 && !snapshot.loadingEarlier;
    if (disposed || !canLoad) return;

    const readGeneration = generation;
    const before = snapshot.window.start;
    publish({ ...snapshot, loadingEarlier: true });

    ipc.subagentTranscriptRead(target.taskId, target.sessionId, target.agentId, target.workflowRunId ?? null, before)
      .then(page => {
        if (disposed) return;
        const isStale = readGeneration !== generation;
        const widened = isStale ? snapshot.window : prependPage(snapshot.window, page.start, page.entries);
        publish({ ...snapshot, window: widened, loadingEarlier: false });
      })
      .catch(() => publish({ ...snapshot, loadingEarlier: false }));
  };

  const dispose = () => {
    if (disposed) return;
    releaseWatch();
    disposed = true;
  };

  const isSwitchedOff = !subagentsEnabled();
  if (isSwitchedOff || isTaskArchived(target.taskId)) {
    publish({ ...LOADING, status: "closed" });
    return { loadEarlier, dispose };
  }

  const held = liveSessions.get(target.taskId) ?? new Set<() => void>();
  held.add(release);
  liveSessions.set(target.taskId, held);

  // The tail goes up first and the page is read once it is open, so the
  // page's end is at or past where the first batch starts: the two overlap
  // and never leave a gap. A failed open (the file is not there) still reads,
  // which is what tells an expired transcript from a slow one.
  stopWatch = subagentWatchOpen(
    {
      taskId: target.taskId,
      tabId: target.viewTabId,
      sessionId: target.sessionId,
      agentId: target.agentId,
      workflowRunId: target.workflowRunId ?? null,
    },
    {
      onEvent: applyEvent,
      onOpened: () => void readNewest(),
      onError: () => void readNewest(),
    },
  );

  return { loadEarlier, dispose };
}

/** Stop every open session, in every task, and leave each view showing
 *  what it had read. For the feature being switched off: the tabs stay, and
 *  nothing is watched or read until it is switched back on. */
export function releaseAllSubagentSessions(): void {
  const held = [...liveSessions.values()].flatMap(releases => [...releases]);
  liveSessions.clear();
  for (const release of held) release();
}

/** Stop every session of `taskId` and close its subagent tabs. */
export function releaseSubagentViews(taskId: string): void {
  const held = liveSessions.get(taskId);
  if (held) {
    liveSessions.delete(taskId);
    for (const release of [...held]) release();
  }

  const subagentTabIds = (useApp.getState().tabs[taskId] ?? [])
    .filter((t: Tab): t is SubagentTab => t.type === "subagent")
    .map(t => t.id);
  for (const tabId of subagentTabIds) useApp.getState().closeTab(taskId, tabId);
}

function archivedOrGone(tasks: readonly Task[], prevTasks: readonly Task[]): string[] {
  const byId = new Map(tasks.map(t => [t.id, t]));
  return prevTasks
    .filter(prev => !prev.archived)
    .filter(prev => {
      const now = byId.get(prev.id);
      return !now || now.archived;
    })
    .map(prev => prev.id);
}

let installed: (() => void) | null = null;

/** Close the subagent views of a task as it is archived. Reacts only when the
 *  task list itself changes, so ordinary writes cost one reference compare. */
export function installSubagentPreviewArchiveWatch(): () => void {
  if (installed) return installed;

  const unsub = useApp.subscribe((state, prev) => {
    if (state.tasks === prev.tasks) return;

    for (const taskId of archivedOrGone(state.tasks, prev.tasks)) {
      const hasSessions = liveSessions.has(taskId);
      const hasTabs = (state.tabs[taskId] ?? []).some(t => t.type === "subagent");
      if (hasSessions || hasTabs) releaseSubagentViews(taskId);
    }
  });

  installed = () => { unsub(); installed = null; };
  return installed;
}
