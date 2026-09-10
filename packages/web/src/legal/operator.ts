/**
 * The party the documents in `../legal.ts` bind.
 *
 * ⚠ **Its own module so that the prose can read it without a cycle.** The three
 * documents import this value at run time and `legal.ts` imports the three
 * documents at run time; with the constant living in `legal.ts` the prose would
 * execute first — imports are hoisted — and read it in its temporal dead zone,
 * which is a `ReferenceError` on first paint rather than a type error at build.
 */

/**
 * ⚠ **The party these documents bind. Replace every field if you run your own
 * copy — see this file's header.**
 *
 * Every field here is rendered into the published documents, so a placeholder
 * left in one is a placeholder somebody reads.
 *
 * ⚠ **PLACEHOLDERS BELOW ARE NOT PUBLISHABLE.** `webcheck` reports a `skip`
 * naming each one that is still unfilled, so a run that checked nothing cannot
 * read as a run that agreed.
 */
export const OPERATOR = {
  /** The name on the product. */
  tradingName: "Reemoat",
  /** The name on the contract, carrying the legal form. */
  legalName: "Nikita Kinelovsky",
  legalForm: "Individual Entrepreneur (ინდივიდუალური მეწარმე), registered in Georgia",
  /**
   * Given by the owner, 2026-09-10. ⚠ **Not verified against the registry from
   * here** — the public search at `enreg.reestri.gov.ge` is POST-and-session
   * gated and answered nothing to a direct request, so this is the owner's word
   * and wants one look at their own extract before the documents are published.
   */
  registrationNumber: "306567943",
  /**
   * ⚠ **`null` by decision, and this comment is the record of that rather than a
   * field somebody forgot to fill.** Filling it in is one line and nothing
   * asserts against it in either direction.
   */
  address: null,
  email: "info@reemoat.com",
  /**
   * Who carries the outbound mail, and from where.
   *
   * ⚠ **Named twice in the Privacy Policy, once as a data processor**, so it is a
   * required disclosure rather than a nicety — which is why it is here, under
   * {@link operatorIncomplete}, rather than beside the prose that reads it. While
   * it says `TODO` this instance publishes **no documents at all**: `App` and the
   * consent box both read `operatorIncomplete()`, so the failure is a feature that
   * stays switched off rather than a placeholder somebody reads in a contract.
   *
   * ⚠ **This one is outside Georgia, and that is why the transfer paragraph in
   * `privacy.ts`'s `who-else-processes` section is load-bearing rather than
   * boilerplate.** The other processor in that list — Hetzner, in Germany and
   * Finland — is somewhere the regulator is likely to treat as adequate; a US
   * company is the case that actually needs the standard contractual clauses and
   * whatever permission the Law on Personal Data Protection requires. Both the
   * list entry and that paragraph state, as fact, that the paperwork exists. Do
   * not shorten either one without the paperwork in hand, and if the provider is
   * ever changed for one inside the EEA, the paragraph still reads correctly —
   * it is written per-processor rather than about this value.
   *
   * The product name is carried alongside the company because the company sells
   * several things and the disclosure is about which service holds the mail.
   * Sub-processors are the provider's own to publish; "that is the whole list" in
   * the prose is a statement about *our* processors, which is the standard reading.
   */
  mailProvider: "Namecheap, Inc. (Private Email), in the United States",
  /** The deployment these documents are the terms of. */
  instance: "app.reemoat.com",
  ordering: "get.reemoat.com",
} as const;

/**
 * The required fields of {@link OPERATOR} still holding a placeholder.
 *
 * ⚠ **Read at run time and not only by a driver, which is the whole of the
 * publication gate.** An empty answer is what lets `App` draw a document and what
 * lets the consent box appear; anything else means this deployment has not
 * finished claiming the documents, and it publishes none of them. A `skip` in
 * `webcheck` says a run checked nothing — it cannot stop a release, and the one
 * thing that must never ship is a contract with `TODO` in it where a reader is
 * deciding whether to trust the service.
 *
 * Cheap enough to call on the first-paint path: three string compares, and this
 * module imports no prose, so nothing here pulls the documents into the entry
 * chunk (`legal/text.ts` holds that measurement).
 */
export function operatorIncomplete(): readonly string[] {
  // `address` is deliberately not in this list: it is `null` by decision rather
  // than unfilled, and a driver that reported it every run would train somebody
  // to stop reading the skips.
  return (["legalName", "registrationNumber", "mailProvider"] as const).filter((field) =>
    OPERATOR[field].startsWith("TODO"),
  );
}

/**
 * Whether this build may publish its legal documents at all.
 *
 * The other half of `REEMOAT_CP_LEGAL_DOCUMENTS`: the instance says whether it
 * *claims* the documents, and this says whether they are *finished*. Both have to
 * be true, and they fail in the same direction — no pages, no consent box, no
 * requirement on the register route.
 */
export function legalPublishable(): boolean {
  return operatorIncomplete().length === 0;
}
