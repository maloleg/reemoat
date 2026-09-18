import { Layers, Menu as MenuIcon, Plus } from "lucide-react";
import { useEffect, useRef, useSyncExternalStore, type ReactNode } from "react";
import { mayAddMachine } from "../quota";
import { navigate } from "../router";
import { settingsPath } from "../settings";
import { sessionGroups, type AppState } from "../store";
import { Icon, Monogram } from "./bits";
import {
  allTab,
  currentView,
  groupsVersion,
  machineTabs,
  selectMachine,
  subscribeGroups,
  type MachineTab,
} from "./groups";

/**
 * The machines, as a column of folders, at `lg` and above.
 *
 * **The same four calls `SessionBrowser` makes, on the same module state, drawn on
 * the other axis.** `machineTabs`, `allTab`, `currentView` and `selectMachine` are
 * untouched: there is one answer to "which machine am I looking at" and two
 * presentations of it, so picking a machine here and picking one on a phone write
 * the same `localStorage` key and cannot disagree.
 *
 * **Two components rather than one with an axis prop**, and that is the same split
 * `SessionBrowser` already made for the same reason. Its docblock: *"The `variant`
 * prop is gone with the split: its only remaining job was row density, and the
 * mount already knows the width, so a prop that could disagree with the CSS no
 * longer exists."* A strip that is horizontal below `lg` and vertical above it is
 * that argument one level up — and this file needs no breakpoint at all, because it
 * is only ever rendered inside `AppShell`'s `hidden … lg:flex` aside.
 *
 * ## What a horizontal strip carries that this one must not
 *
 * **No `.no-scrollbar`.** Its licence in `index.css` is granted to *"a strip dragged
 * sideways whose contents announce there is more of them by being cut off at the
 * edge"*, and the same docblock says outright: never on a vertical list, where a bar
 * is the only thing saying how much more there is. So this column takes the
 * app-wide thin bar under a fine pointer, which is the ordinary appearance of a
 * vertical scroller. That is also how the latent defect recorded against the phone's
 * strip — `.no-scrollbar` plus a desktop pointer — stops applying to a desktop at
 * all.
 *
 * **No `.edge-fade` and no `ResizeObserver`.** The fade answers "this row is cut at
 * its right edge before you touch it", which a scrollbar already answers for a
 * column. ⚠ It is also *wrong* rather than merely redundant here: the strip's
 * `is-cut` arithmetic is `scrollWidth - clientWidth`, which on a vertical box is
 * zero for ever, so the gradient would never light and nothing would fail. Dropping
 * it also leaves this file with no `clientWidth` read at all, which is the property
 * `AppShell`'s no-breakpoint-in-JavaScript rule is really about.
 *
 * **No `overscroll-contain`.** With one machine this column does not overflow, and
 * Chrome ends the scroll chain at a box carrying containment even when it cannot
 * move — 400px of wheel travel against 0px on the same gesture, measured, which is
 * the rule the plugin market's machine list is asserted against.
 *
 * **There is no `wheel` listener to carry over, and there never was one here.** A
 * mouse has no gesture for a horizontal box, so on a desktop the phone's strip
 * cannot be scrolled at all — `AgentStrip` is the one that had to add a non-passive
 * listener for it. A column has a wheel, so this is a gap the axis closes rather
 * than a feature the axis loses.
 *
 * **What does come across** is the scroll-into-view, keyed on `[selected]` and not
 * on every render — the rail re-renders on the four-second poll and on every stream
 * event, and an effect without that key yanks a column you had scrolled back to the
 * selected entry, repeatedly. It is a scroll position rather than a viewport
 * measurement, which is the distinction `AppShell`'s rule turns on.
 *
 * **Order is `machineTabs`', which is `store.ts`'s, which is by name.** No sort
 * here, ever: reachability and activity both flicker on the poll, and a list
 * reordering under a travelling thumb is the one thing this app does not do.
 * Reachability is drawn nowhere — an entry says its name and its waiting count, the
 * two things the pill says today — so this column reverses no part of that trade.
 */
export function MachineColumn({ state, onMenu }: { state: AppState; onMenu: () => void }): ReactNode {
  useSyncExternalStore(subscribeGroups, groupsVersion);
  const groups = sessionGroups(state);
  const view = currentView(groups);
  const tabs = machineTabs(groups, view);
  const all = allTab(groups, view);
  const selected = view.all ? null : view.machine;
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (selected === null) return;
    scroller.current
      ?.querySelector(`[data-machine="${CSS.escape(selected)}"]`)
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [selected]);

  return (
    /*
     * No `bg-*`. This sits inside `AppShell`'s `<aside>`, which paints `bg-ink`
     * explicitly, and the division from the list beside it is `border-r` — the
     * rail's own rule read a second time: `ink` against `surface` is 1.06:1, too
     * small a step to divide two panes, so a line is the divider and a tone would
     * be a hint at best. A ground of its own here would be a third plane in a
     * palette that has three in total.
     *
     * `w-[72px]` in device pixels and not `w-18`, because `rail.ts`'s bounds are
     * device pixels: two spellings of one width that agree only at a 16px root is
     * the defect `--rail-w`'s own docblock records at length. `MACHINE_COLUMN_PX`
     * is the same number in `rail.ts`, and `webcheck` asserts this class string
     * against it.
     */
    <nav aria-label="Machines" className="flex w-[72px] shrink-0 flex-col border-r border-edge">
      {/*
       * The menu, above the folders, which is where a desktop chat client puts it.
       * It needs no breakpoint of its own: this whole component is inside an
       * `<aside>` that is `hidden … lg:flex`, so the phone's copy of this control
       * carries the `lg:hidden` and this one carries nothing — the breakpoint is
       * answered twice in CSS and nowhere in JavaScript.
       */}
      {/*
       * ⚠ **The full width of the column, and not an `IconButton`.**
       *
       * It was a 32px chip centred in a 72px strip, which made the one control
       * above the folders the smallest target in the rail and left it floating in
       * the middle of a band whose every other row is full-bleed. A menu button is
       * the column's own header, so it takes the column's width — the same shape
       * the entries below it have, which is what stops it reading as an object
       * dropped on top of them.
       *
       * The primitive cannot do this: `ICON_BUTTON_SIZE.chip` is `h-8 w-8`, and a
       * `w-full` composed onto it is two width utilities of equal specificity
       * resolved by Tailwind's emission order rather than by the class string —
       * the defect `FIELD`'s docblock names. So this is a plain `<button>` with
       * `min-h-11` for the 44px floor, and `webcheck` matches the label rather
       * than the element.
       */}
      <div className="pt-safe shrink-0 px-1 pb-1">
        <button
          type="button"
          aria-label="Menu"
          onClick={onMenu}
          className="tap flex min-h-11 w-full items-center justify-center rounded-md text-muted hover:bg-raised hover:text-fg"
        >
          <Icon as={MenuIcon} size={18} />
        </button>
      </div>
      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto">
        {/*
         * All is first, and unlike the horizontal strip it needs no pinning
         * outside the scroller. There it was half a pill bled to the rail's left
         * edge, because a tab about the whole fleet must never scroll away and a
         * horizontal row scrolls from the left. A column scrolls from the top, so
         * the first entry is the last thing to leave — the promise is kept by the
         * axis rather than by a shape.
         */}
        <MachineEntry tab={all} glyph={<Icon as={Layers} size={14} />} />
        {tabs.map((tab) => (
          <MachineEntry key={tab.id} tab={tab} />
        ))}
      </div>
      {mayAddMachine(state.me) && (
        /*
         * Outside the scroller and at the bottom: adding a machine is not one more
         * machine to pick between, and with a dozen of them it must not be the
         * thing you scroll to find. The destination is Settings → Machines, the
         * same as the strip's `+`.
         */
        <div className="pb-safe shrink-0 border-t border-edge pt-1">
          <button
            type="button"
            onClick={() => navigate(settingsPath("machines"))}
            className="tap flex min-h-11 w-full flex-col items-center justify-center gap-1 text-muted hover:bg-raised hover:text-fg"
          >
            <Icon as={Plus} size={16} />
            <span className="text-2xs">Add</span>
          </button>
        </div>
      )}
    </nav>
  );
}

/**
 * One machine in the column — or the fleet, which is drawn the same way.
 *
 * **Selection is a band on the whole tile, and the chip steps up on top of it** —
 * `bg-raised` on the entry, `bg-surface` on the monogram inside it. The ⚠ at the
 * top of the function body is the argument; read it before moving the fill.
 *
 * It is not `bg-fg` either way: that is the affirmative action inside a decision
 * and picking a folder is a navigation.
 *
 * **The name is drawn under the square and truncated, and that is what tells two
 * machines apart.** A monogram alone cannot: two hosts whose names begin with the
 * same letter would be one glyph twice, which is a failure the full-width pills
 * never had. `title` is the fallback for a name the 72px column cuts.
 *
 * The blocked badge is the strip's own class string, unchanged — `bg-fg` on a count
 * is already this app's one exception and this is not the place to open it again.
 * `pointer-events-none` so the badge is not a hole in the middle of the control it
 * sits on, which is the rail bell's rule.
 */
function MachineEntry({ tab, glyph }: { tab: MachineTab; glyph?: ReactNode }): ReactNode {
  /*
   * ⚠ **The whole tile carries the selection, not the chip inside it.**
   *
   * It was the chip alone, and at 28px against a rail that is `ink` it was a tone
   * step you had to go looking for — on a strip whose entire job is saying which
   * machine you are reading. A folder rail marks the selected folder as a *band*,
   * and that is what `raised` is for here: `web-shell.md`'s rule is that `raised`
   * means state — a tab you are on, a toggle that is on, a chosen menu row.
   *
   * Which leaves the chip needing to stay visible on top of it, and `surface` is
   * the one step above `raised` this palette has. So a selected entry is a white
   * chip on a grey band and an unselected one is a grey chip on nothing: it reads
   * at a glance and spends no colour, of which there is none to spend.
   *
   * The label carries the third signal, `font-medium text-fg` against
   * `text-muted`, for the reason the session rows already give — with the palette
   * this delicate one signal is not enough, and these three cost nothing.
   *
   * ⚠ **Full-bleed and square, not an inset rounded pill.** The inset was tried
   * and it cost eight pixels of every label in a column where the label is the
   * only thing telling two machines apart — `server-fra` and `server-hel` both
   * elided to `server-…`, which is the one failure a folder rail cannot have. A
   * band running edge to edge is also what the reference draws, and it buys the
   * padding back: `px-0.5` leaves 68px of the 72 for the name, four more than
   * before any of this.
   */
  const tile = tab.selected ? "bg-raised" : "hover:bg-raised/60";
  const chip = tab.selected ? "bg-surface text-fg" : "bg-raised text-muted";
  return (
    <button
      type="button"
      data-machine={tab.id}
      onClick={() => selectMachine(tab.id)}
      aria-pressed={tab.selected}
      title={tab.name}
      className={`tap group relative flex w-full flex-col items-center gap-1 px-0.5 py-2 ${tile}`}
    >
      {glyph === undefined ? (
        <Monogram name={tab.name} className={chip} />
      ) : (
        <span
          aria-hidden="true"
          className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md ${chip}`}
        >
          {glyph}
        </span>
      )}
      <span
        className={`w-full truncate text-center text-2xs ${
          tab.selected ? "font-medium text-fg" : "text-muted group-hover:text-fg"
        }`}
      >
        {tab.name}
      </span>
      {tab.blockedCount > 0 && (
        <span className="pointer-events-none absolute top-1 right-2 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-fg px-1 text-2xs font-semibold text-ink">
          {tab.blockedCount}
        </span>
      )}
    </button>
  );
}
