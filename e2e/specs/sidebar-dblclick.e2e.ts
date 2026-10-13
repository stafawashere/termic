// Double-clicking a parent row in the sidebar (a project, a task with tabs, a
// task group's caption) folds or unfolds it, and renaming a group lives in its
// context menu. A double-click arrives as click, click, dblclick, so each
// case pins the NET result: one toggle, never zero and never two. The events
// of a double-click all fire before the action returns, so a stray extra
// toggle has landed by the time the state is read and needs no timed wait.
//
// A leaf tab row still renames on a double-click (the negative), a single
// click on a task only selects, and an open rename input blocks the toggle.

import {
  archiveTask,
  clickMenuItem,
  dismissOverlays,
  openTask,
  requireTermicApi,
  snap,
  waitForAppShell,
  waitVisible,
} from "../helpers.js";

const PROJECT_NAME = '[data-project-id] span.truncate';
const TASK_HEADER = (id: string) => `[data-sidebar-task-id="${id}"]`;
const GROUP_CAPTION = (id: string) => `[data-testid="task-group-header-${id}"]`;
const GROUP_TOGGLE = (id: string) => `[data-testid="task-group-toggle-${id}"]`;
const INLINE_INPUT = ".sidebar-inline-input";
const GROUP_RENAME = (id: string) => `[data-testid="task-group-rename-${id}"]`;

const fixtureId = () => browser.execute(() =>
  window.__termic!.useApp.getState().projects.find((p: any) => p.name === "fixture-repo").id) as Promise<string>;
const projectOpen = (pid: string) => browser.execute(id =>
  document.querySelector(`[data-project-id="${id}"]`)?.getAttribute("data-open") === "true", pid);
const taskFold = (id: string) => browser.execute(tid =>
  window.__termic!.useApp.getState().collapsedTasks[tid] ?? null, id) as Promise<boolean | null>;
const groupExpanded = (gid: string) => browser.execute(id =>
  document.querySelector(`[data-testid="task-group-toggle-${id}"]`)?.getAttribute("aria-expanded") === "true", gid);
const count = (sel: string) => browser.execute(s => document.querySelectorAll(s).length, sel);

/** The full browser sequence for a double-click: click, click, dblclick, with
 *  the pointer and mouse events a real one fires and `detail` counting up. The
 *  WebDriver double-click did not produce a dblclick in this window (a leaf
 *  tab's rename, which already listens for it, never opened either). */
async function doubleClick(sel: string): Promise<void> {
  await waitVisible(sel);
  await browser.execute(async s => {
    const el = document.querySelector(s) as HTMLElement;
    const r = el.getBoundingClientRect();
    const base = { bubbles: true, cancelable: true, button: 0, clientX: r.left + 6, clientY: r.top + 6 };
    for (const detail of [1, 2]) {
      el.dispatchEvent(new PointerEvent("pointerdown", { ...base, pointerId: 1 }));
      el.dispatchEvent(new MouseEvent("mousedown", { ...base, detail }));
      el.dispatchEvent(new PointerEvent("pointerup", { ...base, pointerId: 1 }));
      el.dispatchEvent(new MouseEvent("mouseup", { ...base, detail }));
      el.dispatchEvent(new MouseEvent("click", { ...base, detail }));
      // Each click is its own task in a real double-click, so React has
      // committed the first toggle before the second handler runs.
      await new Promise(done => setTimeout(done, 0));
    }
    el.dispatchEvent(new MouseEvent("dblclick", { ...base, detail: 2 }));
  }, sel);
}

describe("sidebar double-click on parent rows", () => {
  let pid = "";
  let taskId = "";
  let leadId = "";
  let memberId = "";
  let groupId = "";

  before(async () => {
    await waitForAppShell();
    await requireTermicApi();
    await dismissOverlays();
    await browser.execute(() => {
      const t = window.__termic!;
      t.usePrefs.getState().setTaskExpandMode("chevron");
    });
    pid = await fixtureId();
    taskId = await openTask("dblclick-task", true);
    leadId = await openTask("dblclick-group-lead", false);
    memberId = await openTask("dblclick-group-member", false);
    groupId = await browser.execute(async (a, b) => {
      const t = window.__termic!;
      await t.invoke("task_group_new", { taskId: a, color: "teal" });
      await t.invoke("task_group_join", { taskId: b, targetId: a, color: null });
      await t.useApp.getState().loadAll();
      return t.useApp.getState().tasks.find((w: any) => w.id === a).group.id as string;
    }, leadId, memberId);
    await browser.execute(id => window.__termic!.useApp.getState().setActiveTask(id), taskId);
    await waitVisible(TASK_HEADER(taskId));
  });

  after(async () => {
    for (const id of [taskId, leadId, memberId]) if (id) await archiveTask(id);
  });

  it("a double-click on a project row folds it, the next one unfolds it", async () => {
    await browser.execute(id => window.__termic!.useApp.getState().setProjectCollapsed(id, false), pid);
    await browser.waitUntil(() => projectOpen(pid), { timeout: 4_000, timeoutMsg: "project never opened" });

    await doubleClick(PROJECT_NAME);
    await browser.waitUntil(async () => !(await projectOpen(pid)), { timeout: 4_000, timeoutMsg: "double-click did not fold" });
    expect(await projectOpen(pid)).toBe(false);

    await doubleClick(PROJECT_NAME);
    await browser.waitUntil(() => projectOpen(pid), { timeout: 4_000, timeoutMsg: "double-click did not unfold" });
    expect(await projectOpen(pid)).toBe(true);
    expect(await count(`[data-project-id="${pid}"] ${INLINE_INPUT}`)).toBe(0);
  });

  it("a single click on a task row selects it and never toggles its fold", async () => {
    await browser.execute(id => window.__termic!.useApp.getState().setTaskCollapsed(id, true), taskId);
    await (await $(TASK_HEADER(taskId))).click();
    expect(await taskFold(taskId)).toBe(true);
    expect(await browser.execute(() => window.__termic!.useApp.getState().activeTaskId)).toBe(taskId);
  });

  it("a double-click on a task with tabs unfolds it, then folds it", async () => {
    await browser.waitUntil(
      async () => (await count(`${TASK_HEADER(taskId)} button[aria-expanded], ${TASK_HEADER(taskId)} button[aria-label]`)) > 0,
      { timeout: 15_000, timeoutMsg: "task never grew a tab chevron" },
    );
    await doubleClick(TASK_HEADER(taskId));
    await browser.waitUntil(async () => (await taskFold(taskId)) === false, { timeout: 4_000, timeoutMsg: "double-click did not unfold" });
    expect(await taskFold(taskId)).toBe(false);
    await snap("dblclick-task-expanded");

    await doubleClick(TASK_HEADER(taskId));
    await browser.waitUntil(async () => (await taskFold(taskId)) === true, { timeout: 4_000, timeoutMsg: "double-click did not fold" });
    expect(await taskFold(taskId)).toBe(true);
    expect(await count(`${TASK_HEADER(taskId)} ${INLINE_INPUT}`)).toBe(0);
  });

  it("a double-click on a leaf tab row still renames it and leaves the task's fold alone", async () => {
    await browser.execute(id => window.__termic!.useApp.getState().setTaskCollapsed(id, false), taskId);
    const tabSel = await browser.execute(id => {
      const tab = (window.__termic!.useApp.getState().tabs[id] ?? []).find((t: any) => t.type === "terminal");
      return `[data-sidebar-tab-id="${tab.id}"]`;
    }, taskId);
    await waitVisible(tabSel);
    await doubleClick(tabSel);
    await waitVisible(`${tabSel} ${INLINE_INPUT}`);
    expect(await taskFold(taskId)).toBe(false);
    await browser.keys("Escape");
  });

  it("a double-click on a task row with a rename input open does not toggle it", async () => {
    await browser.execute(id => window.__termic!.useApp.getState().setTaskCollapsed(id, true), taskId);
    await browser.execute(() => window.__termic!.useUI.setState({
      renameRequest: { taskId: window.__termic!.useApp.getState().activeTaskId, nonce: Date.now() },
    }));
    await waitVisible(`${TASK_HEADER(taskId)} ${INLINE_INPUT}`);
    await doubleClick(`${TASK_HEADER(taskId)} ${INLINE_INPUT}`);
    expect(await taskFold(taskId)).toBe(true);
    expect(await count(`${TASK_HEADER(taskId)} ${INLINE_INPUT}`)).toBe(1);
    await browser.keys("Escape");
  });

  it("a double-click on a task group caption toggles it once and opens no rename input", async () => {
    await waitVisible(GROUP_CAPTION(groupId));
    const start = await groupExpanded(groupId);

    await doubleClick(GROUP_CAPTION(groupId));
    await browser.waitUntil(async () => (await groupExpanded(groupId)) === !start, { timeout: 4_000, timeoutMsg: "caption double-click did not toggle" });
    expect(await groupExpanded(groupId)).toBe(!start);
    expect(await count(GROUP_RENAME(groupId))).toBe(0);
    await snap("dblclick-group-toggled");

    await doubleClick(GROUP_CAPTION(groupId));
    await browser.waitUntil(async () => (await groupExpanded(groupId)) === start, { timeout: 4_000, timeoutMsg: "second double-click did not toggle back" });
    expect(await groupExpanded(groupId)).toBe(start);
  });

  it("a single click on the caption toggles once, and the chevron button toggles once", async () => {
    const start = await groupExpanded(groupId);
    await (await $(GROUP_CAPTION(groupId))).click();
    await browser.waitUntil(async () => (await groupExpanded(groupId)) === !start, { timeout: 4_000 });
    await (await $(GROUP_TOGGLE(groupId))).click();
    await browser.waitUntil(async () => (await groupExpanded(groupId)) === start, { timeout: 4_000 });
  });

  it("Rename group in the caption's context menu opens the inline input", async () => {
    await waitVisible(GROUP_CAPTION(groupId));
    await browser.execute(sel => {
      const el = document.querySelector(sel) as HTMLElement;
      const r = el.getBoundingClientRect();
      el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: r.left + 6, clientY: r.top + 6 }));
    }, GROUP_CAPTION(groupId));
    await browser.waitUntil(
      () => browser.execute(() => !![...document.querySelectorAll("[role='menuitem']")].find(e => e.textContent?.trim() === "Rename group")),
      { timeout: 4_000, timeoutMsg: "context menu never offered Rename group" },
    );
    await clickMenuItem("Rename group");
    await waitVisible(GROUP_RENAME(groupId));
    await snap("dblclick-group-rename-from-menu");
    await browser.keys("Escape");
  });
});
