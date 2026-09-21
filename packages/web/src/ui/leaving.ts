import { useEffect, useRef, useState, type AnimationEvent } from "react";

/**
 * A layer that is still on screen after it has been closed, so that it can leave
 * rather than vanish.
 *
 * **Opening is a CSS animation on mount and needs no state. Leaving cannot be, and
 * that asymmetry is the whole of this file** — an unmounted element does not
 * animate, so a close has to keep the element mounted with the outgoing animation
 * on it and drop it when the movement is over.
 *
 * ⚠ **Extracted from `MenuDrawer`, which is where every paragraph below was
 * measured**, when `TaskPanel` needed the same thing on a phone. It is a hook
 * rather than a component for the reason `machineDrag.ts` gives about the two
 * machine axes: the mechanism is one body and the markup is the caller's. Three
 * surfaces in this app keep a panel alive past dismissal and the third is
 * deliberately **not** a caller — `AgentConfigBar`'s picker owns its own `open` as
 * `useState` and flips it from inside the exit timer, so `shown === open`
 * throughout and its render reads `{open && !leaving && (`, which `webcheck` pins
 * as a literal. It is a different shape wearing the same word, and folding it in
 * here would mean inverting its control flow to share sixty lines.
 *
 * ## What the caller owes
 *
 * 1. `shown` goes to **both** the mount guard and `useDismissible`'s third
 *    argument — never `open`. The layer's lifetime and the element's are the same
 *    statement, and passing `open` there pops the layer at the *start* of the exit:
 *    `#root` loses `inert` and the bare-letter shortcuts come back while an opaque
 *    panel is still covering the app, so `j`/`k` walk the list behind it and Tab
 *    reaches controls nobody can see. The scrim still catches taps, so nothing
 *    pointing at the screen ever reproduces it — it is keyboard-only, which is why
 *    it survived being looked at.
 * 2. `onAnimationEnd` goes on the element the outgoing keyframe is on, and on no
 *    other. It is what actually ends the exit; {@link useLeaving}'s `backstopMs` is
 *    only what happens when it never arrives.
 * 3. The outgoing animation is a **keyframe of its own**, never the arrival's name
 *    with `reverse` composed onto it. `index.css`'s `sheet-out` docblock records
 *    what that does: an element keeps its running animation while the
 *    `animation-name` list is unchanged, so swapping direction edits an animation
 *    that finished long ago rather than starting one, and the panel disappears in a
 *    single frame with every check green.
 * 4. Every variant that can be on screen owes an outgoing animation. A breakpoint
 *    at which the element carries `animation: none` is a breakpoint at which
 *    `animationend` never fires, so the exit falls to the backstop and a *fully
 *    visible* panel sits there for its whole duration. `TaskPanel` is the case:
 *    `md:animate-none` on the docked card had to become `md:animate-rise-out`.
 */

/**
 * ⚠ **The transition is derived during render and may never move to an effect.**
 *
 * It was an effect keyed on `open`, and that shipped a visible flash: an effect
 * runs *after* the commit, so the render where `open` first turns false still saw
 * `leaving === false`, took the caller's early return and **unmounted the panel** —
 * the browser painted a frame with no panel at all. Only then did the effect set
 * the flag, remounting it to play the exit. What that looks like is the menu
 * vanishing and then calmly closing a moment later, which is exactly how it was
 * reported. Setting state during render of this same hook's component is React's
 * documented escape hatch for state derived from props: the render output is
 * discarded and re-run immediately, so nothing intermediate is ever committed and
 * there is no frame to see.
 *
 * ⚠ **`wasOpen` is what stops the exit playing on the first render.** Without it a
 * cold load starts at `open === false`, reads that as a transition *out of* open,
 * and slides a panel nobody opened off the screen. It is a ref rather than state
 * precisely because writing it must not schedule a render of its own.
 *
 * Re-opening during an exit cancels it: the open arm clears `leaving` in the same
 * render and the backstop's cleanup drops the pending unmount, so a double tap on a
 * trigger cannot strand a half-faded panel.
 *
 * @param open Whether the caller wants the layer up. Owned by the caller.
 * @param backstopMs The **longest** the panel may outlive a close — a ceiling on
 *   the wait rather than the wait itself. Each caller declares its own number
 *   beside its own class strings, and `webcheck` asserts each against the
 *   stylesheet token it is the ceiling for; a constant shared across surfaces
 *   would be one number standing for durations that are not the same.
 */
export function useLeaving(
  open: boolean,
  backstopMs: number,
): {
  /** The element's real lifetime: `open`, plus the exit. Mount guard and layer. */
  shown: boolean;
  /** Whether the outgoing class strings are the ones to draw. */
  leaving: boolean;
  onAnimationEnd: (event: AnimationEvent<HTMLElement>) => void;
} {
  const [leaving, setLeaving] = useState(false);
  const wasOpen = useRef(false);
  if (open !== wasOpen.current) {
    wasOpen.current = open;
    // Only a close begins an exit; an open cancels one that is in flight.
    setLeaving(!open);
  }
  /*
   * ⚠ **The backstop, and it may never be deleted as redundant with the event
   * below.** An `animationend` that does not arrive is not hypothetical — an
   * animation cancelled by a class change, a tab backgrounded across the exit, or
   * a browser that fires nothing for a `0.01ms` duration all end the same way, and
   * what that costs is not a stuck animation: `leaving` never clears, the element
   * never unmounts, and a layer registered on `shown` holds whatever it holds
   * **for ever** — for `MenuDrawer` that is `inert` on `#root`, an app that cannot
   * be tapped or typed at with nothing on screen to explain why. So the timer
   * stays and the event only ever makes the wait shorter.
   *
   * ⚠ **And it is a backstop rather than the clock, which is the half that was
   * wrong first.** A bare timer is a constant standing in for a duration that is
   * not constant: under `prefers-reduced-motion` `index.css` collapses every
   * animation to `0.01ms !important`, so the panel is off the screen within a
   * frame while the timer goes on holding the layer for the rest of its 260ms.
   * That is the exact mirror of the defect above with the sign flipped, and just
   * as invisible to anything pointing at the screen.
   */
  useEffect(() => {
    if (!leaving) return;
    const timer = window.setTimeout(() => setLeaving(false), backstopMs);
    return () => window.clearTimeout(timer);
  }, [leaving, backstopMs]);

  /*
   * The element's own movement ending, which is the only thing that knows how long
   * the exit actually took.
   *
   * ⚠ **`event.target !== event.currentTarget` rather than a name match on
   * `event.animationName`.** `animationend` bubbles, so a child that ever animates
   * — a row, a spinner, a pulsing meter cell, anything a later edit adds inside the
   * panel — would end its parent's life early from the inside. Comparing the two
   * targets is a fact about *this* element; matching a keyframe by name would be
   * one more copy of a string that already lives in `index.css`, in a class string
   * and in `webcheck`, and a rename would make this fall silently back to the
   * backstop with everything still green.
   *
   * The `leaving` guard is about the **arrival**: the same node plays its incoming
   * animation on open and fires `animationend` for that too, so without it every
   * open would end in a `setLeaving(false)` on an element that is not leaving. A
   * no-op today, and exactly the kind that stops being one the moment the flag
   * means anything more than it does now.
   */
  const onAnimationEnd = (event: AnimationEvent<HTMLElement>): void => {
    if (!leaving || event.target !== event.currentTarget) return;
    setLeaving(false);
  };

  return { shown: open || leaving, leaving, onAnimationEnd };
}
