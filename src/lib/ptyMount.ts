import { decideSpawnOrAttach } from "@/lib/agents";

type Flag = { current: boolean };

/** Find and, when it applies, attach to the daemon PTY still running this
 *  tab's agent. Resolves `null` when the effect was torn down meanwhile.
 *
 *  `hadPty` is claimed only once the effect is known to survive both awaits.
 *  Claimed earlier, an effect rerun that lands while `find` is in flight reads
 *  as a respawn, skips the daemon and spawns a second agent beside the live
 *  one. */
export async function resolvePtyMount<T>(opts: {
  isAgent: boolean;
  hadPty: Flag;
  isCancelled: () => boolean;
  find: () => Promise<{ id: string } | null>;
  attach: (id: string) => Promise<T | null>;
}): Promise<{ attached: T | null } | null> {
  const respawn = opts.hadPty.current;
  const live = opts.isAgent && !respawn ? await opts.find() : null;
  if (opts.isCancelled()) return null;

  const plan = decideSpawnOrAttach({ isAgent: opts.isAgent, respawn, live });
  const attached = plan.kind === "attach" ? await opts.attach(plan.id) : null;
  if (opts.isCancelled()) return null;

  opts.hadPty.current = true;
  return { attached };
}

/** Write the daemon's ring into the terminal with `replaying` held for the
 *  length of the parse. */
export function replayRing(
  term: { write(data: Uint8Array, done: () => void): void },
  replaying: Flag,
  ring: Uint8Array,
): void {
  replaying.current = true;
  term.write(ring, () => { replaying.current = false; });
}

/** Called at the start and the end of every PTY effect. A replay whose
 *  terminal was disposed mid-parse never runs its callback, and a `replaying`
 *  left true would silence the next PTY's bells and attention. */
export function resetReplay(replaying: Flag): void {
  replaying.current = false;
}
