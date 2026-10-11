// Which of the settings' type filters a subagent falls under.
//
// claude reports an agent only by its `agentType` string (the hook body and
// the `.meta.json` sidecar both carry it), so the kind is read off that.
// Built-in agents ship with claude under fixed names; anything else is an
// agent the user or a plugin defined, which claude names as written
// (`reviewer`, `plugin:group:agent`).
//
// Forks are a guess. Nothing measured so far tells a fork apart from the
// agent it was forked as: the sidecar keys are the same, and no transcript of
// a fork has been sampled. Only an agent type spelled `fork` is classed as
// one, and every other fork lands under custom.

export type SubagentKind = "builtIn" | "custom" | "fork" | "workflow";

export const SUBAGENT_KINDS: readonly SubagentKind[] = ["builtIn", "custom", "fork", "workflow"];

/** The agent type claude gives every agent a workflow runs. */
export const WORKFLOW_AGENT_TYPE = "workflow-subagent";
const FORK_AGENT_TYPE = "fork";

const BUILT_IN_AGENT_TYPES: ReadonlySet<string> = new Set([
  "general-purpose",
  "explore",
  "plan",
  "statusline-setup",
  "output-style-setup",
  "claude-code-guide",
]);

export interface SubagentKindMeta {
  isWorkflow?: boolean;
}

export function subagentKind(agentType: string, meta: SubagentKindMeta = {}): SubagentKind {
  const normalized = agentType.trim().toLowerCase();
  const isWorkflow = meta.isWorkflow === true || normalized === WORKFLOW_AGENT_TYPE;
  if (isWorkflow) return "workflow";

  if (normalized === FORK_AGENT_TYPE) return "fork";
  if (BUILT_IN_AGENT_TYPES.has(normalized)) return "builtIn";
  return "custom";
}
