import { describe, expect, it } from "vitest";
import { countWorkingAgentTabs, formatElapsed, workingAgentLines } from "./agentActivity";
import type { Tab, Task } from "./types";

const terminal = (id: string, workState?: "idle" | "working" | "done", workingSince?: number) =>
  ({ id, type: "terminal", title: id, cli: "claude", workState, workingSince }) as Tab;
const editor = (id: string) => ({ id, type: "edit", title: id, path: "/x" }) as unknown as Tab;

describe("countWorkingAgentTabs", () => {
  it("counts working terminal tabs, two in one task as two", () => {
    const tabs = {
      a: [terminal("a1", "working"), terminal("a2", "working"), terminal("a3", "done")],
      b: [terminal("b1", "idle"), editor("b2")],
      c: [terminal("c1", "working")],
    };

    expect(countWorkingAgentTabs({ tabs })).toBe(3);
  });

  it("reads zero with nothing mid-turn", () => {
    expect(countWorkingAgentTabs({ tabs: { a: [terminal("a1", "done")] } })).toBe(0);
  });
});

describe("workingAgentLines", () => {
  it("lists working tabs by task name, longest running first", () => {
    const tasks = [{ id: "a", name: "plan" }, { id: "b", name: "fix" }] as Task[];
    const tabs = {
      a: [terminal("a1", "working", 2_000)],
      b: [terminal("b1", "working", 1_000), terminal("b2", "idle")],
    };

    const lines = workingAgentLines(tabs, tasks);

    expect(lines.map(line => [line.taskName, line.since])).toEqual([["fix", 1_000], ["plan", 2_000]]);
  });
});

describe("formatElapsed", () => {
  it("drops units it does not need", () => {
    expect(formatElapsed(45_000)).toBe("45s");
    expect(formatElapsed(179_000)).toBe("2m 59s");
    expect(formatElapsed(3_840_000)).toBe("1h 4m");
  });
});
