import { createPaneWidth } from "./paneWidth";

/**
 * How wide the rail is, and the two numbers that stop it being useless.
 *
 * ⚠ **The mechanism is `paneWidth.ts` now** — the storage, the clamp, the
 * subscriber set and every paragraph arguing for each of them — because the
 * background panel became draggable and wanted the same thing. What stays here is
 * this pane's four numbers and its four names, and the names are deliberate rather
 * than incidental: `webcheck` drives `clampRailWidth`, `railWidth`, `setRailWidth`
 * and `subscribeRail` by name **and behaviourally**, so keeping them turned an
 * extraction into four lines instead of a rewrite of nine assertions that are about
 * the rail rather than about where the code lives.
 *
 * Holds no DOM, which is `paneWidth.ts`'s ⚠ and the reason `webcheck` can import
 * this at all. `AppShell` is the impure shell that writes `--rail-w`.
 */

/**
 * The bounds, and they are a usability floor rather than a guess.
 *
 * Below `RAIL_MIN` the rail stops being able to say what it is for: a session row
 * is a status dot, a title, a relative time and a kebab, and the title is the only
 * one that can give — at 240px it still shows enough of a name to tell two
 * sessions apart, and under that it is eliding at the tenth character. Above
 * `RAIL_MAX` the cost lands on the transcript instead, which is the thing being
 * read; past ~480px the list is mostly whitespace and the conversation is paying
 * for it.
 *
 * ⚠ **All three are written as arithmetic now, because the rail is two columns.**
 * `MACHINE_COLUMN_PX` is the machine folders on the left; every bound above is that
 * plus the number it used to be, so the three sentences either side of this one are
 * unchanged claims **about the list** rather than about the rail. `webcheck` asserts
 * the subtraction — `RAIL_MIN - MACHINE_COLUMN_PX === 240` and its two siblings —
 * which pins the same three numbers the old literals did and additionally pins that
 * the column was added exactly once to each.
 *
 * It is also the whole migration. A `reemoat.railWidth` written before the column
 * existed meant *the list*, and nothing can tell such a value from one written after
 * — but every path reads it through `clampRailWidth`, so anything under the new
 * floor comes up to it and anything above keeps the total width it had, with the
 * list 72px narrower than the reader left it. A rail that is a little tight is a
 * drag away from right; a storage key bumped to avoid that would have thrown the
 * preference away instead, for everybody, to fix it for nobody.
 *
 * `RAIL_DEFAULT` is the column plus 312px — the width the *list* shipped at, so an
 * install that never touches the handle draws the same list it always did with the
 * folders added beside it. Written in px and
 * **not** as the `19.5rem` it replaced: `index.css` declares the same number and
 * `AppShell` writes px, and the two spellings agreeing only at a 16px root font is
 * a defect that file now records at length.
 *
 * All three are **device pixels and do not scale with the reader's type**, which
 * makes the sentence above about 240px a claim about a 16px root: at a larger one
 * the rows get taller and the titles wider while the floor stays 240, so the
 * elision this bound exists to prevent starts earlier. Accepted rather than
 * missed — a drag produces device pixels, and a floor is something somebody can
 * always drag away from — but it is the first thing to revisit if the rail is ever
 * reported as too tight, rather than moving the number for everybody.
 */
export const MACHINE_COLUMN_PX = 72;
export const RAIL_MIN = MACHINE_COLUMN_PX + 240;
export const RAIL_MAX = MACHINE_COLUMN_PX + 480;
export const RAIL_DEFAULT = MACHINE_COLUMN_PX + 312;

/**
 * ⚠ **`RAIL_DEFAULT` is both the default and the clamp's answer for a value that
 * is not a number, and the rail is allowed to conflate them where the background
 * panel is not.** That one has two declared widths and a breakpoint between them,
 * so `paneWidth`'s `null` means *the stylesheet decides*; this one has a single
 * width at every size, so an unset rail and a rail at its default are the same
 * rail. `railWidth()` therefore answers a number, never `null`, and every caller —
 * `AppShell`'s effect, `webcheck`, the separator's `aria-valuenow` — keeps the type
 * it always had.
 */
const rail = createPaneWidth({
  key: "reemoat.railWidth",
  min: RAIL_MIN,
  max: RAIL_MAX,
  unset: RAIL_DEFAULT,
  fallback: RAIL_DEFAULT,
  prop: "--rail-w",
});

/** The pane itself, for `PaneHandle`, which takes one of these rather than a shape. */
export { rail };

/** @see PaneWidth.clamp — four ways in, one bound, and `NaN` is one of the cases. */
export const clampRailWidth = rail.clamp;

/** The committed width. `useSyncExternalStore` compares it by `Object.is`. */
export function railWidth(): number {
  return rail.width() ?? RAIL_DEFAULT;
}

export const setRailWidth = rail.setWidth;
export const subscribeRail = rail.subscribe;
