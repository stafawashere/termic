// The sidebar's workspace view (docs/ui.md "The sidebar's workspace view"):
// a named, saved set of projects with one active, kept in localStorage. Covers
// creating one, adding and removing projects through the manager, renaming,
// deleting, swapping to the workspace view and back, the persisted active id,
// a removed project leaving every set, and both empty states.
//
// Two throwaway repos are added as projects so the spec never depends on what
// earlier files left in the shared profile. Assertions on the tree are about
// those two projects being listed or not, never a total.

import { execSync } from "node:child_process";
import { mkdtempSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  dismissOverlays,
  requireTermicApi,
  rmTree,
  setInputValue,
  snap,
  waitForAppShell,
  waitGone,
  waitVisible,
} from "../helpers.js";

const VIEW_TOGGLE = '[data-testid="sidebar-workspace-view"]';
const SECTION = '[data-testid="workspace-section"]';
const CHIP = '[data-testid="workspace-chip"]';
const MANAGE = '[data-testid="workspace-manage"]';
const MANAGER = '[data-testid="workspace-manager"]';
const NEW_NAME = '[data-testid="workspace-new-name"]';
const NEW_CREATE = '[data-testid="workspace-new-create"]';
const RENAME_INPUT = '[data-testid="workspace-rename-input"]';
const RENAME_SAVE = '[data-testid="workspace-rename-save"]';
const DELETE = '[data-testid="workspace-delete"]';
const DELETE_CONFIRM = '[data-testid="workspace-delete-confirm"]';
const DELETE_CANCEL = '[data-testid="workspace-delete-cancel"]';
const EYEBROW = '[data-testid="sidebar-section-eyebrow"]';
const CLOSE_MANAGER = '[data-testid="workspace-manager-close"]';
const EMPTY_NONE = '[data-testid="workspace-empty-none"]';
const EMPTY_PROJECTS = '[data-testid="workspace-empty-projects"]';

const click = (sel: string) =>
  browser.execute(s => (document.querySelector(s) as HTMLElement).click(), sel);

const present = (sel: string) => browser.execute(s => !!document.querySelector(s), sel);

const chipNames = () =>
  browser.execute(sel => [...document.querySelectorAll<HTMLElement>(sel)].map(el => el.textContent), CHIP);

const activeChip = () =>
  browser.execute(sel => document.querySelector<HTMLElement>(`${sel}[data-active]`)?.textContent ?? null, CHIP);

const sidebarView = () =>
  browser.execute(() => window.__termic!.usePrefs.getState().sidebarView);

const storedKey = (key: string) =>
  browser.execute(k => localStorage.getItem(k), key);

/** Project names the sidebar tree lists, by their header rows. */
const treeProjectIds = () =>
  browser.execute(() =>
    [...document.querySelectorAll<HTMLElement>("aside [data-project-id]")].map(el => el.dataset.projectId!));

const waitTree = (predicate: (ids: string[]) => boolean, msg: string) =>
  browser.waitUntil(async () => predicate(await treeProjectIds()), { timeout: 8_000, timeoutMsg: msg });

const workspacesInStore = () =>
  browser.execute(() => {
    const raw = localStorage.getItem("workspaces");
    return raw ? (JSON.parse(raw) as Array<{ id: string; name: string; projectIds: string[] }>) : [];
  });

const toggleProjectInManager = async (projectId: string) => {
  await browser.execute(id => {
    const row = document.querySelector(`[data-workspace-project-id="${id}"] [data-testid="workspace-project-toggle"]`);
    (row as HTMLElement).click();
  }, projectId);
};

const projectChecked = (projectId: string) =>
  browser.execute(id => document
    .querySelector(`[data-workspace-project-id="${id}"] [data-testid="workspace-project-toggle"]`)
    ?.getAttribute("aria-checked") === "true", projectId);

const createWorkspace = async (name: string) => {
  await setInputValue(NEW_NAME, name);
  await click(NEW_CREATE);
};

describe("sidebar workspaces", () => {
  const dirs: string[] = [];
  const projectIds: string[] = [];
  let alpha = "";
  let bravo = "";

  const addProject = async (): Promise<string> => {
    const dir = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "e2e-ws-")));
    execSync(
      `git -C "${dir}" init -q && git -C "${dir}" -c user.email=e2e@termic.dev -c user.name=e2e commit -q --allow-empty -m init`,
    );
    dirs.push(dir);
    const project = await browser.execute(async d => await window.__termic!.ipc.projectAdd(d), dir);
    const id = (project as { id: string }).id;
    projectIds.push(id);
    return id;
  };

  before(async () => {
    await waitForAppShell();
    await requireTermicApi();
    await browser.execute(() => {
      const t = window.__termic!;
      if (t.useApp.getState().compactSidebar) t.useApp.getState().toggleCompactSidebar();
      t.usePrefs.getState().setSidebarView("tree");
    });
    alpha = await addProject();
    bravo = await addProject();
    await browser.execute(() => window.__termic!.useApp.getState().loadAll());
    await browser.waitUntil(
      () => browser.execute((a, b) => {
        const ids = window.__termic!.useApp.getState().projects.map((p: any) => p.id);
        return ids.includes(a) && ids.includes(b);
      }, alpha, bravo),
      { timeout: 8_000, timeoutMsg: "added projects never appeared" },
    );
  });

  after(async () => {
    await dismissOverlays();
    await browser.execute(async ids => {
      const t = window.__termic!;
      t.usePrefs.getState().setSidebarView("tree");
      for (const id of ids) await t.ipc.projectRemove(id).catch(() => {});
      await t.useApp.getState().loadAll();
    }, projectIds);
    await browser.execute(() => {
      localStorage.removeItem("workspaces");
      localStorage.removeItem("activeWorkspace");
    });
    for (const dir of dirs) rmTree(dir, { bestEffort: true });
  });

  it("swaps into the workspace view and back, and says there are no workspaces", async () => {
    await waitVisible(VIEW_TOGGLE);
    expect(await present(SECTION)).toBe(false);

    await click(VIEW_TOGGLE);
    await waitVisible(SECTION);
    expect(await sidebarView()).toBe("workspace");
    await waitVisible(EMPTY_NONE);
    expect(await treeProjectIds()).toEqual([]);
    const eyebrow = await browser.execute(sel => {
      const el = document.querySelector<HTMLElement>(sel)!;
      return { text: el.textContent, clipped: el.scrollWidth > el.clientWidth };
    }, EYEBROW);
    expect(eyebrow).toEqual({ text: "Workspaces", clipped: false });
    await snap("sidebar-workspaces-none.png");

    await click(VIEW_TOGGLE);
    await waitGone(SECTION);
    expect(await sidebarView()).toBe("tree");
    await waitTree(ids => ids.includes(alpha) && ids.includes(bravo), "tree did not come back with both projects");
  });

  it("creates a workspace from the manager and makes it the active one", async () => {
    await click(VIEW_TOGGLE);
    await waitVisible(SECTION);
    await click(MANAGE);
    await waitVisible(MANAGER);
    await createWorkspace("Alpha team");

    await browser.waitUntil(async () => (await chipNames()).includes("Alpha team"), {
      timeout: 8_000, timeoutMsg: "the new workspace chip never appeared",
    });
    expect(await activeChip()).toBe("Alpha team");
    expect((await workspacesInStore()).map(w => w.name)).toEqual(["Alpha team"]);
    await waitGone(EMPTY_NONE);
    await waitVisible(EMPTY_PROJECTS);
    await snap("sidebar-workspaces-empty-workspace.png");
  });

  it("adds projects through the manager and the tree shows only those", async () => {
    expect(await projectChecked(alpha)).toBe(false);
    await toggleProjectInManager(alpha);
    await browser.waitUntil(() => projectChecked(alpha), { timeout: 5_000, timeoutMsg: "alpha never checked" });
    await snap("sidebar-workspaces-manager.png");

    await click(CLOSE_MANAGER);
    await waitGone(MANAGER);
    await waitTree(ids => ids.includes(alpha) && !ids.includes(bravo), "tree did not narrow to the workspace");
    await waitGone(EMPTY_PROJECTS);
    await snap("sidebar-workspaces-one-project.png");

    await click(MANAGE);
    await waitVisible(MANAGER);
    await toggleProjectInManager(bravo);
    await browser.waitUntil(() => projectChecked(bravo), { timeout: 5_000, timeoutMsg: "bravo never checked" });
    await click(CLOSE_MANAGER);
    await waitGone(MANAGER);
    await waitTree(ids => ids.includes(alpha) && ids.includes(bravo), "tree did not grow with the second project");
  });

  it("removing a project from the workspace drops it from the tree but not from the app", async () => {
    await click(MANAGE);
    await waitVisible(MANAGER);
    await toggleProjectInManager(alpha);
    await browser.waitUntil(async () => !(await projectChecked(alpha)), { timeout: 5_000, timeoutMsg: "alpha stayed checked" });
    await click(CLOSE_MANAGER);
    await waitGone(MANAGER);

    await waitTree(ids => !ids.includes(alpha) && ids.includes(bravo), "alpha stayed in the tree");
    const stillAProject = await browser.execute(
      id => window.__termic!.useApp.getState().projects.some((p: any) => p.id === id), alpha);
    expect(stillAProject).toBe(true);
  });

  it("renames the workspace", async () => {
    await click(MANAGE);
    await waitVisible(MANAGER);
    await setInputValue(RENAME_INPUT, "Platform");
    await click(RENAME_SAVE);
    await click(CLOSE_MANAGER);
    await waitGone(MANAGER);

    await browser.waitUntil(async () => (await activeChip()) === "Platform", {
      timeout: 8_000, timeoutMsg: "the chip kept the old name",
    });
    expect((await workspacesInStore()).map(w => w.name)).toEqual(["Platform"]);
  });

  // A real reload would end this spec's session (see codenav.e2e.ts), so this
  // pins what the next boot reads: the stored active id names the workspace on
  // screen. The boot path itself is src/store/workspaces.test.ts "reload".
  it("stores the active workspace and the view for the next launch", async () => {
    const stored = await workspacesInStore();
    const activeId = await storedKey("activeWorkspace");
    expect(stored.find(w => w.id === activeId)?.name).toBe("Platform");
    expect(await storedKey("sidebarView")).toBe("workspace");
  });

  it("switches between workspaces", async () => {
    await click(MANAGE);
    await waitVisible(MANAGER);
    await createWorkspace("Second");
    await click(CLOSE_MANAGER);
    await waitGone(MANAGER);

    await browser.waitUntil(async () => (await activeChip()) === "Second", { timeout: 8_000, timeoutMsg: "Second never became active" });
    await waitVisible(EMPTY_PROJECTS);
    expect(await treeProjectIds()).toEqual([]);

    await browser.execute(sel => {
      const chip = [...document.querySelectorAll<HTMLElement>(sel)].find(el => el.textContent === "Platform");
      chip!.click();
    }, CHIP);
    await browser.waitUntil(async () => (await activeChip()) === "Platform", { timeout: 8_000, timeoutMsg: "Platform did not come back" });
    await waitTree(ids => ids.includes(bravo), "Platform's project did not come back");
  });

  it("a load that merely lacks a project does not prune it", async () => {
    await browser.execute(bravoId => {
      const t = window.__termic!;
      t.useApp.setState({ projects: t.useApp.getState().projects.filter((p: any) => p.id !== bravoId) });
    }, bravo);
    await waitTree(ids => !ids.includes(bravo), "the filtered project list did not reach the tree");
    expect((await workspacesInStore()).some(w => w.projectIds.includes(bravo))).toBe(true);

    await browser.execute(() => window.__termic!.useApp.getState().loadAll());
    await waitTree(ids => ids.includes(bravo), "the project did not come back with the next load");
  });

  it("removes a deleted project from every workspace", async () => {
    await browser.execute(async id => {
      const t = window.__termic!;
      await t.ipc.projectRemove(id);
      await t.useApp.getState().loadAll();
    }, bravo);

    await browser.waitUntil(async () => {
      const sets = await workspacesInStore();
      return sets.every(w => !w.projectIds.includes(bravo));
    }, { timeout: 8_000, timeoutMsg: "the removed project stayed in a workspace" });
    await waitVisible(EMPTY_PROJECTS);
    await snap("sidebar-workspaces-pruned.png");
  });

  it("asks inline before deleting, then falls back to the workspace that is left", async () => {
    await click(MANAGE);
    await waitVisible(MANAGER);

    await click(DELETE);
    await waitVisible(DELETE_CONFIRM);
    expect(await chipNames()).toHaveLength(2);
    await snap("sidebar-workspaces-delete-confirm.png");

    await click(DELETE_CANCEL);
    await waitGone(DELETE_CONFIRM);
    await waitVisible(DELETE);
    expect(await chipNames()).toHaveLength(2);

    await click(DELETE);
    await click(DELETE_CONFIRM);
    await browser.waitUntil(async () => (await chipNames()).length === 1, { timeout: 8_000, timeoutMsg: "the workspace was not deleted" });
    await click(CLOSE_MANAGER);
    await waitGone(MANAGER);

    expect(await chipNames()).toEqual(["Second"]);
    expect(await activeChip()).toBe("Second");
    expect((await workspacesInStore()).map(w => w.name)).toEqual(["Second"]);
  });

  it("goes back to the empty state when the last workspace is deleted", async () => {
    await click(MANAGE);
    await waitVisible(MANAGER);
    await click(DELETE);
    await click(DELETE_CONFIRM);
    await waitVisible('[data-testid="workspace-manager-empty"]');
    await click(CLOSE_MANAGER);
    await waitGone(MANAGER);

    await waitVisible(EMPTY_NONE);
    expect(await chipNames()).toEqual([]);
    expect(await storedKey("activeWorkspace")).toBeNull();
    await click(VIEW_TOGGLE);
    await waitGone(SECTION);
  });
});
