// Which subagent transcript is on screen, and when each one was last on
// screen. Retention counts an ended row's window from whichever is later, its
// end or the last time the user looked at it, so a row never goes while its
// transcript is open or straight after the user switched away from it.
//
// Its own store, written only when the on-screen agent changes, so a tab
// switch never touches useApp (docs/performance.md bear trap 8). Nothing here
// is persisted.

import { create } from "zustand";
import { useApp, type AppState } from "@/store/app";
import { useUI } from "@/store/ui";

interface SubagentSeenState {
  visibleAgentId: string | null;
  lastSeenAt: Readonly<Record<string, number>>;
  setVisible: (agentId: string | null, now: number) => void;
}

export const useSubagentSeen = create<SubagentSeenState>((set, get) => ({
  visibleAgentId: null,
  lastSeenAt: {},

  setVisible: (agentId, now) => {
    const previous = get().visibleAgentId;
    if (previous === agentId) return;

    const lastSeenAt = { ...get().lastSeenAt };
    if (previous !== null) lastSeenAt[previous] = now;
    if (agentId !== null) lastSeenAt[agentId] = now;
    set({ visibleAgentId: agentId, lastSeenAt });
  },
}));

export function onScreenSubagentId(s: AppState, windowless: boolean): string | null {
  const taskId = s.activeTaskId;
  if (windowless || taskId === null) return null;

  const activeTabId = s.activeTab[taskId];
  const activeTab = s.tabs[taskId]?.find(tab => tab.id === activeTabId);
  const isSubagentTab = activeTab?.type === "subagent";
  if (!isSubagentTab) return null;

  return activeTab.subagentAgentId ?? null;
}

/** Keeps `visibleAgentId` in step with the app and UI stores. Returns the
 *  unsubscribe. */
export function trackOnScreenSubagent(): () => void {
  const sync = () => {
    const agentId = onScreenSubagentId(useApp.getState(), useUI.getState().windowless);
    useSubagentSeen.getState().setVisible(agentId, Date.now());
  };

  sync();
  const stopApp = useApp.subscribe(sync);
  const stopUI = useUI.subscribe(sync);
  return () => {
    stopApp();
    stopUI();
  };
}
