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

process.stdout.write(failures === 0 ? "\nall green\n\n" : `\n${failures} FAILED\n\n`);
process.exit(failures === 0 ? 0 : 1);
