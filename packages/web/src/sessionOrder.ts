/**
 * Where the rows in the session rail sit, and who decides.
 *
 * **The reader decides, and nothing else may.** This list used to sort itself: the
 * rows waiting on a human went to the top of their folder, and everything else
 * ordered by its most recent event — so a list somebody was reading rearranged
 * itself under their thumb every four seconds, on the poll. Both orders were
 * defensible and both were the app having an opinion about a list of somebody
 * else's conversations. Now a row moves when somebody moves it and at no other
 * time.
 *
 * ⚠ **"An approval cannot be hidden" survives this, and it never rested on the
 * hoist.** Three signals carry it and all three are untouched: the status dot's
 * permanent ring, the row title going semibold, and `blockedCount` on the folder's
 * own header — which is what a *collapsed* folder says out loud. `waitingFloor`
 * still lifts anything this view cannot draw, still by subtraction. What the hoist
 * added on top of those was redundancy, and redundancy that moves rows under a
 * finger costs more than it buys.
 *
 * ## The key is a position clock
 *
 * One number per session, defaulting to its `createdAt`, descending. The unit is a
 * millisecond and the value is an instant — "this row belongs where a session
 * created at this moment would be". Three properties follow, and they are the
 * whole reason it is a clock rather than an index:
 *
 * - **A session nobody has touched has an honest place**, with nothing stored. So
 *   the merge is a comparison rather than the `orderStrip` shape one module over —
 *   *stored first in rank order, then everything unknown at the end*. That clause
 *   is right for the agent strip and wrong here, twice: the strip's membership
 *   changes when somebody installs a harness, while this list gains a member on
 *   the commonest act in the product, so "at the end" buries the conversation
 *   somebody just started. And worse, it inverts the default — the first drag
 *   anybody performed would push every other row in the folder below the one they
 *   moved, which is the whole list reordering itself in response to one gesture.
 * - **A new session is at the top of its folder** because its `createdAt` is now,
 *   and a drop writes an instant between two instants that have already passed.
 *   This is the one place the list still moves by itself, and it is the one place
 *   it should.
 * - **A drop is one write**, not a renumbering of its neighbours.
 *
 * ## The comparator is total, and that is correctness rather than tidiness
 *
 * Two sessions can share a millisecond — a script starting three at once — and the
 * input order changes between polls, so `Array.prototype.sort`'s stability
 * guarantees nothing about what a reader sees. A comparator that answered 0 for
 * such a pair would let them swap on the poll, which is precisely the behaviour
 * this module exists to remove. So it falls through to `createdAt` and then to the
 * row key, which is unique across the fleet.
 */

import type { SessionRow } from "./store";

/**
 * One millisecond, and the size is the argument.
 *
 * A drop at the top of a folder writes `top + RANK_STEP`, so the row lands one
 * instant above what is there now — and therefore still **below** anything created
 * afterwards. Any larger step would put a dragged row above sessions that do not
 * exist yet, which is the app deciding something nobody said.
 */
export const RANK_STEP = 1;

/** What a row is compared by: where somebody put it, or when it was made. */
export function effectiveRank(snapshot: { rank?: number | null; createdAt: number }): number {
  return snapshot.rank ?? snapshot.createdAt;
}

/**
 * Whether this row's daemon can store an order at all.
 *
 * ⚠ **Three-valued, and the arms are not two.** `undefined` is a daemon that has
 * never heard of the field; `null` is one that has and says nobody has moved this
 * row. Only the first takes the gesture away. Nothing here reads a version — an
 * old daemon is known by the shape of what it answers, which is this repository's
 * standing rule for the whole wire.
 */
export function canReorder(snapshot: { rank?: number | null }): boolean {
  return snapshot.rank !== undefined;
}

/** Newest first, then by age, then by key — total, so a poll cannot reshuffle it. */
export function compareRows(a: SessionRow, b: SessionRow): number {
  return (
    effectiveRank(b.snapshot) - effectiveRank(a.snapshot) ||
    b.snapshot.createdAt - a.snapshot.createdAt ||
    (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
  );
}

/** One list in the order its reader put it. Never mutates what it is handed. */
export function orderSessions(rows: readonly SessionRow[]): SessionRow[] {
  return [...rows].sort(compareRows);
}

/**
 * A position strictly between two neighbours, or `null` when there is no room.
 *
 * `above`/`below` are the effective ranks of the rows that will sit either side of
 * the dropped one, and `null` at either end means "nothing there" — the row is
 * going to the top or the bottom of its group.
 *
 * ⚠ **`null` is a real answer, not a defensive `never`.** At a `createdAt` around
 * 1.77e12 a double's ulp is about 0.0005, so a one-millisecond gap admits roughly
 * eleven bisections before the midpoint *is* one of its endpoints. Realistic gaps
 * admit thirty or more and nobody will reach it by accident — but the failure mode
 * if it is not detected is silent: two equal ranks, the key tie-break decides, and
 * the row appears not to have moved. The caller re-spaces instead.
 *
 * Written as `above + (below - above) / 2` rather than `(above + below) / 2`: the
 * second overflows to `Infinity` for two large same-signed values and is less
 * accurate near equality, which is exactly the region this has to be right in.
 */
export function rankBetween(above: number | null, below: number | null): number | null {
  if (above === null && below === null) return null;
  /*
   * ⚠ **Both of these were the wrong way round, and the assertion that covered
   * them was written from the code rather than from the intent — so it agreed.**
   * The order is *descending*: a bigger number is higher up the list. So nothing
   * above means the row is going to the **top** and its position has to be
   * *greater* than the one row it will sit over; nothing below means the bottom
   * and *smaller*. Inverted, a drop at the top sent the row to the bottom.
   */
  if (above === null) return (below as number) + RANK_STEP;
  if (below === null) return above - RANK_STEP;
  if (!(above > below)) return null;
  const mid = above + (below - above) / 2;
  return mid >= above || mid <= below ? null : mid;
}

/**
 * The position that puts `rows[from]` at index `to` among the others.
 *
 * The list is descending, so the row that ends up *above* the moved one is at
 * `to - 1` once it has been taken out, and the one below is at `to`. Taking it out
 * first is what makes "move down by one" mean the same thing to a keyboard as it
 * does to a finger.
 *
 * `null` where {@link rankBetween} has no room, which the caller answers by
 * re-spacing rather than by writing a tie.
 */
export function rankForMove(rows: readonly SessionRow[], from: number, to: number): number | null {
  if (from < 0 || from >= rows.length) return null;
  const rest = rows.filter((_, index) => index !== from);
  const slot = Math.min(Math.max(to, 0), rest.length);
  const above = rest[slot - 1];
  const below = rest[slot];
  return rankBetween(
    above === undefined ? null : effectiveRank(above.snapshot),
    below === undefined ? null : effectiveRank(below.snapshot),
  );
}

/** One row's new position, as a write the caller sends. */
export interface Placement {
  readonly row: SessionRow;
  readonly rank: number;
}

/**
 * Where a dropped row lands, and what else has to move for it to fit.
 *
 * `neighbours` is the group it is being dropped into, in draw order and **without
 * the dragged row**; `index` is the slot between them, `0` for the top.
 *
 * ⚠ **There is no refusal here, and there was.** A drop between two rows whose
 * positions are adjacent doubles used to answer *"there is no room between those
 * two rows, move a neighbour first"* — a sentence that hands the reader an
 * arithmetic problem they did not cause, cannot see and have no way to act on. The
 * gap is this module's business. When one is used up the group is re-spaced and
 * the drop happens; what changes is how many rows are written, which is a fact
 * about the request rather than about the gesture.
 *
 * **Re-spacing walks the group *up* from its own top**, `n` fresh milliseconds
 * above the highest position it already holds, rather than spreading it between
 * its own extremes — which are exactly the values that ran out. Strictly above
 * everything it held, so no pair can tie; and at most `n` milliseconds of drift
 * against rows in *other* folders, which only the All tab compares it with.
 */
export function resolveDrop(
  neighbours: readonly SessionRow[],
  index: number,
  dragged: SessionRow,
): { readonly rank: number; readonly also: readonly Placement[] } {
  const slot = Math.min(Math.max(index, 0), neighbours.length);
  const above = neighbours[slot - 1];
  const below = neighbours[slot];
  const mid = rankBetween(
    above === undefined ? null : effectiveRank(above.snapshot),
    below === undefined ? null : effectiveRank(below.snapshot),
  );
  if (mid !== null) return { rank: mid, also: [] };

  const order = [...neighbours.slice(0, slot), dragged, ...neighbours.slice(slot)];
  const top = neighbours.reduce(
    (best, row) => Math.max(best, effectiveRank(row.snapshot)),
    effectiveRank(dragged.snapshot),
  );
  const placed = order.map((row, at) => ({ row, rank: top + order.length - at }));
  const mine = placed.find((entry) => entry.row.key === dragged.key);
  return {
    rank: mine?.rank ?? top + order.length,
    // Everything except the dragged row, whose rank the caller sends beside the
    // rest of its patch — a drop that also pins writes both fields in one request.
    also: placed.filter((entry) => entry.row.key !== dragged.key),
  };
}

/**
 * What a row looks like while a position write is in flight.
 *
 * The rail is derived from `state.sessions`, which the four-second poll replaces
 * wholesale — so a drop that is not overlaid springs back under the finger and
 * then lands again a moment later when the answer arrives. This is the overlay,
 * kept pure so a driver can hold it.
 *
 * `pinned` rides with `rank` because dropping a row into the pinned group is one
 * act that changes both, and an overlay carrying only half of it would draw the
 * row in its old group at its new position.
 */
export function mergeOptimistic<T extends { pinned?: boolean; rank?: number | null }>(
  snapshot: T,
  patch: { pinned?: boolean; rank?: number | null } | undefined,
): T {
  if (patch === undefined) return snapshot;
  return {
    ...snapshot,
    ...(patch.pinned === undefined ? {} : { pinned: patch.pinned }),
    ...(patch.rank === undefined ? {} : { rank: patch.rank }),
  };
}
