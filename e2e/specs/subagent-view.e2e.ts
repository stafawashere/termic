// The subagent transcript view: a sidebar subagent row opens a live,
// read-only transcript of that agent in the task's preview slot.
//
// Rows come from `#subagent start` through the fake agent, exactly as in
// subagent-rows.e2e.ts. The transcripts are synthetic JSONL the spec writes
// straight into the session's subagents/ dir under the profile's claude
// config: the view's tail has to pick up a write from another process, which
// is what claude is, and the claude terminal is not on screen while the view
// is, so the fake agent's stdin directives cannot reach it then.

import { Key } from "webdriverio";
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
  let taskPath!: string;
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

  // The cases below were written against folded groups with every input
  // and output shown, so they pin those view defaults and forget any view
  // a previous run's bar remembered.
  async function setViewDefaults(written: boolean): Promise<void> {
    await browser.execute((pinned) => {
      const p = window.__termic!.usePrefs.getState();
      p.setSubagentViewVerbose(!pinned);
      p.setSubagentViewShowToolInputs(pinned);
      p.setSubagentViewShowToolOutputs(pinned);
      p.setSubagentViewTruncateLines(pinned ? 40 : 100);
      localStorage.removeItem("subagentViewConfigs");
    }, written);
  }

  before(async function () {
    this.timeout(120_000);
    await waitForAppShell();
    await requireTermicApi();
    await setViewDefaults(true);
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
    taskPath = facts.taskPath;
    const slug = facts.taskPath.replace(/[^A-Za-z0-9]/g, "-");
    subagentsDir = path.join(CONFIG_DIR, "projects", slug, sessionId, "subagents");

    await browser.execute((id) => window.__termic!.useApp.getState().setTaskCollapsed(id, false), taskId);
  });

  after(async () => {
    await setViewDefaults(false);
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
    // As in Claude Code, the thinking and the tool call fold into one
    // summary line until it is clicked.
    expect(facts.kinds).toEqual(["userText", "group", "assistantText"]);
    expect(facts.texts[1]).toMatch(/^Thought for \d+s, read 1 file$/);

    await clickWhenVisible(`${paneSelector(agentId)} [data-testid="subagent-group"]`);
    const members = () => browser.execute((sel) =>
      [...document.querySelectorAll<HTMLElement>(`${sel} [data-testid="subagent-group-member"]`)]
        .map(el => [el.getAttribute("data-entry-kind"), el.textContent ?? ""]), paneSelector(agentId));
    await browser.waitUntil(async () => (await members()).length === 3, {
      timeout: 5_000,
      timeoutMsg: "clicking the summary line never unfolded the group",
    });
    const unfolded = await members();
    // The result answers the call by id, so it hangs under the call's row
    // instead of drawing as a row of its own.
    expect(unfolded.map(([kind]) => kind)).toEqual(["thinking", "redactedThinking", "toolUse"]);
    expect(unfolded[2][1]).toContain("Read");
    expect(unfolded[2][1]).toContain("/Users/u/dev/acme/README.md");
    expect(unfolded[2][1]).toContain("Read 1 line");
    expect(unfolded[1][1]).not.toContain("opaque");

    const tabs = await subagentTabs();
    expect(tabs).toEqual([{ id: tabs[0].id, agentId, preview: true }]);
    expect(await activeTabId()).toBe(tabs[0].id);
    // The row of the agent in view carries the selection.
    const rowClass = await browser.execute((sel) => document.querySelector(sel)?.className ?? "", rowSelector(agentId));
    expect(rowClass).toContain("sidebar-selected");
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
    expect((await paneFacts(agentId))!.count).toBe(4);
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

  it("draws the transcript the way Claude Code's terminal does", async function () {
    this.timeout(90_000);
    const agentId = "e2ecli1";
    const pane = paneSelector(agentId);
    const startedAt = Date.now() - 42_000;
    const at = (second: number) => new Date(startedAt + second * 1000).toISOString();
    const config = `${taskPath}/src/config.ts`;

    const call = (second: number, id: string, name: string, input: unknown) => line({
      type: "assistant",
      timestamp: at(second),
      message: {
        model: "claude-test-model",
        usage: { output_tokens: 400 },
        content: [{ type: "tool_use", id, name, input }],
        stop_reason: "tool_use",
      },
    });
    const result = (second: number, id: string, content: string, isError = false) => line({
      type: "user",
      timestamp: at(second),
      message: { content: [{ type: "tool_result", tool_use_id: id, content, is_error: isError }] },
    });
    const said = (second: number, text: string) => line({
      type: "assistant",
      timestamp: at(second),
      message: { model: "claude-test-model", usage: { output_tokens: 300 }, content: [{ type: "text", text }], stop_reason: "end_turn" },
    });
    const readOutput = Array.from({ length: 12 }, (_, n) => `${String(n + 1).padStart(6)}\u2192line ${n + 1}`).join("\n");
    const buildOutput = ["> acme@1.0.0 build", "> vite build", ...Array.from({ length: 38 }, (_, n) => `built chunk ${n}`)].join("\n");
    const editSnippet = [
      `The file ${config} has been updated. Here's the result of running \`cat -n\` on a snippet of the edited file:`,
      "    11\t// acme config",
      "    12\tconst port = 4000",
      "    13\tconst host = \"localhost\"",
    ].join("\n");

    writeTranscript(agentId, [
      line({ type: "user", timestamp: at(0), message: { role: "user", content: "build the acme bundle" } }),
      line({
        type: "assistant",
        timestamp: at(4),
        thinkingDurationMs: 4000,
        message: { content: [{ type: "thinking", thinking: "the port lives in src/config.ts" }] },
      }),
      said(5, "I'll start by **reading** the config.\n\n- check `port`\n- run the build"),
      call(6, "toolu_read", "Read", { file_path: config }),
      result(7, "toolu_read", readOutput),
      call(8, "toolu_build", "Bash", { command: "npm run build" }),
    ]);
    await startAgent(agentId, "general-purpose");
    await openFromRow(agentId);

    const toolStates = () => browser.execute((sel) =>
      [...document.querySelectorAll(`${sel} [data-testid="subagent-tool-state"]`)]
        .map(el => el.getAttribute("data-tool-state")), pane);
    const groups = () => browser.execute((sel) =>
      [...document.querySelectorAll<HTMLElement>(`${sel} [data-testid="subagent-group"]`)]
        .map(el => ({
          text: el.querySelector('[data-testid="subagent-group-summary"]')?.textContent ?? "",
          unfolded: el.getAttribute("data-group-unfolded") === "true",
          blinking: !!el.querySelector(".termic-cli-blink"),
        })), pane);
    const facts = (await paneFacts(agentId))!;
    expect(facts.kinds).toEqual(["userText", "group", "assistantText", "group"]);
    expect(await toolStates()).toEqual([]);
    // A finished group is dim with no bullet; the running one keeps a
    // blinking bullet and its -ing words, as claude draws them.
    expect(await groups()).toEqual([
      { text: "Thought for 4s", unfolded: false, blinking: false },
      { text: "Reading 1 file, running 1 shell command\u2026", unfolded: false, blinking: true },
    ]);

    const footer = `${pane} [data-testid="subagent-footer"]`;
    await waitVisible(footer, 5_000);
    expect(await browser.execute((sel) => document.querySelector(sel)?.getAttribute("data-footer-state"), footer)).toBe("running");
    const footerText = (await textOf(footer)).replace(/\s+/g, " ");
    expect(footerText).toContain("Working\u2026");
    expect(footerText).toContain("general-purpose Bash(npm run build)");
    expect(await textOf(`${pane} [data-testid="subagent-spinner-suffix"]`)).toMatch(/^\(\d+s \u00B7 \u2193 1\.1k tokens\)$/);

    // The spinner row is claude-coloured, its glyph runs the cosine strip,
    // and while a tool runs the message pulses instead of shimmering.
    const spinner = () => browser.execute((sel) => {
      const root = document.querySelector<HTMLElement>(sel)!;
      const row = root.querySelector<HTMLElement>('[data-testid="subagent-working"]')!;
      const message = root.querySelector<HTMLElement>('[data-testid="subagent-spinner-message"]')!;
      const shimmer = root.querySelector<HTMLElement>('[data-testid="subagent-shimmer"]');
      return {
        rowColor: getComputedStyle(row).color,
        glyphAnimation: getComputedStyle(root.querySelector<HTMLElement>('[data-testid="subagent-spinner-glyph"]')!).animationName,
        messageAnimation: getComputedStyle(message).animationName,
        messageColor: getComputedStyle(message).color,
        shimmerAnimation: shimmer ? getComputedStyle(shimmer).animationName : null,
        shimmerVisibility: shimmer ? getComputedStyle(shimmer).visibility : null,
      };
    }, pane);
    const pulsing = await spinner();
    expect(pulsing.rowColor).toBe("rgb(215, 119, 87)");
    expect(pulsing.glyphAnimation).toBe("termic-cli-spinner");
    expect(pulsing.messageAnimation).toBe("termic-cli-pulse");
    expect(pulsing.shimmerAnimation).toBeNull();
    expect(await textOf(`${pane} [data-testid="subagent-footer-stats"]`)).toMatch(/^\d+s \u00B7 \u2193 1\.1k tokens$/);
    expect(await textOf(`${pane} [data-testid="subagent-header"]`)).toContain("claude-test-model");

    // The cell grid: an assistant bullet's text starts two cells in, every
    // block sits one blank row under the one above, and the pane draws in
    // claude's dark palette.
    const grid = await browser.execute((sel) => {
      const root = document.querySelector<HTMLElement>(sel)!;
      const style = getComputedStyle(root);
      const cell = parseFloat(style.getPropertyValue("--cell"));
      const row = parseFloat(style.getPropertyValue("--row"));
      const said = root.querySelector<HTMLElement>('[data-entry-kind="assistantText"]')!;
      const expectedBullet = /Mac/i.test(navigator.platform || navigator.userAgent) ? "\u23FA" : "\u25CF";
      const bullet = said.querySelector<HTMLElement>("span[aria-hidden]")!;
      const text = bullet.nextElementSibling as HTMLElement;
      const entries = [...root.querySelectorAll<HTMLElement>('[data-testid="subagent-entry"]')];
      const gaps = entries.slice(1).map((entry, position) => {
        const above = entries[position];
        const content = above.firstElementChild as HTMLElement;
        return entry.getBoundingClientRect().top - content.getBoundingClientRect().bottom;
      });
      return {
        cell,
        row,
        textOffset: text.getBoundingClientRect().left - bullet.getBoundingClientRect().left,
        gaps,
        lineHeight: parseFloat(style.lineHeight),
        fontFamily: style.fontFamily,
        fontSize: style.fontSize,
        fontWeight: style.fontWeight,
        theme: root.getAttribute("data-claude-theme"),
        textColor: getComputedStyle(text).color,
        bulletIsPlatforms: bullet.textContent === expectedBullet,
        summaryColor: getComputedStyle(root.querySelector('[data-testid="subagent-group"]')!).color,
        background: style.backgroundColor,
      };
    }, pane);
    expect(grid.cell).toBeGreaterThan(4);
    expect(grid.row).toBeGreaterThan(8);
    expect(Math.abs(grid.textOffset - 2 * grid.cell)).toBeLessThanOrEqual(0.5);
    expect(grid.gaps.length).toBe(3);
    for (const gap of grid.gaps) expect(Math.abs(gap - grid.row)).toBeLessThanOrEqual(0.5);
    expect(grid.lineHeight).toBe(grid.row);
    expect(grid.fontWeight).toBe("400");
    expect(grid.theme).toBe("dark");
    expect(grid.bulletIsPlatforms).toBe(true);
    expect(grid.textColor).toBe("rgb(255, 255, 255)");
    expect(grid.summaryColor).toBe("rgb(153, 153, 153)");
    await snap("subagent-cli-running.png");

    await clickWhenVisible(`${pane} [data-entry-kind="group"]:last-of-type [data-testid="subagent-group"]`);
    await browser.waitUntil(async () => (await toolStates()).join() === "ok,pending", {
      timeout: 5_000,
      timeoutMsg: `clicking the running group never unfolded it: ${JSON.stringify(await toolStates())}`,
    });

    // Inside an unfolded group the columns are Claude Code's too: the result
    // connector is two spaces, the hook, a space and a no-break space, so
    // the result's text starts five cells in.
    const layout = await browser.execute((sel) => {
      const root = document.querySelector<HTMLElement>(sel)!;
      const cell = parseFloat(getComputedStyle(root).getPropertyValue("--cell"));
      const dot = root.querySelector<HTMLElement>('[data-testid="subagent-tool-state"]')!;
      const gutter = dot.parentElement!;
      const hookBlock = root.querySelector<HTMLElement>('[data-testid="subagent-tool-result"]')!;
      const connector = hookBlock.querySelector<HTMLElement>('[data-testid="subagent-result-connector"]')!;
      const hookText = hookBlock.lastElementChild as HTMLElement;
      const fonts = [root, dot, hookText, root.querySelector<HTMLElement>('[data-testid="subagent-tool-name"]')!]
        .map(el => getComputedStyle(el).fontFamily);
      return {
        cell,
        connector: connector.textContent,
        textOffset: hookText.getBoundingClientRect().left - gutter.getBoundingClientRect().left,
        fonts,
        blinking: getComputedStyle(root.querySelectorAll<HTMLElement>('[data-testid="subagent-tool-state"]')[1]).animationName,
      };
    }, pane);
    expect(layout.connector).toBe("  \u23BF \u00A0");
    expect(Math.abs(layout.textOffset - 5 * layout.cell)).toBeLessThanOrEqual(0.5);
    expect(new Set(layout.fonts).size).toBe(1);
    expect(layout.blinking).toBe("termic-cli-blink");
    await snap("subagent-cli-group-open.png");

    // Unfolded, the thought shows under a U+2234 at once, and "Thought for"
    // is written only on the summary line above it.
    await clickWhenVisible(`${pane} [data-testid="subagent-group"]`);
    const thinking = `${pane} [data-testid="subagent-thinking"]`;
    await waitVisible(thinking, 5_000);
    expect((await textOf(thinking)).replace(/\s+/g, " ")).toBe("\u2234 the port lives in src/config.ts");
    expect((await textOf(pane)).split("Thought for").length - 1).toBe(1);
    await snap("subagent-cli-thinking-open.png");

    appendTranscript(agentId, result(20, "toolu_build", buildOutput));
    await browser.waitUntil(async () => (await toolStates()).join() === "ok,ok", {
      timeout: 10_000,
      timeoutMsg: "the build result never reached its call",
    });
    const buildRowText = () => browser.execute((sel) =>
      [...document.querySelectorAll<HTMLElement>(`${sel} [data-testid="subagent-group-member"]`)]
        .map(el => el.innerText)
        .find(text => text.includes("npm run build")) ?? "", pane);
    expect(await buildRowText()).toContain("+37 lines");
    expect(await textOf(`${pane} [data-testid="subagent-footer"]`)).not.toContain("Bash(npm run build)");

    // Nothing has arrived since the build result 20s in, so the row has
    // stalled: the shimmer is parked and the message has gone red.
    await browser.waitUntil(async () => (await spinner()).messageColor === "rgb(171, 43, 63)", {
      timeout: 5_000,
      timeoutMsg: `the stalled spinner never turned red: ${JSON.stringify(await spinner())}`,
    });
    const stalled = await spinner();
    expect(stalled.messageAnimation).toBe("termic-cli-stall");
    expect(stalled.shimmerAnimation).toBe("termic-cli-shimmer-window, termic-cli-park");
    expect(stalled.shimmerVisibility).toBe("hidden");
    await snap("subagent-cli-bash-done.png");

    appendTranscript(agentId, call(22, "toolu_edit", "Edit", {
      file_path: config,
      old_string: "const port = 3000",
      new_string: "const port = 4000\nconst host = \"localhost\"",
    }));
    appendTranscript(agentId, result(23, "toolu_edit", editSnippet));
    appendTranscript(agentId, call(24, "toolu_todo", "TodoWrite", { todos: [
      { content: "Read config", status: "completed", activeForm: "Reading config" },
      { content: "Change the port", status: "in_progress", activeForm: "Changing the port" },
      { content: "Run the build", status: "pending", activeForm: "Running the build" },
    ] }));
    appendTranscript(agentId, result(25, "toolu_todo", "Todos have been modified successfully."));
    appendTranscript(agentId, call(26, "toolu_test", "Bash", { command: "npm test" }));
    appendTranscript(agentId, result(30, "toolu_test", "Error: 2 tests failed\n  at acme.test.ts:12", true));
    appendTranscript(agentId, said(31, [
      "# Result",
      "",
      "The port is **4000** now; two tests still fail.",
      "",
      "| Name | Port |",
      "|---|--:|",
      "| web | 4000 |",
      "",
      "```",
      "npm test",
      "```",
    ].join("\n")));

    // The calls join the group that is already unfolded, since nothing but
    // calls and results arrived between them.
    await browser.waitUntil(async () => (await toolStates()).length === 5, {
      timeout: 10_000,
      timeoutMsg: `the edit, todo and test calls never arrived: ${JSON.stringify(await toolStates())}`,
    });
    expect(await toolStates()).toEqual(["ok", "ok", "ok", "ok", "error"]);

    const tools = await browser.execute((sel) => {
      const root = document.querySelector(sel)!;
      const all = (id: string, attr: string) =>
        [...root.querySelectorAll(`[data-testid="${id}"]`)].map(el => [el.getAttribute(attr), (el as HTMLElement).innerText]);
      const names = [...root.querySelectorAll('[data-testid="subagent-tool-name"]')].map(el => (el as HTMLElement).innerText);
      const args = [...root.querySelectorAll('[data-testid="subagent-tool-input"]')].map(el => (el as HTMLElement).innerText);
      const removed = root.querySelector('[data-diff="remove"]') as HTMLElement | null;
      return {
        names,
        args,
        diff: all("subagent-diff-line", "data-diff"),
        gutters: [...root.querySelectorAll('[data-testid="subagent-diff-gutter"]')].map(el => el.textContent),
        words: [...root.querySelectorAll('[data-testid="subagent-diff-word"]')].map(el => el.textContent),
        todos: all("subagent-todo", "data-todo-status"),
        removedTint: removed ? getComputedStyle(removed).backgroundColor : null,
        doneStrike: getComputedStyle(root.querySelector('[data-todo-status="completed"] span:last-child')!).textDecorationLine,
      };
    }, pane);
    expect(tools.names).toEqual(["Read", "Bash", "Update", "Update Todos", "Bash"]);
    expect(tools.args).toEqual(["(src/config.ts)", "(npm run build)", "(src/config.ts)", "(npm test)"]);
    expect(tools.diff.map(([kind]) => kind)).toEqual(["remove", "add", "add"]);
    expect(tools.diff[0][1]).toContain("12");
    expect(tools.gutters).toEqual([" 12 -", " 12 +", " 13 +"]);
    expect(tools.words).toEqual(["3", "4"]);
    expect(tools.todos.map(([status]) => status)).toEqual(["completed", "in_progress", "pending"]);
    expect(tools.removedTint).toBe("rgb(122, 41, 54)");
    expect(tools.doneStrike).toBe("line-through");
    expect(await textOf(pane)).toContain("Updated src/config.ts with 2 additions and 1 removal");
    expect(await textOf(pane)).toContain("Error: 2 tests failed");

    const markdown = await browser.execute((sel) => {
      const root = document.querySelector(sel)!;
      const heading = root.querySelector<HTMLElement>('[data-heading-level="1"]')!;
      const code = root.querySelector<HTMLElement>('[data-code-language=""]')!;
      const table = root.querySelector<HTMLElement>('[data-testid="subagent-table"]')!;
      const style = getComputedStyle(root as HTMLElement);
      const cell = parseFloat(style.getPropertyValue("--cell"));
      const row = parseFloat(style.getPropertyValue("--row"));
      const codeIndent = parseFloat(getComputedStyle(code).paddingLeft);
      return {
        tableRows: table.getBoundingClientRect().height / row,
        codeIndentCells: codeIndent / cell,
        heading: [getComputedStyle(heading).fontWeight, getComputedStyle(heading).fontStyle, getComputedStyle(heading).textDecorationLine],
        table: root.querySelector<HTMLElement>('[data-testid="subagent-table"]')!.textContent!.split("\n"),
        codeColor: getComputedStyle(code).color,
      };
    }, pane);
    expect(markdown.heading).toEqual(["700", "italic", "underline"]);
    expect(markdown.table).toEqual([
      "\u250C\u2500\u2500\u2500\u2500\u2500\u2500\u252C\u2500\u2500\u2500\u2500\u2500\u2500\u2510",
      "\u2502 Name \u2502 Port \u2502",
      "\u251C\u2500\u2500\u2500\u2500\u2500\u2500\u253C\u2500\u2500\u2500\u2500\u2500\u2500\u2524",
      "\u2502 web  \u2502 4000 \u2502",
      "\u2514\u2500\u2500\u2500\u2500\u2500\u2500\u2534\u2500\u2500\u2500\u2500\u2500\u2500\u2518",
    ]);
    expect(markdown.codeColor).toBe("rgb(177, 185, 249)");
    // Five text rows exactly: border, header, rule, body, border.
    expect(Math.abs(markdown.tableRows - 5)).toBeLessThanOrEqual(0.01);
    expect(Math.abs(markdown.codeIndentCells - 2)).toBeLessThanOrEqual(0.02);
    await snap("subagent-cli-tools.png");

    // ctrl+o in the focused pane unfolds every group, and again folds them
    // all back to their summary lines.
    const pressCtrlO = async () => {
      await browser.execute((sel) => document.querySelector<HTMLElement>(sel)!.focus(), pane);
      await browser.action("key").down(Key.Control).down("o").up("o").up(Key.Control).perform();
    };
    const finderOpen = () => browser.execute(() => !!document.querySelector('[data-testid="task-finder"]'));
    await pressCtrlO();
    await browser.waitUntil(async () => (await groups()).every(group => group.unfolded), {
      timeout: 5_000,
      timeoutMsg: `ctrl+o never unfolded every group: ${JSON.stringify(await groups())}`,
    });
    // ctrl+o belongs to the pane, so the app's own ctrl-as-cmd task finder
    // must stay shut. The finder fades in, so give it time to appear.
    await browser.pause(400);
    expect(await finderOpen()).toBe(false);
    await snap("subagent-cli-verbose.png");
    await pressCtrlO();
    await browser.waitUntil(async () => (await groups()).every(group => !group.unfolded), {
      timeout: 5_000,
      timeoutMsg: `a second ctrl+o never folded the groups: ${JSON.stringify(await groups())}`,
    });
    expect(await toolStates()).toEqual([]);
    expect((await groups()).map(group => group.text)).toEqual([
      "Thought for 4s",
      "Edited 1 file +2 -1, read 1 file, called 1 tool, ran 2 shell commands",
    ]);
    await snap("subagent-cli-collapsed.png");

    // Cmd+O from inside the pane still opens the task finder on macOS.
    if (process.platform === "darwin") {
      await browser.execute((sel) => document.querySelector<HTMLElement>(sel)!.focus(), pane);
      await browser.action("key").down(Key.Command).down("o").up("o").up(Key.Command).perform();
      await waitVisible('[data-testid="task-finder"]', 5_000);
      await browser.action("key").down(Key.Escape).up(Key.Escape).perform();
      await browser.waitUntil(
        async () => browser.execute(() => {
          const storeClosed = !window.__termic!.useUI.getState().taskFinderOpen;
          const dialogState = document.querySelector('[data-testid="task-finder"]')?.getAttribute("data-state") ?? "gone";
          return storeClosed && dialogState !== "open";
        }),
        {
          timeout: 10_000,
          timeoutMsg: `the task finder never closed: ${JSON.stringify(await browser.execute(() => ({
            open: window.__termic!.useUI.getState().taskFinderOpen,
            state: document.querySelector('[data-testid="task-finder"]')?.getAttribute("data-state") ?? null,
            active: (document.activeElement as HTMLElement | null)?.getAttribute("data-testid") ?? document.activeElement?.tagName,
          })))}`,
        },
      );
    }

    const paneCell = await browser.execute((sel) => {
      const style = getComputedStyle(document.querySelector<HTMLElement>(sel)!);
      return {
        cell: parseFloat(style.getPropertyValue("--cell")),
        row: parseFloat(style.getPropertyValue("--row")),
        fontFamily: style.fontFamily,
        fontSize: style.fontSize,
      };
    }, pane);

    await parentToFront();
    // The parent tab's xterm draws on the grid the view copies: its screen
    // is a whole number of the view's cells across and rows down. xterm 5.5
    // measures on an OffscreenCanvas, so there is no measure span to read
    // its font from; both take the same font options from prefs.
    const xterm = await browser.execute((task) => {
      const screen = document.querySelector<HTMLElement>(`[data-task-id="${task}"] .xterm-screen`)!.getBoundingClientRect();
      return { width: screen.width, height: screen.height };
    }, taskId);
    const prefsFontSize = await browser.execute(() => window.__termic!.usePrefs.getState().terminalFontSize as number);
    expect(paneCell.fontSize).toBe(`${prefsFontSize}px`);
    const columns = xterm.width / paneCell.cell;
    const lines = xterm.height / paneCell.row;
    expect(Math.abs(columns - Math.round(columns))).toBeLessThanOrEqual(0.01);
    expect(Math.abs(lines - Math.round(lines))).toBeLessThanOrEqual(0.01);
    expect(Math.round(columns)).toBeGreaterThan(20);
    expect(Math.round(lines)).toBeGreaterThan(5);

    await submitToAgent(taskId, `#subagent stop ${sessionId} ${agentId} general-purpose`);
    await openFromRow(agentId);
    await browser.waitUntil(
      async () => browser.execute((sel) => document.querySelector(sel)?.getAttribute("data-footer-state"), footer).then(state => state === "done"),
      { timeout: 15_000, timeoutMsg: "the footer never turned to done after the stop" },
    );
    expect((await textOf(footer)).replace(/\s+/g, " ")).toContain("general-purpose Done (5 tool uses)");
    expect(await textOf(`${pane} [data-testid="subagent-footer-stats"]`)).toBe("31s \u00B7 \u2193 2.6k tokens");
    expect(await browser.execute((sel) => document.querySelector(`${sel} [data-testid="subagent-working"]`) === null, pane)).toBe(true);
    await snap("subagent-cli-done.png");
  });

  it("follows claude's own theme setting when the window regains focus", async function () {
    this.timeout(30_000);
    const agentId = "e2ecli1";
    const pane = paneSelector(agentId);
    writeFileSync(path.join(CONFIG_DIR, "settings.json"), JSON.stringify({ theme: "light" }));
    try {
      await browser.execute(() => window.dispatchEvent(new Event("focus")));
      await browser.waitUntil(
        async () => browser.execute((sel) => document.querySelector(sel)?.getAttribute("data-claude-theme"), pane).then(theme => theme === "light"),
        { timeout: 10_000, timeoutMsg: "the view never picked up the light theme" },
      );
      const colors = await browser.execute((sel) => {
        const root = document.querySelector<HTMLElement>(sel)!;
        const text = root.querySelector<HTMLElement>('[data-entry-kind="assistantText"] span[aria-hidden]')!;
        return { text: getComputedStyle(text).color, user: getComputedStyle(root.querySelector<HTMLElement>('[data-entry-kind="userText"] > div')!).backgroundColor };
      }, pane);
      expect(colors.text).toBe("rgb(0, 0, 0)");
      expect(colors.user).toBe("rgb(240, 240, 240)");
      await snap("subagent-cli-light.png");
    } finally {
      rmSync(path.join(CONFIG_DIR, "settings.json"), { force: true });
      await browser.execute(() => window.dispatchEvent(new Event("focus")));
    }
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
