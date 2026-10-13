import { describe, expect, it } from "vitest";
import { DEFAULT_BINDINGS, bindingToCmKey } from "@/lib/shortcuts";
import { zedKeymap, zedKeymapOwnsKey } from "./zedKeymap";

function normalizeKey(key: string): string {
  const parts = key.split("-");
  const base = parts[parts.length - 1].toLowerCase();
  const modifiers = parts.slice(0, -1).map(part => part.toLowerCase()).sort();
  return [...modifiers, base].join("-");
}

describe("zedKeymap", () => {
  const bindings = zedKeymap();

  it("binds every key to a command function", () => {
    const unresolved = bindings.filter(binding => typeof binding.run !== "function");
    expect(unresolved).toEqual([]);
  });

  it("never repeats a key", () => {
    const keys = bindings.map(binding => normalizeKey(binding.key as string));
    const repeated = keys.filter((key, index) => keys.indexOf(key) !== index);
    expect(repeated).toEqual([]);
  });

  it("stops propagation on every key an app shortcut also owns", () => {
    const appKeys = new Set(
      Object.values(DEFAULT_BINDINGS).map(binding => normalizeKey(bindingToCmKey(binding))),
    );

    const unguarded = bindings.filter(binding => {
      const collides = appKeys.has(normalizeKey(binding.key as string));
      return collides && !binding.stopPropagation;
    });

    expect(unguarded.map(binding => binding.key)).toEqual([]);
  });

  it("guards the task-switch arrows, which the editor must win while focused", () => {
    const guarded = bindings
      .filter(binding => binding.stopPropagation)
      .map(binding => binding.key);

    expect(guarded).toEqual(expect.arrayContaining(["Mod-Alt-ArrowUp", "Mod-Alt-ArrowDown"]));
  });
});

describe("zedKeymapOwnsKey", () => {
  const insideEditor = { closest: (selector: string) => (selector === ".cm-editor" ? {} : null) } as unknown as EventTarget;
  const outsideEditor = { closest: () => null } as unknown as EventTarget;

  it("claims the key inside an editor under the zed preset", () => {
    expect(zedKeymapOwnsKey("zed", insideEditor)).toBe(true);
  });

  it("leaves the key to the app under the default preset", () => {
    expect(zedKeymapOwnsKey("default", insideEditor)).toBe(false);
  });

  it("leaves the key to the app outside an editor", () => {
    expect(zedKeymapOwnsKey("zed", outsideEditor)).toBe(false);
    expect(zedKeymapOwnsKey("zed", null)).toBe(false);
  });
});
