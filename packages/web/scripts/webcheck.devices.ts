import { readFileSync } from "node:fs";
import { check, report, storage } from "./webcheck.env.js";
import { srcFile, stripComments } from "./webcheck.source.js";
import { ApiError, meansDeviceKeyMissing } from "../src/http.js";

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
 * The key travels with the registration, and the refusal is recoverable
 *
 * An installation that predates device keys reaches its first mint after an
 * update with a row the control plane holds no key for, and so does one whose
 * credential store was reset. If that were only a refusal, an update of the
 * control plane would strand every machine until somebody signed in again on each
 * of them. It is recoverable instead: the client re-registers the **same** id with
 * the key its shell already holds, and mints again.
 *
 * `relaycheck` drives the server half against the real routes — the refusal, the
 * re-registration adopting the row rather than making one, and the capability that
 * follows. This half is the client's wiring, which a browser cannot drive because
 * `registerDevice` answers `null` outside the shell by design.
 * ------------------------------------------------------------------ */

{
  const cpSrc = stripComments(srcFile("cp.ts"));
  const machineSrc = stripComments(srcFile("machine.ts"));

  /*
   * The registration carries the key. Without this line a fleet updates, every
   * installation is refused a capability, and nothing anywhere fixes it.
   */
  check("the registration carries the shell's device key", /publicKey/.test(cpSrc), true);
  check("read off the boot payload rather than invented", /boot\.devicePublicKey/.test(cpSrc), true);

  /*
   * ⚠ **And the mint applies the remedy the refusal names.** Keyed on the code
   * through `meansDeviceKeyMissing`, never on the status: a 409 is shared by
   * refusals that mean unrelated things, which is `meansMachineGone`'s rule.
   */
  check("the mint recognises the refusal", /meansDeviceKeyMissing/.test(machineSrc), true);
  check("and answers it by registering the key", /registerDevice\(\)/.test(machineSrc), true);
  /*
   * Once. A registration that does not take has to surface as the refusal it is
   * rather than as a loop against the control plane, which is the same guard the
   * request path already spends on a retry.
   */
  check("exactly once, on the first attempt", /firstAttempt && meansDeviceKeyMissing/.test(machineSrc), true);

  // The predicate itself, driven rather than read: it is a pure function and the
  // one thing here that can be wrong without any of the wiring above being wrong.
  check("the code is what it keys on", meansDeviceKeyMissing(new ApiError(409, "device_key_required", "no key")), true);
  check(
    "and a different 409 is not it",
    meansDeviceKeyMissing(new ApiError(409, "device_needs_session", "no session")),
    false,
  );
  check("nor is a transport failure", meansDeviceKeyMissing(new TypeError("offline")), false);
}

/* ------------------------------------------------------------------ *
 * The hand mirror, and the one screen that reads what it was missing
 *
 * ⚠ **This is the fifth feature `wire.ts` has silently dropped, and the guard
 * that exists for exactly this could not catch it.**
 * `webcheck.plugin-protocol.ts` sweeps every interface in that file whose
 * original it can find — and it looks each one up in a hard-coded list of `src/`
 * files with no control-plane file in it, so `DeviceRecord` hits that sweep's
 * `continue` and is compared against nothing at all. The control plane has been
 * answering `hasKey` on **every** device row since the column landed, and the
 * screen whose whole purpose is *can this installation reach a machine* could not
 * read it: a device that could not open an encrypted channel to anything drew
 * exactly like one that works.
 *
 * So the comparison is made here, where the control-plane file is already being
 * read for other reasons, and it is a census rather than two named fields — a
 * sixth dropped field is the same defect and must fail the same way.
 * ------------------------------------------------------------------ */

{
  /** The declared field names of one interface, in declaration order. */
  const fieldsOf = (source: string, name: string): string[] => {
    const body = new RegExp(`export interface ${name} \\{([\\s\\S]*?)\\n\\}`).exec(stripComments(source))?.[1] ?? "";
    return [...body.matchAll(/^\s*(\w+)\??:/gm)].map((one) => one[1] ?? "");
  };

  const served = fieldsOf(readFileSync(new URL("../../control-plane/src/devices.ts", import.meta.url), "utf8"), "DeviceRow");
  const mirrored = fieldsOf(read("wire.ts"), "DeviceRecord");

  report("both sides of the mirror were found", served.length > 0 && mirrored.length > 0, `${String(served.length)} served, ${String(mirrored.length)} mirrored`);
  check("⭐ every field the control plane serves on a device row is declared here", served.filter((field) => !mirrored.includes(field)), []);
  /*
   * And the two this landed for, named as well as swept. The census above is what
   * makes the sixth one fail; naming these two is what makes *this* failure legible
   * when it happens, rather than a diff of two lists.
   */
  check("including the pair the encryption put there", [mirrored.includes("hasKey"), mirrored.includes("keySetAt")], [true, true]);

  /*
   * ⚠ **Optional on the mirror while required on the server, and the asymmetry is
   * deliberate rather than laziness.** `public_key` and `key_set_at` are
   * `migrate()` additions onto a `devices` table that shipped without them, so a
   * control plane older than that release lists devices and sends neither.
   * `undefined` means *nobody said*, which is not the same claim as `false`: a
   * client that declared them required would mark every device on such a server as
   * unable to reach anything, which is `SessionRecord.ip`'s rule and the reason
   * `cp.ts`'s own `registerDevice` already reads `hasKey?: boolean`.
   */
  const mirrorSource = stripComments(read("wire.ts"));
  check("the mirror declares them optional", /hasKey\?: boolean;/.test(mirrorSource) && /keySetAt\?: number \| null;/.test(mirrorSource), true);

  /*
   * And the screen. ⚠ **Keyed on `=== false`, never on `!row.hasKey`** — the
   * absent value read as falsy would put the badge, and the sentence explaining
   * it, on a whole account's devices on a control plane that simply predates the
   * column, none of which is broken. Read off the file rather than rendered,
   * because a `!` in front of a field is a one-character edit that changes nothing
   * a type can see.
   */
  const devicesSection = stripComments(read("ui/settings/DevicesSection.tsx"));
  check("⭐ the devices screen reads the field at all", /row\.hasKey/.test(devicesSection), true);
  check("comparing it against false rather than for truthiness", /row\.hasKey === false/.test(devicesSection), true);
  check("and never as a bare negation", /!row\.hasKey\b/.test(devicesSection), false);
  /*
   * **Three readers now, and the pair is still the assertion for two of them**: a
   * badge somebody can see on the row, and one sentence above the list saying what
   * to do about it. A badge with no sentence is a word nobody can act on; a
   * sentence with no badge does not say *which* installation it is about.
   *
   * The third is `rekeyable`, added with the control below, and it is pinned by
   * its own anchored line rather than by this count — which is the whole reason
   * the floor stays a floor: a `report` can say how many readers it found and
   * cannot say **which**, so the reader that matters gets an assertion naming it.
   * The count was written as "twice" and was three within a release.
   */
  report(
    "on both the row's badge and the sentence that explains it",
    [...devicesSection.matchAll(/row\.hasKey === false/g)].length >= 2,
    `${String([...devicesSection.matchAll(/row\.hasKey === false/g)].length)} readers`,
  );

  /*
   * ⚠ **The one act that ends `hasKey: false`, and until this it had no assertion
   * anywhere in the net.** `hostDeviceKeyReset` spent releases with three
   * docblocks in three languages promising it and **no caller in `packages/web`
   * at all**; `grep -rn hostDeviceKeyReset packages/web/scripts` answered nothing,
   * so the control could be deleted again and every driver would stay green —
   * which is precisely the state the feature was just rescued from.
   *
   * Read off the source rather than rendered, for the reason the `row.hasKey`
   * lines above give: every one of these is a *condition on a control's
   * existence*, and a control nobody draws type-checks.
   */
  check("⭐ the re-key control calls the shell's reset", /await hostDeviceKeyReset\(\);/.test(devicesSection), true);
  /*
   * ⚠ **And registers the device *after* it, never beside it.** The pair is
   * sequential because `hostDeviceKeyReset` refreshes the cached `NativeBoot` on
   * its way out and `cp.registerDevice` reads the new public half off exactly
   * that — so a `Promise.all` would send the key that was just given up, and would
   * send it *successfully*, leaving the row reporting the same `hasKey: false` it
   * started from with nothing anywhere to say why.
   *
   * The ordered pattern is what carries this; the `Promise.all` refusal beside it
   * is vacuous on its own and is only worth anything next to the positive half.
   * Measured: the reverse order does not match, so the pattern is discriminating
   * rather than satisfied by the two calls merely co-occurring.
   */
  /*
   * ⚠ **Ordering by position, not by an adjacency pattern.** The first spelling
   * of this was `/await hostDeviceKeyReset\(\);\s*const \w+ = await
   * cp\.registerDevice\(\)/`, which pinned the two calls as *adjacent statements*
   * — and it went red the moment `registerDevice()` was wrapped in the `try` that
   * tells the three real outcomes of a re-key apart. That is a driver failing on
   * an improvement, which is worse than one that misses a regression: it argues
   * for undoing the fix. What is actually load-bearing is that the reset happens
   * **first**, because the reset is irreversible and a registration that never
   * follows it is the one state the screen has to be able to explain.
   */
  const resetAt = devicesSection.indexOf("hostDeviceKeyReset()");
  const registerAt = devicesSection.indexOf("cp.registerDevice()");
  report(
    "both halves of a re-key are present to be ordered",
    resetAt >= 0 && registerAt >= 0,
    `reset at ${resetAt}, register at ${registerAt}`,
  );
  check("and registers the device after it", resetAt >= 0 && registerAt > resetAt, true);
  check("so the two halves are never raced", /Promise\.all/.test(devicesSection), false);
  /*
   * The three conditions on the control, each on its own line because each is
   * wrong in a different way and a single regex over all three would not say
   * which went: a tab has no keyring to reset, somebody else's row would hand a
   * third computer a key nobody asked for, and a row that already has a key has
   * nothing to recover from.
   */
  check("the control exists only in the native shell", /const rekeyable = [^;]*inNativeShell\(\)/.test(devicesSection), true);
  check("only on this installation's own row", /const rekeyable =[^;]*row\.current/.test(devicesSection), true);
  check("and only where the key is what is missing", /const rekeyable =[^;]*row\.hasKey === false/.test(devicesSection), true);
  check("and the button is gated on exactly that", /rekeyable &&/.test(devicesSection), true);
  /*
   * ⚠ **The verdict comes off the refreshed row, never off the registration.**
   * `POST /v1/me/devices` answers a row id whether or not the key was taken, so
   * "it answered" is not "it took" — and `=== false` here for the list's own
   * reason one block up: absent is *nobody said*, which on a control plane that
   * predates the column would report a re-key as refused on every machine.
   */
  check("and the verdict is read off the refreshed row", /listed\.hasKey === false/.test(devicesSection), true);
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
  /*
   * ⚠ **Comments stripped, `cp.ts`'s reads one block up for the same reason.**
   * Every assertion below searches for a rule these files also state in prose —
   * the keyring's two secrets, the fallback writer, the refusal to enumerate — so
   * a raw file satisfies the positive half whichever way round the *code* is, and
   * the cheapest route back to green would be deleting the explanation.
   *
   * Measured before the change and after, because a strip is only free if nothing
   * moves: all six answers in this block, and the secrets census, are identical
   * either way today. What it closes is the direction that goes quiet rather than
   * red — and it is load-bearing for the command sweep below, where the raw file
   * carries **20** occurrences of the attribute against 17 real ones, three of
   * them quoted by `commands.rs`'s own header, and where the first "body" the
   * sweep found began inside that header's `//!` at line 21 and ran 3760
   * characters to the first column-0 `}`.
   *
   * ⚠ **`stripComments` is a TypeScript stripper and these are Rust**, which is
   * safe for the reason that makes it look unsafe: `//!` and `///` both begin
   * `//`, so both go, and a Rust doc comment sits *above* the attribute it
   * documents, so removing one leaves a blank line and cannot merge two bodies.
   * The one hazard is a `//` inside a string literal, and the measurement is that
   * `commands.rs` holds none; the other three carry `https://` inside test
   * strings and every answer above is unchanged by it. Should a future edit put
   * one where it matters, the census below goes **red** rather than quiet.
   */
  const rust = (rel: string): string => stripComments(readFileSync(new URL(rel, NATIVE), "utf8"));
  const credentialRs = rust("credential.rs");
  const configRs = rust("config.rs");

  check("the device id is kept in the configuration file", /fn (read|write|erase)_device\b/.test(configRs), true);

  /*
   * ⚠ **The id and the key go to different places, and this pair is the assertion
   * that they have not been folded together.**
   *
   * An id is an identifier the server handed back; a key is a secret. The id must
   * survive a store that discards writes, or this app registers a new device every
   * launch and burns the account's limit — which is why it is in the file. The key
   * wants the keyring, and falls back to the same file **only** where the keyring
   * will not keep it, because the alternative for that machine is no remote access
   * at all.
   *
   * Two spellings, deliberately: `read_device` and `read_device_key` differ by a
   * suffix, so an anchored pattern is the only way to tell them apart and a lazy
   * one would call the feature done while it was half built.
   */
  check("and the device key is kept in the keyring", /fn read_device_key\b/.test(credentialRs), true);
  check(
    "with a fallback for a store that keeps nothing, in the file beside the id",
    /fn read_device_key_fallback\b/.test(configRs),
    true,
  );

  /*
   * The secret set grows by a **visible edit in one place**, which is the property
   * `credential.rs` states about itself and the whole reason it is a named set
   * rather than a string at each call site. This is that edit, so the expected
   * value moves with it rather than the assertion being deleted.
   */
  const secrets = [...credentialRs.matchAll(/^pub const (\w+): &str = /gm)].map((m) => m[1] ?? "");
  check("the keyring holds exactly two kinds of secret", secrets, ["CREDENTIAL", "DEVICE_KEY"]);
  // And it still has no way to enumerate, which is the half of that position
  // nothing here reverses: listing is what a key rotation wants, and shipping the
  // verb is shipping the feature.
  check("and still cannot be enumerated", /fn list\b/.test(credentialRs), false);

  /*
   * ⚠ **The one property the whole device binding rests on, and no type can hold
   * it: no command hands the private key to the page.**
   *
   * The shell answers with a public key and with the *output* of a
   * Diffie-Hellman, never with the key — that is what makes a capability's binding
   * worth something, because the page is the one place somebody else's JavaScript
   * could run. Read off the source, since both a key and a shared secret are
   * `String`s crossing one bridge and a swap between them would compile, run, and
   * be wrong only in a way nothing observable would show.
   */
  const commandsRs = rust("commands.rs");
  const deviceRs = rust("device.rs");
  /*
   * ⚠ **Both spellings of the attribute, because this sweep had gone silent over
   * exactly the commands it exists to watch.** `#[tauri::command]` takes
   * arguments, and the literal pattern matched only the bare form. Measured on
   * `commands.rs`: **7 bodies of 17 commands**, and the ten it dropped are the
   * `(async)` ones — `host_device_dh`, `host_device_key_reset`, `host_device_set`
   * and `host_device_clear`, which is every command that touches a device key,
   * among them. So the assertion below was being evaluated over a set of bodies
   * none of which was ever going to mention the key, and reading as green for it.
   *
   * ⚠ **A floor cannot notice that, which is why the census replaces it.** A
   * skipped body does not *lower* a count, it fails to raise one — so
   * `commandBodies.length > 5` sat green over seven real bodies and would sit
   * green over six. Differencing the bodies found against the attributes
   * *present* is the shape that can fail instead: any attribute spelling this
   * regex cannot turn into a body is a mismatch rather than an absence. It also
   * catches the strip damaging the file, since a swallowed closing brace merges
   * two bodies and lowers one side of that difference.
   *
   * The floor moves onto the attribute count for the same reason. `commandAttrs`
   * counts the attribute *name* and nothing after it, which no argument list can
   * shrink; the only edit that takes it to zero is the attribute being renamed,
   * and that has to be red here rather than a census passing on `0 === 0`.
   */
  const commandAttrs = [...commandsRs.matchAll(/#\[tauri::command/g)].length;
  const commandBodies = [...commandsRs.matchAll(/#\[tauri::command(?:\([^)]*\))?\][\s\S]*?\n\}/g)].map((m) => m[0]);
  const swept = commandBodies.map((body) => /\bfn (\w+)/.exec(body)?.[1] ?? "");
  report("the commands were found to read at all", commandAttrs > 5, `${String(commandAttrs)} declared`);
  check("⭐ and every one of them was read as a body", commandBodies.length, commandAttrs);
  /*
   * One `fn` per body, which is the third leg: a merged or truncated body is the
   * one way the strip above could damage this file, and it shows up here as an
   * unnamed entry rather than as a number nobody would question. Measured today,
   * all 17 hold exactly one function and exactly one attribute.
   */
  check("each of which is one named function", swept.filter((name) => name === ""), []);
  /*
   * And the named half, `DeviceRecord`'s census one block up for its reason: the
   * census is what makes an eighteenth command fail, while naming the four this
   * assertion exists for is what makes *this* failure legible rather than a diff
   * of two numbers. A hand-written list is the shape this repository has been
   * bitten by, and the direction is why this one is safe — a required-*member*
   * list goes red the moment a member is skipped, where a hand-written *count*
   * cannot go red at all.
   */
  check(
    "including every command that handles a device key",
    ["host_device_clear", "host_device_dh", "host_device_key_reset", "host_device_set"].filter(
      (one) => !swept.includes(one),
    ),
    [],
  );
  /*
   * Reported as function names rather than as whole bodies: the widened sweep
   * carries 2.9 KB of Rust and a failure here has to be one line somebody can
   * read. The predicate is unchanged.
   */
  check(
    "no command returns what the keyring holds for a device",
    commandBodies.filter((body) => /read_device_key\b/.test(body)).map((body) => /\bfn (\w+)/.exec(body)?.[1] ?? ""),
    [],
  );
  check(
    "and the module that does read it returns a shared secret instead",
    /fn diffie_hellman[\s\S]*?shared\.as_bytes\(\)/.test(deviceRs),
    true,
  );
  // The Noise specification's own refusal, and the reason it is here rather than
  // assumed: a peer offering a low-order point forces an all-zero shared secret
  // that both ends would agree on with neither having proved anything.
  check("and refuses a peer key that contributes nothing", /was_contributory\(\)/.test(deviceRs), true);
}
