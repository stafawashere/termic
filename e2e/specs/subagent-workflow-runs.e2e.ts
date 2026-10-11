// Workflow run nodes under a claude tab in the sidebar.
//
// A workflow agent is placed in its run only once a subagent_list refresh
// has read its files, so every agent here gets its transcript and sidecar
// (through the fake agent's #subagent-wf-* directives) before its start
// hook, and the run's state file (#workflow-state) is written first of all.
// The start hook is what triggers the refresh. Files land under a claude
// config dir inside the e2e profile, as in subagent-rows.e2e.ts.
//
// The claude terminal is not on screen while an agent's view is, so the
// spec brings the parent tab back to the front before any directive after
// opening one.

import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { dataDir } from "../../wdio.conf.js";
import {
  archiveTask,
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
const CONFIG_DIR = path.join(dataDir, "e2e-subagent-workflow-claude");
const AGENT_ROW = '[data-testid="subagent-row"]';
const RUN_ROW = '[data-testid="workflow-run-row"]';
const PHASE_ROW = '[data-testid="workflow-phase-row"]';
const PANE = '[data-testid="subagent-pane"]';
/** Every tree row, task header to subagent, wears the one selected look. */
const SELECTED = "sidebar-selected";
const ROW_SELECTED = SELECTED;

const RELEASE_RUN = "wf_e2erelease";
const RELEASE_NAME = "acme-release";
const RELEASE_STATE = `{"workflowName":"${RELEASE_NAME}","phases":[{"title":"Plan"},{"title":"Build"}]}`;
const BUILD_AGENT = "e2ewbuild";
const PLAN_AGENT = "e2ewplan";
const LOOSE_AGENT = "e2ewloose";
const RELEASE_AGENTS = [BUILD_AGENT, PLAN_AGENT, LOOSE_AGENT];

const ORPHAN_RUN = "wf_e2eorphan";
const ORPHAN_AGENT = "e2eworphan";

const WORKFLOW_TYPE = "workflow-subagent";

const userLine = (text: string) => JSON.stringify({ type: "user", message: { role: "user", content: text } });
const ANSWER_LINE =
  '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"all done"}],"stop_reason":"end_turn"}}';
const ERROR_LINE =
  '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"boom","is_error":true}]}}';

interface DrawnRow {
  kind: "run" | "phase" | "agent";
  id: string;
  label: string;
  depth: string;
  left: number;
  icon: string | null;
  iconLeft: number;
  labelLeft: number;
  height: number;
}

describe("subagent workflow runs", () => {
  let taskId!: string;
  let parentTabId!: string;
  let sessionId!: string;
  let sessionDir!: string;
  let originalEnv: Record<string, string> | null = null;

  const scoped = (selector: string) => `[data-sidebar-task-row="${taskId}"] ${selector}`;
  const runRow = (runId: string) => scoped(`${RUN_ROW}[data-run-id="${runId}"]`);
  const agentRow = (agentId: string) => scoped(`${AGENT_ROW}[data-agent-id="${agentId}"]`);
  const paneSelector = (agentId: string) => `${PANE}[data-agent-id="${agentId}"]`;
  const switchIn = (testId: string) => `[data-testid="${testId}"] button[role="switch"]`;

  async function directive(line: string): Promise<void> {
    await submitToAgent(taskId, line);
  }

  async function waitForFile(file: string, contains: string): Promise<void> {
    await browser.waitUntil(
      async () => existsSync(file) && readFileSync(file, "utf8").includes(contains),
      {
        timeout: 10_000,
        interval: 100,
        timeoutMsg: `the fake agent never wrote ${path.relative(sessionDir, file)}`,
      },
    );
  }

  async function runState(runId: string, body: string): Promise<void> {
    await directive(`#workflow-state ${runId} ${body}`);
    await waitForFile(path.join(sessionDir, "workflows", `${runId}.json`), body);
  }

  async function runTranscript(runId: string, agentId: string, line: string): Promise<void> {
    await directive(`#subagent-wf-jsonl ${runId} ${agentId} ${line}`);
    await waitForFile(path.join(sessionDir, "subagents", "workflows", runId, `agent-${agentId}.jsonl`), line);
  }

  async function runMeta(runId: string, agentId: string, phase: string | null): Promise<void> {
    const fields = phase === null
      ? { agentType: WORKFLOW_TYPE }
      : { agentType: WORKFLOW_TYPE, workflowPhase: phase };
    const body = JSON.stringify(fields);
    await directive(`#subagent-wf-meta ${runId} ${agentId} ${body}`);
    await waitForFile(path.join(sessionDir, "subagents", "workflows", runId, `agent-${agentId}.meta.json`), body);
  }

  const start = (agentId: string) => directive(`#subagent start ${sessionId} ${agentId} ${WORKFLOW_TYPE}`);
  const stop = (agentId: string) => directive(`#subagent stop ${sessionId} ${agentId} ${WORKFLOW_TYPE}`);

  async function parentToFront(): Promise<void> {
    await browser.execute(
      (task, tab) => window.__termic!.useApp.getState().setActiveTabId(task, tab),
      taskId,
      parentTabId,
    );
  }

  /** Every run, phase and agent row of the task, in DOM order. */
  async function drawnRows(): Promise<DrawnRow[]> {
    return browser.execute((task, runSel, phaseSel, agentSel) => {
      const scope = document.querySelector(`[data-sidebar-task-row="${task}"]`);
      if (!scope) return [];

      return [...scope.querySelectorAll<HTMLElement>(`${runSel}, ${phaseSel}, ${agentSel}`)].map(el => {
        const testId = el.getAttribute("data-testid");
        const kind = testId === "workflow-run-row" ? "run" : testId === "workflow-phase-row" ? "phase" : "agent";
        const id = el.getAttribute("data-run-id") ?? el.getAttribute("data-phase-key") ?? el.getAttribute("data-agent-id") ?? "";
        const icon = el.querySelector<HTMLElement>('[data-testid="subagent-row-icon"]');
        return {
          kind,
          id,
          label: (el.textContent ?? "").trim(),
          depth: el.getAttribute("data-depth") ?? "",
          // Content start: the rows span the panel and indent by padding.
          left: el.getBoundingClientRect().left + parseFloat(getComputedStyle(el).paddingLeft),
          icon: icon?.getAttribute("data-icon") ?? null,
          iconLeft: icon?.getBoundingClientRect().left ?? -1,
          labelLeft: el.querySelector("span.truncate")!.getBoundingClientRect().left,
          height: el.getBoundingClientRect().height,
        } as DrawnRow;
      });
    }, taskId, RUN_ROW, PHASE_ROW, AGENT_ROW);
  }

  async function runFacts(runId: string) {
    return browser.execute((sel) => {
      const row = document.querySelector<HTMLElement>(sel);
      if (!row) return null;
      return {
        state: row.getAttribute("data-run-state"),
        expanded: row.getAttribute("aria-expanded"),
        name: row.querySelector("span[title]")?.textContent ?? "",
        count: row.querySelector('[data-testid="workflow-run-count"]')?.textContent ?? "",
        badge: row.querySelector('[data-testid="workflow-run-badge"]')?.getAttribute("data-run-state") ?? null,
        className: row.className,
      };
    }, runRow(runId));
  }

  async function waitRun(runId: string, check: (facts: NonNullable<Awaited<ReturnType<typeof runFacts>>>) => boolean, why: string): Promise<void> {
    await browser.waitUntil(async () => {
      const facts = await runFacts(runId);
      return !!facts && check(facts);
    }, {
      timeout: 10_000,
      interval: 50,
      timeoutMsg: `${why}: ${JSON.stringify(await runFacts(runId))}`,
    });
  }

  /** The row's background once its colour transition has finished, so a
   *  screenshot taken next shows the selection rather than a frame of it. */
  /** The selection is a gradient over the row (`.sidebar-selected`), so it
   *  is read from background-image; background-color stays transparent. */
  async function settledSelectionPaint(selector: string): Promise<string> {
    await browser.waitUntil(
      () => browser.execute((sel) => {
        const el = document.querySelector(sel);
        return !!el && el.getAnimations().length === 0;
      }, selector),
      { timeout: 5_000, interval: 25, timeoutMsg: `${selector} never finished its transition` },
    );
    return browser.execute((sel) => getComputedStyle(document.querySelector(sel)!).backgroundImage, selector);
  }

  async function setWorkflowFilterBySwitch(): Promise<void> {
    await browser.execute(() => window.__termic!.useApp.getState().openSettings("tasks"));
    await clickPresent(switchIn("subagent-setting-type-workflow"));
    await browser.execute(() => window.__termic!.useApp.getState().closeSettings());
  }

  before(async function () {
    this.timeout(180_000);
    await waitForAppShell();
    await requireTermicApi();
    rmSync(CONFIG_DIR, { recursive: true, force: true });
    await browser.execute(() => {
      const p = window.__termic!.usePrefs.getState();
      p.setSubagentsEnabled(true);
      p.setSubagentTypeFilter("workflow", true);
      p.setSubagentRetention("session");
      p.setSubagentAutoCollapse("never");
    });

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
    taskId = await openTask("e2e-subagent-workflow", true, CLI);
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
      return { sessionId: tab.sessionId as string, tabId: tab.id as string, taskPath: task.path as string };
    }, taskId);
    sessionId = facts.sessionId;
    parentTabId = facts.tabId;
    const slug = facts.taskPath.replace(/[^A-Za-z0-9]/g, "-");
    sessionDir = path.join(CONFIG_DIR, "projects", slug, sessionId);

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
    await browser.execute(() => {
      window.__termic!.usePrefs.getState().setSubagentTypeFilter("workflow", true);
      window.__termic!.useApp.getState().closeSettings();
      window.__termic!.useSubagentFold.setState({ byTab: {}, openRunsByTab: {}, groupByTab: {} });
    });
    await setHooksOwnState(CLI, false);
    await setWindowPresence(true);
    if (taskId) await archiveTask(taskId);
    rmSync(CONFIG_DIR, { recursive: true, force: true });
  });

  it("draws a run as one collapsed row named by its state file, with no agent rows", async function () {
    this.timeout(90_000);
    await runState(RELEASE_RUN, RELEASE_STATE);
    await runTranscript(RELEASE_RUN, BUILD_AGENT, userLine("build the acme bundle"));
    await runTranscript(RELEASE_RUN, PLAN_AGENT, userLine("plan the acme release"));
    await runTranscript(RELEASE_RUN, LOOSE_AGENT, userLine("tidy up"));
    await runMeta(RELEASE_RUN, BUILD_AGENT, "Build");
    await runMeta(RELEASE_RUN, PLAN_AGENT, "Plan");
    await runMeta(RELEASE_RUN, LOOSE_AGENT, null);
    for (const agentId of RELEASE_AGENTS) await start(agentId);

    await waitRun(
      RELEASE_RUN,
      facts => facts.name === RELEASE_NAME && facts.count === "3/3",
      "the run row never showed its name and three running agents",
    );
    const facts = (await runFacts(RELEASE_RUN))!;
    expect(facts.expanded).toBe("false");
    expect(facts.state).toBe("running");
    expect(facts.badge).toBe("running");

    const rows = await drawnRows();
    expect(rows.filter(row => row.kind === "run").map(row => row.id)).toEqual([RELEASE_RUN]);
    expect(rows.filter(row => row.kind !== "run")).toEqual([]);
    await snap("workflow-run-collapsed.png");
  });

  it("labels a run with no state file by its run id", async function () {
    this.timeout(60_000);
    await runTranscript(ORPHAN_RUN, ORPHAN_AGENT, userLine("check the acme docs"));
    await runMeta(ORPHAN_RUN, ORPHAN_AGENT, "Check");
    await start(ORPHAN_AGENT);

    await waitRun(ORPHAN_RUN, facts => facts.count === "1/1", "the run without a state file never drew");
    expect((await runFacts(ORPHAN_RUN))!.name).toBe(ORPHAN_RUN);
    expect(existsSync(path.join(sessionDir, "workflows", `${ORPHAN_RUN}.json`))).toBe(false);
  });

  it("expanding a run lists its phases in the state file's order, agents under them, and the no-phase agent last", async function () {
    this.timeout(30_000);
    await clickPresent(`${runRow(RELEASE_RUN)} [data-testid="workflow-run-fold"]`);
    await waitRun(RELEASE_RUN, facts => facts.expanded === "true", "the run never opened");

    await browser.waitUntil(async () => (await drawnRows()).some(row => row.id === LOOSE_AGENT), {
      timeout: 5_000,
      timeoutMsg: "opening the run never drew its agents",
    });
    const rows = await drawnRows();
    // The build agent started first, but Plan comes first in the state file.
    expect(rows.map(row => `${row.kind}:${row.kind === "phase" ? row.label : row.id}`)).toEqual([
      `run:${RELEASE_RUN}`,
      "phase:Plan",
      `agent:${PLAN_AGENT}`,
      "phase:Build",
      `agent:${BUILD_AGENT}`,
      `agent:${LOOSE_AGENT}`,
      `run:${ORPHAN_RUN}`,
    ]);

    const byId = (id: string) => rows.find(row => row.id === id || row.label === id)!;
    const run = byId(RELEASE_RUN);
    const plan = byId("Plan");
    const phased = byId(PLAN_AGENT);
    const loose = byId(LOOSE_AGENT);
    expect(plan.left).toBeGreaterThan(run.left);
    expect(phased.left).toBeGreaterThan(plan.left);
    expect(loose.left).toBe(plan.left);
    expect(byId(BUILD_AGENT).left).toBe(phased.left);
    expect(byId(ORPHAN_RUN).left).toBe(run.left);

    const iconOf = (row: DrawnRow) => row.icon;
    expect(rows.map(iconOf)).toEqual(["workflow", "layers", "bot", "layers", "bot", "bot", "workflow"]);
    // Every kind leads with its icon the same distance into the row, so a
    // phase and the loose agent beside it line up icon for icon and label
    // for label.
    const iconInset = run.iconLeft - run.left;
    expect(rows.every(row => row.iconLeft - row.left === iconInset)).toBe(true);
    expect(loose.iconLeft).toBe(plan.iconLeft);
    expect(loose.labelLeft).toBe(plan.labelLeft);
    expect(phased.labelLeft - plan.labelLeft).toBe(plan.labelLeft - run.labelLeft);
    expect(new Set(rows.map(row => row.height)).size).toBe(1);
    await snap("workflow-run-expanded.png");
  });

  it("opens a workflow agent's transcript from its row, and a run folded over it draws the selection", async function () {
    this.timeout(60_000);
    await clickPresent(agentRow(BUILD_AGENT));

    await browser.waitUntil(async () => {
      const text = await browser.execute((sel) => document.querySelector(sel)?.textContent ?? "", paneSelector(BUILD_AGENT));
      return text.includes("build the acme bundle");
    }, { timeout: 10_000, interval: 50, timeoutMsg: "the workflow agent's view never showed its transcript" });

    const openTab = await browser.execute((task) => {
      const s = window.__termic!.useApp.getState();
      const active = (s.tabs[task] ?? []).find((t: any) => t.id === s.activeTab[task]);
      return { type: active?.type ?? null, agentId: active?.subagentAgentId ?? null };
    }, taskId);
    expect(openTab).toEqual({ type: "subagent", agentId: BUILD_AGENT });
    expect(await browser.execute((sel) => document.querySelector(sel)?.className ?? "", agentRow(BUILD_AGENT)))
      .toContain(SELECTED);
    const selectedBackground = await settledSelectionPaint(agentRow(BUILD_AGENT));
    expect(selectedBackground).toContain("linear-gradient");
    await snap("workflow-agent-open.png");

    await clickPresent(`${runRow(RELEASE_RUN)} [data-testid="workflow-run-fold"]`);
    await waitRun(RELEASE_RUN, facts => facts.expanded === "false", "the run never folded");

    const selection = await browser.execute((task, sel, rowSel) => {
      const scope = document.querySelector(`[data-sidebar-task-row="${task}"]`)!;
      const header = scope.querySelector(`[data-sidebar-task-id="${task}"]`)!;
      const tabRow = scope.querySelector("[data-sidebar-tab-id]")!;
      const selectedRuns = [...scope.querySelectorAll('[data-testid="workflow-run-row"]')]
        .filter(el => el.className.includes(sel))
        .map(el => el.getAttribute("data-run-id"));
      return { header: header.className.includes(rowSel), tabRow: tabRow.className.includes(rowSel), selectedRuns };
    }, taskId, SELECTED, ROW_SELECTED);
    expect(selection).toEqual({ header: false, tabRow: false, selectedRuns: [RELEASE_RUN] });
    expect(await settledSelectionPaint(runRow(RELEASE_RUN))).toBe(selectedBackground);
    await snap("workflow-run-folded-over-selection.png");

    await parentToFront();
    await browser.waitUntil(
      async () => !((await runFacts(RELEASE_RUN))!.className.includes(SELECTED)),
      { timeout: 5_000, timeoutMsg: "the run kept the selection after the claude tab came back to the front" },
    );
    const tabRowSelected = await browser.execute(
      (task, sel) => document.querySelector(`[data-sidebar-task-row="${task}"] [data-sidebar-tab-id]`)!.className.includes(sel),
      taskId,
      ROW_SELECTED,
    );
    expect(tabRowSelected).toBe(true);
  });

  it("a run is done once every agent stops on an answer, and failed when one fails", async function () {
    this.timeout(90_000);
    await parentToFront();
    for (const agentId of RELEASE_AGENTS) await runTranscript(RELEASE_RUN, agentId, ANSWER_LINE);
    for (const agentId of RELEASE_AGENTS) await stop(agentId);

    await waitRun(RELEASE_RUN, facts => facts.state === "done", "stopping every agent never made the run done");
    const done = (await runFacts(RELEASE_RUN))!;
    expect(done.count).toBe("0/3");
    expect(done.badge).toBe("done");

    await runTranscript(ORPHAN_RUN, ORPHAN_AGENT, ERROR_LINE);
    await stop(ORPHAN_AGENT);
    await waitRun(ORPHAN_RUN, facts => facts.state === "failed", "a failed agent never made its run failed");
    expect((await runFacts(ORPHAN_RUN))!.badge).toBe("failed");
    expect((await runFacts(RELEASE_RUN))!.state).toBe("done");
  });

  it("the workflow filter removes every run row with no reload and brings them back", async function () {
    this.timeout(60_000);
    const runIds = async () => (await drawnRows()).filter(row => row.kind === "run").map(row => row.id);
    expect(await runIds()).toEqual([RELEASE_RUN, ORPHAN_RUN]);
    const loadedAt = await browser.execute(() => performance.timeOrigin);

    await setWorkflowFilterBySwitch();
    await browser.waitUntil(async () => (await drawnRows()).length === 0, {
      timeout: 5_000,
      timeoutMsg: "turning the workflow filter off left run rows behind",
    });
    expect(await browser.execute(
      () => window.__termic!.usePrefs.getState().subagentTypeFilter.workflow as boolean)).toBe(false);

    await setWorkflowFilterBySwitch();
    await browser.waitUntil(async () => (await runIds()).join(",") === `${RELEASE_RUN},${ORPHAN_RUN}`, {
      timeout: 5_000,
      timeoutMsg: "turning the workflow filter back on did not bring the run rows back",
    });
    expect(await browser.execute(() => performance.timeOrigin)).toBe(loadedAt);
  });
});
