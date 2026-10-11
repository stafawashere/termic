// Subagent rows rebuilt from the transcripts on disk.
//
// Nothing about a subagent is persisted, so a relaunch, a `--resume` spawn
// and a SessionStart that moves the tab to another session all bring the
// rows back by scanning `<sessionId>/subagents/`. A spec cannot relaunch the
// window, so the relaunch case does what a relaunch leaves behind: the task
// stopped, the subagent store empty, the task list reloaded from disk. Then
// it runs the same pass the launch schedules.
//
// The transcripts are synthetic and live under a claude config dir inside the
// e2e profile. The first session's are written by the fake agent's
// `#subagent-jsonl` / `#subagent-meta`; a session the fake agent is not in yet
// is written from here, before `#session` moves the tab to it.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { dataDir } from "../../wdio.conf.js";
import {
  archiveTask,
  ensureActiveTask,
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
const CONFIG_DIR = path.join(dataDir, "e2e-subagents-rebuild-claude");
const ROW = '[data-testid="subagent-row"]';

const USER_LINE = '{"type":"user","message":{"role":"user","content":"look around"}}';
const ANSWER_LINE =
  '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"all done"}],"stop_reason":"end_turn"}}';
const ERROR_LINE =
  '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"boom","is_error":true}]}}';

describe("subagent rows rebuilt from disk", () => {
  let taskId!: string;
  let sessionId!: string;
  let projectsSlugDir!: string;
  let originalEnv: Record<string, string> | null = null;

  const subagentsDirOf = (session: string) => path.join(projectsSlugDir, session, "subagents");

  async function directive(line: string): Promise<void> {
    await submitToAgent(taskId, line);
  }

  async function waitForFile(file: string, contains: string): Promise<void> {
    await browser.waitUntil(
      async () => existsSync(file) && readFileSync(file, "utf8").includes(contains),
      {
        timeout: 10_000,
        interval: 100,
        timeoutMsg: `the fake agent never wrote ${path.basename(file)} (is CLAUDE_CONFIG_DIR reaching its env?)`,
      },
    );
  }

  async function transcript(agentId: string, line: string): Promise<void> {
    await directive(`#subagent-jsonl ${agentId} ${line}`);
    await waitForFile(path.join(subagentsDirOf(sessionId), `agent-${agentId}.jsonl`), line);
  }

  async function meta(agentId: string, fields: Record<string, unknown>): Promise<void> {
    const body = JSON.stringify(fields);
    await directive(`#subagent-meta ${agentId} ${body}`);
    await waitForFile(path.join(subagentsDirOf(sessionId), `agent-${agentId}.meta.json`), body);
  }

  /** The task's rows as drawn: agent id to its state attribute. */
  async function drawnRows(): Promise<Record<string, string>> {
    return browser.execute(
      (task, sel) => Object.fromEntries(
        [...document.querySelectorAll(`[data-sidebar-task-row="${task}"] ${sel}`)].map(el => [
          el.getAttribute("data-agent-id") ?? "",
          el.getAttribute("data-subagent-state") ?? "",
        ]),
      ),
      taskId,
      ROW,
    );
  }

  async function waitRows(expected: Record<string, string>, what: string): Promise<void> {
    const want = JSON.stringify(Object.entries(expected).sort());
    let last: Record<string, string> = {};
    await browser.waitUntil(
      async () => {
        last = await drawnRows();
        return JSON.stringify(Object.entries(last).sort()) === want;
      },
      { timeout: 15_000, interval: 100, timeoutMsg: `${what}: rows never became ${want}` },
    ).catch(() => {
      throw new Error(`${what}: rows are ${JSON.stringify(last)}, wanted ${want}`);
    });
  }

  async function tabSession(): Promise<string | null> {
    return browser.execute(
      (id) => (window.__termic!.useApp.getState().tabs[id] ?? [])[0]?.sessionId ?? null,
      taskId,
    );
  }

  async function errorToastCount(): Promise<number> {
    return browser.execute(
      () => window.__termic!.useUI.getState().toasts.filter((toast: any) => toast.kind === "error").length,
    );
  }

  async function setTaskCollapsed(collapsed: boolean): Promise<void> {
    await browser.execute(
      (id, value) => window.__termic!.useApp.getState().setTaskCollapsed(id, value),
      taskId,
      collapsed,
    );
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
    taskId = await openTask("e2e-subagents-rebuild", true, CLI);
    await waitForAgentReady(taskId);

    await browser.waitUntil(async () => {
      if (await tabSession()) return true;
      await submitToAgent(taskId, "#usage usage 10 10 - -");
      return false;
    }, { timeout: 20_000, interval: 1_000, timeoutMsg: "the fakeclaude tab never held a session id" });
    await waitPtyQuiet(taskId, 2_000);

    sessionId = (await tabSession())!;
    const taskPath = await browser.execute(
      (id) => window.__termic!.useApp.getState().tasks.find((x: any) => x.id === id).path as string,
      taskId,
    );
    projectsSlugDir = path.join(CONFIG_DIR, "projects", taskPath.replace(/[^A-Za-z0-9]/g, "-"));

    await setTaskCollapsed(false);
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
    if (taskId) await archiveTask(taskId);
    rmSync(CONFIG_DIR, { recursive: true, force: true });
  });

  it("after a relaunch, a restored tab's rows come back from its transcripts", async function () {
    this.timeout(60_000);
    await transcript("e2edone", USER_LINE);
    await transcript("e2edone", ANSWER_LINE);
    await meta("e2edone", { agentType: "general-purpose", description: "Survey the repo" });
    await transcript("e2efail", ERROR_LINE);
    await transcript("e2eopen", USER_LINE);
    expect(await drawnRows()).toEqual({});

    await browser.execute((id) => window.__termic!.useApp.getState().stopTask(id), taskId);
    await browser.waitUntil(
      () => browser.execute(
        (id) => !(window.__termic!.useApp.getState().tabs[id] ?? [])[0]?.ptyId,
        taskId,
      ),
      { timeout: 10_000, timeoutMsg: "the stopped task's tab still holds a pty" },
    );
    await browser.execute(async () => {
      const t = window.__termic!;
      t.useSubagents.setState({ byTab: {} });
      await t.useApp.getState().loadAll();
      await t.runSubagentLaunchRebuild();
    });

    await waitRows(
      { e2edone: "done", e2efail: "failed", e2eopen: "interrupted" },
      "launch rebuild with the parent not running",
    );
    await snap("subagents-rebuilt-after-relaunch.png");
  });

  it("resuming the tab rescans with claude running, so an open transcript reads unknown, never running", async function () {
    this.timeout(60_000);
    await ensureActiveTask(taskId);
    await waitForAgentReady(taskId);
    expect(await tabSession()).toBe(sessionId);

    await waitRows(
      { e2edone: "done", e2efail: "failed", e2eopen: "unknown" },
      "resume rebuild with the parent running",
    );
    await snap("subagents-rebuilt-on-resume.png");
  });

  it("a SessionStart that moves the tab swaps the rows to the new session's history", async function () {
    this.timeout(60_000);
    const nextSession = randomUUID();
    const nextDir = subagentsDirOf(nextSession);
    mkdirSync(nextDir, { recursive: true });
    writeFileSync(path.join(nextDir, "agent-e2enext.jsonl"), `${USER_LINE}\n${ANSWER_LINE}\n`);

    await directive(`#session ${nextSession}`);
    await browser.waitUntil(async () => (await tabSession()) === nextSession, {
      timeout: 10_000,
      timeoutMsg: "the tab never took the reported session",
    });

    await waitRows({ e2enext: "done" }, "rows after the session change");
    await snap("subagents-swapped-on-session-change.png");
  });

  it("a session with no subagents directory shows no rows and no error", async function () {
    this.timeout(60_000);
    const emptySession = randomUUID();
    const toastsBefore = await errorToastCount();
    expect(existsSync(subagentsDirOf(emptySession))).toBe(false);

    await directive(`#session ${emptySession}`);
    await browser.waitUntil(async () => (await tabSession()) === emptySession, {
      timeout: 10_000,
      timeoutMsg: "the tab never took the reported session",
    });

    await waitRows({}, "rows after moving to a session with no subagents");
    await waitPtyQuiet(taskId, 1_000);
    expect(await drawnRows()).toEqual({});
    expect(await errorToastCount()).toBe(toastsBefore);
  });
});
