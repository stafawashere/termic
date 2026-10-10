// A live tail of one subagent's transcript, for as long as a view holds it.
//
// The listener goes up before the open, so no batch emitted between the two is
// lost. The host keeps one watch per file and counts holders, so every open
// must be matched by exactly one close: a close that runs before its open
// lands would leave the host holding a watch nobody releases, and a second
// close would release another view's hold. The dispose returned here is the
// only place either can go wrong, which is why it waits for an in-flight open.

import {
  onSubagentWatch,
  subagentWatchClose,
  subagentWatchOpen as openWatch,
  subagentWatchPoke,
} from "@/lib/ipc";
import type { SubagentTailEvent, SubagentWatchOpened } from "@/lib/types";

export { subagentWatchClose, subagentWatchPoke };

export interface SubagentWatchTarget {
  taskId: string;
  tabId: string;
  sessionId: string;
  agentId: string;
  workflowRunId?: string | null;
}

export interface SubagentWatchHandlers {
  onEvent: (event: SubagentTailEvent) => void;
  onOpened?: (opened: SubagentWatchOpened) => void;
  onError?: (error: unknown) => void;
}

export type SubagentWatchDispose = () => void;

export function subagentWatchOpen(target: SubagentWatchTarget, handlers: SubagentWatchHandlers): SubagentWatchDispose {
  const { taskId, tabId, sessionId, agentId } = target;
  let disposed = false;
  let unlisten: (() => void) | null = null;
  let opening: Promise<boolean> | null = null;

  const reportError = (error: unknown) => {
    if (!disposed) handlers.onError?.(error);
  };

  onSubagentWatch(sessionId, agentId, event => {
    if (!disposed) handlers.onEvent(event);
  }).then(stopListening => {
    if (disposed) {
      stopListening();
      return;
    }

    unlisten = stopListening;
    opening = openWatch(taskId, tabId, sessionId, agentId, target.workflowRunId ?? null).then(
      opened => {
        if (!disposed) handlers.onOpened?.(opened);
        return true;
      },
      error => {
        reportError(error);
        return false;
      },
    );
  }, reportError);

  return () => {
    if (disposed) return;
    disposed = true;

    unlisten?.();
    unlisten = null;

    void opening?.then(wasOpened => {
      if (!wasOpened) return;
      subagentWatchClose(taskId, tabId, sessionId, agentId).catch(() => {});
    });
  };
}
