import { localDaemon } from "./native";

/**
 * Whether a daemon on this computer may be reached without the relay.
 *
 * **The policy half; `native.ts` holds the bridge and the host holds the address.**
 * This module decides *whether to ask* and remembers what somebody switched off.
 * It never composes a URL — `base` arrives finished from the host process, where
 * loopback is enforced somewhere a page that renders agent output cannot reach.
 *
 * ⚠ **This is a preference about one computer, so it is not a `MachineRecord`
 * field.** "Local" is true of the device the daemon runs on and false of every
 * other client of the same account — a phone, a second laptop, the browser — so a
 * value on the control plane's row would be one fact contradicting itself per
 * client. `wire.ts` mirrors the control plane and must not grow a client-only key.
 *
 * ⚠ **And it is a routing preference, never a credential.** `cp.ts`'s rule that
 * nothing secret goes into `localStorage` in the native shell is untouched: what is
 * stored here is a list of machine ids somebody switched off, which is already on
 * the screen that stored it.
 *
 * The list is the **off** list, because the default is on. A fleet nobody has
 * touched holds an empty array, which is the same bytes as no array at all, and a
 * machine somebody has never seen behaves like every other one.
 */
const STORAGE_KEY = "reemoat.localDaemons";

/**
 * Seeded on first use rather than at module load.
 *
 * `ui/groups.ts` seeds at load and says why: a render may not do I/O. The reason
 * does not carry here — that one has to hand `useSyncExternalStore` a stable
 * snapshot, and this is read from an effect and from a route probe, neither of
 * which is a render. What lazy buys instead is a module whose *read* path is
 * reachable at all from `webcheck`, which stubs storage after the barrel has
 * already evaluated every `../src` module. Seeded at load, the only thing a driver
 * could ever exercise is the writer.
 */
let off: Set<string> | null = null;

function held(): Set<string> {
  off ??= new Set(readStored());
  return off;
}

function readStored(): string[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || !("off" in parsed)) return [];
    const list = (parsed as { off: unknown }).off;
    return Array.isArray(list) ? list.filter((id): id is string => typeof id === "string") : [];
  } catch {
    // Private mode, a quota, or a hand-edited value. Defaulting to "nothing is
    // switched off" is the same state as a fresh install, and the worst it costs
    // is a probe that the daemon answers.
    return [];
  }
}

function write(): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ off: [...held()] }));
  } catch {
    // The in-memory set still governs this session.
  }
}

/** Has somebody switched the local path off for this machine? */
export function localOff(machineId: string): boolean {
  return held().has(machineId);
}

export function setLocalOff(machineId: string, value: boolean): void {
  if (value) held().add(machineId);
  else held().delete(machineId);
  write();
}

/**
 * The loopback origin for this machine, if there is one worth trying.
 *
 * `null` in a browser and for ever: a page served over `https:` cannot reach
 * `http://127.0.0.1` at all, so the arm is dead there rather than merely unused —
 * which is what keeps the browser build byte-identical and is directly assertable.
 *
 * Deliberately **not memoised**. The read is a file, over IPC, on this machine,
 * and it happens once per route resolution — which is a wake or a fifteen-second
 * retry, never the four-second poll. What a memo would buy is microseconds; what
 * it would cost is a daemon started *after* the app not being found until the app
 * restarts, which on a laptop where both come up at login is the ordinary case.
 */
export async function localBaseFor(machineId: string): Promise<string | null> {
  if (localOff(machineId)) return null;
  return await localAnnouncedFor(machineId);
}

/**
 * The same question with the switch left out, for the screen that draws it.
 *
 * Settings has to tell *"there is no daemon here"* from *"there is one and you
 * turned it off"*, which are the same `null` to {@link localBaseFor} and must not
 * be the same sentence. Separated here rather than by giving the caller two
 * booleans, so there is still one place that compares an announced id to a wanted
 * one.
 */
export async function localAnnouncedFor(machineId: string): Promise<string | null> {
  const found = await localDaemon();
  if (found === null) return null;
  // The id the host read out of the daemon's own file. A hint: what *establishes*
  // that this listener is this machine is the `aud` check, one authenticated
  // request later. This only decides whether that request is worth making.
  return found.machineId === machineId ? found.base : null;
}
