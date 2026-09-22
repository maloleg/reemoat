/**
 * Build `packages/web` for embedding, then drop what must not be embedded.
 *
 * `tauri build` runs this as `beforeBuildCommand`, with this package as the
 * working directory.
 *
 * **The prune is the reason this is a script rather than a one-line command.**
 * `packages/web/vite.config.ts` sets `sourcemap: "hidden"`, which writes 4.1 MB of
 * `.map` across 15 files — nothing in the bundle references them, and
 * `deploy/docker/Dockerfile` deletes them before the runtime stage for exactly
 * this reason. `frontendDist` is *embedded in the binary*, so without the same
 * step every build carries those megabytes into every download, and unlike the
 * image nothing would ever notice. `deploy/docker/prune-store.mjs` is the
 * precedent for the shape.
 *
 * ⚠ This rewrites `packages/web/dist` in place, which is the tree a locally
 * running `pnpm cp` serves — the same hazard `pnpm web:build` already has
 * (Q5.15): the control plane reads `index.html` from disk per request, so a
 * rebuild under a running one leaves open tabs asking for chunks that are gone.
 * Reload such a tab after building.
 */
import { spawnSync } from "node:child_process";
import { readdirSync, statSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const dist = join(root, "packages/web/dist");

/*
 * ⚠ **`shell: true` on Windows, and nothing less than that works.** A pnpm
 * install there is `pnpm.cmd` — a batch file rather than an executable — and
 * since the fix for CVE-2024-27980 Node **refuses** to spawn a `.cmd` or `.bat`
 * without a shell: the call comes back with `status: null` and an `error`, so the
 * `?? 1` below is the only thing anybody sees. Measured twice on
 * `windows-latest`, and the first repair is what proved it — naming `pnpm.cmd`
 * explicitly failed identically and in 56ms, which is the tell that no process
 * was ever started. `tauri build` reports `beforeBuildCommand ... failed with
 * exit code 1` and not one line more, on either.
 *
 * Windows only, so nothing on a POSIX host starts going through a shell's
 * quoting rules for a defect it does not have. The three arguments are literals,
 * which is what makes the Windows arm safe.
 */
const built = spawnSync("pnpm", ["--filter", "@reemoat/web", "build"], {
  cwd: root,
  stdio: "inherit",
  shell: process.platform === "win32",
});
if (built.status !== 0) process.exit(built.status ?? 1);

let dropped = 0;
let bytes = 0;
const sweep = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      sweep(path);
    } else if (entry.name.endsWith(".map")) {
      bytes += statSync(path).size;
      unlinkSync(path);
      dropped += 1;
    }
  }
};
sweep(dist);
process.stdout.write(
  `  dropped ${dropped} source map${dropped === 1 ? "" : "s"}, ${(bytes / 1_000_000).toFixed(1)} MB, before embedding\n`,
);
