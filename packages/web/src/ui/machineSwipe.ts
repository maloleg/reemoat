/**
 * Flick the chat list sideways to move between machines.
 *
 * Telegram's folder gesture, on the one screen shaped like Telegram's: below `lg`
 * the machine tabs are the strip across the top and the list under them belongs to
 * whichever tab is selected, so a horizontal flick on that list is the shortest
 * thing "show me the next machine" can be. Above `lg` the machines are a *column*
 * and the same flick means nothing, which is the section on the layout gate.
 *
 * ## Where it lives, and what it shares the surface with
 *
 * **The list scroller, not the strip.** The strip's own horizontal gesture is its
 * scroll, and taking that would be a third gesture on one 44px band.
 *
 * ⚠ **`machineDrag` needs no coordination with this, and that is structural
 * rather than lucky.** Its listeners are on the *strip's* scroller and these are
 * on the *list's*; the two are siblings, so a touch that begins on a tab never
 * reaches these handlers and a touch that begins on the list never reaches those.
 * Holding a tab to reorder it and flicking the list to change tab are two
 * gestures on one axis on one screen, and what keeps them apart is which box the
 * finger landed in — not a predicate either of them has to remember to ask.
 *
 * What this **does** share a surface with is `rowDrag`, which owns the same
 * scroller for its hold-to-reorder-a-chat. Those two are separated by one number
 * and one predicate:
 *
 * - **{@link SWIPE_SLOP} is `PRESS_SLOP`, imported rather than re-typed**, and the
 *   coincidence is load-bearing in both directions. `rowDrag` abandons an unarmed
 *   hold the moment a finger travels 8px *in any direction*, and that number's own
 *   docblock puts it below the ~10px at which engines commit a pan. So at the one
 *   distance where this decides it is horizontal, the hold is already dead **and**
 *   the scroller has not yet taken the touch. Two copies of that number drifting
 *   apart is a hold and a swipe both live on one finger.
 * - **`armed` refuses outright** while a row drag owns the touch — a finger held
 *   still for 400ms and *then* moved sideways is the case, and it is real. It is a
 *   function over a ref rather than a piece of React state, because this is a
 *   per-frame decision and the frame in which a hold arms is precisely the frame
 *   in which React has not been told yet.
 *
 * ## The contract
 *
 * **It begins on `touchstart`**, non-passive, through `addEventListener` — React
 * attaches `onTouchMove` **passively**, so a JSX handler's `preventDefault` is
 * swallowed with a console warning. Registered for the component's life rather
 * than the gesture's, because some engines decide at `touchstart` from whether
 * such a listener exists at all.
 *
 * **Horizontal intent is decided once per gesture** and never reconsidered: at the
 * first move past {@link SWIPE_SLOP}, the axis is `"x"` if
 * `|dx| > |dy| * DOMINANCE` and `"y"` otherwise. A diagonal is a scroll — the list
 * is the thing under the finger, and taking an ambiguous gesture away from it is
 * the failure `rowDrag` spent four attempts on. `event.cancelable === false` means
 * the engine has already claimed the pan, and arguing with it is how a swipe
 * becomes a stutter, so that is a `"y"` too.
 *
 * **`preventDefault` only after the axis resolves to `"x"`**, and never on
 * `touchstart` — which would kill the tap that opens a session.
 *
 * ⚠ **A second guard that does not share that cause**, which is
 * `agent-strip.md`'s standing pattern: `[touch-action:pan-y_pinch-zoom]` on the
 * same scroller, so the engine is told up front that this box pans vertically and
 * that the horizontal axis is the app's. Written as **one arbitrary value** rather
 * than `touch-pan-y touch-pinch-zoom`, because two utilities setting one property
 * are resolved by Tailwind's emission order rather than by the class string —
 * the defect `FIELD`'s docblock names. `pinch-zoom` is kept deliberately: `pan-y`
 * alone removes zoom from the whole rail, which is an accessibility loss for one
 * gesture's convenience. It is **not** `touch-none`, which would take vertical
 * scrolling from nine tenths of the list.
 *
 * ⚠ **The platform's own Back keeps its edge.** A touch beginning within
 * {@link EDGE_DEAD_ZONE} of either *viewport* edge is refused.
 * `html { overscroll-behavior: none }` stops the rubber-band and says nothing
 * about the edge swipe, which is the browser's and must stay the browser's —
 * `web-shell.md`'s "there is no back button" is the same rule from the other side.
 *
 * ## What it moves through, and what it does not do
 *
 * `[All, …machines]`, **clamped at both ends, never wrapping**. Telegram clamps;
 * and a wrap from the last machine back to All would scroll the strip a screen's
 * width under a gesture that moved eighty pixels, with the rubber-band at the ends
 * replaced by a lie about there being more.
 *
 * The commit is `selectMachine` and nothing else — module state, `localStorage`, a
 * version bump. **No route, no history entry, no view transition**: `router.ts`'s
 * `announce`/`data-nav` machinery is for a screen *replacing* another one, and
 * `navMove` has no value for a tab change.
 *
 * ## The animation, and the one thing CSS cannot reach
 *
 * The list follows the finger by a transform written **straight onto a wrapper
 * node**, once per `touchmove`. That is this app's standing rule — per-frame work
 * to the DOM, per-row work to React — and here it is also correctness: this rail
 * re-renders on the four-second poll and on every stream event, so a coordinate
 * held in state would be overwritten mid-gesture exactly the way a `style={{width}}`
 * rail snapped back to the start of a drag.
 *
 * ⚠ **`prefers-reduced-motion` is read here rather than left to `index.css`.**
 * That file's blanket block zeroes `transition-duration` on `*`, which handles the
 * settle for free — and cannot reach a transform this file writes per frame. It is
 * the same hole that file records having had three times. Under reduced motion no
 * transform is written at all and **the swipe still commits**: reduced motion
 * removes the motion, not the feature.
 *
 * ⚠ This is deliberately **not** Telegram's two-page turn. That needs both
 * machines' lists mounted at once, on a rail whose whole design is one machine on
 * screen at a time — `waitingFloor` exists because of it. What this is, is a nudge
 * and a swap.
 */

import { useCallback, useRef } from "react";
import { PRESS_SLOP, useTouchGesture } from "./rowDrag";
import { selectMachine, type MachineTab } from "./groups";

/** Where a gesture stops being undecided. `rowDrag`'s number, on purpose. */
export const SWIPE_SLOP = PRESS_SLOP;
/** How much more horizontal than vertical a flick must be to be one. */
const DOMINANCE = 1.5;
/** How close to a viewport edge the platform's own Back is left alone. */
const EDGE_DEAD_ZONE = 24;
/** How far a flick must travel before releasing it changes anything. */
const COMMIT = 56;
/** The most the list follows the finger by, inside the range. */
const CAP = 96;
/** What it follows by at either end, where there is nothing to move to. */
const RUBBER = 0.35;
/** How long the release takes to slide back to nothing. */
const SETTLE_MS = 160;
/** When the transition is taken back off the node, past the end of the slide. */
const SETTLE_CLEAR_MS = 180;

export interface MachineSwipe {
  /** Put this on the list's own scroller, composed with whatever else wants it. */
  scrollerRef: (node: HTMLElement | null) => void;
  /**
   * Put this on the `lg:hidden` wrapper the machine tabs are drawn in.
   *
   * It is what the layout gate asks, and it is asked of the element that *carries*
   * the breakpoint rather than of anything derived from it.
   */
  stripRef: (node: HTMLElement | null) => void;
  /** Put this on one bare wrapper inside the scroller, around everything it draws. */
  wrapRef: (node: HTMLElement | null) => void;
}

export function useMachineSwipe({
  tabs,
  armed,
}: {
  /** `[All, …machines]`, in draw order. */
  tabs: readonly MachineTab[];
  /** True while the row drag on this same scroller owns the touch. */
  armed: () => boolean;
}): MachineSwipe {
  const strip = useRef<HTMLElement | null>(null);
  const wrap = useRef<HTMLElement | null>(null);
  const live = useRef<{ x: number; y: number; axis: "x" | "y" | null; still: boolean; dx: number } | null>(null);
  const latest = useRef(tabs);
  latest.current = tabs;
  const busy = useRef(armed);
  busy.current = armed;

  /**
   * The settle's own timer, kept so a second flick can take it back.
   *
   * ⚠ **It was a bare `window.setTimeout` with no handle and nothing cancelling
   * it, and the cost was the common case rather than an edge.** Flicking twice in
   * quick succession is the ordinary way somebody moves two machines along, and
   * the second flick began inside the first settle's 180ms window — so the follow
   * was **interpolated** instead of pinned to the finger, and the list crawled
   * behind the thumb for the first {@link SETTLE_MS}. This file's own standing
   * rule is that the follow is written straight onto the wrapper node, once per
   * `touchmove`, precisely so that nothing sits between the finger and the
   * transform; a `transition` left on the node is exactly that something. And the
   * queued timers each wrote to whatever node `wrap.current` happened to hold by
   * the time they fired, which after a remount is a different node.
   */
  const settling = useRef<number | null>(null);

  /** Take the settle off the node: its timer, and the transition it left behind. */
  const unsettle = (node: HTMLElement): void => {
    if (settling.current !== null) window.clearTimeout(settling.current);
    settling.current = null;
    // Guarded rather than written blind: this runs once per `touchmove`, and an
    // inline-style read costs no layout while a write dirties the element's style.
    if (node.style.transition !== "") node.style.transition = "";
  };

  const slide = (by: number): void => {
    const node = wrap.current;
    if (node === null) return;
    // ⚠ **A live follow is never transitioned**, whatever a settle left on the
    // node — see {@link settling}.
    unsettle(node);
    node.style.transform = by === 0 ? "" : `translate3d(${String(by)}px, 0, 0)`;
  };

  const settle = (): void => {
    const node = wrap.current;
    if (node === null) return;
    // Nothing to slide back. A settle already in flight owns the node and its own
    // timer will clear the transition, so this may not cancel it — doing so would
    // strand the transition on the node for ever.
    if (node.style.transform === "") return;
    if (settling.current !== null) window.clearTimeout(settling.current);
    node.style.transition = `transform ${String(SETTLE_MS)}ms ease-out`;
    node.style.transform = "";
    settling.current = window.setTimeout(() => {
      settling.current = null;
      if (wrap.current !== null) wrap.current.style.transition = "";
    }, SETTLE_CLEAR_MS);
  };

  const onStart = (event: TouchEvent): void => {
    live.current = null;
    if (event.touches.length !== 1 || busy.current()) return;
    const finger = event.touches.item(0);
    if (finger === null) return;
    /*
     * ⚠ **The layout gate, and it is not a breakpoint in disguise.** `AppShell`:
     * *"CSS already knows the width, and a second source of truth for it is how a
     * resized window ends up rendering a rail that is not there."* This stores
     * nothing, subscribes to nothing and re-renders nothing — it reads, once per
     * gesture, whether the `lg:hidden` tab strip is laid out at all, which is
     * layout the browser computed from the same two class strings the breakpoint
     * has always been answered in. So it cannot disagree with CSS and cannot go
     * stale.
     *
     * It is also **exclusive in both directions**: above `lg` the phone's whole
     * mount is `display: none` and below it the desktop `<aside>` is, so exactly
     * one of the two `SessionBrowser` mounts can ever swipe and neither knows
     * which one it is.
     *
     * And it is **semantic rather than dimensional**: this gesture moves the *tab
     * strip's* selection, so it runs where the tab strip is the control on screen.
     * The width is only how that question happens to be decided.
     */
    if (strip.current === null || strip.current.offsetParent === null) return;
    // The platform's own Back owns these bands.
    if (finger.clientX < EDGE_DEAD_ZONE || window.innerWidth - finger.clientX < EDGE_DEAD_ZONE) return;
    live.current = {
      x: finger.clientX,
      y: finger.clientY,
      axis: null,
      // Read once per gesture, at use time, which is what the two existing callers
      // of this query do.
      still: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
      dx: 0,
    };
  };

  const onMove = (event: TouchEvent): void => {
    const going = live.current;
    const finger = event.touches.item(0);
    if (going === null || finger === null) return;
    // A drag that armed after this gesture began takes the touch back.
    if (busy.current()) {
      live.current = null;
      settle();
      return;
    }
    const dx = finger.clientX - going.x;
    const dy = finger.clientY - going.y;
    if (going.axis === null) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) <= SWIPE_SLOP) return;
      // Not cancelable means the engine has already committed to a pan, and
      // arguing with it is how a swipe becomes a stutter.
      going.axis = Math.abs(dx) > Math.abs(dy) * DOMINANCE && event.cancelable ? "x" : "y";
    }
    if (going.axis !== "x") return;
    if (event.cancelable) event.preventDefault();
    going.dx = dx;
    if (going.still) return;
    const at = latest.current.findIndex((tab) => tab.selected);
    const end = (dx > 0 && at <= 0) || (dx < 0 && at >= latest.current.length - 1);
    slide(end ? dx * RUBBER : Math.max(-CAP, Math.min(CAP, dx)));
  };

  const onEnd = (): void => {
    const going = live.current;
    live.current = null;
    settle();
    if (going === null || going.axis !== "x" || Math.abs(going.dx) < COMMIT) return;
    const at = latest.current.findIndex((tab) => tab.selected);
    if (at < 0) return;
    // Clamped, never wrapped: the rubber-band above is what says there is no more.
    const to = Math.min(Math.max(at + (going.dx < 0 ? 1 : -1), 0), latest.current.length - 1);
    if (to === at) return;
    const tab = latest.current[to];
    if (tab !== undefined) selectMachine(tab.id);
  };

  /*
   * ⚠ **The plumbing is `rowDrag.ts`'s {@link useTouchGesture}, and it is one copy
   * on purpose.** This block stood here as the same block in `rowDrag` and
   * `machineDrag` with `end` where those two say `stop`, each under its own copy
   * of the same two ⚠ paragraphs — one about registering in the ref callback
   * rather than an effect, one about being non-passive on the scroller. Both are
   * on that hook now, and this gesture reads nothing off the node, so it keeps no
   * handle on it either.
   */
  const scrollerRef = useTouchGesture<HTMLElement>({ start: onStart, move: onMove, stop: onEnd });

  const stripRef = useCallback((node: HTMLElement | null): void => {
    strip.current = node;
  }, []);
  const wrapRef = useCallback((node: HTMLElement | null): void => {
    // ⚠ **The node is going, and the settle's pending clear has to go with it** —
    // otherwise it fires against whatever lands in this ref next, which is the
    // half of {@link settling} a remount is responsible for.
    if (settling.current !== null) window.clearTimeout(settling.current);
    settling.current = null;
    wrap.current = node;
  }, []);

  return { scrollerRef, stripRef, wrapRef };
}
