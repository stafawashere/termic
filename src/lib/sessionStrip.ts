// The title bar's session strip (docs/ui.md "Title bar"): which agent tab of
// the open task it describes, and in what state. Pure and store-free.
//
// Picked from what the tab already carries: `workState` for running,
// `unread.reason === "attention"` for an agent blocked on you. A finished or
// idle agent is not picked, so the strip hides. There is no
// live tool-call channel, so the only tool the strip can name is the one a
// permission request reports (docs/agent-hooks.md, "claude's attention body
// names the tool").

import type { Tab, TerminalTab } from "./types";

export type SessionStripState = "running" | "waiting";

export interface SessionStripPick {
  tabId: string;
  state: SessionStripState;
  /** When the tab went working, or null when nothing stamped it. */
  since: number | null;
  /** Other agents in the task that are running right now. */
  otherRunning: number;
  /** The tool a permission request is about, when the agent named one. */
  tool: string | null;
}

const PERMISSION_TOOL = /permission:\s*([A-Za-z0-9_.:-]+)\s*$/;

function isAgentTerminal(tab: Tab): tab is TerminalTab {
  if (tab.type !== "terminal") return false;

  const terminal = tab as TerminalTab;
  const isPlainShell = terminal.cli === "shell" || terminal.cli === "custom";

  return !isPlainShell && !terminal.runTab;
}

function stateOf(tab: TerminalTab): SessionStripState | null {
  if (tab.unread?.reason === "attention") return "waiting";
  if (tab.workState === "working") return "running";
  return null;
}

/** Newest running agent, else newest waiting one. */
export function pickSessionTab(tabs: readonly Tab[] | undefined): SessionStripPick | null {
  if (!tabs) return null;

  const rank: Record<SessionStripState, number> = { running: 2, waiting: 1 };
  let best: { tab: TerminalTab; state: SessionStripState; stamp: number } | null = null;
  let running = 0;

  for (const tab of tabs) {
    if (!isAgentTerminal(tab)) continue;

    const state = stateOf(tab);
    if (!state) continue;
    if (state === "running") running += 1;

    const stamp = tab.workingSince ?? 0;
    const outranks = !best || rank[state] > rank[best.state];
    const newerSameRank = !!best && rank[state] === rank[best.state] && stamp > best.stamp;

    if (outranks || newerSameRank) best = { tab, state, stamp };
  }

  if (!best) return null;

  const toolMatch = best.state === "waiting" ? PERMISSION_TOOL.exec(best.tab.unread?.message ?? "") : null;
  const pickedIsRunning = best.state === "running";

  return {
    tabId: best.tab.id,
    state: best.state,
    since: best.tab.workingSince ?? null,
    otherRunning: pickedIsRunning ? running - 1 : running,
    tool: toolMatch ? toolMatch[1] : null,
  };
}

const KEY_SEP = "\u0000";

/** The pick packed into one string, so a store subscription re-renders only
 *  when something the strip draws changes. An output stamp or a live title
 *  leaves it identical. */
export function sessionStripKey(tabs: readonly Tab[] | undefined): string {
  const pick = pickSessionTab(tabs);
  if (!pick) return "";

  return [pick.tabId, pick.state, pick.since ?? "", pick.otherRunning, pick.tool ?? ""].join(KEY_SEP);
}

export function parseSessionStripKey(key: string): SessionStripPick | null {
  if (!key) return null;

  const [tabId, state, since, otherRunning, tool] = key.split(KEY_SEP);

  return {
    tabId,
    state: state as SessionStripState,
    since: since ? Number(since) : null,
    otherRunning: Number(otherRunning),
    tool: tool || null,
  };
}

/** "2:59", "59:59", "1:04:09". Width-stable with tabular figures. */
export function formatClock(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const paddedSeconds = String(seconds).padStart(2, "0");

  if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${paddedSeconds}`;
  return `${minutes}:${paddedSeconds}`;
}
