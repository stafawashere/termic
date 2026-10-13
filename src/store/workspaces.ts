// Workspaces: named, saved sets of project ids for the sidebar's "workspace"
// view. A workspace is a view filter, not project data, so it lives in
// localStorage only and a removed project is pruned out of every set.
//
// Project ids are not disjoint across profiles, so both keys are scoped (see
// lib/profileScope.ts).

import { create } from "zustand";
import { scoped } from "@/lib/profileScope";

const LS_WORKSPACES = scoped("workspaces");
const LS_ACTIVE_WORKSPACE = scoped("activeWorkspace");

export interface Workspace {
  id: string;
  name: string;
  projectIds: string[];
}

/** Ref-stable stand-in for "no active workspace", so a selector returning it
 *  never hands subscribers a fresh array. */
export const NO_PROJECT_IDS: readonly string[] = Object.freeze([]);

/** Anything malformed is dropped rather than repaired: a half-readable blob
 *  should cost the user one workspace, not the whole view. */
export function parseWorkspaces(raw: string): Workspace[] {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return []; }

  if (!Array.isArray(parsed)) return [];

  const seenIds = new Set<string>();
  const result: Workspace[] = [];

  for (const entry of parsed) {
    const candidate = entry as Partial<Workspace> | null;
    const hasId = typeof candidate?.id === "string" && candidate.id !== "";
    const hasName = typeof candidate?.name === "string" && candidate.name.trim() !== "";
    const hasIds = Array.isArray(candidate?.projectIds);
    const isUnseen = hasId && !seenIds.has(candidate!.id as string);
    const isValid = hasId && hasName && hasIds && isUnseen;
    if (!isValid) continue;

    seenIds.add(candidate!.id as string);
    const projectIds = (candidate!.projectIds as unknown[]).filter((id): id is string => typeof id === "string");
    result.push({
      id: candidate!.id as string,
      name: (candidate!.name as string).trim(),
      projectIds: [...new Set(projectIds)],
    });
  }

  return result;
}

/** The stored active id only counts when it names a workspace that exists. */
export function resolveActiveId(workspaces: Workspace[], storedId: string): string | null {
  const exists = workspaces.some(workspace => workspace.id === storedId);
  return exists ? storedId : null;
}

/** Drops one project's id from every set. Returns the SAME array when no set
 *  held it so the caller can skip a write. */
export function withoutProject(workspaces: Workspace[], projectId: string): Workspace[] {
  const needsPrune = workspaces.some(workspace => workspace.projectIds.includes(projectId));
  if (!needsPrune) return workspaces;

  return workspaces.map(workspace =>
    workspace.projectIds.includes(projectId)
      ? { ...workspace, projectIds: workspace.projectIds.filter(id => id !== projectId) }
      : workspace);
}

function load(): { workspaces: Workspace[]; activeId: string | null } {
  let storedWorkspaces = "";
  let storedActive = "";
  try {
    storedWorkspaces = localStorage.getItem(LS_WORKSPACES) ?? "";
    storedActive = localStorage.getItem(LS_ACTIVE_WORKSPACE) ?? "";
  } catch {}

  const workspaces = parseWorkspaces(storedWorkspaces);
  return { workspaces, activeId: resolveActiveId(workspaces, storedActive) };
}

function persist(workspaces: Workspace[], activeId: string | null) {
  try {
    localStorage.setItem(LS_WORKSPACES, JSON.stringify(workspaces));
    if (activeId) localStorage.setItem(LS_ACTIVE_WORKSPACE, activeId);
    else localStorage.removeItem(LS_ACTIVE_WORKSPACE);
  } catch {}
}

interface WorkspacesState {
  workspaces: Workspace[];
  activeId: string | null;
  /** Creates a workspace and makes it the active one. Returns its id, or null
   *  for a blank name. */
  create: (name: string) => string | null;
  rename: (id: string, name: string) => void;
  remove: (id: string) => void;
  setActive: (id: string | null) => void;
  addProject: (id: string, projectId: string) => void;
  removeProject: (id: string, projectId: string) => void;
  /** The project was removed from the app by the user: drop it from every set. */
  forgetProject: (projectId: string) => void;
}

const initial = load();

export const useWorkspaces = create<WorkspacesState>((set, get) => ({
  workspaces: initial.workspaces,
  activeId: initial.activeId,

  create: (name) => {
    const trimmed = name.trim();
    if (!trimmed) return null;

    const id = crypto.randomUUID();
    const next = [...get().workspaces, { id, name: trimmed, projectIds: [] }];
    persist(next, id);
    set({ workspaces: next, activeId: id });
    return id;
  },

  rename: (id, name) => {
    const trimmed = name.trim();
    const target = get().workspaces.find(workspace => workspace.id === id);
    const isNoop = !target || !trimmed || target.name === trimmed;
    if (isNoop) return;

    const next = get().workspaces.map(workspace => workspace.id === id ? { ...workspace, name: trimmed } : workspace);
    persist(next, get().activeId);
    set({ workspaces: next });
  },

  remove: (id) => {
    const { workspaces, activeId } = get();
    if (!workspaces.some(workspace => workspace.id === id)) return;

    const next = workspaces.filter(workspace => workspace.id !== id);
    const nextActive = activeId === id ? (next[0]?.id ?? null) : activeId;
    persist(next, nextActive);
    set({ workspaces: next, activeId: nextActive });
  },

  setActive: (id) => {
    const { workspaces, activeId } = get();
    const nextActive = id === null ? null : resolveActiveId(workspaces, id);
    if (nextActive === activeId) return;

    persist(workspaces, nextActive);
    set({ activeId: nextActive });
  },

  addProject: (id, projectId) => {
    const target = get().workspaces.find(workspace => workspace.id === id);
    if (!target || target.projectIds.includes(projectId)) return;

    const next = get().workspaces.map(workspace =>
      workspace.id === id ? { ...workspace, projectIds: [...workspace.projectIds, projectId] } : workspace);
    persist(next, get().activeId);
    set({ workspaces: next });
  },

  removeProject: (id, projectId) => {
    const target = get().workspaces.find(workspace => workspace.id === id);
    if (!target || !target.projectIds.includes(projectId)) return;

    const next = get().workspaces.map(workspace =>
      workspace.id === id ? { ...workspace, projectIds: workspace.projectIds.filter(pid => pid !== projectId) } : workspace);
    persist(next, get().activeId);
    set({ workspaces: next });
  },

  forgetProject: (projectId) => {
    const { workspaces, activeId } = get();
    const next = withoutProject(workspaces, projectId);
    if (next === workspaces) return;

    persist(next, activeId);
    set({ workspaces: next });
  },
}));

/** Project ids of the active workspace, or null when none is active. */
export function selectActiveProjectIds(state: WorkspacesState): readonly string[] | null {
  const active = state.workspaces.find(workspace => workspace.id === state.activeId);
  return active ? active.projectIds : null;
}
