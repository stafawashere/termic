// @vitest-environment happy-dom
//
// Selector fan-out budget (performance.md bear trap 5).
//
// The rule this guards: tight Zustand selectors, and frozen EMPTY constants
// for the absent case, so an unrelated write does not invalidate every
// subscriber. The regression it exists to catch is someone selecting a whole
// slice (or building a fresh array/object inside a selector), which turns one
// sidebar-drag frame into a re-render of every mounted tab bar.
//
// Why this shape rather than a wall-clock benchmark: the count is
// machine-independent, so it can gate a PR on a 3-core CI VM. Timings cannot.
// See docs/perf-ci.md for the full argument. The one time assertion
// here is a loose backstop with orders of magnitude of headroom, not a budget.
//
// This models `useSyncExternalStore` exactly: on every store notification each
// mounted subscriber re-runs its selector, and re-renders if and only if the
// new snapshot differs from the old one by Object.is.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// Same mocks as app.test.ts, because importing the store pulls in the ipc layer.
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

import { useApp, selectTaskTabs, selectActiveTabId, EMPTY_TABS } from "@/store/app";
import { useAgentUsage, usageKey } from "@/store/agentUsage";
import { useSubagents, selectTabSubagents } from "@/store/subagents";
import { WORKFLOW_AGENT_TYPE } from "@/lib/subagentKind";
import { usePrefs } from "@/store/prefs";
import {
  createSubagentStructureSelector, createWorkflowRunCountsSelector, hasSubagentRow, selectSubagentRecord,
} from "@/components/sidebar/subagentTree";
import {
  createSidebarFactsSelector, createRowTabsSelector, tabRenderEqual, tabListRenderEqual,
  createStatusFactsSelector, createBoardFilterFactsSelector, selectStatusRowBadge, selectStatusRowDelegated,
  selectStatusRowTabCount, selectStatusRowActiveChild, selectRollupMarks,
} from "@/store/sidebarTabs";
import { parseBoardQuery } from "@/lib/boardFilter";
import { taskQueryNeeds } from "@/hooks/useTaskQuery";
import type { AppState } from "@/store/app";
import type { SubagentSummary, Tab, Task, TerminalTab } from "@/lib/types";

/** Mounted subscribers to simulate. A busy window is a handful of panes, not
 *  2500, but the budget should hold with two orders of magnitude of slack. */
const SUBSCRIBERS = 500;
/** Unrelated writes. A sidebar drag at 120 Hz for ~8 seconds. */
const WRITES = 1000;
/** Loose wall-clock backstop. Not a perf budget: purely a tripwire for
 *  accidentally quadratic selector work. Real value on a dev box is ~0.001. */
const MAX_MS_PER_WRITE = 2;

interface FanoutResult {
  selectorRuns: number;
  invalidations: number;
  /** Invalidations per subscriber, in the order they were passed. */
  perSub: number[];
  msPerWrite: number;
}

/** Run `write` `times` times with `subs` selectors mounted, counting how often
 *  each selector ran and how often its snapshot actually changed identity. */
function measureFanout(
  subs: ((s: AppState) => unknown)[],
  times: number,
  write: (i: number) => void,
): FanoutResult {
  let selectorRuns = 0;
  let invalidations = 0;
  const perSub = subs.map(() => 0);

  const snapshots = subs.map(sel => sel(useApp.getState()));
  const unsub = useApp.subscribe(() => {
    for (let i = 0; i < subs.length; i++) {
      selectorRuns++;
      const next = subs[i](useApp.getState());
      if (!Object.is(next, snapshots[i])) {
        invalidations++;
        perSub[i]++;
        snapshots[i] = next;
      }
    }
  });

  const t0 = performance.now();
  for (let i = 0; i < times; i++) write(i);
  const elapsed = performance.now() - t0;
  unsub();

  return { selectorRuns, invalidations, perSub, msPerWrite: elapsed / times };
}

function tab(id: string): Tab {
  return { id, type: "terminal", title: id, cli: "claude" } as Tab;
}

describe("selector fan-out budget (bear trap 5)", () => {
  beforeEach(() => {
    useApp.setState({ tabs: {}, activeTab: {}, sidebarWidth: 260 });
  });

  it("a sidebar drag invalidates no tab selector", () => {
    // The hot path: `setSidebarWidth` fires once per pointer-move while the
    // user drags the sidebar edge. Every mounted tab bar has a `useTaskTabs`
    // subscription. None of them may re-render.
    const seeded = Array.from({ length: SUBSCRIBERS }, (_, i) => `task-${i}`);
    useApp.setState({
      tabs: Object.fromEntries(seeded.map(id => [id, [tab(`${id}-a`)]])),
    });
    const subs = seeded.map(id => selectTaskTabs(id));

    const r = measureFanout(subs, WRITES, i =>
      useApp.getState().setSidebarWidth(200 + (i % 120)));

    expect(r.invalidations).toBe(0);
    // Sanity: the harness really did exercise every selector on every write.
    // Without this, `invalidations === 0` could pass vacuously.
    expect(r.selectorRuns).toBe(SUBSCRIBERS * WRITES);
    expect(r.msPerWrite).toBeLessThan(MAX_MS_PER_WRITE);
  });

  it("a config-sync pull that changed nothing notifies nobody (bear trap 8)", () => {
    // Config sync (src/lib/configSync.ts) reloads the stores from storage
    // after every pull, including the common one that brought nothing. The
    // folder colors live in this store, so a reload that publishes an equal
    // value would re-run every mounted selector here on every sync.
    const seeded = Array.from({ length: SUBSCRIBERS }, (_, i) => `task-${i}`);
    useApp.setState({ tabs: Object.fromEntries(seeded.map(id => [id, [tab(`${id}-a`)]])) });
    const subs = seeded.map(id => selectTaskTabs(id));
    const r = measureFanout(subs, WRITES, () => useApp.getState().reloadGroupColors());
    expect(r.selectorRuns).toBe(0);
  });

  it("detects fan-out when a selector is not tight (positive control)", () => {
    // Proves the harness can fail. A selector that reads the whole `tabs`
    // record is stable here, but one that derives a fresh array is not, this
    // is precisely the mistake bear trap 5 describes.
    useApp.setState({ tabs: { a: [tab("a-1")] } });
    const loose = [(s: AppState) => Object.keys(s.tabs).map(k => k)];

    const r = measureFanout(loose, 10, i =>
      useApp.getState().setSidebarWidth(200 + i));

    expect(r.invalidations).toBe(10);
  });

  it("a write to one task invalidates only that task's selector", () => {
    const ids = ["a", "b", "c"];
    useApp.setState({ tabs: Object.fromEntries(ids.map(id => [id, [tab(`${id}-1`)]])) });
    const subs = ids.map(id => selectTaskTabs(id));

    const r = measureFanout(subs, 1, () => {
      const s = useApp.getState();
      useApp.setState({ tabs: { ...s.tabs, b: [tab("b-1"), tab("b-2")] } });
    });

    expect(r.invalidations).toBe(1);
  });

  it("absent tasks share one frozen EMPTY_TABS reference", () => {
    // This is what keeps `invalidations` at 0 for a task with no tabs yet.
    // A `?? []` here would allocate per call and re-render every frame.
    const s = useApp.getState();
    expect(selectTaskTabs("nope")(s)).toBe(EMPTY_TABS);
    expect(selectTaskTabs("nope")(s)).toBe(selectTaskTabs("other")(s));
    expect(selectTaskTabs(null)(s)).toBe(EMPTY_TABS);
    expect(Object.isFrozen(EMPTY_TABS)).toBe(true);
  });

  // ── Subscription usage (GH #277) ───────────────────────────────────
  //
  // The usage feed is the newest thing on a hot path: claude's status line
  // reports on every turn, on every running task at once. Two invariants keep
  // that from becoming a per-turn re-render of the whole window, and both are
  // counts, so they survive a 3-core CI runner.

  it("a usage report invalidates NO useApp selector", () => {
    // The design decision this pins: usage lives in its OWN store, not in
    // useApp's ~233-key state. Putting it there would mean every status line
    // report copies that whole object and re-runs every mounted tab bar's
    // selector, which is bear trap 8 arriving once per turn per task.
    const seeded = Array.from({ length: SUBSCRIBERS }, (_, i) => `task-${i}`);
    useApp.setState({ tabs: Object.fromEntries(seeded.map(id => [id, [tab(`${id}-a`)]])) });
    const subs = seeded.map(id => selectTaskTabs(id));

    const r = measureFanout(subs, WRITES, i =>
      useAgentUsage.getState().report(
        "claude", null, { session: { usedPercent: i % 100, resetsAt: null }, weekly: null , sessionCostUsd: null}, "statusline"));

    expect(r.invalidations).toBe(0);
    expect(r.selectorRuns).toBe(0);
  });

  it("a usage report reaches only the footers on that agent", () => {
    useAgentUsage.setState({ byAgent: {} });
    // A window of tasks split across two accounts: a claude clone holding a
    // second login must not re-render when the first one's quota moves.
    const agents = Array.from({ length: SUBSCRIBERS }, (_, i) =>
      i % 2 === 0 ? "claude" : "next-claude");

    let runs = 0, invalidations = 0;
    const snap = agents.map(a => useAgentUsage.getState().byAgent[usageKey(a, null)]);
    const unsub = useAgentUsage.subscribe(() => {
      for (let i = 0; i < agents.length; i++) {
        runs++;
        const next = useAgentUsage.getState().byAgent[usageKey(agents[i], null)];
        if (!Object.is(next, snap[i])) { invalidations++; snap[i] = next; }
      }
    });

    useAgentUsage.getState().report(
      "claude", null, { session: { usedPercent: 1, resetsAt: null }, weekly: null , sessionCostUsd: null}, "statusline");
    expect(invalidations).toBe(SUBSCRIBERS / 2);

    // The same reading again. Most turns move a percentage by nothing, so this
    // is the COMMON case, and it must cost zero notifications: the bail in
    // `report` means no subscriber is even woken.
    const runsAfterFirst = runs;
    useAgentUsage.getState().report(
      "claude", null, { session: { usedPercent: 1, resetsAt: null }, weekly: null , sessionCostUsd: null}, "statusline");
    expect(runs).toBe(runsAfterFirst);
    expect(invalidations).toBe(SUBSCRIBERS / 2);

    unsub();
  });

  it("an account pill only re-renders for its OWN agent's accounts", () => {
    // The pill BUILDS an object (one entry per account of its agent), so it is
    // the one usage subscriber that cannot be Object.is-stable by construction
    // and needs `useShallow`. Without it every pill in the window re-renders on
    // every status-line report from any agent, once per turn per task, which
    // is bear trap 8 on the hottest path there is.
    useAgentUsage.setState({ byAgent: {} });
    const agents = Array.from({ length: SUBSCRIBERS }, (_, i) =>
      i % 2 === 0 ? "claude" : "next-claude");
    const ACCOUNTS = ["Work", "Personal"];

    // What the pill's selector produces, compared the way useShallow compares.
    const build = (agent: string) =>
      Object.fromEntries(ACCOUNTS.map(n =>
        [n, useAgentUsage.getState().byAgent[usageKey(agent, n)]]));
    const shallowEq = (a: Record<string, unknown>, b: Record<string, unknown>) =>
      Object.keys(a).length === Object.keys(b).length
      && Object.keys(a).every(k => Object.is(a[k], b[k]));

    let invalidations = 0;
    const snap = agents.map(build);
    const unsub = useAgentUsage.subscribe(() => {
      for (let i = 0; i < agents.length; i++) {
        const next = build(agents[i]);
        if (!shallowEq(next, snap[i])) { invalidations++; snap[i] = next; }
      }
    });

    useAgentUsage.getState().report(
      "claude", "Work", { session: { usedPercent: 1, resetsAt: null }, weekly: null , sessionCostUsd: null}, "statusline");
    // Only the claude pills, and only because one of THEIR accounts moved.
    expect(invalidations).toBe(SUBSCRIBERS / 2);

    // An account of the OTHER agent: the claude pills must not move again.
    useAgentUsage.getState().report(
      "next-claude", "Work", { session: { usedPercent: 5, resetsAt: null }, weekly: null , sessionCostUsd: null}, "statusline");
    expect(invalidations).toBe(SUBSCRIBERS);

    // An account NOBODY's pill lists: no pill re-renders at all.
    const before = invalidations;
    useAgentUsage.getState().report(
      "claude", "Client", { session: { usedPercent: 9, resetsAt: null }, weekly: null , sessionCostUsd: null}, "statusline");
    expect(invalidations).toBe(before);

    unsub();
  });

  it("activeTab selectors are undefined-stable for unknown tasks", () => {
    // `undefined` is Object.is-stable, so an unknown task never invalidates.
    const subs = Array.from({ length: 50 }, (_, i) => selectActiveTabId(`ghost-${i}`));
    const r = measureFanout(subs, 100, i =>
      useApp.getState().setSidebarWidth(200 + (i % 60)));
    expect(r.invalidations).toBe(0);
  });

  it("a ⌃⇥ walk step invalidates no tab-strip selector", () => {
    // The walk is live: every tap of Tab swaps what is on screen, so its cost
    // is paid while the user is holding a key down. `previewPlace` writes only
    // the pointers that decide what is visible, which is why it exists,
    // `setActiveTabId` rebuilds `tabs[taskId]` through .map() on every call and
    // hands back a fresh array even when no flag changed, so every mounted tab
    // bar in the window would re-render on each step.
    const seeded = Array.from({ length: SUBSCRIBERS }, (_, i) => `task-${i}`);
    useApp.setState({
      tabs: Object.fromEntries(seeded.map(id => [id, [tab(`${id}-a`), tab(`${id}-b`)]])),
      activeTab: Object.fromEntries(seeded.map(id => [id, `${id}-a`])),
    });
    const subs = seeded.map(id => selectTaskTabs(id));

    const r = measureFanout(subs, WRITES, i => {
      const id = seeded[i % SUBSCRIBERS];
      useApp.getState().previewPlace(id, `${id}-${i % 2 ? "a" : "b"}`);
    });

    expect(r.invalidations).toBe(0);
    expect(r.selectorRuns).toBe(SUBSCRIBERS * WRITES);
    expect(r.msPerWrite).toBeLessThan(MAX_MS_PER_WRITE);
  });

  it("the real setter DOES invalidate them (control for the step above)", () => {
    // Without this, the assertion above could pass because the walk never
    // wrote anything at all. This is the cost `previewPlace` avoids, measured
    // on the very same subscribers.
    const seeded = Array.from({ length: SUBSCRIBERS }, (_, i) => `task-${i}`);
    useApp.setState({
      tabs: Object.fromEntries(seeded.map(id => [id, [tab(`${id}-a`), tab(`${id}-b`)]])),
      activeTab: Object.fromEntries(seeded.map(id => [id, `${id}-a`])),
    });
    const subs = seeded.map(id => selectTaskTabs(id));

    const r = measureFanout(subs, 10, i => {
      const id = seeded[i % SUBSCRIBERS];
      useApp.getState().setActiveTabId(id, `${id}-${i % 2 ? "a" : "b"}`);
    });

    expect(r.invalidations).toBe(10);
  });

  // ── Board view column key (GH #318) ────────────────────────────────
  //
  // The board's columns come from useTaskQuery's column map over per-task
  // status facts (`createStatusFactsSelector`), the same record the sidebar's
  // status chips hold. These three cases pin it for the board's shape:
  // unrelated writes cost nothing, tab writes that move no badge cost
  // nothing, and a real column change costs exactly one invalidation.

  const boardTask = (id: string): Task => ({
    id, project_id: "p1", name: id, branch: id, base_branch: "main",
    path: "/tmp/x", cli: "claude", port: 0, created: "2026-09-01T00:00:00Z",
    archived: false,
  } as Task);

  it("the board's column key ignores unrelated writes", () => {
    useApp.setState({
      tasks: [boardTask("b1"), boardTask("b2")],
      tabs: { b1: [tab("b1-t")], b2: [tab("b2-t")] },
    });
    const subs = [createStatusFactsSelector()];

    const r = measureFanout(subs, WRITES, i =>
      useApp.getState().setSidebarWidth(200 + (i % 120)));

    expect(r.invalidations).toBe(0);
    expect(r.selectorRuns).toBe(WRITES);
  });

  it("the board's column key ignores tab writes that move no badge", () => {
    useApp.setState({
      tasks: [boardTask("b1")],
      tabs: { b1: [tab("b1-t")] },
    });
    const subs = [createStatusFactsSelector()];

    // A title churn (the per-keystroke case: liveTitle updates land here)
    // changes the tab object but not the work facts, so the record keeps its
    // identity and the board does not re-render.
    const r = measureFanout(subs, 100, i => {
      const s = useApp.getState();
      useApp.setState({ tabs: { ...s.tabs, b1: [{ ...tab("b1-t"), title: `t${i}` }] } });
    });

    expect(r.invalidations).toBe(0);
  });

  it("the board's column key fires exactly once on a real column change", () => {
    useApp.setState({
      tasks: [boardTask("b1")],
      tabs: { b1: [tab("b1-t")] },
    });
    const subs = [createStatusFactsSelector()];

    const r = measureFanout(subs, 1, () => {
      const s = useApp.getState();
      // The cast narrows past the Tab union: workState exists only on
      // terminal tabs, and a spread over the union fails to compile.
      useApp.setState({ tabs: { ...s.tabs, b1: [{ ...(tab("b1-t") as TerminalTab), workState: "working" }] } });
    });

    expect(r.invalidations).toBe(1);
  });

  // ── Kanban filter bar facts ────────────────────────────────────────
  //
  // While a free-text query is typed, BoardView holds the filter facts
  // record. It must not move while agents stream or flip state, or the
  // whole board re-renders per OSC title and per working/idle flip for no
  // change in what the query matches. Only a STABLE title or a property
  // value moves it.

  it("the board's filter facts ignore live titles and work-state flips", () => {
    useApp.setState({ tabs: { b1: [tab("b1-t")] } });
    const subs = [createBoardFilterFactsSelector()];

    const r = measureFanout(subs, 100, i => {
      const s = useApp.getState();
      useApp.setState({ tabs: { ...s.tabs, b1: [{
        ...(tab("b1-t") as TerminalTab),
        liveTitle: `thinking ${i}`,
        workState: i % 2 ? "done" : "idle",
      }] } });
    });

    expect(r.invalidations).toBe(0);
  });

  it("the board's filter facts fire once on a tab rename", () => {
    useApp.setState({ tabs: { b1: [tab("b1-t")] } });
    const subs = [createBoardFilterFactsSelector()];

    const r = measureFanout(subs, 1, () => {
      const s = useApp.getState();
      useApp.setState({ tabs: { ...s.tabs, b1: [{ ...tab("b1-t"), title: "Reviewer" }] } });
    });

    expect(r.invalidations).toBe(1);
  });

  it("one walk step is one notification", () => {
    // `setActiveTask` alone does three writes in a row (the departing tab's
    // timestamps, the main set, then the unread-clearing set). A walk that
    // went through it would pay all three per tap, and this count is what
    // fails if someone later folds previewPlace back into it.
    useApp.setState({
      tabs: { a: [tab("a1")], b: [tab("b1")] },
      activeTab: { a: "a1", b: "b1" },
      activeTaskId: "a",
    });
    let notifications = 0;
    const unsub = useApp.subscribe(() => { notifications++; });
    useApp.getState().previewPlace("b", "b1");
    useApp.getState().previewPlace("a", "a1");
    unsub();
    expect(notifications).toBe(2);
  });
});

// ── The sidebar while agents stream ────────────────────────────────────
//
// A WebContent profile of 16 tasks with 10 live claude PTYs had the main
// thread ~12% busy, most of it React renders driven by store writes, with
// object spreads as the hot leaves. The writes were `lastOutputAt` stamps:
// bear trap 9 bounds their RATE (one per 500 ms per streaming terminal), but
// the sidebar selected the whole `tabs` map, so each one re-rendered the
// sidebar and, with its rows unmemoized, every row in it. These counts pin
// the FAN-OUT: a stamp reaches no sidebar subscriber at all, and a write the
// sidebar does draw reaches exactly the subscribers that draw it.

describe("sidebar under streaming output (bear traps 5, 8)", () => {
  const TASKS = 16;
  const ids = Array.from({ length: TASKS }, (_, i) => `task-${i}`);
  const main = (id: string) => `${id}-main`;

  beforeEach(() => {
    useApp.setState({
      tabs: Object.fromEntries(ids.map(id => [id, [
        { ...tab(main(id)), is_default: true, ptyId: `pty-${id}` } as Tab,
        tab(`${id}-shell`),
      ]])),
    });
  });

  /** What the mounted sidebar subscribes with: one facts selector for the
   *  body, one tabs selector per row. */
  const mountSidebar = () => [
    createSidebarFactsSelector(),
    ...ids.map(id => createRowTabsSelector(id)),
  ];

  const stamp = (i: number) => {
    const id = ids[i % TASKS];
    useApp.getState().patchTab(id, main(id), { lastOutputAt: 1_000 + i });
  };

  it("an output stamp invalidates neither the sidebar body nor any row", () => {
    const subs = mountSidebar();
    const r = measureFanout(subs, WRITES, stamp);

    expect(r.invalidations).toBe(0);
    // Not vacuous: every write notified, and every subscriber re-ran.
    expect(r.selectorRuns).toBe(subs.length * WRITES);
    expect(r.msPerWrite).toBeLessThan(MAX_MS_PER_WRITE);
  });

  it("the subscriptions this replaced fail the same count (positive control)", () => {
    // The body used to select `s.tabs`, and each row `selectTaskTabs(id)`.
    const r = measureFanout(
      [(s: AppState) => s.tabs, ...ids.map(id => selectTaskTabs(id))], WRITES, stamp);

    expect(r.perSub[0]).toBe(WRITES);
    // Each row re-rendered for its own task's stamps, i.e. once per write.
    expect(r.perSub.slice(1).reduce((a, b) => a + b, 0)).toBe(WRITES);
    expect(r.perSub.slice(1).every(n => n > 0)).toBe(true);
  });

  it("a sidebar drag invalidates neither", () => {
    const r = measureFanout(mountSidebar(), WRITES, i =>
      useApp.getState().setSidebarWidth(200 + (i % 120)));
    expect(r.invalidations).toBe(0);
  });

  // No false negatives: each write below changes something the sidebar
  // draws, so it must still get through, to exactly the subscribers that
  // draw it. perSub[0] is the body; perSub[1 + n] is row n.
  const OWNER = 3;
  const expectReached = (r: FanoutResult, body: number) => {
    expect(r.perSub[0]).toBe(body);
    expect(r.perSub.slice(1)).toEqual(ids.map((_, i) => (i === OWNER ? 1 : 0)));
  };
  const owner = ids[OWNER];

  it("an agent's live title reaches its row and not the body", () => {
    // The case a whole-map "ignore the timestamps" comparator gets wrong:
    // agents rewrite their title about once a second while they work, and
    // the body draws none of it.
    expectReached(measureFanout(mountSidebar(), 1, () =>
      useApp.getState().setTabLiveTitle(owner, main(owner), "thinking")), 0);
  });

  it("a finished turn reaches the body (rollup dot, bell count) and its row", () => {
    expectReached(measureFanout(mountSidebar(), 1, () =>
      useApp.getState().patchTab(owner, main(owner), { workState: "done" })), 1);
  });

  it("an agent blocked on the user reaches the body and its row", () => {
    expectReached(measureFanout(mountSidebar(), 1, () =>
      useApp.getState().markAttention(owner, main(owner), "attention")), 1);
  });

  it("a tab rename reaches the body (the filter matches it) and its row", () => {
    expectReached(measureFanout(mountSidebar(), 1, () =>
      useApp.getState().renameTab(owner, `${owner}-shell`, "Reviewer")), 1);
  });

  it("a main agent exiting reaches the body (broadcast count) and its row", () => {
    expectReached(measureFanout(mountSidebar(), 1, () =>
      useApp.getState().patchTab(owner, main(owner), { ptyId: undefined })), 1);
  });

  it("a row held across stamps still shows the next visible change", () => {
    // The row keeps its PREVIOUS array while only hidden fields move, so
    // what it hands back after a stamp must not mask what comes next.
    const sel = createRowTabsSelector(owner);
    const before = sel(useApp.getState());
    stamp(OWNER);
    expect(sel(useApp.getState())).toBe(before);
    useApp.getState().patchTab(owner, main(owner), { workState: "done" });
    const after = sel(useApp.getState());
    expect(after).not.toBe(before);
    expect((after[0] as TerminalTab).workState).toBe("done");
    // And it carries the real timestamp again, not the held one.
    expect((after[0] as TerminalTab).lastOutputAt).toBe(1_000 + OWNER);
  });

  it("a task's tabs loading or going away reaches the body", () => {
    const facts = createSidebarFactsSelector();
    const before = facts(useApp.getState());
    expect(before["late"]).toBeUndefined();
    useApp.setState({ tabs: { ...useApp.getState().tabs, late: [tab("late-1")] } });
    const loaded = facts(useApp.getState());
    expect(loaded).not.toBe(before);
    expect(loaded["late"]).toBeDefined();
    // Untouched tasks keep their facts object, so nothing reading them moves.
    expect(loaded[owner]).toBe(before[owner]);
    const { late: _, ...rest } = useApp.getState().tabs;
    useApp.setState({ tabs: rest });
    expect(facts(useApp.getState())["late"]).toBeUndefined();
  });

  it("the Sidebar body does not select the tabs map", () => {
    // The counts above measure the selectors; this pins that the Sidebar
    // still USES them. `useApp(s => s.tabs)` is the exact line that caused
    // the fan-out, and a row selector reading one task's entry is fine.
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(resolve(here, "../components/sidebar/Sidebar.tsx"), "utf8");
    expect(src).not.toMatch(/=>\s*s\.tabs\s*\)/);
    expect(src).toMatch(/useSidebarTabFacts\(\)/);
    expect(src).toMatch(/useRowTabs\(w\.id\)/);
  });
});

describe("collapsed project and folder marks (bear traps 5, 8)", () => {
  // The tree's folded headers (RollupMarks): two collapsed projects of eight
  // tasks each, inside one collapsed folder that holds all sixteen.
  const TASKS = 16;
  const ids = Array.from({ length: TASKS }, (_, i) => `rm-${i}`);
  const main = (id: string) => `${id}-main`;
  const PREFS = { settledHighlight: true, workingIndicator: true, attentionIndicator: true };
  const projectA = ids.slice(0, 8);
  const projectB = ids.slice(8);

  beforeEach(() => {
    useApp.setState({
      tabs: Object.fromEntries(ids.map(id => [id, [
        { ...tab(main(id)), is_default: true, ptyId: `pty-${id}` } as Tab,
        tab(`${id}-shell`),
      ]])),
    });
  });

  /** perSub: [project A, project B, the folder]. */
  const mountHeaders = () => [
    selectRollupMarks(projectA, PREFS, true),
    selectRollupMarks(projectB, PREFS, true),
    selectRollupMarks(ids, PREFS, true),
  ];

  it("an output stamp, a live title and a sidebar drag reach no header", () => {
    const subs = mountHeaders();
    const stamps = measureFanout(subs, WRITES, i => {
      const id = ids[i % TASKS];
      useApp.getState().patchTab(id, main(id), { lastOutputAt: 1_000 + i });
    });
    expect(stamps.invalidations).toBe(0);
    expect(stamps.selectorRuns).toBe(subs.length * WRITES);
    expect(stamps.msPerWrite).toBeLessThan(MAX_MS_PER_WRITE);
    expect(measureFanout(subs, 100, i =>
      useApp.getState().setTabLiveTitle(ids[2], main(ids[2]), `thinking ${i}`)).invalidations).toBe(0);
    expect(measureFanout(subs, WRITES, i =>
      useApp.getState().setSidebarWidth(200 + (i % 120))).invalidations).toBe(0);
  });

  it("a turn starting reaches its project and its folder, once, and not the other project", () => {
    const r = measureFanout(mountHeaders(), 1, () =>
      useApp.getState().patchTab(ids[2], main(ids[2]), { workState: "working" }));
    expect(r.perSub).toEqual([1, 0, 1]);
  });

  it("a second agent working where one already is moves no header: the SET of marks is the same", () => {
    const subs = mountHeaders();
    measureFanout(subs, 1, () => useApp.getState().patchTab(ids[2], main(ids[2]), { workState: "working" }));
    const r = measureFanout(subs, 1, () =>
      useApp.getState().patchTab(ids[5], main(ids[5]), { workState: "working" }));
    expect(r.invalidations).toBe(0);
  });

  it("an agent blocked on the user reaches its project and its folder", () => {
    const r = measureFanout(mountHeaders(), 1, () =>
      useApp.getState().markAttention(ids[12], main(ids[12]), "attention"));
    expect(r.perSub).toEqual([0, 1, 1]);
  });

  it("Sidebar.tsx draws the marks only on a FOLDED header", () => {
    // Expanded, the rows carry their own badges, and an unmounted header
    // costs no selector run at all.
    const here = dirname(fileURLToPath(import.meta.url));
    const sidebar = readFileSync(resolve(here, "../components/sidebar/Sidebar.tsx"), "utf8");
    expect(sidebar).toMatch(/\{collapsed && taskList\.length > 0 && \(\s*<RollupMarks /);
    expect(sidebar).toMatch(/\{collapsed && grpWs\.length > 0 && \(\s*<RollupMarks /);
    const marks = readFileSync(resolve(here, "../components/sidebar/RollupMarks.tsx"), "utf8");
    expect(marks).toMatch(/selectRollupMarks\(/);
  });
});

describe("tab render equality (sidebar rows)", () => {
  const base = { ...tab("t"), ptyId: "p", lastOutputAt: 1 } as Tab;

  it("ignores only the timestamps no row draws", () => {
    expect(tabRenderEqual(base, { ...base, lastOutputAt: 2 } as Tab)).toBe(true);
    expect(tabRenderEqual(base, { ...base, lastInputAt: 5, firstOutputAt: 6 } as Tab)).toBe(true);
    expect(tabRenderEqual(base, { ...base, title: "other" } as Tab)).toBe(false);
    expect(tabRenderEqual(base, { ...base, liveTitle: "x" } as Tab)).toBe(false);
    expect(tabRenderEqual(base, { ...base, ptyId: undefined } as Tab)).toBe(false);
  });

  it("reads an absent key and an undefined one the same, as they render", () => {
    expect(tabRenderEqual(base, { ...base, workState: undefined } as Tab)).toBe(true);
    expect(tabRenderEqual(base, { ...base, workState: "idle" } as Tab)).toBe(false);
  });

  it("compares lists by position", () => {
    const a = tab("a"), b = tab("b");
    expect(tabListRenderEqual([a, b], [a, b])).toBe(true);
    expect(tabListRenderEqual([a, b], [b, a])).toBe(false);
    expect(tabListRenderEqual([a, b], [a])).toBe(false);
  });
});

// ── The status section while agents stream ─────────────────────────────
//
// The section lists tasks by board column, and one of the facts behind a
// column (`untouched`) reads `lastInputAt`, a field the tree's rows hold back.
// So it keeps a facts record of its own, and these counts pin what that buys:
// timestamps and titles reach nothing, a real column change reaches the
// section, and the Sidebar BODY never pays for the section's facts.

describe("status section under streaming output (bear traps 5, 8)", () => {
  const TASKS = 16;
  const ids = Array.from({ length: TASKS }, (_, i) => `st-${i}`);
  const main = (id: string) => `${id}-main`;
  const PREFS = { settledHighlight: true, workingIndicator: true, attentionIndicator: true };
  const OWNER = 5;
  const owner = ids[OWNER];

  beforeEach(() => {
    useApp.setState({
      tabs: Object.fromEntries(ids.map(id => [id, [
        { ...tab(main(id)), is_default: true, ptyId: `pty-${id}` } as Tab,
        tab(`${id}-shell`),
      ]])),
    });
  });

  /** The mounted section, rows collapsed: one facts selector, and per row
   *  its badge, its delegated-work report, its tab count and whether a child
   *  carries the selection. perSub[0] is the facts record. */
  const mountSection = () => [
    createStatusFactsSelector(),
    ...ids.map(id => selectStatusRowBadge(id, PREFS)),
    ...ids.map(id => selectStatusRowDelegated(id, PREFS)),
    ...ids.map(id => selectStatusRowTabCount(id)),
    ...ids.map(id => selectStatusRowActiveChild(id)),
    // A folded group of four of them: its caption's marks.
    selectRollupMarks(ids.slice(4, 8), PREFS, true),
  ];

  const stamp = (i: number) => {
    const id = ids[i % TASKS];
    useApp.getState().patchTab(id, main(id), { lastOutputAt: 1_000 + i });
  };

  it("an output stamp invalidates neither the section nor any row", () => {
    const subs = mountSection();
    const r = measureFanout(subs, WRITES, stamp);
    expect(r.invalidations).toBe(0);
    expect(r.selectorRuns).toBe(subs.length * WRITES);
    expect(r.msPerWrite).toBeLessThan(MAX_MS_PER_WRITE);
  });

  it("a live title, which the tree's row DOES draw, reaches nothing here", () => {
    const r = measureFanout(mountSection(), 100, i =>
      useApp.getState().setTabLiveTitle(owner, main(owner), `thinking ${i}`));
    expect(r.invalidations).toBe(0);
  });

  it("a sidebar drag invalidates nothing", () => {
    const r = measureFanout(mountSection(), WRITES, i =>
      useApp.getState().setSidebarWidth(200 + (i % 120)));
    expect(r.invalidations).toBe(0);
  });

  it("a task's FIRST input moves it out of Not started, and only the first", () => {
    // The fact useRowTabs cannot see: lastInputAt is in ROW_HIDDEN_TAB_FIELDS.
    const subs = mountSection();
    const first = measureFanout(subs, 1, () =>
      useApp.getState().patchTab(owner, main(owner), { lastInputAt: 2_000 }));
    expect(first.perSub[0]).toBe(1);
    expect(first.invalidations).toBe(1);
    const again = measureFanout(subs, 50, i =>
      useApp.getState().patchTab(owner, main(owner), { lastInputAt: 3_000 + i }));
    expect(again.invalidations).toBe(0);
  });

  it("an agent starting a turn reaches the section and its own badge, once", () => {
    const r = measureFanout(mountSection(), 1, () =>
      useApp.getState().patchTab(owner, main(owner), { workState: "working" }));
    expect(r.perSub[0]).toBe(1);
    // Its badge (index 1 + OWNER) and nobody else's.
    expect(r.perSub.slice(1, 1 + TASKS)).toEqual(ids.map((_, i) => (i === OWNER ? 1 : 0)));
    // ...and the folded group it is a member of: the caption gains a mark.
    expect(r.perSub[r.perSub.length - 1]).toBe(1);
    expect(r.invalidations).toBe(3);
  });

  it("an agent starting a turn does NOT reach the Sidebar body", () => {
    // Why the section's facts are a record of their own: as fields on
    // SidebarTaskFacts, every idle -> working flip would re-render the whole
    // body, section on or off.
    const r = measureFanout([createSidebarFactsSelector()], 1, () =>
      useApp.getState().patchTab(owner, main(owner), { workState: "working" }));
    expect(r.invalidations).toBe(0);
  });

  it("an agent blocked on the user reaches the section and its badge", () => {
    const r = measureFanout(mountSection(), 1, () =>
      useApp.getState().markAttention(owner, main(owner), "attention"));
    expect(r.perSub[0]).toBe(1);
    expect(r.perSub[1 + OWNER]).toBe(1);
  });

  it("StatusSection.tsx does not select the tabs map", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(resolve(here, "../components/sidebar/StatusSection.tsx"), "utf8");
    expect(src).not.toMatch(/=>\s*s\.tabs\s*\)/);
    expect(src).not.toMatch(/selectTaskTabs/);
    // A row's tabs are held only by an EXPANDED row's children, which draw
    // the titles; a collapsed row selects values.
    expect(src.match(/useRowTabs\(/g)?.length).toBe(1);
    const children = src.slice(src.indexOf("function StatusTaskTabs("));
    expect(children).toMatch(/useRowTabs\(taskId\)/);
    expect(src).toMatch(/useStatusTabFacts\(\)/);
    expect(src).toMatch(/selectStatusRowBadge\(/);
    // Mounted only with the pref on and never on the icon rail, so the off
    // state costs no subscription at all.
    const sidebar = readFileSync(resolve(here, "../components/sidebar/Sidebar.tsx"), "utf8");
    expect(sidebar).toMatch(/!compact && showStatusSection && <StatusSection[ />]/);
  });
});

// ── The status chips while agents stream ───────────────────────────────
//
// The chips count tasks by board column, and one of the facts behind a
// column (`untouched`) reads `lastInputAt`, a field the tree's rows hold back.
// So they keep a facts record of their own, and these counts pin what that
// buys: timestamps and titles reach nothing, a real column change reaches the
// chips, and the Sidebar BODY never pays for their facts.

describe("status chips under streaming output (bear traps 5, 8)", () => {
  const TASKS = 16;
  const ids = Array.from({ length: TASKS }, (_, i) => `st-${i}`);
  const main = (id: string) => `${id}-main`;
  const OWNER = 5;
  const owner = ids[OWNER];

  beforeEach(() => {
    useApp.setState({
      tabs: Object.fromEntries(ids.map(id => [id, [
        { ...tab(main(id)), is_default: true, ptyId: `pty-${id}` } as Tab,
        tab(`${id}-shell`),
      ]])),
    });
  });

  /** The mounted chips: one facts selector (inside useTaskQuery), and
   *  nothing per task. */
  const mountChips = () => [createStatusFactsSelector()];

  const stamp = (i: number) => {
    const id = ids[i % TASKS];
    useApp.getState().patchTab(id, main(id), { lastOutputAt: 1_000 + i });
  };

  it("an output stamp invalidates nothing", () => {
    const subs = mountChips();
    const r = measureFanout(subs, WRITES, stamp);
    expect(r.invalidations).toBe(0);
    expect(r.msPerWrite).toBeLessThan(MAX_MS_PER_WRITE);
  });

  it("a live title reaches nothing", () => {
    const r = measureFanout(mountChips(), 100, i =>
      useApp.getState().setTabLiveTitle(owner, main(owner), `thinking ${i}`));
    expect(r.invalidations).toBe(0);
  });

  it("a sidebar drag invalidates nothing", () => {
    const r = measureFanout(mountChips(), WRITES, i =>
      useApp.getState().setSidebarWidth(200 + (i % 120)));
    expect(r.invalidations).toBe(0);
  });

  it("a task's FIRST input moves its column, and only the first", () => {
    // The fact useRowTabs cannot see: lastInputAt is in ROW_HIDDEN_TAB_FIELDS.
    const subs = mountChips();
    const first = measureFanout(subs, 1, () =>
      useApp.getState().patchTab(owner, main(owner), { lastInputAt: 2_000 }));
    expect(first.invalidations).toBe(1);
    const again = measureFanout(subs, 50, i =>
      useApp.getState().patchTab(owner, main(owner), { lastInputAt: 3_000 + i }));
    expect(again.invalidations).toBe(0);
  });

  it("an agent starting a turn reaches the chips once", () => {
    const r = measureFanout(mountChips(), 1, () =>
      useApp.getState().patchTab(owner, main(owner), { workState: "working" }));
    expect(r.invalidations).toBe(1);
  });

  it("an agent starting a turn does NOT reach the Sidebar body", () => {
    // Why the chips' facts are a record of their own: as fields on
    // SidebarTaskFacts, every idle -> working flip would re-render the body.
    const r = measureFanout([createSidebarFactsSelector()], 1, () =>
      useApp.getState().patchTab(owner, main(owner), { workState: "working" }));
    expect(r.invalidations).toBe(0);
  });

  it("an agent blocked on the user reaches the chips", () => {
    const r = measureFanout(mountChips(), 1, () =>
      useApp.getState().markAttention(owner, main(owner), "attention"));
    expect(r.invalidations).toBe(1);
  });

  it("StatusChips.tsx holds its own facts and never the tabs map", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(resolve(here, "../components/sidebar/StatusChips.tsx"), "utf8");
    expect(src).not.toMatch(/=>\s*s\.tabs\s*\)/);
    expect(src).not.toMatch(/selectTaskTabs|useRowTabs/);
    // its columns come from useTaskQuery, whose column facts are the record above
    expect(src).toMatch(/useTaskQuery\(\{[^}]*alwaysColumns: true/);
    const hook = readFileSync(resolve(here, "../hooks/useTaskQuery.tsx"), "utf8");
    expect(hook).toMatch(/useState\(createStatusFactsSelector\)/);
    // Its own memoized component, so a count moving re-renders the chips and
    // not the Sidebar body; never on the icon rail.
    expect(src).toMatch(/export const StatusChips = memo\(/);
    const sidebar = readFileSync(resolve(here, "../components/sidebar/Sidebar.tsx"), "utf8");
    // Never alongside the section, which lists the same buckets, and inside
    // the row that is itself gated off the icon rail.
    expect(sidebar).toMatch(/\{!compact && \(\s*<div[^>]*>\s*\{!showStatusSection && <StatusChips \/>\}/);
  });
});

describe("sidebar filter bar with no query (bear trap 5)", () => {
  // The Sidebar body calls useTaskQuery on every render, query or not. Each
  // subscription it adds must select a constant until the query (or the
  // open menu) reads it, or an empty bar would re-render the body on every
  // PR poll, diffstat and tab write. `taskQueryNeeds` is the gate every one
  // of those subscriptions goes through.
  const needs = (text: string, menuOpen = false, alwaysColumns = false) =>
    taskQueryNeeds(parseBoardQuery(text), menuOpen, alwaysColumns);

  it("an empty, closed bar needs nothing", () => {
    expect(needs("")).toEqual({
      filtering: false, watching: false, columns: false, pr: false, checks: false, changes: false, freeText: false,
    });
  });

  it("free text needs the PR trigger and text facts, and no columns", () => {
    expect(needs("login")).toMatchObject({ watching: true, pr: true, freeText: true, columns: false, changes: false });
  });

  it("columns only for `status:`, the open menu, or a caller that lays them out", () => {
    expect(needs("status:working").columns).toBe(true);
    expect(needs("project:web").columns).toBe(false);
    expect(needs("", true).columns).toBe(true);
    expect(needs("", false, true)).toMatchObject({ columns: true, pr: true, watching: false, changes: false });
  });

  it("checks and diffstats only while something reads them", () => {
    expect(needs("pr:open").checks).toBe(false);
    expect(needs("checks:failing").checks).toBe(true);
    expect(needs("has:changes").changes).toBe(true);
    expect(needs("", true)).toMatchObject({ checks: true, changes: true });
  });

  it("every subscription in the hook goes through the gate", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const hook = readFileSync(resolve(here, "../hooks/useTaskQuery.tsx"), "utf8");
    expect(hook).toMatch(/usePr\(s => needs\.pr\s*\?/);
    expect(hook).toMatch(/useDiffStat\(s => usesChanges\s*\?/);
    expect(hook).toMatch(/useApp\(needs\.columns \? selectStatusFacts : selectNoStatusFacts\)/);
    expect(hook).toMatch(/useApp\(!facts && needs\.freeText \? selectFilterFacts : selectNoFilterFacts\)/);
    // the sidebar reuses the tab facts its body already holds
    const sidebar = readFileSync(resolve(here, "../components/sidebar/Sidebar.tsx"), "utf8");
    expect(sidebar).toMatch(/facts: tabFacts/);
  });
});

// -- Subagents --------------------------------------------------------------
//
// A workflow starts and stops dozens of subagents in seconds. Their records
// live in their own store for the same reason usage does: on useApp, each of
// those writes would copy the whole state and re-run every tab bar's and
// sidebar row's selector.
describe("subagents (bear traps 5, 8)", () => {
  const SESSION = "11111111-2222-4333-8444-555555555555";
  const agentId = (i: number) => `a${i.toString(16).padStart(16, "0")}`;
  const tabIds = Array.from({ length: SUBSCRIBERS }, (_, i) => `task-${i}-a`);

  /** Even writes start an agent, odd writes stop the one just started, so
   *  every write is a real change and none is swallowed by a bail. */
  const subagentWrite = (i: number) => {
    const tabId = tabIds[i % SUBSCRIBERS];
    const taskId = tabId.slice(0, -2);
    if (i % 2 === 0) useSubagents.getState().start(taskId, tabId, SESSION, agentId(i), "Explore");
    else useSubagents.getState().stop(tabIds[(i - 1) % SUBSCRIBERS], agentId(i - 1), "unknown");
  };

  beforeEach(() => {
    useSubagents.setState({ byTab: {} });
    const seeded = Array.from({ length: SUBSCRIBERS }, (_, i) => `task-${i}`);
    useApp.setState({ tabs: Object.fromEntries(seeded.map(id => [id, [tab(`${id}-a`)]])) });
  });

  it("a subagent write invalidates NO useApp selector", () => {
    const subs = Object.keys(useApp.getState().tabs).map(id => selectTaskTabs(id));
    let storeWakes = 0;
    const unsub = useSubagents.subscribe(() => { storeWakes++; });

    const r = measureFanout(subs, WRITES, subagentWrite);
    unsub();

    // Not vacuous: every write was a real change to the subagent store.
    expect(storeWakes).toBe(WRITES);
    expect(r.invalidations).toBe(0);
    expect(r.selectorRuns).toBe(0);
  });

  it("a subagent write reaches neither the sidebar body nor any row nor the status facts", () => {
    const taskIds = Object.keys(useApp.getState().tabs);
    const subs = [
      createSidebarFactsSelector(),
      createStatusFactsSelector(),
      ...taskIds.map(id => createRowTabsSelector(id)),
    ];

    const r = measureFanout(subs, WRITES, subagentWrite);

    expect(r.invalidations).toBe(0);
    expect(r.selectorRuns).toBe(0);
  });

  it("a write to one tab reaches only that tab's subagent list", () => {
    let runs = 0;
    const perTab = tabIds.map(() => 0);
    const selectors = tabIds.map(id => selectTabSubagents(id));
    const snap = selectors.map(sel => sel(useSubagents.getState()));
    const unsub = useSubagents.subscribe(state => {
      for (let i = 0; i < selectors.length; i++) {
        runs++;
        const next = selectors[i](state);
        if (!Object.is(next, snap[i])) { perTab[i]++; snap[i] = next; }
      }
    });

    const owner = 7;
    const ownerTask = tabIds[owner].slice(0, -2);
    useSubagents.getState().start(ownerTask, tabIds[owner], SESSION, agentId(1), "Explore");
    expect(perTab).toEqual(tabIds.map((_, i) => (i === owner ? 1 : 0)));

    // The identical write again: the bail means nobody is even woken.
    const runsAfterFirst = runs;
    useSubagents.getState().start(ownerTask, tabIds[owner], SESSION, agentId(1), "Explore");
    expect(runs).toBe(runsAfterFirst);
    expect(perTab.reduce((a, b) => a + b, 0)).toBe(1);

    unsub();
  });
});

// -- Subagent rows -----------------------------------------------------------
//
// What the sidebar mounts for subagents: per claude tab one structure key
// (SubagentRows' list), per agent one record selector (each SubagentRow), and
// per task row one boolean for the header highlight. A subagent finishing is
// the common write, and it must reach its own row alone.
describe("subagent rows (bear traps 5, 8)", () => {
  const SESSION = "11111111-2222-4333-8444-555555555555";
  const TABS = 16;
  const AGENTS_PER_TAB = 8;
  const tabIds = Array.from({ length: TABS }, (_, i) => `task-${i}-a`);
  const taskOf = (tabId: string) => tabId.slice(0, -2);
  const agentId = (tab: number, n: number) => `a${tab}x${n}`;

  type SubagentSelector = (s: ReturnType<typeof useSubagents.getState>) => unknown;

  interface Mounted {
    label: string;
    select: SubagentSelector;
  }

  /** What a sidebar with every task expanded subscribes to the subagent
   *  store with, labelled so a failure names the selector that moved. */
  function mountRows(): Mounted[] {
    const mounted: Mounted[] = [];
    tabIds.forEach((tabId, t) => {
      mounted.push({ label: `structure ${tabId}`, select: createSubagentStructureSelector(tabId) });
      mounted.push({ label: `header ${tabId}`, select: s => hasSubagentRow(s.byTab, [tabId], agentId(t, 0)) });
      for (let n = 0; n < AGENTS_PER_TAB; n++) {
        mounted.push({ label: `row ${agentId(t, n)}`, select: selectSubagentRecord(tabId, agentId(t, n)) });
      }
    });
    return mounted;
  }

  /** Run `write` with `mounted` subscribed and return the labels whose
   *  snapshot changed identity, once per change. */
  function changedBy(mounted: Mounted[], write: () => void): string[] {
    const snap = mounted.map(m => m.select(useSubagents.getState()));
    const changed: string[] = [];
    const unsub = useSubagents.subscribe(state => {
      mounted.forEach((m, i) => {
        const next = m.select(state);
        if (!Object.is(next, snap[i])) { changed.push(m.label); snap[i] = next; }
      });
    });

    write();
    unsub();
    return changed;
  }

  beforeEach(() => {
    useSubagents.setState({ byTab: {} });
    useApp.setState({ tabs: Object.fromEntries(tabIds.map(id => [taskOf(id), [tab(id)]])) });
    tabIds.forEach((tabId, t) => {
      for (let n = 0; n < AGENTS_PER_TAB; n++) {
        useSubagents.getState().start(taskOf(tabId), tabId, SESSION, agentId(t, n), "Explore");
      }
    });
  });

  it("an agent finishing reaches only its own row", () => {
    const changed = changedBy(mountRows(), () =>
      useSubagents.getState().stop(tabIds[3], agentId(3, 5), "done"));

    expect(changed).toEqual([`row ${agentId(3, 5)}`]);
    expect(useSubagents.getState().byTab[tabIds[3]].agents[agentId(3, 5)].state).toBe("done");
  });

  it("an agent finishing reaches no useApp selector, no sidebar body and no task row", () => {
    const taskIds = tabIds.map(taskOf);
    const subs = [
      createSidebarFactsSelector(),
      createStatusFactsSelector(),
      ...taskIds.map(id => createRowTabsSelector(id)),
      ...taskIds.map(id => selectTaskTabs(id)),
    ];

    const r = measureFanout(subs, AGENTS_PER_TAB, n =>
      useSubagents.getState().stop(tabIds[n], agentId(n, n), "done"));

    expect(r.invalidations).toBe(0);
    expect(r.selectorRuns).toBe(0);
  });

  it("a new agent DOES reach its tab's structure key (positive control)", () => {
    const changed = changedBy(mountRows(), () =>
      useSubagents.getState().start(taskOf(tabIds[3]), tabIds[3], SESSION, "late1", "Explore"));

    expect(changed).toEqual([`structure ${tabIds[3]}`]);
  });

  it("a parent arriving from the transcript reaches the structure key and that row", () => {
    const parent = agentId(3, 0);
    const child = agentId(3, 5);
    const changed = changedBy(mountRows(), () =>
      useSubagents.getState().applySummaries(tabIds[3], SESSION, [{
        agentId: child, isWorkflow: false, workflowRunId: null, mtimeMs: 1, outcome: "none",
        agentType: "Explore", description: null, model: null, toolUseId: null, spawnDepth: 2,
        parentAgentId: parent, requestShape: null, requestNonInteractive: null, workflowPhase: null,
      }]));

    expect(changed.sort()).toEqual([`row ${child}`, `structure ${tabIds[3]}`].sort());
  });
});

// -- Workflow runs -----------------------------------------------------------
//
// A workflow run can start hundreds of agents into one tab. Collapsed, the
// run is one segment of its tab's structure key and one row with its own
// counts selector, so an agent starting or stopping inside it may move that
// run's counts and nothing else: no structure key, no agent row, no header,
// no other tab.
describe("workflow runs (bear traps 5, 8)", () => {
  const SESSION = "11111111-2222-4333-8444-555555555555";
  const TABS = 16;
  const AGENTS_PER_TAB = 8;
  const RUN_AGENTS = 300;
  const RUN = "wf_acme1";
  const RUN_TAB = 5;
  const tabIds = Array.from({ length: TABS }, (_, i) => `task-${i}-a`);
  const taskOf = (tabId: string) => tabId.slice(0, -2);
  const agentId = (tab: number, n: number) => `a${tab}x${n}`;
  const runAgentId = (n: number) => `w${n}`;
  const runTabId = tabIds[RUN_TAB];

  type SubagentSelector = (s: ReturnType<typeof useSubagents.getState>) => unknown;

  interface Mounted {
    label: string;
    select: SubagentSelector;
  }

  const placed = (id: string): SubagentSummary => ({
    agentId: id, isWorkflow: true, workflowRunId: RUN, mtimeMs: 1, outcome: "none",
    agentType: WORKFLOW_AGENT_TYPE, description: null, model: null, toolUseId: null, spawnDepth: 1,
    parentAgentId: null, requestShape: null, requestNonInteractive: null, workflowPhase: "Build",
  });

  /** The 16 by 8 sidebar of the rows block, plus the run's counts and the
   *  header boolean of one of its agents. The run stays collapsed. */
  function mountRows(): Mounted[] {
    const mounted: Mounted[] = [];
    tabIds.forEach((tabId, t) => {
      mounted.push({ label: `structure ${tabId}`, select: createSubagentStructureSelector(tabId) });
      mounted.push({ label: `header ${tabId}`, select: s => hasSubagentRow(s.byTab, [tabId], agentId(t, 0)) });
      for (let n = 0; n < AGENTS_PER_TAB; n++) {
        mounted.push({ label: `row ${agentId(t, n)}`, select: selectSubagentRecord(tabId, agentId(t, n)) });
      }
    });
    mounted.push({ label: `run ${RUN}`, select: createWorkflowRunCountsSelector(runTabId, RUN) });
    mounted.push({
      label: `header ${runAgentId(0)}`,
      select: s => hasSubagentRow(s.byTab, [runTabId], runAgentId(0)),
    });
    return mounted;
  }

  function changedBy(mounted: Mounted[], write: () => void): string[] {
    const snap = mounted.map(m => m.select(useSubagents.getState()));
    const changed: string[] = [];
    const unsub = useSubagents.subscribe(state => {
      mounted.forEach((m, i) => {
        const next = m.select(state);
        if (!Object.is(next, snap[i])) { changed.push(m.label); snap[i] = next; }
      });
    });

    write();
    unsub();
    return changed;
  }

  beforeEach(() => {
    useSubagents.setState({ byTab: {} });
    useApp.setState({ tabs: Object.fromEntries(tabIds.map(id => [taskOf(id), [tab(id)]])) });
    tabIds.forEach((tabId, t) => {
      for (let n = 0; n < AGENTS_PER_TAB; n++) {
        useSubagents.getState().start(taskOf(tabId), tabId, SESSION, agentId(t, n), "Explore");
      }
    });

    const runIds = Array.from({ length: RUN_AGENTS }, (_, n) => runAgentId(n));
    for (const id of runIds) {
      useSubagents.getState().start(taskOf(runTabId), runTabId, SESSION, id, WORKFLOW_AGENT_TYPE);
    }
    useSubagents.getState().applySummaries(runTabId, SESSION, runIds.map(placed));
  });

  it("the run is drawn as one collapsed segment of its tab's key", () => {
    const key = createSubagentStructureSelector(runTabId)(useSubagents.getState());

    expect(key.startsWith(`run:${RUN};`)).toBe(true);
    expect(key).not.toContain(runAgentId(0));
    expect(createWorkflowRunCountsSelector(runTabId, RUN)(useSubagents.getState())).toBe(`${RUN_AGENTS}/${RUN_AGENTS}/0`);
  });

  it("an agent starting in a collapsed run reaches only that run's counts", () => {
    const late = runAgentId(RUN_AGENTS);
    const changed = changedBy(mountRows(), () => {
      useSubagents.getState().start(taskOf(runTabId), runTabId, SESSION, late, WORKFLOW_AGENT_TYPE);
      useSubagents.getState().applySummaries(runTabId, SESSION, [placed(late)]);
    });

    expect(changed).toEqual([`run ${RUN}`]);
  });

  it("an agent stopping in a collapsed run reaches only that run's counts", () => {
    const changed = changedBy(mountRows(), () =>
      useSubagents.getState().stop(runTabId, runAgentId(42), "unknown"));

    expect(changed).toEqual([`run ${RUN}`]);
    expect(useSubagents.getState().byTab[runTabId].agents[runAgentId(42)].state).toBe("unknown");
  });

  it("a plain agent finishing beside the run still reaches only its own row", () => {
    const changed = changedBy(mountRows(), () =>
      useSubagents.getState().stop(runTabId, agentId(RUN_TAB, 3), "done"));

    expect(changed).toEqual([`row ${agentId(RUN_TAB, 3)}`]);
  });
});

// -- Subagent settings -------------------------------------------------------
//
// Settings > Tasks > Claude subagents. A pref write lands on usePrefs, so it
// must wake nothing on useApp, and only the components that draw subagents
// (SubagentRows, SubagentGroupToggle, SubagentPane) may select those prefs.
describe("subagent settings (bear traps 5, 8)", () => {
  const SESSION = "11111111-2222-4333-8444-555555555555";

  /** Every subagent pref except the master toggle, flipped and flipped
   *  back, so each write is a real change. */
  const prefWrite = (i: number) => {
    const on = i % 2 === 1;
    const prefs = usePrefs.getState();
    switch (Math.floor(i / 2) % 8) {
      case 0: prefs.setSubagentTypeFilter("builtIn", on); break;
      case 1: prefs.setSubagentTypeFilter("custom", on); break;
      case 2: prefs.setSubagentRetention(on ? "session" : "hour"); break;
      case 3: prefs.setSubagentAutoCollapse(on ? "never" : "always"); break;
      case 4: prefs.setSubagentViewShowThinking(on); break;
      case 5: prefs.setSubagentViewShowToolOutputs(!on); break;
      case 6: prefs.setSubagentViewTruncateLines(on ? 40 : 3); break;
      case 7: prefs.setSubagentViewAutoScroll(on); break;
    }
  };

  beforeEach(() => {
    const seeded = Array.from({ length: SUBSCRIBERS }, (_, i) => `task-${i}`);
    useApp.setState({ tabs: Object.fromEntries(seeded.map(id => [id, [tab(`${id}-a`)]])) });
    useSubagents.setState({ byTab: {} });
    useSubagents.getState().start("task-0", "task-0-a", SESSION, "a1", "Explore");
  });

  it("a subagent pref write invalidates no useApp selector, sidebar body, row or status fact", () => {
    const taskIds = Object.keys(useApp.getState().tabs);
    const subs = [
      createSidebarFactsSelector(),
      createStatusFactsSelector(),
      ...taskIds.map(id => createRowTabsSelector(id)),
      ...taskIds.map(id => selectTaskTabs(id)),
    ];
    let prefWakes = 0;
    const unsub = usePrefs.subscribe(() => { prefWakes++; });

    const r = measureFanout(subs, 16, prefWrite);
    unsub();

    // Not vacuous: every write was a real change to the prefs store.
    expect(prefWakes).toBe(16);
    expect(r.invalidations).toBe(0);
    expect(r.selectorRuns).toBe(0);
  });

  it("only the master toggle touches the subagent store", () => {
    let storeWakes = 0;
    const unsub = useSubagents.subscribe(() => { storeWakes++; });
    for (let i = 0; i < 16; i++) prefWrite(i);
    unsub();

    expect(storeWakes).toBe(0);
  });

  it("no sidebar component outside the subagent rows selects a subagent pref", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const sidebar = readFileSync(resolve(here, "../components/sidebar/Sidebar.tsx"), "utf8");
    const rows = readFileSync(resolve(here, "../components/sidebar/SubagentRows.tsx"), "utf8");

    expect(sidebar).not.toMatch(/s\.subagent[A-Z]\w*/);
    expect(rows).toMatch(/usePrefs\(s => s\.subagentTypeFilter\)/);
  });

  it("the task header asks the filter-aware hook, not the bare predicate", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const sidebar = readFileSync(resolve(here, "../components/sidebar/Sidebar.tsx"), "utf8");

    expect(sidebar).toMatch(/useSubagentHasRow\(terminalTabIds, activeSubagentId\)/);
    expect(sidebar).not.toMatch(/hasSubagentRow\(/);
  });
});
