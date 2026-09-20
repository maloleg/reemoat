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
 * receive, and they must survive the node being replaced. `bind`'s pointer
 * handlers return unless `pointerType === "mouse"`. `rowDrag.ts` carries the
 * measurement: an engine that dispatches `touchstart` before `pointerdown` has
 * already decided what the gesture is for by the time a pointer handler runs.
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
import { MOUSE_SLOP, PRESS_MS, PRESS_SLOP, driftFor } from "./rowDrag";
import { ALL_MACHINES, type MachineTab, type MachineTabId } from "./groups";

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

  /** A client coordinate, in the scroller's own content coordinates. */
  const content = (at: number): number => {
    const box = scroller.current;
    if (box === null) return at;
    const rect = box.getBoundingClientRect();
    return axisRef.current === "y" ? at - rect.top + box.scrollTop : at - rect.left + box.scrollLeft;
  };

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
   * armed.** The base is recovered from the live rect every frame, which is
   * `rowDrag.ts`'s fix and is self-correcting against the scroller moving under an
   * auto-scroll and against a poll adding a tab — so, unlike the agent strip, this
   * needs no `startY` fixup inside the scroll loop.
   */
  const place = (at: number): void => {
    const going = live.current;
    if (going === null || !going.armed) return;
    const vertical = axisRef.current === "y";
    const rect = going.node.getBoundingClientRect();
    const base = (vertical ? rect.top : rect.left) - going.applied;
    const offset = at - going.grab - base;
    going.applied = offset;
    going.node.style.transform = vertical ? `translateY(${offset}px)` : `translateX(${offset}px)`;
    const to = dropSlot(going.middles, going.from, content(at));
    if (to === going.to) return;
    going.to = to;
    setMove({ from: going.from, to, size: going.size });
  };

  /** Scroll the list while a drag is held against one of its edges. */
  const roll = (): void => {
    rolling.current = null;
    const going = live.current;
    const box = scroller.current;
    if (going === null || !going.armed || box === null) return;
    const vertical = axisRef.current === "y";
    const rect = box.getBoundingClientRect();
    const drift = driftFor(vertical ? rect.top : rect.left, vertical ? rect.bottom : rect.right, last.current);
    if (drift !== 0) {
      if (vertical) box.scrollTop += drift;
      else box.scrollLeft += drift;
    }
    place(last.current);
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
    // it at length. Optional on the type and guarded at the call.
    if (!going.byMove) navigator.vibrate?.(12);
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
    setMachineOrder(moveRow(latest.current, going.from, going.to).map((tab) => tab.id));
  }, []);

  useEffect(() => end, [end]);

  const begin = (id: MachineTabId, node: HTMLElement, at: number, byMove: boolean, pointerId: number): void => {
    suppress.current = false;
    live.current = {
      id,
      node,
      pointerId,
      start: at,
      startOff: lastOff.current,
      grab: at - (axisRef.current === "y" ? node.getBoundingClientRect().top : node.getBoundingClientRect().left),
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

  const touchOps = useRef({
    start: (_event: TouchEvent): void => {},
    move: (_event: TouchEvent): void => {},
    stop: (): void => {},
  });
  const relay = useRef({
    start: (event: TouchEvent): void => touchOps.current.start(event),
    move: (event: TouchEvent): void => touchOps.current.move(event),
    stop: (): void => touchOps.current.stop(),
  });

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

  touchOps.current = { start: onTouchStart, move: onTouchMove, stop: () => end() };

  const scrollerRef = useCallback((node: HTMLElement | null): void => {
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
   *
   * `preventDefault` before the bounds test, or an arrow at either end of the list
   * scrolls the page instead of doing nothing.
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
