import { LogOut, Puzzle, Settings as SettingsIcon, X } from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type AnimationEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { marketPath } from "../market";
import { pluginPath, screenPlugins } from "../plugins";
import { navigate } from "../router";
import { settingsPath } from "../settings";
import { sessionGroups, store, type AppState } from "../store";
import { APP_VERSION } from "../version";
import { Icon, IconButton, Monogram, personEmoji } from "./bits";
import { currentView, groupsVersion, subscribeGroups } from "./groups";
import { LAYER, useDismissible } from "./overlay";

/**
 * The **longest** the panel may outlive a close, and it is one number in two files.
 *
 * `--animate-drawer-out` in `index.css` is the movement; this is the ceiling on
 * the wait before the element stops existing. They have to agree or the panel
 * either vanishes mid-slide or leaves a dead layer on screen, and neither is
 * visible from the other file — so `webcheck` reads the duration out of the
 * stylesheet and asserts it against this constant.
 *
 * ⚠ **It is a backstop rather than the clock, and that is a correction to what
 * this said.** It *was* the clock: a bare `setTimeout(DRAWER_EXIT_MS)` decided
 * when the panel stopped existing, and because the `"sheet"` layer is registered
 * for exactly the panel's lifetime — see the `useDismissible` call below — it also
 * decided how long `#root` stays `inert`. Under `prefers-reduced-motion` that is
 * the wrong number by four orders of magnitude: the block at the foot of
 * `index.css` forces `animation-duration: 0.01ms !important` on everything, so the
 * panel is off the screen within a frame while this timer holds the app inert,
 * untappable and deaf to `j`/`k` for the remaining 260ms. That is the exact mirror
 * of the defect registering the layer on `open` produced, with the sign flipped,
 * and just as invisible to anything pointing at the screen. `animationend` on the
 * panel is the clock now; this number only decides anything when that event never
 * arrives, because an `inert` `#root` that is never handed back is worse than
 * either window.
 */
const DRAWER_EXIT_MS = 260;

/**
 * A row in this panel, and the reason it is not `menuRow`.
 *
 * `menuRow` is the *popover* row — `text-xs` in a floating panel a third of this
 * width, and it has six other callers. This is a drawer: it is the width of a
 * phone, it holds three things, and at `text-xs` with `text-muted` glyphs it read
 * as a list of footnotes rather than as the way out of this screen. Every chat
 * client draws this row at something near body size with the glyph in the same ink
 * as the words, and that is what this is.
 *
 * ⚠ **A separate constant rather than a prop on `menuRow`.** Adding a size there
 * changes six surfaces to fix one, and the two are not the same object that
 * happens to be drawn twice — one floats over content and the other is a
 * destination list. The cost is one more shared string in this file, which is the
 * cheaper of the two.
 *
 * `min-h-12` rather than `min-h-11`: the 44px floor is a *minimum*, and a row this
 * wide with a 18px glyph reads as cramped at exactly the floor.
 */
const DRAWER_ROW = "tap flex min-h-12 w-full items-center gap-3 rounded-md px-3 text-left text-sm font-medium";

/**
 * A band naming what the rows under it are, at **this panel's** inset.
 *
 * ⚠ **Written out rather than composed from `MENU_HEADING`, and the reason is the
 * left edge.** `bits.tsx` gives that constant its own `px-2.5` on purpose — its
 * docblock says every *popover* heading wants the same 2.5 as the rows beneath it
 * and that "a heading that did not share that left edge is the one arrangement
 * worth preventing". This is not a popover: {@link DRAWER_ROW} is `px-3`, both sit
 * inside the same `px-1.5` scroller, and `MENU_HEADING` here put the word `screens`
 * 2px inboard of the rows it heads — the precise arrangement that constant exists
 * to stop, reached by importing it.
 *
 * ⚠ **And not `` `${MENU_HEADING} px-3` `` either.** Two padding utilities of one
 * family on one element are resolved by Tailwind's emission order rather than by
 * the order in the string, which `bits.tsx` records as a silent no-op and
 * `webcheck.typography.ts` sweeps for on the colour axis. `MachineSection`'s
 * `RETIRE_HEADING` and `AgentBuilder`'s `HIDDEN_PROVIDER_HEADING` are spelled out
 * for the same mechanical reason; `.claude/rules/web-typography.md` is the rule,
 * and the type below is byte-for-byte that file's one caps idiom — only the
 * padding is this panel's.
 *
 * `text-faint` is `MENU_HEADING`'s tone and is kept: the choice between the three
 * constants is a colour decision, and a heading sitting over rows that are
 * themselves the content is quieter than the rows. Nothing about the *type*
 * changes, which is what keeps this a fifth documented spelling of the idiom
 * rather than a fourth constant.
 */
const DRAWER_HEADING = "px-3 py-1.5 text-2xs font-semibold tracking-wider text-faint uppercase";

/**
 * Who you are, where you can go, and what build this is.
 *
 * **This replaced `ProfileMenu`, and the rule that file carried is the one thing
 * worth moving intact.** That was a row at the foot of the rail which opened a
 * popover, and its docblock set the test for what could be in it: *a row must be a
 * destination, it must be reached from nowhere else, and it must be about **you**
 * rather than about what is on screen.* All three still hold, and the second one is
 * why there is no `Account` row: Account is `DEFAULT_SECTION`, so Settings already
 * opens on it, and a row here would be the same door drawn twice. The head of this
 * panel is who you are; Settings is where you change it.
 *
 * **What has not changed.** There is no Language row and no ellipsis of extras —
 * this app has no i18n and `index.css` explicitly refuses a theme switcher. `Sign
 * out` is last and separated, above the version, and drawn even when `me === null`:
 * `bootstrap`'s catch keeps `phase: "ready"` with no `me` when the control plane is
 * unreachable, and an outage is the worst moment for the way out to disappear. One
 * tap, no two-step confirm — the confirming pattern is a *row* pattern, question
 * and answer and undo laid out left to right, and it does not fit a panel this
 * narrow.
 *
 * ⚠ **`useDismissible("sheet")`, and `TaskPanel` is the wrong precedent to copy.**
 * That panel registers `"menu"` on purpose, because at `xl` it docks *beside* the
 * conversation with no scrim and `inert` on `#root` would kill the transcript it
 * was opened to read alongside. This one is scrim-backed at every width and never
 * docks. `"menu"` here would leave `shortcutsEnabled` true, and `keyboard.ts`
 * records exactly what that costs: `inert` stops taps and focus but **not** a
 * `window` keydown, so `j` and `k` would walk the session list behind an opaque
 * panel, navigating to sessions nobody can see.
 *
 * ⚠ **The kind is half of it; the *lifetime* is the other half, and it was wrong.**
 * The layer is registered on `shown` rather than on `open`, because the panel
 * outlives `open` by `DRAWER_EXIT_MS` and a layer registered on `open` pops at the
 * start of that window instead of the end — handing the app back its shortcuts and
 * its focus underneath a drawer that is still covering it. The argument above is
 * about which `LayerKind`; this is about when it is on the stack, and the wrong
 * answer to either produces the same `j`/`k` failure.
 *
 * ⚠ **There is a ✕ in the head, and it is not redundant with the scrim.** `inert`
 * makes "the rows behind it" — `Sheet`'s stated accessible way out, quoted at the
 * scrim below — the one thing that cannot be reached, and the scrim is a
 * `aria-hidden` `<div>` by the same argument that keeps it from being a phantom tab
 * stop. Escape works through `useDismissible`, so the gap was exactly one
 * population: a screen-reader user on a touch device, who had no dismiss control at
 * all. `aria-modal="true"` sits beside `role="dialog"` for the matching reason —
 * the rest of the document really is out of play, so saying so is a description
 * rather than a claim.
 *
 * ⚠ **Portaled to `document.body`, and that is not tidiness either.** `inert` lands
 * on `#root`; a drawer rendered inside it inerts *itself* — visible, scrimmed and
 * completely untouchable, with nothing in the console. `Sheet` is portaled for this
 * reason and for a second one it states: `position: fixed` resolves against the
 * nearest `backdrop-filter` ancestor, and this app's header, composer and rail
 * footer are each one hop from one.
 *
 * **No focus trap and no `tabIndex` on the panel.** `overlay.ts` says outright that
 * `inert` is the mechanism and a hand-rolled trap must not be added. Every
 * interactive thing in here is a `<button>`, which is in `index.css`'s one
 * `:focus-visible` selector list — so nothing here is a focusable element type the
 * ring does not reach, which is the trap a `[role="dialog"][tabindex]` would fall
 * into.
 */
export function MenuDrawer({
  state,
  open,
  onClose,
}: {
  state: AppState;
  open: boolean;
  onClose: () => void;
}): ReactNode {
  /*
   * The selected machine, read from the same module state the rail reads.
   *
   * `ProfileMenu` took this as a prop because it was mounted inside
   * `SessionBrowser`, which already had a `view`. This is mounted in `App`, which
   * has none — and the fix is not to thread one down, because `groups.ts` is
   * where "which machine am I looking at" lives and a prop would be a second
   * copy of it that can lag a tab change by a render. Subscribing is what makes
   * switching machines with the drawer open change which screens it offers.
   */
  useSyncExternalStore(subscribeGroups, groupsVersion);

  /*
   * **The panel outlives `open` by its own exit animation**, and by
   * `DRAWER_EXIT_MS` only where that animation never reports.
   *
   * Opening is a CSS animation on mount and needs no state; leaving cannot be,
   * because an unmounted element does not animate. So a close keeps the element
   * on screen with the outgoing animation on it and drops it on the panel's own
   * `animationend`; the timer below is the backstop rather than the wait, for the
   * reason the ⚠ at the foot of this docblock gives.
   *
   * ⚠ **This paragraph said `DRAWER_EXIT_MS` *was* the wait, and that stopped
   * being true in the same change that wired up `animationend` 25 lines below.**
   * A docblock that still promises the old lifetime is worse than no docblock: it
   * is the thing that stops the next reader checking which clock actually ends the
   * exit.
   *
   * `AgentConfigBar`'s picker keeps its panel mounted past dismissal for the same
   * reason — neither layer is a route, so neither has a view-transition snapshot to
   * leave behind — but not on the same clock: read 2026-09-19, its `dismiss` still
   * ends on a flat `window.setTimeout(…, SHEET_EXIT_MS)`. What the two share is the
   * extra lifetime and the argument for it; nothing asserts that they agree about
   * what ends it, and this sentence is a reading of that file rather than a check.
   *
   * ⚠ **The transition is derived during render and may never move to an effect.**
   * It was an effect, and that shipped a visible flash: an effect runs *after* the
   * commit, so the render where `open` first turns false still saw
   * `leaving === false`, took the early return, and **unmounted the panel** — the
   * browser painted a frame with no drawer at all. Only then did the effect set
   * `leaving`, remounting it to play the exit. What that looks like is the menu
   * vanishing and then calmly closing a moment later, which is exactly how it was
   * reported. Setting state during render of this same component is React's
   * documented escape hatch for state derived from props: the render output is
   * discarded and re-run immediately, so nothing intermediate is ever committed
   * and there is no frame to see.
   *
   * ⚠ **`wasOpen` is what stops the exit playing on the first render.** Without
   * it a cold load starts at `open === false`, reads that as a transition out of
   * `open`, and slides a panel nobody opened off the screen. The ref is not state
   * precisely because writing it must not schedule a render of its own.
   *
   * Re-opening during the exit cancels it: the `open` arm clears `leaving` in the
   * same render, and the timer's cleanup drops the pending unmount, so a double
   * tap on the hamburger cannot strand a half-faded panel.
   *
   * ⚠ **What ends the exit is `animationend`, and the timer below is only the
   * backstop.** The wait was a bare `DRAWER_EXIT_MS` timer, which is a constant
   * standing in for a duration that is not constant: under `prefers-reduced-motion`
   * `index.css` collapses every animation to `0.01ms !important`, so the panel is
   * gone within a frame and the timer went on holding the `"sheet"` layer — and
   * therefore `inert` on `#root` — for the rest of the 260ms. Taps hit nothing and
   * the bare-letter shortcuts were dead over a screen with no drawer on it. Both
   * halves of that are now decided by the thing being waited for: the panel says
   * when its own movement finished, in either motion setting, and 260ms is what
   * happens if it never says so.
   */
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
   * what that costs here is not a stuck animation: `leaving` never clears, the
   * panel never unmounts, and the `"sheet"` layer holds `inert` on `#root`
   * **for ever**, which is an app that cannot be tapped or typed at with nothing
   * on screen to explain why. So the timer stays and the event only ever makes the
   * wait shorter.
   */
  useEffect(() => {
    if (!leaving) return;
    const timer = window.setTimeout(() => setLeaving(false), DRAWER_EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [leaving]);

  /*
   * The panel's own movement ending, which is the only thing that knows how long
   * the exit actually took.
   *
   * ⚠ **`event.target !== event.currentTarget` rather than a name match on
   * `event.animationName`.** `animationend` bubbles, so a child that ever animates
   * — a row, a spinner, anything a later edit adds inside the panel — would end
   * this panel's life early from the inside. Comparing the two targets is a fact
   * about *this* element; matching `drawer-out` by name would be a fourth copy of
   * a keyframe name that already lives in `index.css`, in the class string and in
   * `webcheck`, and a rename would make this fall silently back to the timer with
   * everything still green.
   *
   * The `leaving` guard is about the **arrival**, and it is a precondition rather
   * than a measured bug: the same node plays `animate-drawer` on open and fires
   * `animationend` for that too, so without it every open ends in a
   * `setLeaving(false)` on a panel that is not leaving. That is a no-op today, and
   * it is exactly the kind of no-op that stops being one the moment the flag means
   * anything more than it does now.
   */
  const onExitEnd = (event: AnimationEvent<HTMLElement>): void => {
    if (!leaving || event.target !== event.currentTarget) return;
    setLeaving(false);
  };

  const shown = open || leaving;
  /*
   * ⚠ **The layer's lifetime is `shown`, never `open`, and the difference is the
   * whole of the exit animation.**
   *
   * `useDismissible` pushes on `active` and pops in the effect's cleanup, and the
   * pop runs `syncInert` — `#root` loses `inert` and `shortcutsEnabled` goes true
   * again the moment the last `sheet` leaves the stack. Passed `open`, that
   * happened `DRAWER_EXIT_MS` **before** the panel stopped existing: for the whole
   * 260ms of the slide-out the drawer still covered the app while the app behind
   * it was live again, so `j`/`k` walked the session list behind an opaque panel
   * and Tab reached controls nobody could see — verbatim the hazard this file's
   * docblock says `"sheet"` was chosen to prevent. The scrim still caught taps, so
   * nothing pointing at it ever reproduced it; it is keyboard-only, which is why
   * it survived being looked at.
   *
   * `shown` is already the panel's real lifetime — it is what the mount guard
   * below reads — so the layer and the element now begin and end together. The
   * call stays **above** that guard because it is a hook.
   *
   * ⚠ **And `shown` is only worth tying the layer to because it is no longer a
   * timer.** Holding it for a constant `DRAWER_EXIT_MS` traded this defect for its
   * mirror: under `prefers-reduced-motion` the panel is gone in a frame, so the
   * app was inert and keyboard-dead for 260ms with nothing covering it. `leaving`
   * is cleared by the panel's own `animationend` now, so "the layer is up" and
   * "something is covering the app" are the same statement in both motion
   * settings rather than in one of them.
   */
  useDismissible("sheet", onClose, shown);
  const machine = shown ? currentView(sessionGroups(state)).machine : null;
  if (!shown) return null;

  const me = state.me;
  const name = me?.name ?? null;
  /*
   * ⚠ **Only the selected machine's, and only the ones that draw a screen and are
   * usable.** A plugin that is switched off or has failed is not offered rather
   * than offered-and-broken: this is a launcher, and a door onto a sentence saying
   * the plugin is not running is worse than no door. That sentence belongs on the
   * plugin's row inside its machine, and is drawn there.
   */
  const launchable = machine === null ? [] : screenPlugins(state.pluginsByMachine.get(machine) ?? []);

  const go = (path: string): void => {
    /*
     * Close first, then navigate, and the order is the whole of how this panel
     * shuts. `App`'s effect on `usePathname()` is the belt — it is what makes
     * Android's Back close the drawer — but it cannot be the only strap: every
     * destination here is an overlay path, and `AppShell` is handed
     * `route={background}`, so a listener on *that* value would never fire.
     */
    onClose();
    navigate(path);
  };

  return createPortal(
    <>
      {/*
       * A `<div>`, never a `<button>`. `Sheet` argues it: a viewport-sized button
       * is a phantom tab stop, and the ✕ in the head is the accessible way out.
       * `touch-manipulation` because `index.css` grants the 300ms
       * double-tap-to-zoom removal to `button` alone.
       *
       * ⚠ **It read "the rows behind it are the accessible way out", and that was
       * false here rather than merely imprecise.** `Sheet` can say it because it
       * draws a real ✕; this panel registers `useDismissible("sheet")`, which puts
       * `inert` on `#root` — so the rows behind it are precisely the things that
       * cannot be reached. The ✕ is what makes the sentence true again, and the
       * population it was false for is narrow and real: Escape already worked, so
       * a keyboard user was fine, while a screen-reader user on a touch device had
       * no control that dismissed this panel at all.
       *
       * ⚠ **The exiting scrim stops taking taps the instant it starts leaving.**
       * `--animate-scrim-out` ends at `opacity: 0` while the element lives on, so
       * it was an invisible viewport-sized click-eater for the tail of every close.
       * `pointer-events-none` rather than an earlier unmount, because the fade is
       * the thing being kept.
       *
       * ⚠ **The measurement that made this urgent has since gone false, and the
       * line stays anyway.** It read "and under `prefers-reduced-motion`, where
       * `index.css` forces `animation-duration: 0.01ms !important`, for essentially
       * the whole of it" — true while the unmount was a flat `DRAWER_EXIT_MS`
       * timer, which is exactly the hole `animationend` was wired up to close: the
       * dead window under reduced motion is now about one frame rather than 260ms.
       * What is left is the ordinary case, where the scrim is still fading and
       * already transparent enough to be worth nothing as a target, plus whatever
       * the backstop has to cover when no `animationend` arrives — so this is a
       * belt now rather than the fix, and removing it would restore the click-eater
       * precisely on the path that is hardest to see.
       */}
      <div
        aria-hidden={true}
        onClick={leaving ? undefined : onClose}
        className={`${
          leaving ? "animate-scrim-out pointer-events-none" : "animate-scrim"
        } fixed inset-0 touch-manipulation bg-fg/25 ${LAYER.overlay}`}
      />
      <aside
        role="dialog"
        /*
         * `aria-modal`, and it is `Sheet`'s idiom rather than a new one. The
         * attribute is what tells a screen reader that the rest of the document is
         * out of play — which is already *true* here, because the `"sheet"` layer
         * inerts `#root`, so without it the announcement and the reality disagree.
         */
        aria-modal="true"
        aria-label="Menu"
        /*
         * ⚠ **This is what ends the exit, and the timer above is what happens if
         * it never fires.** The panel is the element the outgoing keyframe is on,
         * so it is the only thing in this file that knows when the movement is
         * actually over — which under `prefers-reduced-motion` is a frame rather
         * than `DRAWER_EXIT_MS`, and holding the `"sheet"` layer for the constant
         * left the app inert with nothing on screen for the difference.
         */
        onAnimationEnd={onExitEnd}
        className={`pt-safe pb-safe pl-safe ${
          leaving ? "animate-drawer-out" : "animate-drawer"
        } fixed inset-y-0 left-0 flex w-88 max-w-[85vw] flex-col overflow-hidden border-r border-edge bg-surface shadow-2xl ${LAYER.overlay}`}
      >
        {/*
         * The head: who you are, and the way out.
         *
         * **The identity half is still not a control.** There is no Account row
         * below it for the reason the docblock gives, and making the monogram or
         * the name pressable would put the panel's only destination on the one
         * element that does not look like one.
         *
         * ⚠ **The ✕ is not decoration and it is not a duplicate of the scrim.**
         * This panel inerts `#root`, so a tap on the scrim is the *only* way out
         * that does not go through Escape — and the scrim is `aria-hidden` and a
         * `<div>`, which means a screen-reader user on a touch device had nothing
         * to press. It is `IconButton` at `nav` because that is what `Sheet`'s own
         * ✕ is, down to the 32px of ink reaching 44px: this row is the head of a
         * layer that covers the app, exactly as that one is, and a second size
         * here would be a second answer to a question already settled. `ml-1`
         * keeps that reach off the truncating name beside it.
         */}
        <div className="flex shrink-0 items-center gap-3 px-3 pt-3 pb-4">
          <Monogram name={name} glyph={personEmoji(name)} size="md" className="bg-raised" />
          <span className="min-w-0 flex-1 truncate text-base font-semibold">{name ?? "Signed in"}</span>
          <IconButton icon={X} label="Close menu" onClick={onClose} size="nav" className="-mr-1 ml-1" />
        </div>
        {/*
         * The one extra fact worth a line, and only when it is true. Not `me.id` —
         * an opaque `u_…` under a name is noise. `via` earns its place because it
         * changes what this panel can do: `cp.logout` has no session to delete for
         * a key, and clears locally in its `finally`.
         */}
        {me?.via === "api_key" && (
          <p className="shrink-0 px-3 pb-2 text-2xs text-faint">signed in with an API key</p>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto px-1.5">
          {me !== null && (
            <button type="button" onClick={() => go(settingsPath())} className={`${DRAWER_ROW} text-fg hover:bg-raised`}>
              <Icon as={SettingsIcon} size={18} />
              Settings
            </button>
          )}
          {me !== null && (
            <button type="button" onClick={() => go(marketPath())} className={`${DRAWER_ROW} text-fg hover:bg-raised`}>
              <Icon as={Puzzle} size={18} />
              Plugins
            </button>
          )}
          {/*
           * The plugin screens this machine offers, under the row that manages
           * them — a heading rather than a separator, because these are not more
           * account actions: they are somebody else's screens, and the word above
           * them is what says so.
           */}
          {launchable.length > 0 && machine !== null && (
            <>
              <p className={DRAWER_HEADING}>screens</p>
              {launchable.map((plugin) => (
                <button
                  key={plugin.id}
                  type="button"
                  onClick={() => go(pluginPath(machine, plugin.id))}
                  className={`${DRAWER_ROW} text-fg hover:bg-raised`}
                >
                  <Icon as={Puzzle} size={18} />
                  <span className="min-w-0 truncate">{plugin.contributes.screen?.title ?? plugin.name}</span>
                </button>
              ))}
            </>
          )}
        </div>

        {/*
         * The way out, at the bottom and above the version — pushed there by the
         * scroller's own `flex-1` rather than by a spacer, so a fleet with a dozen
         * plugin screens scrolls past it instead of pushing it off the panel.
         */}
        <div className="shrink-0 border-t border-edge px-1.5 py-1.5">
          <button
            type="button"
            onClick={() => {
              onClose();
              void store.signOut();
            }}
            className={`${DRAWER_ROW} text-danger hover:bg-danger/10`}
          >
            <Icon as={LogOut} size={18} />
            Sign out
          </button>
        </div>

        {/*
         * What build this is, and nothing else.
         *
         * ⚠ **The product mark was here and has been taken out.** A wordmark at
         * the foot of a menu is a thing to look at rather than a thing to read,
         * and the one fact this line carries — which build you are running — was
         * the smaller half of it. `text-muted` rather than `text-faint` for the
         * same reason: it is the only place in the app that answers "what am I
         * running", so it is written to be read once rather than to disappear.
         */}
        <div className="shrink-0 px-4 pb-2 text-2xs text-muted">Version {APP_VERSION}</div>
      </aside>
    </>,
    document.body,
  );
}
