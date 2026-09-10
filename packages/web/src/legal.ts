/**
 * The documents this instance is bound by, and every rule about their URLs.
 *
 * Here rather than in `router.ts` for the reason `gate.ts` states at length:
 * that module reads `window.location` and installs a `popstate` listener **in
 * its module body**, so `webcheck` throws on import before a single case runs.
 * A rule the driver cannot reach is a rule nothing asserts.
 *
 * ## Why these are not gate screens
 *
 * They look like the gate family — no credential, no shell, one card of prose —
 * and they are deliberately not in it. `gate.ts` defines that family as *"the
 * screens somebody reaches **before there is a credential**"*, and a policy is
 * read before **and** after; `depthOf`'s gate arm argues those screens are *"the
 * sign-in form with different fields"*, which a policy is not; and `GateCard` is
 * `max-w-sm`, a **form** measure, where a document wants `COLUMN`, the app's
 * only reading measure. Q3.598.
 *
 * ## ⚠ These are one operator's terms, and a fork must replace them
 *
 * This is AGPL-3.0-only software, so somebody else can and will run this build.
 * The prose below describes **this software's behaviour** and is true of any
 * deployment; {@link OPERATOR} is one particular sole proprietor in one
 * jurisdiction and is **not**. Serving these documents unchanged from your own
 * control plane tells your users they have a contract with somebody who has
 * never heard of them, and collects their agreement to it under a button they
 * pressed to sign up.
 *
 * The shape of the warning is `SOURCE_URL`'s in `packages/control-plane/src/
 * app.ts` — compiled in, with the instruction to change it stated where the
 * value is. The distinction from that constant, and why the party is not an
 * environment variable, is Q1.638.
 */

export { OPERATOR, operatorIncomplete, legalPublishable } from "./legal/operator";

/** One document. The address is the id; the words are {@link legalTitle}'s. */
export type LegalDoc = "terms" | "acceptable-use" | "privacy";

export const LEGAL_DOCS: readonly LegalDoc[] = ["terms", "acceptable-use", "privacy"];

/**
 * The languages a document can be written in, and the ones it **is**.
 *
 * ⚠ **English is the only one written, and the axis is the seam for a second.**
 * {@link LEGAL_LANGS} is what exists; `LegalLang` is what may. Adding a language
 * is a second value in the table and a control on the screen — never a
 * localisation layer, which this app has never had and must not grow here.
 */
export type LegalLang = "en" | "ka";

export const LEGAL_LANGS: readonly LegalLang[] = ["en"];

/**
 * One paragraph-sized thing, and there are four kinds because policy prose has
 * four.
 *
 * ⚠ **There is no `{ kind: "link"; href }` and there must not be.** An href
 * chosen by whoever writes the prose, rendered at this origin, is the sink
 * `Markdown.tsx` refuses by disabling `rehype-raw`. The only outbound links in
 * this whole feature are the two on a {@link LegalCredit}, which the renderer
 * builds itself, and the one `mailto:` a `contact` block carries.
 */
export type LegalBlock =
  | { kind: "para"; text: string }
  | { kind: "list"; items: readonly string[] }
  /** A sentence ending in a link to one of the other documents. */
  | { kind: "ref"; text: string; doc: LegalDoc; label: string }
  /** A sentence ending in an address somebody writes to. */
  | { kind: "contact"; text: string; email: string };

export interface LegalSection {
  /**
   * Lower-case and hyphenated, and stable once published: it is the fragment
   * somebody cites back at you in a dispute.
   */
  id: string;
  heading: string;
  blocks: readonly LegalBlock[];
}

/**
 * Where a document's text was adapted from.
 *
 * ⚠ **CC BY 4.0 is a condition, not a courtesy.** The attribution has to appear
 * where the work is read, so it is rendered on the page rather than only filed
 * in `THIRD-PARTY.md`. A credit line lost to a tidy-up is a licence breach that
 * reads as housekeeping, which is why `webcheck` asserts every field of it.
 */
export interface LegalCredit {
  work: string;
  author: string;
  licence: "CC BY 4.0" | "CC0 1.0";
  workUrl: string;
  licenceUrl: string;
}

export interface LegalDocument {
  doc: LegalDoc;
  lang: LegalLang;
  /** `YYYY-MM-DD`, and the date the *text* changed — never a build stamp. */
  effective: string;
  lead: string;
  sections: readonly LegalSection[];
  credits: readonly LegalCredit[];
}

/**
 * The document a path names, or `null` for every other path.
 *
 * Takes segments rather than a pathname so it composes with `router.ts`'s own
 * split, and matched **exactly**, so the case a URL happens to arrive in never
 * decides what is rendered — `parseGateScreen`'s rule, and the same code.
 */
export function parseLegalDoc(segments: readonly (string | undefined)[]): LegalDoc | null {
  const first = segments[0];
  if (first === undefined) return null;
  return LEGAL_DOCS.find((doc) => doc === first) ?? null;
}

/** Whole-segment, the `isOverlayPath` rule: `/termsish` is not `/terms`. */
export function isLegalPath(pathname: string): boolean {
  return parseLegalDoc(pathname.split("/").filter((part) => part.length > 0)) !== null;
}

export function legalPath(doc: LegalDoc): string {
  return `/${doc}`;
}

/**
 * The words a document is called by.
 *
 * ⚠ **The address is an acronym and the title is not**, which is `sheetTitle`'s
 * standing rule: a link written down last week has to keep opening the screen,
 * and a reader who has never met the acronym must not be shown one. Every
 * control that names a document reads this rather than typing the words again.
 */
export function legalTitle(doc: LegalDoc): string {
  switch (doc) {
    case "terms":
      return "Terms of Use";
    case "acceptable-use":
      return "Acceptable Use Policy";
    case "privacy":
      return "Privacy Policy";
  }
}

/**
 * What the control that leaves a document is called.
 *
 * Named after where it goes rather than "Back", which is `Header`'s rule: there
 * is no history here, only a fixed destination, and a signed-in reader is not
 * going to a sign-in screen.
 */
export function legalUpLabel(signedIn: boolean): string {
  return signedIn ? "Back to your machines" : "Back to sign in";
}
