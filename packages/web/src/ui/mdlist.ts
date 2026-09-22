/**
 * What an ordered list was written with, kept as far as the DOM.
 *
 * Its own module rather than a block inside `Markdown.tsx` for one reason:
 * `webcheck` imports it. `Markdown.tsx` cannot be imported by anything offline —
 * it reaches react-markdown, `highlight.js` and a `useFileAccess` context — so a
 * plugin living there would be asserted only by reading the file as text, which
 * is what this repo does when it has no better option and not when it has one.
 */

/**
 * The class an ordered list wears when it was written with `)` rather than `.`.
 *
 * Not a Tailwind utility — the rule that reads it is in `index.css`, unlayered,
 * beside the other opt-in ones.
 */
export const PAREN_LIST = "md-paren";

/**
 * The shape this file needs from mdast, hand-written.
 *
 * `@types/mdast` is a transitive dependency of react-markdown and is **not
 * resolvable from `packages/web`** — neither is `unist-util-visit`, which is why
 * the walk below is four lines rather than an import. Adding either to make one
 * plugin typed would put a parser's whole type surface into this package's
 * manifest for a field mdast does not even carry.
 */
interface ListNode {
  type?: string;
  ordered?: boolean;
  spread?: boolean;
  position?: { start?: { offset?: number } };
  data?: { hProperties?: Record<string, unknown> };
  children?: unknown[];
}

/**
 * An ordered list keeps the delimiter somebody typed.
 *
 * `1)` and `1.` are both CommonMark — micromark's `list.js` tests for codepoint
 * 41 *or* 46 on the same line — but **mdast records neither**: a `list` node
 * carries `ordered`, `start` and `spread`, and the character is gone by the time
 * anything downstream could read it. So `list-style-type: decimal` drew `1.` over
 * a message that said `1)`, which is this app putting words in somebody's mouth
 * about the one text it has no business rewriting.
 *
 * The delimiter is still in the **source**, and a remark plugin is the last place
 * that holds both halves: `file.value`, and the node's own
 * `position.start.offset`. Measured against this repo's own remark-parse 11 — the
 * offset points at the digit and never at the indentation before it, so the
 * pattern needs no leading `\s*`. Nine digits because that is CommonMark's own
 * ceiling on a list number.
 *
 * It marks and never rewrites. What it sets is one class; `index.css` draws the
 * marker from it, and a browser that cannot style `::marker` still gets `1.` —
 * which is exactly what it drew before this existed, so the degradation is a
 * no-op rather than a fallback anybody has to look at.
 *
 * `unknown` on both parameters is deliberate. A transformer is contravariant in
 * them, so anything narrower than the tree type unified declares would fail at
 * the `remarkPlugins` array instead of here, where the narrowing is.
 */
export function remarkListDelimiter() {
  return (tree: unknown, file: unknown): undefined => {
    const held = (file as { value?: unknown } | null)?.value;
    const source = typeof held === "string" ? held : String(file);
    const visit = (value: unknown): void => {
      if (typeof value !== "object" || value === null) return;
      const node = value as ListNode;
      if (node.type === "list" && node.ordered === true) {
        const at = node.position?.start?.offset;
        if (typeof at === "number" && /^\d{1,9}\)/.test(source.slice(at, at + 12))) {
          node.data ??= {};
          node.data.hProperties = { ...node.data.hProperties, className: [PAREN_LIST] };
        }
      }
      if (Array.isArray(node.children)) for (const child of node.children) visit(child);
    };
    visit(tree);
    return undefined;
  };
}

/**
 * A person's own message keeps the line breaks they typed.
 *
 * In CommonMark a single newline is a **soft** break: remark leaves it in the
 * paragraph's text and `white-space: normal` collapses it to a space, so a
 * message written on two lines was drawn on one. Reported as *"the line break is
 * erased on send"*, and it is not — the composer trims only the ends, the daemon
 * appends the string verbatim, and a real `prompt` row in `~/.reemoat/reemoat.db`
 * still carries its newlines. The loss is entirely at the parse. Measured in
 * WKWebView on the shipped bubble DOM: `"a\nb"` draws one 22px line box whose
 * `innerText` is `"a b"`.
 *
 * ⚠ **Applied to the user's tone only.** An agent writes CommonMark and is
 * entitled to it; turning its soft wraps into hard breaks would rewrite prose
 * this app has no business rewriting. That is the same rule
 * {@link remarkListDelimiter} exists for, one node type over. ⚠ It does reach
 * text an *adapter* emitted — `session.ts` maps ACP's `user_message_chunk` to
 * `role: "user"` and `EventList` draws it in this same bubble — but that is the
 * person's own sentence relayed back, and the two are required to look alike.
 *
 * ⚠ **A `break` node, and never `white-space: pre-wrap`.** The CSS looks cheaper
 * and is wrong: `mdast-util-to-hast` writes a `\n` text node after every `<br>`,
 * so a *hard* break — what somebody who typed a space before Enter produces —
 * draws as two. Measured in the same rig, same page: pre-wrap gave a 66px box
 * reading `"a\n\nb"` where this gives 44px and `"a\nb"`.
 *
 * Fences and backticks are never reached: mdast's `code` and `inlineCode` carry a
 * `value` and no `children`, so the walk below cannot enter them. A newline
 * *inside* backticks therefore still renders as a space, which is CommonMark's
 * own behaviour and is left alone.
 */
export function remarkHardBreaks(): (tree: unknown) => undefined {
  const visit = (value: unknown): void => {
    if (typeof value !== "object" || value === null) return;
    const node = value as ListNode;
    if (!Array.isArray(node.children)) return;
    let split = false;
    const out: unknown[] = [];
    for (const child of node.children) {
      const text = child as { type?: string; value?: string } | null;
      if (text?.type === "text" && typeof text.value === "string" && text.value.includes("\n")) {
        split = true;
        /*
         * The blanks around the newline go with it. That is what a hard break
         * already does, and keeping them would draw a stray space at the end of
         * the line. `\r` is in the class as a free belt: a `textarea`'s value is
         * LF-normalised by the HTML spec so it cannot arrive from this composer,
         * but remark does not normalise CRLF and a stray `\r` would otherwise
         * ride along.
         */
        const parts = text.value.split(/[\t \r]*\n[\t \r]*/);
        parts.forEach((part, index) => {
          if (index > 0) out.push({ type: "break" });
          if (part.length > 0) out.push({ type: "text", value: part });
        });
      } else {
        visit(child);
        out.push(child);
      }
    }
    /*
     * ⚠ **Assigned only when something split.** Rewriting `children` on every
     * node would hand every parse a fresh array for no reason — and it would make
     * the driver's identity assertion untestable, since the honest claim is that
     * a text with no newline in it comes through *as the same node*.
     */
    if (split) node.children = out;
  };
  return (tree: unknown): undefined => {
    visit(tree);
    return undefined;
  };
}

/**
 * A list item that mixes a sentence with a block underneath it gets a real box
 * for the sentence.
 *
 * ⚠ **This is a *selection* fix and it renders nothing new.** `index.css` makes
 * every markdown body a WebKit selection root, which stops the engine painting
 * the run from the end of a selected line to the block's content edge. It cannot
 * reach one box, because that box has no element: `mdast-util-to-hast` unwraps a
 * tight item's paragraph, so `- третий` followed by a nested list renders as
 * `<li>третий<ul>…</ul></li>` and the engine wraps `третий` in an **anonymous**
 * block. Nothing selects an anonymous block, so nothing can put a property on it
 * — measured, all six of `transform`, `overflow`, `contain`, `flow-root`,
 * `display: inline-block` and `display: table` on the `li` left that one line
 * painting `22px@530w` where its text is 67px wide.
 *
 * `spread` is the handle the parser already has. Setting it puts the paragraph
 * back, and a paragraph is a real box: the same line then paints `20px@67w`.
 *
 * ⚠ **It costs no pixels, and that is measured rather than reasoned.**
 * `mdast-util-to-hast` reads looseness off the *list* — its `listLoose` is true
 * if any item is spread — so marking one item wraps every sibling's text in a
 * `<p>` as well. That is what makes this safe to do at all: `COMPONENTS.p` is
 * `my-1.5 first:mt-0 last:mb-0`, and a lone paragraph in a list item is both
 * first and last, so it carries no margin; where the item also holds a nested
 * list the paragraph's 6px bottom margin collapses with the list's own 6px top
 * one and the gap is the 6px it already was. Two WKWebView snapshots of a page
 * holding a tight list, a nested list and an ordered list, rendered both ways,
 * compare **byte for byte**.
 *
 * Both tones. An agent writes far more lists than a person does, and the shape
 * this is about — a bullet with sub-bullets — is the one it writes most.
 */
export function remarkListItemBlocks(): (tree: unknown) => undefined {
  const visit = (value: unknown): void => {
    if (typeof value !== "object" || value === null) return;
    const node = value as ListNode;
    if (!Array.isArray(node.children)) return;
    if (node.type === "listItem") {
      let sentence = false;
      let block = false;
      for (const child of node.children) {
        const kind = (child as { type?: string } | null)?.type;
        if (kind === "paragraph") sentence = true;
        else if (kind !== undefined) block = true;
      }
      /*
       * Both halves, and the `block` half is what keeps this off a list nobody
       * reported. An item that is only a sentence has no anonymous box to give an
       * element to, and an item that is only blocks has no sentence.
       */
      if (sentence && block) node.spread = true;
    }
    for (const child of node.children) visit(child);
  };
  return (tree: unknown): undefined => {
    visit(tree);
    return undefined;
  };
}
