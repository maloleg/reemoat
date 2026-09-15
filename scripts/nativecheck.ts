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
 * `packages/web/src/native.ts` exactly as `telegram.ts` reads
 * `window.TelegramWebviewProxy`. Asserted from both sides, because either alone
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
   * Walked line by line rather than matched as one pattern: a field's JSON name is
   * the `rename` on the line above it when there is one and its own name when there
   * is not, and that "when there is one" is the whole thing being compared. A
   * single regex that got the lookbehind subtly wrong would answer a *superset* and
   * pass for ever.
   */
  const readJsonKeys: string[] = [];
  let pending: string | null = null;
  for (const line of (stored ?? "").split("\n")) {
    const rename = /serde\(rename = "(\w+)"\)/.exec(line);
    if (rename !== null) {
      pending = rename[1] ?? null;
      continue;
    }
    const field = /^\s{4}(\w+): /.exec(line);
    if (field === null) continue;
    readJsonKeys.push(pending ?? field[1] ?? "");
    pending = null;
  }
  readJsonKeys.sort();

  check("both sides were found to have fields", [writtenKeys.length > 0, readJsonKeys.length > 0], [true, true]);
  check("and the daemon writes exactly what the shell reads", writtenKeys, readJsonKeys);

  check(
    "the version the daemon stamps is the version the shell accepts",
    capture(ts, /export const ANNOUNCE_VERSION = (\d+);/),
    capture(rs, /const ANNOUNCE_VERSION: u32 = (\d+);/),
  );
}

process.stdout.write("\nthe commands, declared against registered\n");

const libRs = read(`${TAURI_DIR}/src/lib.rs`);
const declared = [...commandsRs.matchAll(/#\[tauri::command\]\s*(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/g)]
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
  if (/#\[tauri::command\]/.test(readFileSync(join(ROOT, TAURI_DIR, "src", file), "utf8"))) strayCommands.push(file);
}
check("and every command lives in commands.rs", strayCommands, []);

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
] as const) {
  const daemonValue = capture(daemonTs, new RegExp(`const ${constant} = (\\d+);`));
  const pageValue = capture(nativeTs, new RegExp(`${name}: (\\d+),`));
  check(`the daemon names ${constant}`, daemonValue !== null, true);
  check(`and the page agrees on ${name}`, pageValue, daemonValue);
}
check(
  "and the daemon still keeps 2 for everything else",
  /process\.exit\(\s*rejected[\s\S]{0,240}:\s*2,?\s*\)/.test(daemonTs),
  true,
);
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
check("the shell handles its own exit", /RunEvent::Exit/.test(libRs), true);
check("and stops the daemon it started there", /supervisor\.stop\(\)/.test(libRs), true);
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

process.stdout.write(failures === 0 ? "\nall green\n\n" : `\n${failures} FAILED\n\n`);
process.exit(failures === 0 ? 0 : 1);
