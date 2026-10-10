import { describe, it, expect } from "vitest";
import {
  buildSubagentTree, childRowCarriesSelection, createSubagentStructureSelector, hasSubagentRow,
  parseSubagentStructureKey, subagentStructureKey, EMPTY_SUBAGENT_TREE, MAX_SUBAGENT_INDENT_DEPTH,
  type SubagentLink,
} from "./subagentTree";
import type { SubagentRecord, TabSubagents } from "@/store/subagents";

const NONE: ReadonlySet<string> = new Set();

function link(agentId: string, parentAgentId: string | null = null): SubagentLink {
  return { agentId, parentAgentId };
}

function record(agentId: string, extra: Partial<SubagentRecord> = {}): SubagentRecord {
  return {
    agentId,
    agentType: "general-purpose",
    isWorkflow: false,
    state: "running",
    startedAt: 0,
    endedAt: null,
    source: "hook",
    ...extra,
  };
}

function entry(records: SubagentRecord[]): TabSubagents {
  return {
    taskId: "task-1",
    sessionId: "11111111-2222-4333-8444-555555555555",
    agents: Object.fromEntries(records.map(r => [r.agentId, r])),
    order: records.map(r => r.agentId),
  };
}

const ids = (rows: readonly { agentId: string }[]) => rows.map(row => row.agentId);
const depths = (rows: readonly { depth: number }[]) => rows.map(row => row.depth);

describe("buildSubagentTree", () => {
  it("returns the shared empty list when there is nothing", () => {
    expect(buildSubagentTree([], NONE)).toBe(EMPTY_SUBAGENT_TREE);
  });

  it("puts agents with no parent directly under the tab, in spawn order", () => {
    const rows = buildSubagentTree([link("a"), link("b"), link("c")], NONE);

    expect(ids(rows)).toEqual(["a", "b", "c"]);
    expect(depths(rows)).toEqual([1, 1, 1]);
    expect(rows.every(row => !row.hasChildren)).toBe(true);
  });

  it("nests a child right after its parent, one level deeper", () => {
    const rows = buildSubagentTree([link("p"), link("x"), link("c", "p")], NONE);

    expect(ids(rows)).toEqual(["p", "c", "x"]);
    expect(depths(rows)).toEqual([1, 2, 1]);
    expect(rows[0].hasChildren).toBe(true);
    expect(rows[1].hasChildren).toBe(false);
  });

  it("keeps siblings in spawn order under their parent", () => {
    const rows = buildSubagentTree([link("p"), link("c2", "p"), link("c1", "p")], NONE);

    expect(ids(rows)).toEqual(["p", "c2", "c1"]);
  });

  it("puts an agent whose parent has no row under the tab", () => {
    const rows = buildSubagentTree([link("a"), link("orphan", "gone")], NONE);

    expect(ids(rows)).toEqual(["a", "orphan"]);
    expect(depths(rows)).toEqual([1, 1]);
  });

  it("clamps the indent at depth 3 and still lists agents at depth 4 and 5", () => {
    const chain = [link("d1"), link("d2", "d1"), link("d3", "d2"), link("d4", "d3"), link("d5", "d4")];
    const rows = buildSubagentTree(chain, NONE);

    expect(MAX_SUBAGENT_INDENT_DEPTH).toBe(3);
    expect(ids(rows)).toEqual(["d1", "d2", "d3", "d4", "d5"]);
    expect(depths(rows)).toEqual([1, 2, 3, 3, 3]);
  });

  it("moves only the late re-parented agent when its parent arrives", () => {
    const before = buildSubagentTree([link("p"), link("x"), link("c")], NONE);
    const after = buildSubagentTree([link("p"), link("x"), link("c", "p")], NONE);

    expect(ids(before)).toEqual(["p", "x", "c"]);
    expect(ids(after)).toEqual(["p", "c", "x"]);
    expect(after.find(row => row.agentId === "c")?.depth).toBe(2);
    expect(after.find(row => row.agentId === "x")?.depth).toBe(1);
  });

  it("leaves out the subtree of a folded agent but keeps the agent itself", () => {
    const links = [link("p"), link("c", "p"), link("g", "c"), link("x")];
    const rows = buildSubagentTree(links, new Set(["p"]));

    expect(ids(rows)).toEqual(["p", "x"]);
    expect(rows[0].hasChildren).toBe(true);
  });

  it("folding a middle agent hides only below it", () => {
    const links = [link("p"), link("c", "p"), link("g", "c")];
    const rows = buildSubagentTree(links, new Set(["c"]));

    expect(ids(rows)).toEqual(["p", "c"]);
  });

  it("still lists agents whose parent chain loops", () => {
    const rows = buildSubagentTree([link("a", "b"), link("b", "a"), link("self", "self")], NONE);

    expect(ids(rows).sort()).toEqual(["a", "b", "self"]);
  });
});

describe("structure key", () => {
  it("skips workflow agents, so they never get a row", () => {
    const tab = entry([
      record("a"),
      record("wf1", { agentType: "workflow-subagent", isWorkflow: true }),
      record("b", { parentAgentId: "a" }),
    ]);

    const links = parseSubagentStructureKey(subagentStructureKey(tab));
    expect(links).toEqual([link("a"), link("b", "a")]);
    expect(ids(buildSubagentTree(links, NONE))).not.toContain("wf1");
  });

  it("puts the child of a workflow agent under the tab", () => {
    const tab = entry([
      record("wf1", { agentType: "workflow-subagent", isWorkflow: true }),
      record("c", { parentAgentId: "wf1" }),
    ]);

    const rows = buildSubagentTree(parseSubagentStructureKey(subagentStructureKey(tab)), NONE);
    expect(ids(rows)).toEqual(["c"]);
    expect(depths(rows)).toEqual([1]);
  });

  it("does not change when an agent finishes", () => {
    const running = entry([record("a"), record("b")]);
    const finished = entry([record("a", { state: "done", endedAt: 5 }), record("b")]);

    expect(subagentStructureKey(finished)).toBe(subagentStructureKey(running));
  });

  it("changes when an agent gains a parent or a new agent starts", () => {
    const base = subagentStructureKey(entry([record("a"), record("b")]));

    expect(subagentStructureKey(entry([record("a"), record("b", { parentAgentId: "a" })]))).not.toBe(base);
    expect(subagentStructureKey(entry([record("a"), record("b"), record("c")]))).not.toBe(base);
  });

  it("the selector returns its cached key while the tab's entry is unchanged", () => {
    const tab = entry([record("a")]);
    const select = createSubagentStructureSelector("tab-1");

    const first = select({ byTab: { "tab-1": tab } });
    expect(select({ byTab: { "tab-1": tab, other: entry([record("z")]) } })).toBe(first);
    expect(select({ byTab: {} })).toBe("");
  });
});

describe("childRowCarriesSelection", () => {
  const terminalTabIds = ["tab-main", "tab-shell"];
  const rows = new Set(["a1"]);

  it("a terminal child row carries it", () => {
    const active = { id: "tab-shell", type: "terminal" };
    expect(childRowCarriesSelection(active, terminalTabIds, rows)).toBe(true);
  });

  it("a subagent row of this task carries it", () => {
    const active = { id: "tab-sub", type: "subagent", subagentAgentId: "a1" };
    expect(childRowCarriesSelection(active, terminalTabIds, rows)).toBe(true);
  });

  it("a subagent of another task leaves it on the header", () => {
    const active = { id: "tab-sub", type: "subagent", subagentAgentId: "elsewhere" };
    expect(childRowCarriesSelection(active, terminalTabIds, rows)).toBe(false);
  });

  it("no active tab leaves it on the header", () => {
    expect(childRowCarriesSelection(undefined, terminalTabIds, rows)).toBe(false);
    expect(childRowCarriesSelection(null, terminalTabIds, rows)).toBe(false);
  });

  it("an editor tab leaves it on the header", () => {
    const active = { id: "tab-edit", type: "edit" };
    expect(childRowCarriesSelection(active, terminalTabIds, rows)).toBe(false);
  });
});

describe("hasSubagentRow", () => {
  const byTab = {
    "tab-main": entry([
      record("a1"),
      record("wf1", { agentType: "workflow-subagent", isWorkflow: true }),
    ]),
  };

  it("finds a row agent under one of the task's tabs", () => {
    expect(hasSubagentRow(byTab, ["tab-shell", "tab-main"], "a1")).toBe(true);
  });

  it("does not count a workflow agent, an unknown agent, another task's tab, or no agent", () => {
    expect(hasSubagentRow(byTab, ["tab-main"], "wf1")).toBe(false);
    expect(hasSubagentRow(byTab, ["tab-main"], "nobody")).toBe(false);
    expect(hasSubagentRow(byTab, ["tab-other"], "a1")).toBe(false);
    expect(hasSubagentRow(byTab, ["tab-main"], null)).toBe(false);
  });
});
