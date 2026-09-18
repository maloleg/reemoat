import type { ReactNode } from "react";

import {
  LEGAL_DOCS,
  legalPath,
  legalTitle,
  legalUpLabel,
  type LegalBlock,
  type LegalCredit,
  type LegalDoc,
} from "../../legal";
import { legalDocument } from "../../legal/text";
import { navigate } from "../../router";
import { COLUMN, LINK, SETTINGS_SECTION } from "../bits";

/**
 * One of the three documents, drawn as a page rather than as a card.
 *
 * ⚠ **`COLUMN` and not `GateCard`.** These look like gate screens and are
 * deliberately not built like them: `GateCard` is `max-w-sm`, which is a measure
 * for four fields, and a policy set to it is a column about forty characters
 * wide. `COLUMN` is the only reading measure this app has and the transcript
 * already reads at it. Q3.598.
 *
 * **The body size is stated once, on the column, and the blocks carry rhythm
 * only.** That is the pair `webcheck.typography.ts` already asserts for the two
 * mono spans that inherit their line's step, and for the same reason: a size on
 * a container with no blocks under it passes trivially, and blocks with a size
 * each drift apart one edit at a time. The two *headings* are the exception and
 * say so where they are written: a heading has to be a step off the body to be
 * one at all, which is the whole of why this stopped borrowing the settings
 * eyebrow.
 *
 * **No markdown.** Rendering these through `Markdown` would put
 * `react-markdown`, `remark-gfm` and the `highlight.js` core back on the path
 * `App.tsx` measured down from 655.9 kB to 346.8 kB, to draw text with no code
 * fence in it — and that component demotes `h1` to `<h3>` because it exists for
 * untrusted agent output, so a document whose headings *are* its structure would
 * arrive two steps down.
 */
export function LegalScreen({
  doc,
  up,
  signedIn,
  upLabel,
}: {
  doc: LegalDoc;
  /** Where the way out goes, and never `null` from either caller — `App`
   *  computes it with `upFrom`, `GateApp` hands `HANDOFF_PATH` — because the
   *  footer draws its control only when this is a path, and `null` draws no way
   *  out. */
  up: string | null;
  /**
   * Which of the **app's** two roots the way out goes back to. Read only where
   * `upLabel` is absent, which is every caller inside the app.
   */
  signedIn: boolean;
  /**
   * ⚠ **What the way out is called, where the answer is not one of the app's
   * two.** `legalUpLabel` chooses between "Back to your machines" and "Back to
   * sign in", and both name screens that exist in **this** bundle. The gate is a
   * second bundle with a second root: it carries no sign-in form and no machine
   * list, so on `GateApp`'s copy of this screen the label said one thing and the
   * control went to another — at the foot of a document somebody was linked to
   * from the sign-up consent box, which is the one control that page has.
   *
   * A boolean cannot answer for three roots, so the caller outside the app hands
   * its own label over instead of being described to a function that cannot know
   * about it. `signedIn` keeps its meaning and its two answers for everybody
   * else, and `webcheck` keeps asserting both of them.
   */
  upLabel?: string;
}): ReactNode {
  const text = legalDocument(doc);
  const others = LEGAL_DOCS.filter((other) => other !== doc);
  return (
    /* `pt-safe`/`pb-safe` on the shell rather than on the column: without this the
       document's own `<h1>` sits under the notch and the way out sits under the
       home indicator. The chrome that first made that visible was Telegram's, which
       is gone — but the insets are the phone's own, and `GateApp` draws this screen
       in the bundle a mail client opens, so it is reached on a phone by design.
       `Header.tsx` states the rule and this screen draws no header of its own to
       inherit it from. Here and not one element down because the column states the
       body size, and `webcheck` reads that class string whole. */
    <div className="pt-safe pb-safe min-h-full">
      <div className={`${COLUMN} px-4 py-8 text-sm`}>
        <h1 className="text-xl font-semibold">{legalTitle(doc)}</h1>
        <p className="mt-1 text-xs text-muted">Effective {text.effective}</p>
        <p className="mt-4 text-muted">{text.lead}</p>

        {text.sections.map((section, index) => (
          <section key={section.id} id={section.id} className={index === 0 ? "mt-8" : SETTINGS_SECTION}>
            {/* Spelled out rather than composed onto `SETTINGS_HEADING`: that is
                the settings *eyebrow* — `text-2xs` and `text-muted` — which works
                above a row of controls and puts a document's structure two steps
                BELOW the 14px body it introduces. `Markdown.tsx` records fixing
                the identical inversion on this app's other long-prose surface,
                and appending to the constant would be a same-family Tailwind
                no-op (Q5.115). One step up from the body, at full contrast. */}
            <h2 className="text-base font-semibold text-fg">{section.heading}</h2>
            {section.blocks.map((block, position) => (
              <Block key={position} block={block} />
            ))}
          </section>
        ))}

        <footer className="mt-8 border-t border-edge pt-4">
          <p className="text-xs text-muted">
            {others.map((other, position) => (
              <span key={other}>
                {position > 0 ? " · " : ""}
                {/* `replace`, so reading all three does not leave a reading
                    history for the phone's own Back to walk. */}
                <button
                  type="button"
                  onClick={() => navigate(legalPath(other), true)}
                  className={`tap ${LINK}`}
                >
                  {legalTitle(other)}
                </button>
              </span>
            ))}
          </p>
          <Credits credits={text.credits} />
          {up !== null && (
            <button
              type="button"
              onClick={() => navigate(up, true)}
              className="tap mt-3 block text-xs text-muted hover:text-fg"
            >
              {upLabel ?? legalUpLabel(signedIn)}
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}

function Block({ block }: { block: LegalBlock }): ReactNode {
  switch (block.kind) {
    case "para":
      return <p className="mt-3">{block.text}</p>;
    case "list":
      return (
        // The transcript's own list treatment, so a list in a policy is the same
        // object as a list in an agent's answer. `space-y-1` rather than the
        // transcript's `space-y-0.5` on purpose: an item here is a sentence, not
        // a line of output, and the tighter rhythm reads as a wall.
        <ul className="mt-3 ml-4 list-disc space-y-1">
          {block.items.map((item) => (
            <li key={item} className="pl-0.5">
              {item}
            </li>
          ))}
        </ul>
      );
    case "ref":
      return (
        <p className="mt-3">
          {block.text}{" "}
          <button type="button" onClick={() => navigate(legalPath(block.doc), true)} className={`tap ${LINK}`}>
            {block.label}
          </button>
          .
        </p>
      );
    case "contact":
      return (
        <p className="mt-3">
          {block.text}{" "}
          <a href={`mailto:${block.email}`} className={LINK}>
            {block.email}
          </a>
          .
        </p>
      );
  }
}

/**
 * ⚠ **CC BY 4.0 asks for the credit where the work is read, so it is drawn here
 * rather than only filed in `THIRD-PARTY.md`.** The CC0-licensed source owes
 * nothing and is credited anyway; this note is why nobody should "tidy" that one
 * away as unnecessary — telling the two apart at a glance is exactly the mistake
 * that turns a courtesy into a breach.
 */
function Credits({ credits }: { credits: readonly LegalCredit[] }): ReactNode {
  return (
    <p className="mt-2 text-2xs text-muted">
      {credits.map((credit, position) => (
        <span key={credit.workUrl}>
          {position > 0 ? " " : ""}
          Adapted from the{" "}
          <a href={credit.workUrl} target="_blank" rel="noreferrer" className={LINK}>
            {credit.author} {credit.work}
          </a>{" "}
          under{" "}
          <a href={credit.licenceUrl} target="_blank" rel="noreferrer" className={LINK}>
            {credit.licence}
          </a>
          .
        </span>
      ))}
    </p>
  );
}
