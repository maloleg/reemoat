/**
 * Press a machine folder and drag it into a different position.
 *
 * **The gesture the session rows already have, on a list that has two axes.** The
 * arithmetic is pure and lives in `machineOrder.ts`; the splice is
 * `agentStrip.ts`'s `moveRow`, generic now because this is its second subject.
 * What is here is the DOM half, which is the part no driver in this repository can
 * reach.
 *
 * ## A hook, emphatically not a component
 *
 * `MachineColumn`'s own docblock argues — and `web-shell.md` restates — that the
 * two axes are **two components**, and that a `variant` prop *"that could disagree
 * with the CSS no longer exists"*. A shared `<MachineList axis=…>` would undo
 * exactly that. A hook inverts it correctly: the **gesture** is one body and the
 * **presentation** stays two, so the column keeps its column rules and the strip
 * keeps its three cues.
 *
 * ## Arming: neither axis has a handle, and both are scrollers
 *
 * `MachineAgentsSection` can afford `touch-none` on a 44px grip inside a sheet.
 * Here, as in `rowDrag.ts`, the entry **is** the scrolling surface — the column is
 * `overflow-y-auto` and the strip is `overflow-x-auto` — so `touch-action: none`
 * on it would take scrolling away from the control it sits on. What separates the
 * two verbs instead is time:
 *
 * - **A finger arms on a 400ms hold** ({@link PRESS_MS}), abandoned the moment it
 *   travels past {@link PRESS_SLOP} in any direction. Imported from `rowDrag.ts`
 *   rather than re-typed: the swipe on the same screen decides it is horizontal at
 *   that same distance, and the two numbers drifting apart is a hold and a swipe
 *   both arming on one finger.
 * - **A mouse arms on {@link MOUSE_SLOP} of travel.** A pointer has a button, so
 *   the press already says which entry and there is nothing to wait for.
 *
 * ⚠ **A finger never touches the pointer stream.** `touchstart`/`touchmove` are
 * `addEventListener`ed non-passive on the scroller, in the **ref callback** rather
 * than an effect — they must exist before the first `touchstart` the node can
 * receive, and they must survive the node being replaced. That plumbing is
 * `rowDrag.ts`'s `useTouchGesture` and is one copy for the three gestures that
 * need it; both ⚠ paragraphs about it live there. `bind`'s pointer handlers return
 * unless `pointerType === "mouse"`. `rowDrag.ts` also carries the measurement: an
 * engine that dispatches `touchstart` before `pointerdown` has already decided
 * what the gesture is for by the time a pointer handler runs.
 *
 * ⚠ **The pointer is captured at `arm`, never at the press.** The entry is a
 * `<button>` whose `onClick` selects the machine, and capture retargets the
 * synthesised `click` to the capturing element — so capturing at `pointerdown`
 * would stop a machine being selected by clicking it. Q3.576, one control over.
 *
 * ⚠ **`touch-none` is never used as a class here**, and `webcheck` pins that
 * string absent from `SessionBrowser.tsx` — the rail is a scroller before it is a
 * drag surface. `touchAction` is set imperatively at `arm` and cleared at the
 * drop, so it lasts one gesture rather than the life of the list. That also puts
 * it out of reach of the cascade fault `agent-strip.md` records, where an
 * unlayered `button { touch-action: manipulation }` beat the utility class
 * outright.
 *
 * ## What a reorder must not do
 *
 * 1. **Change the selected tab.** `onClickCapture` eats the `click` a drag leaves
 *    behind. Without it every drop also selects, which is the likeliest defect in
 *    this whole file.
 * 2. **Scroll the list.** The entry keeps its own `touch-action` until `arm`, and
 *    `preventDefault` fires only while armed.
 * 3. **Move `All`.** It is the column scroller's first child and carries a
 *    `data-machine` of its own, so the listeners see it. Every index here is taken
 *    over `tabs` — which holds machines only — rather than over the scroller's
 *    children, and a node whose id is not in that list refuses to arm.
 *
 * ## And one thing it does not have to do
 *
 * **There is no write to fail.** `setMachineOrder` is `localStorage` and a version
 * bump, so this file has no `UNREACHABLE` sentence, no sequence guard and no
 * restore-what-the-daemon-confirmed — which is a real difference from both lists
 * it is modelled on, and worth saying out loud so nobody goes looking for the
 * missing half.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { isTypingInto } from "../keys";
import { moveRow } from "../agentStrip";
import { setMachineOrder, dropSlot } from "../machineOrder";
import { HAPTIC_MS, MOUSE_SLOP, PRESS_MS, PRESS_SLOP, driftFor, useTouchGesture } from "./rowDrag";
import { ALL_MACHINES, type MachineTab, type MachineTabId } from "./groups";

/**
 * Which keys move an entry, said out loud rather than only handled.
 *
 * ⚠ **The reorder was keyboard-reachable and neither discoverable nor named.**
 * The entry is a `<button>` whose accessible name is the machine's name and whose
 * state is `aria-pressed`; the reorder hid behind `event.altKey` with nothing
 * anywhere — visible, `sr-only` or in an attribute — saying the entry could be
 * moved at all. `machine-gestures.md`'s *"keyboard parity is owed, not offered"*
 * was satisfied mechanically and not in practice: a keyboard or screen-reader
 * reader had no way to learn the gesture exists. The sibling list one screen over
 * gets it right by hanging the gesture on a handle whose accessible name is
 * `Move <name>`, and this surface deliberately has no handle to name — which is
 * why the naming has to happen on the entry itself.
 *
 * `bind` draws both halves on both axes, from here, so the sentence and the keys
 * cannot disagree with the branch in `onKey` that implements them:
 *
 * - **`aria-keyshortcuts`** is the one attribute that answers *what keys does this
 *   control take*, and it is axis-appropriate because the handler is.
 * - **`aria-roledescription`** is what makes it discoverable rather than merely
 *   discoverable-on-request: nothing announces `aria-keyshortcuts` unprompted. ⚠
 *   It is spent knowingly — it *replaces* how the role is announced, so an entry
 *   reads as "<name>, movable machine, pressed" rather than "<name>, button,
 *   pressed" — and it is the only way to say *movable* without composing an
 *   `aria-label` over the name and the blocked count, which is the one thing this
 *   column's own docblock says the label is for.
 */
const SHORTCUTS = {
  y: "Alt+ArrowUp Alt+ArrowDown Alt+Home Alt+End",
  x: "Alt+ArrowLeft Alt+ArrowRight Alt+Home Alt+End",
} as const;

/** What an entry is, once it can be carried. Read in place of "button". */
const MOVABLE = "movable machine";

/** What the drag as every *other* entry sees it. */
interface Move {
  from: number;
  to: number;
  /** One entry's extent along the axis. Uniform on both, unlike the session rail. */
  size: number;
}

export interface MachineDrag {
  /** Put this on the one scroller the entries live in. */
  scrollerRef: (node: HTMLElement | null) => void;
  /** The machine under the pointer, or `null`. */
  dragging: MachineTabId | null;
  /** True while any drag is live, which is when a shift is worth animating. */
  sliding: boolean;
  /** How far the entry at this index stands aside, in pixels along the axis. */
  shiftFor: (index: number) => number;
  /** Whether a drag has armed and owns the touch. Synchronous, for the swipe. */
  armed: () => boolean;
  /**
   * What a keyboard move has just done, for an `sr-only` live region.
   *
   * `""` until something has happened. The hook owns the sentence because both
   * axes owe the same one, and it is the only markup this hook obliges a caller
   * to draw.
   */
  announcement: string;
  bind: (id: MachineTabId, index: number) => {
    "data-machine": MachineTabId;
    /** {@link SHORTCUTS} for this axis, so the keys are named where they are taken. */
    "aria-keyshortcuts": string;
    /** {@link MOVABLE}, which is how the entry says it can be carried at all. */
    "aria-roledescription": string;
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

export function useMachineDrag({ axis, tabs }: { axis: "x" | "y"; tabs: readonly MachineTab[] }): MachineDrag {
  const [move, setMove] = useState<Move | null>(null);
  const [announcement, setAnnouncement] = useState("");

  const scroller = useRef<HTMLElement | null>(null);
  const live = useRef<{
    id: MachineTabId;
    node: HTMLElement;
    pointerId: number;
    start: number;
    startOff: number;
    /** Where in the entry the pointer landed, so it stays under the same pixel. */
    grab: number;
    /** The translate currently written on the node, so its base can be recovered. */
    applied: number;
    byMove: boolean;
    armed: boolean;
    middles: number[];
    size: number;
    from: number;
    to: number;
  } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rolling = useRef<number | null>(null);
  const last = useRef(0);
  const lastOff = useRef(0);
  /** Set when a drag armed, so the `click` the pointer leaves behind is eaten. */
  const suppress = useRef(false);
  /**
   * Whether the follow needs re-writing on a frame where the pointer has not moved.
   *
   * ⚠ **The only thing that can set it is a change this gesture did not cause**,
   * which in practice is the four-second poll replacing `tabs` underneath a held
   * drag: the entry may have been re-laid-out, and `place`'s whole
   * self-correcting-base argument is about answering exactly that. A pointer event
   * needs no flag — it calls `place` itself, which clears this.
   */
  const dirty = useRef(false);
  /**
   * The current render's tabs, for the touch listeners.
   *
   * They are registered once for the component's life, so they cannot close over
   * a list that stays right — this rail re-renders on the four-second poll.
   */
  const latest = useRef(tabs);
  latest.current = tabs;
  const axisRef = useRef(axis);
  axisRef.current = axis;

  const along = (event: { clientX: number; clientY: number }): number =>
    axisRef.current === "y" ? event.clientY : event.clientX;
  const across = (event: { clientX: number; clientY: number }): number =>
    axisRef.current === "y" ? event.clientX : event.clientY;

  /**
   * The scroller, read once per frame: its box and its scroll offset together.
   *
   * ⚠ **A frame must be read-read-write, and it was read-write-read.** `place`
   * wrote the dragged node's `transform` and *then* asked
   * `scroller.getBoundingClientRect()` for the content coordinate — a style write
   * followed by a layout read, which is a forced synchronous reflow of the whole
   * document, on every `touchmove` and on every rAF tick of `roll`. With the whole
   * session rail and, at `lg`, the whole transcript in that document, that was
   * three rects and two writes per frame at ~120 forced layouts a second of held
   * drag. Both reads happen here, before the one write, and `roll` hands down the
   * rect it has already taken rather than causing a second.
   */
  const frameOf = (): { rect: DOMRect; scroll: number } | null => {
    const box = scroller.current;
    if (box === null) return null;
    return { rect: box.getBoundingClientRect(), scroll: axisRef.current === "y" ? box.scrollTop : box.scrollLeft };
  };

  /** A client coordinate, in the scroller's own content coordinates. */
  const content = (frame: { rect: DOMRect; scroll: number } | null, at: number): number =>
    frame === null ? at : at - (axisRef.current === "y" ? frame.rect.top : frame.rect.left) + frame.scroll;

  const clearTimer = (): void => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  };

  /**
   * Every entry's midpoint along the axis, measured once when the drag arms.
   *
   * Over `tabs` rather than over the scroller's children, which is what keeps
   * `All` out of it — it carries a `data-machine` too, and an index taken over the
   * DOM would be one off for every machine behind it. A tab whose node is not
   * there yet refuses the whole gesture rather than contributing a hole.
   */
  const measure = (): { middles: number[]; size: number } | null => {
    const box = scroller.current;
    if (box === null) return null;
    const rect = box.getBoundingClientRect();
    const vertical = axisRef.current === "y";
    const offset = vertical ? rect.top - box.scrollTop : rect.left - box.scrollLeft;
    const middles: number[] = [];
    let size = 0;
    for (const tab of latest.current) {
      const node = box.querySelector<HTMLElement>(`[data-machine="${CSS.escape(tab.id)}"]`);
      if (node === null) return null;
      const at = node.getBoundingClientRect();
      const near = (vertical ? at.top : at.left) - offset;
      const far = (vertical ? at.bottom : at.right) - offset;
      middles.push((near + far) / 2);
      size = Math.max(size, vertical ? at.height : at.width);
    }
    return { middles, size };
  };

  /**
   * Follow the pointer, and answer where the entry would land.
   *
   * ⚠ **Anchored to where the entry actually is, not to where it was when the drag
   * armed.** The base is recovered from the live rect on every call, which is
   * `rowDrag.ts`'s fix and is self-correcting against the scroller moving under an
   * auto-scroll and against a poll adding a tab — so, unlike the agent strip, this
   * needs no `startY` fixup inside the scroll loop.
   *
   * `frame` is the scroller as {@link frameOf} read it. `roll` passes the one it
   * already holds; an event handler passes nothing and this takes its own.
   */
  const place = (at: number, frame?: { rect: DOMRect; scroll: number } | null): void => {
    const going = live.current;
    if (going === null || !going.armed) return;
    dirty.current = false;
    const vertical = axisRef.current === "y";
    /* Both reads, then the write. See {@link frameOf}. */
    const where = frame === undefined ? frameOf() : frame;
    const rect = going.node.getBoundingClientRect();
    const base = (vertical ? rect.top : rect.left) - going.applied;
    const offset = at - going.grab - base;
    const to = dropSlot(going.middles, going.from, content(where, at));
    going.applied = offset;
    going.node.style.transform = vertical ? `translateY(${offset}px)` : `translateX(${offset}px)`;
    if (to === going.to) return;
    going.to = to;
    setMove({ from: going.from, to, size: going.size });
  };

  /**
   * Scroll the list while a drag is held against one of its edges.
   *
   * ⚠ **The rAF loop re-arms for the whole life of the drag, and that is the point
   * rather than an oversight**: `place` recovers the entry's base from its live
   * rect, so a frame that runs while nothing has happened is what makes the follow
   * self-correcting against the scroller moving underneath it. What it may not do
   * is *work* on such a frame — every `place` is a layout read and a style write,
   * and re-placing a stationary entry against an unchanged list was ~120 forced
   * layouts a second for no movement at all. So a frame does something only when
   * the drift is non-zero or something marked the follow stale, and the list
   * changing under the gesture is exactly what marks it (the effect keyed on
   * `tabs`, below).
   */
  const roll = (): void => {
    rolling.current = null;
    const going = live.current;
    const box = scroller.current;
    if (going === null || !going.armed || box === null) return;
    const vertical = axisRef.current === "y";
    const rect = box.getBoundingClientRect();
    const scroll = vertical ? box.scrollTop : box.scrollLeft;
    const drift = driftFor(vertical ? rect.top : rect.left, vertical ? rect.bottom : rect.right, last.current);
    if (drift !== 0) {
      // Written from the offset read above rather than with `+=`, so the frame's
      // two reads stay together at the top of it.
      if (vertical) box.scrollTop = scroll + drift;
      else box.scrollLeft = scroll + drift;
      // Read back rather than assumed: the engine clamps at either end, and an
      // over-run offset would put the pointer's content coordinate past the list.
      place(last.current, { rect, scroll: vertical ? box.scrollTop : box.scrollLeft });
    } else if (dirty.current) {
      place(last.current, { rect, scroll });
    }
    rolling.current = requestAnimationFrame(roll);
  };

  /** The press has become a drag: measure, take the pointer, lift the entry. */
  const arm = (): void => {
    const going = live.current;
    if (going === null || going.armed) return;
    clearTimer();
    const measured = measure();
    const from = latest.current.findIndex((tab) => tab.id === going.id);
    if (measured === null || from < 0) {
      live.current = null;
      return;
    }
    going.armed = true;
    going.middles = measured.middles;
    going.size = measured.size;
    going.from = from;
    going.to = from;
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
    setMove({ from, to: from, size: measured.size });
    place(last.current);
    if (rolling.current === null) rolling.current = requestAnimationFrame(roll);
    // The one channel a thumb covering the screen leaves open; `rowDrag.ts` argues
    // it at length, and {@link HAPTIC_MS} is its duration rather than a second copy
    // of the number. Optional on the type and guarded at the call.
    if (!going.byMove) navigator.vibrate?.(HAPTIC_MS);
  };

  /** Put the entry down, and write the order if it moved. */
  const end = useCallback((): void => {
    clearTimer();
    if (rolling.current !== null) cancelAnimationFrame(rolling.current);
    rolling.current = null;
    const going = live.current;
    live.current = null;
    setMove(null);
    if (going === null) return;
    going.node.style.transform = "";
    going.node.style.touchAction = "";
    going.node.style.willChange = "";
    going.node.style.webkitUserSelect = "";
    going.node.style.userSelect = "";
    going.node.style.removeProperty("-webkit-touch-callout");
    if (going.byMove) {
      try {
        going.node.releasePointerCapture(going.pointerId);
      } catch {
        // Already released, or a pointer that has gone.
      }
    }
    if (!going.armed || going.to === going.from) return;
    /*
     * ⚠ **The list is checked against the drag before the write, because
     * `going.from` was measured when the drag armed and this rail re-renders on
     * the four-second poll.** `latest.current` is reassigned every render, so a
     * machine arriving or leaving between the press and the drop made
     * `going.from` name a *different* row — and the drop then moved that row
     * instead, persisting the wrong order to storage with nothing said. `arm`
     * already derives the index by id one function up; this is the same
     * derivation at the other end of the gesture.
     *
     * A list that moved abandons the write rather than guessing. `going.to` is a
     * slot measured over the arm-time list, so once that list has changed there
     * is no honest reading of it left — and a reorder is a preference somebody
     * can simply repeat, which makes dropping it strictly better than writing an
     * order they did not ask for.
     */
    const settled = latest.current;
    if (settled.length !== going.middles.length || settled[going.from]?.id !== going.id) return;
    setMachineOrder(moveRow(settled, going.from, going.to).map((tab) => tab.id));
  }, []);

  useEffect(() => end, [end]);

  /*
   * ⚠ **A drag whose row left the list is ended here, because no event will do
   * it.** `SessionBrowser` and `MachineColumn` both key each entry on `tab.id`, so
   * a machine leaving `tabs` on the poll unmounts the node the gesture owns.
   * Nothing arrives after that: touch events dispatch to a detached element and
   * never reach the scroller's `touchend`, and for a mouse `PaneHandle.tsx`
   * measured the rest on Chrome 151 — removing the element that holds the capture
   * releases it implicitly and delivers **no** `pointerup`, `pointercancel` or
   * even `lostpointercapture`.
   *
   * So `end` never ran: `roll` kept scrolling the list to its edge and writing an
   * ever-growing transform onto a node no longer in the document (its
   * `getBoundingClientRect()` is all zeros, so the offset grows without bound),
   * `armed()` stayed true so the swipe stayed dead, and `suppress.current` stayed
   * true so the next click on any machine was eaten — with no recovery on the
   * desktop path short of a reload.
   */
  useEffect(() => {
    const going = live.current;
    if (going === null) return;
    if (!tabs.some((tab) => tab.id === going.id)) end();
    // It is still there, but the list around it moved — which is the one thing
    // `roll` cannot see for itself and the only reason it re-places a stationary
    // entry at all. `place`'s ⚠ is the argument.
    else dirty.current = true;
  }, [tabs, end]);

  const begin = (id: MachineTabId, node: HTMLElement, at: number, byMove: boolean, pointerId: number): void => {
    suppress.current = false;
    // One rect for both axes: it was `getBoundingClientRect()` twice in one
    // expression, which is two layouts for one measurement.
    const box = node.getBoundingClientRect();
    live.current = {
      id,
      node,
      pointerId,
      start: at,
      startOff: lastOff.current,
      grab: at - (axisRef.current === "y" ? box.top : box.left),
      applied: 0,
      byMove,
      armed: false,
      middles: [],
      size: 0,
      from: -1,
      to: -1,
    };
    last.current = at;
  };

  /* ---- the finger's whole gesture, on the touch stream and nowhere else ---- */

  const onTouchStart = (event: TouchEvent): void => {
    if (event.touches.length !== 1) {
      if (live.current !== null) end();
      return;
    }
    const finger = event.touches.item(0);
    const from = event.target instanceof Element ? event.target : null;
    if (finger === null || from === null) return;
    const node = from.closest<HTMLElement>("[data-machine]");
    if (node === null) return;
    const id = (node.dataset["machine"] ?? "") as MachineTabId;
    // ⚠ **`All` carries a `data-machine` of its own and is not a machine**, and
    // `MachineTabId` cannot express "not that one" — so this membership test is the
    // mechanism rather than the type, and it is the same test that refuses a tab
    // for a machine which left the list between a render and a touch.
    if (id === ALL_MACHINES || !latest.current.some((tab) => tab.id === id)) return;
    /*
     * ⚠ **Set here, which is the whole reason this handler exists.** iOS decides
     * at `touchstart` whether a long press raises its own callout, and cancels the
     * touch when it does. Set from `pointerdown` on an engine that dispatches
     * `touchstart` first, this arrives after the decision it exists to change.
     */
    node.style.webkitUserSelect = "none";
    node.style.userSelect = "none";
    node.style.setProperty("-webkit-touch-callout", "none");
    lastOff.current = across(finger);
    begin(id, node, along(finger), false, -1);
    clearTimer();
    timer.current = setTimeout(arm, PRESS_MS);
  };

  const onTouchMove = (event: TouchEvent): void => {
    const going = live.current;
    const finger = event.touches.item(0);
    if (going === null || finger === null || going.byMove) return;
    const at = along(finger);
    const off = across(finger);
    last.current = at;
    lastOff.current = off;
    if (going.armed) {
      // Ours now, and refusing the default is what keeps the scroller from taking
      // it back. Only ever while a drag is live.
      if (event.cancelable) event.preventDefault();
      place(at);
      return;
    }
    // Handed back: this was a scroll, or the swipe on the same screen. Through
    // `end` rather than by hand, so the styles the press put on come off either way.
    if (Math.hypot(at - going.start, off - going.startOff) > PRESS_SLOP) end();
  };

  /*
   * ⚠ **The plumbing is `rowDrag.ts`'s {@link useTouchGesture}, and it is one copy
   * on purpose.** This block stood here byte-for-byte as it stands in `rowDrag`
   * and in `machineSwipe`, each preceded by the same two ⚠ paragraphs about
   * registering in the ref callback and about being non-passive on the scroller —
   * a measurement in three places to keep in step. Those paragraphs are on that
   * hook now; this is only the composition, because the drag also measures against
   * the node and so keeps its own handle on it.
   */
  const scrollerRef = useTouchGesture<HTMLElement>(
    { start: onTouchStart, move: onTouchMove, stop: () => end() },
    scroller,
  );

  /* ---- the shift every other entry takes ---- */

  const shiftFor = (index: number): number => {
    if (move === null || index === move.from) return 0;
    if (move.to > move.from && index > move.from && index <= move.to) return -move.size;
    if (move.to < move.from && index >= move.to && index < move.from) return move.size;
    return 0;
  };

  /**
   * Move an entry with the keyboard, and say so.
   *
   * ⭐ `agent-strip.md`: *"a pointer gesture that is the only way to reorder is a
   * control a keyboard cannot reach at all."* There is no handle here to hang
   * arrows on, so the entry takes them held with `Alt` — the bare ones belong to
   * the list, and `keyboard.ts`'s bare-key rules therefore need no edit.
   * {@link SHORTCUTS} is the same list as an attribute, which is how anybody
   * learns it is here.
   *
   * ⚠ **On the horizontal axis this takes the platform's own Back and Forward,
   * and the exception is stated here rather than left to be found.**
   * `Alt+ArrowLeft`/`Alt+ArrowRight` are Back and Forward on Windows and Linux,
   * and the horizontal mount is the `lg:hidden` strip — so on a narrow window on
   * those platforms, holding `Alt` and pressing Left while a machine tab has focus
   * moves the tab instead of going back. That is the *opposite* of the call the
   * touch half of this same gesture makes twenty lines into `machineSwipe`, where
   * the platform's edge swipe keeps a 24px band at each viewport edge because *"it
   * is the browser's and must stay the browser's"*.
   *
   * It is kept, and the two are not in conflict, because the two gestures are not
   * comparable at the moment they are claimed. An edge swipe is indistinguishable
   * from the platform's own at its first pixel and there is nothing focused to
   * disambiguate it with; a key press arrives on an element somebody deliberately
   * focused, which is a member of a list this control reorders, and a focused
   * widget preempting a browser accelerator is ordinary practice. What is paid for
   * it is real and worth writing down: a reader who tabs to a machine tab and then
   * wants to go back has no `Alt+Left` until they focus something else. `Alt+Home`
   * and `Alt+End` are free on both axes and cost nothing.
   *
   * `preventDefault` before the bounds test, so a key this control claims does
   * **nothing** at either end of the list rather than being handed back to the
   * platform half the time — an entry at index 0 taking `Alt+Left` would otherwise
   * navigate, which is the same bite applied unpredictably.
   */
  const onKey = (index: number, event: React.KeyboardEvent<HTMLElement>): void => {
    if (!event.altKey || isTypingInto(event.target)) return;
    const vertical = axisRef.current === "y";
    const back = vertical ? "ArrowUp" : "ArrowLeft";
    const on = vertical ? "ArrowDown" : "ArrowRight";
    const count = latest.current.length;
    let to = index;
    if (event.key === back) to = index - 1;
    else if (event.key === on) to = index + 1;
    else if (event.key === "Home") to = 0;
    else if (event.key === "End") to = count - 1;
    else return;
    event.preventDefault();
    to = Math.min(Math.max(to, 0), count - 1);
    if (to === index) return;
    const rows = moveRow(latest.current, index, to);
    setMachineOrder(rows.map((tab) => tab.id));
    const name = latest.current[index]?.name ?? "";
    setAnnouncement(`${name} moved to position ${String(to + 1)} of ${String(count)}.`);
  };

  const bind = (id: MachineTabId, index: number): ReturnType<MachineDrag["bind"]> => ({
    "data-machine": id,
    "aria-keyshortcuts": SHORTCUTS[axis],
    "aria-roledescription": MOVABLE,
    onPointerDown: (event) => {
      if (event.pointerType !== "mouse" || event.button !== 0) return;
      lastOff.current = across(event);
      begin(id, event.currentTarget, along(event), true, event.pointerId);
    },
    onPointerMove: (event) => {
      const going = live.current;
      if (event.pointerType !== "mouse" || going === null || !going.byMove) return;
      last.current = along(event);
      lastOff.current = across(event);
      if (going.armed) {
        place(along(event));
        return;
      }
      if (Math.hypot(along(event) - going.start, across(event) - going.startOff) > MOUSE_SLOP) arm();
    },
    onPointerUp: (event) => {
      if (event.pointerType === "mouse") end();
    },
    onPointerCancel: (event) => {
      if (event.pointerType === "mouse") end();
    },
    onLostPointerCapture: (event) => {
      if (event.pointerType === "mouse") end();
    },
    // Android's long press is ~500ms against this hold's 400, so the two race.
    onContextMenu: (event) => {
      if (live.current !== null) event.preventDefault();
    },
    // ⚠ **The drop may not also select the machine it dropped.** Without this every
    // reorder ends on the tab you just moved, which is the likeliest defect here.
    onClickCapture: (event) => {
      if (!suppress.current) return;
      suppress.current = false;
      event.preventDefault();
      event.stopPropagation();
    },
    // The label is text and the browser will happily drag it instead.
    onDragStart: (event) => event.preventDefault(),
    onKeyDown: (event) => onKey(index, event),
  });

  return {
    scrollerRef,
    dragging: move === null ? null : (latest.current[move.from]?.id ?? null),
    sliding: move !== null,
    shiftFor,
    armed: () => live.current?.armed === true,
    announcement,
    bind,
  };
}
