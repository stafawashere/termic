// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";
import { hasBusyEdge, shouldAutoExpandSubagents, shouldAutoExpandTask, spawnedSubagentIds } from "./useAutoExpand";
import type { SubagentRecord, TabSubagents } from "@/store/subagents";
import type { Tab } from "@/lib/types";

const agentTab = (id: string, workState: "idle" | "working" | "done", cli = "claude") =>
  ({ id, type: "terminal", cli, workState }) as unknown as Tab;

const record = (agentId: string, source: "hook" | "scan", state: SubagentRecord["state"] = "running") =>
  ({ agentId, source, state }) as SubagentRecord;

const entry = (sessionId: string, records: SubagentRecord[]): TabSubagents => ({
  taskId: "t",
  sessionId,
  agents: Object.fromEntries(records.map(r => [r.agentId, r])),
  order: records.map(r => r.agentId),
  runs: {},
});

describe("shouldAutoExpandTask", () => {
  it("opens a task that is folded by its mode's default", () => {
    expect(shouldAutoExpandTask(undefined, "chevron", 1)).toBe(true);
    expect(shouldAutoExpandTask(undefined, "click", 1)).toBe(true);
  });

  it("leaves a task the user folded by hand alone, even where the mode would open it", () => {
    expect(shouldAutoExpandTask(true, "chevron", 3)).toBe(false);
    expect(shouldAutoExpandTask(true, "always", 3)).toBe(false);
  });

  it("does nothing for a task that is already open", () => {
    expect(shouldAutoExpandTask(undefined, "always", 1)).toBe(false);
    expect(shouldAutoExpandTask(undefined, "click", 2)).toBe(false);
    expect(shouldAutoExpandTask(false, "chevron", 1)).toBe(false);
  });
});

describe("hasBusyEdge", () => {
  it("fires when an agent tab goes from idle to working", () => {
    expect(hasBusyEdge([agentTab("a", "idle")], [agentTab("a", "working")])).toBe(true);
  });

  it("fires for an agent tab that appears already working", () => {
    expect(hasBusyEdge([], [agentTab("a", "working")])).toBe(true);
  });

  it("does not fire while the agent stays working, or when it finishes", () => {
    expect(hasBusyEdge([agentTab("a", "working")], [agentTab("a", "working")])).toBe(false);
    expect(hasBusyEdge([agentTab("a", "working")], [agentTab("a", "done")])).toBe(false);
  });

  it("ignores a plain shell tab that reports working", () => {
    expect(hasBusyEdge([agentTab("a", "idle", "shell")], [agentTab("a", "working", "shell")])).toBe(false);
  });
});

describe("spawnedSubagentIds", () => {
  it("reports a hook-created agent the previous snapshot lacked", () => {
    const before = entry("s1", [record("a", "hook", "done")]);
    const after = entry("s1", [record("a", "hook", "done"), record("b", "hook")]);

    expect(spawnedSubagentIds(before, after)).toEqual(["b"]);
  });

  it("does not report records a disk scan rebuilt", () => {
    const after = entry("s1", [record("a", "scan")]);

    expect(spawnedSubagentIds(undefined, after)).toEqual([]);
  });

  it("does not report agents that were already there", () => {
    const same = entry("s1", [record("a", "hook")]);

    expect(spawnedSubagentIds(same, { ...same })).toEqual([]);
  });

  it("treats every agent of a new session as new", () => {
    const before = entry("s1", [record("a", "hook")]);
    const after = entry("s2", [record("a", "hook")]);

    expect(spawnedSubagentIds(before, after)).toEqual(["a"]);
  });
});

describe("shouldAutoExpandSubagents", () => {
  const spawned = entry("s1", [record("a", "hook")]);

  it("opens a group that would otherwise show folded", () => {
    expect(shouldAutoExpandSubagents(spawned, undefined, "always")).toBe(true);
  });

  it("leaves a group the user folded or opened for this session alone", () => {
    expect(shouldAutoExpandSubagents(spawned, { sessionId: "s1", collapsed: true }, "always")).toBe(false);
    expect(shouldAutoExpandSubagents(spawned, { sessionId: "s1", collapsed: false }, "always")).toBe(false);
  });

  it("ignores a fold left over from an older session", () => {
    expect(shouldAutoExpandSubagents(spawned, { sessionId: "old", collapsed: true }, "always")).toBe(true);
  });

  it("writes nothing when the group is already showing open", () => {
    expect(shouldAutoExpandSubagents(spawned, undefined, "never")).toBe(false);
    expect(shouldAutoExpandSubagents(spawned, undefined, "allFinished")).toBe(false);
  });
});
