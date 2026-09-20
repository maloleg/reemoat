/**
 * What order the machines are in, and who decides.
 *
 * **Their reader decides, and only by saying so.** The list is ordered by name
 * until somebody drags one, and by name for every machine nobody has dragged.
 * That is a narrowing of the rule in `web-shell.md`, not a reversal of it, and the
 * distinction is the rule's own stated reason: *reachability* and *activity*
 * flicker on the four-second poll, so a list ordered by either reshuffles under a
 * travelling thumb. A **stored** order cannot — it moves when somebody moves it
 * and at no other moment — which is exactly why one is allowed here where a
 * derived one is still banned outright.
 *
 * **Module state seeded from `localStorage`**, the idiom `rail.ts` argues and
 * `groups.ts` uses: this is a preference about the app rather than about a screen,
 * and the phone's list → detail → back unmounts both things that draw it. Per
 * device, deliberately — the control plane has nowhere to put a per-user order and
 * the owner's call was that a schema migration is not worth one.
 *
 * ⚠ **No DOM in this module's body.** `webcheck` imports it with a stubbed
 * `window.localStorage` and nothing else, which is `rail.ts`'s own ⚠ and the
 * reason this file sits beside `store.ts` rather than under `ui/` — `store.ts`
 * reads it, and `store.ts` may not import from `ui/`.
 *
 * ## Why this is `orderStrip`'s shape and not `sessionOrder.ts`'s
 *
 * Sessions carry a `rank`: a position *clock*, one number per row, defaulting to
 * `createdAt`. That is right there and wrong here, and `agentStrip.ts` already
 * argues the difference one list over — **which list gains members on the
 * commonest act in the product.** Starting a session is what this app is *for*, so
 * that list grows constantly and a new row has to have an honest position with
 * nothing stored; hence a clock, `rankBetween`, and a re-space when two instants
 * collide. Machines are added by hand, a handful per account, over months. A
 * whole-list rewrite per reorder costs nothing there and removes every way the
 * arithmetic can be wrong: no equal ranks, no bisection running out of room, no
 * partial application to report.
 *
 * Two more, either of which would be enough on its own. There is no server to hold
 * a rank — a per-machine rank in `localStorage` is the same information as an
 * ordered list of ids with strictly more ways to disagree with itself. And this
 * list is **bounded** ({@link MAX_MACHINE_ORDER}) where sessions are not.
 */

import type { MachineId } from "./ids";

const STORAGE_KEY = "reemoat.machineOrder";

/**
 * How many positions are kept.
 *
 * `MAX_STRIP_ENTRIES` read one subject over: this is hand-editable storage and a
 * bound is cheaper than a validation. Two hundred is past any fleet this product
 * is shaped for — the machine limit itself defaults to fifty — so nobody reaches
 * it by using the app, and somebody who has pasted a megabyte into the key gets a
 * working list rather than a slow one.
 */
export const MAX_MACHINE_ORDER = 200;

/**
 * The stored order, merged over what the fleet actually holds.
 *
 * Three clauses, two of them {@link import("./agentStrip").orderStrip}'s and the
 * third a deliberate absence:
 *
 *   1. **Stored ids first, in stored order**, keeping only those `natural` still
 *      holds. An id that resolves to nothing is dropped *at draw time* and keeps
 *      its slot in storage, so a machine comes back where it was if the grant
 *      does.
 *   2. **Then everything the store has never heard of, in natural order, at the
 *      end.** `natural` arrives already sorted by name, so this clause *is* the
 *      name sort rather than a replacement for it. A machine enrolled this morning
 *      has no position anybody expressed, and inventing one inside the stored list
 *      would be this function having an opinion nobody gave it.
 *   3. **There is no `hidden` clause and there must never be one.** `natural`
 *      decides membership outright. `web-shell.md`: *"A machine with no sessions
 *      still gets a tab"* — an order that could drop a granted machine would
 *      reverse that through the other door, and the tab is the only route to
 *      starting a session on a machine you have just added.
 *
 * ⚠ **`natural` decides membership; `stored` decides only order.** Reading them
 * as symmetric is the mistake `agentStrip.ts` records having to name, and the
 * duplicate guard is the other half of it: this list comes out of storage somebody
 * can hand-edit, and one id drawn twice is two tabs that select each other.
 */
export function orderMachines<T extends { id: MachineId }>(
  natural: readonly T[],
  stored: readonly string[],
): T[] {
  const live = new Map(natural.map((one) => [one.id as string, one]));
  const rows: T[] = [];
  const placed = new Set<string>();
  for (const id of stored) {
    if (placed.has(id)) continue;
    const one = live.get(id);
    if (one === undefined) continue;
    placed.add(id);
    rows.push(one);
  }
  for (const one of natural) {
    if (placed.has(one.id as string)) continue;
    placed.add(one.id as string);
    rows.push(one);
  }
  return rows;
}

/**
 * What to write back, given what is drawn now and what was stored before.
 *
 * ⚠ **This is the one place this diverges from the agent strip, and it is on
 * purpose.** `MachineAgentsSection` writes back the *merged* list, so an entry the
 * machine no longer offers is silently dropped from storage by the next reorder —
 * its "it comes back where it was if the thing does" holds until somebody drags.
 * A machine keeps its slot instead, because `groups.ts`'s `selectedMachineIn`
 * already makes exactly that promise about the selected tab — *"a grant revoked
 * and restored puts you back on your tab rather than on whatever happened to be
 * first while it was gone"* — and an order that forgot while a tab remembered
 * would be two halves of one preference disagreeing.
 *
 * So `drawn` is spliced into the positions `stored` already had: walking the
 * stored list, a slot that names something currently drawn takes the next id from
 * `drawn`, and a slot that names something absent keeps what it held.
 *
 * Truncated **from the tail**, which is the end nobody has expressed a position
 * for.
 */
export function nextOrder(stored: readonly string[], drawn: readonly string[]): string[] {
  const live = new Set(drawn);
  const queue = [...drawn];
  const out: string[] = [];
  const placed = new Set<string>();
  const push = (id: string): void => {
    if (placed.has(id)) return;
    placed.add(id);
    out.push(id);
  };
  for (const id of stored) {
    if (live.has(id)) {
      const next = queue.shift();
      if (next !== undefined) push(next);
      continue;
    }
    push(id);
  }
  for (const id of queue) push(id);
  return out.slice(0, MAX_MACHINE_ORDER);
}

/**
 * Which slot a pointer is over, counting the entries it has passed.
 *
 * `middles` is every entry's midpoint along the axis, in draw order and including
 * the one being dragged; `from` is that one's index; `at` is the pointer.
 *
 * ⚠ **Not `dropIndex`, and the difference is the axis.** That function divides
 * travel by **one** measured row, which is exact on a 72px column where every
 * entry is the same size and drifts past the first neighbour on a strip where
 * `mac` sits beside `server-fra-01`. A function that is right on one axis and
 * quietly wrong on the other is worse than two functions, so `dropIndex` keeps its
 * one caller and this counts midpoints instead.
 *
 * The rule is **the pointer passing a neighbour's midpoint**, which is what
 * `dropIndex`'s rounding approximates on a uniform list and what this states
 * exactly on a list that is not uniform. Where the grab is near the middle of the
 * entry — the ordinary case, and `rowDrag.ts`'s too — that is the moment the
 * dragged entry is half over its neighbour, which is where the eye expects the
 * swap; a grab near one end offsets it by that much, on both lists equally.
 *
 * ⚠ **The two coordinate systems `rowDrag.ts` keeps apart coincide here, and the
 * note exists so nobody goes looking for the off-by-one.** There `origin.index`
 * counts a zone's rows *including* the dragged one while `target.index` is a slot
 * *among the others*, because a drop can cross groups. This is a single list, so a
 * slot-among-others and an index-in-the-full-list are the same number — which is
 * why the answer feeds {@link import("./agentStrip").moveRow} directly.
 */
export function dropSlot(middles: readonly number[], from: number, at: number): number {
  let slot = 0;
  for (let i = 0; i < middles.length; i += 1) {
    if (i === from) continue;
    if (at > (middles[i] ?? 0)) slot += 1;
  }
  return slot;
}

function read(): string[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === "string").slice(0, MAX_MACHINE_ORDER);
  } catch {
    // Private mode, a quota, or somebody's hand-edited value. ⚠ **The failure mode
    // of storage here is the behaviour this app had before there was an order at
    // all**: an empty list falls straight through clause 2 to pure name order. That
    // is what makes this `catch` honest rather than a swallow.
    return [];
  }
}

let order: string[] = read();
const listeners = new Set<() => void>();
/** Bumped on every committed change. `useSyncExternalStore` compares by `Object.is`. */
let version = 0;

export function machineOrder(): readonly string[] {
  return order;
}

/**
 * The version, and it is in `sessionGroups`' memo guard rather than only here.
 *
 * That memo is keyed on the identity of `state.sessions` and `state.machines`, and
 * a reorder replaces neither — so this number is the third input, and the only one
 * of the three that moves without the poll.
 */
export function machineOrderVersion(): number {
  return version;
}

/** Idempotent on the committed value: a drop that moved nothing tells nobody. */
export function setMachineOrder(drawn: readonly string[]): void {
  const next = nextOrder(order, drawn);
  if (next.length === order.length && next.every((id, at) => id === order[at])) return;
  order = next;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // The in-memory order still works for this session, which is the same trade
    // `groups.ts` and `rail.ts` both make about a preference.
  }
  version += 1;
  for (const listener of [...listeners]) listener();
}

export function subscribeMachineOrder(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
