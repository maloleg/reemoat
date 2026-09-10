import { Download, Paperclip } from "lucide-react";
import type { ReactNode } from "react";
import { formatBytes } from "../paths";
import { previewable } from "../preview";
import type { PromptAttachmentRef } from "../wire";
import type { FileAccess } from "./files";
import { ImagePreview } from "./ImagePreview";
import { Markdown } from "./Markdown";
import { Icon } from "./bits";

/**
 * What the person said, drawn the way a messenger draws it.
 *
 * There were three of these and they looked like three different things: the
 * `prompt` event was a full-width bordered card, an agent-echoed `role: "user"`
 * text run was bare accent-coloured markdown with no container at all, and the
 * composer's optimistic echo was a third card with its own border and opacity. The
 * same sentence therefore rendered differently depending on which path it arrived
 * by — and none of the three was distinguishable at a glance from the agent's own
 * output, which on a phone is the entire reading problem.
 *
 * One component, four call sites, so they cannot drift again. The fourth is the
 * `/clear` a `context_cleared` marker stands for — the same bubble, drawn from the
 * marker because the prompt that caused it is one seq below the cut.
 *
 * **There is no `pending` any more, and its removal is the point rather than a
 * tidy-up.** A message on its way carried a spinner and the word `sending`, drawn
 * under the transcript by the composer — so a message you had just sent was marked
 * as not-quite-sent for as long as a resume took, and then moved. Nothing is
 * claimed about delivery now: the bubble is the same bubble in the same place
 * whichever side of the round trip it is on. What a refusal costs is unchanged and
 * is a *remedy* rather than a warning — the text goes back into the box, the chips
 * come back with it, and a toast says why.
 *
 * **Agent text stays full-bleed and left**, deliberately. The asymmetry is what
 * makes a conversation readable; bubbling the agent's side too would halve the
 * width of the thing people are actually here to read.
 */
export function UserBubble({
  text,
  attachments = [],
  files = null,
}: {
  text: string;
  attachments?: readonly PromptAttachmentRef[];
  files?: FileAccess | null;
}): ReactNode {
  if (text.trim().length === 0 && attachments.length === 0) return null;
  return (
    /*
     * **Room above and below, and it belongs here rather than on the run.**
     *
     * The transcript's rhythm is `space-y-1.5` — 6px, which is right between two
     * steps of one turn and far too tight around a turn *boundary*. Your message
     * and the reply to it were 6px apart, so a conversation read as one column of
     * text with the sides alternating rather than as an exchange.
     *
     * `my-4` on the bubble's own row, symmetric, because the boundary is on both
     * sides of it: what comes before is the end of the agent's last turn and what
     * comes after is the beginning of the next. Margins collapse with nothing here
     * (`space-y-*` is a margin on the sibling, and adjacent margins in a
     * block-level run take the larger), so consecutive messages do not accumulate
     * gaps. It is on the *wrapper* rather than on the filled box so the bubble's
     * own shape is untouched — which matters because all three call sites share
     * that box and only this one is a turn boundary.
     */
    <div className="my-4 flex justify-end">
      <div
        /*
         * `w-fit` + `ml-auto` is what makes it hug its content instead of spanning
         * the column; `max-w-*` is what stops a paragraph running the full width of
         * a desktop pane. Both in CSS, with no breakpoint state in JavaScript —
         * `AppShell` is explicit that a resized window must not be able to render a
         * layout that is not there.
         *
         * `min-w-0` is load-bearing rather than defensive. `Markdown`'s table
         * wrapper and its code blocks scroll with `overflow-x-auto`, and an
         * overflow container can only scroll if its flex ancestor is allowed to
         * shrink below its content. Without this a long line inside a user bubble
         * widens the transcript column and pushes the rail off the screen — the
         * exact failure `AppShell` documents `min-w-0` for.
         *
         * **A shape rather than a fill, and the cap before all of these did not
         * cap at all.** It was `46rem` against a `COLUMN` of 48rem. ⚠ That reads
         * as 96% and this docblock called it 96% *of the measure*, which is the
         * column-versus-content-box slip the last paragraph here warns about,
         * committed two paragraphs above the warning: 96% is its share of the
         * **column**, and once the transcript's fixed 32px of `px-4` comes off,
         * 46rem is 736px against a 736px measure — **100%**. "Never capped" was
         * literal. Being visibly short of the measure is what makes "you said
         * this" readable at a glance from the *outline*, before any colour is
         * involved, which is the whole job of the asymmetry this component exists
         * for.
         *
         * ⚠ **`26rem` — 416px — read off a reference as a *ratio*, and it is not a
         * fraction of `COLUMN`.** For one pass the two moved by a single factor
         * and the cap held at exactly three quarters of the column, and two
         * docblocks leaned on that as though it were a rule; it was arithmetic,
         * and it is gone. Both numbers are now set against a screenshot of another
         * product's conversation, in which the message was **60.6% of the text
         * measure**. Against this 688px measure that is 416px. **Neither number
         * derives from the other**, nothing in the build or the drivers relates
         * them, and this docblock is the only place the pair is written down
         * together.
         *
         * ⚠ **A ratio, because the absolute pixels off a screenshot are not
         * transferable — and that is not caution, it is what went wrong.** The
         * first attempt at this took the reference's 927px measure literally,
         * inferred the capture was 1:1 from its line spacing, and set a 60rem
         * column. It landed within a pixel of the number and looked nothing like
         * the reference, because the two captures were at different zoom: measured
         * on the result, the column filled **76%** of its pane where the reference
         * fills **56.9%**. What survives a change of scale is the fraction of the
         * pane and the ratio inside it; a pixel count does not. The column was
         * refitted to 45rem on the first of those and this cap to the second, and
         * the pane fraction came out at 57.0%.
         *
         * ⚠ **The reference bubble was `w-fit` and fitted on one line, so its
         * 60.6% is a *lower bound* on what that product caps at, not its cap.**
         * What is matched is a ratio one sample supports; if messages here start
         * wrapping visibly earlier than they do there, this number is the one that
         * is wrong, not the column.
         *
         * A `rem` cap rather than the `%` it sits beside. ⚠ **The reason given
         * here for years — that the three call sites are inset differently, `px-4`
         * in the transcript against `px-3` for the composer's echo — is stale.**
         * `UserBubble` is imported by `EventList` alone and rendered at three
         * places inside it, all within the one `${COLUMN} px-4` container; the
         * echo moved into the transcript and `Composer` draws no bubble at all. So
         * all three share one inset and a percentage would render the same sentence
         * at one width. What a `rem` still buys is a cap that does **not** ride the
         * column — which is the whole reason the two numbers can be tuned
         * independently at all.
         *
         * The `85%` survives only below `lg`, where hugging the screen edge is
         * what is wanted, and it is left alone on every pass for that reason.
         *
         * ⚠ **The band where `85%` is what binds has a moving lower edge, and it
         * is `COLUMN`'s own width rather than a breakpoint** — which is why no
         * class here names it. It is 720px today, and has been 960, ~699, 653 and
         * 768 across the passes; a docblock that hard-codes one of those is stale
         * the next time the column is tuned, which has already happened to this
         * paragraph. The upper edge is `lg`, 1024px, and that one is fixed. So the
         * band is 304px of viewport wide.
         *
         * Below 720px the column's cap does not bind, so a phone is untouched by
         * any of this, as it has been by every pass.
         *
         * Inside the band `85%` gives 584.8px and the cap gives 416px, so crossing
         * `lg` upward still **narrows** the bubble. That direction is the property
         * worth keeping rather than the size of the step: it has never widened
         * here, and a percentage low enough to reverse it would be the one change
         * on this line that reads as a bug.
         *
         * ⚠ **A percentage resolves against the parent's *content* box, not the
         * column.** The transcript's `px-4` takes a fixed 32px off before `85%`
         * sees it, and those 32px do not scale with the column — so a 720px column
         * is a 688px measure, and every figure above is against the one the number
         * is actually read from. Subtracting a constant also makes the measure's
         * *relative* move the larger one in **either** direction: on earlier passes
         * it grew 7.37% where the column grew 7.01%, and shrank 15.65% where the
         * column shrank 15.00%. Written down because the obvious arithmetic
         * (0.85 × the column) is wrong by ~30px and has been caught in this
         * docblock twice.
         */
        className="ml-auto w-fit min-w-0 max-w-[85%] rounded-xl rounded-br-md bg-raised px-3.5 py-2.5 lg:max-w-[26rem]"
      >
        {/*
         * The event's own string, passed through untouched.
         *
         * `Markdown` is memoised on `text`, and a run in flight is reparsed on
         * every arriving chunk — so building the string here (interpolating a
         * status, appending a space, joining anything) would defeat that memo on
         * every render. Whatever this needs to show *about* the message goes
         * outside the memoised child, as `pending` does below.
         */}
        <Markdown text={text} tone="user" />
        {/*
         * Chips, and they go **here** rather than into `text`.
         *
         * The docblock above is not decorative: appending a filename or a
         * `![](blob:…)` to the string would defeat `Markdown`'s memo on every
         * render *and* route a URL through the markdown renderer, which is the
         * one place this client deliberately keeps untrusted input away from.
         *
         * A preview goes above the chip rather than instead of it, so a picture
         * that will not load still leaves a name and a download button. The
         * decision is `previewable` and the drawing is `ImagePreview`; the rules
         * both of them keep — the four-type allowlist excluding `image/svg+xml`,
         * bytes via `fetch` with the header and never a URL in the DOM, `<img>`
         * and nothing else — live in those two modules rather than here.
         */}
        {attachments.length > 0 && (
          <ul className="mt-1.5 space-y-1">
            {attachments.map((ref) => (
              <li key={ref.uploadId} className="space-y-1">
                {/* Drawn only for the four raster types under the preview cap —
                    and the size is known here without fetching anything, because
                    the daemon put `mime` and `bytes` on the event. That is what
                    makes a preview of somebody's own attachment free of the
                    "fetch it to find out how big it is" problem. */}
                {files !== null && previewable(ref.mime, ref.bytes) && (
                  <ImagePreview
                    cacheKey={`u:${ref.uploadId}`}
                    fetcher={() => files.fetchUpload(ref.uploadId)}
                    alt={ref.name}
                  />
                )}
              <div
                className="flex items-center gap-1.5 rounded-md border border-edge/60 bg-surface/60 px-2 py-1 text-2xs"
              >
                <Icon as={Paperclip} size={11} className="shrink-0 text-faint" />
                <span className="min-w-0 flex-1 truncate font-mono">{ref.name}</span>
                <span className="shrink-0 text-faint">{formatBytes(ref.bytes)}</span>
                {files !== null && (
                  <button
                    type="button"
                    aria-label={`Download ${ref.name}`}
                    title={`Download ${ref.name}`}
                    onClick={() => void files.downloadUpload(ref.uploadId, ref.name)}
                    className="tap shrink-0 rounded p-0.5 text-faint hover:text-fg"
                  >
                    <Icon as={Download} size={11} />
                  </button>
                )}
              </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
