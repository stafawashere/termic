import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

vi.mock("@/lib/ipc", () => ({
  ptyWrite: vi.fn(),
  ptyKill: vi.fn().mockResolvedValue(undefined),
  projectsList: vi.fn().mockResolvedValue([]),
  tasksList: vi.fn().mockResolvedValue([]),
  settingsLoad: vi.fn().mockResolvedValue({ agents: [] }),
  detectClis: vi.fn().mockResolvedValue([]),
  taskSetTabs: vi.fn().mockResolvedValue(undefined),
  taskSetTabSessionId: vi.fn().mockResolvedValue(undefined),
  subagentList: vi.fn().mockResolvedValue([]),
  subagentWorkflowRuns: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/lib/tabFocus", () => ({
  focusTerminalTab: vi.fn(),
  focusMainTab: vi.fn(),
  focusPaneTab: vi.fn(),
}));

import * as ipc from "@/lib/ipc";
import { useApp } from "@/store/app";
import {
  useSubagents, selectTabSubagents, selectTabSubagentRows, receiveSubagentEvent,
  EMPTY_SUBAGENTS,
} from "@/store/subagents";
import { WORKFLOW_AGENT_TYPE } from "@/lib/subagentKind";
import { deliverSubagentEvent, type SubagentHookEvent } from "@/lib/subagentHooks";
import type { SubagentSummary, Tab, WorkflowRunInfo } from "@/lib/types";

const SESSION = "11111111-2222-4333-8444-555555555555";
const OTHER_SESSION = "99999999-8888-4777-8666-555555555555";
const TASK = "task-1";
const TAB = "tab-1";
const AGENT_A = "a0123456789abcdef";
const AGENT_B = "a1123456789abcdef";

function startA(agentId = AGENT_A, agentType = "Explore") {
  useSubagents.getState().start(TASK, TAB, SESSION, agentId, agentType);
}

/** How many times the store notified its subscribers while `run` ran. */
function wakes(run: () => void): number {
  let count = 0;
  const unsub = useSubagents.subscribe(() => { count++; });
  run();
  unsub();
  return count;
}

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
    mtimeMs: 0,
    outcome: "none",
    ...patch,
  };
}

function hookEvent(phase: "start" | "stop", agentId: string, agentType = "Explore"): SubagentHookEvent {
  return { phase, sessionId: SESSION, agentId, agentType };
}

beforeEach(() => {
  useSubagents.setState({ byTab: {} });
  vi.mocked(ipc.subagentList).mockReset().mockResolvedValue([]);
  vi.mocked(ipc.subagentWorkflowRuns).mockReset().mockResolvedValue([]);
});

describe("subagent lifecycle", () => {
  it("a start adds a running record and a stop moves it to the end state given", () => {
    startA();
    const [record] = selectTabSubagents(TAB)(useSubagents.getState());
    expect(record).toMatchObject({ agentId: AGENT_A, state: "running", endedAt: null, source: "hook" });

    useSubagents.getState().stop(TAB, AGENT_A, "unknown");
    const [stopped] = selectTabSubagents(TAB)(useSubagents.getState());
    expect(stopped.state).toBe("unknown");
    expect(stopped.endedAt).not.toBeNull();
  });

  it("keeps records in start order", () => {
    startA(AGENT_B);
    startA(AGENT_A);
    expect(selectTabSubagents(TAB)(useSubagents.getState()).map(r => r.agentId)).toEqual([AGENT_B, AGENT_A]);
  });

  it("a pty exit marks only the still-running records interrupted", () => {
    startA(AGENT_A);
    startA(AGENT_B);
    useSubagents.getState().stop(TAB, AGENT_A, "done");
    useSubagents.getState().markInterrupted(TAB);

    const states = selectTabSubagents(TAB)(useSubagents.getState()).map(r => r.state);
    expect(states).toEqual(["done", "interrupted"]);
  });

  it("a session change on the tab drops the old session's records", () => {
    useApp.setState({ tabs: { [TASK]: [{ id: TAB, type: "terminal", title: "c", cli: "claude", sessionId: SESSION } as Tab] } });
    startA();

    useApp.getState().setTabSessionId(TASK, TAB, OTHER_SESSION);
    expect(useSubagents.getState().byTab[TAB]).toBeUndefined();
  });

  it("a cleared session id drops the records too", () => {
    useApp.setState({ tabs: { [TASK]: [{ id: TAB, type: "terminal", title: "c", cli: "claude", sessionId: SESSION } as Tab] } });
    startA();

    useApp.getState().setTabSessionId(TASK, TAB, "");
    expect(useSubagents.getState().byTab[TAB]).toBeUndefined();
  });

  it("closing the tab forgets its records", () => {
    useApp.setState({
      tabs: { [TASK]: [
        { id: TAB, type: "terminal", title: "c", cli: "claude", sessionId: SESSION } as Tab,
        { id: "tab-2", type: "terminal", title: "d", cli: "claude" } as Tab,
      ] },
      activeTab: { [TASK]: "tab-2" },
    });
    startA();
    useSubagents.getState().start(TASK, "tab-2", SESSION, AGENT_B, "Explore");

    useApp.getState().closeTab(TASK, TAB);
    expect(useSubagents.getState().byTab[TAB]).toBeUndefined();
    expect(useSubagents.getState().byTab["tab-2"]).toBeDefined();
  });

  it("never downgrades a finished record", () => {
    startA();
    useSubagents.getState().stop(TAB, AGENT_A, "failed");
    useSubagents.getState().stop(TAB, AGENT_A, "unknown");
    expect(useSubagents.getState().byTab[TAB].agents[AGENT_A].state).toBe("failed");
  });
});

describe("unchanged writes wake nobody (bear trap 8)", () => {
  it("a duplicate start for a known agent", () => {
    startA();
    const before = useSubagents.getState();
    expect(wakes(() => startA())).toBe(0);
    expect(useSubagents.getState()).toBe(before);
  });

  it("a stop for an unknown agent", () => {
    startA();
    const before = useSubagents.getState();
    expect(wakes(() => useSubagents.getState().stop(TAB, AGENT_B, "unknown"))).toBe(0);
    expect(wakes(() => useSubagents.getState().stop("no-such-tab", AGENT_A, "unknown"))).toBe(0);
    expect(useSubagents.getState()).toBe(before);
  });

  it("a stop repeating the current end state", () => {
    startA();
    useSubagents.getState().stop(TAB, AGENT_A, "unknown");
    const before = useSubagents.getState();
    expect(wakes(() => useSubagents.getState().stop(TAB, AGENT_A, "unknown"))).toBe(0);
    expect(useSubagents.getState()).toBe(before);
  });

  it("markInterrupted on a tab with no running record", () => {
    startA();
    useSubagents.getState().stop(TAB, AGENT_A, "done");
    const before = useSubagents.getState();
    expect(wakes(() => useSubagents.getState().markInterrupted(TAB))).toBe(0);
    expect(wakes(() => useSubagents.getState().markInterrupted("no-such-tab"))).toBe(0);
    expect(useSubagents.getState()).toBe(before);
  });

  it("a session reset to the same session id", () => {
    startA();
    const before = useSubagents.getState();
    expect(wakes(() => useSubagents.getState().setSession(TAB, SESSION))).toBe(0);
    expect(useSubagents.getState()).toBe(before);
  });

  it("forgetting a tab with no records", () => {
    const before = useSubagents.getState();
    expect(wakes(() => useSubagents.getState().forget(TAB))).toBe(0);
    expect(useSubagents.getState()).toBe(before);
  });

  it("each real change wakes subscribers exactly once", () => {
    expect(wakes(() => startA())).toBe(1);
    expect(wakes(() => useSubagents.getState().stop(TAB, AGENT_A, "unknown"))).toBe(1);
  });
});

describe("selectors", () => {
  it("an absent tab reads the frozen EMPTY_SUBAGENTS, stable across writes", () => {
    const select = selectTabSubagents("absent");
    const first = select(useSubagents.getState());
    expect(first).toBe(EMPTY_SUBAGENTS);
    expect(Object.isFrozen(first)).toBe(true);

    startA();
    expect(select(useSubagents.getState())).toBe(first);
    expect(selectTabSubagentRows("absent")(useSubagents.getState())).toBe(EMPTY_SUBAGENTS);
  });

  it("a tab's list keeps its identity across writes to another tab", () => {
    startA();
    const select = selectTabSubagents(TAB);
    const first = select(useSubagents.getState());

    useSubagents.getState().start(TASK, "tab-2", SESSION, AGENT_B, "Explore");
    expect(select(useSubagents.getState())).toBe(first);
  });

  it("a workflow agent no listing has placed yet is recorded but kept off the rows", () => {
    startA(AGENT_A, WORKFLOW_AGENT_TYPE);
    startA(AGENT_B, "Explore");

    const all = selectTabSubagents(TAB)(useSubagents.getState());
    expect(all.find(r => r.agentId === AGENT_A)?.isWorkflow).toBe(true);

    const rows = selectTabSubagentRows(TAB)(useSubagents.getState());
    expect(rows.map(r => r.agentId)).toEqual([AGENT_B]);
  });

  it("a workflow agent placed in a run is one of the rows", () => {
    const placed = summary(AGENT_A, { agentType: WORKFLOW_AGENT_TYPE, isWorkflow: true, workflowRunId: "wf_run1" });
    useSubagents.getState().mergeScanned(TASK, TAB, SESSION, [placed, summary(AGENT_B, { mtimeMs: 1 })], true);

    const rows = selectTabSubagentRows(TAB)(useSubagents.getState());
    expect(rows.map(r => r.agentId)).toEqual([AGENT_A, AGENT_B]);
  });

  it("the workflow type filter takes run agents off the rows", () => {
    const placed = summary(AGENT_A, { agentType: WORKFLOW_AGENT_TYPE, isWorkflow: true, workflowRunId: "wf_run1" });
    useSubagents.getState().mergeScanned(TASK, TAB, SESSION, [placed, summary(AGENT_B, { mtimeMs: 1 })], true);
    const noWorkflow = { builtIn: true, custom: true, fork: true, workflow: false };

    const rows = selectTabSubagentRows(TAB, noWorkflow)(useSubagents.getState());
    expect(rows.map(r => r.agentId)).toEqual([AGENT_B]);
  });

  it("an unplaced workflow agent changing leaves the rows list identical", () => {
    startA(AGENT_A, WORKFLOW_AGENT_TYPE);
    startA(AGENT_B, "Explore");
    const select = selectTabSubagentRows(TAB);
    const first = select(useSubagents.getState());

    useSubagents.getState().stop(TAB, AGENT_A, "unknown");
    expect(select(useSubagents.getState())).toBe(first);
  });

  it("a tab of only unplaced workflow agents has no rows", () => {
    startA(AGENT_A, WORKFLOW_AGENT_TYPE);
    expect(selectTabSubagentRows(TAB)(useSubagents.getState())).toBe(EMPTY_SUBAGENTS);
  });
});

describe("hook events", () => {
  const origin = { taskId: TASK, tabId: TAB, tabSessionId: SESSION };

  it("an event from another session is dropped", () => {
    receiveSubagentEvent(origin, { ...hookEvent("start", AGENT_A), sessionId: OTHER_SESSION });
    expect(useSubagents.getState().byTab[TAB]).toBeUndefined();

    receiveSubagentEvent({ ...origin, tabSessionId: null }, hookEvent("start", AGENT_A));
    expect(useSubagents.getState().byTab[TAB]).toBeUndefined();
  });

  it("a start for a session the records do not belong to is dropped", () => {
    startA();
    useSubagents.getState().start(TASK, TAB, OTHER_SESSION, AGENT_B, "Explore");
    expect(Object.keys(useSubagents.getState().byTab[TAB].agents)).toEqual([AGENT_A]);
  });

  it("the tab moving to a new session replaces the old records", () => {
    startA();
    receiveSubagentEvent(
      { ...origin, tabSessionId: OTHER_SESSION },
      { ...hookEvent("start", AGENT_B), sessionId: OTHER_SESSION },
    );
    const entry = useSubagents.getState().byTab[TAB];
    expect(entry.sessionId).toBe(OTHER_SESSION);
    expect(Object.keys(entry.agents)).toEqual([AGENT_B]);
  });

  it("strips a leading agent- and refuses ids outside the charset", () => {
    startA(`agent-${AGENT_A}`);
    expect(Object.keys(useSubagents.getState().byTab[TAB].agents)).toEqual([AGENT_A]);

    for (const bad of ["a/../../etc", "a b", "", "agent-", "a".repeat(65), "a.jsonl"]) {
      useSubagents.getState().start(TASK, TAB, SESSION, bad, "Explore");
    }
    expect(Object.keys(useSubagents.getState().byTab[TAB].agents)).toEqual([AGENT_A]);

    useSubagents.getState().stop(TAB, `agent-${AGENT_A}`, "unknown");
    expect(useSubagents.getState().byTab[TAB].agents[AGENT_A].state).toBe("unknown");
  });

  it("the store is the registered sink, and a stop lands as unknown", () => {
    deliverSubagentEvent(origin, hookEvent("start", AGENT_A));
    deliverSubagentEvent(origin, hookEvent("stop", AGENT_A));
    expect(useSubagents.getState().byTab[TAB].agents[AGENT_A].state).toBe("unknown");
  });

  it("the transcript read fills meta and upgrades unknown to the outcome", async () => {
    vi.mocked(ipc.subagentList).mockResolvedValue([
      summary(AGENT_A, { outcome: "failed", description: "Find the parser", spawnDepth: 1, parentAgentId: null }),
    ]);
    receiveSubagentEvent(origin, hookEvent("start", AGENT_A));
    receiveSubagentEvent(origin, hookEvent("stop", AGENT_A));
    await vi.waitFor(() =>
      expect(useSubagents.getState().byTab[TAB].agents[AGENT_A].state).toBe("failed"));

    expect(ipc.subagentList).toHaveBeenCalledWith(TASK, SESSION);
    expect(useSubagents.getState().byTab[TAB].agents[AGENT_A]).toMatchObject({
      description: "Find the parser", spawnDepth: 1, parentAgentId: null,
    });
  });

  it("a transcript read never upgrades a running record or downgrades a finished one", () => {
    startA(AGENT_A);
    startA(AGENT_B);
    useSubagents.getState().stop(TAB, AGENT_B, "done");
    const before = useSubagents.getState();

    useSubagents.getState().applySummaries(TAB, SESSION, [
      summary(AGENT_A, { outcome: "done" }),
      summary(AGENT_B, { outcome: "failed" }),
    ]);
    expect(useSubagents.getState()).toBe(before);
  });

  it("a transcript read for a session the tab has left is dropped", () => {
    startA();
    useSubagents.getState().stop(TAB, AGENT_A, "unknown");
    const before = useSubagents.getState();

    useSubagents.getState().applySummaries(TAB, OTHER_SESSION, [summary(AGENT_A, { outcome: "done" })]);
    expect(useSubagents.getState()).toBe(before);
  });

  it("a transcript read that changes nothing wakes nobody", () => {
    startA();
    expect(wakes(() =>
      useSubagents.getState().applySummaries(TAB, SESSION, [summary(AGENT_A), summary(AGENT_B)]))).toBe(0);
  });
});

describe("workflow runs and phases", () => {
  const origin = { taskId: TASK, tabId: TAB, tabSessionId: SESSION };
  const RUN = "wf_run1";

  function workflowSummary(agentId: string, patch: Partial<SubagentSummary> = {}): SubagentSummary {
    return summary(agentId, {
      agentType: WORKFLOW_AGENT_TYPE, isWorkflow: true, workflowRunId: RUN, workflowPhase: "Build", ...patch,
    });
  }

  function runInfo(patch: Partial<WorkflowRunInfo> = {}): WorkflowRunInfo {
    return { runId: RUN, name: "acme-release", phases: ["Plan", "Build"], ...patch };
  }

  it("a hook-created workflow agent learns its run and phase on the next listing", async () => {
    vi.mocked(ipc.subagentList).mockResolvedValue([workflowSummary(AGENT_A)]);
    receiveSubagentEvent(origin, hookEvent("start", AGENT_A, WORKFLOW_AGENT_TYPE));
    expect(useSubagents.getState().byTab[TAB].agents[AGENT_A]).toMatchObject({
      workflowRunId: null, workflowPhase: null,
    });

    await vi.waitFor(() =>
      expect(useSubagents.getState().byTab[TAB].agents[AGENT_A]).toMatchObject({
        workflowRunId: RUN, workflowPhase: "Build",
      }));
  });

  it("a workflow agent with no phase is kept with a null phase", () => {
    useSubagents.getState().mergeScanned(TASK, TAB, SESSION, [workflowSummary(AGENT_A, { workflowPhase: null })], true);
    expect(useSubagents.getState().byTab[TAB].agents[AGENT_A]).toMatchObject({
      isWorkflow: true, workflowRunId: RUN, workflowPhase: null,
    });
  });

  it("a rescan moves a workflow agent to the phase its sidecar now names", () => {
    useSubagents.getState().mergeScanned(TASK, TAB, SESSION, [workflowSummary(AGENT_A, { workflowPhase: null })], true);
    useSubagents.getState().mergeScanned(TASK, TAB, SESSION, [workflowSummary(AGENT_A)], true);
    expect(useSubagents.getState().byTab[TAB].agents[AGENT_A].workflowPhase).toBe("Build");
  });

  it("the run info is read with the listing once the tab has a workflow agent", async () => {
    vi.mocked(ipc.subagentList).mockResolvedValue([workflowSummary(AGENT_A)]);
    vi.mocked(ipc.subagentWorkflowRuns).mockResolvedValue([runInfo()]);
    receiveSubagentEvent(origin, hookEvent("start", AGENT_A, WORKFLOW_AGENT_TYPE));

    await vi.waitFor(() =>
      expect(useSubagents.getState().byTab[TAB].runs[RUN]).toEqual({ name: "acme-release", phases: ["Plan", "Build"] }));
    expect(ipc.subagentWorkflowRuns).toHaveBeenCalledWith(TASK, SESSION);
  });

  it("a tab with no workflow agent never reads run info", async () => {
    vi.mocked(ipc.subagentList).mockResolvedValue([summary(AGENT_A, { description: "Find the parser" })]);
    receiveSubagentEvent(origin, hookEvent("start", AGENT_A));

    await vi.waitFor(() =>
      expect(useSubagents.getState().byTab[TAB].agents[AGENT_A].description).toBe("Find the parser"));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(ipc.subagentWorkflowRuns).not.toHaveBeenCalled();
  });

  it("run info that changes nothing wakes nobody", () => {
    startA(AGENT_A, WORKFLOW_AGENT_TYPE);
    useSubagents.getState().applyWorkflowRuns(TAB, SESSION, [runInfo()]);
    const runs = useSubagents.getState().byTab[TAB].runs;

    expect(wakes(() => useSubagents.getState().applyWorkflowRuns(TAB, SESSION, [runInfo()]))).toBe(0);
    expect(useSubagents.getState().byTab[TAB].runs).toBe(runs);
  });

  it("run info that does change wakes once and keeps the unchanged runs by reference", () => {
    startA(AGENT_A, WORKFLOW_AGENT_TYPE);
    const other = runInfo({ runId: "wf_run2", name: null, phases: null });
    useSubagents.getState().applyWorkflowRuns(TAB, SESSION, [runInfo(), other]);
    const firstRun = useSubagents.getState().byTab[TAB].runs[RUN];

    const renamed = { ...other, name: "acme-docs", phases: ["Write"] };
    expect(wakes(() => useSubagents.getState().applyWorkflowRuns(TAB, SESSION, [runInfo(), renamed]))).toBe(1);
    expect(useSubagents.getState().byTab[TAB].runs[RUN]).toBe(firstRun);
    expect(useSubagents.getState().byTab[TAB].runs.wf_run2).toEqual({ name: "acme-docs", phases: ["Write"] });
  });

  it("run info for a session the tab has left is dropped", () => {
    startA(AGENT_A, WORKFLOW_AGENT_TYPE);
    const before = useSubagents.getState();
    useSubagents.getState().applyWorkflowRuns(TAB, OTHER_SESSION, [runInfo()]);
    expect(useSubagents.getState()).toBe(before);
  });
});

describe("subagents never reach attention", () => {
  it("the store does not touch attention, the bell or work state", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(resolve(here, "subagents.ts"), "utf8");
    for (const forbidden of ["markAttention", "clearAttention", "setWorkState"]) {
      expect(source).not.toContain(forbidden);
    }
  });
});
