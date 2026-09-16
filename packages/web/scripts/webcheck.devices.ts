import { readFileSync } from "node:fs";
import { check, report, storage } from "./webcheck.env.js";
import { stripComments } from "./webcheck.source.js";

/* ------------------------------------------------------------------ *
 * A device, and the gate the control plane serves
 *
 * Two subjects in one file because they arrived for one reason: the app is the
 * product, so the control plane serves the gate and nothing else, and an
 * installation of that app is now a thing somebody can retire.
 *
 * What is asserted here is the part no type can hold:
 *
 *   - **The two HTML entry points agree about their `<head>`.** `index.html` is
 *     the app and `gate.html` is what the control plane serves; every tag in that
 *     head is a measured decision, and the second file is a copy.
 *   - **`readPastedGateToken` accepts exactly three shapes and refuses the rest.**
 *     It is the remedy for a mail client that rewrites a URL and drops the `#`
 *     the token rides on — which is a real and unremarkable thing for one to do.
 *   - **Signing out keeps the device and `device_revoked` gives it up.** Both
 *     directions are wrong in a way nothing else notices: dropping it on sign-out
 *     registers a second device for one computer every time, and keeping it on a
 *     retirement means presenting an id the server will never adopt.
 *   - **The stored value is a key of its own**, so a sign-out that clears the
 *     credential cannot take it along by sharing a name.
 * ------------------------------------------------------------------ */

process.stdout.write("\nthe gate's two entry points, devices, and a pasted link\n");

{
  /*
   * ⚠ **`gate.html` is a copy of `index.html`'s head and nothing but this says
   * so.** Every tag in it is a decision with a measurement behind it — the
   * viewport's `interactive-widget`, which is what stops a software keyboard
   * hiding the box you are typing in; the theme colour that has to track
   * `--color-ink` because a `<meta>` cannot read a CSS variable; the favicons
   * that may not be `data:` URIs under this document's own CSP. Every one of
   * those applies to the gate for exactly the reason it applies to the app, and
   * the gate is the page a *stranger* sees first.
   *
   * A shared partial would need a templating step this package does not have, so
   * the copy is the design and this is the check. Compared as the set of `<meta>`
   * and `<link>` tags with whitespace collapsed: the `<title>` is excluded
   * deliberately, since the two documents are allowed to name themselves.
   */
  const headTags = (file: string): string[] => {
    const text = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    const head = /<head>([\s\S]*?)<\/head>/.exec(text)?.[1] ?? "";
    // Comments out first: both files carry long ones and only one carries the
    // note about being a copy.
    const bare = head.replace(/<!--[\s\S]*?-->/g, "");
    return [...bare.matchAll(/<(?:meta|link)\b[^>]*>/g)]
      .map((m) => (m[0] ?? "").replace(/\s+/g, " ").trim())
      .sort();
  };
  const app = headTags("index.html");
  const gate = headTags("gate.html");
  report("both entry points were read", app.length > 0 && gate.length > 0, `${String(app.length)} tags each side`);
  check("the gate's head is the app's head", gate, app);
  /*
   * And the half that says they are two documents rather than one file read
   * twice: different entry scripts. Without this the check above passes for a
   * `gate.html` that is a byte copy of `index.html` — which would boot the whole
   * app on a page the control plane serves.
   */
  const entry = (file: string): string => {
    const text = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    return /<script type="module" src="([^"]+)"/.exec(text)?.[1] ?? "";
  };
  check("and they load different entry points", entry("index.html") !== entry("gate.html"), true);
  check("the gate loads the gate's", entry("gate.html"), "/src/gate-main.tsx");
}


const SRC = new URL("../src/", import.meta.url);
const read = (rel: string): string => readFileSync(new URL(rel, SRC), "utf8");

{
  const { isGateToken, readGateToken, readPastedGateToken } = await import("../src/gate.js");

  /*
   * A real token shape. `et_` is what `user_email_tokens` mints and `pr_` what a
   * pending registration does — the two prefixes `isGateToken` admits.
   */
  const TOKEN = "et_abcdefghijklmnopqrstuvwxyz012345";
  const PENDING = "pr_abcdefghijklmnopqrstuvwxyz012345";

  check("the fixture is a token at all", [isGateToken(TOKEN), isGateToken(PENDING)], [true, true]);

  /* -- the three shapes somebody can paste ------------------------------- */

  check("a whole link", readPastedGateToken(`https://cp.example/reset#t=${TOKEN}`), TOKEN);
  check("with a port and a path that is not ours", readPastedGateToken(`http://localhost:7888/verify#t=${TOKEN}`), TOKEN);
  check("a bare fragment, which is what selecting half a link gives", readPastedGateToken(`#t=${TOKEN}`), TOKEN);
  check("the fragment without its hash", readPastedGateToken(`t=${TOKEN}`), TOKEN);
  check("the code on its own, which is what a mail client that ate the link leaves", readPastedGateToken(TOKEN), TOKEN);
  check("a registration token too", readPastedGateToken(PENDING), PENDING);
  // Pasting drags whitespace in from every mail client there is.
  check("surrounded by whitespace", readPastedGateToken(`  ${TOKEN}\n`), TOKEN);
  check("and a link with whitespace", readPastedGateToken(`\n https://cp.example/confirm#t=${TOKEN} `), TOKEN);

  /* -- and what it refuses ------------------------------------------------ */

  /*
   * ⚠ **Every refusal here is a request that is never made.** The alternative is
   * sending whatever was in the box and letting the server answer about it, which
   * `readGateToken`'s own docblock refuses one function over for the same reason:
   * the person is then told their *link* did not work when what did not work is
   * that they pasted the wrong thing.
   */
  check("nothing at all", readPastedGateToken(""), null);
  check("whitespace only", readPastedGateToken("   \n "), null);
  check("a link with no fragment", readPastedGateToken("https://cp.example/reset"), null);
  check("a link whose fragment carries something else", readPastedGateToken("https://cp.example/reset#hello"), null);
  check("a fragment with the wrong parameter", readPastedGateToken(`#token=${TOKEN}`), null);
  check("a truncated token", readPastedGateToken("et_abc"), null);
  check("a token with the wrong prefix", readPastedGateToken("rs_abcdefghijklmnopqrstuvwxyz012345"), null);
  check("a sentence", readPastedGateToken("here is the link from my email"), null);
  /*
   * ⚠ **A session token pasted by mistake, which is the one refusal with a cost
   * behind it.** `rs_` is a live bearer credential; `cpctl login` prints one and
   * somebody who has both in a terminal can reach for the wrong one. It is refused
   * by shape here rather than sent to a route that would answer about it, so the
   * value never leaves the page.
   */
  check("and a credential, which must never be sent anywhere", readPastedGateToken("rs_0123456789abcdef0123456789abcdef"), null);

  /*
   * The reader the URL arm delegates to is unchanged, which is what makes the new
   * one additive rather than a second policy. A negative control, because "both
   * answer the same" passes trivially if either is broken.
   */
  check("the fragment reader still refuses what it always did", readGateToken("#t=nope"), null);
  check("and the pasted reader agrees with it on a real one", readPastedGateToken(`#t=${TOKEN}`), readGateToken(`#t=${TOKEN}`));
}

/* ------------------------------------------------------------------ *
 * Which of the gate's addresses draws what
 * ------------------------------------------------------------------ */

{
  const { parseGateRoute } = await import("../src/gate.js");

  for (const screen of ["register", "confirm", "forgot", "reset", "verify"]) {
    check(`/${screen} draws its gate screen`, parseGateRoute(`/${screen}`), { name: "gate", screen });
  }
  for (const doc of ["terms", "acceptable-use", "privacy"]) {
    check(`/${doc} draws the document`, parseGateRoute(`/${doc}`), { name: "legal", doc });
  }
  check("/app is the handoff", parseGateRoute("/app"), { name: "handoff" });

  /*
   * ⚠ **The fallback is the handoff rather than an error, and that is the one
   * decision in this function.** Anything reaching this bundle at all was served
   * by the control plane, which answers a page on a closed list — so a path that
   * gets here came from a client-side navigation or a trailing slash. The one
   * thing this surface always has to say is where the product is; drawing "not
   * found" instead would be a dead end on a page whose whole job is to be a way
   * forward.
   */
  check("and so is anything else", parseGateRoute("/"), { name: "handoff" });
  check("including an address belonging to the app", parseGateRoute("/settings"), { name: "handoff" });
  check("and one that names nothing", parseGateRoute("/nope"), { name: "handoff" });

  // Trailing and leading slashes are the same address. A mail client that
  // appends one must not land somebody on the handoff for a link that works.
  check("a trailing slash changes nothing", parseGateRoute("/reset/"), { name: "gate", screen: "reset" });
  check("nor does a doubled leading one", parseGateRoute("//reset"), { name: "gate", screen: "reset" });

  /*
   * ⚠ **Nothing here decodes, which is `router.ts`'s rule.** A bare
   * `decodeURIComponent` over a segment holding a lone `%` throws `URIError` —
   * during module evaluation, on a phone, with no console and no way to recover
   * by reloading. Every value compared is an ASCII literal, so there is nothing
   * to decode; this asserts the hostile input simply falls through.
   */
  check("a lone percent does not throw", parseGateRoute("/%"), { name: "handoff" });
  check("nor does an incomplete escape", parseGateRoute("/re%zzset"), { name: "handoff" });
}

/* ------------------------------------------------------------------ *
 * What a sign-out keeps, and what a retirement takes
 * ------------------------------------------------------------------ */

{
  const cp = await import("../src/cp.js");

  storage.clear();
  check("nothing stored is no device", cp.currentDevice(), null);

  cp.rememberDevice("dv_abc123");
  check("a registered device is remembered", cp.currentDevice(), "dv_abc123");

  /*
   * ⚠ **The assertion this section exists for.** Signing out ends a session; the
   * computer is still the same computer and its row on the server is still live.
   * A `clearSession` that swept the device along would make every sign-out
   * register a second device for one machine, and an account that signs out
   * twenty times walks into its own device limit with twenty rows all naming the
   * same laptop.
   */
  cp.setSession("rs_0123456789abcdef0123456789abcdef");
  cp.clearSession();
  check("⭐ signing out keeps the device", cp.currentDevice(), "dv_abc123");
  check("and really did clear the credential", cp.currentCredential(), null);

  /*
   * ⚠ **And the other direction.** A retired device's id is finished: the server
   * declines to bind it and registers a fresh one, so a client that kept
   * presenting it would re-register on every launch while holding an id nothing
   * will ever adopt again.
   */
  cp.forgetDevice();
  check("⭐ and a retirement gives it up", cp.currentDevice(), null);

  /*
   * Two keys, never one. Written as a source-text assertion as well as a
   * behavioural one, because the behaviour above passes for a value stored under
   * *any* name and what stops a later edit folding them together is that the
   * names are visibly different.
   */
  const cpSrc = stripComments(read("cp.ts"));
  const credentialKey = /const CREDENTIAL_STORAGE = "([^"]+)"/.exec(cpSrc)?.[1] ?? "";
  const deviceKey = /const DEVICE_STORAGE = "([^"]+)"/.exec(cpSrc)?.[1] ?? "";
  report("both storage keys were found", credentialKey.length > 0 && deviceKey.length > 0, `${credentialKey} / ${deviceKey}`);
  check("and they are not the same name", credentialKey === deviceKey, false);
  /*
   * ⚠ **And neither is a `LEGACY_STORAGE` name.** `setSession` writes the
   * credential and then sweeps that list; `cp.ts`'s own ⚠ block records a blanket
   * rename putting the same string in both, so signing in deleted what it had just
   * written. A device key that collided with one of those would be swept on every
   * sign-in, silently, and the symptom would be an account growing a device per
   * launch — the same failure the keyring arm is kept out of `credential.rs` to
   * avoid.
   */
  const legacy = /const LEGACY_STORAGE = \[([^\]]*)\]/.exec(cpSrc)?.[1] ?? "";
  report("the legacy list was found", legacy.length > 0, legacy.trim());
  check("and the device key is not one of them", legacy.includes(deviceKey), false);
}

/* ------------------------------------------------------------------ *
 * Where the device id is kept in the shell, which is not the keyring
 * ------------------------------------------------------------------ */

{
  /*
   * ⚠ **The one assertion here that is about a *file* rather than a value.**
   * `credential.rs` is the OS keyring and `config.rs` is an ordinary preferences
   * file. A device id belongs in the second: it is an identifier the server handed
   * back rather than a secret, and the cost of the first is measured — a machine
   * whose keyring silently discards writes (`credential::probe` answers `false` for
   * exactly that state, which the app already draws a sentence for) would lose the
   * id on every launch and register a new device each time.
   *
   * Read off disk because nothing typed can hold it: both are `String`s crossing
   * one bridge, so a device moved into the keyring would compile, run, and fail
   * only on the machines nobody develops on.
   */
  const NATIVE = new URL("../../native/src-tauri/src/", import.meta.url);
  const rust = (rel: string): string => readFileSync(new URL(rel, NATIVE), "utf8");
  const credentialRs = rust("credential.rs");
  const configRs = rust("config.rs");

  check("the device is kept in the configuration file", /fn (read|write|erase)_device\b/.test(configRs), true);
  check("and the keyring does not know about one", /fn \w*device\w*\s*\(/i.test(credentialRs), false);
  /*
   * The secret set stays at one member, which is the property `credential.rs`
   * states about itself — *"a named set with a single member … so adding a second
   * is a visible edit in one place"* — and the seam it reserves is for a device
   * **key**, which cannot use a `String` interface at all.
   */
  const secrets = [...credentialRs.matchAll(/^pub const (\w+): &str = /gm)].map((m) => m[1] ?? "");
  check("the keyring still holds exactly one kind of secret", secrets, ["CREDENTIAL"]);
  // And it still has no way to enumerate, which is the other half of that
  // position: listing is what a key rotation wants, and shipping the verb is
  // shipping the feature.
  check("and still cannot be enumerated", /fn list\b/.test(credentialRs), false);
}
