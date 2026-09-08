import { ExternalLink } from "lucide-react";
import type { ReactNode } from "react";
import { machineOffer, type InstanceConfig } from "../instance";
import { machineOfferHref } from "../offer";
import type { Me } from "../wire";
import { Icon } from "./bits";

/**
 * Where to get a machine, when this instance says there is somewhere.
 *
 * **One renderer for all three screens, and it decides for itself whether to
 * draw.** Returning `null` on no offer is what makes "off by default draws
 * nothing" a property of one function rather than of three ternaries a reader has
 * to compare — `machineQuotaNotice`'s own structural argument, one screen over.
 *
 * **It takes the config and the person, never a ready-made href.** `quota.ts`'s
 * rule verbatim: a signature taking a string would make it natural for one call
 * site to build the URL its own way, and the escaping of somebody's address is
 * exactly the thing that must have one implementation.
 *
 * **It is drawn only inside the `mayAddMachine` arm, and that is not tidiness.**
 * A machine bought on the other side comes back here to enroll, which needs a
 * free slot: with the limit reached the dial is refused with a `403`. An offer in
 * the other arm would take money for a host this control plane will not connect
 * — and it would sit beside the sentence saying so, which makes "Add a machine" a
 * heading that lies while `machineQuotaNotice` stays literally `null`-iff-
 * `mayAddMachine`. `webcheck` asserts the placement from both sides.
 *
 * **A rule that says `Or`, and a filled control under it.** The two ways to get a
 * machine are alternatives, not a list, and the earlier shape — a second bordered
 * row stacked directly under the command — said "and then" rather than "or else".
 * The rule is `EventList`'s `context_cleared` idiom unchanged: a hairline each
 * side of a `text-2xs text-faint` word.
 *
 * **The one tinted control in the app** (`bg-offer`, argued at the token in
 * `index.css`). The label stays `text-fg` — the fill is tinted and the text is
 * not, which is the constraint the diff's colours are held to — so the button
 * reads identically in greyscale and the hue is emphasis rather than meaning.
 * Hover moves the border rather than the fill: with a tint carrying the identity,
 * swapping the fill to `raised` on hover would take the colour away at the moment
 * of the pointer being on it.
 *
 * Never `bg-fg`: that fill is the affirmative action *inside* a decision, and this
 * is a navigation off the origin. `ExternalLink` and not a chevron, for
 * `MarketEntry`'s reason — a chevron in this app promises a screen it is about to
 * push.
 *
 * Full width rather than centred-and-shrunk, because this renders in three boxes
 * of different widths — a 280px rail, a `max-w-lg` pane, and a left-aligned
 * settings section — and a control that fills its box needs no alignment rule
 * that has to be right in all three.
 *
 * **The rule is equidistant from the two things it separates, and that is why the
 * margins are equal and why the parent may not add to them.** `mt-4` above and
 * `mt-4` below is the whole of it — but `NothingSelected` draws its children in a
 * `gap-3` column, so an offer that is a *sibling* of the command there inherits
 * 12px on top of its own 16 and the rule sits visibly low. It is wrapped with the
 * command into one flex child instead, which is also the honest grouping: they are
 * two answers to one question.
 *
 * **No host under the button.** It was there on the argument that
 * `referrer-policy: no-referrer` means nothing else will ever name the
 * destination — true, and outweighed: it put a second line of small grey text
 * under a control whose own label already says what it does, in the one screen
 * whose job is to be read in a glance. A desktop browser still shows the target on
 * hover, which is what every other outbound link in this app relies on.
 */
export function MachineOffer({ config, me }: { config: InstanceConfig | null; me: Me | null }): ReactNode {
  const href = machineOfferHref(machineOffer(config), me);
  if (href === null) return null;
  return (
    <div className="mt-4">
      {/* `EventList`'s labelled-rule idiom, unchanged: two hairlines and a quiet
          word. It is what makes the two doors read as alternatives. */}
      <div className="flex items-center gap-2">
        <span className="h-px flex-1 bg-edge" />
        {/* Not `MENU_HEADING`, though it is nearly it: no `font-semibold` and no
            padding. This is not a heading — it is the word between two doors, and
            weight here would make it read as one. */}
        <span className="shrink-0 text-2xs tracking-wider text-faint uppercase">or</span>
        <span className="h-px flex-1 bg-edge" />
      </div>
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        className="tap press mt-4 flex min-h-11 items-center justify-center gap-2 rounded-lg border border-offer-ink/25 bg-offer px-3 hover:border-offer-ink/50"
      >
        <span className="truncate text-sm font-medium text-fg">Rent a machine</span>
        <Icon as={ExternalLink} size={14} className="text-offer-ink" />
      </a>
    </div>
  );
}
