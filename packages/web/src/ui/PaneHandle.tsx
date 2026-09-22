import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { PaneWidth } from "./paneWidth";

/**
 * The strip you drag to make a pane wider or narrower — **one separator, two
 * panes, and the axis is the only thing that differs.**
 *
 * ⚠ **This is `AppShell`'s `RailHandle` generalised rather than a second one**, and
 * that matters more than the line count: every paragraph below is a defect that was
 * measured on the rail, and a hand-written second copy would have inherited none of
 * them. `RailHandle` survives as a two-line wrapper in `AppShell` so that
 * `<RailHandle />`'s position after `<main>` stays a literal in that file, which is
 * a thing a driver reads and an ordering nothing else expresses.
 *
 * **A drag writes the custom property and nothing else.** No React state moves
 * while the pointer does — not width, not a transform — because the shell
 * re-renders on the four-second poll and on every streamed event, and a width owned
 * by `style={{ width }}` would be reset to where the drag *started* every time one
 * landed. `dragging` is React state, but it is set once at `pointerdown` and once
 * at `pointerup`, never in between.
 *
 * **`setPointerCapture`, not listeners on `window`.** A pointer moving faster than
 * the layout follows leaves the 8px strip on the first frame, so the element's own
 * handlers are only enough once the capture redirects every later event for that
 * `pointerId` back to it. The first draft used `window` listeners instead, which
 * covers the fast pointer and *not* the case that strands the drag: release the
 * button outside the browser window and no `pointerup` is delivered to the document
 * at all, so the strip stays armed, the next click anywhere resizes the pane, and
 * nothing looks wrong until it happens. Capture also makes teardown structural —
 * there is nothing to remove, so there is nothing to leak when this unmounts
 * mid-drag, which the background panel's separator does every time it is closed.
 *
 * ⚠ **That last clause is about the *listener*, and it is false of the custom
 * property** — read the unmount effect below before relying on it. The clause is
 * kept rather than corrected in place because the correction is the lesson, and it
 * is stated once, at the effect that acts on it; `AppShell`'s `RailHandle` sends
 * readers here for the same reason.
 *
 * `pointercancel` is a real outcome rather than defensive: on a touch laptop the
 * browser can decide mid-gesture that this was a scroll. It reverts to the
 * committed width rather than keeping wherever the finger was when the gesture was
 * taken away, because a cancelled gesture is not a smaller one.
 *
 * **Keyboard and double-click are not decoration.** A separator that only answers a
 * pointer is one nobody on a keyboard can move, and `aria-valuenow` would be
 * announcing a number with no way to change it. Double-click resets, which is also
 * the answer to "I have dragged this somewhere silly" that does not require finding
 * the default by feel.
 *
 * ⚠ **This is the one element in the client that changes the mouse, and it is a
 * named exception rather than a survivor.** Everything else lost its cursor when
 * the app-wide ban landed, this included — and it came back by the owner's call,
 * which is the right one: the ban is about a *pointer* shape claiming that
 * ordinary text is pressable, and `col-resize` is not that. It is the only cue
 * there is that an 8px strip between two panes can be dragged at all, on a control
 * whose entire appearance at rest is a transparent line. `index.css` carries the
 * ban, `web-typography.md` the rule, and `webcheck`'s allow-list names this file —
 * so a second exception is a failing check rather than a precedent.
 */
export function PaneHandle({
  pane,
  label,
  sign,
  className,
  style,
}: {
  /**
   * ⚠ **A module singleton, passed by reference.** An object literal at the call
   * site makes `pane.subscribe` a new identity on every render and
   * `useSyncExternalStore` resubscribes on each one — on a shell that re-renders
   * on every streamed token.
   */
  pane: PaneWidth;
  label: string;
  /**
   * Which way the pointer makes it wider: `1` for a pane on the left of its
   * handle, `-1` for one on the right. The rail grows rightwards and the
   * background panel grows leftwards, and this is the whole of the difference
   * between them.
   */
  sign: 1 | -1;
  className: string;
  style?: React.CSSProperties;
}): ReactNode {
  const [dragging, setDragging] = useState(false);
  /**
   * Read for `aria-valuenow` alone — the *visible* width is the custom property,
   * which a drag writes without telling React. Subscribed rather than read once
   * because a screen reader has to be told the committed number after a keyboard
   * step, and that is the one path that does re-render.
   */
  const announced = useSyncExternalStore(pane.subscribe, pane.width);
  /** The last width the pointer asked for, so `pointerup` commits what is on screen. */
  const latest = useRef(pane.clamp(Number.NaN));

  const apply = (px: number): void => {
    document.documentElement.style.setProperty(pane.prop, `${String(px)}px`);
  };
  /**
   * What a drag starts from when nobody has chosen a width yet.
   *
   * ⚠ **The DOM's own answer for the property** — never a measurement of the
   * element and never a breakpoint. The background panel has two declared widths
   * and no stored one until somebody drags, so without this the first drag at `xl`
   * would begin from 20rem and jump 96px under the pointer. `getComputedStyle` on
   * `documentElement` hands back whichever of the two media blocks won, which is
   * CSS answering rather than JavaScript deciding — the same distinction
   * `machineSwipe`'s `offsetParent` read is granted, and the reason this is not the
   * `matchMedia` those files ban.
   */
  const resolve = (): number =>
    pane.clamp(Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue(pane.prop)));
  /**
   * The same answer, held until something can have changed it.
   *
   * ⚠ **This used to be resolved inside the JSX, once per render, and the render
   * it was in is the transcript's.** `aria-valuenow` falls back to it and
   * `announced` is `null` for every reader who has never dragged — which is the
   * default state, not an edge — so while the panel was open a computed-style
   * resolution on the root element sat in the path of every arriving chunk:
   * `TaskPanel` is rendered from `EventList`'s own body with no `memo` between
   * them, and that component re-renders on every streamed token against a
   * transcript that draws all its events with no render window. A computed-style
   * read flushes whatever style invalidation is pending. The rail never reached it
   * at all, its `unset` being a number.
   *
   * So it is `??=` on a ref, and the three things that drop it are the whole of
   * what makes that safe rather than merely cheaper:
   *
   * 1. **A change to the committed width**, because `AppShell` writes that onto
   *    `documentElement` and `getComputedStyle` would then hand back the inline
   *    value rather than the stylesheet's. The case is a reset: the render in which
   *    `announced` turns `null` still sees the old inline number — as it did
   *    uncached — and the effect below is what makes the render after it read the
   *    stylesheet again instead of announcing the width that was just given up.
   * 2. **A resize**, which is the only thing that can move the breakpoint. The
   *    listener reads nothing and decides nothing; it drops an answer so that the
   *    next render asks CSS again, which is why it is not the kind of
   *    breakpoint-in-JavaScript this file is banned from by literal.
   * 3. **`pointerdown`**, so a gesture still begins from a reading taken for it.
   *    Redundant given 2 wherever a resize is delivered — and what is *not*
   *    measured here is which events a change to the browser's own font size
   *    delivers, while `@media (min-width: 80rem)` is in `rem` and therefore
   *    answers to it. One line keeps the 96px jump above impossible either way.
   */
  const cached = useRef<number | null>(null);
  const declared = (): number => (cached.current ??= resolve());
  /*
   * Reason 1 above, and it is an effect rather than a derive-during-render on
   * purpose: the render that sees `announced` change still sees the inline
   * property `AppShell` has not removed yet, so clearing the cache *there* would
   * cache the same stale number one render earlier. Cleared after the commit, the
   * next render is the first one that can read the stylesheet — which is exactly
   * where the uncached version got the right answer too.
   */
  useEffect(() => {
    cached.current = null;
  }, [announced]);
  /*
   * Reason 2. `resize` rather than a `matchMedia` listener, which this file is
   * banned from by literal and would be a second statement of a breakpoint; and
   * the handler is deliberately not a reader — it drops the held answer and the
   * next render asks CSS for a new one.
   */
  useEffect(() => {
    const forget = (): void => {
      cached.current = null;
    };
    window.addEventListener("resize", forget);
    return () => void window.removeEventListener("resize", forget);
  }, []);

  /**
   * Where this drag began, **which pointer it belongs to**, and `null` whenever one
   * is not in flight.
   *
   * ⚠ **The `id` is not bookkeeping — without it a *second* pointer ends the
   * first's drag.** The press is refused entry by the guard in `onPointerDown`, but
   * the finger is still on the strip, so its own `pointerup` arrives here and
   * committed and ended the gesture that was in flight. After that the first
   * pointer went on moving with `from.current === null`, i.e. the pane frozen under
   * a button that is still held, until it was lifted.
   */
  const from = useRef<{ id: number; x: number; width: number } | null>(null);
  /**
   * Whether an event belongs to the gesture in flight — the whole of the fix above,
   * read by the three handlers that *end* a drag. `pointerdown` has its own guard
   * (there is no gesture yet to own it) and `pointermove` narrows `from` itself.
   */
  const owns = (event: React.PointerEvent<HTMLDivElement>): boolean => from.current?.id === event.pointerId;
  /**
   * ⚠ **Whether the pointer ever moved, because a bare click must commit
   * nothing.** `pointerup` fires for a press that travelled zero pixels, and
   * committing there writes `declared()` — the stylesheet's own answer — into
   * storage as though a reader had chosen it. On the rail that is invisible, the
   * value being the one already in force. On the background panel it is
   * destructive: `unset` is `null` there, so one click turns *the stylesheet
   * decides* into a number, that number is written onto `documentElement` where it
   * beats both unlayered `:root` blocks, and the `xl` step is from then on
   * present, declared, correct and unreachable — the precise state `reset()` exists
   * to prevent, reached by touching the separator once. Measured: a click at 1400px
   * stored 416, after which a 900px window drew 416 where the stylesheet says 320.
   */
  const moved = useRef(false);

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    // Left button only. A right-click would otherwise arm a drag that no
    // `pointerup` on the same button ever disarms.
    if (event.button !== 0) return;
    // One pointer at a time. A second one landing on the strip mid-drag would
    // rebase `from` onto the committed width — the width as it was *before* the
    // drag started, since nothing commits until `pointerup` — and the pane would
    // jump by however far the first finger had already travelled. Refusing entry
    // is only half of it: the refused pointer is still on the strip and its own
    // release still arrives here, which is what `owns` is for.
    if (from.current !== null) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    // Reason 3 above: a gesture begins from a reading taken for it.
    cached.current = null;
    const start = pane.width() ?? declared();
    from.current = { id: event.pointerId, x: event.clientX, width: start };
    latest.current = start;
    moved.current = false;
    setDragging(true);
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const origin = from.current;
    // `owns` in the shape that also narrows `origin`, which is the only reason
    // this one is spelled out rather than calling it.
    if (origin === null || origin.id !== event.pointerId) return;
    moved.current = true;
    latest.current = pane.clamp(origin.width + sign * (event.clientX - origin.x));
    apply(latest.current);
  };

  const finish = (commit: boolean): void => {
    if (from.current === null) return;
    from.current = null;
    setDragging(false);
    if (commit && moved.current) pane.setWidth(latest.current);
    /*
     * Re-stated from the committed value either way: on commit `setWidth` clamps
     * and may land where the pointer did not, and on cancel the property is still
     * showing wherever the gesture was abandoned.
     *
     * ⚠ **A cancelled *first* drag is the case with no committed value to restate,
     * and it must hand the property back rather than re-reading it.** There is
     * nothing to restore to; `declared()` here would read the inline value this
     * very gesture wrote and commit the abandoned width through the back door,
     * which is precisely what `pointercancel` exists to undo. Removing it is what
     * lets the stylesheet's two answers take over again — the same thing
     * `AppShell`'s effect does for an unset pane, spelled here because that effect
     * does not re-run: no React state moved.
     */
    const settled = pane.width();
    if (settled === null) document.documentElement.style.removeProperty(pane.prop);
    else apply(settled);
  };

  /*
   * ⚠ **Unmounting mid-drag is not a `pointercancel`, and the docblock above is
   * right about the listener and was wrong about the property.** Measured on
   * Chrome 151: removing the element that holds the capture releases it implicitly
   * and delivers **no** `pointerup`, `pointercancel` or even `lostpointercapture`
   * to it — the eventual release is hit-tested onto `<html>`. So `finish` never
   * runs and whatever this gesture wrote outlives the pane.
   *
   * It is not hypothetical here: the background panel's separator unmounts on every
   * close, Escape closes the panel mid-drag, and `"menu"` does not stand down the
   * bare-letter shortcuts, so `j`/`k` does it too. And `AppShell`'s effect cannot
   * repair it — nothing was committed, so its value never changes and it never
   * re-runs, leaving the panel to reopen at the abandoned width with `reset()` an
   * early-returning no-op, `committed` already being `unset`.
   *
   * A cancel rather than a commit, which is `pointercancel`'s own rule: a gesture
   * taken away is not a smaller pane. No `setDragging(false)` and no clearing of
   * `from` — setting state during unmount warns, and the refs die with the
   * component.
   */
  useEffect(
    () => () => {
      if (from.current === null) return;
      const settled = pane.width();
      if (settled === null) document.documentElement.style.removeProperty(pane.prop);
      else document.documentElement.style.setProperty(pane.prop, `${String(settled)}px`);
    },
    [pane],
  );

  const onPointerUp = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (owns(event)) finish(true);
  };
  const onPointerCancel = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (owns(event)) finish(false);
  };
  /*
   * ⚠ **A capture can be lost without a `pointerup` or a `pointercancel`, and the
   * cost of not hearing it is the separator for the rest of the session.** Another
   * element taking the same `pointerId`, or a `releasePointerCapture` from
   * anywhere, ends the redirection with no terminal pointer event on this element:
   * `from` stays set, and `onPointerDown`'s one-pointer-at-a-time guard then
   * refuses **every** later press. The strip goes on drawing, hovering and
   * focusing, and moves nothing ever again.
   *
   * A cancel rather than a commit, which is `pointercancel`'s rule: a gesture
   * taken away is not a smaller pane. On an ordinary release it is a no-op, and
   * `from` is what makes it one rather than the ordering: Pointer Events has the
   * implicit release firing this *after* `pointerup`, by which time `finish` has
   * cleared `from` and `owns` answers false — so an engine that fired it the other
   * way round would revert the drag instead of doubling it, which is the harmless
   * direction of the two. It is emphatically **not** the mid-drag unmount, which
   * the effect above exists for: measured on Chrome 151, that delivers this event
   * no more than it delivers the other two.
   */
  const onLostPointerCapture = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (owns(event)) finish(false);
  };

  const step = (by: number): void => {
    pane.setWidth((pane.width() ?? declared()) + by);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    // Inline-start/end rather than "smaller/bigger": this app is LTR throughout —
    // `Header`'s leading control, the rail on the left — so the two coincide, and
    // spelling it this way is what a future RTL pass has to change rather than
    // discover.
    const by = event.shiftKey ? 48 : 16;
    if (event.key === "ArrowLeft") step(-by * sign);
    else if (event.key === "ArrowRight") step(by * sign);
    else if (event.key === "Home") pane.reset();
    else return;
    // Only after one of the three matched. An unconditional `preventDefault` here
    // would eat Tab off a focused separator, which is the one key that has to keep
    // working on a control whose whole purpose is to be reachable.
    event.preventDefault();
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      /*
       * ⚠ **A focusable separator owes `aria-valuenow` — WAI-ARIA 1.2 makes it
       * required, and unlike `slider` it names no repair.** This read
       * `announced ?? undefined` on the argument that an unchosen width has no
       * honest number, which left the background panel's separator tabbable with a
       * 288–512 range and no position: engines synthesise one, and the synthesised
       * value is not inside the range this element advertises.
       *
       * `declared()` is the honest number and it is already what
       * `onPointerDown` and `step()` treat as "where this pane is" when nothing is
       * stored — CSS answering with whichever media block won, not a width decided
       * here. It is held rather than resolved here: this is the render the
       * background panel makes on every streamed token, and `declared()`'s own
       * docblock carries what that cost and the three things that drop the held
       * answer.
       *
       * ⚠ **It announces the *stored* number, which is `--task-w` and not the
       * `--task-fit` the panel spends** — `index.css` and `taskWidth.ts` both say
       * so, and it is deliberate rather than overlooked: a reader's choice is what
       * a separator is a position in, and the viewport clamp beside it belongs to
       * CSS. What it costs is honest to state: where the clamp binds, this
       * announces a width wider than the pane is drawn at, and a keyboard step
       * above the clamp moves no pixel. Closing that needs the clamped value to
       * have a name JavaScript can read, which is a change to `PaneWidth` rather
       * than to this element.
       */
      aria-valuenow={announced ?? declared()}
      aria-valuemin={pane.min}
      aria-valuemax={pane.max}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onLostPointerCapture={onLostPointerCapture}
      onDoubleClick={() => pane.reset()}
      onKeyDown={onKeyDown}
      /*
       * 8px is under the 44px this app gives a *tap* target and deliberately so:
       * these separators exist only where the pointer is a mouse, and a 44px grab
       * strip would swallow clicks aimed at the first character of every row beside
       * it.
       *
       * `touch-none` because a touchscreen laptop is still a desktop width: without
       * it the browser claims the gesture as a scroll and `pointercancel` fires
       * instead of a drag.
       */
      className={`group cursor-col-resize touch-none ${className}`}
      style={style}
    >
      {/*
       * The line itself, which is the pane's border thickening under the pointer.
       * `bg-edge-strong` is the token every control in this app is identified by
       * and the only one with a ≥3:1 floor — the same reason a field's border is
       * that and never `edge`. Transparent at rest: the `border` underneath is
       * already drawing the division, and a permanently visible second line beside
       * it is two dividers where the palette argument asks for one.
       *
       * ⚠ **It is also the only affordance this control has left**, since the
       * `col-resize` shape went with every other cursor in the app. That makes
       * `group-hover` load-bearing rather than polish.
       */}
      <div
        aria-hidden="true"
        className={`absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 transition-colors ${
          dragging ? "bg-edge-strong" : "bg-transparent group-hover:bg-edge-strong/60"
        }`}
      />
    </div>
  );
}
