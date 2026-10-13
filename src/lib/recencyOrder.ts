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
