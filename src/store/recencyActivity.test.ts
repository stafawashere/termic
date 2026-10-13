// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/ipc", () => ({
  ptyWrite: vi.fn(),
  ptyKill: vi.fn().mockResolvedValue(undefined),
  projectsList: vi.fn().mockResolvedValue([]),
  tasksList: vi.fn().mockResolvedValue([]),
  settingsLoad: vi.fn().mockResolvedValue({ agents: [] }),
  detectClis: vi.fn().mockResolvedValue([]),
  taskSetTabs: vi.fn().mockResolvedValue(undefined),
  taskSetTabSessionId: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/tabFocus", () => ({
  focusTerminalTab: vi.fn(),
  focusMainTab: vi.fn(),
  focusPaneTab: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));

import { useApp } from "@/store/app";
import { makeTask, makeTerminalTab, resetAppStore, seedTab } from "@/test-utils/store";

beforeEach(() => {
  resetAppStore();
  useApp.setState({ activityAt: {}, pendingActivityAt: {} });
});

describe("activity stamps for the sidebar order", () => {
  it("holds opening a task and prompting it back until a turn ends", () => {
    useApp.setState({ tasks: [makeTask({ id: "a" }), makeTask({ id: "b" })] });

    useApp.getState().setActiveTask("a");
    useApp.getState().noteTaskPrompt("b");

    expect(useApp.getState().activityAt).toEqual({});
    expect(Object.keys(useApp.getState().pendingActivityAt).sort()).toEqual(["a", "b"]);
  });

  it("folds every held stamp into the order when any turn ends, the finishing task newest", () => {
    const tab = makeTerminalTab({ workState: "working" });
    seedTab("done-task", tab);
    useApp.setState({ pendingActivityAt: { held: 111 } });

    useApp.getState().setWorkState("done-task", tab.id, "done");

    const { activityAt, pendingActivityAt } = useApp.getState();
    expect(activityAt.held).toBe(111);
    expect(activityAt["done-task"]).toBeGreaterThan(111);
    expect(pendingActivityAt).toEqual({});
  });

  it("does not stamp when an idle tab is told it is idle again", () => {
    const tab = makeTerminalTab({ workState: "idle" });
    seedTab("quiet", tab);

    useApp.getState().setWorkState("quiet", tab.id, "idle");

    expect(useApp.getState().activityAt).toEqual({});
  });
});
