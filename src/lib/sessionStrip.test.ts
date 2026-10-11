import { describe, expect, it } from "vitest";
import { formatClock, parseSessionStripKey, pickSessionTab, sessionStripKey } from "./sessionStrip";
import type { Tab } from "./types";

type TerminalFields = {
  workState?: "idle" | "working" | "done";
  workingSince?: number;
  workDoneAt?: number;
  unread?: { reason: string; message?: string } | null;
  cli?: string;
  runTab?: object;
  liveTitle?: string;
  lastOutputAt?: number;
};

const terminal = (id: string, fields: TerminalFields = {}) =>
  ({ id, type: "terminal", title: id, cli: "claude", ...fields }) as unknown as Tab;

describe("pickSessionTab", () => {
  it("shows the newest running agent and counts the others", () => {
    const tabs = [
      terminal("old", { workState: "working", workingSince: 1_000 }),
      terminal("new", { workState: "working", workingSince: 5_000 }),
      terminal("third", { workState: "working", workingSince: 3_000 }),
    ];

    expect(pickSessionTab(tabs)).toMatchObject({ tabId: "new", state: "running", since: 5_000, otherRunning: 2 });
  });

  it("prefers a running agent over a waiting one, and waiting over done", () => {
    const waiting = terminal("waiting", { workState: "working", workingSince: 9_000, unread: { reason: "attention" } });
    const done = terminal("done", { workState: "done", workDoneAt: 9_500 });
    const running = terminal("running", { workState: "working", workingSince: 1_000 });

    expect(pickSessionTab([done, waiting, running])?.tabId).toBe("running");
    expect(pickSessionTab([done, waiting])).toMatchObject({ tabId: "waiting", state: "waiting", otherRunning: 0 });
    expect(pickSessionTab([done])).toMatchObject({ tabId: "done", state: "done" });
  });

  it("names the tool a permission request is about, and only for a waiting agent", () => {
    const asking = terminal("asking", { unread: { reason: "attention", message: "needs your permission: mcp__github__create_pr" } });
    const vague = terminal("vague", { unread: { reason: "attention", message: "Claude needs your permission" } });

    expect(pickSessionTab([asking])?.tool).toBe("mcp__github__create_pr");
    expect(pickSessionTab([vague])?.tool).toBeNull();

    const finished = terminal("finished", { workState: "done", unread: { reason: "done", message: "needs your permission: Bash" } });
    expect(pickSessionTab([finished])?.tool).toBeNull();
  });

  it("ignores shells, run tabs and idle agents", () => {
    const tabs = [
      terminal("shell", { cli: "shell", workState: "working" }),
      terminal("run", { cli: "custom", runTab: { kind: "run" }, workState: "working" }),
      terminal("idle", { workState: "idle" }),
    ];

    expect(pickSessionTab(tabs)).toBeNull();
    expect(pickSessionTab(undefined)).toBeNull();
  });
});

describe("sessionStripKey", () => {
  it("does not move for output or a live title, so the strip does not re-render", () => {
    const before = [terminal("a", { workState: "working", workingSince: 1_000, liveTitle: "x", lastOutputAt: 1 })];
    const after = [terminal("a", { workState: "working", workingSince: 1_000, liveTitle: "y", lastOutputAt: 2 })];

    expect(sessionStripKey(after)).toBe(sessionStripKey(before));
  });

  it("round-trips the pick", () => {
    const tabs = [terminal("a", { unread: { reason: "attention", message: "needs your permission: Bash" }, workingSince: 7 })];

    expect(parseSessionStripKey(sessionStripKey(tabs))).toEqual(pickSessionTab(tabs));
    expect(parseSessionStripKey("")).toBeNull();
  });
});

describe("formatClock", () => {
  it("pads seconds, and minutes once there are hours", () => {
    expect(formatClock(9_000)).toBe("0:09");
    expect(formatClock(599_000)).toBe("9:59");
    expect(formatClock(3_599_000)).toBe("59:59");
    expect(formatClock(3_849_000)).toBe("1:04:09");
  });
});
