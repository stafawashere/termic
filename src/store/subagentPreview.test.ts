import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/ipc", () => ({
  ptyKill: vi.fn().mockResolvedValue(undefined),
  taskSetTabs: vi.fn().mockResolvedValue(undefined),
  taskSetTabSessionId: vi.fn().mockResolvedValue(undefined),
  subagentList: vi.fn().mockResolvedValue([]),
  subagentTranscriptRead: vi.fn(),
  subagentWatchOpen: vi.fn(),
  subagentWatchClose: vi.fn().mockResolvedValue(undefined),
  subagentWatchPoke: vi.fn().mockResolvedValue(undefined),
  onSubagentWatch: vi.fn(),
}));
vi.mock("@/lib/tabFocus", () => ({
  focusTerminalTab: vi.fn(),
  focusMainTab: vi.fn(),
  focusPaneTab: vi.fn(),
}));

import * as ipc from "@/lib/ipc";
import { useApp } from "@/store/app";
import { useSubagents } from "@/store/subagents";
import {
  installSubagentPreviewArchiveWatch, openSubagentPreview, openTranscriptSession,
  type TranscriptSnapshot,
} from "@/store/subagentPreview";
import type { SubagentTab, SubagentTailEvent, Tab, Task, TranscriptEntry, TranscriptPage } from "@/lib/types";

const SESSION = "11111111-2222-4333-8444-555555555555";
const TASK = "task-1";
const PARENT = "tab-claude";
const AGENT_A = "a0123456789abcdef";
const AGENT_B = "a1123456789abcdef";

let tailListener: ((event: SubagentTailEvent) => void) | null = null;

function entry(text: string): TranscriptEntry {
  return { kind: "assistantText", text, truncated: false, name: null, isError: false, timestamp: null };
}

function page(start: number, texts: string[], total = start + texts.length, outcome: TranscriptPage["outcome"] = "none"): TranscriptPage {
  return {
    agentId: AGENT_A,
    entries: texts.map(entry),
    total,
    start,
    skippedLines: 0,
    outcome,
    meta: {
      agentType: null, description: null, model: null, toolUseId: null, spawnDepth: null,
      parentAgentId: null, requestShape: null, requestNonInteractive: null, workflowPhase: null,
    },
  };
}

function batch(start: number, texts: string[]): SubagentTailEvent {
  return { kind: "entries", sessionId: SESSION, agentId: AGENT_A, start, entries: texts.map(entry) };
}

function task(archived = false): Task {
  return { id: TASK, archived, persisted_tabs: [] } as unknown as Task;
}

function seed(): void {
  const parent = { id: PARENT, type: "terminal", cli: "claude", title: "claude", sessionId: SESSION, is_default: true } as Tab;
  useApp.setState({
    tasks: [task()],
    tabs: { [TASK]: [parent] },
    activeTab: { [TASK]: PARENT },
    splitTree: {},
    activePaneId: {},
  });
  useSubagents.setState({ byTab: {} });
  useSubagents.getState().start(TASK, PARENT, SESSION, AGENT_A, "Explore");
  useSubagents.getState().start(TASK, PARENT, SESSION, AGENT_B, "Plan");
}

function subagentTabs(): SubagentTab[] {
  return (useApp.getState().tabs[TASK] ?? []).filter((t): t is SubagentTab => t.type === "subagent");
}

async function settle(): Promise<void> {
  for (let round = 0; round < 5; round++) await Promise.resolve();
}

function startSession(viewTabId = "view-1") {
  const snapshots: TranscriptSnapshot[] = [];
  const session = openTranscriptSession(
    { taskId: TASK, viewTabId, sessionId: SESSION, agentId: AGENT_A },
    snapshot => snapshots.push(snapshot),
  );
  const last = () => snapshots[snapshots.length - 1];
  const texts = () => last().window.rows.map(row => `${row.index}:${row.text}`);
  return { session, snapshots, last, texts };
}

beforeEach(() => {
  vi.clearAllMocks();
  tailListener = null;
  vi.mocked(ipc.onSubagentWatch).mockImplementation(async (_session, _agent, cb) => {
    tailListener = cb;
    return () => { tailListener = null; };
  });
  vi.mocked(ipc.subagentWatchOpen).mockResolvedValue({ live: true, total: 3 });
  vi.mocked(ipc.subagentTranscriptRead).mockResolvedValue(page(0, ["a", "b", "c"]));
  seed();
});

describe("openSubagentPreview", () => {
  it("opens a subagent in the preview slot and recycles that slot for the next one", () => {
    openSubagentPreview(TASK, PARENT, AGENT_A);
    const [first] = subagentTabs();
    expect(first).toMatchObject({ preview: true, parentTabId: PARENT, sessionId: SESSION, subagentAgentId: AGENT_A, title: "Explore" });
    expect(useApp.getState().activeTab[TASK]).toBe(first.id);

    openSubagentPreview(TASK, PARENT, AGENT_B);
    const after = subagentTabs();
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(first.id);
    expect(after[0]).toMatchObject({ subagentAgentId: AGENT_B, title: "Plan", preview: true });
  });

  it("keeps a pinned transcript and opens the next one in a new preview tab", () => {
    openSubagentPreview(TASK, PARENT, AGENT_A);
    const [first] = subagentTabs();
    useApp.getState().persistTab(TASK, first.id);

    openSubagentPreview(TASK, PARENT, AGENT_B);
    const after = subagentTabs();
    expect(after.map(t => [t.subagentAgentId, !!t.preview])).toEqual([[AGENT_A, false], [AGENT_B, true]]);
  });

  it("clears the transcript identity when a file recycles the slot", () => {
    openSubagentPreview(TASK, PARENT, AGENT_A);
    const [first] = subagentTabs();
    useApp.getState().openPreviewTab(TASK, { type: "edit", path: "README.md", title: "README.md" });

    const recycled = useApp.getState().tabs[TASK].find(t => t.id === first.id) as unknown as Record<string, unknown>;
    expect(recycled).toMatchObject({ type: "edit", path: "README.md" });
    expect(recycled.subagentAgentId).toBeUndefined();
    expect(recycled.parentTabId).toBeUndefined();
  });

  it("never writes a subagent tab into the task's persisted tabs", () => {
    openSubagentPreview(TASK, PARENT, AGENT_A);
    const [view] = subagentTabs();
    useApp.getState().persistTab(TASK, view.id);
    useApp.getState().syncDurableTabs(TASK);

    const persisted = useApp.getState().tasks.find(t => t.id === TASK)!.persisted_tabs ?? [];
    expect(persisted.map(t => t.id)).not.toContain(view.id);
    expect(persisted.map(t => t.id)).toContain(PARENT);
  });

  it("does nothing for an agent the store does not hold", () => {
    openSubagentPreview(TASK, PARENT, "a9999999999999999");
    expect(subagentTabs()).toHaveLength(0);
  });
});

describe("openTranscriptSession", () => {
  it("reads only after the tail is open, then merges live batches by index without duplicates", async () => {
    const { session, last, texts } = startSession();
    await settle();

    expect(ipc.subagentWatchOpen).toHaveBeenCalledTimes(1);
    const openOrder = vi.mocked(ipc.subagentWatchOpen).mock.invocationCallOrder[0];
    const readOrder = vi.mocked(ipc.subagentTranscriptRead).mock.invocationCallOrder[0];
    expect(readOrder).toBeGreaterThan(openOrder);
    expect(last().status).toBe("live");
    expect(texts()).toEqual(["0:a", "1:b", "2:c"]);

    tailListener!(batch(2, ["c", "d"]));
    tailListener!(batch(4, ["e"]));
    expect(texts()).toEqual(["0:a", "1:b", "2:c", "3:d", "4:e"]);
    session.dispose();
  });

  it("holds batches that land before the first page and applies them on top of it", async () => {
    let resolveRead!: (value: TranscriptPage) => void;
    vi.mocked(ipc.subagentTranscriptRead).mockReturnValueOnce(new Promise(resolve => { resolveRead = resolve; }));
    const { session, texts } = startSession();
    await settle();

    tailListener!(batch(3, ["d"]));
    resolveRead(page(0, ["a", "b", "c"]));
    await settle();

    expect(texts()).toEqual(["0:a", "1:b", "2:c", "3:d"]);
    session.dispose();
  });

  it("asks only for the last page first, and loads the page above on demand", async () => {
    vi.mocked(ipc.subagentTranscriptRead).mockResolvedValueOnce(page(500, ["late"], 501));
    const { session, last, texts } = startSession();
    await settle();

    expect(vi.mocked(ipc.subagentTranscriptRead).mock.calls[0][4]).toBeUndefined();
    expect(last().window.start).toBe(500);

    vi.mocked(ipc.subagentTranscriptRead).mockResolvedValueOnce(page(499, ["early"], 501));
    session.loadEarlier();
    expect(last().loadingEarlier).toBe(true);
    await settle();

    expect(vi.mocked(ipc.subagentTranscriptRead).mock.calls[1][4]).toBe(500);
    expect(texts()).toEqual(["499:early", "500:late"]);
    expect(last().loadingEarlier).toBe(false);
    session.dispose();
  });

  it("shows a transcript whose file is gone as expired and lets go of the watch", async () => {
    vi.mocked(ipc.subagentWatchOpen).mockRejectedValueOnce("subagent transcript not found");
    vi.mocked(ipc.subagentTranscriptRead).mockResolvedValueOnce(page(0, [], 0, "expired"));
    const { last } = startSession();
    await settle();

    expect(last().status).toBe("expired");
    expect(ipc.subagentWatchClose).not.toHaveBeenCalled();
  });

  it("stops tailing when the file goes away while the view is open", async () => {
    const { last, texts } = startSession();
    await settle();

    tailListener!({ kind: "expired", sessionId: SESSION, agentId: AGENT_A, start: 0, entries: [] });
    await settle();

    expect(last().status).toBe("expired");
    expect(texts()).toEqual(["0:a", "1:b", "2:c"]);
    expect(ipc.subagentWatchClose).toHaveBeenCalledTimes(1);
    expect(tailListener).toBeNull();
  });
});

describe("archiving the task", () => {
  let uninstall: (() => void) | null = null;

  afterEach(() => {
    uninstall?.();
    uninstall = null;
  });

  it("releases the view's watch and closes the subagent tab", async () => {
    uninstall = installSubagentPreviewArchiveWatch();
    openSubagentPreview(TASK, PARENT, AGENT_A);
    const [view] = subagentTabs();
    const { last } = startSession(view.id);
    await settle();
    expect(last().status).toBe("live");

    useApp.setState({ tasks: [task(true)] });
    await settle();

    expect(ipc.subagentWatchClose).toHaveBeenCalledTimes(1);
    expect(vi.mocked(ipc.subagentWatchClose).mock.calls[0]).toEqual([TASK, view.id, SESSION, AGENT_A]);
    expect(last().status).toBe("closed");
    expect(subagentTabs()).toHaveLength(0);
    expect(tailListener).toBeNull();
  });

  it("reads nothing for a task that is already archived", async () => {
    useApp.setState({ tasks: [task(true)] });
    const { last } = startSession();
    await settle();

    expect(last().status).toBe("closed");
    expect(ipc.subagentTranscriptRead).not.toHaveBeenCalled();
    expect(ipc.subagentWatchOpen).not.toHaveBeenCalled();
    expect(ipc.onSubagentWatch).not.toHaveBeenCalled();
  });
});
