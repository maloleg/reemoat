import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { defineConfig } from "vite";

/**
 * The gate, built on its own.
 *
 * ⚠ **A separate build rather than a second input to the app's, and the reason is
 * chunking.** `rollupOptions.input = {app, gate}` produces one `dist` in which the
 * two entries *share* chunks — so shipping only the gate would mean computing its
 * reachable chunk set from Vite's manifest and copying exactly those, a build-time
 * walk this repository would then have to keep correct. Two builds have no shared
 * chunks to separate: `dist/` is the app, `dist-gate/` is the gate, and the
 * Dockerfile copies one directory and can carry no part of the other by accident.
 *
 * What it costs is that modules used by both are emitted twice. That is paid in
 * bytes on disk and never on the wire — no browser loads both — and it buys the
 * property the split exists for: **the control plane's image cannot serve the
 * app**, because the app's bundle is not in it.
 *
 * ## What this bundle weighed, and why a number is not written down for what it
 * weighs now
 *
 * ⚠ **The last measurement of the old shape, 2026-09-17, taken off the emitted
 * artifact rather than off a build log: `dist-gate/assets/gate-CLGvbqn9.js` was
 * 335,745 bytes, of which `gzip -9` gave 104,745** — Vite's own report for the
 * same file said 106.31 kB, which is its compression level rather than a
 * disagreement, and it is quoted here because that is the figure a build prints.
 * It was 266 kB on 2026-09-15, so a third of this bundle arrived in two days with
 * nothing in the tree measuring it.
 *
 * The cause was one import chain and it is worth naming, because nothing about
 * sign-up suggests it: `gate-main.tsx` imported `store.ts`, `store.ts` imports
 * `machine.ts`, `machine.ts` imports `e2ee.ts`, and `e2ee.ts` imports
 * `@reemoat/protocol` — the handshake, the cipher state and the frame codec.
 * Attributed off the emitted sourcemap: @noble/{curves,ciphers,hashes} 43,208 B,
 * `packages/protocol/src` 6,200 B, `e2ee.ts` 9,571 B, `machine.ts` 11,573 B.
 * About 70.5 kB, 21% of the chunk — and `grep` found the literal
 * `Noise_IK_25519_ChaChaPoly_BLAKE2s` inside the shipped file. Every page in this
 * bundle carried an implementation of `Noise_IK` it can never use: a browser holds
 * no device key, `dist-gate` has no session view to open a channel *for*, and
 * these nine addresses are a registration form, four mailed-link screens, three
 * legal documents and a handoff page — four of which are opened by a mail client,
 * typically on mobile data.
 *
 * **Repaired in the source, and deliberately not here.** Five files decide it:
 * `gate-main.tsx`, `GateApp.tsx`, `Gate.tsx` and `ui/gate/Handoff.tsx` read
 * `gateStore.ts`, which holds the fields these screens actually use and reaches no
 * transport module; and `ui/SignIn.tsx` — the one box both bundles draw that also
 * has to *act* — reaches its store through `signInAuth.ts` rather than naming
 * either. This file still sets no `alias` and no `external`, because either would
 * be a build config asserting something the code does not say, and a bundle whose
 * contents depend on a setting is exactly what the two-builds argument above
 * exists to avoid.
 *
 * ⚠ **Measured after the repair, 2026-09-17, off the emitted artifact:
 * `dist-gate/assets/gate-DRWfETna.js` is 232,490 bytes, 72.91 kB by Vite's own
 * gzip report.** Against 335,745 / 106.31 kB that is −103,255 bytes raw and
 * −33.4 kB on the wire, and it is below the 266 kB the bundle weighed before the
 * regression as well. `grep` finds neither `Noise_IK_25519_ChaChaPoly_BLAKE2s`
 * nor the ed25519 basepoint constant in any emitted gate asset.
 *
 * ⚠ **The numbers above are still prose, and prose is not what holds this.** Two
 * figures in this file went stale before these — 266 kB, and an older note
 * claiming a store-decoupled gate measured 194 kB — which is how a 31% regression
 * shipped unnoticed: a reader who sees a figure stops looking. What holds it now
 * is `webcheck.gate-and-server-settings.ts`'s *"the gate bundle reaches no
 * transport module"*, which walks the **value** import graph from each entry — not
 * the built artifact, so it runs offline with no build step like every other
 * driver here. It has to be the value graph: `ui/bits.tsx` type-imports
 * `OfflineReason` from `machine.ts`, `verbatimModuleSyntax` erases that, and the
 * broad walk therefore reported a transport chain the bundle does not contain.
 * Measured both ways: 34 value modules with the repair, 47 with one import edge
 * in `Handoff.tsx` put back.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    outDir: "dist-gate",
    // The app's target, for the app's reason: a phone on LTE.
    target: "es2022",
    // `"hidden"`, matching `vite.config.ts` — the maps are written and the
    // Dockerfile drops them before the runtime stage.
    sourcemap: "hidden",
    rollupOptions: { input: resolve(import.meta.dirname, "gate.html") },
  },
});
