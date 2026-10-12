import { describe, it, expect } from "vitest";
import {
  buildSubagentTree, childRowCarriesSelection, createSubagentStructureSelector, createWorkflowRunCountsSelector,
  hasSubagentRow, isPastRetention, nextRetentionExpiry, parseSubagentStructureKey, subagentGroupStartsCollapsed,
  subagentGuideLines, subagentRowIndent, subagentRowsOfKey, subagentStructureKey, workflowRunName, EMPTY_SUBAGENT_TREE, MAX_SUBAGENT_INDENT_DEPTH,
  type SubagentLink, type SubagentRowRules, type SubagentTreeRow,
} from "./subagentTree";
import { DEFAULT_SUBAGENT_TYPE_FILTER } from "@/lib/subagentPrefs";
import type { SubagentRecord, TabSubagents } from "@/store/subagents";

const NONE: ReadonlySet<string> = new Set();

function link(agentId: string, parentAgentId: string | null = null): SubagentLink {
  return { kind: "agent", agentId, parentAgentId };
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

const ids = (rows: readonly SubagentTreeRow[]) => rows.map(row => row.key);
const hasKids = (row: SubagentTreeRow) => row.kind === "agent" && row.hasChildren;
const depths = (rows: readonly { depth: number }[]) => rows.map(row => row.depth);

describe("buildSubagentTree", () => {
  it("returns the shared empty list when there is nothing", () => {
    expect(buildSubagentTree([], NONE)).toBe(EMPTY_SUBAGENT_TREE);
  });

  it("puts agents with no parent directly under the tab, in spawn order", () => {
    const rows = buildSubagentTree([link("a"), link("b"), link("c")], NONE);

    expect(ids(rows)).toEqual(["a", "b", "c"]);
    expect(depths(rows)).toEqual([1, 1, 1]);
    expect(rows.every(row => !hasKids(row))).toBe(true);
  });

  it("nests a child right after its parent, one level deeper", () => {
    const rows = buildSubagentTree([link("p"), link("x"), link("c", "p")], NONE);

    expect(ids(rows)).toEqual(["p", "c", "x"]);
    expect(depths(rows)).toEqual([1, 2, 1]);
    expect(hasKids(rows[0])).toBe(true);
    expect(hasKids(rows[1])).toBe(false);
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
    expect(after.find(row => row.key === "c")?.depth).toBe(2);
    expect(after.find(row => row.key === "x")?.depth).toBe(1);
  });

  it("leaves out the subtree of a folded agent but keeps the agent itself", () => {
    const links = [link("p"), link("c", "p"), link("g", "c"), link("x")];
    const rows = buildSubagentTree(links, new Set(["p"]));

    expect(ids(rows)).toEqual(["p", "x"]);
    expect(hasKids(rows[0])).toBe(true);
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
  it("leaves out a workflow agent no listing has placed in a run yet", () => {
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

  it("does not count an unplaced workflow agent, an unknown agent, another task's tab, or no agent", () => {
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

  const keyIds = (key: string) => parseSubagentStructureKey(key).map(item => ("agentId" in item ? item.agentId : item.kind));

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

  it("draws a workflow run only while the workflow filter is on", () => {
    const tab = entry([record("w", { agentType: "workflow-subagent", isWorkflow: true, workflowRunId: "wf_r1" })]);
    const workflowOn = rules({ typeFilter: { ...DEFAULT_SUBAGENT_TYPE_FILTER, workflow: true } });
    const workflowOff = rules({ typeFilter: { ...DEFAULT_SUBAGENT_TYPE_FILTER, workflow: false } });

    expect(subagentStructureKey(tab, workflowOn)).toBe("run:wf_r1;");
    expect(subagentStructureKey(tab, workflowOff)).toBe("");
  });

  it("flipping the workflow filter off and on takes the run segment out and puts it back", () => {
    const tab = entry([
      record("a"),
      record("w", { agentType: "workflow-subagent", isWorkflow: true, workflowRunId: "wf_r1" }),
    ]);
    const workflowOn = rules({ typeFilter: { ...DEFAULT_SUBAGENT_TYPE_FILTER, workflow: true } });
    const workflowOff = rules({ typeFilter: { ...DEFAULT_SUBAGENT_TYPE_FILTER, workflow: false } });

    const before = subagentStructureKey(tab, workflowOn);
    const off = subagentStructureKey(tab, workflowOff);
    const back = subagentStructureKey(tab, workflowOn);

    expect(before).toBe("a>;run:wf_r1;");
    expect(off).toBe("a>;");
    expect(back).toBe(before);
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

  it("never takes the row whose transcript is on screen", () => {
    const done = record("a", { state: "done", endedAt: 0 });
    const seen = { visibleAgentId: "a", lastSeenAt: { a: 0 } };

    expect(isPastRetention(done, 0, 10 * HOUR, seen)).toBe(false);
    expect(isPastRetention(done, 10_000, 10 * HOUR, seen)).toBe(false);
  });

  it("counts the window from the last time the transcript was on screen", () => {
    const done = record("a", { state: "done", endedAt: 0 });
    const seen = { visibleAgentId: null, lastSeenAt: { a: 60_000 } };

    expect(isPastRetention(done, 10_000, 69_999, seen)).toBe(false);
    expect(isPastRetention(done, 10_000, 70_000, seen)).toBe(true);
  });

  it("schedules the expiry from the last view, and none for the row on screen", () => {
    const tab = entry([record("a", { state: "done", endedAt: 0 })]);

    expect(nextRetentionExpiry(tab, rules({ retentionMs: 10_000, now: 65_000, lastSeenAt: { a: 60_000 } }))).toBe(70_000);
    expect(nextRetentionExpiry(tab, rules({ retentionMs: 10_000, now: 65_000, visibleAgentId: "a" }))).toBeNull();
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

  it("counts the agents of a run, and stays open with no agent at all", () => {
    const finishedRun = entry([record("w", { isWorkflow: true, workflowRunId: "wf_r1", state: "done" })]);
    const runningRun = entry([
      record("a", { state: "done" }),
      record("w", { isWorkflow: true, workflowRunId: "wf_r1" }),
    ]);

    expect(subagentGroupStartsCollapsed(undefined, "allFinished")).toBe(false);
    expect(subagentGroupStartsCollapsed(finishedRun, "allFinished")).toBe(true);
    expect(subagentGroupStartsCollapsed(runningRun, "allFinished")).toBe(false);
  });

  it("does not count an unplaced workflow agent", () => {
    const unplacedRunning = entry([record("a", { state: "done" }), record("w", { isWorkflow: true })]);

    expect(subagentGroupStartsCollapsed(unplacedRunning, "allFinished")).toBe(true);
  });

  it("counts only the agents the type filters show", () => {
    const tab = entry([
      record("r", { agentType: "reviewer", state: "running" }),
      record("w1", { isWorkflow: true, workflowRunId: "wf_r1", state: "done", endedAt: 1 }),
      record("w2", { isWorkflow: true, workflowRunId: "wf_r1", state: "failed", endedAt: 1 }),
    ]);
    const typeFilter = { builtIn: true, custom: false, fork: true, workflow: true };
    const noCustom = { typeFilter, retentionMs: null, now: 0 };

    expect(subagentGroupStartsCollapsed(tab, "allFinished")).toBe(false);
    expect(subagentGroupStartsCollapsed(tab, "allFinished", noCustom)).toBe(true);
  });
});

describe("workflow runs", () => {
  const RUN = "wf_r1";
  const ALL_KINDS = { builtIn: true, custom: true, fork: true, workflow: true };

  function wf(agentId: string, phase: string | null, extra: Partial<SubagentRecord> = {}): SubagentRecord {
    return record(agentId, {
      agentType: "workflow-subagent", isWorkflow: true, workflowRunId: RUN, workflowPhase: phase, ...extra,
    });
  }

  function rowsOf(tab: TabSubagents, open: readonly string[] = [], folded: ReadonlySet<string> = NONE) {
    return buildSubagentTree(parseSubagentStructureKey(subagentStructureKey(tab, undefined, new Set(open))), folded);
  }

  const shape = (rows: readonly SubagentTreeRow[]) => rows.map(row => `${row.kind} ${row.key} ${row.depth}`);

  it("draws a collapsed run as one run row at depth 0, keyed apart from its agents", () => {
    const tab = entry([wf("w1", "Build"), wf("w2", "Build"), wf("w3", null)]);
    const rows = rowsOf(tab);

    expect(subagentStructureKey(tab)).toBe(`run:${RUN};`);
    expect(shape(rows)).toEqual([`run run:${RUN} 0`]);
    expect(rows[0]).toMatchObject({ kind: "run", runId: RUN, open: false });
  });

  it("opens to its phases with their agents, then the agents with no phase", () => {
    const tab = entry([
      wf("w1", "Build", { startedAt: 1 }),
      wf("w2", null, { startedAt: 2 }),
      wf("w3", "Plan", { startedAt: 3 }),
      wf("w4", "Build", { startedAt: 4 }),
    ]);
    tab.runs[RUN] = { name: "acme-release", phases: ["Plan", "Build"] };

    expect(shape(rowsOf(tab, [RUN]))).toEqual([
      `run run:${RUN} 0`,
      `phase phase:${RUN}:0 1`,
      "agent w3 2",
      `phase phase:${RUN}:1 1`,
      "agent w1 2",
      "agent w4 2",
      "agent w2 1",
    ]);
  });

  it("orders phases the run file does not list by their earliest agent's start", () => {
    const tab = entry([
      wf("late-review", "Review", { startedAt: 30 }),
      wf("early-build", "Build", { startedAt: 10 }),
      wf("mid-review", "Review", { startedAt: 20 }),
    ]);

    const phases = rowsOf(tab, [RUN]).filter(row => row.kind === "phase");
    expect(phases.map(row => row.kind === "phase" && row.title)).toEqual(["Build", "Review"]);
  });

  it("puts declared phases before undeclared ones, whatever started first", () => {
    const tab = entry([wf("x", "Extra", { startedAt: 1 }), wf("p", "Plan", { startedAt: 5 })]);
    tab.runs[RUN] = { name: null, phases: ["Plan"] };

    const phases = rowsOf(tab, [RUN]).filter(row => row.kind === "phase");
    expect(phases.map(row => row.key)).toEqual([`phase:${RUN}:0`, `phase:${RUN}:1`]);
    expect(phases.map(row => row.kind === "phase" && row.title)).toEqual(["Plan", "Extra"]);
  });

  it("keeps a phase title with key characters in it intact", () => {
    const title = "Build: a;b>c";
    const tab = entry([wf("w1", title)]);

    const phase = rowsOf(tab, [RUN]).find(row => row.kind === "phase");
    expect(phase).toMatchObject({ title });
  });

  it("a folded phase hides its agents but not the run's agents with no phase", () => {
    const tab = entry([wf("w1", "Build"), wf("w2", null)]);
    const rows = rowsOf(tab, [RUN], new Set([`phase:${RUN}:0`]));

    expect(shape(rows)).toEqual([`run run:${RUN} 0`, `phase phase:${RUN}:0 1`, "agent w2 1"]);
  });

  it("sits where its first agent started among the plain agents", () => {
    const tab = entry([record("a"), wf("w1", "Build"), record("b"), wf("w2", "Build")]);

    expect(ids(rowsOf(tab))).toEqual(["a", `run:${RUN}`, "b"]);
  });

  it("keeps the key identical while agents of a 300-agent collapsed run start, stop and move", () => {
    const agents = Array.from({ length: 300 }, (_, i) => wf(`w${i}`, i % 2 ? "Build" : "Plan", { startedAt: i }));
    const base = entry(agents);
    const key = subagentStructureKey(base, undefined, new Set());

    const started = entry([...agents, wf("w300", "Plan", { startedAt: 300 })]);
    const stopped = entry(agents.map(a => (a.agentId === "w7" ? { ...a, state: "done" as const, endedAt: 9 } : a)));
    const moved = entry(agents.map(a => (a.agentId === "w8" ? { ...a, workflowPhase: "Review" } : a)));

    expect(key).toBe(`run:${RUN};`);
    expect(subagentStructureKey(started, undefined, new Set())).toBe(key);
    expect(subagentStructureKey(stopped, undefined, new Set())).toBe(key);
    expect(subagentStructureKey(moved, undefined, new Set())).toBe(key);

    // The same start and move reach the key once the run is open.
    const open = new Set([RUN]);
    const openKey = subagentStructureKey(base, undefined, open);
    expect(subagentStructureKey(started, undefined, open)).not.toBe(openKey);
    expect(subagentStructureKey(moved, undefined, open)).not.toBe(openKey);
  });

  it("draws no run row when every agent is filtered out or past retention", () => {
    const tab = entry([wf("w1", "Build", { state: "done", endedAt: 1 }), wf("w2", "Build", { state: "failed", endedAt: 1 })]);
    const noWorkflow = { typeFilter: { ...ALL_KINDS, workflow: false }, retentionMs: null, now: 10 };
    const finishedGone = { typeFilter: ALL_KINDS, retentionMs: 0, now: 10 };

    expect(subagentStructureKey(tab, noWorkflow)).toBe("");
    expect(subagentStructureKey(tab, finishedGone)).toBe("");
    expect(subagentStructureKey(tab, { typeFilter: ALL_KINDS, retentionMs: null, now: 10 })).toBe(`run:${RUN};`);
  });

  it("a tab with only workflow agents draws its run under the group chevron, in every fold state", () => {
    const tab = entry([wf("w1", "Build"), wf("w2", null)]);
    const phaseFold = new Set([`phase:${RUN}:0`]);
    const states: [ReadonlySet<string>, ReadonlySet<string>][] = [
      [NONE, NONE],
      [new Set([RUN]), NONE],
      [new Set([RUN]), phaseFold],
    ];

    for (const [open, folded] of states) {
      const key = subagentStructureKey(tab, undefined, open);
      const rows = subagentRowsOfKey(key, folded);

      expect(key).not.toBe("");
      expect(rows[0]).toMatchObject({ kind: "run", runId: RUN });
    }
  });

  it("indents a run like a plain agent and everything in it one step deeper", () => {
    const tab = entry([record("a"), wf("w1", "Build"), wf("w2", null)]);
    const rows = subagentRowsOfKey(subagentStructureKey(tab, undefined, new Set([RUN])), NONE);

    expect(rows.map(row => `${row.key} ${subagentRowIndent(row)}`)).toEqual([
      "a 1",
      `run:${RUN} 1`,
      `phase:${RUN}:0 2`,
      "w1 3",
      "w2 2",
    ]);
  });

  it("is named by its run file, or by its id with the wf_ prefix kept", () => {
    const tab = entry([wf("w1", null)]);

    expect(workflowRunName(tab, RUN)).toBe(RUN);
    tab.runs[RUN] = { name: "acme-release", phases: null };
    expect(workflowRunName(tab, RUN)).toBe("acme-release");
  });

  it("a workflow agent has a header row while its run is drawn, collapsed or not", () => {
    const byTab = { "tab-main": entry([wf("w1", "Build"), wf("w2", "Build", { state: "done", endedAt: 1 })]) };
    const workflowOn = { typeFilter: ALL_KINDS, retentionMs: 0, now: 10 };
    const workflowOff = { typeFilter: { ...ALL_KINDS, workflow: false }, retentionMs: null, now: 10 };

    expect(hasSubagentRow(byTab, ["tab-main"], "w1")).toBe(true);
    // w2 is past retention, but its run still draws for w1.
    expect(hasSubagentRow(byTab, ["tab-main"], "w2", workflowOn)).toBe(true);
    expect(hasSubagentRow(byTab, ["tab-main"], "w1", workflowOff)).toBe(false);
  });

  it("counts a run's agents as one string that moves only when a count does", () => {
    const tab = entry([wf("w1", "Build"), wf("w2", "Build"), record("plain")]);
    const select = createWorkflowRunCountsSelector("tab-1", RUN);

    const first = select({ byTab: { "tab-1": tab } });
    expect(first).toBe("2/2/0");

    const renamed = entry([wf("w1", "Build", { description: "x" }), wf("w2", "Build"), record("plain")]);
    expect(select({ byTab: { "tab-1": renamed } })).toBe(first);

    const failed = entry([wf("w1", "Build", { state: "failed", endedAt: 1 }), wf("w2", "Build"), record("plain")]);
    expect(select({ byTab: { "tab-1": failed } })).toBe("1/2/1");
  });
});

describe("subagentGuideLines", () => {
  it("stops a guide at the last sibling and carries an open ancestor's guide past its children", () => {
    // a
    //   a1
    //   a2
    //     a2x
    // b
    //   b1
    const lines = subagentGuideLines([1, 2, 2, 3, 1, 2]);

    expect(lines.map(line => line.last)).toEqual([false, false, true, true, true, true]);
    expect(lines.map(line => line.through)).toEqual([[], [1], [1], [1], [], []]);
  });
});

