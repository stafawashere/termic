import { describe, it, expect } from "vitest";
import {
  buildSubagentTree, childRowCarriesSelection, createSubagentStructureSelector, hasSubagentRow,
  isPastRetention, nextRetentionExpiry, parseSubagentStructureKey, subagentGroupStartsCollapsed,
  subagentStructureKey, EMPTY_SUBAGENT_TREE, MAX_SUBAGENT_INDENT_DEPTH,
  type SubagentLink, type SubagentRowRules,
} from "./subagentTree";
import { DEFAULT_SUBAGENT_TYPE_FILTER } from "@/lib/subagentPrefs";
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
    workflowRunId: null,
    workflowPhase: null,
    ...extra,
  };
}

function entry(records: SubagentRecord[]): TabSubagents {
  return {
    taskId: "task-1",
    sessionId: "11111111-2222-4333-8444-555555555555",
    agents: Object.fromEntries(records.map(r => [r.agentId, r])),
    order: records.map(r => r.agentId),
    runs: {},
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

describe("rows under the Settings rules", () => {
  const HOUR = 60 * 60 * 1000;

  function rules(patch: Partial<SubagentRowRules> = {}): SubagentRowRules {
    return { typeFilter: DEFAULT_SUBAGENT_TYPE_FILTER, retentionMs: null, now: 10 * HOUR, ...patch };
  }

  const keyIds = (key: string) => parseSubagentStructureKey(key).map(l => l.agentId);

  it("hides the agents whose kind is filtered out, and only those", () => {
    const tab = entry([
      record("a", { agentType: "Explore" }),
      record("b", { agentType: "reviewer" }),
      record("c", { agentType: "fork" }),
    ]);
    const noBuiltIn = rules({ typeFilter: { ...DEFAULT_SUBAGENT_TYPE_FILTER, builtIn: false } });
    const noCustom = rules({ typeFilter: { ...DEFAULT_SUBAGENT_TYPE_FILTER, custom: false } });

    expect(keyIds(subagentStructureKey(tab, rules()))).toEqual(["a", "b", "c"]);
    expect(keyIds(subagentStructureKey(tab, noBuiltIn))).toEqual(["b", "c"]);
    expect(keyIds(subagentStructureKey(tab, noCustom))).toEqual(["a", "c"]);
  });

  it("never gives a workflow agent a row, whatever its filter says", () => {
    const tab = entry([record("w", { agentType: "workflow-subagent", isWorkflow: true })]);
    const workflowOn = rules({ typeFilter: { ...DEFAULT_SUBAGENT_TYPE_FILTER, workflow: true } });

    expect(subagentStructureKey(tab, workflowOn)).toBe("");
  });

  it("re-roots a child under the tab when its parent is filtered out", () => {
    const tab = entry([
      record("p", { agentType: "reviewer" }),
      record("k", { agentType: "Explore", parentAgentId: "p" }),
    ]);
    const noCustom = rules({ typeFilter: { ...DEFAULT_SUBAGENT_TYPE_FILTER, custom: false } });
    const rows = buildSubagentTree(parseSubagentStructureKey(subagentStructureKey(tab, noCustom)), NONE);

    expect(ids(rows)).toEqual(["k"]);
    expect(depths(rows)).toEqual([1]);
  });

  it("keeps a running row past any retention window", () => {
    const running = record("a", { state: "running", startedAt: 0 });

    expect(isPastRetention(running, 0, 10 * HOUR)).toBe(false);
    expect(isPastRetention(running, HOUR, 10 * HOUR)).toBe(false);
  });

  it("takes an ended row away once its window has passed, and not before", () => {
    const done = record("a", { state: "done", endedAt: 9 * HOUR });

    expect(isPastRetention(done, null, 100 * HOUR)).toBe(false);
    expect(isPastRetention(done, HOUR, 9.5 * HOUR)).toBe(false);
    expect(isPastRetention(done, HOUR, 10 * HOUR)).toBe(true);
    expect(isPastRetention(done, 0, 9 * HOUR)).toBe(true);
  });

  it("treats failed and interrupted rows as ended", () => {
    for (const state of ["failed", "interrupted"] as const) {
      expect(isPastRetention(record("a", { state, endedAt: 0 }), 0, 0)).toBe(true);
    }
  });

  it("keeps a row whose end is not known yet, since it may still be running", () => {
    expect(isPastRetention(record("a", { state: "unknown", endedAt: 0 }), 0, 10 * HOUR)).toBe(false);
  });

  it("leaves an expired row alone, since its transcript going is not retention", () => {
    expect(isPastRetention(record("a", { state: "expired", endedAt: 0 }), 0, 10 * HOUR)).toBe(false);
  });

  it("times a scanned row with no end time from its transcript's last write", () => {
    const scanned = record("a", { state: "interrupted", startedAt: 9 * HOUR, endedAt: null, source: "scan" });

    expect(isPastRetention(scanned, HOUR, 9.5 * HOUR)).toBe(false);
    expect(isPastRetention(scanned, HOUR, 10 * HOUR)).toBe(true);
  });

  it("names the soonest moment a shown row ends its stay, or null with nothing waiting", () => {
    const tab = entry([
      record("a", { state: "done", endedAt: 9.5 * HOUR }),
      record("b", { state: "failed", endedAt: 9.2 * HOUR }),
      record("c", { state: "running" }),
    ]);

    expect(nextRetentionExpiry(tab, rules({ retentionMs: HOUR }))).toBe(10.2 * HOUR);
    expect(nextRetentionExpiry(tab, rules({ retentionMs: null }))).toBeNull();
    expect(nextRetentionExpiry(tab, rules({ retentionMs: 0 }))).toBeNull();
    expect(nextRetentionExpiry(entry([record("c")]), rules({ retentionMs: HOUR }))).toBeNull();
  });

  it("leaves the structure key alone when an agent finishes under session retention", () => {
    const running = entry([record("a"), record("b")]);
    const finished = entry([record("a", { state: "done", endedAt: 1 }), record("b")]);

    expect(subagentStructureKey(finished, rules())).toBe(subagentStructureKey(running, rules()));
  });

  it("drops a finished agent from the key at once when finished rows hide", () => {
    const finished = entry([record("a", { state: "done", endedAt: 1 }), record("b")]);

    expect(keyIds(subagentStructureKey(finished, rules({ retentionMs: 0 })))).toEqual(["b"]);
  });
});

describe("subagentGroupStartsCollapsed", () => {
  it("never and always ignore the agents", () => {
    const tab = entry([record("a")]);

    expect(subagentGroupStartsCollapsed(tab, "never")).toBe(false);
    expect(subagentGroupStartsCollapsed(tab, "always")).toBe(true);
  });

  it("collapses once every agent has ended, and not while one runs", () => {
    const oneRunning = entry([record("a", { state: "done" }), record("b")]);
    const allEnded = entry([record("a", { state: "done" }), record("b", { state: "failed" })]);

    expect(subagentGroupStartsCollapsed(oneRunning, "allFinished")).toBe(false);
    expect(subagentGroupStartsCollapsed(allEnded, "allFinished")).toBe(true);
  });

  it("does not count workflow agents, and stays open with no agent at all", () => {
    const onlyWorkflow = entry([record("w", { isWorkflow: true, state: "done" })]);
    const runningWorkflow = entry([record("a", { state: "done" }), record("w", { isWorkflow: true })]);

    expect(subagentGroupStartsCollapsed(undefined, "allFinished")).toBe(false);
    expect(subagentGroupStartsCollapsed(onlyWorkflow, "allFinished")).toBe(false);
    expect(subagentGroupStartsCollapsed(runningWorkflow, "allFinished")).toBe(true);
  });
});
