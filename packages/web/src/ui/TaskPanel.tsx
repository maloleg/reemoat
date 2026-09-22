import { Bot, ChevronRight, Square, Trash2, X } from "lucide-react";
import { memo, useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { errorText } from "../http";
import {
  BACKGROUND_EMPTY,
  dotCells,
  FINISHED_LABEL,
  TASK_CHIPS,
  taskDuration,
  taskElapsedMs,
  taskKindLabel,
  taskSections,
  taskTitle,
  taskTokens,
  type BackgroundReporting,
} from "../tasks";
import { taskFinished, type BackgroundTask } from "../wire";
import type { OutstandingTask } from "./tail";
import { Icon, IconButton, SETTINGS_HEADING } from "./bits";
import { useLeaving } from "./leaving";
import { PaneHandle } from "./PaneHandle";
import { LAYER, useDismissible } from "./overlay";
import { taskPane } from "./taskWidth";

/**
 * The **longest** this panel may outlive a close, and it is one number in two
 * files.
 *
 * It is a ceiling on the wait rather than the wait: `leaving.ts` ends the exit on
 * the panel's own `animationend`, and this decides only what happens when that
 * never arrives — an animation cancelled by a class change, a tab backgrounded
 * across the exit, a browser that fires nothing for a `0.01ms` duration. What it
 * costs to get wrong is not a stuck animation but a panel that never unmounts,
 * sitting over the conversation with nothing left to explain why.
 *
 * ⚠ **It is the longer of the panel's two exits, not the one it plays most.** The
 * phone's sheet leaves on `--animate-sheet-out` at 260ms and the docked card on
 * `--animate-rise-out` at 140, and a backstop is only a backstop if it outlasts
 * both. `webcheck` reads both tokens out of the stylesheet and asserts this
 * against the longer while requiring the shorter to be under it — neither file can
 * see the other's number.
 *
 * Declared here rather than imported from `MenuDrawer`, which is this repository's
 * standing pattern for these: `DRAWER_EXIT_MS` and `SHEET_EXIT_MS` are each
 * written beside the class strings they are the ceiling for and each asserted
 * against its own token. One constant shared across three surfaces would be a
 * single number standing for durations that are not the same.
 */
const TASK_PANEL_EXIT_MS = 260;

/**
 * How wide the docked panel is, and the gutter the conversation opens for it —
 * **one length, spent twice, and it is a custom property now rather than a pair of
 * literals.**
 *
 * ⭐ **The panel is draggable from `md` up, on the rail's own mechanism.** It was
 * two Tailwind literals — `md:w-[20rem] xl:w-[26rem]` here and
 * `md:pr-[20.75rem] xl:pr-[26.75rem]` for the conversation — with a driver reading
 * the two lists and asserting the subtraction at every step. That pin did its job
 * and is gone with the thing it pinned: a width somebody can drag cannot be a
 * literal at all.
 *
 * ⚠ **The gutter is `calc` of the same property rather than a second number**,
 * which is what retires the whole class of defect the old pair was built around. A
 * width and a gutter that had to agree, in two files, four hundred lines apart, is
 * replaced by one declaration and one `+ 0.75rem` — the 12px the card stands off
 * the right edge, so its *left* edge is that much further in and a gutter equal to
 * the width alone would be overlapped by precisely that much. There is no second
 * copy left to drift.
 *
 * ⚠ **They still cannot be built from a number.** A Tailwind class only exists if
 * it survives a scan of the source *as a literal*, so `` `md:w-[${W}]` `` emits no
 * CSS — which is exactly why the two declared defaults live in `index.css`, where a
 * breakpoint belongs, and `taskWidth.ts` keeps the driver's copy of them.
 *
 * `SessionView` imports {@link TASK_PANEL_GUTTER} and puts it on the column holding
 * the header, the transcript and the composer, because the panel is
 * `position: fixed` and displaces nothing by itself. Below `md` neither applies:
 * the panel is a sheet *over* the conversation and there is nothing to make room
 * for.
 *
 * ⭐ **It docks from `md`.** The sheet is for a phone — every phone in portrait is
 * under 768px, and a phone in *landscape* is better served by the card anyway,
 * since a bottom sheet at `h-[92dvh]` over a short landscape viewport is the whole
 * screen.
 *
 * ⚠ **The conversation's width is not monotonic in the window's**, which is why
 * `index.css` declares two defaults rather than one. At `lg` the rail arrives and
 * takes `RAIL_DEFAULT` — 384px — so the 20rem panel leaves the conversation **308px
 * at 1024, narrower than the 436px the same panel leaves at 768**. Measured across the three:
 *
 * | | rail | panel | conversation |
 * |---|---:|---:|---:|
 * | `md` 768 | — | 20rem | 436px |
 * | `lg` 1024 | 384 | 20rem | 308px |
 * | `xl` 1280 | 384 | 26rem | 468px |
 *
 * A reader who drags overrides both — an inline declaration on `documentElement`
 * beats both media blocks — and a double-click on the separator hands them back.
 * `taskWidth.ts` argues why that is the honest shape rather than one number.
 */
export const TASK_PANEL_WIDTH = "md:w-[var(--task-fit)]";
/**
 * How far the docked panel stands off every edge it is near: 12px, `*-3`.
 *
 * ⚠ **It used to sit flush — `inset-y-0 right-0`, square, no shadow — and that is
 * what made it impossible to line up.** Flush against the viewport it is a second
 * surface claiming the same edges as the window's own chrome, so its head's rule
 * and the header's had to be the same height to the pixel or the eye read one
 * broken line. They were 4px apart. Pinning the two heights fixed that instance
 * and left the arrangement: any future change to either row reopens it.
 *
 * Inset, the question stops being asked. A card that touches nothing lines up with
 * nothing, so there is no edge to meet and nothing to keep in step — which is why
 * this is a *shape* change rather than a second measurement.
 *
 * ⚠ **`0.75rem` appears once more, inside {@link TASK_PANEL_GUTTER}'s `calc`**, and
 * that is the one number here a driver still has to read out of two strings and
 * compare. Three `*-3` utilities and a `+ 0.75rem` are the same 12px written in
 * Tailwind's two spellings, and nothing in CSS relates them.
 */
export const TASK_PANEL_INSET = "md:top-3 md:right-3 md:bottom-3";
/**
 * The room the conversation leaves for it: the panel's own width **plus the inset
 * on the side it is docked to**.
 *
 * ⚠ **Not the same length as {@link TASK_PANEL_WIDTH}, and the difference is
 * load-bearing.** While the panel was flush the two were one length and `webcheck`
 * asserted exactly that. Standing it 12px off the right edge moves its *left* edge
 * 12px further in, so a gutter still equal to the width would be overlapped by
 * precisely that much — the card lying over the last 12px of every line of the
 * conversation.
 */
export const TASK_PANEL_GUTTER = "md:pr-[calc(var(--task-fit)+0.75rem)]";

/**
 * Everything this session left running, on a surface of its own.
 *
 * ⚠ **Two placements, one element, and the breakpoint is answered only in CSS.**
 * Below `md` this is a bottom sheet over the conversation — the geometry the
 * settings pop-up uses on a phone, because that is the shape somebody asked for
 * and the shape this app already teaches. From `md` it docks against the right edge
 * and `SessionView` pads itself out of the way, so the conversation is beside it
 * rather than under it. `AppShell`'s rule holds here: nothing in JavaScript knows
 * what `md` is, so a resized window cannot end up drawing a docked panel over a
 * conversation that did not make room for it.
 *
 * ⚠ **Portaled, and not because it is modal — because `fixed` has to mean the
 * viewport.** `Sheet.tsx` states the mechanism and this panel inherits it:
 * `position: fixed` resolves against the nearest ancestor carrying `filter` /
 * `backdrop-filter` / `transform` / `perspective` / `contain`, and this app's
 * header and composer are one hop from a `backdrop-blur`. A panel rendered in
 * place inside `SessionView` would be positioned against whichever of those it
 * happened to sit under. The *measured* half of that — the stacking-context
 * regression from rendering in place rather than portaling — is `AskCard`'s
 * docblock, which is where `Sheet.tsx` points too; nothing about it was re-run
 * for this surface.
 *
 * ⚠ **It is `menu` in the overlay stack rather than `sheet`, and that is the
 * whole of what "not modal" means here.** A `sheet` puts `inert` on `#root`,
 * which would switch off the conversation this panel is docked *beside* from `md` —
 * and there is no way to make that conditional without asking JavaScript what the
 * breakpoint is. So: Escape closes the topmost layer as everywhere else, the ask
 * card's digit shortcuts stand down while it is open exactly as they do under any
 * open menu, and nothing behind it is switched off.
 *
 * ⚠ **What this panel cannot draw, and why the gaps are silences rather than
 * zeroes.** Claude Code's own dialog shows, for a workflow, an agent count, a
 * per-agent table of model / tokens / time, and an `N/M` phase fraction. **None of
 * those is on this wire.** The adapter marks every `local_agent` task `ignored`
 * before publishing anything, so a workflow's ten agents never leave the CLI; the
 * three `async_task_*` payloads carry no phase, no fraction, no model and no agent
 * count at all. Drawing `0 agents` or `0/10` would be a claim, so the fraction is
 * omitted — which is Claude Code's own rule for a phase whose total is zero — and
 * the meter draws the one moving cell that says *something is going and nobody is
 * saying how far*.
 */
export function TaskPanel({
  open,
  onClose,
  tasks,
  background,
  reporting,
  onStopTask,
  hiddenFinished,
  onClearFinished,
}: {
  open: boolean;
  onClose: () => void;
  /** The transcript's delegations — the `Agents` section, and a different source. */
  tasks: readonly OutstandingTask[];
  /** What the agent said it left running, from the snapshot. */
  background: readonly BackgroundTask[];
  /**
   * Whether anybody has been able to ask this session about background work.
   *
   * ⚠ **The only thing that can tell an empty list from an unasked question**, and
   * it is three-valued rather than a boolean because *unasked* is two different
   * situations. claude is the one agent of the four with a lifecycle on the wire;
   * kimi backgrounds shells, agents and cron jobs and says nothing, codex leaves a
   * PTY running behind an ordinary tool call, and opencode cannot background at
   * all — that is `silent`. And after a daemon restart there is no agent at all
   * until one is resumed, which read as `silent` and put a sentence about claude on
   * screen that was false. `tasks.ts` carries the derivation and the three
   * sentences.
   */
  reporting: BackgroundReporting;
  /** `null` where nothing can stop one — an older daemon, or a session with no agent. */
  onStopTask: ((task: BackgroundTask) => Promise<void>) | null;
  /**
   * Which finished rows this reader has cleared — a set, not a filtered list, so
   * the wire's own partition stays the wire's. `finishedTasks.ts` owns it.
   */
  hiddenFinished: ReadonlySet<string>;
  onClearFinished: (ids: readonly string[]) => void;
}): ReactNode {
  /*
   * ⭐ **The sheet collapses rather than disappearing, and on a phone that was the
   * whole complaint.** Opening is a CSS animation on mount and needs no state;
   * leaving cannot be, because an unmounted element does not animate — so the
   * panel stays on screen with the outgoing animation on it and is dropped when
   * the movement reports. `leaving.ts` is the mechanism and carries every
   * paragraph of it; what is here is this panel's own two exits and its own
   * ceiling.
   *
   * ⚠ **`shown`, never `open`, in both places below.** The layer's lifetime and
   * the element's are one statement: registered on `open` the layer pops at the
   * *start* of the exit, so the ask card's digit shortcuts come back and Escape
   * stops being swallowed while an opaque sheet is still covering the screen.
   * `MenuDrawer` measured that one layer kind over, where it costs `inert` as
   * well.
   */
  const { shown, leaving, onAnimationEnd } = useLeaving(open, TASK_PANEL_EXIT_MS);
  useDismissible("menu", onClose, shown);
  if (!shown) return null;
  return createPortal(
    <>
      {/* The scrim exists only where the panel covers the conversation. From `md`
          the panel is beside it and there is nothing to dim — and a scrim that
          followed it there would grey out the transcript somebody opened this to
          read alongside. `md:hidden` is `display: none`, so at those widths no
          animation runs here and nothing takes a click: the docked arrangement
          needs nothing from this element.

          ⚠ **It had no animation in *either* direction**, which is half of what
          "it disappears" was about — the ground snapped to 25% ink on open and
          blinked out on close while the sheet slid. It is on the sheet's clock now,
          which is what makes the two read as one movement.

          ⚠ **`pointer-events-none` the moment it starts leaving.**
          `--animate-scrim-out` ends at `opacity: 0` while the element lives on, so
          without it the tail of every close is an invisible viewport-sized
          click-eater. `MenuDrawer` measured that; it is a belt here rather than the
          fix, and removing it restores the eater precisely on the path that is
          hardest to see. */}
      <div
        aria-hidden={true}
        className={`${
          leaving ? "animate-scrim-out pointer-events-none" : "animate-scrim"
        } fixed inset-0 touch-manipulation bg-fg/25 md:hidden ${LAYER.overlay}`}
        onClick={leaving ? undefined : onClose}
      />
      {/*
       * ⚠ **The material tokens are `SHEET_PANEL`'s, in `SHEET_PANEL`'s order, and
       * they are spelled out here rather than composed — which is the one place in
       * this panel where `web-typography.md`'s "extracting a constant does not
       * retire an idiom" is knowingly not obeyed.** The shared twelve are
       * `pb-safe animate-sheet flex h-[92dvh] min-h-0 flex-col overflow-hidden
       * rounded-t-2xl border-t border-edge bg-surface shadow-2xl`, and the `aside`
       * below writes them in that order — with **one substitution**, which is the
       * exception that proves the rule rather than a drift: the leading `pb-safe`
       * is spelled as its own value, `pb-[max(0.75rem,env(safe-area-inset-bottom))]`.
       * `.pb-safe` is declared **unlayered** in `index.css` while Tailwind emits
       * every utility inside `@layer utilities`, and an unlayered rule beats a
       * layered one regardless of specificity — so the `md:pb-0` at the end of this
       * string was a silent no-op and the docked card carried 12px of phone padding
       * at every desktop width. Measured at 1280: `padding-bottom` computed 12px
       * with `md:pb-0` asking for 0, leaving the body 28px above the card's bottom
       * border against 16px below its top. Written as a utility it is the same
       * value in the same layer, so the `md:` variant can finally win.
       * `Composer.tsx` records the identical cascade fact and names `SHEET`'s
       * `sm:pb-0` as still losing it, which is this defect one surface over.
       *
       * **The positioning is deliberately not shared, and that is the half that
       * cannot be composed even in principle.** `SHEET_PANEL` carries `relative
       * w-full` because `Sheet.tsx` hands it to a `fixed inset-0 flex flex-col
       * justify-end` scrim that does the positioning for it; here the scrim is a
       * sibling that exists only below `md`, so this element is the positioned one
       * and takes `fixed inset-x-0 bottom-0` instead. Those three are not
       * `SHEET_PANEL` tokens and its two are absent — which is why the question to
       * ask of this string later is *"are the twelve still the constant's, in its
       * order?"* and never *"does this match `SHEET_PANEL`?"*, a thing it was never
       * true of. `SHEET_PANEL` is a bottom
       * sheet *and* a centred card: `sm:h-[min(44rem,88dvh)] sm:max-w-2xl
       * sm:rounded-2xl sm:border sm:pb-0 sm:animate-rise`. This surface is a bottom
       * sheet at every width below `md` — it has a rail beside it, not a backdrop
       * around it — so composing that string means cancelling six utilities in the
       * `sm:` variant, and a cancellation of the *same property in the same
       * variant* is exactly the trap `SETTINGS_HEADING` carries its own warning
       * about: `sm:h-[92dvh]` against `sm:h-[min(44rem,88dvh)]` is resolved by
       * Tailwind's emission order and not by the order of the string, so the height
       * of this panel would be decided by which file the scanner reached first.
       * ⚠ **The head below has the same half on the `min-h-*` axis and is spelled
       * out for it**, so this file now refuses composition in both places for one
       * reason. That paragraph read "`SHEET_HEAD` below has no such half and *is*
       * composed", which was true when it was written and is the claim
       * {@link PANEL_HEAD} reverses — a second `min-h` is resolved by emission
       * order exactly as a second `h` is, and in a direction that only ever adds.
       *
       * What is shared is therefore shared by writing the same tokens: `h-[92dvh]`
       * rather than the `top-[8dvh] bottom-0` it replaces, which is the same
       * geometry and the same grep. `md:h-auto` is what that costs — with `top`,
       * `bottom` and a definite `height` all set, the height wins and `bottom` is
       * ignored, so the docked panel would stop 8dvh short of the floor.
       */}
      <aside
        aria-label="Background"
        /*
         * ⚠ **This is what ends the exit, and {@link TASK_PANEL_EXIT_MS} is what
         * happens if it never fires.** The aside is the element both outgoing
         * keyframes are on, so it is the only node here that knows when the
         * movement is over — which under `prefers-reduced-motion` is a frame rather
         * than either constant. `leaving.ts` carries why it compares targets rather
         * than keyframe names, which matters more here than on the drawer: this
         * panel has a pulsing meter cell inside it, and `animationend` bubbles.
         */
        onAnimationEnd={onAnimationEnd}
        /*
         * ⚠ **Two arms, and each variant carries exactly one `animation` utility in
         * each of them.** `md:animate-none` used to sit in the shared run, which
         * was correct while there was no exit: it cancels `animate-sheet`, whose
         * `translateY(100%)` would otherwise slide the docked card up from the
         * bottom of the screen. It cannot stay there now. Written
         * `md:animate-rise-out` beside a standing `md:animate-none` it is two
         * utilities setting one property in one variant, resolved by Tailwind's
         * emission order rather than by the order of this string — the trap
         * `SETTINGS_HEADING` carries its own warning about. So the cancellation
         * moved onto the non-leaving arm, where it has since become a real arrival:
         * a card at a width with no edge to have come from is what `rise` is for,
         * and `SHEET_PANEL` already answers it that way.
         *
         * ⚠ **And it is not optional at `md`.** An element carrying
         * `animation: none` fires no `animationend`, so the exit would fall to the
         * backstop and leave a fully visible card over the conversation for its
         * whole duration — the mirror of the defect the backstop exists to prevent,
         * arriving at one breakpoint only.
         */
        className={`pb-[max(0.75rem,env(safe-area-inset-bottom))] ${leaving ? "animate-sheet-out" : "animate-sheet"} fixed inset-x-0 bottom-0 flex h-[92dvh] min-h-0 flex-col overflow-hidden rounded-t-2xl border-t border-edge bg-surface shadow-2xl ${TASK_PANEL_WIDTH} ${TASK_PANEL_INSET} ${leaving ? "md:animate-rise-out" : "md:animate-rise"} md:left-auto md:h-auto md:rounded-2xl md:border md:pb-0 md:shadow-lg ${LAYER.overlay}`}
        role="dialog"
      >
        <PanelHead onClose={onClose} />
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4 sm:px-5">
          <PanelBody
            background={background}
            hiddenFinished={hiddenFinished}
            onClearFinished={onClearFinished}
            onStopTask={onStopTask}
            reporting={reporting}
            tasks={tasks}
          />
        </div>
        {/* ⚠ **There was a footer here explaining that a per-task view is not sent
            to this app, and it is gone by the owner's call.** The sentence was true
            — `outputFilePath` points outside the workspace and there is no detail
            view to build — but it answered a question nobody on this screen was
            asking, on every visit, for ever. A standing explanation of an absence
            costs more than the absence does once somebody has opened the panel
            twice. The fact it stated is in `plugins.md`'s neighbourhood and in this
            file's own history; what it may not be is a permanent line. */}
      </aside>
      {/*
       * ⭐ **The card can be made wider or narrower, on the rail's own separator.**
       *
       * `PaneHandle` is `AppShell`'s `RailHandle` generalised rather than a second
       * one — `sign: -1` is the whole of the difference, this pane being to the
       * *right* of its handle, so leftwards is wider. Everything measured on the
       * rail comes with it: capture rather than `window` listeners, the committed
       * width restated on cancel, the keyboard steps, and the reset on
       * double-click, which here hands back the two breakpoints instead of a single
       * default.
       *
       * ⚠ **A sibling of the `<aside>`, not a child of it.** That element is
       * `overflow-hidden`, so a strip on its edge would be clipped away entirely;
       * and it is the element both exit keyframes are on, so a handle inside it
       * would ride the card off the screen on every close.
       *
       * ⚠ **`md:top-6 md:bottom-6`, not the card's own `*-3`.** The panel is
       * `md:rounded-2xl` — a 16px radius — so a strip run its full height overhangs
       * the corner at both ends and its top and bottom 16px sit over the
       * conversation, where a click meant for a line of text resizes the panel
       * instead. 24px in clears the radius with room to spare.
       *
       * ⚠ **`LAYER.overlay`, not `LAYER.header`.** The rail's strip has to beat two
       * sticky bars in the page; this one has to beat the card it is attached to,
       * which is itself at `overlay` — and it is portaled to `document.body`, so it
       * is `fixed` rather than `absolute`.
       *
       * `hidden md:…:block` for `AppShell`'s reason: below `md` this panel is a
       * sheet covering the conversation, there is nothing beside it to take width
       * from, and the breakpoint is answered in CSS and nowhere else.
       *
       * ⚠ **`[@media(pointer:fine)]` nested inside the width, because an 8px strip
       * is not a control a finger may reach.** `md` is 768px and `lg` is 1024,
       * which every tablet clears — so without this the separator is a tabbable,
       * capture-taking, `touch-action: none` strip lying across the edge of the
       * conversation on an iPad, with `bg-transparent group-hover:` as its only
       * appearance and therefore no appearance at all. A flick that begins within
       * four pixels of that edge resized a pane instead of scrolling, silently,
       * and committed the result.
       *
       * ⚠ **Nested rather than a competing `[@media(pointer:coarse)]:hidden`.**
       * Two `display` utilities in one string are resolved by Tailwind's emission
       * order rather than by the order of the string — the trap this repository
       * records on three other properties. Narrowing the one that turns it *on*
       * has no such contest: `hidden` is the base and exactly one thing overrides
       * it. Verified in the built stylesheet.
       *
       * This is what the docblock above already claims — *"these separators exist
       * only where the pointer is a mouse"* — which is also the standing argument
       * for an 8px target under this app's 44px tap floor. It was a claim rather
       * than a mechanism until now. The cost is that a coarse-pointer device has
       * no way to change either width; the stylesheet's declared answers stand,
       * which is the same trade the rail already made below `lg`.
       */}
      <PaneHandle
        pane={taskPane}
        label="Background panel width"
        sign={-1}
        className={`fixed hidden w-2 translate-x-1/2 md:top-6 md:bottom-6 md:[@media(pointer:fine)]:block ${LAYER.overlay}`}
        style={{ right: "calc(var(--task-fit) + 0.75rem)" }}
      />
    </>,
    document.body,
  );
}

/**
 * `Background`, Claude Code's title, and the one control this panel has.
 *
 * ⚠ **No total beside the title, on the owner's call, and the argument holds up:
 * every section already carries its own count and they are the counts somebody
 * came here for.** A second number over them answers a question nobody has —
 * `Agents` and `Completed` are in it, so it is not "how much is running", and it
 * is not any section's figure either. Claude Code's own dialog has no total here;
 * what it puts in this slot is a *subtitle* naming the live kinds.
 */
/**
 * `SHEET_HEAD`'s row at this panel's own height, and the number is the only
 * difference.
 *
 * ⚠ **It was that constant, composed, and un-composing it reverses a decision
 * this file recorded rather than drifting from one.** The paragraph here argued
 * that the row being a second copy of an idiom is what composing fixed —
 * `web-typography.md`'s rule, and still true of the row. What it never weighed is
 * that 56px is a height argued for a *sheet's* head: a `text-lg` `<h1>` beside a
 * 32px `nav` control. This head carries a `text-xs` `<h2>` and a 24px `sm` button,
 * so it was forty pixels of band around twenty-four of content — which is what was
 * reported.
 *
 * ⚠ **`` `${SHEET_HEAD} min-h-11` `` is a silent no-op, and it is measured rather
 * than feared.** Two `min-h-*` utilities on one element are resolved by the
 * stylesheet's emission order rather than by the order of the class string, and
 * that order is **numeric and ascending**: in the built sheet `.min-h-9`,
 * `.min-h-10`, `.min-h-11`, `.min-h-12`, `.min-h-14` appear in that sequence
 * inside one layer. So composition can only ever make this head *taller*. `h-10`
 * is no escape either — a `min-height` of 56px beats a `height` of 40 by the box
 * algorithm rather than by the cascade — and `min-h-[2.75rem]` is the same bet in
 * a less legible form, there being no arbitrary `min-h` anywhere in the sheet to
 * say where one would land.
 *
 * ⚠ **Inverting `SHEET_HEAD` to 44 and letting `Sheet` compose 56 back on would
 * work, and is refused for that reason.** Upward composition is the direction
 * emission order permits, so it is a smaller diff that happens to land — and it
 * makes a head's height depend on which of two numbers is larger, which is the
 * trap `BUTTON_SIZE` and `DRAWER_HEADING` each spent a docblock closing. It also
 * hands the next person who wants a shorter sheet head a revert that fails in
 * silence. `SHEET_HEAD` stays 56 and stays one thing.
 *
 * **44 rather than 40, and the two pixels are the whole of the reason.** Every
 * entry in `ICON_BUTTON_SIZE` reaches this app's 44px floor through a positioned
 * `::after` that costs no layout — `sm` is 24px of ink plus `after:-inset-2.5`.
 * At 40 that target overhangs the band by 2px top and bottom, and the `<aside>`
 * carries `overflow-hidden`, which clips hit-testing along with paint: a 42px
 * target with nothing on screen to explain the missing strip. At 44 it ends flush,
 * bar a corner lens the card's own 16px radius takes at the point furthest from
 * the glyph. It is also the one value on `webcheck`'s own reaches-44 list that
 * `min-h-10` is not, and it still takes 12px — a fifth — off the band.
 *
 * Every other token is `SHEET_HEAD`'s, in `SHEET_HEAD`'s order, `sm:px-5`
 * included: the scroller below carries the same inset, and a head inset further
 * than its own contents is the one visible thing spelling this out could break.
 * `webcheck` differences the two strings rather than trusting the sentence.
 *
 * ⚠ **Not named with a capital-S `Sheet` in any spelling.** `webcheck` pins
 * `/\bSheet\b/` **absent** from this file's code, which is what says this panel is
 * not the app's modal pop-up.
 */
const PANEL_HEAD = "flex min-h-11 shrink-0 items-center gap-2 border-b border-edge px-4 sm:px-5";

function PanelHead({ onClose }: { onClose: () => void }): ReactNode {
  return (
    /*
     * ⚠ **`xl:min-h-15` was here and is gone with the flush edges.** It made this
     * head exactly as tall as the window's own header so their two rules read as
     * one line. A card that stands 12px off every edge meets no line, so the
     * number had nothing left to agree with — and a number kept past its reason is
     * the next thing to drift. {@link PANEL_HEAD} is the height that replaced it,
     * argued from what the row holds rather than from what it sits beside.
     */
    <div className={PANEL_HEAD}>
      {/* ⚠ **`text-xs`, and the rule is the comparison rather than the size.** This
          is a sub-window *inside* the app, so its name may not compete with the
          name of the screen it is inside: `SessionTitle` is `text-sm`, and this was
          `text-lg` — a panel announcing itself more loudly than the conversation it
          is about. `webcheck` asserts it is strictly the smaller of the two rather
          than asserting either number, which is what keeps the claim true when
          either moves. The band's height is the other half of that decision and did
          not move with it for a release; {@link PANEL_HEAD} is where it did. */}
      <h2 className="min-w-0 flex-1 truncate text-xs font-semibold">Background</h2>
      <IconButton icon={X} label="Close background tasks" onClick={onClose} size="sm" />
    </div>
  );
}

function PanelBody({
  tasks,
  background,
  hiddenFinished,
  onClearFinished,
  reporting,
  onStopTask,
}: {
  tasks: readonly OutstandingTask[];
  background: readonly BackgroundTask[];
  hiddenFinished: ReadonlySet<string>;
  onClearFinished: (ids: readonly string[]) => void;
  reporting: BackgroundReporting;
  onStopTask: ((task: BackgroundTask) => Promise<void>) | null;
}): ReactNode {
  /*
   * ⚠ **Memoised because this component hangs off `EventList`, which re-renders on
   * every streamed token — and the panel is open precisely while tokens stream.**
   * `taskSections` allocates five fresh arrays per call, and each `TaskCard` below
   * re-runs `taskTitle`, `taskElapsedMs`, `taskDuration`, `taskTokens` and
   * `dotCells` (which allocates again). At the daemon's own ceiling that is 32
   * cards rebuilt per arriving chunk, on a phone. The daemon already hands back a
   * fresh array only when the set really changed — `sameBackgroundTasks` gates the
   * announce — so the reference is a sound key.
   */
  const sections = useMemo(() => taskSections(background), [background]);
  /*
   * ⭐ **The finished band is the panel's, not the partition's**, and it is drawn
   * even when there is nothing in it — which is the owner's rule and the reason
   * the kebab's door exists at all: a record you can only reach while something
   * else is running is not a record.
   *
   * ⚠ **Gated on `reports`, like the sentence below and for the same reason.**
   * `Completed (0)` is a *count*, and a count of finished background work is an
   * **answer**. claude is the one agent of the four that reports a lifecycle;
   * kimi backgrounds shells and says nothing, codex leaves a PTY behind an
   * ordinary tool call, opencode cannot background at all. So on three of the four
   * a zero here would assert exactly what the sentence below is careful to
   * disclaim. The `||` arm is belt rather than a second behaviour: a non-reporting
   * agent's `background` is always empty, so it never fires.
   *
   * ⚠ **`"unasked"` is on the barred side with `"silent"`, and for the same
   * reason.** After a restart the daemon's own rows are gone — `asyncTasks` is a
   * `Map` in memory, emptied at `doStop` — so a zero there would say *nothing
   * finished* about a session that may have finished ten things before the process
   * died. The band comes back the moment an agent does, which is when the count
   * starts meaning something again.
   */
  const finished = useMemo(() => background.filter((task) => taskFinished(task.state)), [background]);
  const showFinished = reporting === "reports" || finished.length > 0;
  /*
   * ⚠ **One count where there were two proxies.** The `Agents` heading was gated
   * on `sections.length > 0` and a live section's own heading on
   * `sections.length > 1`, both standing in for *is there more than one band on
   * screen* — which was true while `Completed` was inside `sections` and stopped
   * being the moment it moved out. Counting the bands says the thing directly.
   * `FinishedSection` names itself unconditionally, so it counts.
   */
  const bands = (tasks.length > 0 ? 1 : 0) + sections.length + (showFinished ? 1 : 0);
  /*
   * ⚠ **One interval for the whole panel, and it used to be one per card.**
   * `useTick` was called inside `TaskCard`, so a panel at the daemon's own
   * ceiling (`MAX_TRACKED_ASYNC_TASKS`) installed that many independent
   * `setInterval`s — each started whenever its card mounted, so each firing its
   * own `setNow` at its own phase, and React batches nothing across separate
   * timer callbacks. That is up to one render of a card per 1/32 of a second on a
   * phone, to move a clock that ticks once a second. {@link TICK_MS}'s docblock
   * claimed *"the one place in this app that schedules a render for a clock"*,
   * which was true of the app and not of this panel.
   *
   * Gated on something actually running rather than on the panel being open: a
   * list of finished work needs no clock, and `taskElapsedMs` prefers `endedAt`,
   * so a finished card reads the same number whatever `now` says.
   */
  const now = useTick(background.some((task) => !taskFinished(task.state)));
  /*
   * The stem the section headings hang their ids off. `useId` because there can
   * be two of this panel mounted at once for one blink — `OverlaySheet`'s
   * cross-dissolve moment, and a two-pane desktop switching sessions — and an id
   * repeated in the document points every `aria-labelledby` at whichever came
   * first.
   */
  const headings = useId();
  if (tasks.length === 0 && sections.length === 0 && !showFinished) {
    /*
     * ⭐ **Three empty states, because there are three reasons to be empty and only
     * one of them is a fact about the work.** It was a ternary over a boolean, and
     * the missing third arm is what put *"This agent doesn't report background
     * work"* on screen about claude after every daemon restart: the flag is `false`
     * while no agent is attached, and that is *nobody asked* rather than *it does
     * not report*. `tasks.ts` holds the derivation and the sentences, as a table
     * over the union rather than a shape here, so a fourth state is a compile
     * error and `webcheck` can sweep the partition.
     */
    return <p className="text-2xs text-faint">{BACKGROUND_EMPTY[reporting]}</p>;
  }
  return (
    <div className="space-y-5">
      {tasks.length > 0 && (
        /* ⚠ **`aria-labelledby` is conditional on the heading being drawn**, and
           it has to be: a section pointing at an id nothing renders has no name
           at all, which is worse than the unnamed region it was meant to fix. The
           two conditions are therefore literally the same expression. */
        <section
          aria-labelledby={bands > 1 ? `${headings}-agents` : undefined}
          className="space-y-1.5"
        >
          {/* `Agents` heads its list only when something else is populated —
              Claude Code suppresses its own first heading for the same reason: a
              single labelled group is a label with nothing to distinguish it
              from, and this list was unlabelled for its whole life before the
              second source arrived. */}
          {bands > 1 && <PanelHeading count={tasks.length} id={`${headings}-agents`} label="Agents" />}
          {tasks.map((task) => (
            <p className="flex items-center gap-2 text-2xs" key={task.key}>
              <span className="shrink-0 text-muted">
                <Icon as={Bot} size={11} />
              </span>
              <span className="min-w-0 flex-1 truncate text-fg/85">
                {task.title}
                {task.latest !== null && <span className="ml-1.5 text-faint">{task.latest}</span>}
              </span>
              {task.steps > 0 && (
                <span className="shrink-0 text-faint">
                  {task.steps} step{task.steps === 1 ? "" : "s"}
                </span>
              )}
            </p>
          ))}
          {/* The whole semantics of that count, in four words, and it covers the
              delegations only: a background task reports its own end, so "not
              reported finished" is exactly what is *not* true of one. */}
          <p className="text-2xs text-faint">started, and not reported finished</p>
        </section>
      )}
      {sections.map((section, index) => {
        const headingId = `${headings}-${index}`;
        /* From the other side: a machine running only shells draws the cards it
           always would have, unlabelled — and then names no region either, for
           the reason the `Agents` section above states. */
        const named = bands > 1;
        return (
          <section
            aria-labelledby={named ? headingId : undefined}
            className="space-y-1.5"
            key={section.label}
          >
            {named && (
              <PanelHeading count={section.tasks.length} id={headingId} label={section.label} />
            )}
            {section.tasks.map((task) => (
              <TaskCard key={task.id} now={now} onStop={onStopTask} task={task} />
            ))}
          </section>
        );
      })}
      {/* Last, always named, and drawn whether or not it holds anything — the one
          band whose job is saying that work is over rather than that it is going. */}
      {showFinished && (
        <FinishedSection
          headingId={`${headings}-finished`}
          hidden={hiddenFinished}
          label={FINISHED_LABEL}
          now={now}
          onClear={onClearFinished}
          onStop={onStopTask}
          tasks={finished}
        />
      )}
    </div>
  );
}

/**
 * `Label (n)` — Claude Code's `Jg`, in this app's one heading idiom.
 *
 * ⚠ **A real `<h3>` carrying an id, and both halves are the fix for the same
 * defect.** This drew a `<p>`. Swept while writing this — `grep -rn
 * SETTINGS_HEADING packages/web/src`, minus the constant's own declaration, the
 * imports and the prose mentions — every call site of the idiom is on a heading
 * element **except eight**, and the eight are the same kind of thing as each
 * other: four `<label>`s (`ForcedPasswordChange`, `SignIn` twice, and `gate/Gate`'s
 * shared `label` constant), two `<span>`s (`OneTimeSecret`'s copyable-value
 * caption, `MarketEntry`'s disclosure label), one `<tr>` (`KeyRow`'s table head)
 * and one `<p>` (`PluginsPanel`'s `What it printed`, which argues its own case in
 * place: a failed plugin per machine would otherwise put that many identical
 * entries into the document outline). Every one of those eight names a *control
 * or a cell* rather than a band of content. Here the bands
 * *are* the content — this is the one surface in the app whose entire job is
 * partitioning work by kind — and with a `<p>` above each of them the panel was a
 * flat run of rows to a screen reader, inside a `role="dialog"` whose own name is
 * the single word `Background`. `<h3>` because the dialog's title is an `<h2>`;
 * nothing in `index.css` styles a heading element, so nothing visual moves.
 *
 * The exceptions are enumerated rather than left as a bare total on purpose:
 * `web-typography.md` makes the point that a count restated in prose is the claim
 * this repository has learned not to keep, and a named set is a thing the grep
 * above can be re-run against one file at a time. The sentence this replaces said
 * *"all but two … a table head and a field label"*, which was wrong in both the
 * total and the shape of the exception set.
 *
 * The id is the other half: a `<section>` with no accessible name is not exposed
 * as a region at all, so the heading would have been announceable while the group
 * under it stayed anonymous. Its caller points `aria-labelledby` here.
 */
/**
 * The finished band's type: `SETTINGS_HEADING`'s idiom one tone down.
 *
 * ⚠ **Written out rather than `` `${SETTINGS_HEADING} text-faint` ``, which is a
 * silent no-op.** Two members of one colour family on one element are resolved by
 * Tailwind's alphabetical emission rather than by the order of the string —
 * `RETIRE_HEADING`, `HIDDEN_PROVIDER_HEADING` and `DRAWER_HEADING` are each spelled
 * out for exactly this, and `webcheck.typography.ts` sweeps every shared class
 * string for the form. This is the sixth documented site of the idiom, and that
 * driver carries a **census** rather than a count, so a sixth reddens it as *found,
 * not listed* until the table names it.
 *
 * **Faint rather than muted, and the distinction is the band's whole subject.**
 * Every other heading in this panel names work that is *going*; this one names work
 * that is *over*. A reader scanning a live panel is scanning past it, and by the
 * owner's call it should look like it.
 *
 * ⚠ **Both arms of the band spend it** — the fold and the empty heading — or the
 * band changes colour at the moment it empties, which is the one moment nothing
 * about it has changed.
 */
const FINISHED_HEADING = "text-2xs font-semibold tracking-wider text-faint uppercase";

/**
 * `Completed (n)`, folded, with the one control that empties it.
 *
 * ⭐ **A workflow that ended while this panel was open used to just sit there.**
 * `taskSections` did move it to `Completed`, correctly — but `PanelBody` draws a
 * section's heading only when something else is populated, so with one workflow
 * and no delegations the finished card was drawn in the same place, at the same
 * size, with its chip changed from `(running)` to `(done)` and **nothing on screen
 * saying the word**. Reported as the panel not letting go of it. A band that folds
 * is what says the row moved.
 *
 * ⚠ **Seeded closed, and the mechanism is the panel's early return rather than a
 * prop.** `TaskPanel` renders nothing while `!shown`, so everything from
 * `PanelBody` down is unmounted on every close and this `useState(false)` is read
 * afresh on every open — the whole of *collapsed by default*, with no state to
 * store and nothing to keep in step. It matters that this lives **here** and not
 * in `TaskPanel`'s own body: that component is rendered unconditionally by
 * `EventList`, so state written there would survive every close and every session
 * switch instead.
 *
 * ⚠ **No `aria-controls`.** The body is `{open && …}`, and an attribute pointing
 * at an id nothing renders names nothing — the defect `PanelBody` carries its own
 * ⚠ about one region up. `aria-expanded` alone, which is what the transcript's own
 * fold does.
 *
 * ⚠ **The `<h3>` is outside the `<button>`, not inside it.** A `<button>` takes
 * phrasing content only, and the heading element carrying the id is what makes
 * this `<section>` a named region at all — `PanelHeading`'s whole docblock is
 * about that. So this is `PanelHeading`'s type and role, reached through a control.
 *
 * ⚠ **The count is what this reader is shown, and the band stands at `(0)`.** The
 * clear hides rows; it does not destroy them, so `Completed` does not disappear
 * when somebody empties it — which is the owner's rule. It goes only when the
 * daemon's own rows go — a restart, the agent's `/clear`, an eviction at the cap —
 * and that is right: there is nothing left for it to be the record of.
 */
function FinishedSection({
  headingId,
  hidden,
  label,
  now,
  onClear,
  onStop,
  tasks,
}: {
  headingId: string;
  hidden: ReadonlySet<string>;
  label: string;
  now: number;
  onClear: (ids: readonly string[]) => void;
  onStop: ((task: BackgroundTask) => Promise<void>) | null;
  tasks: readonly BackgroundTask[];
}): ReactNode {
  const [open, setOpen] = useState(false);
  const shown = tasks.filter((task) => !hidden.has(task.id));
  /*
   * ⭐ **Nothing to show is a heading, not a fold**, and that is a repair rather
   * than a concession to the always-drawn band.
   *
   * It is already reachable without it: clear the list and `tasks.length > 0`
   * while `shown.length === 0`, so the control stayed pressable over an empty
   * body — verbatim the defect `EventList` names one file over, *a disclosure
   * whose body is empty is a control that lies about having something behind it*,
   * which is why the transcript's foot draws an inert paragraph in that state. The
   * never-backgrounded session reaches the same arm by the same test, so one
   * condition covers both.
   *
   * No clear control either: there is nothing to clear, and a trash beside a zero
   * is an act with no object.
   */
  if (shown.length === 0) {
    return (
      <section aria-labelledby={headingId} className="space-y-1.5">
        <PanelHeading count={0} id={headingId} label={label} tone={FINISHED_HEADING} />
      </section>
    );
  }
  return (
    <section aria-labelledby={headingId} className="space-y-1.5">
      {/* `gap-3` rather than the `gap-1.5` this panel's sections use: the control
          beside the fold is `sm`, 24px of ink carrying 10px of invisible target on
          every side, and the fold itself is a `flex-1` button. At any gap under
          12px that target lies on the fold's own face, which is the mis-tap pair
          `ICON_BUTTON_SIZE`'s docblock calls the classic one. */}
      <div className="flex items-center gap-3">
        <h3 className="min-w-0 flex-1" id={headingId}>
          {/* ⚠ **No `min-h`, so the band is exactly the height of its own words** —
              it carried `min-h-11` on the argument that this is the only way into
              the record and the panel is used from a phone. Reversed by the owner,
              and the app's own rule is on their side: the 44px floor here is
              scoped to controls that *answer an agent* — the ask, permission and
              elicitation cards, asserted on those three files — and
              `web-shell.md` says outright that a blanket version would be false,
              naming a `<summary>` and a link inside a sentence as things that are
              right not to reach it. A fold that reveals a list is one of those, and
              a mis-tap costs one tap. It also read wrong: 44px of band beside the
              24px of ink in the control next to it. The type is this band's own
              constant, never a colour composed onto the shared one. */}
          <button
            aria-expanded={open}
            className={`tap flex w-full items-center gap-1.5 rounded-md px-1 text-left hover:bg-raised ${FINISHED_HEADING}`}
            onClick={() => setOpen(!open)}
            type="button"
          >
            <span className={`shrink-0 transition-transform ${open ? "rotate-90" : ""}`}>
              <Icon as={ChevronRight} size={13} />
            </span>
            <span className="min-w-0 flex-1 truncate">
              {label} ({shown.length})
            </span>
          </button>
        </h3>
        {/* ⚠ **This destroys nothing on the machine.** The daemon has exactly one
            background-task route — stopping one — and no forget, no delete, no
            clear; it keeps every terminal row on purpose so this panel can answer
            *did that build finish*. Another tab still sees them, and so does this
            one after a reload. `finishedTasks.ts` carries the whole argument for
            why that is in memory rather than stored.

            Every finished id is handed up, not just the visible ones — that is the
            prune, and it is why the hidden set can never name a row the wire has
            already lost. */}
        <IconButton
          icon={Trash2}
          label="Clear the finished list"
          onClick={() => onClear(tasks.map((task) => task.id))}
          size="sm"
        />
      </div>
      {open && shown.map((task) => <TaskCard key={task.id} now={now} onStop={onStop} task={task} />)}
    </section>
  );
}

function PanelHeading({
  label,
  count,
  id,
  tone = SETTINGS_HEADING,
}: {
  label: string;
  count: number;
  id: string;
  /**
   * The whole class string rather than a colour to append.
   *
   * ⚠ **A tone cannot be composed onto one of the caps constants** — two members
   * of one family on one element are resolved by Tailwind's emission order, not by
   * the string — so the caller hands the finished band's own spelled-out idiom
   * instead. Defaulted, so every live section is unchanged.
   */
  tone?: string;
}): ReactNode {
  return (
    <h3 className={tone} id={id}>
      {label} ({count})
    </h3>
  );
}

/**
 * How often a running card's elapsed time is redrawn.
 *
 * ⚠ **The only clock-driven render in the transcript surface** — `MachineInstalls`
 * ticks one the same way for install progress, so this is not the app's only one —
 * and it is affordable only because it is scoped to a surface somebody opened:
 * `tail.ts`
 * refuses an elapsed time on a tool card on the grounds that "a ticking number
 * re-renders the whole transcript once a second", and that objection is about the
 * transcript rather than about seconds. Nothing outside this panel re-renders,
 * the interval is not installed while the panel is closed (the component is not
 * mounted), and it stops as soon as nothing here is running.
 *
 * ⚠ **"The one place" is a claim about a count, so it is called from exactly one
 * place**: `PanelBody`, once, with `now` handed down as a prop. Called from
 * `TaskCard` — which is where it was — the sentence above stayed true of the app
 * and became false of this panel, one timer per card and every one of them on its
 * own phase. See `PanelBody`.
 */
const TICK_MS = 1_000;

function useTick(running: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, [running]);
  return now;
}

/**
 * One task, as a card, and the card is a **typographic hierarchy** rather than a
 * run of facts at one size.
 *
 * ⚠ **That is the whole of what changed here, and it is the third of the owner
 * calls `docs/DECISIONS.md` Q3.603 records against the first version of this
 * panel** — cited rather than quoted, because the wording of the call itself is
 * not written down anywhere and this docblock is not the place to invent one. That
 * first version drew title, kind, duration, tokens and chip as one `text-2xs` line
 * joined by `·`, which is the shape of a transcript *row* — and a row is what this
 * deliberately is not. Four bands, top to bottom, each a step quieter than the one
 * above:
 *
 * 1. **the title**, the only thing here at `text-xs` and the only thing at full
 *    `fg`. Mono for a shell, because a backgrounded shell's title *is* its
 *    command line and this app draws a command in mono — and mono takes the step
 *    below, which `web-typography.md` states as a rule rather than a preference.
 *    ⚠ The ternary below tests the **kind**, not the string, and mono is its
 *    *fallback*: `workflow` and `monitor` are the two named sans arms and
 *    everything else — a shell, and any kind a later adapter sends — lands in
 *    mono. That is the same default `taskSections` files an unknown `taskType`
 *    under `Shells` by, for the same reason: the unnamed kind is a thing the
 *    agent ran.
 * 2. **what it is and how long**, `muted` for the kind and `faint` for the clock.
 * 3. **what the run cost**, the same split one more time: the *numbers* are
 *    `muted` and their nouns are `faint`, which is what makes a glance land on
 *    `429.7k` rather than on `tokens`. Absent entirely where the agent sent no
 *    `usage` — a quiet task has no numbers rather than zeroes.
 * 4. **what it said it was doing**, `faint`, and only where it is not a second
 *    copy of the title.
 *
 * No `·` between bands: the separator was doing the work a line break should.
 * The one `·` left is *inside* band 3, between two facts of one kind.
 *
 * What is absent is absent because it is not on the wire — see the ⚠ on
 * {@link TaskPanel} — and the two numbers that are there arrive only on a
 * progress frame, so a quiet task (a `sleep`, a build that calls nothing) carries
 * neither and band 3 simply does not exist.
 */
const TaskCard = memo(function TaskCard({
  task,
  now,
  onStop,
}: {
  task: BackgroundTask;
  /** The panel's clock — see {@link TICK_MS}. Unread once this card is finished. */
  now: number;
  onStop: ((task: BackgroundTask) => Promise<void>) | null;
}): ReactNode {
  const [stopping, setStopping] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  /*
   * A press is over when the daemon reports a new state for this task, not when the
   * request it sent comes back. See the ⚠ on the control below: the stop response
   * carries no transition, so resolving on it re-arms the button over work that is
   * still stopping. `task.state` is the one signal that means the daemon has
   * something new to say about it, and it covers both directions — terminal, where
   * `offerable` takes the control away, and the `stopped → running` correction,
   * where it has to come back.
   */
  useEffect(() => {
    setStopping(false);
  }, [task.state]);
  const finished = taskFinished(task.state);
  // `noUncheckedIndexedAccess` makes this `| undefined` even over a `Record` on a
  // closed union, and the fallback is the one that fails toward *live*: a state
  // this table has no row for is a state nobody has decided is over.
  const chip = TASK_CHIPS[task.state] ?? TASK_CHIPS.running;
  const offerable = onStop !== null && task.canStop && !finished;
  const title = taskTitle(task);
  const description = task.description === title ? null : task.description;
  const command = task.taskType !== "workflow" && task.taskType !== "monitor";
  return (
    /* `bg-raised/50`: **`web-shell.md` writes down two strengths** — `bg-raised`
       for the message you wrote, `bg-raised/50` for a plan, a wizard's panel and a
       well inside an expanded row — and a card on a panel is the second of those.
       It was `bg-raised/40`, which is a spelling that rule does not carry and which
       `grep -rn bg-raised packages/web/src` finds at no other call site. The reason
       that is worth a line is that nothing can see it: a strength that exists once
       is a palette that has quietly grown a step, and the next surface copies
       whichever one it happened to open.

       ⚠ **What this is not is a claim that the tree now spends exactly two.** The
       same grep still answers `bg-raised/60` at two call sites — `NewSession`'s row
       hover and the dimmed-in-place fill on a removed harness in
       `MachineAgentsSection`, which argues for it at the code. So the rule
       documents two, the tree spends three, and this change is one spelling brought
       back inside the rule rather than the last one outside it. Q3.205, Q3.206. */
    <div className="rounded-lg bg-raised/50 px-3 py-2.5">
      <div className="flex items-start gap-2">
        {/* `break-words` rather than `truncate`: a card is not a row, and a
            backgrounded shell's title *is* its command line — the one string on
            this surface where the part that would be cut is the part somebody is
            looking for. Two lines of command beat one line of `python3 -c "impo…`. */}
        <p
          className={`min-w-0 flex-1 break-words text-fg ${
            command ? "font-mono text-2xs" : "text-xs font-medium"
          }`}
        >
          {title}
          {stopping && !finished && <span className="text-faint"> · stopping…</span>}
        </p>
        {offerable && (
          <span className="-mt-1 -mr-1 shrink-0">
            <IconButton
              disabled={stopping}
              icon={Square}
              label={`Stop ${title}`}
              /*
               * ⚠ **`stopping` means "this press is in flight", and what ends it is
               * the task *moving* — never the response arriving.** Both halves of
               * that were wrong once, in opposite directions.
               *
               * It was first cleared only in the `.catch`, on the assumption that
               * a resolved promise means the task is over and the control is about
               * to disappear anyway. It does not:
               * `POST /sessions/:id/async-tasks/:taskId/stop` answers
               * `{stopped: false}` with a **200** for a task that finished on its
               * own between the tap and the request — the route says so in as many
               * words, and calls it the judgement `/cancel` makes for `no_turn` —
               * and neither that nor a `stopped: true` is a rejection. So the card
               * stayed `disabled` under `· stopping…` for the life of the
               * component.
               *
               * ⚠ **Clearing it on resolution instead is the other error, and it
               * is the worse one.** `ManagedSession.stopBackgroundTask` asks the
               * agent and mutates no task; `applyBackgroundTasks` is fed only from
               * the agent's own edges, and `acp/asynctasks.ts` says outright that
               * the transition arm is *"the only arm that can end one"*. So the
               * snapshot that comes back on the stop response still carries
               * `state: "running"` in the ordinary case — `· stopping…` vanishes
               * and the control comes back **enabled over work that is still being
               * stopped**. Somebody then taps again, and that is the accumulation
               * `withAbandonableDeadline` in `src/session.ts` exists to bound —
               * read its docblock rather than this one for the argument, which is
               * not restated here: a deadline settles *this* daemon's promise and
               * says nothing to the peer, so a tap against a wedged agent leaves a
               * request outstanding in the SDK, and nothing on this side gated a
               * second tap on the first one's silence. `disabled={stopping}` is
               * that gate, and a resolved promise is not permission to open it.
               *
               * What is permission is the daemon reporting a new `state` for this
               * task, which is the effect above: it covers the terminal case (the
               * control disappears with `offerable` anyway) and the
               * `stopped → running` correction the daemon explicitly supports,
               * where the control has to come back. An agent that acknowledges a
               * stop and then never transitions leaves the row saying
               * `· stopping…`, which is the honest description of what is known.
               */
              onClick={() => {
                setStopping(true);
                setFailure(null);
                void onStop(task)
                  .catch((cause: unknown) => {
                    // In the card rather than a toast: the card is what somebody
                    // pressed, and a toast would have to name the task again to be
                    // readable at all. `stopping` is cleared with it, so the control
                    // comes back rather than staying disabled under a failure.
                    setStopping(false);
                    setFailure(errorText(cause));
                  });
              }}
              size="sm"
            />
          </span>
        )}
      </div>
      <p className="mt-1 flex flex-wrap items-baseline gap-x-2 text-2xs">
        <span className="text-muted">{taskKindLabel(task.taskType)}</span>
        <span className="text-faint">{taskDuration(taskElapsedMs(task, now))}</span>
        <span className={chip[1]}>{chip[0]}</span>
      </p>
      {task.usage !== null && (
        <p className="mt-0.5 flex flex-wrap items-baseline gap-x-1 text-2xs text-faint">
          <span className="text-muted">{taskTokens(task.usage.totalTokens)}</span>
          <span>tokens</span>
          <span aria-hidden={true} className="px-1">
            ·
          </span>
          <span className="text-muted">{task.usage.toolUses}</span>
          {/* Claude Code's own noun for this figure, from its agent card:
              `N tool calls`. Not `tool uses`, which is the wire's word for it. */}
          <span>tool {task.usage.toolUses === 1 ? "call" : "calls"}</span>
        </p>
      )}
      {description !== null && description.length > 0 && (
        <p className="mt-2 text-2xs break-words text-faint">{description}</p>
      )}
      {task.taskType === "workflow" && <Phases running={!finished} />}
      {failure !== null && <p className="mt-2 text-2xs text-danger">Couldn&apos;t stop it: {failure}</p>}
    </div>
  );
});

/**
 * A workflow's phases — one of them, always, and never a fraction.
 *
 * Claude Code builds this list from `workflow_phase` progress events and falls
 * back to **one** synthetic phase titled `Agents` when a run reports none. That
 * fallback is the only case this app can ever be in: no phase, no agent and no
 * fraction crosses the AIR wire, so the list is one phase by construction rather
 * than by choice, and the title is theirs.
 *
 * The fraction is omitted rather than drawn as `0/0` — their own rule, at
 * `totalCount > 0 ? … : ""` — and nothing is written where their agent table
 * would be. An empty table under a heading would be a sentence about ten agents
 * that are running; a silence is the only honest thing this wire can say.
 */
function Phases({ running }: { running: boolean }): ReactNode {
  return (
    <div className="mt-3">
      {/* `Phases` is a heading over the box rather than a row inside it, which is
          the shape Claude Code draws and the reason the box below can be a box:
          a title inside its own frame would be a second card.

          ⚠ **And it is deliberately none of `web-typography.md`'s three caps
          constants, nor the caps idiom at all.** `SETTINGS_HEADING` and its two
          siblings are letter-spaced uppercase bands that head *a list of rows*;
          this heads a single framed box two levels down inside a card, where a
          caps band would read as a second card's header. What it takes instead is
          `text-2xs font-medium text-fg` — the same step as the `Agents` line
          inside the box, one weight and one tone louder, which is the whole of
          what makes it read as a label over the frame rather than a row in it.
          That is the same argument `SessionBrowser`'s waiting-elsewhere band makes
          about tone, reached from the other direction: there the type stays the
          caps idiom and only the colour moves. */}
      <p className="text-2xs font-medium text-fg">Phases</p>
      {/* The full-strength `raised`, which is the *other* documented step and the
          one that reads as a box inside the `bg-raised/50` card around it. It was
          `bg-raised/70`, a second undocumented strength in this one file. */}
      <div className="mt-1.5 rounded-md bg-raised px-2.5 py-2">
        <p className="text-2xs text-muted">Agents</p>
        <div className="mt-1.5">
          <Meter running={running} />
        </div>
      </div>
    </div>
  );
}

/**
 * Claude Code's four-cell meter, as four boxes rather than four braille glyphs.
 *
 * `⠿` is what a terminal has; a browser has a box it can paint, and a braille
 * codepoint's width and weight are whichever font the reader's phone fell back to.
 * The arithmetic is theirs exactly ({@link dotCells}), including the cap that
 * keeps one cell moving while anything runs, and `motion-reduce` stops it for the
 * reason their own `t_()` does.
 */
function Meter({ running }: { running: boolean }): ReactNode {
  return (
    <span aria-hidden={true} className="flex shrink-0 items-center gap-1">
      {dotCells(0, 0, running).map((cell, index) => (
        <span
          className={`size-1.5 rounded-full ${
            cell === "empty"
              ? "bg-edge-strong/40"
              : cell === "live"
                ? "animate-pulse bg-add-ink motion-reduce:animate-none"
                : "bg-add-ink"
          }`}
          key={index}
        />
      ))}
    </span>
  );
}
