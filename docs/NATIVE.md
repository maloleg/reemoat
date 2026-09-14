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

## What it adds, and what it deliberately does not

Four things a webview cannot do for itself:

| | |
|---|---|
| the `/v1/*` leg | the control plane mounts **no CORS at all**, so that one request goes through the host process. Everything else — the relay, the daemons, the WebSocket — is the same webview `fetch`/`XMLHttpRequest`/`WebSocket` the browser client uses |
| the credential | in the operating system's credential store, keyed on the server's origin, never in `localStorage` |
| a link | opened in the real browser, through `ui/links.ts`'s own three-scheme allowlist |
| a download | written through the platform's save panel |

Not built, on purpose: no local-daemon shortcut (every request goes down the relay's
tunnel, which is where a revoked grant takes effect on the *next* request), no
device identity, no updater, no menu bar, no tray, no notifications.

## Developing

```bash
pnpm --dir packages/native install    # once. The ROOT install does not do this
pnpm native                           # Vite on 5173 with the window over it
pnpm native:build                     # a .app and a .dmg
pnpm nativecheck                      # offline, no cargo, part of `pnpm check`
cd packages/native/src-tauri && cargo test && cargo clippy -- -D warnings
```

⚠ **The separate install is not a mistake.** `packages/native` sits under
`packages/` and is **excluded from the pnpm workspace** — the three things that
depend on that one line are in `pnpm-workspace.yaml` beside it, and the shortest of
them is that the Tauri CLI would otherwise install on every daemon host in the
fleet. It carries its own `pnpm-workspace.yaml` so that `pnpm install` run inside it
does not walk up and silently install the repository's three projects instead.

⚠ `pnpm native:build` rewrites `packages/web/dist`, which is the tree a locally
running `pnpm cp` serves from disk per request. Reload any open browser tab
afterwards — the same hazard `pnpm web:build` has (Q5.15).

### Prerequisites

| Platform | Needs |
|---|---|
| macOS (desktop) | Xcode **Command Line Tools** and a Rust toolchain. That is all: the linker, the SDK and `codesign` all ship in CLT, and `xcodebuild` is only needed for iOS |
| Windows | Rust, the MSVC build tools, and WebView2 (present on Windows 11) |
| Linux | Rust plus `libwebkit2gtk-4.1-dev`, `libgtk-3-dev`, `librsvg2-dev`, `libsoup-3.0-dev`, `patchelf` |
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
2. `pnpm native:build`, run the app. The server picker appears; a typo is refused
   with a sentence and leaves you on the picker.
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

## Open measurements

Recorded here rather than discovered, in the column this repository keeps them in:

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
