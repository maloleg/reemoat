/**
 * Press a session row and drag it.
 *
 * The DOM half of the rail's order. The arithmetic is pure and lives in
 * `sessionOrder.ts`; what is here is the gesture, which is the part no driver in
 * this repository can reach.
 *
 * ## What it borrows from the agent strip, and the three places it cannot
 *
 * `MachineAgentsSection` reorders a list with no library, and the *feel* is taken
 * from it exactly: the dragged row carries its own transform written straight to
 * its node, every row between where it left and where it is going shifts by one
 * row in the direction that opens the gap, and only the neighbours are
 * transitioned. Q3.533 argues all three and they are unchanged here.
 *
 * ⚠ **The row may not carry `touch-none`.** There the handle is a 44px square
 * inside a sheet, so taking every touch gesture on it costs nothing. Here the row
 * **is** the rail's scrolling surface, so `touch-action: none` would take
 * scrolling away from nine tenths of the list. What replaces it is that file's
 * *second* guard, a non-passive `touchmove` listener that `preventDefault`s only
 * while a drag is live, and the arming below is what makes it sufficient.
 *
 * ⚠ **A mouse arms on movement and a finger on time.** The hold is a touch
 * idiom: a finger's other verb on this surface is *scroll the rail*, and the two
 * have to be separated before either commits. A pointer has a button, so the press
 * already says which row, and there is nothing to disambiguate or wait for.
 *
 * ⚠ **There is no single list to index into.** The strip divides travel by one
 * measured row height. This rail interleaves 36px section headers with 44-56px
 * rows across two *groups*, so a drag is a move between **zones**: every slot is
 * measured once when the drag arms, in the scroller's content coordinates, which
 * also removes the strip's `startY` fixup during auto-scroll.
 *
 * ## Where a row may go
 *
 * **Pinned, and its own folder.** A folder is `git.repoRoot ?? requestedCwd`, a
 * fact about where the work is, so no drop can move a conversation into a
 * different one. Landing in Pinned pins; **leaving Pinned unpins**, and it unpins
 * whether or not the folder it returns to is on screen: a collapsed folder, or one
 * the filter is hiding, is still where that session lives. Both are one request
 * carrying `pinned` and `rank` together, because two would half-apply.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { isTypingInto } from "../keys";
import { canReorder, rankForMove, resolveDrop, type Placement } from "../sessionOrder";
import type { SessionKey } from "../ids";
import { sessionGroups, store, type AppState, type SessionRow } from "../store";
import { PINNED_FOLDER, folderId, folderPathOf, siblingsOf } from "./groups";
import { toast } from "./Toast";

/**
 * How long a finger has to be still before the row becomes draggable.
 *
 * 400ms. A tap is 60-150ms, so nothing that means "open this session" ever arms;
 * UIKit's own long press is 500ms, and this is shorter because the row underneath
 * is a list you also scroll.
 */
export const PRESS_MS = 400;

/**
 * How far a **mouse** travels with the button down before the drag is on.
 *
 * 4px, past a click's jitter and nothing more. Waiting instead put a 400ms window
 * in front of the gesture in which the natural response cancelled it.
 */
export const MOUSE_SLOP = 4;

/**
 * How far a **finger** may move before the hold is abandoned to the scroller.
 *
 * 8px in any direction, below the ~10px at which engines commit a pan, so the
 * timer is dead before the scroller could have taken the touch. Horizontal counts
 * because an edge swipe is the platform's own Back.
 */
export const PRESS_SLOP = 8;

/**
 * How far past the Pinned group a row must be carried before it leaves it.
 *
 * ⚠ **Zero was two bugs at once.** Reaching the *last* place in Pinned means
 * putting the pointer below the last row's middle, and with the group's own edge
 * as the boundary the band that meant "last, still pinned" was half a row tall —
 * overshoot it and the row silently unpinned instead. And unpinning is the one
 * thing here that is not undone by dragging back, so it is the one that should
 * cost a deliberate movement rather than a slip.
 *
 * 48px, about a row: far enough that nobody reaches it by aiming at the end of
 * the list, near enough that carrying a row out of the group is one motion.
 */
const UNPIN_MARGIN = 48;

/**
 * How far a press has to travel on a row that cannot be reordered before the
 * refusal is said out loud.
 *
 * Between {@link MOUSE_SLOP} and {@link PRESS_SLOP}: past both, so the sentence is
 * owed only to somebody who has plainly *tried to drag* rather than to anybody who
 * touched the row, and short enough that the attempt and the answer are one motion.
 */
const REFUSAL_SLOP = 12;

/** Said once per press, to whichever of the two input paths noticed the attempt. */
const TOO_OLD = "This machine's daemon is too old to store an order. Restart it after updating.";

/** What a write that was never issued did not do. One sentence, two callers. */
const UNREACHABLE = "That machine is not reachable right now, so the row was not moved.";

/** What a re-space says when it could not move every row it had to. One sentence. */
const PART_MOVED = "Some rows beside it did not move, so this group is not in the order you asked for.";

/** Pixels from an edge of the scroller at which a live drag starts scrolling it. */
const SCROLL_EDGE = 60;
/** The fastest that scroll goes, per frame. */
const SCROLL_MAX = 14;

/** How fast to scroll, given how far into the edge band the pointer is. */
function driftFor(box: { top: number; bottom: number }, y: number): number {
  const intoTop = SCROLL_EDGE - (y - box.top);
  if (intoTop > 0) return -Math.min(SCROLL_MAX, (intoTop / SCROLL_EDGE) * SCROLL_MAX);
  const intoBottom = SCROLL_EDGE - (box.bottom - y);
  if (intoBottom > 0) return Math.min(SCROLL_MAX, (intoBottom / SCROLL_EDGE) * SCROLL_MAX);
  return 0;
}

/**
 * A zone id, safe to put in an attribute and to read back out.
 *
 * ⚠ **A `FolderId` joins the machine id to the path with U+0000**, the one byte
 * a POSIX path cannot hold, which is what makes it collision-proof. An attribute
 * is not a place that byte survives reliably: the HTML parser replaces it with
 * U+FFFD, and whether one set through `setAttribute` reads back identically is an
 * engine's business rather than a guarantee.
 */
const asAttribute = (zone: string): string => encodeURIComponent(zone);

/** One group a row may be dropped into, measured when the drag arms. */
interface Zone {
  id: string;
  /** Its rows in draw order, the dragged one included. */
  rows: SessionRow[];
  /** Each row's vertical middle, in the scroller's content coordinates. */
  middles: number[];
  top: number;
  bottom: number;
}

/** Where the dragged row will land. `zone === null` is "out of Pinned, no folder drawn". */
interface Target {
  zone: string | null;
  /** The slot between the target zone's rows, the dragged one excluded. */
  index: number;
}

/** What the rail needs to know while a drag is happening. */
export interface RowDrag {
  /** Put this on the one scroller the rail has. */
  scrollerRef: (node: HTMLDivElement | null) => void;
  /** The key of the row under the pointer, or `null`. */
  dragging: string | null;
  /** The key of a row being held down before the press has become a drag. */
  pressing: string | null;
  /** True while any drag is live, which is when a shift is worth animating. */
  sliding: boolean;
  /**
   * Put this on the thing that follows the pointer while a drag is live.
   *
   * ⚠ **A ref rather than a coordinate in state.** The pointer moves every frame,
   * and per-frame work goes to the DOM — Q3.533's rule, and the reason the dragged
   * row's own offset never goes through React either. A `left`/`top` in state is a
   * render of the whole rail per pointer event, which on a phone is most of what
   * "it moves very unsmoothly" ever means.
   */
  pillRef: (node: HTMLElement | null) => void;
  /** True while releasing here would unpin the row being carried. */
  unpinning: boolean;
  /**
   * How much taller or shorter a group is while a row is in the air over it.
   *
   * ⚠ **Translating rows does not make room for one.** A row carried from a
   * folder into Pinned makes that group one row taller and its own folder one row
   * shorter, and a `translateY` on the rows below the insertion point moves them
   * *over* whatever the group ends at — reported as Pinned "riding on top of" the
   * sessions under it. The group being joined reserves the height and the group
   * being left gives it back, so everything below both of them stays exactly
   * where it is and the document does not change height at all.
   */
  spaceFor: (zone: string) => number;
  /**
   * How far this row stands aside, in pixels.
   *
   * `index` is its position in the zone's own drawn list, the same list the DOM
   * holds, because that is what the shift is computed against.
   */
  shiftFor: (zone: string, index: number, key: string) => number;
  /** Wire a row up. `zone` is its folder id, or `PINNED_FOLDER` if it is pinned. */
  bind: (row: SessionRow, zone: string) => {
    "data-row-key": string;
    "data-zone": string;
    onPointerDown: (event: React.PointerEvent<HTMLElement>) => void;
    onPointerMove: (event: React.PointerEvent<HTMLElement>) => void;
    onPointerUp: (event: React.PointerEvent<HTMLElement>) => void;
    onPointerCancel: (event: React.PointerEvent<HTMLElement>) => void;
    onLostPointerCapture: (event: React.PointerEvent<HTMLElement>) => void;
    onContextMenu: (event: React.MouseEvent<HTMLElement>) => void;
    onClickCapture: (event: React.MouseEvent<HTMLElement>) => void;
    onDragStart: (event: React.DragEvent<HTMLElement>) => void;
    onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => void;
  };
}

export function useRowDrag(state: AppState): RowDrag {
  const [pressing, setPressing] = useState<string | null>(null);
  /**
   * The drag as every *other* row sees it.
   *
   * Per-frame work goes to the DOM and per-row work goes to React, Q3.533's rule.
   * The dragged row's offset is written straight onto its node; this is the target,
   * which changes once per row crossed and which every neighbour's shift is a
   * function of.
   */
  const [move, setMove] = useState<{
    key: string;
    height: number;
    origin: { zone: string; index: number };
    target: Target;
  } | null>(null);

  const scroller = useRef<HTMLDivElement | null>(null);
  const live = useRef<{
    row: SessionRow;
    node: HTMLElement;
    pointerId: number;
    startY: number;
    startX: number;
    /** Where in the row the pointer landed, so it stays under the same pixel. */
    grab: number;
    /** The translate currently written on the node, so its base can be recovered. */
    applied: number;
    byMove: boolean;
    armed: boolean;
    zones: Zone[];
    origin: { zone: string; index: number };
    height: number;
    target: Target;
  } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rolling = useRef<number | null>(null);
  const lastY = useRef(0);
  const lastX = useRef(0);
  /** Set when a drag armed, so the `click` the pointer leaves behind is eaten. */
  const suppress = useRef(false);
  /** The "release to unpin" badge, moved by hand for the reason above. */
  const pill = useRef<HTMLElement | null>(null);
  /**
   * The current render's state, for the touch listeners.
   *
   * They are registered once for the component's life — see the effect below,
   * which is the whole point of them — so they cannot close over a `state` that
   * stays right. A ref rewritten every render is the standing way out.
   */
  const latest = useRef(state);
  latest.current = state;
  /**
   * A press that began on a row whose machine cannot store an order.
   *
   * Held rather than answered immediately: a press is not yet a question, and the
   * sentence is owed once somebody has plainly *tried to drag*.
   */
  const refused = useRef<{ x: number; y: number; told: boolean } | null>(null);

  const contentY = (clientY: number): number => {
    const box = scroller.current;
    if (box === null) return clientY;
    return clientY - box.getBoundingClientRect().top + box.scrollTop;
  };

  /**
   * Owe the refusal, once, to a press that has become an attempt.
   *
   * One body for both input paths: two copies of a distance and a sentence is two
   * places for them to disagree, and only one of the two would be noticed.
   */
  const tellRefused = (x: number, y: number): void => {
    const denied = refused.current;
    if (denied === null || denied.told) return;
    if (Math.hypot(y - denied.y, x - denied.x) <= REFUSAL_SLOP) return;
    denied.told = true;
    toast("error", TOO_OLD);
  };

  /**
   * Move the neighbours a re-space has to move, and account for the ones it cannot.
   *
   * ⚠ **`canReorder` was tested for the dragged row and for nothing else.** Under
   * the All tab `PINNED_FOLDER` is one group spanning machines — `pinnedHere`
   * applies no machine cut there — so a neighbour can belong to a daemon that has
   * never heard of `rank` and answers `400` to a body carrying only that field.
   * Skipping it here is the difference between a row that stays put and a request
   * that could never have worked.
   *
   * ⚠ **And one sentence for the group, not one per row.** Each write reports its
   * own refusal, and `resolveDrop` can hand back every row in a folder — so the
   * unguarded loop answered a re-space of thirty with thirty toasts. What the
   * reader needs is the fact that the order they see is not the order they asked
   * for, said once; which rows is not something they can act on.
   *
   * The dragged row is deliberately not in here. Its write is the one that must
   * land, its failure is a different sentence, and its rank rides its own patch
   * because a drop into Pinned changes `pinned` in the same request.
   */
  const respace = (also: readonly Placement[]): void => {
    let told = false;
    const note = (): void => {
      if (told) return;
      told = true;
      toast("error", PART_MOVED);
    };
    for (const entry of also) {
      if (!canReorder(entry.row.snapshot)) {
        note();
        continue;
      }
      if (!store.setSessionMeta(entry.row.ref, { rank: entry.rank }, note)) note();
    }
  };

  const clearTimer = (): void => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  };

  /** Measure the two zones this row may be dropped into, once, when it arms. */
  const measure = (row: SessionRow): { zones: Zone[]; height: number } => {
    const box = scroller.current;
    if (box === null) return { zones: [], height: 0 };
    const offset = box.getBoundingClientRect().top - box.scrollTop;
    const wanted = new Set<string>([PINNED_FOLDER, folderId(row.ref.machineId, folderPathOf(row))]);
    const byZone = new Map<string, { rows: SessionRow[]; middles: number[]; top: number; bottom: number }>();
    let height = 0;
    for (const node of box.querySelectorAll<HTMLElement>("[data-row-key][data-zone]")) {
      const id = decodeURIComponent(node.dataset["zone"] ?? "");
      if (!wanted.has(id)) continue;
      // `latest.current`, not the render's own `state`: the touch path reaches
      // here through a 400ms `setTimeout(arm)`, so the closure `arm` was captured
      // from can be a poll behind by the time it runs — the hazard the `latest`
      // docblock states and `onTouchStart` already observes.
      const other = latest.current.rowsByKey.get((node.dataset["rowKey"] ?? "") as SessionKey);
      if (other === undefined) continue;
      const rect = node.getBoundingClientRect();
      const top = rect.top - offset;
      const bottom = rect.bottom - offset;
      height = Math.max(height, rect.height);
      const zone = byZone.get(id) ?? { rows: [], middles: [], top, bottom };
      zone.rows.push(other);
      zone.middles.push((top + bottom) / 2);
      zone.top = Math.min(zone.top, top);
      zone.bottom = Math.max(zone.bottom, bottom);
      byZone.set(id, zone);
    }
    return { zones: [...byZone].map(([id, zone]) => ({ id, ...zone })), height };
  };

  /**
   * Where the pointer says this row is going.
   *
   * **Leaving Pinned unpins, whether or not the folder is drawn.** A collapsed
   * folder, or one the filter is hiding, is still where the session lives, so the
   * answer there is a `null` zone: it writes `pinned: false` and leaves the
   * position alone rather than inventing one out of a list nobody can see.
   */
  const pickTarget = (going: NonNullable<typeof live.current>, y: number): Target => {
    const slotIn = (zone: Zone): number => {
      let slot = 0;
      for (let i = 0; i < zone.rows.length; i += 1) {
        if ((zone.rows[i] as SessionRow).key === going.row.key) continue;
        if (y > (zone.middles[i] as number)) slot += 1;
      }
      return slot;
    };
    const pinnedZone = going.zones.find((zone) => zone.id === PINNED_FOLDER);
    const ownZone = going.zones.find((zone) => zone.id !== PINNED_FOLDER);
    /*
     * ⚠ **The boundary is whichever group is nearer, never one group's own
     * edge**, and getting that wrong is what made the last place in Pinned
     * unreachable — twice. That slot means "below the last row's middle", so
     * against a bare edge it is a band half a row tall with the *other group* on
     * the far side of it; aiming at the end of the list landed past the edge and
     * the row went somewhere else. Widening the band only for rows already pinned
     * fixed it for those and left it broken for a row arriving from a folder,
     * which is the same bug reported a second time.
     *
     * Distance answers every case at once: inside a group is distance zero, and
     * between two groups the header gap splits down the middle. Nothing has an
     * edge to fall off.
     */
    const gap = (zone: Zone): number => (y < zone.top ? zone.top - y : y > zone.bottom ? y - zone.bottom : 0);
    /*
     * The one asymmetry left, and it is about consequence rather than geometry:
     * **leaving Pinned is the only outcome a drag cannot take back**, so a row
     * already in the group holds on to it for an extra 48px. A row arriving from a
     * folder is not leaving anything and gets no such bias.
     */
    const sticky = going.origin.zone === PINNED_FOLDER ? UNPIN_MARGIN : 0;

    if (pinnedZone !== undefined && ownZone !== undefined) {
      const nearer = gap(pinnedZone) - sticky <= gap(ownZone) ? pinnedZone : ownZone;
      return { zone: nearer.id, index: slotIn(nearer) };
    }
    if (pinnedZone !== undefined && gap(pinnedZone) <= sticky) {
      return { zone: PINNED_FOLDER, index: slotIn(pinnedZone) };
    }
    if (ownZone !== undefined) return { zone: ownZone.id, index: slotIn(ownZone) };
    return going.origin.zone === PINNED_FOLDER ? { zone: null, index: 0 } : going.origin;
  };

  const place = (clientY: number, clientX?: number): void => {
    const going = live.current;
    if (going === null || !going.armed) return;
    const y = contentY(clientY);
    /*
     * ⚠ **Anchored to where the row actually is, not to where it was when the
     * drag armed**, and that is what stopped it jumping. Carrying a row from a
     * folder up into Pinned makes that group a row taller, which pushes the folder
     * — and the row being carried — down by exactly one row. Against a fixed
     * origin the transform did not know, so the row leapt a row's height at the
     * moment it crossed, and leapt back on the way out.
     *
     * Recovering the base each frame costs one rect read and is self-correcting
     * against *any* layout change: the reserved space animating in over 150ms, the
     * scroller moving under an auto-scroll, a poll adding a row above. `roll` runs
     * this every frame while a drag is live, so a still pointer over a moving
     * layout stays glued too.
     */
    const base = going.node.getBoundingClientRect().top - going.applied;
    const offset = clientY - going.grab - base;
    going.applied = offset;
    going.node.style.transform = `translateY(${offset}px)`;
    const badge = pill.current;
    if (badge !== null) {
      const box = scroller.current;
      const left = box === null ? 0 : (clientX ?? lastX.current) - box.getBoundingClientRect().left;
      badge.style.transform = `translate3d(${left}px, ${y}px, 0)`;
    }
    const next = pickTarget(going, y);
    if (next.zone === going.target.zone && next.index === going.target.index) return;
    going.target = next;
    setMove({ key: going.row.key, height: going.height, origin: going.origin, target: next });
  };

  const roll = (): void => {
    const box = scroller.current;
    const going = live.current;
    if (box === null || going === null || !going.armed) {
      rolling.current = null;
      return;
    }
    const drift = driftFor(box.getBoundingClientRect(), lastY.current);
    if (drift !== 0) box.scrollTop += drift;
    // Every frame, not only when the scroll moved: the space a group reserves
    // animates in over 150ms, so the row's own base is still travelling while the
    // pointer is perfectly still.
    place(lastY.current);
    rolling.current = requestAnimationFrame(roll);
  };

  const end = useCallback((): void => {
    clearTimer();
    if (rolling.current !== null) cancelAnimationFrame(rolling.current);
    rolling.current = null;
    const going = live.current;
    live.current = null;
    setMove(null);
    setPressing(null);
    if (going === null) return;
    going.node.style.transform = "";
    going.node.style.willChange = "";
    going.node.style.touchAction = "";
    going.node.style.webkitUserSelect = "";
    going.node.style.userSelect = "";
    going.node.style.removeProperty("-webkit-touch-callout");
    if (!going.armed) return;

    const wasPinned = going.row.snapshot.pinned === true;
    const nowPinned = going.target.zone === PINNED_FOLDER;
    const zone = going.zones.find((entry) => entry.id === going.target.zone);
    const say = (message: string): void => toast("error", message);

    if (zone === undefined) {
      if (nowPinned === wasPinned) return;
      if (!store.setSessionMeta(going.row.ref, { pinned: nowPinned }, say)) say(UNREACHABLE);
      return;
    }

    /*
     * ⚠ **One index means "it did not move", and it used to be two.**
     *
     * `origin.index` counts the zone's rows *with* the dragged one in them;
     * `target.index` is a slot among the others, which is what `resolveDrop`
     * takes. In those two coordinate systems the only drop that changes nothing
     * is `target === origin` — slot `origin + 1` puts the row one place *below*
     * where it was. Treating that as a no-op swallowed every move down by exactly
     * one place, silently, and the last slot of a group is reachable from the
     * row above it in no other way: this is "I cannot put anything in the last
     * place, I can only carry the last one higher" and "moving the second-to-last
     * session to the last place does not go through", which are one bug reported
     * twice.
     */
    if (nowPinned === wasPinned && going.target.zone === going.origin.zone) {
      if (going.target.index === going.origin.index) return;
    }
    const neighbours = zone.rows.filter((row) => row.key !== going.row.key);
    const landed = resolveDrop(neighbours, going.target.index, going.row);
    const patch = nowPinned === wasPinned ? { rank: landed.rank } : { rank: landed.rank, pinned: nowPinned };
    if (!store.setSessionMeta(going.row.ref, patch, say)) {
      say(UNREACHABLE);
      return;
    }
    respace(landed.also);
  }, []);

  /**
   * The press has become a drag: measure, take the pointer, lift the row.
   *
   * One body for both paths, because everything after the *decision* is identical
   * and only what makes the decision differs.
   */
  const arm = (): void => {
    const going = live.current;
    if (going === null || going.armed) return;
    clearTimer();
    const measured = measure(going.row);
    const zone = measured.zones.find((entry) => entry.rows.some((row) => row.key === going.row.key));
    if (zone === undefined) {
      live.current = null;
      setPressing(null);
      return;
    }
    going.armed = true;
    going.zones = measured.zones;
    going.height = measured.height;
    going.origin = { zone: zone.id, index: zone.rows.findIndex((row) => row.key === going.row.key) };
    going.target = { zone: zone.id, index: going.origin.index };
    suppress.current = true;
    if (going.byMove) {
      try {
        going.node.setPointerCapture(going.pointerId);
      } catch {
        // A pointer that has already gone. The drag ends on the next event.
      }
    }
    going.node.style.touchAction = "none";
    going.node.style.willChange = "transform";
    setPressing(null);
    setMove({ key: going.row.key, height: going.height, origin: going.origin, target: going.target });
    place(lastY.current);
    if (rolling.current === null) rolling.current = requestAnimationFrame(roll);
    /*
     * ⭐ **The moment the row comes off the list, said in the one channel a thumb
     * is covering the screen with.**
     *
     * A hold is a gesture with no visible beginning: for 400ms the app must look
     * like it is doing nothing, and then it must be unmistakable that it is not.
     * The visual half of that is a shadow and a lift under the finger — which is
     * under the *finger*, and therefore the part of the screen nobody can see. So
     * the arming is also a tick of haptic, which is what both phone platforms use
     * for exactly this moment in exactly this gesture.
     *
     * Optional on the type and guarded at the call: no engine on a desktop
     * implements it, iOS implements nothing here at all, and a missing method may
     * not be the reason a drag does not start.
     */
    if (!going.byMove) navigator.vibrate?.(12);
  };

  /**
   * A finger's whole gesture, from the first touch to the last.
   *
   * ⭐ **This is the fourth attempt at "it still does not work on a phone", and
   * the first one that does not begin in `pointerdown`.**
   *
   * The three before it each fixed something real — the iOS callout, Android's
   * context menu, and finally moving the *drag* onto touch events because
   * `pointercancel` means "the browser has claimed this gesture" for a finger and
   * "the gesture is over" for a mouse. All three left the **setup** in
   * `onPointerDown`, and that is the assumption none of them questioned: that
   * `pointerdown` arrives before the engine has decided what this touch is for.
   *
   * In Blink it does. That ordering is not something the Pointer Events
   * specification requires, and an engine that dispatches `touchstart` first has
   * already been asked whether this gesture can be prevented by the time
   * `pointerdown` runs — so a listener registered there, a `-webkit-touch-callout`
   * set there, a hold started there, are all one event too late, every time,
   * on that engine only. Which is the exact shape of a bug that works on every
   * desktop and has never once worked on a phone.
   *
   * So a finger is now handled entirely on the touch stream and never touches the
   * pointer one: `touchstart` decides which row, `touchmove` decides whether this
   * was a scroll, and `touchend`/`touchcancel` finish. `bind`'s pointer handlers
   * are a mouse's, and say so.
   *
   * ⚠ **Non-passive, and attached to the scroller rather than to the document.**
   * React attaches `onTouchStart`/`onTouchMove` passively, so `preventDefault`
   * from a JSX handler is ignored — that part is unchanged and is why these are
   * `addEventListener` at all. A touch's target is *latched* at `touchstart`, so
   * the scroller is in the path of every event of the gesture including the ones
   * delivered after the finger has left it, and being an ordinary element it is
   * clear of the passive-by-default treatment `window`, `document` and `body` get.
   */
  const touchOps = useRef({
    start: (_event: TouchEvent): void => {},
    move: (_event: TouchEvent): void => {},
    stop: (): void => {},
  });
  const mouseOps = useRef((_event: PointerEvent): void => {});
  /* Stable identities, so the listeners can be taken off the node they went on. */
  const relay = useRef({
    start: (event: TouchEvent): void => touchOps.current.start(event),
    move: (event: TouchEvent): void => touchOps.current.move(event),
    stop: (): void => touchOps.current.stop(),
  });

  /**
   * Where the touch gesture begins, and the only place it may.
   *
   * The row is found from the event rather than from a closure, because these
   * listeners belong to the scroller and outlive every row in it.
   */
  const onTouchStart = (event: TouchEvent): void => {
    /*
     * A second finger is a pinch or a two-finger scroll and never this, and a
     * gesture already in the air is abandoned rather than confused: the arithmetic
     * from here on is written for one contact.
     */
    if (event.touches.length !== 1) {
      if (live.current !== null) end();
      return;
    }
    const finger = event.touches.item(0);
    const from = event.target instanceof Element ? event.target : null;
    if (finger === null || from === null) return;
    // The row is the drag surface *except* where it already carries a control.
    if (from.closest("[data-no-drag]") !== null) return;
    const node = from.closest<HTMLElement>("[data-row-key][data-zone]");
    if (node === null) return;
    const row = latest.current.rowsByKey.get((node.dataset["rowKey"] ?? "") as SessionKey);
    if (row === undefined) return;
    if (!canReorder(row.snapshot)) {
      refused.current = { x: finger.clientX, y: finger.clientY, told: false };
      return;
    }
    refused.current = null;
    suppress.current = false;
    live.current = {
      row,
      node,
      pointerId: -1,
      startY: finger.clientY,
      startX: finger.clientX,
      grab: finger.clientY - node.getBoundingClientRect().top,
      applied: 0,
      byMove: false,
      armed: false,
      zones: [],
      origin: { zone: decodeURIComponent(node.dataset["zone"] ?? ""), index: 0 },
      height: 0,
      target: { zone: decodeURIComponent(node.dataset["zone"] ?? ""), index: 0 },
    };
    lastY.current = finger.clientY;
    lastX.current = finger.clientX;
    /*
     * ⚠ **Set here, which is the whole reason this handler exists.** iOS decides
     * at `touchstart` whether a long press on this element will raise its own
     * callout and start a selection, and it cancels the touch when it does. Set
     * from `pointerdown` on an engine that dispatches `touchstart` first, this
     * arrived after the decision it exists to change. Switched off for the length
     * of the press rather than for the life of the list: a mouse keeps both.
     */
    node.style.webkitUserSelect = "none";
    node.style.userSelect = "none";
    // Not in the DOM typings, and the only way to stop iOS opening its own menu
    // over a row that is about to move.
    node.style.setProperty("-webkit-touch-callout", "none");
    clearTimer();
    setPressing(row.key);
    timer.current = setTimeout(arm, PRESS_MS);
  };

  const onTouchMove = (event: TouchEvent): void => {
    const going = live.current;
    const finger = event.touches.item(0);
    if (finger === null) return;
    if (going === null) {
      tellRefused(finger.clientX, finger.clientY);
      return;
    }
    // A mouse drag is not this gesture, whatever else the screen is reporting.
    if (going.byMove) return;
    lastY.current = finger.clientY;
    lastX.current = finger.clientX;
    if (going.armed) {
      // Ours now, and refusing the default is what keeps the scroller from taking
      // it back. Only ever while a drag is live, which is what leaves the other
      // nine tenths of this list scrolling normally.
      if (event.cancelable) event.preventDefault();
      place(finger.clientY, finger.clientX);
      return;
    }
    // Handed back: this was a scroll all along. Through `end` rather than by hand,
    // so the styles the press put on the row come off on both paths.
    if (Math.hypot(finger.clientY - going.startY, finger.clientX - going.startX) > PRESS_SLOP) end();
  };

  /**
   * A mouse press that has left the rail before it armed.
   *
   * The row's own `onPointerMove` answers every ordinary case — the cursor is on
   * the row it pressed, and even a cursor that has crossed onto another row is on
   * a sibling sharing this exact handler. What it cannot see is a press that
   * travels its four pixels straight off the list, or a button released over
   * another window; without capture at the press (see `onPointerDown`) those leave
   * a press live with nothing to end it. So the document carries the same two
   * rules, and they are deliberately the same two rather than a second opinion.
   */
  const onMousePointer = (event: PointerEvent): void => {
    const going = live.current;
    if (going === null || !going.byMove || going.armed) return;
    if (going.pointerId !== event.pointerId) return;
    if (event.type !== "pointermove") {
      end();
      return;
    }
    lastY.current = event.clientY;
    lastX.current = event.clientX;
    if (Math.hypot(event.clientY - going.startY, event.clientX - going.startX) > MOUSE_SLOP) arm();
  };

  touchOps.current = { start: onTouchStart, move: onTouchMove, stop: () => end() };
  mouseOps.current = onMousePointer;

  useEffect(() => {
    const relayed = (event: PointerEvent): void => mouseOps.current(event);
    document.addEventListener("pointermove", relayed);
    document.addEventListener("pointerup", relayed);
    document.addEventListener("pointercancel", relayed);
    return () => {
      document.removeEventListener("pointermove", relayed);
      document.removeEventListener("pointerup", relayed);
      document.removeEventListener("pointercancel", relayed);
    };
  }, []);

  useEffect(() => end, [end]);

  /*
   * ⚠ **The listeners go on in the ref callback, not in an effect.** They have to
   * exist before the first `touchstart` the node can receive, and a callback ref
   * runs during the commit that puts the node in the document rather than after
   * it. It also answers the node being *replaced* — a route change remounting the
   * rail — which an effect with an empty dependency list never would.
   */
  const scrollerRef = useCallback((node: HTMLDivElement | null): void => {
    const going = relay.current;
    const previous = scroller.current;
    if (previous !== null) {
      previous.removeEventListener("touchstart", going.start);
      previous.removeEventListener("touchmove", going.move);
      previous.removeEventListener("touchend", going.stop);
      previous.removeEventListener("touchcancel", going.stop);
    }
    scroller.current = node;
    if (node === null) return;
    node.addEventListener("touchstart", going.start, { passive: false });
    node.addEventListener("touchmove", going.move, { passive: false });
    node.addEventListener("touchend", going.stop);
    node.addEventListener("touchcancel", going.stop);
  }, []);

  /**
   * Where a row stands while another one is dragged over it.
   *
   * ⭐ **The strip's rule, generalised to two groups.** Within one group it is
   * `MachineAgentsSection.shiftFor` unchanged: every row between where the dragged
   * one left and where it is going moves by exactly one row, in the direction that
   * opens the gap. Across two, it is the same statement twice, the group being
   * left closing its gap and the group being joined opening one, which is what
   * makes a row crossing into Pinned look like two lists trading a row rather than
   * like one list glitching.
   */
  const shiftFor = (zone: string, index: number, key: string): number => {
    if (move === null || key === move.key) return 0;
    const { origin, target, height } = move;
    if (zone === origin.zone && zone === target.zone) {
      if (target.index > origin.index && index > origin.index && index <= target.index) return -height;
      if (target.index < origin.index && index >= target.index && index < origin.index) return height;
      return 0;
    }
    if (zone === origin.zone) return index > origin.index ? -height : 0;
    if (zone === target.zone) return index >= target.index ? height : 0;
    return 0;
  };

  const bind = (row: SessionRow, zone: string): ReturnType<RowDrag["bind"]> => ({
    "data-row-key": row.key,
    "data-zone": asAttribute(zone),
    /*
     * ⚠ **A mouse's, and nothing else's.** A finger's gesture is the scroller's
     * touch listeners above, start to finish — see the argument there. Leaving the
     * two overlapping is how the same press got decided twice, by two rules that
     * disagreed about what a cancellation means.
     */
    onPointerDown: (event) => {
      if (event.pointerType !== "mouse" || event.button !== 0) return;
      /*
       * ⚠ **The row's trailing controls are not a place to grab it by**, and
       * leaving them in was what broke the kebab outright. A mouse takes the
       * pointer at the press here, so every later event — the `click` the menu
       * needs included — was retargeted to the row and the button never heard from
       * the gesture it started. The row is the drag surface *except* where it
       * already carries a control; `data-no-drag` is that exception, marked on the
       * markup rather than tested by tag, because the next control added there
       * should inherit it without this file learning its name.
       */
      if ((event.target as HTMLElement).closest("[data-no-drag]") !== null) return;
      if (!canReorder(row.snapshot)) {
        refused.current = { x: event.clientX, y: event.clientY, told: false };
        return;
      }
      refused.current = null;
      suppress.current = false;
      live.current = {
        row,
        node: event.currentTarget,
        pointerId: event.pointerId,
        startY: event.clientY,
        startX: event.clientX,
        grab: event.clientY - event.currentTarget.getBoundingClientRect().top,
        applied: 0,
        byMove: true,
        armed: false,
        zones: [],
        origin: { zone, index: 0 },
        height: 0,
        target: { zone, index: 0 },
      };
      lastY.current = event.clientY;
      lastX.current = event.clientX;
      clearTimer();
      /*
       * ⚠ **The pointer is taken when the drag arms, and taking it at the press
       * silently broke opening a session by clicking it.**
       *
       * A captured pointer retargets everything that follows to the capturing
       * element — including the `click` the browser synthesises from the press.
       * The row is a `<div>` holding a navigating `<button>`, so with capture at
       * `pointerdown` that click was delivered to the `<div>`, the `<button>` was
       * never in the event's path, and its `onClick` never ran. Measured, not
       * reasoned: driving Chrome through the debugging protocol, `mousedown` lands
       * on the row's own label and `click` lands on the wrapper — while the same
       * click on the kebab, which returns above and captures nothing, reaches its
       * button normally. That is the whole mechanism and its control.
       *
       * What capture at the press was buying is the 4px before the drag arms: an
       * uncaptured `pointermove` goes to whatever is under the cursor. Four pixels
       * do not leave a 44px row, every row in the rail shares this one handler in
       * any case, and the document listeners below close the gap for the cursor
       * that leaves the list entirely. So it is bought back for nothing, and this
       * cost a click.
       */
    },
    onPointerMove: (event) => {
      if (event.pointerType !== "mouse") return;
      const going = live.current;
      if (going === null) {
        tellRefused(event.clientX, event.clientY);
        return;
      }
      // A finger's drag is live on the touch stream; the pointer events it also
      // emits are not this gesture and may not steer it.
      if (!going.byMove || going.pointerId !== event.pointerId) return;
      lastY.current = event.clientY;
      lastX.current = event.clientX;
      if (!going.armed) {
        if (Math.hypot(event.clientY - going.startY, event.clientX - going.startX) > MOUSE_SLOP) arm();
        return;
      }
      place(event.clientY, event.clientX);
    },
    /*
     * ⚠ **All three end a *mouse* drag and none of them ends a finger's.** For a
     * pointer, `pointercancel` and a lost capture mean the gesture is over. For a
     * finger they mean the browser has decided the gesture is **its** — which it
     * does the moment it commits to a scroll, on movement far smaller than the
     * hold tolerates, and which is the state this drag exists to take back. A
     * finger ends on `touchend` or `touchcancel`, on the scroller, and nowhere
     * else.
     */
    onPointerUp: (event) => {
      if (event.pointerType !== "mouse") return;
      refused.current = null;
      end();
    },
    onPointerCancel: (event) => {
      if (event.pointerType !== "mouse") return;
      refused.current = null;
      end();
    },
    onLostPointerCapture: (event) => {
      if (event.pointerType === "mouse") end();
    },
    /*
     * A row holds text and the browser will start its own drag of it, which then
     * races ours and wins: a ghost of the title following the cursor while the row
     * itself stays put.
     */
    onDragStart: (event: React.DragEvent<HTMLElement>) => event.preventDefault(),
    /*
     * ⚠ **Refused for the whole press, not just once it has armed.** Android's own
     * long press is around 500ms and this one arms at 400, so the two are close
     * enough to race — and the platform's menu opening over a row that is about to
     * move takes the gesture with it. Gated on a press being live rather than on
     * anything having happened yet, so the race has one answer.
     */
    onContextMenu: (event: React.MouseEvent<HTMLElement>) => {
      if (live.current !== null) event.preventDefault();
    },
    /*
     * A drag leaves a `click` behind, and this row's click opens the session.
     * Cleared on the next `pointerdown` as well, so a suppressed click that never
     * arrives cannot eat an ordinary tap later.
     */
    onClickCapture: (event: React.MouseEvent<HTMLElement>) => {
      if (!suppress.current) return;
      suppress.current = false;
      event.preventDefault();
      event.stopPropagation();
    },
    /**
     * ⚠ **The keyboard's way in, and it is owed rather than offered.**
     *
     * A pointer gesture that is the only way to reorder is a control a keyboard
     * cannot reach at all, Q3.533's rule. This list has no handle to hang arrows
     * on, so the row takes them held with `Alt`: the bare ones belong to the list,
     * `j`/`k` already walk it, and `Alt` is the platform's own idiom for *move the
     * thing* rather than *move among the things*.
     */
    onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => {
      /*
       * ⚠ **Typing beats this, like every other key rule in the app.**
       * `web-shell.md` states it as one of the two rules that decide the whole
       * keyboard, and the rename field is a descendant of the element carrying
       * this handler *and* autofocused — so without the guard Option+↑/↓, which
       * on macOS is a caret movement inside a text field, silently reorders the
       * list instead.
       */
      if (isTypingInto(event.target)) return;
      if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
      if (!canReorder(row.snapshot)) return;
      event.preventDefault();
      const siblings = siblingsOf(row, sessionGroups(state));
      const from = siblings.findIndex((other) => other.key === row.key);
      if (from < 0) return;
      const to = from + (event.key === "ArrowUp" ? -1 : 1);
      if (to < 0 || to >= siblings.length) return;
      const say = (message: string): void => toast("error", message);
      const direct = rankForMove(siblings, from, to);
      if (direct !== null) {
        if (!store.setSessionMeta(row.ref, { rank: direct }, say)) say(UNREACHABLE);
        return;
      }
      const landed = resolveDrop(
        siblings.filter((other) => other.key !== row.key),
        to,
        row,
      );
      if (!store.setSessionMeta(row.ref, { rank: landed.rank }, say)) {
        say(UNREACHABLE);
        return;
      }
      respace(landed.also);
    },
  });

  const pillRef = useCallback((node: HTMLElement | null): void => {
    pill.current = node;
    // The badge mounts mid-gesture, so it is placed once on arrival rather than
    // waiting for the next pointer event to find it.
    if (node !== null) place(lastY.current, lastX.current);
  }, []);

  const spaceFor = (zone: string): number => {
    if (move === null || move.target.zone === move.origin.zone) return 0;
    if (zone === move.target.zone) return move.height;
    if (zone === move.origin.zone) return -move.height;
    return 0;
  };

  return {
    scrollerRef,
    dragging: move?.key ?? null,
    pressing,
    sliding: move !== null,
    pillRef,
    unpinning: move !== null && move.origin.zone === PINNED_FOLDER && move.target.zone !== PINNED_FOLDER,
    spaceFor,
    shiftFor,
    bind,
  };
}
