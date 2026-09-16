# The native app

`packages/native` is a [Tauri 2](https://v2.tauri.app) window around
`packages/web`, built once and **embedded in the binary**. That sentence is the
point of it: the control plane this app supervises serves no JavaScript to it and
cannot replace any.

It is a **fourth client of the same API** and not a fourth deployment. Nothing
installs it, it has no unit, it holds no data `deploy/backup.sh` must take, it is
not in `RELAY_INPUTS`, and `deploy/deploy.sh` never touches it. `deploy/README.md`
is the operator's document and this is not in it for that reason.

`.claude/rules/native-shell.md` is the document for *changing* this. This one is for
building and shipping it.

## What runs where

**This app is two things, and conflating them is the main source of confusion
here.** It is a **client** — it talks to a control plane, a relay and daemons —
and it is a **daemon host**, carrying a Node runtime and a copy of `src/` so it
can run a daemon on the computer it is installed on.

| | Client | Daemon host |
|---|---|---|
| macOS | built, measured, shipping | built, measured, shipping |
| Linux | compiles; the bundle layout is unverified | staging works; see *Open measurements* |
| Windows | the near-term goal | **refused**, and the refusal is in `build-daemon.mjs` by name |

Windows is refused as a *host* rather than merely unwritten: there is no way to
stop a bundled daemon cleanly there — `TerminateProcess` gives `scripts/daemon.ts`
no chance at its 20-second close, so every turn in flight is interrupted and every
pending approval dropped — and `deploy/install.sh` is a shell script with no
supervisor to install into. `deploy/bootstrap.sh`'s `detect_platform` draws the
same line for the shell installer and is the authority `AGENT_HOST_OS` is held
against.

## What it adds, and what it deliberately does not

Five things a webview cannot do for itself:

| | |
|---|---|
| the `/v1/*` leg | the control plane mounts **no CORS at all**, so that one request goes through the host process. Everything else — the relay, the daemons, the WebSocket — is the same webview `fetch`/`XMLHttpRequest`/`WebSocket` the browser client uses |
| the credential | in the operating system's credential store, keyed on the server's origin, never in `localStorage` |
| a link | opened in the real browser, through `ui/links.ts`'s own three-scheme allowlist |
| a download | written through the platform's save panel |
| a daemon on this computer | read out of `~/.reemoat/daemon.json`, which a webview cannot open. The host answers a finished loopback origin and refuses any other |

The fifth is what makes the app more than a window: a daemon on the same machine is
reached over loopback rather than out to the relay and back. ⚠ **It changes what a
revocation costs, and only here.** The relay reads live user, machine and grant rows
before each request; loopback does not, so on this path a revoked grant keeps
working for the token's remaining life — 300 s plus 60 s of leeway either way.
Everywhere else it stops at once. Settings → Machines → *This device* says so beside
the switch, and switches it off per machine. What makes that trade defensible is
*who* can take it: only a process running as the uid that owns `~/.reemoat`, which
already holds the daemon's database, its signing keys and every transcript.
`docs/DECISIONS.md` Q7.137.

Not built, on purpose: no device identity, no updater, no menu bar, no tray, no
notifications.

## Developing

```bash
pnpm --dir packages/native install    # once. The ROOT install does not do this
pnpm native                           # Vite on 5173 with the window over it
pnpm native:build                     # a .app — not a .dmg, see below
pnpm nativecheck                      # offline, no cargo, part of `pnpm check`
cd packages/native/src-tauri && cargo test && cargo clippy -- -D warnings
```

### Pointing a build at a server by default

```bash
REEMOAT_DEFAULT_SERVER=https://app.example pnpm native:build
```

**Unset in this repository, deliberately** — a fork inherits no address, which is
`signingIdentity: null`'s rule applied to the question *which fleet does this
binary join*. `nativecheck` asserts no file here sets it.

It is baked in by `option_env!` and is therefore **not a secret**: it ends up in
the binary as a string. `build.rs` carries `cargo:rerun-if-env-changed` for the
name, without which cargo has no reason to recompile when the value moves.

⚠ **It is a suggestion for the welcome screen's field and is written down by
nothing.** The first screen is a welcome either way; with a default compiled in,
its address box opens already holding it, and **Continue** is what adopts it.
Setting this variable therefore changes what somebody confirms, never what they
skip — a build cannot decide which fleet an installation joins. A malformed value
is no default: the box opens empty and the screen asks. A fork's typo fails its
own `cargo test` rather than shipping.

⚠ **The separate install is not a mistake.** `packages/native` sits under
`packages/` and is **excluded from the pnpm workspace** — the three things that
depend on that one line are in `pnpm-workspace.yaml` beside it, and the shortest of
them is that the Tauri CLI would otherwise install on every daemon host in the
fleet. It carries its own `pnpm-workspace.yaml` so that `pnpm install` run inside it
does not walk up and silently install the repository's three projects instead.

⚠ `pnpm native:build` rewrites `packages/web/dist`, which is the tree a locally
running `pnpm cp` serves from disk per request. Reload any open browser tab
afterwards — the same hazard `pnpm web:build` has (Q5.15).

### The daemon inside it, and the loop for changing it

The app carries a daemon — a Node runtime in `Contents/MacOS/node` and a snapshot of
`src/`, `scripts/` and `deploy/` in `Contents/Resources/daemon/`, staged by
`pnpm native:stage`.

⚠ **That snapshot is not your working tree, and it is not your working tree in
`tauri dev` either.** `bundle.resources` is copied by `build.rs` into
`target/<profile>/`, and `resource_dir()` answers that copy in a development build
exactly as it answers `Contents/Resources` in a bundle. So editing `src/session.ts`
and reloading the window shows the *old* code, with nothing anywhere saying why —
measured, and the reason this paragraph exists.

For daemon work there are two loops and they are not interchangeable:

```bash
# Changing the daemon: point the app at a checkout. Development builds only.
REEMOAT_DAEMON_PAYLOAD=/path/to/reemoat/app pnpm native

# Changing what ships: re-stage, then rebuild.
pnpm native:stage && pnpm native:build
```

The override swaps the **code** and never the runtime: the daemon still runs under
the bundled `node`, so a checkout is exercised against the binary that will ship. It
is `cfg!(debug_assertions)`-gated, for `lib.rs`'s navigation-guard reason — a
variable naming a directory this process executes as you is fine on a developer's
machine and is not fine in an application people install.

**And the third loop is the one that needs no app at all.** A daemon started the
ordinary way — `pnpm daemon`, or the launchd unit — runs your working tree and
announces itself, and the app *adopts* it (`host_daemon_state` answers `foreign` and
starts nothing). That is the fastest loop for daemon work and it is what already
happens on a machine with a daemon installed.

### Prerequisites

| Platform | Needs |
|---|---|
| macOS (desktop) | Xcode **Command Line Tools** and a Rust toolchain. That is all: the linker, the SDK and `codesign` all ship in CLT, and `xcodebuild` is only needed for iOS |
| Windows | Rust, the MSVC build tools, and WebView2 (present on Windows 11). A **client** build; the daemon host is refused — see *What runs where* |
| Linux | Rust plus `libwebkit2gtk-4.1-dev`, `libgtk-3-dev`, `librsvg2-dev`, `libsoup-3.0-dev`, `patchelf`, and — ⚠ missing from this table until 2026-09-16 — `libssl-dev` and `pkg-config`, because `reqwest` takes `default-tls`, which is Security.framework on macOS and **OpenSSL** here |
| iOS | full **Xcode** *and* `rustup` |
| Android | Android SDK + NDK (`ANDROID_HOME`, `NDK_HOME`) *and* `rustup` |

## What is measured on this checkout, and what it costs

Measured 2026-09-14 on the machine this was written on: `rustc`/`cargo` 1.95 from
Homebrew, **no `rustup`**, the `aarch64-apple-darwin` target only, Xcode Command
Line Tools with no `xcodebuild`, and **zero code-signing identities**.

Three consequences, each stated rather than worked around:

1. **A development build works today and is arm64 only.** `--target
   universal-apple-darwin` needs `x86_64-apple-darwin`, which needs `rustup`; a
   Homebrew toolchain ships the host target and no way to add another.
2. **iOS and Android are prepared, not buildable here.** Both blocks exist in
   `tauri.conf.json` so the identifier and the OS floors are decided rather than
   defaulted, and neither `tauri ios init` nor `tauri android init` has been run —
   `src-tauri/gen/android` and `gen/apple` do not exist. The `SecretStore` boundary
   in `credential.rs` is the one thing mobile actually forces, and it is a trait
   already: `keyring`'s Android support is behind its own feature with a different
   API, and iOS reaches the Apple keychain by a third path.
3. **A build with no identity is unsigned**, runs locally, and is blocked by
   Gatekeeper the moment it is *downloaded*. The gap is a certificate, not code.
   ⚠ Measured on the produced bundle: `codesign -dv` reports
   `flags=0x20002(adhoc,linker-signed)` and **no entitlements and no hardened
   runtime**. Both are applied when a real identity signs, not before — so a
   development build is not evidence that `entitlements.plist` is right, and the
   first signed build is where that gets tested.

**And three things a `.dmg` needs that a `.app` does not.** `bundle.targets` is
`["app"]` alone, because Tauri's `bundle_dmg.sh` drives **Finder over AppleScript**
to lay the disk image window out, and from a non-interactive shell that fails —
measured 2026-09-14: `execution error: Finder got an error: AppleEvent timed out.
(-1712)`, *after* the `.app` had been built correctly. So the default build would
fail on every CI runner and every machine nobody is logged into, having already
produced the artifact that matters. Run `pnpm --dir packages/native exec tauri build
--bundles dmg` from a logged-in session to get one.

## Signing, notarization and updates

None of this is switched on. `tauri.conf.json` carries
`macOS.hardenedRuntime: true` and an `entitlements.plist` naming one entitlement
(`com.apple.security.network.client`); `signingIdentity` and `providerShortName` are
`null`, and `nativecheck` asserts they stay that way — a value committed there would
be somebody's identity in a public repository.

**Three signatures, and conflating them is the classic error.**

| | What | Driven by |
|---|---|---|
| Apple code signature | a **Developer ID Application** certificate, with the hardened runtime | `APPLE_SIGNING_IDENTITY`, or `APPLE_CERTIFICATE` + `APPLE_CERTIFICATE_PASSWORD` |
| Notarization | Apple's service; Tauri submits and staples during `tauri build` when the variables are present | `APPLE_ID` + `APPLE_PASSWORD` (an app-specific password) + `APPLE_TEAM_ID`, **or** `APPLE_API_KEY` / `APPLE_API_ISSUER` / `APPLE_API_KEY_PATH` |
| Update signature | a **separate** minisign keypair from `tauri signer generate`, nothing to do with Apple | `TAURI_SIGNING_PRIVATE_KEY` |

All of it is environment, so **no file in this repository changes to sign a
build**. The steps, in order:

1. Enrol in the Apple Developer Program and create a *Developer ID Application*
   certificate. Install it; `security find-identity -v -p codesigning` should list
   it.
2. Export `APPLE_SIGNING_IDENTITY` and the notarization variables from one of the
   two rows above, then `pnpm native:build`. Tauri signs, submits, waits and
   staples.
3. `xcrun stapler validate` on the `.app`, and `spctl -a -vvv -t install` on the
   `.dmg`, to see what a downloader will see.

⚠ **If signed updates are ever wanted, generate the keypair before the first public
build.** A build shipped with no `pubkey` can never be updated in place by a later
one that has it — the updater refuses an unsigned predecessor by design. Turning it
on is then `tauri signer generate`, the *public* half into
`plugins.updater.pubkey`, `bundle.createUpdaterArtifacts: true`, and an `endpoints`
entry.

⚠ **The update endpoint must not be a control-plane origin.** *Where the software
comes from* and *which fleet it joins* are two questions, and conflating them is
what putting a hosted address in the README once did — `docscheck` asserts the
separation for the installer already. A release asset on the repository is the right
source; an instance's own origin is not.

⚠ **Shipping a binary is a distribution, so AGPL §6 applies and not only §13.** The
control plane's `SOURCE_URL` discharges §13 for the hosted client and says nothing
about a `.dmg`. `bundle.licenseFile` puts the licence in the bundle; the
corresponding source has to be offered with it.

## Continuous integration

`nativecheck` runs in the ordinary `check` job — it reads text and JSON, needs no
`cargo`, and finishes in milliseconds.

Everything that needs a Rust toolchain is the `native` job in
`.github/workflows/check.yml`: `cargo fmt --check`, `cargo clippy -- -D warnings`,
`cargo test`, and `tauri build --no-bundle`. That last one earns the job on its own —
`tauri-build` compiles `capabilities/*.json` into an ACL, so a permission that does
not exist fails there and nowhere else, and a `version` path that does not resolve
fails there too.

It is a **sibling** job with no `needs:`, for the reason the `image` job gives: it is
not offline-in-one-process, and gating it behind the others would only delay the one
signal nothing else gives.

**Nothing about the native app deploys, publishes or notarizes on a push.** That is
this repository's stance rather than an omission — the control plane's own deploy is
`workflow_dispatch` only, and a release is a tag. If a distributable is ever
automated it rides the existing `v*` tag with the gates in a `deploy/ci-*.sh` script
where `deploycheck` can drive them, because a second entry point would be a second
way to answer *which commit is v0.1.0*.

## Verifying a build by hand

The parts that need a window, a fleet or an agent, and therefore no driver:

1. `pnpm cp`, then `pnpm web` — sign in at `127.0.0.1:5173` first, so a native
   regression is distinguishable from a broken control plane.
2. `pnpm native:build`, run the app. The first screen is the **welcome** — a
   greeting, one sentence about what a server is, and an address box. This build
   compiles no default, so the box is empty; a typo is refused with a sentence and
   leaves you here, and there is no Cancel, there being nothing to go back to.
   Build once more with `REEMOAT_DEFAULT_SERVER` set: the same screen, with the
   box already holding that address. **Continue**, and the sign-in form is next —
   which names no server, that question having just been answered.
3. Sign in. Then, in the webview inspector: `localStorage.length === 0`. **That is
   the one property no offline assertion can reach.**
4. The empty-fleet screen's install command names **the server you chose**, not
   `tauri://localhost`.
5. Enrol a daemon, `pnpm daemon`. The row goes online — which is the one assumption
   nothing offline checks: that the daemon leg really does work from a `tauri://`
   origin against `access-control-allow-origin: *`.
6. Refresh the browser tab from step 1: still signed in, machine still online. Two
   clients, two credentials, neither disturbing the other.
7. Run a turn. Text arrives incrementally and the transcript has no duplicated and
   no dropped rows.
8. Approve something — with `kimi`, or `claude` under an isolated
   `CLAUDE_CONFIG_DIR`, since a blanket allow in `~/.claude/settings.json` bypasses
   the permission machinery entirely.
9. The three seams: copy an enrollment code; download a file from a transcript (a
   **save panel**, not a navigation, and the file is not rendered); tap an `https://`
   link in agent output (the **system browser**), and check that a `file:` link is
   still drawn as plain text.
10. Drag a file onto the composer. This is the `dragDropEnabled` check.
11. Wifi off for ~30 s mid-turn, then on: it reattaches, the turn continues, and
    **you are not signed out**.
12. Zero CSP violations in the inspector console throughout.
13. Quit and relaunch: still signed in, same server, machine reconnects. Then sign
    out, relaunch, and confirm
    `security find-generic-password -s com.reemoat.app -a 'credential#<origin>'`
    answers *item could not be found*.
14. Point the picker at a second control plane, sign in, quit, relaunch, switch
    back. Each server keeps its own credential.
15. On the sign-in screen, tap **‹ Server**. The welcome screen comes back with
    the current address in the box and a **Cancel** that returns here — this is
    the only route back for somebody who confirmed a reachable but wrong address,
    Settings needing a session they cannot get. Then tap **Create one**. The **system browser** opens
    `<server>/register` — not a window inside the app, and the app's own window is
    unchanged behind it. Same for **Forgot password?**.
16. Signed in: Settings → Account → **Server address** → Change. The screen
    replaces the whole sheet, opens on the current address and offers **Cancel**,
    which returns to the settings sheet still open at the same section. Submit the
    address unchanged: nothing reloads and nothing is signed out. Then change it
    for real and confirm the app reloads
    signed out, and that
    `security find-generic-password -s com.reemoat.app -a 'credential#<the first origin>'`
    answers *item could not be found* while the second server's entry is there.
17. The app carries no sign-up form at all:
    `grep -c "Create an account" packages/web/dist/assets/*.js` answers `0`.

## Open measurements

Recorded here rather than discovered, in the column this repository keeps them in:

- **The Linux bundle layout, and whether it reaches the staged runtime.** Read off
  `tauri-utils`: a `.deb` or AppImage puts resources at `/usr/lib/<productName>/`
  while the executable is at `/usr/bin/<productName>`. Two things follow, and
  neither is fixed here — fixing them blind on a macOS checkout is how a guess
  becomes a measurement. `Payload::locate` takes `node` from
  `exe.parent()?.join("node")`, which there is `/usr/bin/node` — the
  distribution's. And `placeRuntime`'s shim probes `../../../../MacOS/node` and
  `../../../node`, neither of which resolves from
  `/usr/lib/Reemoat/daemon/node_modules/.bin`, so it falls to `exec node "$@"`
  with the payload's own `.bin` first on PATH — i.e. it re-execs itself.
  `tauri build --no-bundle` touches neither, so CI would stay green over both.
  The instrument: `tauri build --bundles deb` on a Linux box, install it,
  `ls -l /usr/bin/node`, then `node_modules/.bin/node --version` from inside the
  installed payload.
- **What Windows staging costs, when it is wanted.** Five items, not the three the
  refusal used to name: a `zip` rather than a tarball (`tar -xf` reads both, so
  not a new dependency); `node.exe` at the archive root rather than under `bin/`;
  `npm-cli.js` at the root rather than under `lib/node_modules`; an `.exe` suffix
  on the staged external binary; and `.cmd` shims — npm writes real files rather
  than symlinks there, so `regenerateShims`' symlink loop finds nothing to
  rewrite, and `deploy/agents.sh`'s `$(dirname -- "$(command -v npm)")/node` is a
  shell idiom with no Windows meaning. None of it is worth doing before a daemon
  can be stopped cleanly there.
- **A graceful stop with no `SIGTERM`.** Four options were weighed and the shape
  that wins is an **in-band request over a channel the parent already owns**:
  `daemon.rs` spawns with `.stdin(Stdio::null())`, so make it a pipe, have the
  supervisor write a line, and have `scripts/daemon.ts` treat it as the shutdown
  it already knows how to do. No signal, no port, no auth, no new route, and the
  channel is private to the parent by construction. It must act on the **line**
  rather than on EOF, because `pnpm daemon < /dev/null` is also EOF. Rejected:
  `GenerateConsoleCtrlEvent` (the shipped app sets `windows_subsystem = "windows"`
  and therefore has no console, and it delivers `SIGBREAK` rather than `SIGTERM`);
  a job object (`TerminateProcess` for every member — it solves orphaning, not
  gracefulness); and an HTTP route (every daemon route needs a token whose `aud`
  is the machine, and at `RunEvent::Exit` there is no page left to mint one).
- **A Linux CI leg**, which is cheap and is deliberately not here yet. `cargo fmt`,
  `clippy`, `cargo test` and `tauri build --no-bundle` on `ubuntu-latest` would be
  the first time five things are compiled at all: `keyring`'s secret-service
  backend and its zbus tree, `reqwest`'s native-tls against OpenSSL, wry against
  WebKitGTK, the capability ACL on a second platform, and `build-daemon.mjs`'s
  Linux staging path end to end. It would **not** catch the bundle layout above.
  It is held with the rest of the build work rather than because it is hard.
- **An `http://` control plane with a `ws://` relay.** `tauri://localhost` is a
  secure context, so mixed-content rules may refuse the relay legs — which are
  direct webview calls, not proxied. The failure would be a signed-in app whose
  machines are all unreachable, with the reason only in a console. One LAN fleet
  settles it.
- **A 100 MiB save through raw IPC.** The download bound is 100 MiB and
  `host_save_file` takes bytes; nobody has timed the round trip.
- **An intermediary in front of a real relay meeting `Origin: tauri://localhost`.**
  The relay itself answers `*` and never `Access-Control-Allow-Credentials`; a CDN
  in front of it may not.
- **Loopback from a packaged webview, per platform.** macOS is settled by the
  `lsof` step in the checklist: App Transport Security exempts loopback, the
  entitlement is already `com.apple.security.network.client`, and the App Sandbox is
  off. The other two are not. Windows runs WebView2, which is Chromium and applies
  **Private Network Access** preflights, and Linux runs WebKitGTK. A platform that
  refuses costs nothing visible — `proveLocal` fails and the relay answers, which is
  the same path every other client takes — so the failure to watch for is the silent
  one: the feature never engaging on a machine where it should. `lsof` on the app is
  the instrument; a WebSocket to `127.0.0.1:<port>` rather than to the relay's origin
  is the answer.
- **The keychain, end to end.** The key *shape* is unit-tested and the crate's Apple
  backend is the one that compiles, but writing a real entry needs an unlocked login
  keychain: from a non-interactive shell `security add-generic-password` answers
  `User interaction is not allowed`. A GUI app session has it unlocked, which is
  where step 13 above actually happens.

## What has been verified, and how

Recorded because *which* of these was measured and which was reasoned about is the
part that goes stale first.

| | |
|---|---|
| the frontend is inside the binary | `tauri build` produced `Reemoat.app` with `CFBundleShortVersionString 0.9.0` — **read through the `version` path** out of the root manifest, which is the field working rather than being asserted |
| the source maps do not ship | `dropped 29 source maps, 6.5 MB, before embedding` |
| the transport really is the host process | with a server configured, `lsof` on the running app shows **one** ESTABLISHED socket to it, held by `reemoat-native` itself and **not** by `com.apple.WebKit.Networking`. That is `cpSend` → `host_cp` → `reqwest` → the control plane, end to end |
| the app dials nothing it was not told to | with no server chosen it runs, draws the picker, opens **zero** sockets and writes **no** file |
| the webview loaded a document | a `com.apple.WebKit.WebContent` process appears beside the app's own within a second of launch |
| the Rust rules | `cargo test`: the origin-escape table, the normalization that makes one server one key, the keyring scope, and what this window may navigate to |
| everything else in the checklist above | **needs a person at a logged-in session.** `screencapture` from a non-interactive shell returns the desktop with no windows, and Automation is refused the same way the disk image's Finder step is — so nothing here has *seen* the server picker, only the process that drew it |
