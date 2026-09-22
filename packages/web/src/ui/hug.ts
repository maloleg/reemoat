/**
 * Sizing a message bubble to the text it ended up holding.
 *
 * **The problem is that CSS cannot do this and nothing in it ever could.**
 * `width: fit-content` resolves to `min(max-content, available)`, and for text
 * that *wraps* the max-content width is by definition larger than what is
 * available — so the box takes the available width and sits there, however far
 * short of it the longest line falls. A bubble whose longest line ends 31px
 * before its right padding is the ordinary case rather than the odd one.
 *
 * It was reported through the selection, which is where it was loudest: WebKit
 * filled a selection's line to the **block's content edge**, so those 31px
 * painted blue and read as "empty space is selected". Measured on one DOM in both
 * engines — Blink `22px@549w`, WebKit `20px@584w` — so the *rule* was the
 * engine's and not this app's (Q3.636).
 *
 * ⚠ **The selection half of that argument is gone and this module is not.** The
 * fill is `index.css`'s now, in one property: a block WebKit treats as a
 * selection root paints no gaps at all, so no width here decides anything the
 * selection can see. What is left is the 31px themselves — the box is wider than
 * its text with **nothing selected**, which is a grey box that does not fit its
 * sentence — and that is what this module removes. Read it as a typographic
 * decision now rather than a workaround; Q3.637 records the trade, and nothing
 * below it depends on how a selection is painted.
 *
 * ⚠ **This writes a layout value from JavaScript, which `AppShell` refuses by
 * name** — *"a resized window must not be able to render a layout that is not
 * there"*. The exception is deliberate and narrow, and it is written down at
 * Q3.637 rather than left here: there is no CSS for it, the cost is measured
 * (1.6ms for 300 bubbles, batched), and it **degrades to today's rendering** — a
 * bubble this never reaches keeps the width its `max-w-*` gives it, which is what
 * shipped before. Nothing here decides *which* layout is drawn; it trims one box
 * inside a layout CSS has already chosen.
 */

/**
 * The width a bubble should take, given the lines it drew and the chrome around
 * them.
 *
 * Pure, and exported for the reason every arithmetic in this app is: `webcheck`
 * has no DOM, so what it can hold is the sum — not the reading of it. The reads
 * are asserted as *placement*, off the source, beside this.
 *
 * `chrome` is the bubble's border box minus its content box, measured rather than
 * restated: `bubble.offsetWidth - inner.offsetWidth` with `inner` the content
 * wrapper. Taking it from `getComputedStyle` would be a second copy of `px-3.5`
 * that drifts the first time the padding is tuned.
 *
 * `null` when there is nothing to measure — an empty bubble, or a set of rects a
 * browser answered with zeroes because the element is not being drawn. A `null`
 * means *leave the box alone*, which is the state this module degrades to.
 */
export function hugWidth(lineWidths: readonly number[], chrome: number): number | null {
  let widest = 0;
  for (const width of lineWidths) if (width > widest) widest = width;
  // `<= 0` rather than `=== 0`: a display:none ancestor answers zero, and a
  // sub-pixel negative is not a width anybody should be writing to a style.
  if (widest <= 0) return null;
  if (!Number.isFinite(chrome) || chrome < 0) return null;
  /*
   * Rounded **up**. The rects are fractional and the box is `box-sizing:
   * border-box`, so a floor would set a width one sub-pixel under what the line
   * needs and the text would re-wrap — the box would then measure narrower on the
   * next pass, and narrower again, which is the runaway this rounding prevents.
   */
  return Math.ceil(widest) + chrome;
}

/**
 * Whether a bubble may be hugged at all.
 *
 * ⚠ **The guards are about children whose width is not their text's**, and both
 * are cases where hugging would clip something. An attachment chip and an image
 * preview are laid out to the box rather than to a line, so a bubble trimmed to
 * its sentence would cut them; and anything that scrolls horizontally — a code
 * fence, a table — reports the width it is *allowed*, not the width it wants, so
 * measuring it would feed the box its own cap back.
 *
 * Read off the element rather than passed in by the caller, because the caller is
 * a render that does not know what the markdown turned into.
 */
export function huggable(bubble: Element): boolean {
  if (bubble.querySelector("ul, img") !== null) return false;
  if (bubble.querySelector("pre, table") !== null) return false;
  return true;
}

/**
 * Every bubble currently on screen, and the one observer watching all of them.
 *
 * ⚠ **One `ResizeObserver` for the whole transcript, not one per message.** A
 * conversation here is drawn whole — `MAX_TRANSCRIPT_BYTES` is the only ceiling
 * and there is no render window — so "one per message" is hundreds of observers
 * on a screen. A single instance takes many targets, which is what this uses:
 * each bubble's **row** is observed, because the row is full-column-width and
 * therefore resizes exactly when the column does. That is what makes this work
 * while somebody drags the rail, without this module having to find the column or
 * know that a rail exists.
 */
const registered = new Set<HTMLElement>();
let observer: ResizeObserver | null = null;
let scheduled = 0;

/**
 * Reset every bubble, then read every bubble, then write every bubble.
 *
 * ⚠ **The three passes are the whole performance story and the order is not a
 * preference.** Interleaving them — read this bubble, write it, read the next —
 * forces a layout between every pair, which is layout thrashing. Measured on 300
 * bubbles, the same code both ways: **1.6ms** batched against **25.7ms**
 * interleaved, sixteen times the cost for the same answer. After a width change it
 * is 3.1ms against 29.5ms, and a pass where nothing moved is 0.8ms. The frame
 * budget is 16.7ms, which is what makes this affordable while somebody drags the
 * rail rather than only at rest.
 *
 * The reset is not optional either, and it is the second half of the same
 * argument. A bubble already carrying a width from the last pass would be
 * measured *at that width*, so its text would re-wrap inside it and the next
 * answer would be narrower again — a box that walks itself down to one word.
 * Clearing first puts every box back on the width its `max-w-*` gives it, which
 * is the only width the measurement means anything at.
 */
function reflow(): void {
  scheduled = 0;
  const boxes: { bubble: HTMLElement; inner: HTMLElement }[] = [];
  for (const bubble of registered) {
    const inner = bubble.firstElementChild;
    if (!(inner instanceof HTMLElement)) continue;
    if (!huggable(bubble)) continue;
    bubble.style.width = "";
    boxes.push({ bubble, inner });
  }
  const widths = boxes.map(({ bubble, inner }) => hugWidth(lineWidths(inner), bubble.offsetWidth - inner.offsetWidth));
  boxes.forEach(({ bubble }, i) => {
    const width = widths[i];
    if (width !== null && width !== undefined) bubble.style.width = `${width}px`;
  });
}

/**
 * Every line the text drew, and nothing else.
 *
 * ⚠ **Measured per *text node*, never as one range over the wrapper**, and the
 * difference is the whole measurement. `Range.getClientRects()` answers a rect
 * for each **element** in the range as well as for each line box, so selecting
 * the wrapper's contents returns the wrapper's own border box first — `584x44`
 * beside the `545x17` and `40x17` that are the actual lines. Taking the widest of
 * that set hands the box back its own width, which is the number this module
 * exists to replace: measured, it wrote 612 and nothing moved. A walk over text
 * nodes cannot pick up an element box, whatever the markdown turned into.
 */
function lineWidths(inner: Element): number[] {
  const lines: number[] = [];
  const walker = document.createTreeWalker(inner, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const range = document.createRange();
    range.selectNodeContents(node);
    for (const rect of range.getClientRects()) lines.push(rect.width);
  }
  return lines;
}

/** Coalesced to one pass a frame, however many rows reported a resize. */
function schedule(): void {
  if (scheduled !== 0) return;
  scheduled = requestAnimationFrame(reflow);
}

/**
 * Take a bubble under measurement, and give back the undo.
 *
 * Called from a layout effect so the first pass runs before paint — a bubble that
 * appeared at `max-w` and snapped narrower one frame later would be a flicker on
 * every message.
 */
export function hugBubble(bubble: HTMLElement): () => void {
  const row = bubble.parentElement;
  registered.add(bubble);
  if (typeof ResizeObserver !== "undefined") {
    observer ??= new ResizeObserver(schedule);
    if (row !== null) observer.observe(row);
  }
  reflow();
  return () => {
    registered.delete(bubble);
    if (row !== null) observer?.unobserve(row);
    bubble.style.width = "";
  };
}
