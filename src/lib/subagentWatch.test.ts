import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SubagentTailEvent, SubagentWatchOpened } from "@/lib/types";

vi.mock("@/lib/ipc", () => ({
  onSubagentWatch: vi.fn(),
  subagentWatchOpen: vi.fn(),
  subagentWatchClose: vi.fn(),
  subagentWatchPoke: vi.fn(),
}));

import { onSubagentWatch, subagentWatchClose, subagentWatchOpen as openWatch } from "@/lib/ipc";
import { subagentWatchOpen } from "@/lib/subagentWatch";

const SESSION = "00000000-0000-0000-0000-000000000000";
const TARGET = { taskId: "t1", tabId: "tab1", sessionId: SESSION, agentId: "a1" };

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

let listening: Deferred<() => void>;
let opening: Deferred<SubagentWatchOpened>;
let unlisten: ReturnType<typeof vi.fn>;
let deliver: ((event: SubagentTailEvent) => void) | null;

beforeEach(() => {
  vi.clearAllMocks();
  listening = deferred();
  opening = deferred();
  unlisten = vi.fn();
  deliver = null;

  vi.mocked(onSubagentWatch).mockImplementation((_session, _agent, cb) => {
    deliver = cb;
    return listening.promise;
  });
  vi.mocked(openWatch).mockImplementation(() => opening.promise);
  vi.mocked(subagentWatchClose).mockResolvedValue(undefined);
});

function batch(text: string): SubagentTailEvent {
  return {
    kind: "entries",
    sessionId: SESSION,
    agentId: "a1",
    start: 0,
    entries: [{ kind: "assistantText", text, truncated: false, name: null, isError: false, timestamp: null }],
  };
}

describe("subagentWatchOpen", () => {
  it("listens before it opens, then closes once and removes the listener on dispose", async () => {
    const onEvent = vi.fn();
    const onOpened = vi.fn();
    const dispose = subagentWatchOpen(TARGET, { onEvent, onOpened });
    expect(openWatch).not.toHaveBeenCalled();

    listening.resolve(unlisten);
    await flush();
    expect(openWatch).toHaveBeenCalledWith("t1", "tab1", SESSION, "a1", null);

    opening.resolve({ live: true, total: 4 });
    await flush();
    expect(onOpened).toHaveBeenCalledWith({ live: true, total: 4 });

    deliver?.(batch("hello"));
    expect(onEvent).toHaveBeenCalledTimes(1);

    dispose();
    await flush();
    expect(unlisten).toHaveBeenCalledTimes(1);
    expect(subagentWatchClose).toHaveBeenCalledTimes(1);
    expect(subagentWatchClose).toHaveBeenCalledWith("t1", "tab1", SESSION, "a1");

    deliver?.(batch("after"));
    expect(onEvent).toHaveBeenCalledTimes(1);
  });

  it("waits for an open still in flight before it closes", async () => {
    const onOpened = vi.fn();
    const dispose = subagentWatchOpen(TARGET, { onEvent: vi.fn(), onOpened });
    listening.resolve(unlisten);
    await flush();

    dispose();
    await flush();
    expect(unlisten).toHaveBeenCalledTimes(1);
    expect(subagentWatchClose).not.toHaveBeenCalled();

    opening.resolve({ live: true, total: 0 });
    await flush();
    expect(subagentWatchClose).toHaveBeenCalledTimes(1);
    expect(onOpened).not.toHaveBeenCalled();
  });

  it("closes exactly once however many times it is disposed", async () => {
    const dispose = subagentWatchOpen(TARGET, { onEvent: vi.fn() });
    listening.resolve(unlisten);
    opening.resolve({ live: false, total: 0 });
    await flush();

    dispose();
    dispose();
    await flush();
    dispose();
    await flush();
    expect(unlisten).toHaveBeenCalledTimes(1);
    expect(subagentWatchClose).toHaveBeenCalledTimes(1);
  });

  it("never opens when disposed before the listener is up, and still removes it", async () => {
    const dispose = subagentWatchOpen(TARGET, { onEvent: vi.fn() });
    dispose();

    listening.resolve(unlisten);
    await flush();
    expect(unlisten).toHaveBeenCalledTimes(1);
    expect(openWatch).not.toHaveBeenCalled();
    expect(subagentWatchClose).not.toHaveBeenCalled();
  });

  it("does not close a watch whose open failed", async () => {
    const onError = vi.fn();
    const dispose = subagentWatchOpen(TARGET, { onEvent: vi.fn(), onError });
    listening.resolve(unlisten);
    opening.reject(new Error("subagent transcript not found"));
    await flush();
    expect(onError).toHaveBeenCalledTimes(1);

    dispose();
    await flush();
    expect(unlisten).toHaveBeenCalledTimes(1);
    expect(subagentWatchClose).not.toHaveBeenCalled();
  });

  it("passes a workflow run id through to the host", async () => {
    subagentWatchOpen({ ...TARGET, workflowRunId: "wf_r1" }, { onEvent: vi.fn() });
    listening.resolve(unlisten);
    await flush();
    expect(openWatch).toHaveBeenCalledWith("t1", "tab1", SESSION, "a1", "wf_r1");
  });
});
