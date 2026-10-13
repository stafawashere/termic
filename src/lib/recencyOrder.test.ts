import { describe, expect, it } from "vitest";
import { compareRecency, orderTasksByRecency, sortByRecency, taskRecencyKey } from "./recencyOrder";
import type { Task } from "./types";

const task = (id: string, created: string, extra: Partial<Task> = {}): Task =>
  ({ id, name: id, project_id: "p", archived: false, created, ...extra }) as Task;

const ids = (tasks: Task[]) => tasks.map(t => t.id);

describe("compareRecency", () => {
  it("puts the larger timestamp first", () => {
    expect(compareRecency(200, 100)).toBeLessThan(0);
    expect(compareRecency(100, 200)).toBeGreaterThan(0);
  });

  it("sorts a missing timestamp after a present one, including zero", () => {
    expect(compareRecency(null, 0)).toBeGreaterThan(0);
    expect(compareRecency(0, undefined)).toBeLessThan(0);
    expect(compareRecency(null, undefined)).toBe(0);
  });

  it("treats equal timestamps as a tie", () => {
    expect(compareRecency(5, 5)).toBe(0);
  });
});

describe("sortByRecency", () => {
  it("keeps incoming order for ties and does not mutate the input", () => {
    const input = [
      { id: "a", at: 10 },
      { id: "b", at: 10 },
      { id: "c", at: 30 },
      { id: "d", at: null },
      { id: "e", at: 10 },
    ];
    const snapshot = [...input];

    expect(sortByRecency(input, item => item.at).map(item => item.id)).toEqual(["c", "a", "b", "e", "d"]);
    expect(input).toEqual(snapshot);
  });
});

describe("taskRecencyKey", () => {
  it("falls back to creation time and takes the later of the two", () => {
    const made = task("t", "2026-01-01T00:00:00Z");
    const createdMs = Date.parse("2026-01-01T00:00:00Z");

    expect(taskRecencyKey(made, {})).toBe(createdMs);
    expect(taskRecencyKey(made, { t: createdMs + 5 })).toBe(createdMs + 5);
    expect(taskRecencyKey(made, { t: createdMs - 5 })).toBe(createdMs);
  });

  it("is missing when the creation time is unparseable and there is no activity", () => {
    expect(taskRecencyKey(task("t", "not a date"), {})).toBeNull();
  });
});

describe("orderTasksByRecency", () => {
  const oldest = task("old", "2026-01-01T00:00:00Z");
  const middle = task("mid", "2026-01-02T00:00:00Z");
  const newest = task("new", "2026-01-03T00:00:00Z");

  it("lists the newest task first", () => {
    expect(ids(orderTasksByRecency([oldest, middle, newest], {}))).toEqual(["new", "mid", "old"]);
  });

  it("moves a task up when it has later activity", () => {
    const activityAt = { old: Date.parse("2026-02-01T00:00:00Z") };

    expect(ids(orderTasksByRecency([oldest, middle, newest], activityAt))).toEqual(["old", "new", "mid"]);
  });

  it("treats a null order, which is how Rust sends a task never dragged, as unordered", () => {
    const neverDragged = (id: string, created: string) => task(id, created, { order: null as unknown as undefined });

    expect(ids(orderTasksByRecency([neverDragged("a", "2026-01-01T00:00:00Z"), neverDragged("b", "2026-01-02T00:00:00Z")], {})))
      .toEqual(["b", "a"]);
  });

  it("keeps dragged tasks in their manual slots ahead of the rest", () => {
    const dragged = task("drag", "2026-01-01T00:00:00Z", { order: 0 });

    expect(ids(orderTasksByRecency([dragged, oldest, newest], {}))).toEqual(["drag", "new", "old"]);
  });
});
