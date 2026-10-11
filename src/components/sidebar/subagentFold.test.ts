import { describe, expect, it } from "vitest";
import { foldAllSubagents } from "./subagentFold";
import type { TabSubagents } from "@/store/subagents";

const tab = (sessionId: string, runIds: string[]): TabSubagents => ({
  taskId: "t",
  sessionId,
  agents: {},
  order: [],
  runs: Object.fromEntries(runIds.map(runId => [runId, {}])) as TabSubagents["runs"],
});

describe("foldAllSubagents", () => {
  const subagents = { a: tab("s1", ["r1", "r2"]), b: tab("s2", []) };

  it("folds every group and closes every run", () => {
    const start = { groupByTab: {}, openRunsByTab: { a: ["r1"] } };

    const next = foldAllSubagents(start, subagents, true);

    expect(next?.groupByTab).toEqual({ a: { sessionId: "s1", collapsed: true }, b: { sessionId: "s2", collapsed: true } });
    expect(next?.openRunsByTab.a).toEqual([]);
  });

  it("opens every group and every run", () => {
    const next = foldAllSubagents({ groupByTab: {}, openRunsByTab: {} }, subagents, false);

    expect(next?.groupByTab.a).toEqual({ sessionId: "s1", collapsed: false });
    expect([...(next?.openRunsByTab.a ?? [])].sort()).toEqual(["r1", "r2"]);
  });

  it("changes nothing when everything is already that way, so the store is not written", () => {
    const folded = foldAllSubagents({ groupByTab: {}, openRunsByTab: {} }, subagents, true)!;

    expect(foldAllSubagents(folded, subagents, true)).toBeNull();
  });

  it("re-folds a group whose fold belongs to an older session", () => {
    const stale = { groupByTab: { a: { sessionId: "old", collapsed: true } }, openRunsByTab: {} };

    expect(foldAllSubagents(stale, { a: tab("s1", []) }, true)?.groupByTab.a).toEqual({ sessionId: "s1", collapsed: true });
  });
});
