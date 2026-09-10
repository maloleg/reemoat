import type { LegalDoc, LegalDocument, LegalLang } from "../legal";

import { ACCEPTABLE_USE_EN } from "./acceptableUse";
import { PRIVACY_EN } from "./privacy";
import { TERMS_EN } from "./terms";

/**
 * The prose itself, and the only module that reaches it.
 *
 * ⚠ **Separate from `../legal.ts` because of a measurement, not for tidiness.**
 * `router.ts` imports `parseLegalDoc` to parse every URL this app opens, so
 * anything `legal.ts` imports is on the first-paint path — and with the table
 * living there the whole of three policies rode into the entry chunk. Measured
 * on this bundle, 2026-09-10: entry **365.21 kB (112.01 kB gzipped)** with the
 * table in `legal.ts`, **308.82 kB (95.68 kB)** with it here, and the documents
 * in a `LegalScreen` chunk of 32.57 kB (11.14 kB) fetched only when somebody
 * opens one. That is the same trade `App.tsx` argues for the markdown pipeline,
 * arriving by a different door. `LegalScreen` is the only importer, and it is
 * itself `lazy()`.
 *
 * Neither `typecheck` nor any driver can see this: it is a bundler fact. What
 * pins it is one assertion in `webcheck.legal-and-consent.ts` — that `legal.ts`
 * imports no prose — plus this comment.
 */
/**
 * Every document that exists, keyed by language and then by document.
 *
 * `Partial` on the language axis rather than a full record, because the whole
 * point of {@link LEGAL_LANGS} is that one of the two languages is not written
 * yet and the type should say so rather than being satisfied by three empty
 * documents.
 */
const TEXT: Partial<Record<LegalLang, Record<LegalDoc, LegalDocument>>> = {
  en: {
    terms: TERMS_EN,
    "acceptable-use": ACCEPTABLE_USE_EN,
    privacy: PRIVACY_EN,
  },
};

/**
 * A document, in a language, falling back to English.
 *
 * **Falls back rather than refusing**, which is `instance.ts`'s standing
 * sentence in the other direction: fail closed where the cost is a missing
 * screen, fail open where the cost is a person who cannot get on. A consent
 * checkbox linking to a blank page is worse than one linking to a language
 * somebody did not ask for, and a language segment is reachable by typing long
 * before there is anything behind it.
 */
export function legalDocument(doc: LegalDoc, lang: LegalLang = "en"): LegalDocument {
  const inLang = TEXT[lang]?.[doc];
  if (inLang !== undefined) return inLang;
  const english = TEXT["en"];
  // Not reachable while `en` is populated above, and typed rather than asserted
  // because a `!` here would be the one place this file lied about its own table.
  if (english === undefined) throw new Error("no legal text in any language");
  return english[doc];
}
