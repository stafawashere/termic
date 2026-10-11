// @vitest-environment happy-dom
// The Claude subagents master toggle (Settings > Tasks), end to end through
// the real stores: switched off, the feature must do no work at all, and
// switched back on it must rebuild what it dropped. The IPC wrappers and the
// transcript watch are mocked so every call they would make is counted.

import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";

const { watchDisposers } = vi.hoisted(() => ({ watchDisposers: [] as ReturnType<typeof vi.fn>[] }));

vi.mock("@/lib/ipc", () => ({
  ptyKill: vi.fn().mockResolvedValue(undefined),
  taskSetTabs: vi.fn().mockResolvedValue(undefined),
  taskSetTabSessionId: vi.fn().mockResolvedValue(undefined),
  subagentList: vi.fn().mockResolvedValue([]),
  subagentTranscriptRead: vi.fn().mockReturnValue(new Promise(() => {})),
  subagentWatchPoke: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/subagentWatch", () => ({
  subagentWatchOpen: vi.fn(() => {
    const dispose = vi.fn();
    watchDisposers.push(dispose);
    return dispose;
  }),
}));
vi.mock("@/lib/tabFocus", () => ({
  focusTerminalTab: vi.fn(),
  focusMainTab: vi.fn(),
  focusPaneTab: vi.fn(),
}));

import * as ipc from "@/lib/ipc";
import { subagentWatchOpen } from "@/lib/subagentWatch";
import { rebuildSubagentsForTab, runLaunchRebuild } from "@/lib/subagentRebuild";
import { subagentsEnabled } from "@/lib/subagentGate";
import { installSubagentsEnabledWatch } from "@/lib/subagentSettingsWatch";
import { useApp } from "@/store/app";
import { usePrefs } from "@/store/prefs";
import { receiveSubagentEvent, selectTabSubagents, useSubagents, type SubagentRecord, type TabSubagents } from "@/store/subagents";
import { createSubagentStructureSelector, subagentGroupStartsCollapsed } from "@/components/sidebar/subagentTree";
import { SUBAGENT_TYPE_FILTER_VERSION, parseSubagentTypeFilter, retentionWindowMs } from "@/lib/subagentPrefs";
import { openTranscriptSession, type TranscriptSnapshot } from "@/store/subagentPreview";
import type { Tab, Task } from "@/lib/types";

const SESSION = "11111111-2222-4333-8444-555555555555";
const OTHER_SESSION = "22222222-3333-4444-8555-666666666666";
const TASK = "task-1";
const OTHER_TASK = "task-2";
const TAB = "tab-claude";
const OTHER_TAB = "tab-claude-2";
const AGENT_A = "a0123456789abcdef";
const AGENT_B = "a1123456789abcdef";

function claudeTab(id: string, sessionId: string): Tab {
  return { id, type: "terminal", cli: "claude", title: "claude", sessionId } as Tab;
}

function task(id: string): Task {
  return { id, archived: false, persisted_tabs: [] } as unknown as Task;
}

function seed(): void {
  useApp.setState({
    tasks: [task(TASK), task(OTHER_TASK)],
    tabs: {
      [TASK]: [claudeTab(TAB, SESSION), { id: "tab-codex", type: "terminal", cli: "codex", title: "codex" } as Tab],
      [OTHER_TASK]: [claudeTab(OTHER_TAB, OTHER_SESSION)],
    },
  });
  useSubagents.setState({ byTab: {} });
}

function hookStart(agentId: string): void {
  receiveSubagentEvent(
    { taskId: TASK, tabId: TAB, tabSessionId: SESSION },
    { phase: "start", sessionId: SESSION, agentId, agentType: "Explore" },
  );
}

function openView(taskId: string, viewTabId: string, sessionId: string, agentId: string) {
  const snapshots: TranscriptSnapshot[] = [];
  const session = openTranscriptSession({ taskId, viewTabId, sessionId, agentId }, s => snapshots.push(s));
  return { session, snapshots };
}

async function settle(): Promise<void> {
  for (let round = 0; round < 10; round++) await Promise.resolve();
}

let uninstall: () => void;

beforeAll(() => { uninstall = installSubagentsEnabledWatch(); });
afterAll(() => uninstall());

beforeEach(() => {
  usePrefs.getState().setSubagentsEnabled(true);
  seed();
  watchDisposers.length = 0;
  vi.mocked(ipc.subagentList).mockClear();
  vi.mocked(ipc.subagentTranscriptRead).mockClear();
  vi.mocked(ipc.subagentWatchPoke).mockClear();
  vi.mocked(subagentWatchOpen).mockClear();
});

describe("claude subagents switched off", () => {
  it("closes the gate the moment the pref changes", () => {
    expect(subagentsEnabled()).toBe(true);
    usePrefs.getState().setSubagentsEnabled(false);
    expect(subagentsEnabled()).toBe(false);
  });

  it("drops a hook report before it reaches the store, and reads nothing for it", async () => {
    usePrefs.getState().setSubagentsEnabled(false);
    hookStart(AGENT_A);
    await settle();

    expect(useSubagents.getState().byTab).toEqual({});
    expect(selectTabSubagents(TAB)(useSubagents.getState())).toHaveLength(0);
    expect(ipc.subagentList).toHaveBeenCalledTimes(0);
  });

  it("never invokes the directory scan, for one tab or for a launch", async () => {
    usePrefs.getState().setSubagentsEnabled(false);
    vi.mocked(ipc.subagentList).mockClear();

    const applied = await rebuildSubagentsForTab(TASK, TAB, SESSION);
    await runLaunchRebuild();

    expect(applied).toBe(false);
    expect(ipc.subagentList).toHaveBeenCalledTimes(0);
  });

  it("opens no watch and reads no transcript for a view opened while off", async () => {
    usePrefs.getState().setSubagentsEnabled(false);
    const { snapshots } = openView(TASK, "view-1", SESSION, AGENT_A);
    await settle();

    expect(subagentWatchOpen).toHaveBeenCalledTimes(0);
    expect(ipc.subagentTranscriptRead).toHaveBeenCalledTimes(0);
    expect(snapshots.at(-1)?.status).toBe("closed");
  });

  it("drops every record the store held", () => {
    hookStart(AGENT_A);
    hookStart(AGENT_B);
    expect(selectTabSubagents(TAB)(useSubagents.getState())).toHaveLength(2);

    usePrefs.getState().setSubagentsEnabled(false);

    expect(useSubagents.getState().byTab).toEqual({});
  });

  it("releases each open view's watch exactly once, and keeps what it showed", async () => {
    const first = openView(TASK, "view-1", SESSION, AGENT_A);
    const second = openView(OTHER_TASK, "view-2", OTHER_SESSION, AGENT_B);
    expect(watchDisposers).toHaveLength(2);

    usePrefs.getState().setSubagentsEnabled(false);
    // The pane's own cleanup runs after the release and must not release again.
    first.session.dispose();
    second.session.dispose();
    await settle();

    for (const dispose of watchDisposers) expect(dispose).toHaveBeenCalledTimes(1);
    expect(first.snapshots.at(-1)?.status).toBe("closed");
    expect(second.snapshots.at(-1)?.status).toBe("closed");
  });

  it("does not release a watch while the pref only changes to the value it had", () => {
    openView(TASK, "view-1", SESSION, AGENT_A);
    usePrefs.getState().setSubagentsEnabled(true);

    expect(watchDisposers[0]).toHaveBeenCalledTimes(0);
  });
});

describe("claude subagents switched back on", () => {
  it("scans every claude tab that names a session, and no other tab", async () => {
    usePrefs.getState().setSubagentsEnabled(false);
    vi.mocked(ipc.subagentList).mockClear();

    usePrefs.getState().setSubagentsEnabled(true);
    await settle();

    const scanned = vi.mocked(ipc.subagentList).mock.calls.map(call => [call[0], call[1]]);
    expect(scanned.sort()).toEqual([[TASK, SESSION], [OTHER_TASK, OTHER_SESSION]]);
  });

  it("brings the rows back from what the scan found", async () => {
    hookStart(AGENT_A);
    usePrefs.getState().setSubagentsEnabled(false);
    vi.mocked(ipc.subagentList).mockImplementation(async (taskId) => taskId !== TASK ? [] : [{
      agentId: AGENT_A, agentType: "Explore", description: null, model: null, toolUseId: null,
      spawnDepth: 1, parentAgentId: null, requestShape: null, requestNonInteractive: null,
      workflowPhase: null, isWorkflow: false, workflowRunId: null, mtimeMs: 1_000, outcome: "done",
    }]);

    usePrefs.getState().setSubagentsEnabled(true);
    await settle();

    const records = selectTabSubagents(TAB)(useSubagents.getState());
    expect(records.map(record => [record.agentId, record.state])).toEqual([[AGENT_A, "done"]]);
    vi.mocked(ipc.subagentList).mockReset().mockResolvedValue([]);
  });

  it("accepts hook reports again", () => {
    usePrefs.getState().setSubagentsEnabled(false);
    usePrefs.getState().setSubagentsEnabled(true);
    hookStart(AGENT_A);

    expect(selectTabSubagents(TAB)(useSubagents.getState())).toHaveLength(1);
  });

  it("opens a watch for a view opened after it", () => {
    usePrefs.getState().setSubagentsEnabled(false);
    usePrefs.getState().setSubagentsEnabled(true);
    openView(TASK, "view-1", SESSION, AGENT_A);

    expect(subagentWatchOpen).toHaveBeenCalledTimes(1);
  });
});

describe("the stored type filter", () => {
  const PHASE_ONE_FILTER = '{"builtIn":false,"custom":true,"fork":true,"workflow":false}';

  it("reads a phase 1 filter with workflow forced on, and keeps the kinds the user chose", () => {
    expect(parseSubagentTypeFilter(PHASE_ONE_FILTER)).toEqual({ builtIn: false, custom: true, fork: true, workflow: true });
  });

  it("honours workflow off in a filter that carries the version marker", () => {
    const stored = '{"v":2,"builtIn":true,"custom":true,"fork":true,"workflow":false}';

    expect(parseSubagentTypeFilter(stored).workflow).toBe(false);
  });

  it("writes the marker, so a workflow choice made now survives the next read", () => {
    usePrefs.getState().setSubagentTypeFilter("workflow", false);
    const written = localStorage.getItem("subagentTypeFilter");

    expect(JSON.parse(written!).v).toBe(SUBAGENT_TYPE_FILTER_VERSION);
    expect(parseSubagentTypeFilter(written).workflow).toBe(false);
    usePrefs.getState().setSubagentTypeFilter("workflow", true);
  });
});

describe("the sidebar following a settings change", () => {
  const WORKFLOW_AGENT = "a2123456789abcdef";

  function record(agentId: string, agentType: string, isWorkflow: boolean): SubagentRecord {
    return {
      agentId, agentType, isWorkflow, state: "done", startedAt: 1_000, endedAt: 2_000, source: "hook",
      parentAgentId: null, workflowRunId: isWorkflow ? "wf_run1" : null, workflowPhase: null,
    };
  }

  const entry: TabSubagents = {
    taskId: TASK,
    sessionId: SESSION,
    agents: {
      [AGENT_A]: record(AGENT_A, "Explore", false),
      [WORKFLOW_AGENT]: record(WORKFLOW_AGENT, "workflow-step", true),
    },
    order: [AGENT_A, WORKFLOW_AGENT],
    runs: {},
  };
  const state = { byTab: { [TAB]: entry } };

  // What useVisibleSubagentStructure does on every pref change: fresh rules
  // from the store, a fresh selector, and the key it reads.
  function visibleKey(): string {
    const { subagentTypeFilter, subagentRetention } = usePrefs.getState();
    const rules = { typeFilter: subagentTypeFilter, retentionMs: retentionWindowMs(subagentRetention), now: 3_000 };
    return createSubagentStructureSelector(TAB, rules)(state);
  }

  beforeEach(() => {
    const s = usePrefs.getState();
    s.setSubagentTypeFilter("builtIn", true);
    s.setSubagentTypeFilter("workflow", true);
    s.setSubagentAutoCollapse("never");
  });

  it("hands the sidebar a new filter object when workflow flips, so its rules rebuild", () => {
    const before = usePrefs.getState().subagentTypeFilter;
    usePrefs.getState().setSubagentTypeFilter("workflow", false);
    const after = usePrefs.getState().subagentTypeFilter;

    expect(after).not.toBe(before);
    expect(after.workflow).toBe(false);
    expect(before.workflow).toBe(true);
  });

  it("drops and restores a row when its kind is switched off and on, with no reload", () => {
    const shown = visibleKey();
    expect(shown).toContain(AGENT_A);

    usePrefs.getState().setSubagentTypeFilter("builtIn", false);
    expect(visibleKey()).not.toContain(AGENT_A);

    usePrefs.getState().setSubagentTypeFilter("builtIn", true);
    expect(visibleKey()).toBe(shown);
  });

  it("folds a finished group as soon as auto-collapse changes", () => {
    const startsCollapsed = () => subagentGroupStartsCollapsed(entry, usePrefs.getState().subagentAutoCollapse);
    expect(startsCollapsed()).toBe(false);

    usePrefs.getState().setSubagentAutoCollapse("allFinished");
    expect(startsCollapsed()).toBe(true);

    usePrefs.getState().setSubagentAutoCollapse("never");
    expect(startsCollapsed()).toBe(false);
  });
});
