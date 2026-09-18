#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The regression driver for the native shell, and its subject is a **shell
 * configuration** — which is why it is a file of its own rather than a section of
 * another driver. No other check here can see `tauri.conf.json`, a capability
 * file, or a `#[tauri::command]`: `typecheck` compiles no Rust and reaches no JSON,
 * `webcheck` is scoped to `packages/web`, and `pincheck` reads version sites by
 * literal path. So everything in this file would otherwise be asserted by the
 * `cargo` build alone, which is a separate CI job, or by nothing at all.
 *
 * The assertions cluster around five facts, and each was a real hazard before it
 * was a line:
 *
 *   1. **The frontend is bundled locally.** That is the whole point of a native
 *      app here — the server must not be able to replace the code running in it —
 *      and it is one JSON field away from being false, silently, with the app
 *      still working.
 *   2. **The webview's file drops still arrive.** Tauri intercepts OS drag-and-drop
 *      by default, which takes the composer's attachments and the code importer
 *      with it. The paperclip keeps working, so the failure reads as "drag-and-drop
 *      was never supported" rather than as a regression. Nothing else anywhere
 *      would catch it.
 *   3. **The capability surface is empty, and the version sites stay six.** An
 *      app-defined command is not ACL-gated, so `commands.rs` *is* the surface and
 *      the capability file should add nothing to it; and `tauri.conf.json` names a
 *      *path* to the root manifest rather than a number, so this release is still
 *      written down in the six places `docs/RELEASING.md` lists.
 *   4. **`packages/native` is not a member of the workspace.** Three separate
 *      things depend on that one line — the fleet's install weight, whether a
 *      native bump drops every relay tunnel, and whether the control plane's image
 *      still builds — and deleting it undoes all three at once. Q4.114 is the same
 *      argument at a larger number.
 *   5. **One rule, not two copies of one rule.** The schemes a link may open are
 *      `OPENABLE` in `packages/web/src/ui/links.ts`; `commands.rs` carries a second
 *      copy as a backstop, and this is what stops a second copy from becoming a
 *      second policy.
 *
 * Offline, one process, no network, no fleet, no agent — and **no `cargo`**, which
 * is the property that lets it join `pnpm check` beside the other eight. What
 * needs a Rust toolchain is the `native` job in `.github/workflows/check.yml`:
 * `tauri-build` compiles the capability files into an ACL and a `version` path that
 * does not resolve fails there, and neither is reachable from text.
 *
 *   pnpm nativecheck
 */

const root = new URL("../", import.meta.url);
const ROOT = fileURLToPath(root);

let failures = 0;

function check(name: string, got: unknown, want: unknown): void {
  if (JSON.stringify(got) === JSON.stringify(want)) {
    process.stdout.write(`  ok    ${name}\n`);
    return;
  }
  failures += 1;
  process.stdout.write(`  FAIL  ${name}\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}\n`);
}

/**
 * A property that holds, with the measurement beside it.
 *
 * `daemoncheck`, `relaycheck` and `webcheck` all grew one of these and this file
 * had not: every assertion here whose subject is really a *bound* — "the census
 * saw more than nothing", "both lists were non-empty" — had to be written as an
 * equality against `true`, which then says `ok` and nothing else. The detail
 * string is what keeps a non-vacuity report readable: "17 commands, 4 of them
 * declared with arguments" says something `ok` on its own does not, and it is the
 * half a reader needs when the question is whether the check still bites.
 */
function report(name: string, ok: boolean, detail: string): void {
  if (ok) {
    process.stdout.write(`  ok    ${name}  (${detail})\n`);
    return;
  }
  failures += 1;
  process.stdout.write(`  FAIL  ${name}  (${detail})\n`);
}

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

function json(rel: string): Record<string, unknown> {
  return JSON.parse(read(rel)) as Record<string, unknown>;
}

/**
 * One capture, or `null`, and never a throw.
 *
 * `pincheck`'s idiom: a pattern that stops matching must fail as a *readable*
 * assertion rather than as a stack trace, because the two want different fixes.
 */
function capture(text: string, re: RegExp): string | null {
  return re.exec(text)?.[1] ?? null;
}

/**
 * One function's body, cut between two anchors, or the empty string.
 *
 * ⚠ **`source.slice(source.indexOf(a), source.indexOf(b))` widens silently when
 * the *closing* anchor moves, and the `length > 0` floor beside every such slice
 * cannot see it.** A missing `indexOf` answers `-1`, and `String.slice` reads a
 * negative end as *counting from the end* — so the slice does not empty, it runs
 * to one character short of the file. Measured on the three call sites in this
 * file on 2026-09-17: `writeStored` 4078 → 32958 characters, `keyFallback`
 * 222 → 25776, `setServerBody` 465 → 7057 — every one of them with its floor
 * still printing `ok`.
 *
 * What that costs is the assertion, not the floor. Every positive line over such
 * a slice — "a device key is written through that one writer", "adopting a server
 * gives up the previous one's sign-in" — goes on matching, from **some other
 * function's body**, and says `ok` about a claim nothing checked any more. That is
 * the failure this repository keeps finding: an assertion that cannot fail.
 *
 * So both anchors have to be present and in order, and anything else is the empty
 * string, which is what the floors were written to catch. The opening anchor was
 * already covered — `slice(-1, b)` is empty — and this makes the pair symmetric
 * rather than accidentally half-safe.
 */
function between(source: string, from: string, to: string): string {
  const start = source.indexOf(from);
  const end = source.indexOf(to);
  if (start < 0 || end < 0 || end <= start) return "";
  return source.slice(start, end);
}

/**
 * Rust source with `cargo fmt`'s line breaking taken back out.
 *
 * ⚠ **Every assertion in this file that reads a `.rs` file reads *formatted*
 * source, and nothing in this job knows that.** `cargo fmt --check` is a step of
 * the `native` job, which needs a Rust toolchain; this driver is in the `check`
 * job and deliberately runs no cargo. So the two can disagree indefinitely, and
 * they did: the assertions below were written against source that had never been
 * through `rustfmt`, and the first run of `cargo fmt` broke nine of them at once
 * by wrapping three expressions past `max_width = 100`. Either job could be made
 * green on its own and never both.
 *
 * The rule this restores is that **an assertion is about what the code says, not
 * about where the lines end**. Only rustfmt's four line-breaking artefacts are
 * undone, so a pattern can be written the way the expression reads:
 *
 *   - runs of whitespace become one space — the wrap itself;
 *   - space around a `.` is dropped — a broken method chain puts the dot first;
 *   - space after `(` is dropped — arguments pushed onto their own lines;
 *   - a trailing `,` before `)` is dropped — rustfmt adds one when it wraps a
 *     call and there is none in the single-line form.
 *
 * ⚠ **For code, never for prose.** Collapsing whitespace around a `.` also runs
 * two sentences of a docblock together, so an assertion whose subject is a
 * *comment* must read the raw text. `wrap_comments` and `normalize_comments` are
 * both `false` under default rustfmt, which is what makes that safe: the comment
 * layer is not reflowed, so nothing about it needs this.
 */
function flat(rust: string): string {
  return rust
    .replace(/\s+/g, " ")
    .replace(/ ?\. ?/g, ".")
    .replace(/\( /g, "(")
    .replace(/,? \)/g, ")");
}

/**
 * The JSON names a serde-derived struct body actually answers to.
 *
 * ⚠ **Walked line by line rather than matched as one pattern, and that walk is the
 * whole thing being compared.** A field's JSON name is the `serde(rename = "…")`
 * on the line above it where there is one and its own Rust spelling where there is
 * not — so a single regex that got the lookbehind subtly wrong would answer a
 * *superset* of the real names and pass for ever, which is the one failure a
 * census of this kind cannot survive.
 *
 * `pub` is optional because both shapes are read through here: `Stored` in
 * `local.rs` is private to its module and every payload struct that crosses the
 * bridge is `pub`. One reader rather than one per caller, because this loop was
 * already written down twice — and the second copy was added by extracting the
 * first, with a comment saying so, which is exactly how a third would arrive.
 */
function rustJsonKeys(body: string): string[] {
  const keys: string[] = [];
  let pending: string | null = null;
  for (const line of body.split("\n")) {
    const rename = /serde\(rename = "(\w+)"\)/.exec(line);
    if (rename !== null) {
      pending = rename[1] ?? null;
      continue;
    }
    const field = /^\s{4}(?:pub )?(\w+): /.exec(line);
    if (field === null) continue;
    keys.push(pending ?? field[1] ?? "");
    pending = null;
  }
  return keys.sort();
}

/**
 * The property names a TypeScript interface body declares, optional ones included.
 *
 * Anchored at exactly two spaces, which is what keeps a docblock out of the
 * answer: a continuation line is `   * …` — three spaces then an asterisk — so the
 * `\w` after the indent never matches, and `{@link DaemonState.machineId}` inside
 * one cannot be read as a field.
 */
function tsInterfaceKeys(body: string): string[] {
  return [...body.matchAll(/^\s{2}(\w+)[?]?:/gm)].map((m) => m[1] ?? "").sort();
}

const NATIVE = "packages/native";
const TAURI_DIR = `${NATIVE}/src-tauri`;
const CONF = `${TAURI_DIR}/tauri.conf.json`;

/* ------------------------------------------------------------------ *
 * The frontend is inside the binary
 * ------------------------------------------------------------------ */

process.stdout.write("\nthe frontend, and where it comes from\n");

const conf = json(CONF);
const build = (conf["build"] ?? {}) as Record<string, unknown>;
const app = (conf["app"] ?? {}) as Record<string, unknown>;
const bundle = (conf["bundle"] ?? {}) as Record<string, unknown>;

check("tauri.conf.json names a frontendDist", typeof build["frontendDist"], "string");
const dist = String(build["frontendDist"]);
/*
 * `frontendDist` accepts a remote URL or a custom protocol as well as a path, and
 * a remote URL is exactly the shape this whole exercise exists to refuse: the app
 * would then load its own JavaScript from the server it is supervising, and the
 * server could replace it between launches.
 */
check("and it is a path rather than a URL", /^[a-z][a-z0-9+.-]*:/i.test(dist), false);
check(
  "which resolves to the web package's build output",
  resolve(ROOT, TAURI_DIR, dist),
  resolve(ROOT, "packages/web/dist"),
);
check(
  "there is no second copy of the frontend in this package",
  ["src", "dist", "index.html", "public"].filter((p) => existsSync(join(ROOT, NATIVE, p))),
  [],
);
/*
 * The dev server is the one place a URL belongs, and it is only read by
 * `tauri dev`. Pinned to loopback so a `devUrl` naming a deployed origin — which
 * would be the bundled-frontend rule broken in development, where it is hardest
 * to notice — fails here.
 */
const devUrl = build["devUrl"];
check(
  "the dev URL is a loopback dev server and nothing else",
  typeof devUrl === "string" && /^http:\/\/(localhost|127\.0\.0\.1):\d+\/?$/.test(devUrl),
  true,
);

/*
 * **The last way a chunk URL could point off-origin**, and it fails closed in the
 * quietest possible manner.
 *
 * `frontendDist` being a path decides where the *bundle* comes from; Vite's `base`
 * decides what the `<script src>` inside `index.html` says. Set to a URL, Vite
 * emits absolute module URLs and the shell's `script-src 'self'` refuses them —
 * so the app is a blank window with the reason in a console nobody has open on a
 * page that never painted. Absent today, which is what makes root-relative URLs
 * resolve against `tauri://localhost`.
 *
 * Checked as "names no scheme" rather than "is absent", because `base: "./"` and
 * `base: "/"` are both legitimate and neither leaves the origin.
 */
const viteConfig = read("packages/web/vite.config.ts");
check(
  "the web build emits no asset URL that could leave this origin",
  /base:\s*["'`][a-z][a-z0-9+.-]*:/i.test(viteConfig),
  false,
);

const windows = (app["windows"] ?? []) as Record<string, unknown>[];
check("there is a window to check", windows.length, 1);
const main = windows[0] ?? {};
check("it is the one the Rust side builds", main["label"], "main");
/*
 * `create: false` because `lib.rs` builds this window from this very config in
 * order to attach `on_navigation` — the one thing a configuration file cannot
 * express. With `create` left true there would be two windows, one of them
 * unguarded.
 */
check("and the configuration leaves creating it to Rust", main["create"], false);
check(
  "no window is pointed at a remote URL",
  windows.filter((w) => typeof w["url"] === "string" && /^https?:/i.test(String(w["url"]))),
  [],
);

/*
 * ⚠ **The assertion with no other symptom.**
 *
 * Tauri intercepts OS file drops by default and the `drop` event then never
 * arrives with files — so `packages/web/src/ui/Composer.tsx`'s attachment drop and
 * `ui/ImportCode.tsx`'s archive drop both stop working while the paperclip and the
 * file picker beside them keep working. Nothing in `webcheck` can see it, nothing
 * in the build can see it, and the shape of the failure invites the conclusion
 * that the feature never existed.
 */
check("OS file drops still reach the webview", main["dragDropEnabled"], false);

/*
 * What makes `packages/web` need **zero** `@tauri-apps/*` npm packages: this
 * global is the whole bridge surface, read through a hand-written interface in
 * `packages/web/src/native.ts`. The idiom is inherited rather than invented — the
 * deleted `telegram.ts` read `window.TelegramWebviewProxy` through exactly that
 * shape, and it went out of the tree with the mini-app host it served, so this is
 * the last place the pattern is described. Asserted from both sides, because either alone
 * would pass while the other broke — a dependency added to the web manifest ships
 * a native-only module inside the bundle the control plane's image serves.
 */
check("the bridge global is injected", app["withGlobalTauri"], true);
const webManifest = json("packages/web/package.json");
check(
  "and the web package depends on no @tauri-apps package",
  [...Object.keys(webManifest["dependencies"] ?? {}), ...Object.keys(webManifest["devDependencies"] ?? {})].filter(
    (name) => name.startsWith("@tauri-apps/"),
  ),
  [],
);

/* ------------------------------------------------------------------ *
 * Security: the CSP, and what is switched off
 * ------------------------------------------------------------------ */

process.stdout.write("\nthe policy this document carries, since no server sends it one\n");

const security = (app["security"] ?? {}) as Record<string, unknown>;
/*
 * ⚠ **`dangerousDisableAssetCspModification` and `dangerousRemoteDomainIpcAccess`
 * are the two keys that turn all of this off**, and both are invisible to every
 * other assertion here: the first stops Tauri adding the sources its own IPC needs
 * (so a policy that looks tighter is really a broken app), and the second hands
 * `invoke` to an origin nobody in this repository chose. Swept by prefix rather
 * than named, so a third one is covered on the day it is added.
 */
check(
  "nothing dangerous is switched on",
  Object.keys(security).filter((k) => /^dangerous/i.test(k)),
  [],
);

const csp = security["csp"];
check("the shell carries a CSP of its own", typeof csp === "string" && csp.length > 0, true);
const policy = String(csp);
const directives = new Map<string, string[]>(
  policy
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => {
      const [name, ...sources] = part.split(/\s+/);
      return [String(name), sources] as [string, string[]];
    }),
);

/*
 * **The same directive names the control plane sends, minus one.**
 *
 * Read off `packages/control-plane/src/app.ts` rather than transcribed, so a
 * directive added to the browser client's policy and forgotten here fails — which
 * is the shape of every CSP defect that document has had: `img-src` right and
 * `connect-src` wrong, or the reverse, with the reason only in a console nobody
 * has open.
 *
 * `frame-ancestors` is the declared difference: a window with no parent cannot be
 * framed, and the directive is meaningless on a document nothing embeds.
 */
const appTs = read("packages/control-plane/src/app.ts");
const browserDirectives = [...appTs.matchAll(/^\s*["`]([a-z-]+-src|base-uri|form-action|frame-ancestors) /gm)]
  .map((m) => m[1])
  .filter((name): name is string => name !== undefined);
const expected = [...new Set(browserDirectives)].filter((name) => name !== "frame-ancestors").sort();
check("the browser client's policy was readable at all", expected.length >= 9, true);
check("this policy names the same directives, minus frame-ancestors", [...directives.keys()].sort(), expected);

check("default-src is self", directives.get("default-src"), ["'self'"]);
check("script-src is self and nothing else", directives.get("script-src"), ["'self'"]);
check("object-src is none", directives.get("object-src"), ["'none'"]);
check("base-uri is self", directives.get("base-uri"), ["'self'"]);
check("form-action is self", directives.get("form-action"), ["'self'"]);
check("font-src is self", directives.get("font-src"), ["'self'"]);
/*
 * `blob:` because `ui/ImagePreview.tsx` builds one out of bytes it fetched with a
 * header, which is the *supported* way to see a file. `https:` because a plugin's
 * icon is read from an origin this client only learns from the wire, and a scheme
 * is the only bound a static policy can put on it. No `data:`, which the built
 * bundle does not need — measured on the browser client's own policy.
 */
check("img-src is self, blob and https", (directives.get("img-src") ?? []).sort(), ["'self'", "blob:", "https:"]);
/*
 * ⚠ **`connect-src` is the directive that can break everything**, and it is also
 * the one that cannot be written tightly here. The relay's origin arrives per
 * machine from `POST /v1/tokens`, so it is not knowable at build time; the browser
 * client gets it in a header the control plane builds from the same variable it
 * publishes, and a bundled app has no such header. So the bound is the scheme, and
 * the thing that actually holds is `script-src 'self'` above.
 *
 * The control plane must **not** appear here: `/v1/*` goes over IPC, so a
 * control-plane origin in `connect-src` would mean the transport split had quietly
 * stopped being one.
 */
const connect = directives.get("connect-src") ?? [];
check("connect-src reaches a relay over both of its schemes", ["https:", "wss:"].every((s) => connect.includes(s)), true);
check(
  "and carries nothing but schemes and self",
  connect.filter((s) => s !== "'self'" && !/^[a-z][a-z0-9+.-]*:$/.test(s)),
  [],
);
check("no source anywhere is a wildcard", policy.includes("*"), false);
check("and eval is never allowed", /unsafe-eval/.test(policy), false);

/* ------------------------------------------------------------------ *
 * The capability surface
 * ------------------------------------------------------------------ */

process.stdout.write("\nwhat the webview is allowed to reach\n");

const capDir = join(ROOT, TAURI_DIR, "capabilities");
const caps = readdirSync(capDir).filter((f) => f.endsWith(".json"));
check("there are capability files to check", caps.length >= 1, true);

const granted: string[] = [];
for (const file of caps) {
  const cap = JSON.parse(readFileSync(join(capDir, file), "utf8")) as Record<string, unknown>;
  check(`${file} names the windows it applies to`, cap["windows"], ["main"]);
  check(`${file} grants nothing to a remote origin`, Object.hasOwn(cap, "remote"), false);
  /*
   * `description` rather than a comment, because a capability file is JSON and
   * this repository's comment layer is its specification. A capability with no
   * description is one whose reason has to be reconstructed.
   */
  check(`${file} says why it is what it is`, typeof cap["description"] === "string", true);
  for (const permission of (cap["permissions"] ?? []) as unknown[]) {
    granted.push(typeof permission === "string" ? permission : JSON.stringify(permission));
  }
}
/*
 * **Empty, and pinned as an exact list rather than as a ceiling.**
 *
 * Two different mistakes want two different lines: a permission that crept in, and
 * a line pinning something nobody uses. Commands this app defines are allowed to
 * every window without an entry, and the three Tauri plugins here are driven from
 * Rust — so a JS permission for `dialog`, `clipboard-manager` or `opener` would be
 * a door the webview could walk through on a page that renders agent output.
 */
check("the granted permission set is empty", granted.sort(), []);
check(
  "and no plugin the Rust side drives is reachable from the page",
  granted.filter((p) => /^(dialog|clipboard-manager|opener|http|fs|shell|updater):/.test(p)),
  [],
);
check("no permission is a wildcard", granted.filter((p) => p.includes("*")), []);

/* ------------------------------------------------------------------ *
 * One rule, not two copies of one rule
 * ------------------------------------------------------------------ */

process.stdout.write("\nthe schemes a link may open, from both sides\n");

/*
 * `packages/web/src/ui/links.ts` holds the policy and the argument for it:
 * anything outside these three is *"launching a program named by an agent-chosen
 * string"*, on a page that renders agent output. `commands.rs` carries a second
 * copy as the half that holds if the page is ever wrong — and a second copy of a
 * rule is only safe while something compares them.
 */
const linksTs = read("packages/web/src/ui/links.ts");
const openableTs = capture(linksTs, /const OPENABLE = new Set\(\[([^\]]*)\]\)/);
check("the web client's allowlist was readable", openableTs !== null, true);
const webSchemes = [...(openableTs ?? "").matchAll(/"([a-z]+):"/g)]
  .map((m) => m[1])
  .filter((s): s is string => s !== undefined)
  .sort();

const commandsRs = read(`${TAURI_DIR}/src/commands.rs`);
const openableRs = capture(commandsRs, /const OPENABLE_SCHEMES: \[&str; \d+\] = \[([^\]]*)\]/);
check("the shell's allowlist was readable", openableRs !== null, true);
const rustSchemes = [...(openableRs ?? "").matchAll(/"([a-z]+)"/g)]
  .map((m) => m[1])
  .filter((s): s is string => s !== undefined)
  .sort();

check("both lists were found to be non-empty", [webSchemes.length > 0, rustSchemes.length > 0], [true, true]);
check("and they are the same set", rustSchemes, webSchemes);

/* ------------------------------------------------------------------ *
 * The command surface, from three directions
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * The file a daemon writes, and the file this shell reads
 * ------------------------------------------------------------------ */

process.stdout.write("\nthe announcement, from both sides of it\n");

/*
 * **One shape, written down twice, compared** — the same rule as `OPENABLE` below
 * and for a sharper reason. `src/announce.ts` is the only writer of
 * `~/.reemoat/daemon.json` and `local.rs` is the only reader, and they are in
 * different languages in different packages built by different toolchains. A field
 * renamed on one side is not a compile error anywhere: it is a local route that
 * silently stops being offered, on a fleet that goes on working through the relay,
 * with nothing in any log. Nobody would find it.
 *
 * The version is compared too. It is the field that decides whether a reader
 * *tries*, so two numbers drifting apart is the same failure arriving deliberately.
 */
{
  const ts = read("src/announce.ts");
  const rs = read("packages/native/src-tauri/src/local.rs");

  const written = capture(ts, /export interface LocalAnnounce \{([\s\S]*?)\n\}/);
  check("the daemon's side of the shape was readable", written !== null, true);
  const writtenKeys = [...(written ?? "").matchAll(/^\s{2}(\w+)[?]?:/gm)].map((m) => m[1] ?? "").sort();

  const stored = capture(rs, /struct Stored \{([\s\S]*?)\n\}/);
  check("and the shell's side of it", stored !== null, true);
  /*
   * `rustJsonKeys` is that walk, and its docblock carries the argument for why it
   * is a walk: a field's JSON name is the `rename` on the line above it when there
   * is one and its own name when there is not, and a single regex that got the
   * lookbehind subtly wrong would answer a *superset* and pass for ever.
   */
  const readJsonKeys = rustJsonKeys(stored ?? "");

  check("both sides were found to have fields", [writtenKeys.length > 0, readJsonKeys.length > 0], [true, true]);
  check("and the daemon writes exactly what the shell reads", writtenKeys, readJsonKeys);

  check(
    "the version the daemon stamps is the version the shell accepts",
    capture(ts, /export const ANNOUNCE_VERSION = (\d+);/),
    capture(rs, /const ANNOUNCE_VERSION: u32 = (\d+);/),
  );
}

/* ------------------------------------------------------------------ *
 * The second pair: what the shell hands the page at first paint
 *
 * `Boot` in `commands.rs` is serialized straight into `NativeBoot` in
 * `native.ts`, and **nothing compared them** — which is the same hole the pair
 * above exists to close, on the one struct every launch reads.
 *
 * ⚠ **The specific failure, and it is silent in five checkers at once.** `Boot`
 * carries no `#[serde(rename_all = "camelCase")]`; every camelCase field names
 * itself with its own `rename`. So a `pub device_id: Option<String>` added
 * without one serializes as `device_id`, `boot.deviceId` is `undefined` for ever,
 * and `tsc`, `cargo`, `cargo test`, `webcheck` and the command census below are
 * all green. The app then decides on every single launch that it has no device,
 * registers another, and walks into the account's device limit — with the only
 * evidence being a list of identically-named rows. `local.rs`'s docblock names
 * this class in so many words: *"A field renamed on one side is not a compile
 * error anywhere… Nobody would find it."*
 *
 * The reader is `rustJsonKeys`, shared with the pair above: a field's JSON name is
 * the `rename` on the line before it where there is one and its own name where
 * there is not.
 * ------------------------------------------------------------------ */

{
  const ts = read("packages/web/src/native.ts");

  const declared = capture(ts, /export interface NativeBoot \{([\s\S]*?)\n\}/);
  check("the page's side of the boot payload was readable", declared !== null, true);
  const pageKeys = tsInterfaceKeys(declared ?? "");

  const boot = capture(commandsRs, /pub struct Boot \{([\s\S]*?)\n\}/);
  check("and the shell's side of it", boot !== null, true);
  const hostKeys = rustJsonKeys(boot ?? "");

  check("both sides were found to have fields", [pageKeys.length > 0, hostKeys.length > 0], [true, true]);
  check("and the shell sends exactly what the page declares", hostKeys, pageKeys);

  /*
   * And the negative control, because the reader above is what the assertion
   * rests on: a struct that renames nothing must come back with its Rust
   * spellings, or the reader is silently answering the page's names whatever the
   * source says and the comparison is vacuous.
   */
  const renames = [...(boot ?? "").matchAll(/serde\(rename = "(\w+)"\)/g)].length;
  check(
    "the reader is actually reading renames rather than assuming them",
    renames > 0 && hostKeys.some((key) => /[A-Z]/.test(key)),
    true,
  );
  /*
   * ⚠ **Comments stripped first, and that is not fussiness.** Written against the
   * raw text this fails immediately — on the docblock of the very field that
   * explains why there is no `rename_all`. A source-text assertion that cannot
   * tell code from prose about the code is the shape `webcheck` already carries
   * `stripComments` for, and the failure here is the loud direction; the quiet
   * one is the same reader passing over a *commented-out* attribute.
   *
   * The attribute would sit in the derive above `pub struct`, outside the body
   * captured above, so the preamble is included.
   */
  const bootDecl = capture(commandsRs, /((?:#\[[^\]]*\]\s*)*pub struct Boot \{[\s\S]*?\n\})/) ?? "";
  const bootCode = bootDecl
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
  check(
    "and `rename_all` is still absent, which is why each field needs its own",
    /#\[serde\([^)]*rename_all/.test(bootCode),
    false,
  );
  // The negative control for the strip itself: the prose that mentions the
  // attribute is in the file, so a reader that saw nothing would pass above for
  // the wrong reason.
  check("the strip had something to remove", bootDecl.length > bootCode.length, true);
}

/* ------------------------------------------------------------------ *
 * The other three payloads, which had no census at all
 *
 * ⚠ **`Boot` is not the only struct that crosses this bridge by hand-written
 * `serde(rename)`, and it was the only one anybody was watching.** The block above
 * states the failure in full — a camelCase field that forgets its own `rename`
 * serializes under its Rust spelling, the page reads `undefined` for ever, and
 * `tsc`, `cargo`, `cargo test`, `webcheck` and the command census are all green.
 * Nothing about that argument is specific to `Boot`. Three more payloads are shaped
 * exactly the same way and were reaching the page on trust:
 *
 *   - `DeviceKey` (`device.rs`) — `publicKey` and `atRest`. Drop either `rename`
 *     and `hostDeviceKeyReset` answers an object with the right *shape* and the
 *     wrong *keys*: `fresh.publicKey` is `undefined`, `boot.devicePublicKey` is
 *     overwritten with it, and the Devices screen shows a re-key that appears to
 *     have worked while the app now holds no public half to register. That is the
 *     `wrong_device` loop `e2ee.md` describes, arriving from the inside.
 *   - `DaemonState` (`daemon.rs`) — `machineId` and `exitCode`. The setup screen
 *     polls this once a second; `exitCode` is the *structured* half of "why did it
 *     stop", and its docblock says in so many words that it is the reason no arm
 *     in the store reads the log. A dropped `rename` makes `3` (the control plane
 *     refused the code) and `4` (it could not be reached) both read as `null`,
 *     which is the arm for "signalled, or we did not start it" — so the one screen
 *     that could offer a fresh code offers nothing.
 *   - `CpAnswer` (`proxy.rs`) — `statusText`. `answerToResponse` passes it to
 *     `new Response`, and `undefined` there is not an error: it becomes the empty
 *     string, so every control-plane error in the native build quietly loses its
 *     reason phrase.
 *
 * ⚠ **The page's side of `DeviceKey` is an inline return type, not an interface**,
 * which is why this reads `hostDeviceKeyReset`'s signature rather than a named
 * declaration. That is worth saying out loud rather than working around silently:
 * the two-field object is written twice inside `native.ts` itself — once on the
 * return type and once on the `invoke<…>` — and neither is a type this file could
 * have found by name.
 * ------------------------------------------------------------------ */

{
  const nativeTs = read("packages/web/src/native.ts");
  const deviceRs = read(`${TAURI_DIR}/src/device.rs`);
  const daemonRsRaw = read(`${TAURI_DIR}/src/daemon.rs`);
  const proxyRs = read(`${TAURI_DIR}/src/proxy.rs`);

  const payloads = [
    {
      what: "the device key",
      source: deviceRs,
      struct: "DeviceKey",
      // The one inline page-side type here. `[^}]*` is safe because the object has
      // no nested braces; a nested one would stop matching rather than answer a
      // truncated list, which is the direction a broken pattern has to fail in.
      page: () =>
        [
          ...(capture(nativeTs, /export async function hostDeviceKeyReset\(\): Promise<\{([^}]*)\}>/) ?? "").matchAll(
            /(\w+):/g,
          ),
        ]
          .map((m) => m[1] ?? "")
          .sort(),
    },
    {
      what: "the daemon's state",
      source: daemonRsRaw,
      struct: "DaemonState",
      page: () => tsInterfaceKeys(capture(nativeTs, /export interface DaemonState \{([\s\S]*?)\n\}/) ?? ""),
    },
    {
      what: "a control-plane answer",
      source: proxyRs,
      struct: "CpAnswer",
      // Not exported: the bridge answers it and `answerToResponse` consumes it in
      // the same module, so the pattern may not require an `export`.
      page: () => tsInterfaceKeys(capture(nativeTs, /\binterface CpAnswer \{([\s\S]*?)\n\}/) ?? ""),
    },
  ] as const;

  for (const payload of payloads) {
    const body = capture(payload.source, new RegExp(`pub struct ${payload.struct} \\{([\\s\\S]*?)\\n\\}`));
    check(`${payload.what}: the shell's side of the payload was readable`, body !== null, true);
    const hostKeys = rustJsonKeys(body ?? "");
    const pageKeys = payload.page();

    report(
      `${payload.what}: both sides were found to have fields`,
      hostKeys.length > 0 && pageKeys.length > 0,
      `${hostKeys.length} in ${payload.struct}, ${pageKeys.length} in native.ts`,
    );
    check(`${payload.what}: the shell sends exactly what the page declares`, hostKeys, pageKeys);

    /*
     * The same negative control `Boot` carries, and for the same reason: the
     * comparison above rests entirely on `rustJsonKeys` reading renames rather
     * than assuming them. Each of these three has at least one camelCase field
     * that exists **only** because of a `rename`, so a reader that silently
     * answered the page's spellings would still pass the equality and fail here.
     */
    const renames = [...(body ?? "").matchAll(/serde\(rename = "(\w+)"\)/g)].map((m) => m[1] ?? "");
    report(
      `${payload.what}: the reader is reading renames rather than assuming them`,
      renames.length > 0 && renames.every((name) => hostKeys.includes(name)) && hostKeys.some((k) => /[A-Z]/.test(k)),
      renames.length === 0 ? "no rename in the struct at all" : `${renames.length}: ${renames.join(", ")}`,
    );

    /*
     * And that `rename_all` is still absent, which is the premise the whole census
     * rests on — with the derive included in the capture, since the attribute would
     * sit above `pub struct` rather than in the body, and with comments stripped
     * first because two of these three carry prose that names the attribute.
     */
    const decl =
      capture(payload.source, new RegExp(`((?:#\\[[^\\]]*\\]\\s*)*pub struct ${payload.struct} \\{[\\s\\S]*?\\n\\})`)) ?? "";
    const code = decl
      .split("\n")
      .filter((line) => !/^\s*\/\//.test(line))
      .join("\n");
    check(`${payload.what}: and each field still needs its own rename`, /#\[serde\([^)]*rename_all/.test(code), false);
    /*
     * The one thing the loop cannot state generically: the derive has to be there
     * at all. A struct that stopped deriving `Serialize` would keep every `rename`
     * attribute, keep passing every line above, and cross no bridge.
     */
    check(`${payload.what}: and the struct is still serialized`, /derive\([^)]*Serialize/.test(decl), true);
  }
}

process.stdout.write("\nthe commands, declared against registered\n");

const libRs = read(`${TAURI_DIR}/src/lib.rs`);

/**
 * The attribute, in **both** its forms.
 *
 * ⚠ **`#[tauri::command]` takes arguments, and a pattern matching only the bare
 * literal drops every command that uses them — silently, in the direction that
 * reads as passing.** `commands.rs` says it in its own header: the bare form runs
 * the body on the main thread, the one the webview paints on, and
 * `#[tauri::command(async)]` runs it on the async runtime instead. **Most of this
 * surface carries the argument form** — anything that waits on a socket, on a disk
 * flush, on a platform panel or on a child process — and the moment the first of
 * them was changed, the census below stopped seeing it.
 *
 * ⚠ **The count is deliberately not restated here.** `commands.rs`'s own header
 * gives the reason — "a count restated in a comment is exactly the kind of claim
 * `docs/DECISIONS.md` records this repository learning not to keep" — and it has
 * been wrong twice in that file and once in this sentence, which read *four* while
 * ten commands used the argument form. The `report` at the bottom of this section
 * prints the live pair instead: how many commands there are, and how many of them
 * are declared with arguments.
 *
 * What is worth naming is the **counter-example**, because it is the reason this
 * can never be shortened into a census of `async fn`: `host_cp` is an `async fn`
 * under a **bare** attribute, and the macro gives it the same treatment without
 * being asked. The attribute is the fact here; the signature is not. (That
 * sentence named `host_cp` as one of the four for a while, which is the same class
 * of error as the count.)
 *
 * What that costs is both directions at once. "Every command the Rust declares is
 * registered" goes on saying `ok` over a list short of the truth by however many
 * commands use the argument form, so a command declared and never registered is no
 * longer caught; and the stray sweep at the bottom — whose whole job is to notice
 * a door opened in another file —
 * cannot see an `(async)` one there either. Neither failure has a symptom: the app
 * builds, the command works, and the check that was supposed to be watching the
 * surface is watching part of it.
 *
 * So the argument list is optional in the pattern, and the source is written once
 * and spliced into both readers rather than typed twice — a second copy is how
 * this became two patterns that had to be fixed separately in the first place.
 */
const COMMAND_ATTR = String.raw`#\[tauri::command(?:\([^)]*\))?\]`;

const declared = [...commandsRs.matchAll(new RegExp(`${COMMAND_ATTR}\\s*(?:pub\\s+)?(?:async\\s+)?fn\\s+(\\w+)`, "g"))]
  .map((m) => m[1])
  .filter((n): n is string => n !== undefined)
  .sort();
const handlerList = capture(libRs, /generate_handler!\[([\s\S]*?)\]/);
check("the handler list was readable at all", handlerList !== null, true);
const registered = [...(handlerList ?? "").matchAll(/commands::(\w+)/g)]
  .map((m) => m[1])
  .filter((n): n is string => n !== undefined)
  .sort();

check("there are commands to check", declared.length > 0, true);
/*
 * Both directions, each on its own line, for `pincheck`'s reason: a declared
 * command nobody registered is a dead function, and a registered one nobody
 * declared does not compile — but the *third* case is the expensive one and needs
 * the bridge to exist, so it lives beside the bridge in `webcheck`.
 */
check("every command the Rust declares is registered", declared.filter((c) => !registered.includes(c)), []);
check("and every command registered is declared", registered.filter((c) => !declared.includes(c)), []);
/*
 * One file holds the surface, so reading one file is reading all of it. A
 * `#[tauri::command]` somewhere else would be a door that this driver's census —
 * and any future reader's — would simply not see.
 */
const strayCommands: string[] = [];
for (const file of readdirSync(join(ROOT, TAURI_DIR, "src"))) {
  if (file === "commands.rs" || !file.endsWith(".rs")) continue;
  if (new RegExp(COMMAND_ATTR).test(readFileSync(join(ROOT, TAURI_DIR, "src", file), "utf8"))) strayCommands.push(file);
}
check("and every command lives in commands.rs", strayCommands, []);

/*
 * ⚠ **And the non-vacuity report for the widening itself.**
 *
 * The three lines above are only stronger than the bare literal while some command
 * actually uses the argument form. If the last `(async)` were taken off, the
 * optional group would stop being exercised, nothing here would go red, and the
 * next command declared with arguments would drop out of the census exactly as the
 * argument-form ones did — with the same absence of a symptom. Counting both
 * spellings separately is what makes that visible: the census has to be *larger*
 * than the bare count, not merely non-empty.
 *
 * ⚠ **Comments stripped before counting, and this is the file where that matters
 * most.** `commands.rs` opens by explaining the difference between the two forms
 * and quotes both of them in its own header; a later docblock quotes
 * `#[tauri::command(async)]` again as a standing TODO. Counted raw, the arguments
 * total came out at six against four real ones when this was written, and twelve
 * against ten when it was last re-measured (2026-09-17) — so a report whose whole
 * job is to say how much of the surface is exercised would have been reporting the
 * prose about the surface. The measurement is dated because the *gap* is the
 * subject rather than either number, and it widens as the file grows.
 */
const commandsCode = commandsRs.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/[^\n]*$/gm, "");
const bareAttrs = (commandsCode.match(/#\[tauri::command\]/g) ?? []).length;
const argAttrs = (commandsCode.match(/#\[tauri::command\([^)]*\)\]/g) ?? []).length;
report(
  "the census reaches the argument form of the attribute, not only the bare one",
  argAttrs > 0 && declared.length > bareAttrs,
  `${declared.length} commands, ${argAttrs} of them declared with arguments`,
);

/* ------------------------------------------------------------------ *
 * Versions: the two this package does not add
 * ------------------------------------------------------------------ */

process.stdout.write("\nthe versions, and the six that stay six\n");

const rootManifest = json("package.json");
const rootVersion = String(rootManifest["version"]);
const confVersion = conf["version"];

/*
 * **A path, not a number.** `docs/RELEASING.md` says all six sites move together in
 * one commit; a literal here would make it seven, in a file `pincheck` reads by
 * literal path and therefore would not read at all. Tauri resolves this against
 * the config file's own directory and takes the `version` field out of it.
 */
check(
  "tauri.conf.json's version is a path rather than a literal",
  typeof confVersion === "string" && !/^\d/.test(confVersion),
  true,
);
check(
  "and the path it names is the repository's root manifest",
  resolve(ROOT, TAURI_DIR, String(confVersion)),
  resolve(ROOT, "package.json"),
);

const cargoToml = read(`${TAURI_DIR}/Cargo.toml`);
const cargoVersion = capture(cargoToml, /^version = "([^"]+)"$/m);
check("Cargo.toml's version was readable", cargoVersion !== null, true);
check("and it is the inert one", cargoVersion, "0.0.0");
/*
 * The negative earns its place: it makes "somebody bumped it in sympathy with the
 * release" a failure rather than a seventh site nobody notices.
 */
check("which is deliberately not this release's", cargoVersion !== rootVersion, true);

const nativeManifest = json(`${NATIVE}/package.json`);
check("the native package declares no version of its own", Object.hasOwn(nativeManifest, "version"), false);
check("and it is private", nativeManifest["private"], true);

const cliPin = capture(read(`${NATIVE}/package.json`), /"@tauri-apps\/cli":\s*"([^"]+)"/);
const cratePin = capture(cargoToml, /^tauri = \{ version = "([^"]+)"/m);
const buildPin = capture(cargoToml, /^tauri-build = \{ version = "([^"]+)"/m);
check("the CLI pin was readable", cliPin !== null, true);
check("and it is exact rather than a range", /^\d+\.\d+\.\d+$/.test(cliPin ?? ""), true);
check("the tauri crate pin was readable", cratePin !== null, true);
check("and so was tauri-build's", buildPin !== null, true);
/*
 * The major and not the exact version: the CLI and the crates are published on
 * their own release lines and pinning them equal would be pinning a coincidence.
 * What actually breaks is a major drift, and that is what this says.
 */
check(
  "the CLI and both crates are the same major",
  [cliPin, cratePin, buildPin].map((v) => (v ?? "").split(".")[0]),
  ["2", "2", "2"],
);
/*
 * And the one line that compares a file to what would actually be *built*, rather
 * than to another file: `pincheck`'s argument for reading `node_modules`.
 */
const lockedTauri = capture(read(`${TAURI_DIR}/Cargo.lock`), /\nname = "tauri"\nversion = "([^"]+)"\n/);
check("Cargo.lock is committed and readable", lockedTauri !== null, true);
check("and the locked tauri is the one Cargo.toml asks for", lockedTauri, cratePin);

/* ------------------------------------------------------------------ *
 * Placement: out of the workspace, out of the image
 * ------------------------------------------------------------------ */

process.stdout.write("\nwhere this package sits, and the three things that depend on it\n");

const workspace = read("pnpm-workspace.yaml");
/*
 * ⚠ **One line, three consequences**, and all three are invisible from here:
 * `@tauri-apps/cli` and its platform binary would install on every daemon host in
 * the fleet (`deploy/bootstrap.sh` and `deploy/deploy.sh` both run an unfiltered
 * root install); `deploy/deploy.sh`'s `RELAY_INPUTS` matches `pnpm-lock.yaml`, so
 * a Tauri bump would recreate the relay container and drop every tunnel; and the
 * control plane's image would stop building, because `--frozen-lockfile` verifies
 * the lockfile against every importer and the build context cannot see this one.
 * Q4.114 is the same argument at 552 MB.
 */
check("the root workspace excludes this package", /^\s*-\s*'!packages\/native'\s*$/m.test(workspace), true);
/*
 * Exclusion alone is not enough: pnpm resolves a root by searching *upwards*, so
 * `pnpm install` in here found the repository's root, installed the three projects
 * it lists and left this one with no `node_modules` — silently, exit 0.
 */
const ownRoot = read(`${NATIVE}/pnpm-workspace.yaml`);
check("and this package is its own pnpm root", /^\s*-\s*'\.'\s*$/m.test(ownRoot), true);
check(
  "which lists itself and nothing else",
  [...ownRoot.matchAll(/^\s*-\s*'([^']+)'\s*$/gm)].map((m) => m[1]),
  ["."],
);
check("so the root lockfile holds no importer for it", read("pnpm-lock.yaml").includes("packages/native"), false);

/*
 * The control plane is a service that spawns nothing and draws nothing native, so
 * none of this belongs in its image. `.dockerignore` is deny-first, so the
 * assertion is that nothing allows it back in and that no COPY line names it —
 * the twice-written file list, held to saying nothing about this package twice.
 */
check("no .dockerignore line allows this package into the build context", /^!packages\/native/m.test(read(".dockerignore")), false);
check("and no Dockerfile stage copies it", read("deploy/docker/Dockerfile").includes("packages/native"), false);

/*
 * The root `tsconfig.json` compiles `packages/*​/src/**​/*.ts` and
 * `packages/*​/scripts/**​/*.ts` under `lib: ["ES2023"]`, `types: ["node"]` and
 * NodeNext — correct for everything that runs under `tsx`, and unable to compile a
 * line mentioning `window`. This package holds no TypeScript at all, so it needs
 * no exception; a `.ts` appearing here would be compiled by the daemon's config,
 * and a `.tsx` by nothing. Asserted rather than excluded, because an `exclude`
 * would make the second case silent.
 */
const strayTs: string[] = [];
const sweep = (dir: string, base: string): void => {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    if (/^(node_modules|target|gen)$/.test(entry)) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) sweep(path, `${base}/${entry}`);
    else if (/\.tsx?$/.test(entry)) strayTs.push(`${base}/${entry}`);
  }
};
sweep(join(ROOT, NATIVE), NATIVE);
check("this package holds no TypeScript, so no config has to claim it", strayTs, []);

/*
 * And the driver that walks `packages/` still skips what this package builds.
 * Measured at 2.9 GB after one `cargo check`: left in, `docscheck` reads every
 * `.json` fingerprint in there into its symbol corpus, which is assertion 4 of
 * that driver switched off in the direction that reads as passing.
 */
const docscheckSrc = read("scripts/docscheck.ts");
const skipDir = capture(docscheckSrc, /const SKIP_DIR = \/\^\(([^)]+)\)\$\//);
check("docscheck's directory skip was readable", skipDir !== null, true);
check(
  "and it skips both trees this package generates",
  ["target", "gen"].filter((d) => !(skipDir ?? "").split("|").includes(d)),
  [],
);
/*
 * And the same driver can read this package's Rust at all, which is the other half
 * of the same edit: `src-tauri/src` is where the control-plane proxy, the keyring
 * keying rule and the navigation rule live, so a decision citing one of their
 * symbols has to be able to resolve. Safe **only** with the skip above — a corpus
 * that reached a build tree would read every vendored crate in it.
 */
const sourceExt = capture(docscheckSrc, /const SOURCE_EXT = \/\\\.\(([^)]+)\)\$\//);
check("docscheck's extension list was readable", sourceExt !== null, true);
check("and it reads Rust", (sourceExt ?? "").split("|").includes("rs"), true);
/*
 * Not `toml`, and the negative is the assertion: `Cargo.toml` is a manifest of
 * dependency names and `Cargo.lock` a larger one, which is the hazard that driver
 * already refuses about `pnpm-lock.yaml` — a corpus of dependency names lets a
 * stale symbol resolve to somebody else's package.
 */
check("and not a manifest of dependency names", (sourceExt ?? "").split("|").includes("toml"), false);

const gitignore = read(".gitignore");
check(
  "and neither tree is tracked",
  [`${TAURI_DIR}/target/`, `${TAURI_DIR}/gen/schemas/`].filter((p) => !gitignore.includes(p)),
  [],
);

/* ------------------------------------------------------------------ *
 * The daemon payload, and the two sweeps it has to stay out of
 * ------------------------------------------------------------------ */

process.stdout.write("\nthe daemon this app carries, and where it is allowed to sit\n");

const STAGE = "packages/native/scripts/build-daemon.mjs";
const stage = read(STAGE);

/*
 * **The runtime is an `externalBin` and the payload is a `resources` entry, and
 * swapping them is the failure this pair exists to catch.**
 *
 * `externalBin` lands in `Contents/MacOS/` and is signed as nested code;
 * `resources` lands in `Contents/Resources/` and is not reliably signed at all.
 * `node` is the only Mach-O in the payload — everything else is JavaScript, since
 * `node:sqlite` is built in and the whole dependency set is pure JS — so it is the
 * only thing that has to be in the first list, and putting the JS tree there
 * instead would put 200 MB through a code-signing walk that has nothing to sign.
 */
const externalBin = (bundle["externalBin"] ?? []) as string[];
check("the runtime is an external binary", externalBin, ["binaries/node"]);
/*
 * ⚠ **The map form, not the list form.** `resource_relpath` in `tauri-utils` maps
 * `..` to a literal `_up_` path segment, so a list entry reaching out of
 * `src-tauri` lands at `Resources/_up_/_up_/…` and `resource_dir().join("daemon")`
 * finds nothing. The map form honours the destination it is given. Asserted as the
 * whole object rather than the key, because the destination is what `daemon.rs`
 * joins onto and a renamed value is a path that resolves to nothing at runtime.
 */
check("the payload is a resource, by the map form", bundle["resources"], { "target/daemon/": "daemon" });
/*
 * ⚠ **`target/` is not a tidiness choice, it is what keeps two other drivers
 * honest**, and it is the one thing about this staging directory that has to be
 * asserted rather than remembered.
 *
 * The payload is a verbatim copy of `src/`, `scripts/` and `deploy/`. Staged
 * anywhere else under `packages/native` it would be caught by this file's own
 * no-TypeScript sweep — which is the *good* failure. The bad one is `docscheck`:
 * it walks the working tree rather than `git ls-files`, so a second copy of every
 * `.ts` in `src/` would enter its symbol corpus, and assertion 4 there would start
 * answering `true` for symbols that no longer exist anywhere real. That is that
 * driver switched off in the direction that reads as passing. `SKIP_DIR` already
 * holds `target`, so the destination is chosen to land inside a skip that exists
 * rather than to need a new one.
 */
const stageDest = Object.keys((bundle["resources"] ?? {}) as Record<string, unknown>)[0] ?? "";
check("and it is staged under target/, which both sweeps already skip", stageDest.startsWith("target/"), true);
check("the staging script is where the config expects it", existsSync(join(ROOT, STAGE)), true);
/*
 * **Staged by its own step, never by `beforeBuildCommand`.** Resources and
 * external binaries are copied from inside `build.rs`, so they are read by *cargo*
 * — `cargo clippy`, `cargo test` and `tauri build --no-bundle` all fail with
 * `ResourcePathNotFound` if the directory is absent, and the `native` CI job runs
 * all three. A `beforeBuildCommand` runs for `tauri build` alone and would leave
 * those three broken on a clean checkout. Both manifests are asserted because the
 * root script is what CI calls and the package script is what actually stages.
 */
check(
  "the root exposes a staging step",
  /"native:stage":\s*"pnpm --dir packages\/native run stage"/.test(read("package.json")),
  true,
);
const nativePkg = read(`${NATIVE}/package.json`);
check("the package defines it", /"stage":\s*"node scripts\/build-daemon\.mjs"/.test(nativePkg), true);
/*
 * And both cargo-driving scripts run it first. Not a convenience: `tauri dev` runs
 * `build.rs` exactly like `tauri build` does, so a developer who has never staged
 * gets `ResourcePathNotFound` from a Rust build rather than a missing payload.
 */
for (const script of ["dev", "build"] as const) {
  check(
    `\`${script}\` stages before it reaches cargo`,
    new RegExp(`"${script}":\\s*"node scripts/build-daemon\\.mjs && tauri `).test(nativePkg),
    true,
  );
}
/*
 * ⚠ **The runtime is downloaded and verified, never copied off the build machine.**
 * `process.execPath` on this checkout is Homebrew's, and `otool -L` names seven
 * Homebrew dylibs under it (`@rpath/libnode.147.dylib`, `libuv`, `libada`, …) — a
 * bundle built from it runs on the machine that built it and nowhere else. And
 * since what is fetched is an executable that will be signed with this project's
 * identity and run as the user, the checksum step is not optional hygiene.
 */
check("the runtime is fetched from nodejs.org", /const NODE_DIST = "https:\/\/nodejs\.org\/dist"/.test(stage), true);
check("and verified against the release's own manifest", /SHASUMS256\.txt/.test(stage) && /checksum mismatch/.test(stage), true);
/*
 * ⚠ **A cache is valid only if the thing it caches is there, and this asked the
 * directory.**
 *
 * `existsSync(extracted)` answered `true` for a directory that had been emptied,
 * so the script reported *(cached)* and handed back a tree with no `bin/node` —
 * surfacing two functions later as `spawnSync … ENOENT` on a path whose own name
 * says "cache", which reads as a corrupt download. It broke CI on
 * `97d1e58`, having been poisoned by the run before it.
 *
 * Two independent ways in, which is why both halves are pinned. `Swatinem/rust-cache`
 * treats every subdirectory of `target/` as a build profile and cleans what it
 * does not recognise before saving — so the cache lived somewhere another tool
 * owns, and a green run saved the directory without its 130 MB binary. And
 * locally, `run()` aborts the script on a non-zero exit, so an interrupted `tar`
 * leaves a partial directory that every later run then trusts.
 *
 * The correctness half is validating by the **file about to be executed**; the
 * cost half is not living under `target/` at all. Neither replaces the other: the
 * first makes a poisoned cache a re-download instead of a failure, the second
 * stops it being poisoned every run.
 */
check("the runtime cache is validated by the binary, not the directory", /existsSync\(binary\)/.test(stage), true);
check("and a directory that lost its binary is refetched", /rmSync\(extracted, \{ recursive: true, force: true \}\)/.test(stage), true);
check(
  "and it does not live where rust-cache prunes",
  /const cacheDir = join\(tauriRoot, "\.node-cache"\)/.test(stage),
  true,
);
check("and it is gitignored under its new name", /^packages\/native\/src-tauri\/\.node-cache\/$/m.test(gitignore), true);
/*
 * ⚠ **And the workflow caches the directory the script actually writes to.** The
 * path is now written down twice — once in `build-daemon.mjs`, once in
 * `check.yml` — and a mismatch is silent in the direction that costs the most: CI
 * saves an empty path, every run re-downloads 50 MB, and nothing anywhere is red.
 * That is the `.dockerignore`/Dockerfile hazard `CLAUDE.md` already names, at a
 * smaller scale, and it gets the same treatment: read both off disk.
 *
 * The cache key is pinned to `NODE_VERSION` rather than to the script's hash —
 * the file changes far more often than the version does, and a key that churns is
 * a cache that never hits.
 */
const checkWorkflow = read(".github/workflows/check.yml");
check(
  "the workflow caches the directory the staging script writes to",
  /path: packages\/native\/src-tauri\/\.node-cache/.test(checkWorkflow),
  true,
);
check(
  "and keys that cache on the pinned runtime version",
  /steps\.node-runtime\.outputs\.version/.test(checkWorkflow),
  true,
);
/*
 * **The payload must contain no symlink, and the script asserts it itself.** The
 * bundler's `copy_file` refuses anything that is not a regular file and its walker
 * does not follow links, so one symlink is a `cargo build` that dies with
 * `"… is not a file"` — reported as a broken Rust build rather than as a packaging
 * mistake. Pinned here so the self-check cannot be deleted as redundant.
 */
check("the payload refuses to contain a symlink", /function assertNoSymlinks/.test(stage), true);
/*
 * ⚠ **The runtime is placed once, and this assertion exists because it was twice.**
 *
 * The payload needs a `node` inside `node_modules/.bin` — the package shims test
 * `$basedir/node`, and `deploy/agents.sh` resolves the runtime as the node *beside*
 * npm. Copying the binary there satisfies both and costs **122 MB, byte-identical
 * to the `externalBin` copy**: measured at 360 MiB projected for the bundle against
 * 244 MiB without it. Nothing failed, nothing warned, and the only symptom was a
 * download twice the size it needed to be.
 *
 * A symlink is what this wants and is the one thing the bundler cannot copy, so
 * what sits there is a shim. Asserted as "writes a shim, does not copy the binary"
 * rather than by measuring the staged tree, because this driver has to pass on a
 * clean checkout where nothing has been staged yet.
 */
check(
  "the runtime is placed once and reached by a shim",
  /for candidate in .*MacOS\/node/.test(stage) && !/cpSync\(node, join\(binDir/.test(stage),
  true,
);
/*
 * ⚠ **The 552 MB that must not come back.** The two ACP adapters each pull a
 * coding-agent CLI as *optional* platform packages, which `pnpm-workspace.yaml`'s
 * `overrides` strip from the pnpm tree for the reasons Q4.114 gives at length.
 * npm has no equivalent of pnpm's `'-'`, so the payload drops the whole optional
 * set — and `deploy/docker/Dockerfile` already measured what that costs on its own
 * ("`--no-optional` would take esbuild's own platform binary with it and break
 * `tsx`"), which is why exactly one of them is named back in.
 */
check("optional dependencies are dropped from the payload", /"--omit=optional"/.test(stage), true);
/*
 * ⚠ **And every target names esbuild's binary back in — checked per target, not
 * once.** This is the assertion that would have gone vacuous the day a second
 * platform was added: one `ESBUILD_BINARY` constant covering macOS would pass
 * while a Linux build silently shipped a `tsx` with no compiler behind it. The
 * table is the unit, so the check counts it.
 */
const triples = [...stage.matchAll(/"([a-z0-9_]+-[a-z0-9-]+)":\s*\{\s*dir:/g)].map((m) => m[1]);
const withEsbuild = [...stage.matchAll(/esbuild:\s*"(@esbuild\/[a-z0-9-]+)"/g)].map((m) => m[1]);
check("more than one platform is described", triples.length > 1, true);
check("and every one of them names an esbuild binary", withEsbuild.length, triples.length);
/*
 * ⚠ **The workspace package the payload would otherwise ship without, and three
 * lines are the whole of it.**
 *
 * `@reemoat/protocol` holds the Noise handshake the daemon speaks to an app. It is
 * a pnpm *workspace* package, so in this checkout `node_modules/@reemoat/protocol`
 * is a link into `packages/protocol` — and the bundler copies no symlink, which is
 * why `build-daemon.mjs` writes a real directory instead. Nothing asserted that it
 * did, and the failure that leaves is the worst shape a packaging bug comes in:
 * take the three lines out and `typecheck`, every driver, `pnpm native:stage` and
 * `cargo build` all still succeed, while the **shipped app's daemon dies at its
 * first start** on `Cannot find module '@reemoat/protocol'`. It is a *static*
 * import on the entry path — `scripts/daemon.ts` imports `ensureMachineKey` from
 * `src/machinekey.ts`, which imports the package at load — so the process is gone
 * before it has listened on anything, and there is no green-versus-red anywhere
 * between the edit and a person's machine.
 *
 * Only the manifest and the sources are copied, deliberately: copying the package
 * whole would follow its own `node_modules`, every entry of which is a pnpm link,
 * and `dereference` would turn each into a full copy of a tree the payload root
 * already has. So both halves are named, because a payload with the manifest and
 * no `src` resolves the package and then fails on its entry point instead.
 */
check(
  "the payload carries the protocol package as a real directory",
  /join\(stageDir, "node_modules", "@reemoat", "protocol"\)/.test(stage),
  true,
);
check(
  "and copies its manifest",
  /cpSync\(join\(repoRoot, "packages", "protocol", "package\.json"\), join\(protocol, "package\.json"\)\)/.test(stage),
  true,
);
check(
  "and its sources, dereferenced",
  /cpSync\(join\(repoRoot, "packages", "protocol", "src"\), join\(protocol, "src"\), \{\s*recursive: true,\s*dereference: true,\s*\}\)/.test(
    stage,
  ),
  true,
);
/*
 * And the non-vacuity half, which is the part that decides whether the three
 * assertions above are worth anything. They pin a copy; what makes the copy
 * load-bearing is that the daemon's own entry point reaches the package at import
 * time. Read off `src/` rather than assumed, because the day nothing there imports
 * it the copy is dead weight and these lines should be deleted rather than kept
 * green — and the day the *first* import lands in a file the payload does not carry,
 * the count is what says so.
 */
/*
 * ⚠ **Value imports only.** The first spelling of this counted
 * `/["']@reemoat\/protocol["']/` over raw source, which matched
 * `src/relay/tunnel.ts`'s `import type { StaticKey }` — erased by TypeScript and
 * requiring nothing at runtime — and `src/relay/protocol.ts`'s *comment* naming
 * the package. Two of the four matches were not imports at all, so the report
 * would have stayed green in the one world it exists to rule out: every
 * remaining reference erased and the payload copy genuinely dead weight.
 */
const importsProtocolAtLoad = (source: string): boolean =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "")
    .split("\n")
    .some((line) => /["']@reemoat\/protocol["']/.test(line) && !/^\s*(?:import|export)\s+type\b/.test(line));
const protocolImporters = readdirSync(join(ROOT, "src"), { recursive: true, encoding: "utf8" })
  .filter((rel) => rel.endsWith(".ts"))
  .filter((rel) => importsProtocolAtLoad(readFileSync(join(ROOT, "src", rel), "utf8")));
report(
  "and the daemon really needs it: src/ imports it at load",
  protocolImporters.length > 0 && importsProtocolAtLoad(read("scripts/daemon.ts")),
  `${protocolImporters.length} value importer(s) under src/: ${protocolImporters.sort().join(", ")}`,
);
/*
 * **The runtime binary is a build input and never a tracked file.** 122 MB, and
 * the one staged artifact that cannot live under `target/` — `externalBin`
 * resolves relative to `src-tauri`, not to the cargo profile directory.
 */
check(
  "the staged runtime is gitignored",
  /^packages\/native\/src-tauri\/binaries\/$/m.test(read(".gitignore")),
  true,
);

/* ------------------------------------------------------------------ *
 * Distribution: configured, and inert
 * ------------------------------------------------------------------ */

process.stdout.write("\nwhat shipping this would take, and what is switched off until then\n");

check("the identifier is not Tauri's placeholder", conf["identifier"] !== "com.tauri.dev", true);
/*
 * ⚠ **`dmg` is not a default target, and that is a measurement rather than a
 * preference.** Tauri's `bundle_dmg.sh` drives Finder over AppleScript to lay the
 * disk image window out, and from a non-interactive shell that times out:
 * `execution error: Finder got an error: AppleEvent timed out. (-1712)`, measured
 * 2026-09-14 — after the `.app` had already been built correctly. So with `dmg` in
 * this list the ordinary `pnpm native:build` fails on a machine nobody is logged
 * into, including every CI runner, *having produced the artifact that matters*.
 * `--bundles dmg` from a logged-in session is the documented way to get one, and
 * `docs/NATIVE.md` carries it.
 */
check(
  "the disk image is not bundled by default",
  ((bundle["targets"] ?? []) as string[]).includes("dmg"),
  false,
);
check("but an app bundle is", ((bundle["targets"] ?? []) as string[]).includes("app"), true);
const mac = (bundle["macOS"] ?? {}) as Record<string, unknown>;
/*
 * Hardened runtime on, because notarization requires it and turning it on later is
 * the kind of change that reveals an entitlement was missing all along.
 */
check("the hardened runtime is on", mac["hardenedRuntime"], true);
check("an entitlements file is named", typeof mac["entitlements"], "string");
check("and it exists", existsSync(join(ROOT, TAURI_DIR, String(mac["entitlements"]))), true);
/*
 * **Two Mach-O binaries, two signatures, two entitlement sets — and the split is
 * the assertion.**
 *
 * The app's set stays at one entitlement: this is the signature on the window
 * holding the fleet's credential. The bundled runtime's is five, because V8
 * cannot start under the hardened runtime without them — and they were *measured*
 * off the official build's own signature (`codesign -d --entitlements -`) rather
 * than chosen, so this list is what the people who build V8 ask for.
 *
 * Pinned as exact sets in both directions. A key added to the app's file is a
 * loosening of the wrong process — `disable-library-validation` there would mean
 * any dylib could be loaded into the window — and a key dropped from the
 * runtime's is a daemon that will not start once signing is switched on, which is
 * a failure nobody would see until the first signed build.
 */
const keysOf = (rel: string): string[] =>
  [...read(rel).matchAll(/<key>([^<]+)<\/key>/g)].map((m) => m[1] ?? "").sort();
check("the app's entitlements stay at exactly one", keysOf(`${TAURI_DIR}/entitlements.plist`), [
  "com.apple.security.network.client",
]);
check("the runtime has its own file", existsSync(join(ROOT, TAURI_DIR, "entitlements-node.plist")), true);
check("and it carries exactly what V8 needs", keysOf(`${TAURI_DIR}/entitlements-node.plist`), [
  "com.apple.security.cs.allow-dyld-environment-variables",
  "com.apple.security.cs.allow-jit",
  "com.apple.security.cs.allow-unsigned-executable-memory",
  "com.apple.security.cs.disable-executable-page-protection",
  "com.apple.security.cs.disable-library-validation",
]);
/*
 * ⚠ **`get-task-allow` is the one key in that measurement that must never be
 * copied**, and it is asserted absent rather than left to the exact-set check
 * above — because the failure it describes deserves its own sentence. It lets
 * another process attach a debugger and read the daemon's memory: every
 * transcript, the machine's signing keys, `identity.tunnel_key`. Node ships it
 * because Node's own builds are debuggable. Notarization rejects it, which is the
 * only reason anybody would find it by accident rather than by reading this.
 */
check(
  "and never the debug entitlement Node ships with",
  read(`${TAURI_DIR}/entitlements-node.plist`).includes("get-task-allow</key>"),
  false,
);
/*
 * ⚠ **The macOS floor is 13.0 because the *opt-in* background service needs it.**
 *
 * The daemon is an ordinary child process of this app and dies with it, which is
 * the default and needs no floor at all. What needs 13 is the switch beside it:
 * `SMAppService` is how a login item gets registered such that macOS owns it,
 * shows it in System Settings, and — the part that decides it — **removes it when
 * the app is deleted**. The alternative is a plist written by hand into
 * `~/Library/LaunchAgents`, which with `KeepAlive` survives the app being dragged
 * to the trash and relaunches a missing binary every ten seconds for ever.
 *
 * Pinned rather than left to drift, because lowering it would compile, install,
 * and then fail at the one call that matters — on the oldest machines, which are
 * the population least likely to report it. 11 and 12 are out of support, and the
 * nearest prior art in this space ships the same floor.
 */
check("the macOS floor is where the opt-in service starts", mac["minimumSystemVersion"], "13.0");
/*
 * ⚠ **Inert, and asserted inert.** With no `signingIdentity` a build is ad-hoc
 * signed and runs locally, which is what makes a development build work on a
 * machine with no certificate. A value committed here would be somebody's identity
 * in a public repository; signing is driven entirely by the environment —
 * `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` — so
 * neither an unsigned local build nor a signed release needs this field to move.
 */
check("no signing identity is committed", mac["signingIdentity"], null);
check("and no notarization provider is either", mac["providerShortName"], null);

/* ── the default server, and its absence here ────────────────────────────── */

/**
 * **Which fleet a build joins, and why this repository names none.**
 *
 * `option_env!("REEMOAT_DEFAULT_SERVER")` is the only build-time input this app
 * has. It is read in Rust rather than on the page for two reasons that both point
 * the same way: `native.ts` refuses `import.meta.env`-style flags in that layer,
 * and `host_cp`'s base has to live in the host process where the page cannot
 * reach it — which is the same string the OS keyring account is built from.
 *
 * ⚠ **Asserted absent, exactly as `signingIdentity` is.** This is AGPL software
 * and forks run their own control planes, so a value compiled in here would be
 * one deployment's address in everybody's binary. `cp-accounts.md` makes the same
 * argument for the two `REEMOAT_CP_*` addresses that reach the browser, and both
 * are for the same reason without a compiled-in default.
 */
const configRs = flat(read(`${TAURI_DIR}/src/config.rs`));
check(
  "the default server comes from the environment at compile time",
  /option_env!\("REEMOAT_DEFAULT_SERVER"\)/.test(configRs),
  true,
);
check("and nothing hard-codes one beside it", /const DEFAULT_SERVER: Option<&str> = Some\(/.test(configRs), false);
/*
 * Through the one normalizer, because a suggested value and a typed one have to
 * be the same spelling of the same server — two spellings is two credential keys,
 * one of which a sign-out would not reach.
 */
check("the suggestion goes through the one normalizer", /normalize_origin\(DEFAULT_SERVER\?\)/.test(configRs), true);
/*
 * ⚠ **`option_env!` is baked into a cached object file.** Without this line cargo
 * has no reason to recompile when the variable moves, so a fork that corrects its
 * address gets a binary silently keeping the previous one — a failure with no
 * symptom anywhere, which is why it is asserted rather than remembered.
 */
check(
  "cargo is told to notice the variable changing",
  /cargo:rerun-if-env-changed=REEMOAT_DEFAULT_SERVER/.test(read(`${TAURI_DIR}/build.rs`)),
  true,
);
/*
 * ⚠ **A suggestion for a form field, and never a value anything writes down.**
 * The first draft seeded it — first launch with a default compiled in wrote it to
 * `server.json` — and that was wrong twice: it skipped the setup screen, so the
 * app chose a fleet and said so afterwards on the sign-in form; and it created a
 * `credential#<origin>` keyring account for an origin nobody had confirmed.
 *
 * So `read_server` stays the **only** reader of *which server*, the shell calls
 * it and nothing else, and `default_server` is a second function answering a
 * second question. The two are held apart here because folding them is exactly
 * the edit that would pass every other assertion in this file.
 */
const shellRs = flat(read(`${TAURI_DIR}/src/lib.rs`));
check("the shell reads the chosen server and nothing else", /config::read_server\(&dir\)/.test(shellRs), true);
check("and never writes one at startup", /read_or_seed_server|write_server/.test(shellRs), false);
check("the suggestion is its own function", /pub fn default_server\(\) -> Option<String>/.test(configRs), true);
check("and it writes nothing", /fn default_server[\s\S]{0,200}write_server/.test(configRs), false);
/*
 * And it reaches the page as its own field. `Boot`/`NativeBoot` key equality is
 * asserted elsewhere in this file; what that cannot say is that the two fields
 * stay two.
 */
const commandsSrc = flat(read(`${TAURI_DIR}/src/commands.rs`));
check("the suggestion crosses the bridge under its own name", /rename = "defaultServer"/.test(commandsSrc), true);
check("and the chosen server is still a separate field", /pub server: Option<String>/.test(commandsSrc), true);
/*
 * **And no file in this repository supplies a value.** The sweep is over every
 * place a build is described — the native package, the root manifest, `deploy/`
 * and the workflows — for the name followed by an assignment. The
 * `rerun-if-env-changed=` declaration above is safe because there the `=`
 * *precedes* the name.
 */
const setters: string[] = [];
for (const file of [
  "package.json",
  `${NATIVE}/package.json`,
  `${TAURI_DIR}/tauri.conf.json`,
  ".github/workflows/check.yml",
  ".github/workflows/release.yml",
]) {
  if (/REEMOAT_DEFAULT_SERVER\s*[=:]\s*\S/.test(read(file))) setters.push(file);
}
check("and no file in this repository sets one", setters, []);

/* ── the private key in a file, and the mode it is created at ─────────────── */

/**
 * ⚠ **The device key's file fallback is a private key in plaintext, and what
 * bounds it is a mode set at `open` time.**
 *
 * `read_device_key_fallback`'s own docblock is blunt about why the file exists at
 * all — a Linux box with no D-Bus session or no unlocked collection accepts a
 * keyring write and keeps nothing, and the alternative to a file is an
 * installation that regenerates its static on every launch and spends a device
 * slot each time. So the file is the lesser failure, and the mode is the entire
 * difference between it and a bad one.
 *
 * `write_stored` is the single writer for all three of `server.json`'s subjects —
 * the origin, the device ids and the device keys — and it used to be `fs::write`.
 * That is wrong in three ways the docblock above it records at length, and the one
 * this pins is the first: `fs::write` creates at `0666 & !umask`, which is `0644`
 * under the default, on precisely the machines where "world-readable" has somebody
 * in it to read. Three docblocks and `.claude/rules/e2ee.md` said `0600` while no
 * line of code anywhere did.
 *
 * ⚠ **Asserted here although `cargo test` covers it, and the reason is which job
 * each runs in.** `config.rs`'s own tests do check the resulting mode — but they
 * need a Rust toolchain, so they live in the `native` job while this driver is in
 * `check` and deliberately runs no cargo. That is `flat`'s standing hazard at the
 * top of this file: the two can disagree indefinitely and either can be made green
 * on its own. A regression back to `fs::write` would leave both this assertion and
 * that test red, which is what makes it a regression rather than a discussion.
 */
const writeStored = between(configRs, "fn write_stored(", "pub fn read_device(");
check("the writer behind the fallback was found to read", writeStored.length > 0, true);
/*
 * The mode at **creation**, which is the half that closes the window in which the
 * bytes exist at the umask's mode — `write_private` records that ordering bug, and
 * a `set_permissions` after the fact is a fix with a race in it.
 */
check("the file is created with an explicit 0600", /options\.mode\(0o600\);/.test(writeStored), true);
check("and through OpenOptions rather than fs::write", /fs::OpenOptions::new\(\)/.test(writeStored), true);
check("and fs::write appears nowhere in it", /fs::write\(/.test(writeStored), false);
/*
 * And again on the open handle, which is what makes it exactly `0600` rather than
 * `0600 & !umask`: a umask carrying owner bits leaves `0400` at `0277` and nothing
 * readable at all at `0677`, and a key file this same user cannot read back on the
 * next launch is the regenerate-every-launch failure the file exists to prevent.
 */
check(
  "and narrowed again on the handle, against a umask with owner bits",
  /file\.set_permissions\(fs::Permissions::from_mode\(0o600\)\)/.test(writeStored),
  true,
);
/*
 * The mode on the **directory** is set on every write rather than only where
 * `create_dir_all` made one, because it left `0755` on every machine so far — the
 * same upgrade argument the rename below carries for the file.
 */
check(
  "and the directory is narrowed on every write",
  /fs::set_permissions\(dir, fs::Permissions::from_mode\(0o700\)\)/.test(writeStored),
  true,
);
/*
 * ⚠ **And it is a fresh inode, not the one that is already there.** A `server.json`
 * an earlier build created at `0644` keeps that mode for ever through any writer
 * that opens the existing file, so a fix that set a mode only at creation would
 * leave every installation in the field world-readable while passing every test
 * that starts from an empty directory. The rename is what narrows them.
 */
check("and the narrowed file replaces the old inode by rename", /fs::rename\(&tmp, &target\)/.test(writeStored), true);

/*
 * That the *device key* really goes through that writer, which is the link the two
 * halves hang on: a `write_device_key_fallback` that grew a writer of its own
 * would leave every assertion above green over a key file nothing narrows.
 */
const keyFallback = between(configRs, "pub fn write_device_key_fallback(", "pub fn erase_device_key_fallback(");
check("the fallback writer was found to read", keyFallback.length > 0, true);
check("a device key is written through that one writer", /write_stored\(dir, &stored\)/.test(keyFallback), true);
check("and never by a writer of its own", /fs::(write|OpenOptions|File)/.test(keyFallback), false);

/* ── what a `server.json` nobody can use is allowed to cost ──────────────── */

/**
 * ⚠ **Read with the comments taken out, and every pattern below is why.**
 * `config.rs` states each of these rules in prose directly above the code that
 * holds it — "`replaceable` is `false` and `write_stored` refuses", "the first one
 * wins" — so over the raw file a search for the *code* is satisfied by the
 * paragraph explaining it, and the cheapest route back to green is deleting the
 * explanation. `daemonSrc` below already strips for exactly this; `configRs`
 * above deliberately does not, because the assertions there are about names a
 * docblock cannot contain.
 *
 * **What this section is about.** `server.json` is the only copy of an X25519
 * device private key on a keyring-less host, so what `read_stored` decides about
 * a file it cannot use is a decision about that key. The census below is the six
 * arms that decide it — five states a stored file can be in that are not the
 * ordinary one, plus the ordinary one — and they do **not** answer one thing each:
 * three of them answer `true`, two answer `quarantine(dir)`, and one answers
 * `false`. So what a reader has to keep straight is the mapping rather than a
 * count, which is why the list is written out below and not tallied.
 *
 * ⚠ **This sentence read "there are four states and each answers a different
 * pair", 26 lines above a census that enumerates six arms sharing three answers.**
 * It was false on both halves, and it is the kind of false that costs something
 * here: the whole point of the census is that no number about these arms is
 * trustworthy unless it is differenced against the source.
 *
 * Three defects lived in the gaps between these arms: invalid UTF-8 classified as
 * a read failure, which is permanent and froze every configuration write on that
 * installation; a quarantine that preserved nothing and authorized the overwrite
 * anyway; and a superseded key retained in the quarantine for ever after a re-key.
 *
 * ⚠ **A census rather than a count, because a count cannot see a skipped arm.**
 * The list below is derived from the source in source order and compared for
 * equality against a hand-written one, so a new arm, a missing arm, a reordering
 * and a changed answer are each a different red line. `cargo test` covers the
 * *behaviour* — it is the `native` job and needs a toolchain; this is the `check`
 * job, which compiles no Rust, and the two can disagree indefinitely.
 */
const configCode = flat(
  read(`${TAURI_DIR}/src/config.rs`)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, ""),
);
const readStored = between(configCode, "fn read_stored(", "fn sync_dir(");
check("the reader behind every writer was found to read", readStored.length > 0, true);
const arms = [
  ...readStored.matchAll(
    /(ErrorKind::\w+|Err\(_\)|Ok\(parsed\)) => \((?:Stored::default\(\)|parsed), (true|false|quarantine\(dir\))\)/g,
  ),
].map(([, arm, answer]) => `${arm} => ${answer}`);
check("every state a stored file can be in, and what each one authorizes", arms, [
  // Nothing there: the whole truth, and a write proceeds.
  "ErrorKind::NotFound => true",
  // A directory at the path: nothing this app wrote is in it to lose, and POSIX
  // refuses `rename(file, directory)` so the one destructive statement cannot run.
  "ErrorKind::IsADirectory => true",
  // ⚠ Bytes that are not UTF-8. `read_to_string` does the decoding, so this is the
  // one read failure with **no errno** — evidence about the bytes rather than a
  // syscall saying no, and never transient. In the catch-all below it made the
  // file unreplaceable for ever: no quarantine, no replacement, and every
  // configuration write on that installation refused until somebody moved it by
  // hand — silently, on `host_device_set` and `host_device_clear`.
  "ErrorKind::InvalidData => quarantine(dir)",
  // Every read failure that *does* carry an errno: evidence of nothing about the
  // bytes, so they are neither moved nor replaced.
  "Err(_) => false",
  "Ok(parsed) => true",
  // Bytes that will not deserialize, and the answer is whatever the quarantine
  // managed rather than an unconditional `true`.
  "Err(_) => quarantine(dir)",
]);
/*
 * ⚠ **And the quarantine has to be able to say it preserved nothing.** It
 * answered `()`, so both of its failing paths — the slot already taken by an
 * earlier corruption, and a `rename` that did not land — left the caller marking
 * the file replaceable. After one recovery that is exactly backwards: the
 * retained copy holds what the *first* failure reduced the file to, and the bytes
 * being overwritten are the current key.
 */
check("the quarantine answers whether the bytes are actually aside", /fn quarantine\(dir: &Path\) -> bool/.test(configCode), true);
check("and its rename is read rather than discarded", /let _ = fs::rename\(/.test(configCode), false);
/*
 * And nothing calls it for its effect alone: a bare statement is an answer thrown
 * away, which is the shape that shipped. The lookbehind is what keeps
 * `discard_quarantine(dir);` — a different function, whose answer is genuinely
 * nothing — from satisfying this.
 */
check("and no caller drops that answer on the floor", /(?<!\w)quarantine\(dir\);/.test(configCode), false);
/*
 * ⚠ **The superseded key, and the two statements it takes to give one up.** A
 * quarantined `server.json` can hold a recoverable private key — a truncation past
 * the base64 leaves the key legible and the JSON unparseable — and nothing removed
 * it, so the Devices screen's **Re-key** gave up the keyring copy and the
 * `server.json` copy and left that one on disk for ever.
 *
 * ⚠ **The first fix put the removal on `erase_device_key_fallback`, and that is
 * the statement `device::store_secret` reaches too** — on every keyring-verified
 * first use, through `device::ensure_key`. A **promotion** to the keyring is not a
 * key given up; the docblock claiming *"`ensure_key`'s first-use path never comes
 * here"* was false the day it was written, and the path that survives its early
 * return is a `device_keys` entry `device::decode_key` rejects, where a quarantine
 * that may hold the legible copy was discarded over a key nobody gave up. So the
 * two acts are two functions, and this pair of assertions is which is which: the
 * promotion must reach no quarantine at all, and `give_up_device_key` — the one
 * `device::reset_key` calls — must reach it only after a write that landed.
 */
const eraseKey = between(configCode, "pub fn erase_device_key_fallback(", "pub fn give_up_device_key(");
check("the statement a promotion reaches was found to read", eraseKey.length > 0, true);
check("promoting a key to the keyring rewrites server.json and nothing else", /discard_quarantine/.test(eraseKey), false);
const giveUp = between(configCode, "pub fn give_up_device_key(", "pub fn normalize_origin(");
check("the statement a re-key reaches was found to read", giveUp.length > 0, true);
check(
  "giving up a file-held key drops the copy it supersedes, after the write that landed",
  /erase_device_key_fallback\(dir, origin\)\?; discard_quarantine\(dir, origin\); Ok\(\(\)\)/.test(giveUp),
  true,
);
/*
 * ⚠ **And never a file about some other server.** The removal was the **whole**
 * `server.json.unreadable` for one release, which is a sweep behind a per-origin
 * button: re-keying server A destroyed the last hand-recoverable copy of server
 * B's key. The argument for it — "a second server can only lose something already
 * superseded, because each origin is regenerated the first time it is used" —
 * fails on *the first time it is used*, which for a server nobody has opened since
 * the corruption has not happened. So the removal is guarded by a read of the
 * bytes, and the guard is asserted **in the same statement as the removal**: a
 * pattern matching `remove_file` alone would stay green with the guard deleted.
 */
check(
  "and the removal is guarded by what those bytes name, in the same statement",
  /fn discard_quarantine\(dir: &Path, origin: &str\) \{ if !quarantine_is_only_about\(dir, origin\) \{ return; \} let _ = fs::remove_file\(unreadable_file\(dir\)\); \}/.test(
    configCode,
  ),
  true,
);
/*
 * One definition and one caller, which is what keeps the split above from being
 * undone by a third statement growing its own removal.
 */
check(
  "and no other statement in the module reaches for it",
  configCode.replace(giveUp, "").split("discard_quarantine(").length - 1,
  1,
);
/*
 * The caller side, in the one file that has it. `device::reset_key` is the Devices
 * screen's Re-key and `device::store_secret` is the promotion; swapping which
 * function each reaches is the single edit that puts the defect back with every
 * assertion above still green.
 */
const deviceCode = flat(
  read(`${TAURI_DIR}/src/device.rs`)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, ""),
);
const resetKey = between(deviceCode, "pub fn reset_key(", "pub fn diffie_hellman(");
check("the re-key was found to read", resetKey.length > 0, true);
check("a re-key gives up the quarantined copy too", /config::give_up_device_key\(dir, origin\)/.test(resetKey), true);
const storeSecret = between(deviceCode, "fn store_secret(", "pub fn ensure_key(");
check("the promotion was found to read", storeSecret.length > 0, true);
check("and a promotion takes the other door", /config::erase_device_key_fallback\(dir, origin\)/.test(storeSecret), true);
check("and only that one", /give_up_device_key/.test(storeSecret), false);


/* ── what adopting a server gives up ─────────────────────────────────────── */

/**
 * ⚠ **Two rules at one call site, answering oppositely, and neither had ever been
 * asserted.** `host_set_server` erases the previous origin's *credential* — a
 * credential this app will not present is one it has no reason to hold, and doing
 * it in the same act is what makes "no credential is retained for a server you
 * are not using" true of the act rather than of an intention.
 *
 * It erases the previous origin's *device id* nowhere, and must not learn to:
 * the row on that server still exists, so forgetting the id leaves an
 * installation nobody can recognise in their own list and spends a second slot
 * against the account's limit on the way back. `cp-devices.md` is the argument.
 */
const setServer = flat(read(`${TAURI_DIR}/src/commands.rs`));
const setServerBody = between(setServer, "pub fn host_set_server", "pub fn host_credential_set");
check("the sweep can see host_set_server at all", setServerBody.length > 0, true);
check("adopting a server gives up the previous one's sign-in", /credential::erase\(&previous\)/.test(setServerBody), true);
check("and never the device recorded for it", /erase_device/.test(setServerBody), false);

/* ── what the host process assumes about the platform it is on ───────────── */

/**
 * **PATH is a list, joined by the platform's own separator.**
 *
 * ⚠ It was `parts.join(":")`, which is POSIX's — so on Windows the daemon's whole
 * `PATH` would have been one garbage entry and every agent CLI invisible. It also
 * closes a latent bug on the platforms that *do* use `:`, where a directory whose
 * own name contains one silently corrupted the list.
 *
 * Asserted here rather than left to `cargo test`, which cannot fail over a
 * separator it never sees: CI compiles this crate on Unix only, so the hand-rolled
 * join was correct in every environment that has ever run it.
 */
/*
 * Comments stripped: the docblocks beside each of these quote the very shape
 * being searched for — "never with a POSIX literal", "not Linuxbrew" — so the raw
 * file satisfies every search here whichever way round the code is, and the
 * cheapest route back to green would be deleting the explanation.
 */
const daemonSrc = flat(
  read(`${TAURI_DIR}/src/daemon.rs`)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, ""),
);
check("the daemon's PATH is joined with the platform's separator", /std::env::join_paths\(/.test(daemonSrc), true);
check("and never with a POSIX literal", /parts\.join\(":"\)/.test(daemonSrc), false);
check("and the user's own PATH is split the same way", /std::env::split_paths\(/.test(daemonSrc), true);
/*
 * Homebrew is named on exactly one fallback list, because it was measured on
 * exactly one platform. Linuxbrew on the Linux list would be a guess wearing a
 * measurement's clothes.
 */
check("Homebrew is named once, on the platform it was measured on", (daemonSrc.match(/\/opt\/homebrew\/bin/g) ?? []).length, 1);
check("and no fallback names Linuxbrew", /linuxbrew/i.test(daemonSrc), false);
/*
 * The login-shell probe is Unix by decision. It answered `None` on Windows by
 * luck — `SHELL` being unset — and that luck breaks under Git Bash and MSYS2,
 * which set it to a POSIX shell that knows nothing of the Windows `PATH`.
 */
check("the login-shell probe refuses where it cannot mean anything", /if !cfg!\(unix\) \{/.test(daemonSrc), true);
/*
 * No updater artifacts, and no updater. `docs/NATIVE.md` carries the steps, and
 * the one that has to happen *before* a first public build is generating the
 * keypair — a shipped build with no public key can never be updated in place by a
 * later one that has it.
 */
check("no updater artifacts are produced", bundle["createUpdaterArtifacts"], false);
check("and no updater is configured", Object.hasOwn((conf["plugins"] ?? {}) as object, "updater"), false);
/*
 * AGPL §6, not only §13: handing somebody a binary is a *distribution*, and the
 * offer that discharges it is the one served by the control plane's `SOURCE_URL`,
 * which says nothing about this artifact.
 */
check("the licence travels with the bundle", typeof bundle["licenseFile"], "string");
check(
  "and it is this repository's own",
  resolve(ROOT, TAURI_DIR, String(bundle["licenseFile"])),
  resolve(ROOT, "LICENSE"),
);
/*
 * The mobile blocks are declared and nothing is wired: `tauri ios init` has never
 * been run here and cannot be — it needs full Xcode and `rustup`, and this machine
 * has Command Line Tools and a Homebrew toolchain. Declared anyway so the
 * identifier and the OS floors are decided rather than defaulted on the day
 * somebody does run it.
 */
check("an iOS floor is decided rather than defaulted", typeof ((bundle["iOS"] ?? {}) as Record<string, unknown>)["minimumSystemVersion"], "string");
check("and an Android one", typeof ((bundle["android"] ?? {}) as Record<string, unknown>)["minSdkVersion"], "number");
check("no Apple development team is committed", ((bundle["iOS"] ?? {}) as Record<string, unknown>)["developmentTeam"], null);

/*
 * ── what the env file already on a computer is allowed to say ──────────────
 *
 * ⚠ **Three answers, written down twice, and a fourth added to one side alone is
 * silent.** `daemon.rs` decides whether `~/.reemoat/daemon.env` names this server,
 * another one, or nothing; `store.ts` branches on the answer to decide between
 * adopting a daemon, refreshing its enrollment code, and buying a machine. A value
 * the page has never heard of falls through every arm and does *nothing* — which
 * is precisely the failure this pair of constants was introduced to end, so
 * leaving it to be caught by reading would be the same bug one level up.
 *
 * Compared as sets off disk, the way `OPENABLE` and the scheme allowlist already
 * are — this file's own precedent for one rule with copies on both sides of the
 * bridge.
 */
process.stdout.write("\nthe env file's three answers, on both sides of the bridge\n");
const daemonRs = read(`${TAURI_DIR}/src/daemon.rs`);
const rustConfig = [...daemonRs.matchAll(/pub const CONFIG_[A-Z]+: &str = "([a-z]+)";/g)].map((m) => m[1]);
const pageConfig = [
  ...read("packages/web/src/native.ts")
    .slice(read("packages/web/src/native.ts").indexOf("export const DAEMON_CONFIG"))
    .matchAll(/^\s{2}([a-z]+): "([a-z]+)",$/gm),
].map((m) => m[2]);
check("the host names three", rustConfig.length, 3);
check("and the page mirrors exactly those", [...pageConfig].sort(), [...rustConfig].sort());
/*
 * ⚠ **And the exits the daemon gives, written down in three places.**
 * `scripts/daemon.ts` decides them, `daemon.rs` carries one back, and `store.ts`
 * branches on them — so a renumbering on one side is a store that silently takes
 * no arm at all. The alternative to a number was reading the daemon's log, and a
 * supervisor that greps its child's output is one rewording away from doing
 * nothing quietly; that is the whole reason these exist, so they are pinned.
 */
const daemonTs = read("scripts/daemon.ts");
const nativeTs = read("packages/web/src/native.ts");
for (const [name, constant] of [
  ["codeRefused", "EXIT_CODE_REFUSED"],
  ["controlPlaneUnreachable", "EXIT_CONTROL_PLANE_UNREACHABLE"],
  ["localNetworkBlocked", "EXIT_LOCAL_NETWORK_BLOCKED"],
] as const) {
  const daemonValue = capture(daemonTs, new RegExp(`const ${constant} = (\\d+);`));
  const pageValue = capture(nativeTs, new RegExp(`${name}: (\\d+),`));
  check(`the daemon names ${constant}`, daemonValue !== null, true);
  check(`and the page agrees on ${name}`, pageValue, daemonValue);
}
check(
  "and the daemon still keeps 2 for everything else",
  /process\.exit\(\s*rejected[\s\S]{0,600}:\s*2,?\s*\)/.test(daemonTs),
  true,
);
/*
 * ⚠ **And the app says why macOS refused it, because the daemon cannot.**
 * Measured 2026-09-15 on macOS 15: a daemon started by this app is a child of it,
 * so this app is the responsible process for Local Network Privacy — and until
 * that is granted, reaching a control plane on a private subnet fails with
 * `EHOSTUNREACH` while the same address answers `ping` from a terminal one second
 * later. The key is what makes the system's own prompt say something about
 * Reemoat rather than nothing at all.
 */
check(
  "the bundle asks for the local network in its own words",
  /NSLocalNetworkUsageDescription/.test(read(`${TAURI_DIR}/Info.plist`)),
  true,
);
check("and the config merges that file in", (bundle["macOS"] as Record<string, unknown>)["infoPlist"], "Info.plist");
/*
 * And the key itself is spelled the same on both sides of the *file*, since the
 * shell installer writes it and this reads it back.
 */
check(
  "the fleet is decided by the key install.sh writes",
  /const CONTROL_PLANE_KEY: &str = "REEMOAT_CONTROL_PLANE";/.test(daemonRs),
  true,
);
/*
 * ⚠ **The keys a rewrite is allowed to touch are a closed list of three.** Growing
 * it is how a refreshed enrollment code deletes somebody's `NODE_EXTRA_CA_CERTS`
 * — measured on a real machine 2026-09-15, where that line was the only reason the
 * daemon could reach its control plane at all.
 */
const owned = /const OWNED_KEYS: \[&str; 3\] = \[([^\]]+)\];/.exec(daemonRs)?.[1] ?? "";
/*
 * ⚠ **An announce file is not evidence that a daemon is running.** `announce.ts`
 * removes it on a clean stop and cannot on an unclean one, so a force quit, a
 * crash or a power cut leaves one naming a port nobody is on — and believing it
 * answers `foreign`, the one status the setup flow reads as "somebody else has
 * this covered". Nothing would ever start a daemon again, on a computer whose
 * daemon dies with the app by design.
 */
check("a daemon this app did not start is confirmed to be there", /fn is_alive\(/.test(daemonRs), true);
/*
 * ⚠ **And the probe carries no credential.** `local.rs` reads a file rather than
 * probing precisely because a *meaningful* probe would hand a 300-second bearer to
 * whatever happened to answer. `/health` is the one route below the daemon's auth
 * middleware, so asking it costs nothing — but only while nothing attaches a
 * header to the request, which is why it is written over a raw socket rather than
 * through a configured client.
 */
const probe = /pub fn is_alive\([\s\S]*?\n\}/.exec(daemonRs)?.[0] ?? "";
check("the liveness probe exists to be read", probe.length > 0, true);
check("and it sends no credential", /authorization|Bearer|reqwest/i.test(probe), false);
check("and it asks the one route below the auth gate", /GET \/health/.test(probe), true);
/*
 * ⚠ **And the daemon dies with the app, which is one line and no other evidence.**
 * `Child` does not kill on drop — it detaches — so without an exit hook the daemon
 * is orphaned on every quit, keeps its *own* bundle's runtime and sources, and the
 * next version of this app finds it alive and announced, reads `foreign`, and never
 * starts the daemon it shipped with. Nothing else in this repository can see the
 * absence of a callback: `cargo` compiles either way and no driver runs the app.
 */
/*
 * ⚠ **Read with the comments taken out, and the reason is this assertion's own
 * history.** `/RunEvent::Exit/.test(libRs)` was green on the docblock four lines
 * above the code — the paragraph you have just read names `RunEvent::Exit`, so the
 * check passed whether or not the callback existed. That is the failure the
 * paragraph itself describes, arriving in the thing meant to catch it, and the
 * realistic regression walks straight through it: somebody "corrects" the hook to
 * `ExitRequested` or a window-close handler, keeps `supervisor.stop()`, and both
 * assertions stay green while every quit orphans a daemon.
 *
 * `daemonSrc` above already strips for exactly this; `libRs` is stripped here
 * rather than at its `read` because other assertions in this file are *about* the
 * comment layer, and `flat()` must not run over prose.
 */
const libCode = libRs.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
check("the shell handles its own exit", /matches!\(event, tauri::RunEvent::Exit\)/.test(flat(libCode)), true);
check("and stops the daemon it started there", /supervisor\.stop\(\)/.test(libCode), true);
/*
 * Bounded, because it runs on the way out of the main loop: an unbounded wait
 * hands the daemon's 25-second shutdown budget to the quit gesture.
 */
check("and the stop is bounded rather than open-ended", /const STOP_DEADLINE/.test(daemonRs), true);
/*
 * ⚠ **And a rewrite is refused while a hand-installed service owns the same file.**
 * `deploy/launchd/reemoat.plist.in` sets `KeepAlive` with `ThrottleInterval 10`,
 * so launchd would respawn within ten seconds, source the newly written file and
 * race this app's child for a single-use enrollment code, the database lock and
 * the port. Whichever loses, the code is spent and neither ends up enrolled.
 */
check("a hand-installed service is looked for", /fn managed_unit\(/.test(daemonRs), true);
check(
  "and a rewrite is refused while one owns the file",
  /daemon::managed_unit\(&home\)/.test(read(`${TAURI_DIR}/src/commands.rs`)),
  true,
);
/*
 * ⚠ **And the remedy must clear what the check looks at.** The first one said
 * `launchctl bootout`, which unloads a service and leaves its file — so the check
 * found it again, refused again, and offered the same command: a permanent lockout
 * whose own instructions could not end it. Detection is by file, because
 * `RunAtLoad` means an unloaded plist comes back at the next login, so the remedy
 * has to move the file.
 */
const remedy = /pub fn managed_unit_detail\([\s\S]*?\n\}/.exec(daemonRs)?.[0] ?? "";
check("the remedy exists to be read", remedy.length > 0, true);
check("and it moves the file rather than only unloading it", /mv \{/.test(remedy), true);
/*
 * ⚠ **And a value that could write a second assignment is refused rather than
 * escaped.** The env file is sourced by `run-daemon.sh` with `.`, and every key
 * `parse_env` finds reaches the daemon's environment with no whitelist — so a
 * newline is a second assignment and `NODE_OPTIONS` is code. `parse_env` strips one
 * pair of quotes and does not understand `'\''`, so escaping here would be a
 * second, divergent reading of a file that already has one authoritative reader.
 */
check("values written into the env file are validated", /fn is_writable_value\(/.test(daemonRs), true);
check(
  "and the state command asks before answering foreign",
  /announced\.filter\(\|found\| ours \|\| daemon::is_alive/.test(read(`${TAURI_DIR}/src/commands.rs`)),
  true,
);
check(
  "a rewrite may replace exactly the three keys this app owns",
  owned.split(",").map((k) => k.trim()).filter(Boolean),
  ['"REEMOAT_AUTH"', "CONTROL_PLANE_KEY", '"REEMOAT_ENROLL_CODE"'],
);

/*
 * ⚠ **The log is its own command, and the split is the assertion.** Owner's call,
 * 2026-09-15: the setup notice stopped drawing the daemon's two hundred lines and
 * Settings → Logs draws them instead. The obvious way to feed that screen would
 * have been to widen `DaemonState.detail` to carry the ring whenever there is one
 * — which puts a log on the one-second setup poll and turns a field meaning *what
 * explains this failure* into a log field by accident. So: a second command, and
 * `host_daemon_state`'s running and foreign arms still answer `detail: None`.
 *
 * Both halves, because the first alone would go green over a widened `detail`
 * sitting beside a command nobody calls.
 */
{
  const commandsRs = read(`${TAURI_DIR}/src/commands.rs`);
  check("the log has a command of its own", /pub fn host_daemon_log\(/.test(commandsRs), true);
  check("and the supervisor answers it as lines", /pub fn log_lines\(&self\) -> Vec<String>/.test(daemonRs), true);
  /*
   * ⚠ **And the poll carries no output at all any more.** `DaemonState` had a
   * `detail` field holding the tail, which is what the setup notice drew; the
   * notice draws a sentence now, so the field has no reader and is gone rather
   * than left on the wire for nobody. What the poll asks the ring is a boolean —
   * `printed_anything`, which is the whole of `exited` against `absent`.
   *
   * A negative and a positive, because either alone is satisfied by the wrong
   * thing: no field named `detail` on the struct, and the bit that replaced it.
   */
  check("the poll carries no daemon output", /pub detail:/.test(daemonRs), false);
  check("and asks the ring for a bit instead", /pub fn printed_anything\(&self\) -> bool/.test(daemonRs), true);
  check("which is what tells `exited` from `absent`", /if supervisor\.printed_anything\(\) \{ "exited" \} else \{ "absent" \}/.test(flat(commandsRs)), true);
  check("and the page's mirror of the struct dropped it too", /detail/.test(/export interface DaemonState \{[\s\S]*?\n\}/.exec(read("packages/web/src/native.ts"))?.[0] ?? "x detail"), false);
  /*
   * ⚠ **And it never refuses.** A screen whose whole subject is "what did it say"
   * has no use for a refusal it would have to render instead of the log — every
   * absence is an empty list, and the screen tells them apart from the state it
   * already has. A `Result` here would be a second empty-state vocabulary.
   */
  check("the log command answers a list rather than a result", /pub fn host_daemon_log\(host: State<'_, Host>\) -> Vec<String>/.test(commandsRs), true);
}

/*
 * ⚠ **The payload is not where a coding-agent CLI comes from, and it shipped one
 * anyway.** Measured 2026-09-15: `codex-acp` depends on `@openai/codex`, so npm
 * staged that package and wrote a `.bin/codex` for it, while `--omit=optional`
 * dropped the platform package that implements it — on purpose, because
 * `deploy/agents.sh` installs that CLI from the vendor (Q4.114). `daemon_path`
 * puts the payload's `.bin` first on PATH, which is right for the adapters and
 * wrong for this: `findOnPath("codex")` returned a shim that answers every
 * invocation with `Missing optional dependency`, ahead of the working copy the
 * person had installed. The agent was *listed* — listing asks only whether the
 * CLI resolves — and failed after the first message.
 *
 * Two halves, and the second is what keeps this from rotting: the prune exists,
 * **and** the names it prunes are exactly `AGENT_LOGIN`'s. A fifth agent added in
 * `src/acp/agents.ts` and not in the staging script is this defect back, on the
 * fifth agent, with nothing saying so.
 */
{
  const staging = read(`${NATIVE}/scripts/build-daemon.mjs`);
  check("the payload prunes the agent CLIs it does not ship", /function pruneAgentClis\(\)/.test(staging), true);
  check("and the prune runs", /^pruneAgentClis\(\);$/m.test(staging), true);
  const staged = /const AGENT_CLIS = \[([^\]]*)\]/.exec(staging)?.[1] ?? "";
  const pruning = staged.split(",").map((name) => name.trim().replace(/^"|"$/g, "")).filter(Boolean).sort();
  const agentsTs = read("src/acp/agents.ts");
  const login = /export const AGENT_LOGIN[\s\S]*?\n\};/.exec(agentsTs)?.[0] ?? "";
  const commands = [...login.matchAll(/^    command: "([a-z]+)",$/gm)].map((m) => m[1]).sort();
  check("both lists were found", pruning.length > 0 && commands.length > 0, true);
  check("and the payload prunes exactly the CLIs this daemon drives", pruning, commands);
  /*
   * The ordering the prune exists because of. `.bin` first is deliberate — the
   * adapters and the runtime must resolve with no profile at all — so the fix
   * cannot be to move it, and this pins that it was not moved by mistake.
   */
  check("the payload's bin is still first on the daemon's PATH", /parts\.push\(payload\.root\.join\("node_modules"\)\.join\("\.bin"\)/.test(flat(daemonRs)), true);
}

/*
 * ⚠ **Who the daemon is, which `env_clear` took away and which a credential store
 * keys on.** Measured 2026-09-15 on the machine that had it, and it is the
 * sharpest failure this shell has produced: `claude` derives its macOS Keychain
 * *account* from `USER`, falling back to the literal `unknown`. Spawned without
 * it, the agent looked up a credential nobody has, wrote an **empty** one under
 * `unknown` on its first start, and then answered every turn with `OAuth session
 * expired and could not be refreshed` — while the same binary, same `HOME`, same
 * Keychain, worked in a terminal three feet away. Reproduced exactly on
 * `env -i HOME=… PATH=… LANG=…`: refused without `USER`, answered with it.
 *
 * Signing in again could never have fixed it: a sign-in writes the *right*
 * account and the agent kept reading the wrong one.
 *
 * Three assertions, because the interesting part is not that the line exists.
 */
{
  /*
   * ⚠ **Captured from the raw source rather than through {@link flat}, and the
   * `\\s*` is load-bearing.** The body is asserted below by *position* as well as
   * by content, and flattening the whole file would make one index compare across
   * every function before this one. So only the signature is relaxed — rustfmt
   * puts each parameter on its own line once the line passes `max_width` — and
   * `\n    \}` still finds the function's own close, because every block inside
   * it is indented deeper.
   */
  const start = /pub fn start\(\s*&mut self[\s\S]*?\n    \}/.exec(daemonRs)?.[0] ?? "";
  check("the supervisor's spawn was found to read", start.length > 0, true);
  check("it still builds the environment rather than inheriting one", /\.env_clear\(\)/.test(start), true);
  check("and it names who the daemon is", /command\.env\("USER", &name\);/.test(start), true);
  check("in both spellings, because POSIX has two and tools read either", /command\.env\("LOGNAME", &name\);/.test(start), true);
  /*
   * ⚠ **Set *before* the env file is applied, so a `USER=` line there still wins.**
   * That is the rule the certificate pass-through states outright, and it is what
   * keeps an interim workaround somebody wrote into `~/.reemoat/daemon.env` from
   * fighting the fix. Asserted by position, because nothing typed can hold an
   * ordering.
   */
  const named = start.indexOf('command.env("USER", &name);');
  const fromFile = start.indexOf("for (key, value) in env {");
  check("and the env file still wins over it", named > 0 && fromFile > named, true);
  /*
   * The authority, not the inherited value — `commands.rs` takes `HOME` from
   * `app.path().home_dir()` for the same reason, and a stale export from whoever
   * launched the bundle is exactly what this must not reproduce.
   */
  check("the name comes from the system rather than from a variable", /libc::getpwuid\(libc::getuid\(\)\)/.test(daemonRs), true);
  /*
   * The two neighbours caught with it. Neither is measured breaking anything —
   * they are here because the failure was not "claude is unusual", it was "a clean
   * environment is missing what every tool assumes a session has".
   */
  for (const name of ["SHELL", "TMPDIR"]) {
    check(`and ${name} reaches the daemon too`, new RegExp(`"${name}",`).test(start), true);
  }
}

process.stdout.write(failures === 0 ? "\nall green\n\n" : `\n${failures} FAILED\n\n`);
process.exit(failures === 0 ? 0 : 1);
