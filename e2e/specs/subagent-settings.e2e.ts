// Settings > Tasks > Claude subagents, driven through the real controls.
//
// The rows come from the fake agent, the same way subagent-rows.e2e.ts gets
// them: `#subagent start|stop` replays claude's hooks, and `#subagent-jsonl`
// writes the transcript a rebuild scans, so turning the master toggle back on
// has something on disk to bring the rows back from. Every setting is changed
// by clicking it on the settings page, and every effect is read off the
// sidebar with no reload in between.

import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { dataDir } from "../../wdio.conf.js";
import {
  archiveTask,
  clearLanguagePref,
  clickPresent,
  openTask,
  requireTermicApi,
  setHooksOwnState,
  setWindowPresence,
  snap,
  submitToAgent,
  waitForAgentReady,
  waitForAppShell,
  waitPtyQuiet,
} from "../helpers.js";

const CLI = "fakeclaude";
const CONFIG_DIR = path.join(dataDir, "e2e-subagent-settings-claude");
const BLOCK = '[data-testid="subagent-settings"]';
const ROW = '[data-testid="subagent-row"]';
const BUILT_IN_AGENT = "e2eset1";
const CUSTOM_AGENT = "e2eset2";

const USER_LINE = '{"type":"user","message":{"role":"user","content":"look around"}}';
const ANSWER_LINE =
  '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"all done"}],"stop_reason":"end_turn"}}';

describe("subagent settings", () => {
  let taskId!: string;
  let sessionId!: string;
  let subagentsDir!: string;
  let originalEnv: Record<string, string> | null = null;

  const switchIn = (testId: string) => `[data-testid="${testId}"] button[role="switch"]`;

  async function directive(line: string): Promise<void> {
    await submitToAgent(taskId, line);
  }

  async function transcript(agentId: string, line: string): Promise<void> {
    await directive(`#subagent-jsonl ${agentId} ${line}`);
    const file = path.join(subagentsDir, `agent-${agentId}.jsonl`);
    await browser.waitUntil(
      async () => existsSync(file) && readFileSync(file, "utf8").includes(line),
      { timeout: 10_000, interval: 100, timeoutMsg: `the fake agent never wrote ${path.basename(file)}` },
    );
  }

  // Claude records each subagent's type in a sidecar, and a rebuild reads it
  // from there, so rows brought back from disk keep their built-in or custom kind.
  async function meta(agentId: string, agentType: string): Promise<void> {
    await directive(`#subagent-meta ${agentId} {"agentType":"${agentType}"}`);
    const file = path.join(subagentsDir, `agent-${agentId}.meta.json`);
    await browser.waitUntil(
      async () => existsSync(file) && readFileSync(file, "utf8").includes(agentType),
      { timeout: 10_000, interval: 100, timeoutMsg: `the fake agent never wrote ${path.basename(file)}` },
    );
  }

  async function openTasksSettings(): Promise<void> {
    await browser.execute(() => window.__termic!.useApp.getState().openSettings("tasks"));
    await browser.waitUntil(
      () => browser.execute((sel) => !!document.querySelector(sel), BLOCK),
      { timeout: 10_000, interval: 50, timeoutMsg: "the Claude subagents block never rendered" },
    );
  }

  async function closeSettings(): Promise<void> {
    await browser.execute(() => window.__termic!.useApp.getState().closeSettings());
  }

  /** Click a control on the settings page, then come back to the sidebar. */
  async function changeSetting(selector: string): Promise<void> {
    await openTasksSettings();
    await clickPresent(selector);
    await closeSettings();
  }

  async function rowIds(): Promise<string[]> {
    return browser.execute(
      (task, sel) => [...document.querySelectorAll(`[data-sidebar-task-row="${task}"] ${sel}`)]
        .map(el => el.getAttribute("data-agent-id") ?? ""),
      taskId,
      ROW,
    );
  }

  async function waitRows(expected: string[], why: string): Promise<void> {
    const want = [...expected].sort().join(",");
    await browser.waitUntil(async () => (await rowIds()).sort().join(",") === want, {
      timeout: 10_000,
      interval: 50,
      timeoutMsg: `${why}: rows were ${(await rowIds()).join(",") || "none"}, wanted ${want || "none"}`,
    });
  }

  async function storedAgentCount(): Promise<number> {
    return browser.execute(() => {
      const byTab = window.__termic!.useSubagents.getState().byTab as Record<string, { order: string[] }>;
      return Object.values(byTab).reduce((sum, entry) => sum + entry.order.length, 0);
    });
  }

  async function resetPrefs(): Promise<void> {
    await browser.execute(() => {
      const p = window.__termic!.usePrefs.getState();
      p.setSubagentsEnabled(true);
      p.setSubagentTypeFilter("builtIn", true);
      p.setSubagentTypeFilter("custom", true);
      p.setSubagentTypeFilter("fork", true);
      p.setSubagentRetention("session");
      p.setSubagentAutoCollapse("never");
    });
  }

  before(async function () {
    this.timeout(120_000);
    await waitForAppShell();
    await requireTermicApi();
    rmSync(CONFIG_DIR, { recursive: true, force: true });
    await resetPrefs();

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
    taskId = await openTask("e2e-subagent-settings", true, CLI);
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
      return { sessionId: s.tabs[id][0].sessionId as string, taskPath: task.path as string };
    }, taskId);
    sessionId = facts.sessionId;
    const slug = facts.taskPath.replace(/[^A-Za-z0-9]/g, "-");
    subagentsDir = path.join(CONFIG_DIR, "projects", slug, sessionId, "subagents");

    await browser.execute((id) => window.__termic!.useApp.getState().setTaskCollapsed(id, false), taskId);

    await transcript(BUILT_IN_AGENT, USER_LINE);
    await transcript(CUSTOM_AGENT, USER_LINE);
    await meta(BUILT_IN_AGENT, "general-purpose");
    await meta(CUSTOM_AGENT, "reviewer");
    await directive(`#subagent start ${sessionId} ${BUILT_IN_AGENT} general-purpose`);
    await directive(`#subagent start ${sessionId} ${CUSTOM_AGENT} reviewer`);
    await waitRows([BUILT_IN_AGENT, CUSTOM_AGENT], "the start hooks never drew both rows");
  });

  after(async () => {
    await resetPrefs();
    await clearLanguagePref();
    await closeSettings();
    if (originalEnv) {
      await browser.execute(async (cli, env) => {
        const t = window.__termic!;
        const agents = (await t.invoke("settings_load")).agents.map((a: any) =>
          a.id === cli ? { ...a, env } : a);
        await t.invoke("agents_save", { agents });
        await t.useApp.getState().loadAll();
      }, CLI, originalEnv);
    }
    await browser.execute(() => window.__termic!.useSubagentFold.setState({ byTab: {}, groupByTab: {} }));
    await setHooksOwnState(CLI, false);
    await setWindowPresence(true);
    if (taskId) await archiveTask(taskId);
    rmSync(CONFIG_DIR, { recursive: true, force: true });
  });

  it("renders in Settings > Tasks with the workflow filter disabled and no capped text", async () => {
    await openTasksSettings();

    const block = await browser.execute((sel, workflow, master) => {
      const root = document.querySelector(sel)!;
      const workflowSwitch = document.querySelector<HTMLButtonElement>(workflow)!;
      return {
        text: root.textContent ?? "",
        workflowDisabled: workflowSwitch.disabled,
        workflowChecked: workflowSwitch.getAttribute("aria-checked"),
        masterChecked: document.querySelector(master)?.getAttribute("aria-checked") ?? null,
        cappedNodes: root.querySelectorAll('[class*="max-w-"]').length,
      };
    }, BLOCK, switchIn("subagent-setting-type-workflow"), switchIn("subagent-setting-enabled"));

    expect(block.text).toContain("Claude subagents");
    expect(block.text).toContain("Workflow agents are not shown in the sidebar yet.");
    expect(block.workflowDisabled).toBe(true);
    expect(block.workflowChecked).toBe("false");
    expect(block.masterChecked).toBe("true");
    expect(block.cappedNodes).toBe(0);
    await snap("subagent-settings-en.png");

    // A click on the disabled workflow switch changes nothing.
    await clickPresent(switchIn("subagent-setting-type-workflow"));
    const workflow = await browser.execute(
      () => window.__termic!.usePrefs.getState().subagentTypeFilter.workflow as boolean);
    expect(workflow).toBe(false);
    await closeSettings();
  });

  it("the master toggle removes every row at once and brings them back from disk", async function () {
    this.timeout(60_000);
    await changeSetting(switchIn("subagent-setting-enabled"));

    await waitRows([], "switching subagents off left rows behind");
    expect(await storedAgentCount()).toBe(0);
    await snap("subagent-settings-off.png");

    // Off means hooks are dropped too: a start now draws nothing.
    await directive(`#subagent start ${sessionId} e2eset3 general-purpose`);
    await waitPtyQuiet(taskId, 1_000);
    expect(await rowIds()).toEqual([]);
    expect(await storedAgentCount()).toBe(0);

    await changeSetting(switchIn("subagent-setting-enabled"));
    await waitRows([BUILT_IN_AGENT, CUSTOM_AGENT], "switching subagents back on did not rebuild the rows");
    await snap("subagent-settings-on-again.png");
  });

  it("a type filter hides only the matching rows, live", async function () {
    this.timeout(60_000);
    await changeSetting(switchIn("subagent-setting-type-custom"));
    await waitRows([BUILT_IN_AGENT], "turning custom agents off did not hide only the custom row");
    await snap("subagent-settings-custom-off.png");

    await changeSetting(switchIn("subagent-setting-type-builtIn"));
    await waitRows([], "turning built-in agents off too left a row");

    await changeSetting(switchIn("subagent-setting-type-custom"));
    await changeSetting(switchIn("subagent-setting-type-builtIn"));
    await waitRows([BUILT_IN_AGENT, CUSTOM_AGENT], "turning both kinds back on did not bring both rows back");
  });

  it("hide when finished takes a finished row away and keeps the running one", async function () {
    this.timeout(60_000);
    await changeSetting('[data-testid="subagent-setting-retention"] button[data-value="finished"]');
    await waitRows([BUILT_IN_AGENT, CUSTOM_AGENT], "a retention change hid a running row");

    await transcript(BUILT_IN_AGENT, ANSWER_LINE);
    await directive(`#subagent stop ${sessionId} ${BUILT_IN_AGENT} general-purpose`);
    await waitRows([CUSTOM_AGENT], "a finished row stayed under hide when finished");

    await changeSetting('[data-testid="subagent-setting-retention"] button[data-value="session"]');
    await waitRows([BUILT_IN_AGENT, CUSTOM_AGENT], "keeping rows for the session did not bring the finished one back");
  });

  it("auto-collapse folds the group, and a manual expand wins", async function () {
    this.timeout(60_000);
    const toggle = `[data-sidebar-task-row="${taskId}"] [data-testid="subagent-group-toggle"]`;

    await changeSetting('[data-testid="subagent-setting-auto-collapse"] button[data-value="always"]');
    await waitRows([], "collapse always left the rows open");
    const collapsed = await browser.execute(
      (sel) => document.querySelector(sel)?.getAttribute("aria-expanded") ?? null, toggle);
    expect(collapsed).toBe("false");
    await snap("subagent-settings-collapsed.png");

    await clickPresent(toggle);
    await waitRows([BUILT_IN_AGENT, CUSTOM_AGENT], "expanding the group by hand did not show the rows");

    await changeSetting('[data-testid="subagent-setting-auto-collapse"] button[data-value="never"]');
    await waitRows([BUILT_IN_AGENT, CUSTOM_AGENT], "collapse never hid the rows");
  });

  it("renders the block in Chinese through the language switch", async () => {
    await browser.execute(() => window.__termic!.usePrefs.getState().setLanguage("zh-CN"));
    await browser.waitUntil(
      async () => (await browser.execute(() => document.documentElement.lang)) === "zh-CN",
      { timeout: 10_000, interval: 50, timeoutMsg: "the language never switched to zh-CN" },
    );
    await openTasksSettings();

    const block = await browser.execute((sel, workflow) => ({
      text: document.querySelector(sel)?.textContent ?? "",
      workflowDisabled: document.querySelector<HTMLButtonElement>(workflow)?.disabled ?? null,
    }), BLOCK, switchIn("subagent-setting-type-workflow"));

    expect(block.text).toContain("Claude 子智能体");
    expect(block.text).toContain("工作流智能体暂不在侧边栏中显示。");
    expect(block.text).not.toContain("tasks.subagents.");
    expect(block.workflowDisabled).toBe(true);
    await snap("subagent-settings-zh-CN.png");

    await clearLanguagePref();
    await closeSettings();
  });
});
