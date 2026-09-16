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
 * Measured, 2026-09-15: the gate is 266 kB (81 kB gzipped) against the app's
 * 380 kB entry chunk. Most of the remainder is React itself (~140 kB) and
 * `store.ts`'s own import closure, which `Gate` reaches through six calls. A
 * gate decoupled from the store measures 194 kB; that refactor is not done, and
 * it is a size decision rather than a correctness one.
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
