// Subagent rows under a claude tab in the sidebar.
//
// Driven end to end through the fake agent: `#subagent start|stop` replays
// claude's SubagentStart / SubagentStop hooks over the trusted OSC channel,
// and `#subagent-jsonl` / `#subagent-meta` write the transcript files claude
// keeps beside its session, which is where a stop's outcome (done or failed)
// and an agent's parent come from. Those files land under a claude config
// dir inside the e2e profile: the spec points `fakeclaude` at it for its own
// run and puts the agent's env back afterwards.
//
// What only a frame sampler can see is sampled per animation frame (the
// re-parent). Everything else is read off the DOM the user sees.

import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { dataDir } from "../../wdio.conf.js";
import {
  archiveTask,
  clickPresent,
  openTask,
  requireTermicApi,
  requireWorkBadges,
  setHooksOwnState,
  setWindowPresence,
  snap,
  submitToAgent,
  waitForAgentReady,
  waitForAppShell,
  waitPtyQuiet,
  workBadges,
} from "../helpers.js";

const CLI = "fakeclaude";
const CONFIG_DIR = path.join(dataDir, "e2e-subagent-claude");
const ROW = '[data-testid="subagent-row"]';

const USER_LINE = '{"type":"user","message":{"role":"user","content":"look around"}}';
const ANSWER_LINE =
  '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"all done"}],"stop_reason":"end_turn"}}';
const ERROR_LINE =
  '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"boom","is_error":true}]}}';

describe("subagent rows", () => {
  let taskId!: string;
  let sessionId!: string;
  let subagentsDir!: string;
  let originalEnv: Record<string, string> | null = null;

  const rowSelector = (agentId: string) =>
    `[data-sidebar-task-row="${taskId}"] ${ROW}[data-agent-id="${agentId}"]`;

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
    await waitForFile(path.join(subagentsDir, `agent-${agentId}.jsonl`), line);
  }

  async function meta(agentId: string, fields: Record<string, unknown>): Promise<void> {
    const body = JSON.stringify(fields);
    await directive(`#subagent-meta ${agentId} ${body}`);
    await waitForFile(path.join(subagentsDir, `agent-${agentId}.meta.json`), body);
  }

  const start = (agentId: string, agentType = "general-purpose") =>
    directive(`#subagent start ${sessionId} ${agentId} ${agentType}`);
  const stop = (agentId: string, agentType = "general-purpose") =>
    directive(`#subagent stop ${sessionId} ${agentId} ${agentType}`);

  async function rowState(agentId: string): Promise<string | null> {
    return browser.execute(
      (sel) => document.querySelector(sel)?.getAttribute("data-subagent-state") ?? null,
      rowSelector(agentId),
    );
  }

  async function waitRowState(agentId: string, state: string, timeout = 10_000): Promise<void> {
    await browser.waitUntil(async () => (await rowState(agentId)) === state, {
      timeout,
      interval: 50,
      timeoutMsg: `row ${agentId} never reached ${state} (last: ${await rowState(agentId)})`,
    });
  }

  /** The task's subagent rows in DOM order, with their drawn depth. */
  async function rows(): Promise<Array<{ id: string; depth: string }>> {
    return browser.execute(
      (task, sel) => [...document.querySelectorAll(`[data-sidebar-task-row="${task}"] ${sel}`)].map(el => ({
        id: el.getAttribute("data-agent-id") ?? "",
        depth: el.getAttribute("data-depth") ?? "",
      })),
      taskId,
      ROW,
    );
  }

  async function storeHasAgent(agentId: string): Promise<boolean> {
    return browser.execute(
      (task, id) => {
        const tab = (window.__termic!.useApp.getState().tabs[task] ?? [])[0];
        const entry = tab ? window.__termic!.useSubagents.getState().byTab[tab.id] : undefined;
        return !!entry?.agents[id];
      },
      taskId,
      agentId,
    );
  }

  /** Every localStorage key and value, so a spec can prove a UI action
   *  wrote nothing there. */
  async function localStorageDump(): Promise<string> {
    return browser.execute(() => {
      const dump: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i) ?? "";
        dump.push(`${key}=${localStorage.getItem(key) ?? ""}`);
      }
      return dump.sort().join("\n");
    });
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
    await requireWorkBadges();
    rmSync(CONFIG_DIR, { recursive: true, force: true });

    // Point fakeclaude's claude config at the profile, so the transcript
    // files the fake agent writes are the ones subagent_list reads.
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
    taskId = await openTask("e2e-subagent-rows", true, CLI);
    await waitForAgentReady(taskId);

    // The same wait as agent.e2e.ts's subagent hooks: submit until the
    // spawn's session id is held by the tab.
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
    await browser.execute(() => window.__termic!.useSubagentFold.setState({ byTab: {} }));
    await setHooksOwnState(CLI, false);
    await setWindowPresence(true);
    if (taskId) await archiveTask(taskId);
    rmSync(CONFIG_DIR, { recursive: true, force: true });
  });

  it("draws a running row under the tab within 1000 ms of the start hook", async function () {
    this.timeout(30_000);
    const agentId = "e2erun1";

    // Every DOM commit from here on checks for the row, so the time recorded
    // is the commit that drew it, not the moment a poll noticed. Not rAF: the
    // harness window is occluded and WebKit freezes rAF there.
    const startedAt = await browser.execute((sel) => {
      const w = window as unknown as { __subagentSeenAt?: number | null };
      w.__subagentSeenAt = null;
      const observer = new MutationObserver(() => {
        if (!document.querySelector(sel)) return;
        w.__subagentSeenAt = Date.now();
        observer.disconnect();
      });
      observer.observe(document.body, { childList: true, subtree: true, attributes: true });
      return Date.now();
    }, rowSelector(agentId));

    await start(agentId);
    await browser.waitUntil(
      () => browser.execute(() => (window as unknown as { __subagentSeenAt?: number | null }).__subagentSeenAt != null),
      { timeout: 5_000, interval: 25, timeoutMsg: "the subagent row never appeared" },
    );
    const seenAt = await browser.execute(
      () => (window as unknown as { __subagentSeenAt: number }).__subagentSeenAt);
    expect(seenAt - startedAt).toBeLessThanOrEqual(1_000);

    expect(await rowState(agentId)).toBe("running");
    const indent = await browser.execute((task, sel) => {
      const row = document.querySelector<HTMLElement>(sel)!;
      const tabRow = document.querySelector<HTMLElement>(`[data-sidebar-task-row="${task}"] div.ml-8`)!;
      return {
        depth: row.getAttribute("data-depth"),
        rowLeft: row.getBoundingClientRect().left,
        tabLeft: tabRow.getBoundingClientRect().left,
      };
    }, taskId, rowSelector(agentId));
    expect(indent.depth).toBe("1");
    expect(indent.rowLeft).toBeGreaterThan(indent.tabLeft);
    await snap("subagent-row-running.png");
  });

  it("a stop whose transcript ends on an answer flips the row to done, and never badges the tab", async function () {
    this.timeout(30_000);
    const agentId = "e2erun1";
    await transcript(agentId, USER_LINE);
    await transcript(agentId, ANSWER_LINE);
    await stop(agentId);

    await waitRowState(agentId, "done");
    await waitPtyQuiet(taskId, 1_000);
    const badges = await workBadges(taskId);
    expect(badges).not.toContain("attention");
    expect(badges).not.toContain("done");
    await snap("subagent-row-done.png");
  });

  it("a stop whose transcript ends on an error flips the row to failed", async function () {
    this.timeout(30_000);
    const agentId = "e2efail1";
    await transcript(agentId, USER_LINE);
    await start(agentId);
    await waitRowState(agentId, "running");
    await transcript(agentId, ERROR_LINE);
    await stop(agentId);

    await waitRowState(agentId, "failed");
    await snap("subagent-row-failed.png");
  });

  it("a stop with no transcript to read stays a neutral stopped row", async function () {
    this.timeout(30_000);
    const agentId = "e2enone1";
    await start(agentId);
    await waitRowState(agentId, "running");
    await stop(agentId);

    await waitRowState(agentId, "unknown");
  });

  it("nests agents under their parent and clamps the indent at depth 3", async function () {
    this.timeout(60_000);
    const chain = ["e2ed1", "e2ed2", "e2ed3", "e2ed4", "e2ed5"];
    for (const [index, agentId] of chain.entries()) {
      await transcript(agentId, USER_LINE);
      const parentAgentId = index === 0 ? undefined : chain[index - 1];
      await meta(agentId, { agentType: "general-purpose", spawnDepth: index + 1, parentAgentId });
    }
    for (const agentId of chain) await start(agentId);

    await browser.waitUntil(async () => {
      const drawn = (await rows()).filter(row => chain.includes(row.id));
      return drawn.map(row => row.depth).join(",") === "1,2,3,3,3";
    }, { timeout: 10_000, interval: 100, timeoutMsg: `the chain never nested: ${JSON.stringify(await rows())}` });

    const drawn = (await rows()).filter(row => chain.includes(row.id));
    expect(drawn.map(row => row.id)).toEqual(chain);
    await snap("subagent-rows-nested-depth-3.png");
  });

  it("a parent's chevron folds its subtree, and collapsing the task hides every row", async function () {
    this.timeout(30_000);
    const fold = `${rowSelector("e2ed1")} [data-testid="subagent-fold"]`;
    const storedBefore = await localStorageDump();
    await clickPresent(fold);

    await browser.waitUntil(async () => !(await rows()).some(row => row.id === "e2ed2"), {
      timeout: 5_000,
      timeoutMsg: "folding e2ed1 left its children on screen",
    });
    expect((await rows()).some(row => row.id === "e2ed1")).toBe(true);
    expect(await $(fold).getAttribute("aria-expanded")).toBe("false");
    // Fold state is in memory only.
    expect(await localStorageDump()).toBe(storedBefore);
    await snap("subagent-rows-folded.png");

    await clickPresent(fold);
    await browser.waitUntil(async () => (await rows()).some(row => row.id === "e2ed5"), {
      timeout: 5_000,
      timeoutMsg: "unfolding e2ed1 never brought its children back",
    });

    await setTaskCollapsed(true);
    await browser.waitUntil(async () => (await rows()).length === 0, {
      timeout: 5_000,
      timeoutMsg: "collapsing the task left subagent rows on screen",
    });
    await snap("subagent-rows-task-collapsed.png");
    await setTaskCollapsed(false);
    await browser.waitUntil(async () => (await rows()).length > 0, { timeout: 5_000 });

    const keys = (await localStorageDump()).split("\n").map(entry => entry.split("=")[0]);
    // The settings block persists its own prefs (subagentsEnabled and friends);
    // fold state is the one thing that must never reach storage.
    expect(keys.filter(key => /fold/i.test(key))).toEqual([]);
  });

  it("moves a row under a parent that arrives late without a frame of flicker", async function () {
    this.timeout(60_000);
    const parent = "e2ep1";
    const other = "e2ex1";
    const child = "e2ec1";
    for (const agentId of [parent, other, child]) await transcript(agentId, USER_LINE);
    for (const agentId of [parent, other, child]) await start(agentId);

    await browser.waitUntil(async () => {
      const ids = (await rows()).map(row => row.id);
      return [parent, other, child].every(id => ids.includes(id));
    }, { timeout: 10_000, timeoutMsg: "the three rows never appeared" });
    const flat = (await rows()).filter(row => [parent, other, child].includes(row.id));
    expect(flat.map(row => row.id)).toEqual([parent, other, child]);
    expect(flat.every(row => row.depth === "1")).toBe(true);

    await browser.execute((sel) => {
      const w = window as unknown as { __reparent?: { frames: number; bad: number; swapped: number; stop: boolean } };
      const first = document.querySelector(sel);
      const sample = { frames: 0, bad: 0, swapped: 0, stop: false };
      w.__reparent = sample;
      // Checked on every DOM commit rather than per rAF, which WebKit freezes
      // in the occluded harness window.
      const observer = new MutationObserver(() => {
        if (sample.stop) {
          observer.disconnect();
          return;
        }
        const found = document.querySelectorAll(sel);
        sample.frames++;
        if (found.length !== 1) sample.bad++;
        else if (found[0] !== first) sample.swapped++;
      });
      observer.observe(document.body, { childList: true, subtree: true, attributes: true });
    }, rowSelector(child));

    await meta(child, { agentType: "general-purpose", spawnDepth: 2, parentAgentId: parent });
    // The parent is read from disk on the tab's next hook event.
    await transcript(other, ANSWER_LINE);
    await stop(other);

    await browser.waitUntil(async () => {
      const drawn = (await rows()).find(row => row.id === child);
      return drawn?.depth === "2";
    }, { timeout: 10_000, interval: 50, timeoutMsg: "the late parent never moved the row" });

    const sample = await browser.execute(() => {
      const w = window as unknown as { __reparent: { frames: number; bad: number; swapped: number; stop: boolean } };
      w.__reparent.stop = true;
      return w.__reparent;
    });
    expect(sample.frames).toBeGreaterThan(0);
    expect(sample.bad).toBe(0);
    expect(sample.swapped).toBe(0);

    const moved = (await rows()).filter(row => [parent, other, child].includes(row.id));
    expect(moved.map(row => row.id)).toEqual([parent, child, other]);
  });

  it("keeps a workflow agent in the store but draws no row for it", async function () {
    this.timeout(30_000);
    const agentId = "e2ewf1";
    await start(agentId, "workflow-subagent");

    await browser.waitUntil(() => storeHasAgent(agentId), {
      timeout: 10_000,
      timeoutMsg: "the workflow agent never reached the store",
    });
    await waitPtyQuiet(taskId, 500);
    expect((await rows()).some(row => row.id === agentId)).toBe(false);
  });

  it("leaves the selection on the tab row, never on a subagent row or the header", async function () {
    this.timeout(30_000);
    const selection = await browser.execute((task) => {
      const sel = "bg-[var(--color-sel)]";
      const scope = document.querySelector(`[data-sidebar-task-row="${task}"]`)!;
      const header = scope.querySelector(`[data-sidebar-task-id="${task}"]`)!;
      const tabRow = scope.querySelector("div.ml-8")!;
      const subagentRows = [...scope.querySelectorAll('[data-testid="subagent-row"]')];
      return {
        header: header.className.includes(sel),
        tabRow: tabRow.className.includes(sel),
        subagents: subagentRows.filter(el => el.className.includes(sel)).length,
      };
    }, taskId);

    expect(selection).toEqual({ header: false, tabRow: true, subagents: 0 });
  });

  it("an agent still running when the parent exits flips to interrupted", async function () {
    this.timeout(30_000);
    const agentId = "e2eint1";
    await start(agentId);
    await waitRowState(agentId, "running");

    await browser.execute(async (id) => {
      const t = window.__termic!;
      const tab = t.useApp.getState().tabs[id].find((x: any) => x.type === "terminal");
      await t.invoke("pty_kill", { ptyId: tab.ptyId });
    }, taskId);

    await waitRowState(agentId, "interrupted");
    expect(await rowState("e2erun1")).toBe("done");
    await snap("subagent-row-interrupted.png");
  });
});
