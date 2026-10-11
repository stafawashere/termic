import { describe, it, expect } from "vitest";
import { subagentKind } from "./subagentKind";

describe("subagentKind", () => {
  it("classes claude's own agents as built-in, whatever their case", () => {
    expect(subagentKind("general-purpose")).toBe("builtIn");
    expect(subagentKind("Explore")).toBe("builtIn");
    expect(subagentKind("Plan")).toBe("builtIn");
    expect(subagentKind("statusline-setup")).toBe("builtIn");
    expect(subagentKind("claude-code-guide")).toBe("builtIn");
  });

  it("classes user and plugin agents as custom", () => {
    expect(subagentKind("reviewer")).toBe("custom");
    expect(subagentKind("acme-plugin:research:deep-reader")).toBe("custom");
    expect(subagentKind("explorer")).toBe("custom");
  });

  it("classes the workflow agent type as workflow", () => {
    expect(subagentKind("workflow-subagent")).toBe("workflow");
  });

  it("trusts the workflow flag over the type string", () => {
    expect(subagentKind("Explore", { isWorkflow: true })).toBe("workflow");
    expect(subagentKind("reviewer", { isWorkflow: false })).toBe("custom");
  });

  it("classes only an agent type spelled fork as a fork", () => {
    expect(subagentKind("fork")).toBe("fork");
    expect(subagentKind("Fork")).toBe("fork");
    expect(subagentKind("forked-reviewer")).toBe("custom");
  });

  it("puts an empty or blank type under custom", () => {
    expect(subagentKind("")).toBe("custom");
    expect(subagentKind("   ")).toBe("custom");
  });
});
