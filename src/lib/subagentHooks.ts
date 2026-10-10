// claude's `SubagentStart` / `SubagentStop` hooks, as they reach the terminal.
//
// The hook writes `subagent start|stop <session> <agent> <type>` on the same
// trusted OSC 777 channel as every other termic hook (see `lib/agentHooks.ts`
// and `agent_hooks.rs`). The ids end up in a path on disk later, so they are
// validated twice: by the script before it writes, and here before anything
// downstream sees them. A body that fails either is dropped, never escaped.
//
// A subagent report is information, not state. It never badges, rings, or
// ends a turn: a subagent's stop is not a done for the task that spawned it.

/** KEEP IN SYNC with `SUBAGENT_BODY_PREFIX` in `agent_hooks.rs`. */
export const HOOK_OSC_SUBAGENT_PREFIX = "subagent ";

export type SubagentPhase = "start" | "stop";

export interface SubagentHookEvent {
  phase: SubagentPhase;
  sessionId: string;
  agentId: string;
  agentType: string;
}

/** Which tab a report arrived on, and the session that tab is running at
 *  the moment it arrived. */
export interface SubagentEventOrigin {
  taskId: string;
  tabId: string;
  tabSessionId: string | null;
}

export type SubagentEventSink = (origin: SubagentEventOrigin, event: SubagentHookEvent) => void;

const SUBAGENT_BODY =
  /^(start|stop) ([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}) ([A-Za-z0-9_-]{1,70}) ([A-Za-z0-9_:.-]{1,128})$/;
const AGENT_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Parse what follows `HOOK_OSC_SUBAGENT_PREFIX`. Strict on purpose, like
 *  `parseDelegatedBody`: no trimming, exactly four fields, and the same
 *  alphabets the hook script enforces. */
export function parseSubagentBody(rest: string): SubagentHookEvent | null {
  const match = SUBAGENT_BODY.exec(rest);
  if (!match) return null;

  const [, phase, sessionId, rawAgentId, agentType] = match;
  const agentId = normalizeAgentId(rawAgentId);
  if (!agentId) return null;

  return { phase: phase as SubagentPhase, sessionId, agentId, agentType };
}

/** The bare agent id, without the `agent-` file prefix, or null when it is
 *  outside the alphabet the hook script enforces. */
export function normalizeAgentId(raw: string): string | null {
  const agentId = raw.startsWith("agent-") ? raw.slice("agent-".length) : raw;
  return AGENT_ID.test(agentId) ? agentId : null;
}

/** True only when the report belongs to the session this tab is running. A tab
 *  with no session id yet cannot claim anything. */
export function sessionMatches(event: SubagentHookEvent, tabSessionId: string | null | undefined): boolean {
  if (!tabSessionId) return false;
  return event.sessionId === tabSessionId;
}

let subagentEventSink: SubagentEventSink | null = null;

/** Where accepted reports go. Null until the subagent store connects itself. */
export function setSubagentEventSink(sink: SubagentEventSink | null): void {
  subagentEventSink = sink;
}

export function deliverSubagentEvent(origin: SubagentEventOrigin, event: SubagentHookEvent): void {
  subagentEventSink?.(origin, event);
}
