import { readFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "../../wdio.conf.js";
import {
  archiveTask,
  dismissOverlays,
  openTask,
  requireTermicApi,
  submitToAgent,
  waitForAgentReady,
  waitForAppShell,
  waitForWorkBadge,
} from "../helpers.js";

// "Keep agents running" puts agent PTYs in termic-ptyd, so a webview that
// goes away and comes back finds its agent still running and attaches to it
// instead of spawning a second one. A webview reload is the restart here: it
// throws away every mounted pane and all frontend state without running a
// single unmount, which is what a quit does to the frontend, while the Rust
// side keeps the adoption a reattach has to cope with.
describe("pty daemon reattach", () => {
  let taskId: string | null = null;

  function spawnCount(id: string): number {
    const raw = readFileSync(join(dataDir, "e2e-agent-argv.log"), "utf8");
    return raw.split("\n").filter(l => l.startsWith(id + "\t")).length;
  }

  const setDaemon = (on: boolean) => browser.execute(async (v) => {
    const t = window.__termic!;
    const s = await t.invoke("settings_load");
    await t.invoke("settings_save", { s: { ...(s as object), pty_daemon_enabled: v } });
    if (v) await t.ipc.ptyDaemonWarm();
  }, on);

  const ptyId = (id: string) => browser.execute(
    (t) => ((window.__termic!.useApp.getState().tabs[t] ?? [])[0]?.ptyId ?? null) as string | null, id);

  const tabId = (id: string) => browser.execute(
    (t) => (window.__termic!.useApp.getState().tabs[t] ?? [])[0]?.id as string, id);

  const livePid = (id: string, tab: string) => browser.execute(
    async (t, b) => ((await window.__termic!.ipc.ptyDaemonFind(t, b)) as { pid: number | null } | null)?.pid ?? null,
    id, tab) as unknown as Promise<number | null>;

  async function reloadAndOpen(id: string) {
    await browser.refresh();
    await waitForAppShell();
    await requireTermicApi();
    await dismissOverlays();
    await browser.execute(async (t) => {
      const s = window.__termic!.useApp.getState();
      await s.loadAll();
      window.__termic!.useApp.getState().setActiveTask(t);
    }, id);
  }

  const waitPty = (id: string, differentFrom: string | null) => browser.waitUntil(async () => {
    const cur = await ptyId(id);
    return !!cur && cur !== differentFrom;
  }, { timeout: 30_000, timeoutMsg: "the tab never got a PTY" });

  after(async () => {
    await setDaemon(false);
    if (taskId) await archiveTask(taskId);
  });

  it("reattaches to the running agent after a reload instead of spawning", async () => {
    await waitForAppShell();
    await requireTermicApi();
    await setDaemon(true);
    taskId = await openTask("e2e-ptyd", true, "fakeclaude");
    const id = taskId;
    await waitForAgentReady(id);
    const before = await ptyId(id);
    const tab = await tabId(id);
    await browser.waitUntil(async () => (await livePid(id, tab)) !== null,
      { timeout: 15_000, timeoutMsg: "the agent never reached the daemon" });
    const pid = await livePid(id, tab);
    const spawns = spawnCount(id);

    await reloadAndOpen(id);
    await browser.waitUntil(async () => (await ptyId(id)) === before,
      { timeout: 30_000, timeoutMsg: "the tab did not reattach to its daemon PTY" });
    expect(spawnCount(id)).toBe(spawns);
    expect(await livePid(id, tab)).toBe(pid);

    // The live stream is back: a submit reaches the same process and its
    // title change reaches the tab.
    await waitForAgentReady(id);
    await submitToAgent(id, "after the reload");
    await waitForWorkBadge(id, "working");
    expect(spawnCount(id)).toBe(spawns);
  });

  it("spawns a new agent on restart after the old one exited", async () => {
    const id = taskId!;
    const before = await ptyId(id);
    const spawns = spawnCount(id);
    await browser.execute((p) => window.__termic!.ipc.ptyWrite(p, [3]), before!);
    await browser.waitUntil(async () => (await ptyId(id)) === null,
      { timeout: 15_000, timeoutMsg: "the agent never exited" });

    await browser.execute((t) => {
      const s = window.__termic!.useApp.getState();
      const tab = (s.tabs[t] ?? [])[0] as any;
      s.patchTab(t, tab.id, { respawnKick: (tab.respawnKick ?? 0) + 1 });
    }, id);
    await waitPty(id, before);
    await browser.waitUntil(async () => spawnCount(id) === spawns + 1,
      { timeout: 15_000, timeoutMsg: "the restart did not spawn" });
    await waitForAgentReady(id);
  });

  it("spawns rather than attaches when the setting is off", async () => {
    const id = taskId!;
    const before = await ptyId(id);
    const tab = await tabId(id);
    const spawns = spawnCount(id);
    await setDaemon(false);

    await reloadAndOpen(id);
    await waitPty(id, before);
    await browser.waitUntil(async () => spawnCount(id) === spawns + 1,
      { timeout: 15_000, timeoutMsg: "turning the setting off did not spawn" });
    expect(await livePid(id, tab)).toBeNull();
    await waitForAgentReady(id);

    // The agent the daemon still holds belongs to nobody now.
    await browser.execute((p) => window.__termic!.ipc.ptyKill(p), before!);
  });
});
