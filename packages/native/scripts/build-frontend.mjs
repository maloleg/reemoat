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

const built = spawnSync("pnpm", ["--filter", "@reemoat/web", "build"], {
  cwd: root,
  stdio: "inherit",
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
