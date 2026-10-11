// Which icon a subagent sidebar row leads with. Pure, so the agent type to
// icon table is pinned by a unit test rather than by a screenshot.

export type SubagentRowIconName = "workflow" | "layers" | "search" | "list-todo" | "book-open" | "bot";

const AGENT_TYPE_ICONS: Readonly<Record<string, SubagentRowIconName>> = {
  "explore": "search",
  "plan": "list-todo",
  "claude-code-guide": "book-open",
};

/** The icon of an agent row, by the agent type claude reported. Workflow
 *  agents, general-purpose and every custom agent share the generic bot. */
export function subagentAgentIconName(agentType: string): SubagentRowIconName {
  const normalized = agentType.trim().toLowerCase();
  return AGENT_TYPE_ICONS[normalized] ?? "bot";
}
