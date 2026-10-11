// The subagent transcript view: a sidebar subagent row opens a live,
// read-only transcript of that agent in the task's preview slot.
//
// Rows come from `#subagent start` through the fake agent, exactly as in
// subagent-rows.e2e.ts. The transcripts are synthetic JSONL the spec writes
// straight into the session's subagents/ dir under the profile's claude
// config: the view's tail has to pick up a write from another process, which
// is what claude is, and the claude terminal is not on screen while the view
// is, so the fake agent's stdin directives cannot reach it then.

import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { dataDir } from "../../wdio.conf.js";
import {
  archiveTask,
  clickPresent,
  clickWhenVisible,
  openTask,
  requireTermicApi,
  setHooksOwnState,
  setWindowPresence,
  snap,
  submitToAgent,
  textOf,
  waitForAgentReady,
  waitForAppShell,
  waitGone,
  waitPtyQuiet,
  waitVisible,
} from "../helpers.js";

const CLI = "fakeclaude";
const CONFIG_DIR = path.join(dataDir, "e2e-subagent-view-claude");
const PANE = '[data-testid="subagent-pane"]';
const ENTRY = '[data-testid="subagent-entry"]';

const line = (value: unknown) => JSON.stringify(value);
const userText = (text: string) => line({ type: "user", message: { role: "user", content: text } });
const assistantText = (text: string) =>
  line({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });
const THINKING = line({
  type: "assistant",
  message: { content: [{ type: "thinking", thinking: "weighing the options" }, { type: "redacted_thinking", data: "opaque" }] },
});
const TOOL_CALL = line({
  type: "assistant",
  message: {
    content: [{ type: "tool_use", id: "toolu_e2e", name: "Read", input: { file_path: "/Users/u/dev/acme/README.md" } }],
    stop_reason: "tool_use",
  },
});
const TOOL_RESULT = line({
  type: "user",
  message: { content: [{ type: "tool_result", tool_use_id: "toolu_e2e", content: "hello from acme" }] },
});
const COMPACT = line({ type: "system", subtype: "compact_boundary", content: "Conversation compacted" });

describe("subagent transcript view", () => {
  let taskId!: string;
  let parentTabId!: string;
  let sessionId!: string;
  let subagentsDir!: string;
  let archived = false;
  let originalEnv: Record<string, string> | null = null;

  const rowSelector = (agentId: string) =>
    `[data-sidebar-task-row="${taskId}"] [data-testid="subagent-row"][data-agent-id="${agentId}"]`;
  const paneSelector = (agentId: string) => `${PANE}[data-agent-id="${agentId}"]`;
  const transcriptFile = (agentId: string) => path.join(subagentsDir, `agent-${agentId}.jsonl`);

  function writeTranscript(agentId: string, lines: string[]): void {
    mkdirSync(subagentsDir, { recursive: true });
    writeFileSync(transcriptFile(agentId), lines.map(entry => `${entry}\n`).join(""));
  }

  function appendTranscript(agentId: string, entry: string): void {
    appendFileSync(transcriptFile(agentId), `${entry}\n`);
  }

  async function parentToFront(): Promise<void> {
    await browser.execute(
      (task, tab) => window.__termic!.useApp.getState().setActiveTabId(task, tab),
      taskId,
      parentTabId,
    );
  }

  /** Start a subagent through the hook path and wait for its row. */
  async function startAgent(agentId: string, agentType = "general-purpose"): Promise<void> {
    await parentToFront();
    await submitToAgent(taskId, `#subagent start ${sessionId} ${agentId} ${agentType}`);
    await waitVisible(rowSelector(agentId), 10_000);
  }

  async function openFromRow(agentId: string): Promise<void> {
    await clickPresent(rowSelector(agentId));
    await waitStatus(agentId, "live");
  }

  async function paneFacts(agentId: string) {
    return browser.execute((sel, entrySel) => {
      const pane = document.querySelector<HTMLElement>(sel);
      if (!pane) return null;
      const entries = [...pane.querySelectorAll<HTMLElement>(entrySel)];
      return {
        status: pane.getAttribute("data-subagent-status"),
        start: Number(pane.getAttribute("data-transcript-start")),
        count: Number(pane.getAttribute("data-entry-count")),
        visible: pane.getBoundingClientRect().height > 0,
        mounted: entries.length,
        kinds: entries.map(el => el.getAttribute("data-entry-kind")),
        texts: entries.map(el => el.textContent ?? ""),
        hasTerminal: !!pane.querySelector(".xterm, canvas"),
      };
    }, paneSelector(agentId), ENTRY);
  }

  async function waitStatus(agentId: string, status: string): Promise<void> {
    await browser.waitUntil(async () => (await paneFacts(agentId))?.status === status, {
      timeout: 10_000,
      interval: 50,
      timeoutMsg: `the view of ${agentId} never reached ${status}: ${JSON.stringify(await paneFacts(agentId))}`,
    });
  }

  async function subagentTabs(): Promise<Array<{ id: string; agentId: string; preview: boolean }>> {
    return browser.execute(
      (task) => (window.__termic!.useApp.getState().tabs[task] ?? [])
        .filter((t: any) => t.type === "subagent")
        .map((t: any) => ({ id: t.id, agentId: t.subagentAgentId, preview: !!t.preview })),
      taskId,
    );
  }

  async function activeTabId(): Promise<string> {
    return browser.execute((task) => window.__termic!.useApp.getState().activeTab[task], taskId);
  }

  before(async function () {
    this.timeout(120_000);
    await waitForAppShell();
    await requireTermicApi();
    rmSync(CONFIG_DIR, { recursive: true, force: true });

    originalEnv = await browser.execute(async (cli, dir) => {
      const t = window.__termic!;
      const agents = (await t.invoke("settings_load")).agents;
      const own = agents.find((a: any) => a.id === cli);
      const before = { ...(own?.env ?? {}) };
      const next = agents.map((a: any) =>
        a.id === cli ? { ...a, env: { ...a.env, CLAUDE_CONFIG_DIR: dir } } : a);
      await t.invoke("agents_save", { agents: next });
      await t.useApp.getState().loadAll();
      return before;
    }, CLI, CONFIG_DIR);

    await setHooksOwnState(CLI, true);
    await setWindowPresence(false);
    taskId = await openTask("e2e-subagent-view", true, CLI);
    await waitForAgentReady(taskId);

    await browser.waitUntil(async () => {
      const held = await browser.execute(
        (id) => (window.__termic!.useApp.getState().tabs[id] ?? [])[0]?.sessionId ?? null,
        taskId,
      );
      if (held) return true;
      await submitToAgent(taskId, "#usage usage 10 10 - -");
      return false;
    }, { timeout: 20_000, interval: 1_000, timeoutMsg: "the fakeclaude tab never held a session id" });
    await waitPtyQuiet(taskId, 2_000);

    const facts = await browser.execute((id) => {
      const s = window.__termic!.useApp.getState();
      const task = s.tasks.find((x: any) => x.id === id);
      const tab = s.tabs[id][0];
      return { tabId: tab.id as string, sessionId: tab.sessionId as string, taskPath: task.path as string };
    }, taskId);
    parentTabId = facts.tabId;
    sessionId = facts.sessionId;
    const slug = facts.taskPath.replace(/[^A-Za-z0-9]/g, "-");
    subagentsDir = path.join(CONFIG_DIR, "projects", slug, sessionId, "subagents");

    await browser.execute((id) => window.__termic!.useApp.getState().setTaskCollapsed(id, false), taskId);
  });

  after(async () => {
    if (originalEnv) {
      await browser.execute(async (cli, env) => {
        const t = window.__termic!;
        const agents = (await t.invoke("settings_load")).agents.map((a: any) =>
          a.id === cli ? { ...a, env } : a);
        await t.invoke("agents_save", { agents });
        await t.useApp.getState().loadAll();
      }, CLI, originalEnv);
    }
    await setHooksOwnState(CLI, false);
    await setWindowPresence(true);
    if (taskId && !archived) await archiveTask(taskId);
    rmSync(CONFIG_DIR, { recursive: true, force: true });
  });

  it("opens a row's transcript in the preview slot, in file order, without a terminal", async function () {
    this.timeout(60_000);
    const agentId = "e2eview1";
    writeTranscript(agentId, [userText("look around acme"), THINKING, TOOL_CALL, TOOL_RESULT, assistantText("all done")]);
    await startAgent(agentId);

    await openFromRow(agentId);
    const facts = (await paneFacts(agentId))!;
    expect(facts.visible).toBe(true);
    expect(facts.hasTerminal).toBe(false);
    expect(facts.kinds).toEqual([
      "userText", "thinking", "redactedThinking", "toolUse", "toolResult", "assistantText",
    ]);
    expect(facts.texts[3]).toContain("Read");
    expect(facts.texts[3]).toContain("/Users/u/dev/acme/README.md");
    expect(facts.texts[4]).toContain("hello from acme");
    expect(facts.texts[2]).not.toContain("opaque");

    const tabs = await subagentTabs();
    expect(tabs).toEqual([{ id: tabs[0].id, agentId, preview: true }]);
    expect(await activeTabId()).toBe(tabs[0].id);
    // The row of the agent in view carries the selection.
    const rowClass = await browser.execute((sel) => document.querySelector(sel)?.className ?? "", rowSelector(agentId));
    expect(rowClass).toContain("bg-[var(--color-sel)]");
    await snap("subagent-view-open.png");
  });

  it("shows a line appended to the transcript without a reload", async function () {
    this.timeout(30_000);
    const agentId = "e2eview1";
    appendTranscript(agentId, assistantText("a live line"));

    await browser.waitUntil(async () => (await paneFacts(agentId))!.texts.some(text => text.includes("a live line")), {
      timeout: 10_000,
      interval: 50,
      timeoutMsg: "the appended line never reached the open view",
    });
    expect((await paneFacts(agentId))!.count).toBe(7);
    await snap("subagent-view-live-tail.png");
  });

  it("draws a compaction as a divider and keeps the entries after it", async function () {
    this.timeout(30_000);
    const agentId = "e2eview1";
    appendTranscript(agentId, COMPACT);
    appendTranscript(agentId, assistantText("after compaction"));

    const divider = `${paneSelector(agentId)} [data-testid="subagent-compact-divider"]`;
    await waitVisible(divider, 10_000);
    await browser.waitUntil(async () => (await paneFacts(agentId))!.texts.some(text => text.includes("after compaction")), {
      timeout: 10_000,
      timeoutMsg: "the entry after the compaction never arrived",
    });
    const kinds = (await paneFacts(agentId))!.kinds;
    expect(kinds.slice(-2)).toEqual(["compactBoundary", "assistantText"]);
    expect(await textOf(divider)).toContain("Conversation compacted");
    await snap("subagent-view-compacted.png");
  });

  it("mounts only the rows near the viewport, and loads earlier entries without moving the view", async function () {
    this.timeout(60_000);
    const agentId = "e2ebulk1";
    writeTranscript(agentId, Array.from({ length: 600 }, (_, index) => assistantText(`entry ${index}`)));
    await startAgent(agentId);
    await openFromRow(agentId);

    const first = (await paneFacts(agentId))!;
    expect(first.start).toBe(100);
    expect(first.count).toBe(500);
    expect(first.mounted).toBeGreaterThan(0);
    expect(first.mounted).toBeLessThan(150);
    expect(first.texts[first.texts.length - 1]).toContain("entry 599");

    // Scroll to the top of the first page, so the view is anchored on entry
    // 100 rather than following the tail.
    await browser.execute((sel) => {
      const scroller = document.querySelector(`${sel} [data-testid="subagent-scroller"]`) as HTMLElement;
      scroller.scrollTop = 0;
      scroller.dispatchEvent(new Event("scroll"));
    }, paneSelector(agentId));
    await waitVisible(`${paneSelector(agentId)} [data-testid="subagent-jump-latest"]`, 5_000);

    const anchorTop = () => browser.execute((sel) => {
      const scroller = document.querySelector(`${sel} [data-testid="subagent-scroller"]`) as HTMLElement;
      const row = scroller.querySelector('[data-entry-index="100"]') as HTMLElement | null;
      return row ? row.getBoundingClientRect().top - scroller.getBoundingClientRect().top : null;
    }, paneSelector(agentId));
    // The virtualizer mounts the rows at the new offset on the render after
    // the scroll event, so wait for entry 100 rather than reading it at once.
    await browser.waitUntil(async () => (await anchorTop()) !== null, {
      timeout: 5_000,
      timeoutMsg: "entry 100 never mounted at the top of the first page",
    });
    const before = await anchorTop();
    expect(before).not.toBeNull();

    await clickWhenVisible(`${paneSelector(agentId)} [data-testid="subagent-load-earlier"]`);
    await browser.waitUntil(async () => (await paneFacts(agentId))!.start === 0, {
      timeout: 10_000,
      timeoutMsg: "load earlier never prepended the first page",
    });
    const after = await anchorTop();
    expect(after).not.toBeNull();
    expect(Math.abs(after! - before!)).toBeLessThanOrEqual(2);

    const widened = (await paneFacts(agentId))!;
    expect(widened.count).toBe(600);
    expect(widened.mounted).toBeLessThan(150);
    await waitGone(`${paneSelector(agentId)} [data-testid="subagent-load-earlier"]`, 5_000);
    await snap("subagent-view-load-earlier.png");

    await clickWhenVisible(`${paneSelector(agentId)} [data-testid="subagent-jump-latest"]`);
    await browser.waitUntil(async () => (await paneFacts(agentId))!.texts.some(text => text.includes("entry 599")), {
      timeout: 5_000,
      timeoutMsg: "jump to latest did not bring the tail back",
    });
  });

  it("recycles the preview slot for a second row, and a pinned view stays put", async function () {
    this.timeout(30_000);
    const viewTabs = await subagentTabs();
    expect(viewTabs).toHaveLength(1);
    const slotId = viewTabs[0].id;
    expect(viewTabs[0].agentId).toBe("e2ebulk1");

    await openFromRow("e2eview1");
    const recycled = await subagentTabs();
    expect(recycled).toEqual([{ id: slotId, agentId: "e2eview1", preview: true }]);

    // A double-click on the pill is what pins a preview tab.
    await browser.execute((sel) => {
      document.querySelector(sel)!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    }, `div[data-tab-id="${slotId}"]`);
    await browser.waitUntil(async () => (await subagentTabs())[0]?.preview === false, {
      timeout: 5_000,
      timeoutMsg: "double-clicking the pill never pinned the view",
    });

    await openFromRow("e2ebulk1");
    const both = await subagentTabs();
    expect(both.map(t => [t.agentId, t.preview])).toEqual([["e2eview1", false], ["e2ebulk1", true]]);
    expect(both[0].id).toBe(slotId);
    await snap("subagent-view-pinned-and-preview.png");
  });

  it("shows an expired transcript instead of an error when the file goes away", async function () {
    this.timeout(30_000);
    const agentId = "e2ebulk1";
    // The recycle case above reopened this view, so it holds the newest page
    // again rather than all 600 entries.
    const read = (await paneFacts(agentId))!.count;
    expect(read).toBeGreaterThan(0);
    rmSync(transcriptFile(agentId), { force: true });

    await waitStatus(agentId, "expired");
    const banner = `${paneSelector(agentId)} [data-testid="subagent-expired"]`;
    await waitVisible(banner, 5_000);
    expect(await textOf(banner)).toContain("Transcript expired");

    // What was already read stays on screen under the banner.
    const facts = (await paneFacts(agentId))!;
    expect(facts.count).toBe(read);
    expect(facts.mounted).toBeGreaterThan(0);
    await snap("subagent-view-expired.png");
  });

  it("closes every subagent view when the task is archived", async function () {
    this.timeout(30_000);
    expect((await subagentTabs()).length).toBeGreaterThan(0);

    await archiveTask(taskId);
    archived = true;

    await browser.waitUntil(async () => (await subagentTabs()).length === 0, {
      timeout: 10_000,
      timeoutMsg: "archiving left subagent tabs open",
    });
    await waitGone(PANE, 10_000);
  });
});
