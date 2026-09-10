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
}: {
  doc: LegalDoc;
  /** Where the way out goes. `App` computes it once and Telegram's own back
   *  control is given the same value, so the two cannot disagree. */
  up: string | null;
  signedIn: boolean;
}): ReactNode {
  const text = legalDocument(doc);
  const others = LEGAL_DOCS.filter((other) => other !== doc);
  return (
    <div className="min-h-full">
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
              {legalUpLabel(signedIn)}
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
