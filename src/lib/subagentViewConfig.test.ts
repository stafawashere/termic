import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  parseViewConfigs, readViewOverrides, resolveViewConfig, subagentViewKey, withViewOverrides, writeViewOverrides,
  type SubagentViewConfig,
} from "@/lib/subagentViewConfig";

const DEFAULTS: SubagentViewConfig = {
  verbose: true, showThinking: true, showToolInputs: false, showToolOutputs: false, truncateLines: 100, autoScroll: true,
};

describe("parseViewConfigs", () => {
  it("keeps the fields it knows with the right types and drops the rest", () => {
    const raw = JSON.stringify({
      "s/a": { at: 5, overrides: { verbose: false, truncateLines: 20, showThinking: "no", extra: 1 } },
      "s/b": { at: 6, overrides: { truncateLines: -1 } },
      "s/c": "junk",
    });

    expect(parseViewConfigs(raw)).toEqual({ "s/a": { at: 5, overrides: { verbose: false, truncateLines: 20 } } });
  });

  it("reads a missing or broken store as empty", () => {
    expect(parseViewConfigs(null)).toEqual({});
    expect(parseViewConfigs("{not json")).toEqual({});
    expect(parseViewConfigs("[1,2]")).toEqual({});
  });
});

describe("withViewOverrides", () => {
  it("merges a change into what the view already changed", () => {
    const first = withViewOverrides({}, "s/a", { verbose: false }, 1);
    const second = withViewOverrides(first, "s/a", { showToolOutputs: true }, 2);

    expect(second["s/a"]).toEqual({ at: 2, overrides: { verbose: false, showToolOutputs: true } });
  });

  it("forgets the least recently changed views past the cap", () => {
    let configs = {};
    for (let n = 0; n < 4; n++) configs = withViewOverrides(configs, `s/${n}`, { verbose: false }, n, 3);

    expect(Object.keys(configs).sort()).toEqual(["s/1", "s/2", "s/3"]);
  });
});

describe("resolveViewConfig", () => {
  it("takes the defaults for every toggle the view never changed", () => {
    expect(resolveViewConfig(DEFAULTS, { showToolOutputs: true })).toEqual({ ...DEFAULTS, showToolOutputs: true });
  });
});

describe("per-agent persistence", () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value); },
    });
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("brings one agent's changes back after a reload and leaves other agents on the defaults", () => {
    const mine = subagentViewKey("session-1", "a1");
    writeViewOverrides(mine, { verbose: false });
    writeViewOverrides(mine, { truncateLines: 0 });

    expect(readViewOverrides(mine)).toEqual({ verbose: false, truncateLines: 0 });
    expect(readViewOverrides(subagentViewKey("session-1", "a2"))).toEqual({});
  });
});
