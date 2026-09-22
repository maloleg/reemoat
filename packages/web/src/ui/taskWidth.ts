import { createPaneWidth } from "./paneWidth";

/**
 * How wide the background panel is, and the two numbers that bound a drag of it.
 *
 * `paneWidth.ts` is the mechanism and `rail.ts` is the other instance. What is
 * here is this pane's own four numbers and the one way it genuinely differs from
 * the rail.
 *
 * ⚠ **The declared widths are `index.css`'s, and these are the driver's copy of
 * them.** A Tailwind class only exists if it survives a scan of the source *as a
 * literal*, so the panel's width cannot be built from a number in TypeScript —
 * which is why it is `md:w-[var(--task-fit)]` and the two defaults are declared in
 * the stylesheet, where a breakpoint belongs. These constants exist so `webcheck`
 * can read the stylesheet and assert the two agree, which is the same pin
 * `--rail-w`/`RAIL_DEFAULT` carries and for the same measured reason: `19.5rem`
 * and `312` were asserted independently for a release, agreed only at a 16px root
 * font, and cost every reader on Chrome's Large setting a 78px snap on load.
 *
 * ⚠ **Two defaults and one draggable number, which is the whole of what this pane
 * asks that the rail does not.** The conversation's width is not monotonic in the
 * window's: at `lg` the rail arrives and takes `RAIL_DEFAULT`, so the 20rem panel
 * leaves 308px at 1024 — narrower than the 436px it leaves at 768 with no rail.
 * That is why the panel is 20rem where the row is shared and 26rem where there is
 * room for both, and why a single stored number could not simply replace them.
 * `paneWidth`'s `null` is what reconciles it: unset means *the stylesheet decides*
 * and both breakpoints stand; a stored number is written onto `documentElement`,
 * which beats both media blocks, so a reader who has dragged has one width at
 * every size the panel docks at. A double-click on the separator resets to `null`
 * and hands the breakpoints back.
 *
 * **A JavaScript clamp against the available width was refused**, and not on
 * taste: `webcheck` bans `matchMedia`, `innerWidth` and `clientWidth` in
 * `TaskPanel.tsx` by literal, because a panel that decides its own layout in
 * JavaScript is a second source of truth for a width CSS already knows.
 *
 * ⚠ **Which does not mean there is no clamp — it means the clamp is in CSS, and
 * these bounds are not the ones that bind.** {@link TASK_MAX} and `RAIL_MAX` are
 * independent and nothing bounds their sum: measured in a real browser at a 1024px
 * window with both panes dragged to their maxima, the conversation's content box
 * floored at **0px** and this card lay 52px over the session rail. `index.css`
 * derives `--task-fit` from these numbers *and the room there actually is*, and
 * that is what the panel and the gutter spend; what is here is the stored number
 * the separator writes, reads back and announces. So the honest statement of the
 * cost is the floor rather than a width: the conversation keeps 240px at every
 * size, and past that a drag stops widening the card rather than eating the text.
 */

/** 18rem at a 16px root. The panel still holds a task card: a title, a chip row, a meter. */
export const TASK_MIN = 288;
/** 32rem. Past this the conversation is paying for a list somebody opened to glance at. */
export const TASK_MAX = 512;
/** 20rem — what `index.css` declares from `md`, where the panel first docks. */
export const TASK_DEFAULT = 320;
/** 26rem — what it steps to at `xl`, where there is room for the rail and both panes. */
export const TASK_WIDE = 416;

export const taskPane = createPaneWidth({
  key: "reemoat.taskWidth",
  min: TASK_MIN,
  max: TASK_MAX,
  /*
   * ⚠ **`null`, which is the one field this pane sets differently from the rail.**
   * Two declared widths and a breakpoint between them means there is no single
   * number an unset panel is at — so unset has to mean *the stylesheet decides*,
   * and the separator's `aria-valuenow` is absent rather than announcing one of
   * the two arbitrarily.
   */
  unset: null,
  /*
   * The width the stylesheet declares at the breakpoint this pane first docks at —
   * so a hand-edited storage entry lands on what a reader who had never dragged
   * would have seen, rather than on the floor. It is **not** the unset state; that
   * is `null`, and only `reset()` produces it.
   */
  fallback: TASK_DEFAULT,
  prop: "--task-w",
});

/** The committed width, or `null` where the stylesheet's two answers still stand. */
export function taskWidth(): number | null {
  return taskPane.width();
}

export const subscribeTaskWidth = taskPane.subscribe;
