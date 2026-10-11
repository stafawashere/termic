import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

vi.mock("@/lib/ipc", () => ({
  ptyWrite: vi.fn(),
  ptyKill: vi.fn().mockResolvedValue(undefined),
  taskSetTabs: vi.fn().mockResolvedValue(undefined),
  taskSetTabSessionId: vi.fn().mockResolvedValue(undefined),
  subagentList: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/lib/tabFocus", () => ({
  focusTerminalTab: vi.fn(),
  focusMainTab: vi.fn(),
  focusPaneTab: vi.fn(),
}));

import * as ipc from "@/lib/ipc";
import { useApp } from "@/store/app";
import { useSubagents, receiveSubagentEvent, selectTabSubagents } from "@/store/subagents";
import {
  SUBAGENT_HISTORY_CAP, LAUNCH_REBUILD_CONCURRENCY, rebuildSubagentsForTab, runLaunchRebuild,
} from "@/lib/subagentRebuild";
import type { SubagentSummary, Tab, Task, PersistedTab } from "@/lib/types";

const SESSION = "11111111-2222-4333-8444-555555555555";
const OTHER_SESSION = "99999999-8888-4777-8666-555555555555";
const TASK = "task-1";
const TAB = "tab-1";
const AGENT_A = "a0123456789abcdef";
const AGENT_B = "a1123456789abcdef";
const AGENT_C = "a2123456789abcdef";

function summary(agentId: string, patch: Partial<SubagentSummary> = {}): SubagentSummary {
  return {
    agentId,
    agentType: "Explore",
    description: null,
    model: null,
    toolUseId: null,
    spawnDepth: null,
    parentAgentId: null,
    requestShape: null,
    requestNonInteractive: null,
    workflowPhase: null,
    isWorkflow: false,
    workflowRunId: null,
    mtimeMs: 1_000,
    outcome: "none",
    ...patch,
  };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolveIt!: (value: T) => void;
  const promise = new Promise<T>(r => { resolveIt = r; });
  return { promise, resolve: resolveIt };
}

function terminalTab(patch: Record<string, unknown> = {}): Tab {
  return { id: TAB, type: "terminal", title: "c", cli: "claude", sessionId: SESSION, ...patch } as Tab;
}

function persistedTask(id: string, persisted: PersistedTab[], patch: Partial<Task> = {}): Task {
  return { id, name: id, path: `/Users/u/dev/${id}`, cli: "claude", persisted_tabs: persisted, ...patch } as Task;
}

function setTab(patch: Record<string, unknown> = {}) {
  useApp.setState({ tabs: { [TASK]: [terminalTab(patch)] } });
}

function states(): Record<string, string> {
  const records = selectTabSubagents(TAB)(useSubagents.getState());
  return Object.fromEntries(records.map(record => [record.agentId, record.state]));
}

function wakes(run: () => void): number {
  let count = 0;
  const unsub = useSubagents.subscribe(() => { count++; });
  run();
  unsub();
  return count;
}

beforeEach(() => {
  useSubagents.setState({ byTab: {} });
  useApp.setState({ tabs: {}, tasks: [], agents: [] });
  vi.mocked(ipc.subagentList).mockReset().mockResolvedValue([]);
});

describe("rebuildSubagentsForTab", () => {
  it("asks for the newest SUBAGENT_HISTORY_CAP transcripts of the tab's session", async () => {
    setTab();
    await rebuildSubagentsForTab(TASK, TAB, SESSION);

    expect(SUBAGENT_HISTORY_CAP).toBe(50);
    expect(ipc.subagentList).toHaveBeenCalledWith(TASK, SESSION, SUBAGENT_HISTORY_CAP);
  });

  it("maps outcomes: done, failed, and no end entry as interrupted while the parent is not running", async () => {
    setTab();
    vi.mocked(ipc.subagentList).mockResolvedValue([
      summary(AGENT_A, { outcome: "done" }),
      summary(AGENT_B, { outcome: "failed" }),
      summary(AGENT_C, { outcome: "none" }),
      summary("aGone", { outcome: "expired" }),
    ]);

    expect(await rebuildSubagentsForTab(TASK, TAB, SESSION)).toBe(true);
    expect(states()).toEqual({ [AGENT_A]: "done", [AGENT_B]: "failed", [AGENT_C]: "interrupted" });
    expect(selectTabSubagents(TAB)(useSubagents.getState())[0].source).toBe("scan");
  });

  it("no end entry is unknown, never running, while the parent claude is running", async () => {
    setTab({ ptyId: "pty-1" });
    vi.mocked(ipc.subagentList).mockResolvedValue([summary(AGENT_C, { outcome: "none" })]);

    await rebuildSubagentsForTab(TASK, TAB, SESSION);
    expect(states()).toEqual({ [AGENT_C]: "unknown" });
  });

  it("reads a tab that is only persisted, for a task nobody has opened yet", async () => {
    useApp.setState({ tasks: [persistedTask(TASK, [{ id: TAB, cli: "claude", session_id: SESSION }])] });
    vi.mocked(ipc.subagentList).mockResolvedValue([summary(AGENT_A, { outcome: "none" })]);

    expect(await rebuildSubagentsForTab(TASK, TAB, SESSION)).toBe(true);
    expect(states()).toEqual({ [AGENT_A]: "interrupted" });
  });

  it("drops a result whose session is no longer the tab's when it resolves", async () => {
    setTab();
    const pending = deferred<SubagentSummary[]>();
    vi.mocked(ipc.subagentList).mockReturnValue(pending.promise);

    const rebuild = rebuildSubagentsForTab(TASK, TAB, SESSION);
    useApp.getState().setTabSessionId(TASK, TAB, OTHER_SESSION);

    let writes = 0;
    const unsub = useSubagents.subscribe(() => { writes++; });
    pending.resolve([summary(AGENT_A, { outcome: "done" })]);
    expect(await rebuild).toBe(false);
    unsub();

    expect(writes).toBe(0);
    expect(useSubagents.getState().byTab[TAB]).toBeUndefined();
  });

  it("drops a result when the tab closed or its claude stopped during the scan", async () => {
    setTab({ ptyId: "pty-1" });
    const stopped = deferred<SubagentSummary[]>();
    vi.mocked(ipc.subagentList).mockReturnValue(stopped.promise);
    const rebuildBeforeStop = rebuildSubagentsForTab(TASK, TAB, SESSION);
    setTab({ ptyId: undefined });
    stopped.resolve([summary(AGENT_A)]);
    expect(await rebuildBeforeStop).toBe(false);

    const closed = deferred<SubagentSummary[]>();
    vi.mocked(ipc.subagentList).mockReturnValue(closed.promise);
    const rebuildBeforeClose = rebuildSubagentsForTab(TASK, TAB, SESSION);
    useApp.setState({ tabs: { [TASK]: [] } });
    closed.resolve([summary(AGENT_A)]);
    expect(await rebuildBeforeClose).toBe(false);

    expect(useSubagents.getState().byTab[TAB]).toBeUndefined();
  });

  it("hooks that land while the scan is in flight win, and nothing is listed twice", async () => {
    setTab({ ptyId: "pty-1" });
    const pending = deferred<SubagentSummary[]>();
    vi.mocked(ipc.subagentList).mockReturnValueOnce(pending.promise).mockResolvedValue([]);

    const rebuild = rebuildSubagentsForTab(TASK, TAB, SESSION);
    const origin = { taskId: TASK, tabId: TAB, tabSessionId: SESSION };
    receiveSubagentEvent(origin, { phase: "start", sessionId: SESSION, agentId: AGENT_A, agentType: "Explore" });
    receiveSubagentEvent(origin, { phase: "start", sessionId: SESSION, agentId: AGENT_B, agentType: "Explore" });
    receiveSubagentEvent(origin, { phase: "stop", sessionId: SESSION, agentId: AGENT_B, agentType: "Explore" });

    pending.resolve([
      summary(AGENT_A, { outcome: "done", description: "Look around" }),
      summary(AGENT_B, { outcome: "none" }),
      summary(AGENT_C, { outcome: "failed" }),
    ]);
    await rebuild;

    const records = selectTabSubagents(TAB)(useSubagents.getState());
    expect(records.map(record => record.agentId).sort()).toEqual([AGENT_A, AGENT_B, AGENT_C].sort());
    expect(states()).toEqual({ [AGENT_A]: "running", [AGENT_B]: "unknown", [AGENT_C]: "failed" });
    expect(records.find(record => record.agentId === AGENT_A)?.description).toBe("Look around");
  });

  it("never turns a hook-reported done into anything else", async () => {
    setTab();
    useSubagents.getState().start(TASK, TAB, SESSION, AGENT_A, "Explore");
    useSubagents.getState().stop(TAB, AGENT_A, "done");
    vi.mocked(ipc.subagentList).mockResolvedValue([summary(AGENT_A, { outcome: "none" })]);

    await rebuildSubagentsForTab(TASK, TAB, SESSION);
    expect(states()).toEqual({ [AGENT_A]: "done" });
  });

  it("a rescan of an unchanged directory notifies no subscriber", async () => {
    setTab();
    const listing = [summary(AGENT_A, { outcome: "done" }), summary(AGENT_B, { outcome: "none", mtimeMs: 2_000 })];
    vi.mocked(ipc.subagentList).mockResolvedValue(listing);
    await rebuildSubagentsForTab(TASK, TAB, SESSION);

    let notifications = 0;
    const unsub = useSubagents.subscribe(() => { notifications++; });
    await rebuildSubagentsForTab(TASK, TAB, SESSION);
    unsub();

    expect(notifications).toBe(0);
  });

  it("a session change swaps the rows to the new session's history", async () => {
    setTab();
    vi.mocked(ipc.subagentList).mockResolvedValue([summary(AGENT_A, { outcome: "done" })]);
    await rebuildSubagentsForTab(TASK, TAB, SESSION);

    useApp.getState().setTabSessionId(TASK, TAB, OTHER_SESSION);
    vi.mocked(ipc.subagentList).mockResolvedValue([summary(AGENT_B, { outcome: "failed" })]);
    await rebuildSubagentsForTab(TASK, TAB, OTHER_SESSION);

    expect(states()).toEqual({ [AGENT_B]: "failed" });
    expect(useSubagents.getState().byTab[TAB].sessionId).toBe(OTHER_SESSION);
  });
});

describe("mergeScanned", () => {
  it("bails on a scan that changes nothing", () => {
    const listing = [summary(AGENT_A, { outcome: "done" })];
    useSubagents.getState().mergeScanned(TASK, TAB, SESSION, listing, false);

    expect(wakes(() => useSubagents.getState().mergeScanned(TASK, TAB, SESSION, listing, false))).toBe(0);
    expect(wakes(() => useSubagents.getState().mergeScanned(TASK, TAB, SESSION, [], false))).toBe(0);
  });

  it("orders scanned records oldest first", () => {
    useSubagents.getState().mergeScanned(TASK, TAB, SESSION, [
      summary(AGENT_B, { mtimeMs: 3_000 }),
      summary(AGENT_A, { mtimeMs: 1_000 }),
    ], false);

    expect(selectTabSubagents(TAB)(useSubagents.getState()).map(record => record.agentId)).toEqual([AGENT_A, AGENT_B]);
  });
});

describe("runLaunchRebuild", () => {
  afterEach(() => {
    vi.mocked(ipc.subagentList).mockReset().mockResolvedValue([]);
  });

  it("scans every restored claude tab with a session, never more than two at a time", async () => {
    const sessionOf = (index: number) => `${index}1111111-2222-4333-8444-555555555555`;
    const claudeTabs = (taskIndex: number): PersistedTab[] => [
      { id: `t${taskIndex}-a`, cli: "claude", session_id: sessionOf(taskIndex) },
      { id: `t${taskIndex}-codex`, cli: "codex", session_id: null },
      { id: `t${taskIndex}-fresh`, cli: "claude", session_id: null },
    ];
    useApp.setState({
      tasks: [
        persistedTask("w1", claudeTabs(1)),
        persistedTask("w2", claudeTabs(2)),
        persistedTask("w3", claudeTabs(3)),
        persistedTask("w4", claudeTabs(4)),
        persistedTask("w5", claudeTabs(5), { archived: true } as Partial<Task>),
      ],
    });

    let inFlight = 0;
    let peak = 0;
    vi.mocked(ipc.subagentList).mockImplementation(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise(r => setTimeout(r, 5));
      inFlight--;
      return [summary(AGENT_A, { outcome: "done" })];
    });

    await runLaunchRebuild();

    const asked = vi.mocked(ipc.subagentList).mock.calls.map(call => call[0]).sort();
    expect(asked).toEqual(["w1", "w2", "w3", "w4"]);
    expect(peak).toBe(LAUNCH_REBUILD_CONCURRENCY);
    expect(LAUNCH_REBUILD_CONCURRENCY).toBe(2);
    expect(useSubagents.getState().byTab["t1-a"].agents[AGENT_A].state).toBe("done");
  });
});

describe("scheduleLaunchRebuild", () => {
  it("defers to an idle callback, runs once, and returns before any scan", async () => {
    vi.resetModules();
    const idle: Array<() => void> = [];
    vi.stubGlobal("window", { requestIdleCallback: (run: () => void) => { idle.push(run); return 1; } });
    try {
      const fresh = await import("@/lib/subagentRebuild");
      const freshIpc = await import("@/lib/ipc");
      vi.mocked(freshIpc.subagentList).mockClear();

      fresh.scheduleLaunchRebuild();
      fresh.scheduleLaunchRebuild();
      expect(idle).toHaveLength(1);
      expect(freshIpc.subagentList).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("startup never waits on the rebuild", () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const appTsx = readFileSync(resolve(root, "src/App.tsx"), "utf8");
  const appStore = readFileSync(resolve(root, "src/store/app.ts"), "utf8");

  it("App schedules it after loadAll without awaiting it", () => {
    expect(appTsx).toContain("void loaded.then(() => scheduleLaunchRebuild());");
    expect(appTsx).not.toMatch(/await[^;\n]*(scheduleLaunchRebuild|runLaunchRebuild|rebuildSubagentsForTab)/);
  });

  it("hydration (loadAll, ensureDefaultTab) never reaches it", () => {
    expect(appStore).not.toMatch(/subagentRebuild|scheduleLaunchRebuild|runLaunchRebuild|rebuildSubagentsForTab/);
  });
});
