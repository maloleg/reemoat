import { readFileSync, readdirSync, statSync } from "node:fs";

/** Source with comments removed, so a rule quoted in prose cannot satisfy a regex. */
export function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/**
 * Every `.ts`/`.tsx` under `packages/web/src`, and the reader for one.
 *
 * Here rather than in the driver that first needed it, because the second driver
 * to want a census over the whole client would otherwise write a third copy of a
 * directory walk — and a sweep that misses a directory is a check that passes by
 * not looking. `webcheck.native-bridge.ts` was the first caller; the menu
 * placement census is the second.
 */
const SRC_ROOT = new URL("../src/", import.meta.url);

export function srcFile(rel: string): string {
  return readFileSync(new URL(rel, SRC_ROOT), "utf8");
}

export function srcFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string, base: string): void => {
    for (const entry of readdirSync(new URL(dir, SRC_ROOT))) {
      const path = `${dir}${entry}`;
      if (statSync(new URL(path, SRC_ROOT)).isDirectory()) walk(`${path}/`, `${base}${entry}/`);
      else if (/\.tsx?$/.test(entry)) out.push(`${base}${entry}`);
    }
  };
  walk("", "");
  return out;
}
