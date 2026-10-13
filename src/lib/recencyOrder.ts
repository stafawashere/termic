// Newest-first ordering for sidebar rows. The key is a stored timestamp, not
// anything a PTY writes: a turn ending or the user opening an item stamps it
// (store/app.ts `activityAt`), so a row only moves when one of those happens.

import type { Task } from "@/lib/types";

export type RecencyKey = number | null | undefined;

const hasKey = (key: RecencyKey): key is number => typeof key === "number" && Number.isFinite(key);

/** Newer first. A missing key sorts after every present one, and equal keys
 *  compare 0 so a stable sort keeps their incoming order. */
export function compareRecency(a: RecencyKey, b: RecencyKey): number {
  const aKnown = hasKey(a);
  const bKnown = hasKey(b);
  if (!aKnown && !bKnown) return 0;
  if (!aKnown) return 1;
  if (!bKnown) return -1;

  return b - a;
}

export function sortByRecency<T>(items: readonly T[], keyOf: (item: T) => RecencyKey): T[] {
  return [...items].sort((left, right) => compareRecency(keyOf(left), keyOf(right)));
}

/** The later of the task's last activity and its creation. */
export function taskRecencyKey(task: Task, activityAt: Readonly<Record<string, number>>): RecencyKey {
  const created = Date.parse(task.created);
  const createdKey = Number.isNaN(created) ? null : created;
  const activity = activityAt[task.id];
  if (!hasKey(activity)) return createdKey;
  if (createdKey === null) return activity;

  return Math.max(activity, createdKey);
}

/** One project's tasks, newest first. A task the user dragged (`order` set; Rust sends null for a task never dragged)
 *  keeps its manual slot ahead of the rest, as the stored order puts it. */
export function orderTasksByRecency(tasks: readonly Task[], activityAt: Readonly<Record<string, number>>): Task[] {
  const pinned = tasks.filter(task => task.order != null);
  const loose = tasks.filter(task => task.order == null);

  return [...pinned, ...sortByRecency(loose, task => taskRecencyKey(task, activityAt))];
}

interface OrderInputs {
  tasks: Task[];
  activityAt: Record<string, number>;
}

/** Every project's display order as one string, so a subscriber re-renders
 *  when an ORDER changes and not on each stamp or unrelated task write. The
 *  result is cached on the identity of its two inputs, because a selector
 *  runs on every store write and the PTY-driven ones leave both untouched. */
export function createTaskOrderSelector(): (state: OrderInputs) => string {
  let lastTasks: Task[] | null = null;
  let lastActivity: Record<string, number> | null = null;
  let lastKey = "";

  return state => {
    const unchanged = state.tasks === lastTasks && state.activityAt === lastActivity;
    if (unchanged) return lastKey;

    const byProject = new Map<string, Task[]>();
    for (const task of state.tasks) {
      if (task.archived) continue;

      const list = byProject.get(task.project_id);
      if (list) list.push(task);
      else byProject.set(task.project_id, [task]);
    }

    const ordered = [...byProject.values()].flatMap(list => orderTasksByRecency(list, state.activityAt));
    lastTasks = state.tasks;
    lastActivity = state.activityAt;
    lastKey = ordered.map(task => task.id).join(",");
    return lastKey;
  };
}

export function parseTaskOrderKey(key: string): ReadonlyMap<string, number> {
  const ranks = new Map<string, number>();
  key.split(",").forEach((id, index) => { if (id) ranks.set(id, index); });
  return ranks;
}

/** Tasks in the order a key ranks them. A task the key does not know yet
 *  sorts last, in its incoming position. */
export function rankTasks(tasks: readonly Task[], ranks: ReadonlyMap<string, number>): Task[] {
  return sortByRecency(tasks, task => {
    const rank = ranks.get(task.id);
    return rank === undefined ? null : -rank;
  });
}

/** The store's task array with one project's tasks rewritten to the order the
 *  sidebar draws them in, each carrying that position as its manual `order`.
 *  A drag splices the store array and persists the result, so it has to start
 *  from what the user sees. The project's tasks keep the slots they held. */
export function freezeDisplayOrder(
  all: readonly Task[],
  projectId: string,
  activityAt: Readonly<Record<string, number>>,
): Task[] {
  const members = all.filter(task => task.project_id === projectId && !task.archived);
  const displayed = orderTasksByRecency(members, activityAt).map((task, index) => ({ ...task, order: index }));

  let next = 0;
  return all.map(task => {
    const isMember = task.project_id === projectId && !task.archived;
    return isMember ? displayed[next++] : task;
  });
}
