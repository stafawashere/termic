import { describe, it, expect } from "vitest";
import { subagentAgentIconName } from "./subagentRowIcon";

describe("subagentAgentIconName", () => {
  it("gives the built-in agents with a role of their own their icon, whatever their case", () => {
    expect(subagentAgentIconName("Explore")).toBe("search");
    expect(subagentAgentIconName("explore")).toBe("search");
    expect(subagentAgentIconName("Plan")).toBe("list-todo");
    expect(subagentAgentIconName(" claude-code-guide ")).toBe("book-open");
  });

  it("falls back to the bot for general-purpose, workflow and custom agents", () => {
    expect(subagentAgentIconName("general-purpose")).toBe("bot");
    expect(subagentAgentIconName("workflow-subagent")).toBe("bot");
    expect(subagentAgentIconName("acme-plugin:research:deep-reader")).toBe("bot");
    expect(subagentAgentIconName("explorer")).toBe("bot");
    expect(subagentAgentIconName("")).toBe("bot");
  });
});
