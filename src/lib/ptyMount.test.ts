import { describe, it, expect } from "vitest";
import { resolvePtyMount, replayRing, resetReplay } from "@/lib/ptyMount";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

describe("resolvePtyMount", () => {
  it("lets an effect rerun during the find still attach to the live agent", async () => {
    const hadPty = { current: false };
    const firstFind = deferred<{ id: string } | null>();
    let firstCancelled = false;
    const first = resolvePtyMount({
      isAgent: true,
      hadPty,
      isCancelled: () => firstCancelled,
      find: () => firstFind.promise,
      attach: async (id) => id,
    });

    firstCancelled = true;
    let secondFound = false;
    const second = resolvePtyMount({
      isAgent: true,
      hadPty,
      isCancelled: () => false,
      find: async () => { secondFound = true; return { id: "live" }; },
      attach: async (id) => id,
    });
    firstFind.resolve({ id: "live" });

    expect(await first).toBeNull();
    expect(await second).toEqual({ attached: "live" });
    expect(secondFound).toBe(true);
    expect(hadPty.current).toBe(true);
  });

  it("leaves hadPty unclaimed when torn down during the attach", async () => {
    const hadPty = { current: false };
    let cancelled = false;
    const result = await resolvePtyMount({
      isAgent: true,
      hadPty,
      isCancelled: () => cancelled,
      find: async () => ({ id: "live" }),
      attach: async (id) => { cancelled = true; return id; },
    });

    expect(result).toBeNull();
    expect(hadPty.current).toBe(false);
  });

  it("never asks the daemon on a respawn", async () => {
    const hadPty = { current: true };
    let asked = false;
    const result = await resolvePtyMount({
      isAgent: true,
      hadPty,
      isCancelled: () => false,
      find: async () => { asked = true; return { id: "live" }; },
      attach: async (id) => id,
    });

    expect(asked).toBe(false);
    expect(result).toEqual({ attached: null });
  });
});

describe("replay guard", () => {
  it("does not outlive a replay whose terminal was disposed mid-parse", () => {
    const replaying = { current: false };
    const disposedTerm = { write: () => {} };
    replayRing(disposedTerm, replaying, new Uint8Array([7]));
    expect(replaying.current).toBe(true);

    resetReplay(replaying);

    expect(replaying.current).toBe(false);
  });

  it("clears once the ring has been parsed", () => {
    const replaying = { current: false };
    let done: () => void = () => {};
    replayRing({ write: (_d, cb) => { done = cb; } }, replaying, new Uint8Array([7]));
    expect(replaying.current).toBe(true);

    done();

    expect(replaying.current).toBe(false);
  });
});
