/**
 * Stage the daemon — runtime, dependencies and source — for embedding in the app.
 *
 * `node scripts/build-daemon.mjs`, from this package. It writes two things and
 * nothing else:
 *
 *   src-tauri/binaries/node-<target-triple>   the runtime, for `bundle.externalBin`
 *   src-tauri/target/daemon/                  the payload, for `bundle.resources`
 *
 * **This is its own step rather than a `beforeBuildCommand`, and that is the one
 * structural thing to know about it.** `build-frontend.mjs` can be a
 * `beforeBuildCommand` because `frontendDist` is read by the *bundler*. Resources
 * and external binaries are not: `tauri-build` copies both from inside `build.rs`
 * (`copy_resources` / `copy_binaries`), so they are read by **cargo**, and a
 * missing staging directory fails `cargo clippy`, `cargo test` and
 * `tauri build --no-bundle` — all three of which the `native` CI job runs — with
 * `ResourcePathNotFound` long before anything is bundled. So this has to run ahead
 * of every cargo invocation, which is what `pnpm native:stage` is for.
 *
 * ## Why npm builds the tree when this repository is a pnpm repository
 *
 * Two independent reasons, both measured on this checkout, and either alone
 * decides it.
 *
 * **A pnpm tree cannot be copied.** `tauri-build`'s `copy_file` refuses anything
 * that is not a regular file, and its walker does not follow links — a symlinked
 * directory reads as a file, `is_file()` answers false, and the build dies with
 * `"… is not a file"`. pnpm's whole layout is symlinks into `.pnpm`.
 *
 * **A pnpm tree cannot be moved.** Its bin shims bake an absolute `NODE_PATH`:
 * this checkout's `node_modules/.bin/claude-agent-acp` exports
 * `/Users/rends/reemoat-prod/app/node_modules/.pnpm/…`. A shim copied into a
 * `.app` names a path on the machine that built it. `deploy/docker/Dockerfile`
 * records the same finding for `tsx` and answers it by installing and running at
 * one path; an app bundle has no such luxury, because the install path and the
 * run path are on different computers.
 *
 * npm produces what is needed instead: a real-file tree with correct nesting and
 * no symlinks outside `.bin` — verified here, not assumed, by
 * {@link assertNoSymlinks} at the end.
 *
 * ⚠ **Versions come from the root `package.json` and the installed tree, never
 * from a range resolved fresh.** `entryVersions` reads each dependency's *actual*
 * installed version out of `node_modules`, so the payload carries what
 * `pnpm install --frozen-lockfile` chose. A `^` resolved by npm against the
 * registry would make the bundled daemon a different program from the one every
 * driver in this repository just checked. It therefore requires that a root
 * `pnpm install` has happened, and says so rather than guessing.
 *
 * ## Three things the payload needs that are not obvious
 *
 * **`tsx` is a runtime dependency even though it is a devDependency.** Nothing
 * here has a build step — running from source under tsx is what a deployment of
 * this *is* — and `src/plugins/runtime.ts` `fork()`s `./runner.ts`, a TypeScript
 * file, at runtime. `deploy/docker/Dockerfile` states the same rule for the same
 * reason ("No --prod, and that is load-bearing rather than lazy"). `typescript`
 * is **not** needed: nothing in `src/` or `scripts/` imports it, and tsx compiles
 * with esbuild.
 *
 * **`--omit=optional`, with esbuild's platform binary added back by hand.** The two
 * ACP adapters pull a coding-agent CLI each as *optional* platform packages —
 * `@anthropic-ai/claude-agent-sdk-*` and `@openai/codex-*`, 552 MB of the two on
 * this architecture — which `pnpm-workspace.yaml`'s `overrides` remove from the
 * pnpm tree and Q4.114 argues at length: `deploy/agents.sh` installs and updates
 * those CLIs from the vendors, and the pinned copy is never the one that runs.
 * npm has no equivalent of pnpm's `'-'`, so the whole optional set is dropped —
 * and `deploy/docker/Dockerfile` already measured what that costs on its own
 * ("`--no-optional` would take esbuild's own platform binary with it and break
 * `tsx`"), so esbuild's binary is named as a direct dependency to bring exactly
 * that one back — per target, in `TARGETS`, because the right package differs by
 * platform and a single constant would ship a `tsx` with no compiler behind it on
 * every target but the one it was written for.
 *
 * **`.bin` is regenerated rather than copied.** npm writes symlinks there, which
 * Tauri cannot copy; pnpm writes shims with absolute paths, which do not move.
 * So this writes its own: three lines, relative, `exec`ing the `node` that sits
 * beside them. That last part is what makes the payload work with an **empty
 * PATH** — `src/acp/agents.ts` spawns `node_modules/.bin/claude-agent-acp` as a
 * command, and a launchd job started by an app has whatever environment the app
 * gave it and no profile.
 *
 * ## The runtime is downloaded, not copied from this machine
 *
 * `process.execPath` here is Homebrew's, and `otool -L` on it names seven
 * Homebrew dylibs (`@rpath/libnode.147.dylib`, `libuv`, `libada`, …). Copying it
 * produces a bundle that runs on the machine that built it and nowhere else. The
 * official build is one self-contained binary against `CoreFoundation`,
 * `Security`, `libc++` and `libSystem`, and it ships npm — which `deploy/agents.sh`
 * needs, since kimi is always installed from the registry and is skipped with a
 * warning when there is no `npm`.
 *
 * The download is checksum-verified against the release's own `SHASUMS256.txt`.
 * It is an executable that will be signed with this project's identity and run as
 * the user; taking it on trust from a redirect is not a thing to do quietly.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The runtime that ships.
 *
 * ⚠ **Written down here and asserted by `pincheck`**, which is the rule every
 * other version in this repository already follows. Node 24 because `package.json`
 * says `engines.node >= 24` — `node:sqlite` is behind a flag on 22, and this
 * daemon's entire store is that module — and because 24 is the active LTS, which
 * is the line a shipped desktop application should be on rather than current.
 */
const NODE_VERSION = "v24.21.0";

/** Where the official build comes from. */
const NODE_DIST = "https://nodejs.org/dist";

/**
 * Which build to fetch, per Rust target triple.
 *
 * `bundle.externalBin` names a path *prefix* and resolves
 * `<prefix>-<target-triple>`, so the file on disk carries the triple and the
 * binary inside the bundle does not.
 *
 * ⚠ **This project is not macOS-only, and this table is where that stops being a
 * comment and starts being work.** `docs/NATIVE.md` lists macOS, Windows and Linux
 * as supported and iOS and Android as prepared. What is macOS-arm64-only is *this
 * checkout* — a Homebrew toolchain with no `rustup`, so there is one target
 * installed — and conflating "what this machine can build" with "what this app
 * targets" is exactly the mistake that makes a cross-platform product accumulate
 * macOS-shaped decisions.
 *
 * So every desktop triple is named here with the archive it needs, and the ones
 * whose *unpacking* is not written yet are refused by name rather than silently
 * doing the wrong thing. Windows is a different shape in three ways at once — a
 * `.zip` rather than a tarball, `node.exe` at the archive root rather than under
 * `bin/`, and an `.exe` suffix on the staged binary — which is why it is a
 * separate piece of work and not a line in this table.
 */
const TARGETS = {
  "aarch64-apple-darwin": { dir: "darwin-arm64", archive: "tar.gz", esbuild: "@esbuild/darwin-arm64" },
  "x86_64-apple-darwin": { dir: "darwin-x64", archive: "tar.gz", esbuild: "@esbuild/darwin-x64" },
  "aarch64-unknown-linux-gnu": { dir: "linux-arm64", archive: "tar.gz", esbuild: "@esbuild/linux-arm64" },
  "x86_64-unknown-linux-gnu": { dir: "linux-x64", archive: "tar.gz", esbuild: "@esbuild/linux-x64" },
  "aarch64-pc-windows-msvc": { dir: "win-arm64", archive: "zip", esbuild: "@esbuild/win32-arm64" },
  "x86_64-pc-windows-msvc": { dir: "win-x64", archive: "zip", esbuild: "@esbuild/win32-x64" },
};

/**
 * The runtime dependency set, by name.
 *
 * Read from the root `package.json` rather than listed, so a dependency added to
 * the daemon reaches the payload without anybody remembering this file. `tsx` is
 * the one devDependency that is a runtime dependency; see the header.
 */
const EXTRA_DEV_DEPS = ["tsx"];

/**
 * What is copied out of the repository, verbatim.
 *
 * `package.json` is deliberately **not** here: the payload's manifest is written
 * by {@link installDependencies} from the repository's, with the dependency list
 * replaced by the resolved one. Copying the repository's over it afterwards would
 * leave npm's `node_modules` described by a manifest naming ranges it did not
 * install, and would put a `devDependencies` block in a tree that has none.
 */
const SOURCE_TREES = ["src", "scripts", "deploy"];
const SOURCE_FILES = ["tsconfig.json"];

const here = fileURLToPath(new URL(".", import.meta.url));
const nativeRoot = join(here, "..");
const repoRoot = join(nativeRoot, "..", "..");
const tauriRoot = join(nativeRoot, "src-tauri");
const cacheDir = join(tauriRoot, "target", "node-cache");
const stageDir = join(tauriRoot, "target", "daemon");
const binariesDir = join(tauriRoot, "binaries");

const triple = process.argv[2] ?? defaultTriple();
const target = TARGETS[triple];
if (target === undefined) {
  fail(`no Node build is mapped for ${triple}. Add it to TARGETS in ${relative(repoRoot, fileURLToPath(import.meta.url))}.`);
}
if (target.archive !== "tar.gz") {
  fail(
    `${triple} needs a ${target.archive} archive, and unpacking one is not written yet.\n` +
      "  Windows also puts node.exe at the archive root rather than under bin/, and the staged\n" +
      "  binary needs an .exe suffix — three differences, so it is its own change rather than\n" +
      "  a line in TARGETS. Refusing rather than staging something that cannot run.",
  );
}

/**
 * The triple this machine builds for when nothing says otherwise.
 *
 * Derived rather than defaulted to macOS, because a default that names one
 * platform is how a cross-platform project quietly becomes a single-platform one.
 */
function defaultTriple() {
  const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
  if (process.platform === "darwin") return `${arch}-apple-darwin`;
  if (process.platform === "linux") return `${arch}-unknown-linux-gnu`;
  if (process.platform === "win32") return `${arch}-pc-windows-msvc`;
  return `${arch}-unknown-${process.platform}`;
}

function fail(message) {
  process.stderr.write(`build-daemon: ${message}\n`);
  process.exit(1);
}

function step(message) {
  process.stdout.write(`  ${message}\n`);
}

/** `spawnSync` that refuses to continue past a failure. */
function run(command, args, options = {}) {
  const done = spawnSync(command, args, { stdio: "inherit", ...options });
  if (done.error) fail(`${command} could not be run: ${done.error.message}`);
  if (done.status !== 0) fail(`${command} ${args.join(" ")} exited ${done.status}`);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/* ── the runtime ─────────────────────────────────────────────────────────── */

/**
 * The official Node build, downloaded once and kept.
 *
 * Cached under `target/`, so `cargo clean` discards it and a rebuild fetches it
 * again — which is the right trade for a 50 MB archive that changes only when
 * {@link NODE_VERSION} does.
 */
function fetchRuntime() {
  const name = `node-${NODE_VERSION}-${target.dir}`;
  const archive = join(cacheDir, `${name}.${target.archive}`);
  const extracted = join(cacheDir, name);
  if (existsSync(extracted)) {
    step(`runtime ${NODE_VERSION} ${target.dir} (cached)`);
    return extracted;
  }
  mkdirSync(cacheDir, { recursive: true });

  const url = `${NODE_DIST}/${NODE_VERSION}/${name}.${target.archive}`;
  step(`downloading ${url}`);
  run("curl", ["-fsSL", "--retry", "3", "-o", archive, url]);

  // Verified against the release's own manifest before anything is extracted.
  // This binary is signed with this project's identity and runs as the user.
  const sums = join(cacheDir, `SHASUMS256-${NODE_VERSION}.txt`);
  run("curl", ["-fsSL", "--retry", "3", "-o", sums, `${NODE_DIST}/${NODE_VERSION}/SHASUMS256.txt`]);
  const wanted = readFileSync(sums, "utf8")
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .find(([, file]) => file === `${name}.${target.archive}`)?.[0];
  if (wanted === undefined) fail(`SHASUMS256.txt for ${NODE_VERSION} does not list ${name}.${target.archive}`);
  const got = createHash("sha256").update(readFileSync(archive)).digest("hex");
  if (got !== wanted) fail(`checksum mismatch for ${name}.${target.archive}\n  expected ${wanted}\n  got      ${got}`);
  step(`checksum ok (${got.slice(0, 16)}…)`);

  run("tar", ["xzf", archive, "-C", cacheDir]);
  if (!existsSync(extracted)) fail(`${archive} did not extract to ${extracted}`);
  return extracted;
}

/* ── the payload ─────────────────────────────────────────────────────────── */

/**
 * Every runtime dependency, at the version actually installed.
 *
 * Refuses rather than guessing when the root install has not happened: a payload
 * built from ranges is a different program from the one the drivers checked.
 */
function entryVersions() {
  const manifest = readJson(join(repoRoot, "package.json"));
  const names = [...Object.keys(manifest.dependencies ?? {}), ...EXTRA_DEV_DEPS];
  const pinned = {};
  for (const name of names) {
    const installed = join(repoRoot, "node_modules", name, "package.json");
    if (!existsSync(installed)) {
      fail(`${name} is not installed. Run \`pnpm install\` at the repository root first.`);
    }
    pinned[name] = readJson(installed).version;
  }
  const esbuild = target.esbuild;
  // A range, deliberately, and the only one here: this package is chosen *by*
  // esbuild's own version, which is a transitive dependency of tsx and therefore
  // not ours to pin. npm resolves it against the esbuild that lands beside it.
  pinned[esbuild] = "*";
  return pinned;
}

/**
 * Install the payload's dependencies with the runtime that will run them.
 *
 * The bundled npm rather than this machine's, so the platform binaries npm picks
 * are the ones for the build being staged rather than the ones for whatever is on
 * PATH here.
 */
function installDependencies(runtime, versions) {
  rmSync(stageDir, { recursive: true, force: true });
  mkdirSync(stageDir, { recursive: true });

  /*
   * The repository's own manifest, with the dependency list replaced by what is
   * actually being installed — rather than a manifest invented here.
   *
   * ⚠ **`type: "module"` is the field that matters and the reason this is a
   * derivation rather than a literal.** Every relative import in `src/` ends in
   * `.js` under `verbatimModuleSyntax`; a payload whose manifest lost that field
   * would have Node treat the whole tree as CommonJS and fail at the first
   * import, a long way from here. Deriving it means the payload cannot disagree
   * with the repository about what kind of package this is.
   *
   * `devDependencies` and `scripts` go: nothing in the payload runs `pnpm`, and a
   * `scripts` block naming drivers that are not shipped is a manifest describing
   * a tree that does not exist.
   */
  const manifest = readJson(join(repoRoot, "package.json"));
  delete manifest.devDependencies;
  delete manifest.scripts;
  manifest.dependencies = versions;
  writeFileSync(join(stageDir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  const node = join(runtime, "bin", "node");
  const npm = join(runtime, "lib", "node_modules", "npm", "bin", "npm-cli.js");
  step("installing payload dependencies");
  run(node, [npm, "install", "--omit=optional", "--no-audit", "--no-fund", "--loglevel=error"], {
    cwd: stageDir,
    // The bundled runtime first, so any install script a dependency runs sees the
    // same node the payload will.
    env: { ...process.env, PATH: `${join(runtime, "bin")}:${process.env.PATH ?? ""}` },
  });
}

/**
 * The repository's own files, and the runtime beside them.
 *
 * `src/store/schema.sql` and `deploy/agents.sh` ride along inside their trees and
 * have to: `store/sqlite.ts` reads the first as `new URL("./schema.sql",
 * import.meta.url)`, and `agentupdate.ts` resolves the second from its own file
 * URL through `PACKAGE_ROOT`. Both are why the payload is a tree rather than a
 * bundle.
 */
function copySource(runtime) {
  for (const tree of SOURCE_TREES) {
    cpSync(join(repoRoot, tree), join(stageDir, tree), { recursive: true, dereference: true });
  }
  for (const file of SOURCE_FILES) {
    cpSync(join(repoRoot, file), join(stageDir, file));
  }

  /*
   * npm's own tree, and it earns its place rather than riding along.
   *
   * `deploy/agents.sh` installs kimi from the registry **always** — `kimi upgrade`
   * without a TTY prints the manual command and exits 0 having installed nothing,
   * so shelling out to it would report success for ever — and the whole
   * `REEMOAT_AGENT_SOURCE=npm` arm, which is a firewalled machine's only route,
   * runs through it too. Without npm that script skips them with a warning
   * (`agents.sh:507`), which is a degraded machine nobody is told about.
   *
   * Into `node_modules/npm`, so the shim written beside `node` in `.bin` reaches
   * it by the same relative rule as every other shim.
   */
  cpSync(join(runtime, "lib", "node_modules", "npm"), join(stageDir, "node_modules", "npm"), {
    recursive: true,
    dereference: true,
  });
}

/**
 * The `node` the payload runs, and the shims that find it.
 *
 * A copy inside `node_modules/.bin` rather than a link to the one in
 * `Contents/MacOS`: the shims resolve it as `$basedir/node`, which is what makes
 * the payload independent of PATH, and a relative link out of `Resources` into
 * `MacOS` would be a symlink — the one thing the bundler cannot copy.
 */
function placeRuntime(runtime) {
  const node = join(runtime, "bin", "node");

  /*
   * ⚠ **One copy of the runtime, and this used to be two.**
   *
   * The payload needs a `node` inside `node_modules/.bin` for two separate
   * consumers: the package shims test `[ -x "$basedir/node" ]` before falling back
   * to PATH, and `deploy/agents.sh` resolves the runtime as
   * `$(dirname -- "$(command -v npm)")/node` — the node *beside* npm. The obvious
   * way to satisfy both is to copy the binary there, and that is what this did:
   * **122 MB, byte-identical to the `externalBin` copy, shipped twice**, taking the
   * projected bundle from 244 MiB to 360 MiB.
   *
   * A symlink is what this wants and is exactly what cannot be used — the bundler
   * refuses to copy anything that is not a regular file, which is the constraint
   * this whole script is shaped around. So: a shim, which is a regular file, and
   * which finds the one real copy.
   *
   * It probes **two** relative paths because the two layouts differ in depth, and
   * hard-coding either would work in development and fail in the bundle or the
   * reverse — the worst pair of outcomes to choose between:
   *
   *   bundle  Contents/Resources/daemon/node_modules/.bin → ../../../../MacOS/node
   *   dev     target/<profile>/daemon/node_modules/.bin   → ../../../node
   *
   * The final `exec node` is not a third guess; it is what happens if this file is
   * ever run from a tree that is neither, and PATH is then the honest last word.
   */
  const binDir = join(stageDir, "node_modules", ".bin");
  mkdirSync(binDir, { recursive: true });
  writeFileSync(
    join(binDir, "node"),
    `#!/bin/sh\n` +
      `# Generated by packages/native/scripts/build-daemon.mjs.\n` +
      `# The runtime itself is the externalBin copy; this only finds it.\n` +
      `basedir=$(dirname "$0")\n` +
      `for candidate in "$basedir/../../../../MacOS/node" "$basedir/../../../node"; do\n` +
      `  [ -x "$candidate" ] && exec "$candidate" "$@"\n` +
      `done\n` +
      `exec node "$@"\n`,
  );
  chmodSync(join(binDir, "node"), 0o755);

  mkdirSync(binariesDir, { recursive: true });
  const external = join(binariesDir, `node-${triple}`);
  cpSync(node, external);
  chmodSync(external, 0o755);
  step(`runtime placed once (${(statSync(node).size / 1e6).toFixed(0)} MB), reached by a shim in the payload`);
}

/**
 * Replace every `.bin` entry with a relative shim.
 *
 * npm writes symlinks here. The bundler cannot copy one, and a `.app` is not a
 * place a symlink to a sibling package survives being signed and moved anyway.
 * What replaces them is the smallest thing that works, and deliberately not a
 * copy of pnpm's — that one carries an absolute `NODE_PATH` and 40 lines of
 * Windows handling for a payload that ships on macOS.
 */
function regenerateShims() {
  const binDir = join(stageDir, "node_modules", ".bin");
  let written = 0;
  for (const name of readdirSync(binDir)) {
    const path = join(binDir, name);
    if (!lstatSync(path).isSymbolicLink()) continue;
    const targetPath = readlinkSync(path);
    rmSync(path);
    writeFileSync(
      path,
      `#!/bin/sh\n` +
        `# Generated by packages/native/scripts/build-daemon.mjs. Relative on purpose.\n` +
        `basedir=$(dirname "$0")\n` +
        `exec "$basedir/node" "$basedir/${targetPath}" "$@"\n`,
    );
    chmodSync(path, 0o755);
    written += 1;
  }

  /*
   * And one npm does not write for us, because npm did not install itself.
   *
   * ⚠ **This is what makes `deploy/agents.sh` correct on an app-installed
   * machine, and it is subtler than "npm is on PATH".** That script resolves the
   * runtime as `$(dirname -- "$(command -v npm)")/node` — the node *beside* npm —
   * so npm and node have to live in one directory or it finds a different Node
   * than the one running the daemon. Putting this shim in `.bin`, where `node`
   * already is, satisfies both halves with one entry on PATH.
   */
  writeFileSync(
    join(binDir, "npm"),
    `#!/bin/sh\n` +
      `# Generated by packages/native/scripts/build-daemon.mjs. Relative on purpose.\n` +
      `basedir=$(dirname "$0")\n` +
      `exec "$basedir/node" "$basedir/../npm/bin/npm-cli.js" "$@"\n`,
  );
  chmodSync(join(binDir, "npm"), 0o755);
  step(`regenerated ${written} bin shim${written === 1 ? "" : "s"}, plus npm`);
}

/**
 * The assertion this whole file exists to be able to make.
 *
 * A symlink anywhere under the payload is a `cargo build` that fails with
 * `"… is not a file"`, and it fails in `build.rs` — so it would be reported as a
 * broken Rust build rather than as a packaging mistake. Caught here, where the
 * message can say what actually happened.
 */
function assertNoSymlinks() {
  const offenders = [];
  const sweep = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) offenders.push(relative(stageDir, path));
      else if (entry.isDirectory()) sweep(path);
    }
  };
  sweep(stageDir);
  if (offenders.length > 0) {
    fail(
      `the payload holds ${offenders.length} symlink(s), which the bundler cannot copy:\n` +
        `${offenders.slice(0, 10).map((p) => `    ${p}`).join("\n")}` +
        `${offenders.length > 10 ? `\n    … and ${offenders.length - 10} more` : ""}`,
    );
  }
}

function payloadSize() {
  let bytes = 0;
  const sweep = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) sweep(path);
      else if (entry.isFile()) bytes += statSync(path).size;
    }
  };
  sweep(stageDir);
  return bytes;
}

/* ── main ────────────────────────────────────────────────────────────────── */

process.stdout.write(`build-daemon: staging for ${triple}\n`);
const runtime = fetchRuntime();
installDependencies(runtime, entryVersions());
copySource(runtime);
placeRuntime(runtime);
regenerateShims();
assertNoSymlinks();
process.stdout.write(
  `  payload ${(payloadSize() / 1e6).toFixed(0)} MB at ${relative(repoRoot, stageDir)}\n`,
);
