// Where somebody with no machine is pointed, as a link with their address in it.
//
// **A fourth small pure module, because this is a function of the instance *and*
// of the person, and the three that already exist each own one half.**
// `instance.ts` holds statements about the instance; `quota.ts` was split out of
// it precisely because "what may this person do" is a different question;
// `enrollment.ts`'s whole subject is shell quoting, and dragging an email address
// into it would make its one theme two. This one takes both and belongs to
// neither, which is the case none of them covers.
//
// Pure, so `webcheck` drives every row of it with no DOM.

import type { Me } from "./wire";

/**
 * The offer's address with this person's email already in it, or `null`.
 *
 * **`new URL` and `searchParams`, never string concatenation, and
 * `encodeURIComponent` is not used here at all.** The base is operator-supplied:
 * it may carry a path, a trailing slash, an existing query or a fragment, and
 * concatenation gets each of the four wrong differently. Measured on Node 24:
 * `` `${base}?email=…` `` against `https://get.example#top` produces
 * `https://get.example#top?email=…`, where the whole tail sits *inside the
 * fragment* and the far side receives no query at all — a link that opens, looks
 * right, and silently prefills nothing. `encodeURIComponent` cannot help with
 * that, because the question it does not answer is `?` against `&` and where the
 * `#` goes.
 *
 * `set` rather than `append`, so a base that already names an address is replaced
 * rather than joined by a second the receiver would pick from arbitrarily.
 *
 * And the escaping is `URLSearchParams`', so the address is data. Measured:
 * `a@b.com&plan=free` serialises as `a%40b.com%26plan%3Dfree` and cannot become a
 * second parameter, and `+` becomes `%2B` — which is not cosmetic. The service on
 * the other side reads this with Hono, whose query decoder replaces `+` with a
 * space *before* percent-decoding, so a bare `+` would arrive as a mangled
 * address in a field that page renders `readonly`. `enrollment.ts`'s rule about a
 * caller-influenced value, arriving in a URL instead of in a shell.
 *
 * **No address is still an offer.** `email` is optional on `Me` — an instance
 * with no SMTP has accounts that never had one — and the point of the link is
 * that somebody with no machine can get one, which is true of them too. They get
 * the bare address and type their own on the far side, which is what that page
 * does for everyone who did not arrive from here.
 *
 * **An unverified address is prefilled.** `emailVerified` answers whether *this
 * control plane* may send to it: it gates recovery and invitation, and it exists
 * because an unverified claim reserves nothing here. That is a statement about
 * this instance's trust, not about whether the string is the one the person would
 * type into somebody else's checkout. Withholding it would empty the form for
 * exactly the newest account — the one whose confirmation link is still in their
 * inbox — which is the person this offer is most for.
 *
 * `null` is the only state a caller branches on: one predicate, rather than "is
 * there a URL" and "is it usable" answered in two places.
 */
export function machineOfferHref(offer: string | null, me: Me | null): string | null {
  if (offer === null) return null;
  let url: URL;
  try {
    url = new URL(offer);
  } catch {
    /*
     * Unreachable through `parseInstanceConfig`, which has already refused
     * anything `new URL` cannot read. Stated here rather than assumed from a
     * caller, because this is exported and the next one may not come through it.
     */
    return null;
  }
  /*
   * `new URL` accepts every scheme — `javascript:` and `data:` both parse — and
   * this value ends up in an `href`. The same check `isAbsoluteHttpUrl` makes one
   * file over, repeated rather than imported, so that a call site reaching this
   * directly still cannot produce one.
   */
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const email = typeof me?.email === "string" ? me.email.trim() : "";
  if (email.length > 0) url.searchParams.set("email", email);
  return url.toString();
}
