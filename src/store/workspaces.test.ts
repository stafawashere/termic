// Workspace store: what survives a bad blob, what a removed project takes with
// it, which workspace becomes active after a delete, and that no-op actions do
// not churn subscribers.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { useWorkspaces, parseWorkspaces, withoutProject, resolveActiveId } from "./workspaces";
import { useApp } from "./app";
import { scoped } from "@/lib/profileScope";

// Map-backed stub for the same reason as pinnedFolders.test.ts: Node's own
// experimental localStorage global is unusable without --localstorage-file.
function fakeLocalStorage() {
  const store = new Map<string, string>();
  return {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => { store.clear(); },
  };
}

const project = (id: string) => ({ id }) as never;
const storedWorkspaces = () => JSON.parse(localStorage.getItem(scoped("workspaces")) || "[]");
const storedActive = () => localStorage.getItem(scoped("activeWorkspace"));
const state = () => useWorkspaces.getState();

beforeEach(() => {
  vi.stubGlobal("localStorage", fakeLocalStorage());
  useWorkspaces.setState({ workspaces: [], activeId: null });
  useApp.setState({ projects: [] });
});

describe("parseWorkspaces", () => {
  it("returns nothing for unparseable or non-array blobs", () => {
    expect(parseWorkspaces("")).toEqual([]);
    expect(parseWorkspaces("{oops")).toEqual([]);
    expect(parseWorkspaces("{\"id\":\"a\"}")).toEqual([]);
  });

  it("drops malformed entries and duplicate ids but keeps the good ones", () => {
    const raw = JSON.stringify([
      { id: "a", name: " Alpha ", projectIds: ["p1", "p1", 7, "p2"] },
      { id: "a", name: "Dup", projectIds: [] },
      { id: "b", name: "  ", projectIds: [] },
      { id: "c", name: "NoIds" },
      null,
      { id: "d", name: "Delta", projectIds: [] },
    ]);
    expect(parseWorkspaces(raw)).toEqual([
      { id: "a", name: "Alpha", projectIds: ["p1", "p2"] },
      { id: "d", name: "Delta", projectIds: [] },
    ]);
  });
});

describe("resolveActiveId", () => {
  it("accepts only an id that names an existing workspace", () => {
    const list = [{ id: "a", name: "A", projectIds: [] }];
    expect(resolveActiveId(list, "a")).toBe("a");
    expect(resolveActiveId(list, "gone")).toBeNull();
    expect(resolveActiveId(list, "")).toBeNull();
  });
});

describe("withoutProject", () => {
  it("removes one project's id from every set and leaves the others", () => {
    const list = [
      { id: "a", name: "A", projectIds: ["p1", "p2"] },
      { id: "b", name: "B", projectIds: ["p2", "p3"] },
    ];
    const next = withoutProject(list, "p2");
    expect(next.map(w => w.projectIds)).toEqual([["p1"], ["p3"]]);
  });

  it("hands back the same array when no set held it", () => {
    const list = [{ id: "a", name: "A", projectIds: ["p1"] }];
    expect(withoutProject(list, "p9")).toBe(list);
  });
});

describe("store actions", () => {
  it("create trims, activates and persists; a blank name is refused", () => {
    expect(state().create("   ")).toBeNull();
    const id = state().create("  Work ");
    expect(state().workspaces).toEqual([{ id, name: "Work", projectIds: [] }]);
    expect(state().activeId).toBe(id);
    expect(storedWorkspaces()[0].name).toBe("Work");
    expect(storedActive()).toBe(id);
  });

  it("adds and removes projects without duplicates", () => {
    const id = state().create("W")!;
    state().addProject(id, "p1");
    state().addProject(id, "p1");
    state().addProject(id, "p2");
    expect(state().workspaces[0].projectIds).toEqual(["p1", "p2"]);
    state().removeProject(id, "p1");
    expect(state().workspaces[0].projectIds).toEqual(["p2"]);
    expect(storedWorkspaces()[0].projectIds).toEqual(["p2"]);
  });

  it("deleting the active workspace falls back to the first remaining one", () => {
    const first = state().create("One")!;
    const second = state().create("Two")!;
    state().remove(second);
    expect(state().activeId).toBe(first);
    state().remove(first);
    expect(state().activeId).toBeNull();
    expect(storedActive()).toBeNull();
  });

  it("deleting a non-active workspace leaves the active one alone", () => {
    const first = state().create("One")!;
    const second = state().create("Two")!;
    state().setActive(first);
    state().remove(second);
    expect(state().activeId).toBe(first);
  });

  it("setActive ignores an unknown id", () => {
    const id = state().create("W")!;
    state().setActive("nope");
    expect(state().activeId).toBeNull();
    state().setActive(id);
    expect(state().activeId).toBe(id);
  });

  it("no-op actions keep the state object identical", () => {
    const id = state().create("W")!;
    state().addProject(id, "p1");
    const before = state().workspaces;
    state().addProject(id, "p1");
    state().removeProject(id, "absent");
    state().rename(id, "W");
    state().rename(id, "   ");
    state().forgetProject("p9");
    expect(state().workspaces).toBe(before);
  });
});

describe("project removal", () => {
  it("forgetProject drops the id from every workspace and persists it", () => {
    const a = state().create("A")!;
    const b = state().create("B")!;
    state().addProject(a, "p1");
    state().addProject(a, "p2");
    state().addProject(b, "p2");

    state().forgetProject("p2");

    expect(state().workspaces.find(w => w.id === a)!.projectIds).toEqual(["p1"]);
    expect(state().workspaces.find(w => w.id === b)!.projectIds).toEqual([]);
    expect(storedWorkspaces().find((w: { id: string }) => w.id === b).projectIds).toEqual([]);
  });

  it("a project list that merely lacks an id (a partial or failed load) prunes nothing", () => {
    const a = state().create("A")!;
    state().addProject(a, "p1");
    state().addProject(a, "p2");

    useApp.setState({ projects: [project("p1"), project("p2")] });
    useApp.setState({ projects: [project("p1")] });
    useApp.setState({ projects: [] });

    expect(state().workspaces[0].projectIds).toEqual(["p1", "p2"]);
  });

  it("ipc.projectRemove prunes only after the backend call succeeds", async () => {
    const a = state().create("A")!;
    state().addProject(a, "p1");
    const invoke = vi.fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(undefined);
    vi.doMock("@tauri-apps/api/core", () => ({ invoke }));
    vi.resetModules();
    const fresh = await import("./workspaces");
    fresh.useWorkspaces.setState({ workspaces: [{ id: a, name: "A", projectIds: ["p1"] }], activeId: a });
    const ipc = await import("@/lib/ipc");

    await expect(ipc.projectRemove("p1")).rejects.toThrow("boom");
    expect(fresh.useWorkspaces.getState().workspaces[0].projectIds).toEqual(["p1"]);

    await ipc.projectRemove("p1");
    expect(fresh.useWorkspaces.getState().workspaces[0].projectIds).toEqual([]);
    vi.doUnmock("@tauri-apps/api/core");
  });
});

describe("reload", () => {
  it("a fresh module boots on the stored workspaces and the stored active one", async () => {
    localStorage.setItem(scoped("workspaces"), JSON.stringify([
      { id: "a", name: "A", projectIds: ["p1"] },
      { id: "b", name: "B", projectIds: [] },
    ]));
    localStorage.setItem(scoped("activeWorkspace"), "b");

    vi.resetModules();
    const fresh = await import("./workspaces");

    expect(fresh.useWorkspaces.getState().workspaces.map(w => w.id)).toEqual(["a", "b"]);
    expect(fresh.useWorkspaces.getState().activeId).toBe("b");
  });

  it("a stored active id that no longer names a workspace boots as none", async () => {
    localStorage.setItem(scoped("workspaces"), JSON.stringify([{ id: "a", name: "A", projectIds: [] }]));
    localStorage.setItem(scoped("activeWorkspace"), "deleted");

    vi.resetModules();
    const fresh = await import("./workspaces");

    expect(fresh.useWorkspaces.getState().activeId).toBeNull();
  });
});
