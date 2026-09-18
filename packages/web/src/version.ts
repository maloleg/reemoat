/**
 * What build of this app the browser is running.
 *
 * **A build-time constant read from this package's own `package.json`, so there is
 * no new place a version is written down.** `pincheck` already pins that manifest
 * against the root, the other two workspace manifests, `src/version.ts`'s
 * `DAEMON_VERSION`, the control plane's `VERSION` and the CHANGELOG's newest dated
 * heading — seven copies of which six are asserted against each other. A literal
 * here would have been the eighth, asserted by nothing, and the one most likely to
 * be forgotten at a release: it is the only one nobody greps for.
 *
 * ⚠ **`typeof`, and it is the whole trick rather than defensive style.** `webcheck`
 * imports this package's modules under plain `tsx` with no Vite, stubbing only
 * `window.location` and `window.localStorage` — so `__APP_VERSION__` is not defined
 * there at all. A bare reference, or `__APP_VERSION__ === undefined`, throws
 * `ReferenceError` during *module evaluation*, which takes down every check that
 * transitively imports this file with an error naming neither the file nor the
 * identifier. `typeof` on an undeclared name is the one read JavaScript defines, and
 * `webcheck` asserts the fallback it produces so the guard cannot rot into a
 * comment.
 *
 * The same guard covers the gate bundle, whose config deliberately declares no
 * `define`: `vite.gate.config.ts` refuses build config asserting something the code
 * does not say, and nothing across those nine addresses draws a version. Should this
 * file ever enter that import graph the guard answers `"dev"` rather than throwing —
 * and `webcheck.gate-and-server-settings.ts` asserts it never does, because a shipped
 * bundle quietly claiming to be `dev` is worse than a build that fails.
 */
declare const __APP_VERSION__: string;

export const APP_VERSION: string = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "dev";
