import { readFileSync, readdirSync, statSync } from "node:fs";
import { check, report, storage } from "./webcheck.env.js";
import { stripComments } from "./webcheck.source.js";

/* ------------------------------------------------------------------ *
 * The native shell, from this side of the bridge
 *
 * **This section exists because the credential moves.** In a browser it is in
 * `localStorage` and every rule about it has been asserted here for releases; in
 * the native shell it is in the operating system's credential store, and the two
 * arms share one function. So every one of those rules has to hold twice, and the
 * second time through a transport nothing else here has ever driven.
 *
 * Two of the assertions below are the ones that would otherwise be lost silently
 * rather than loudly, and they are worth naming:
 *
 *   - **the credential never reaches `localStorage` in the shell.** A native build
 *     that wrote to both would work perfectly and would have put the credential in
 *     the one place the whole exercise exists to get it out of.
 *   - **a 401 for a *superseded* credential still does not clear the current one.**
 *     `cpFetch` captures `const sent = credential` and compares by identity, and
 *     the ten-second window that rule defends is unchanged by which transport
 *     answered. A host that mapped its failures wrongly would either sign the fleet
 *     out on every subway tunnel or never sign anybody out at all, and the existing
 *     table one section over would stay green through both.
 *
 * **The arms are reachable in one process, and that is a property of the design
 * rather than a trick.** `inNativeShell()` reads the injected global on *every*
 * call — `telegram.ts`'s `proxy()` idiom — so installing it mid-run flips the arm
 * without re-importing anything. What is decided at import time and stays decided
 * is only the hydration state, which is driven through its own exported function.
 * ------------------------------------------------------------------ */

process.stdout.write("\nthe native bridge, and the browser arm it must not disturb\n");

const SRC = new URL("../src/", import.meta.url);
const src = (rel: string): string => readFileSync(new URL(rel, SRC), "utf8");

/** Every `.ts`/`.tsx` under `packages/web/src`, the sweep the clipboard census uses. */
function sources(): string[] {
  const out: string[] = [];
  const walk = (dir: string, base: string): void => {
    for (const entry of readdirSync(new URL(dir, SRC))) {
      const path = `${dir}${entry}`;
      if (statSync(new URL(path, SRC)).isDirectory()) walk(`${path}/`, `${base}${entry}/`);
      else if (/\.tsx?$/.test(entry)) out.push(`${base}${entry}`);
    }
  };
  walk("", "");
  return out;
}

const files = sources();
report("there are files to sweep at all", files.length >= 50, `${files.length} modules under src/`);

/* ------------------------------------------------------------------ *
 * One file names the platform, the way one file names the clipboard
 * ------------------------------------------------------------------ */
{
  /*
   * The same shape of rule as `navigator.clipboard`'s census, and for the same
   * reason: what is interesting is the **absence** of a call anywhere else. A React
   * component reaching for `__TAURI__` directly is how a shared codebase acquires a
   * native-only branch that a browser silently takes the wrong side of.
   *
   * Comments stripped first, because this file's own docblocks name the global while
   * forbidding it elsewhere — exactly what the clipboard docblocks do.
   */
  const named = files.filter((f) => /__TAURI__/.test(stripComments(src(f))));
  check("the injected global is named in one file", named, ["native.ts"]);
  const invokes = files.filter((f) => /\binvoke[<(]/.test(stripComments(src(f))));
  check("and so is every call through it", invokes, ["native.ts"]);
  report("the sweep can see a call at all", /__TAURI__/.test("window.__TAURI__"), "pattern matches a real read");

  const native = src("native.ts");
  /*
   * The reverse half, which the clipboard census also has: a file that became
   * native-only would pass the census above and break every browser. So the
   * predicate has to exist, and it has to be the thing every export is gated on.
   */
  check("the bridge is feature-detected rather than assumed", /typeof held\?\.core\?\.invoke === "function"/.test(native), true);
  check("and it still answers for a plain browser", /export function inNativeShell\(\): boolean/.test(native), true);
  check(
    "the transport's browser arm is a bare fetch",
    /if \(!inNativeShell\(\)\) return await fetch\(path, init\);/.test(native),
    true,
  );
  /*
   * No `@tauri-apps` import anywhere, asserted over the source as well as over the
   * manifest: a dependency can be added to a file without being added to a
   * `package.json`, and it is the *import* that ends up in the bundle the control
   * plane's image serves.
   */
  check(
    "no module imports a Tauri package",
    files.filter((f) => /from "@tauri-apps/.test(src(f))),
    [],
  );
}

/* ------------------------------------------------------------------ *
 * The commands this side calls are the commands the shell registers
 * ------------------------------------------------------------------ */
{
  /*
   * **The third direction of a three-way pin.** `nativecheck` compares the commands
   * the Rust *declares* with the ones it *registers*; this compares what the page
   * *calls* with what is registered — the direction that fails at runtime with
   * `Command … not found` and which no offline check on either side alone can see.
   */
  const native = stripComments(src("native.ts"));
  const called = [
    ...new Set(
      [...native.matchAll(/invoke(?:<[^>]*>)?\(\s*"([a-z0-9_]+)"/g)]
        .map((m) => m[1])
        .filter((c): c is string => c !== undefined),
    ),
  ].sort();
  /*
   * One command name is built by a conditional rather than written as a literal —
   * the credential set/clear pair — so it is named here too. Written out rather
   * than pattern-matched: a name this census cannot see is a name the pin does not
   * cover, and saying which one is cheaper than a cleverer regex.
   */
  const conditional = [
    ...new Set(
      [...native.matchAll(/"(host_credential_(?:set|clear))"/g)]
        .map((m) => m[1])
        .filter((c): c is string => c !== undefined),
    ),
  ];
  const wanted = [...new Set([...called, ...conditional])].sort();

  const rust = readFileSync(new URL("../../native/src-tauri/src/lib.rs", SRC), "utf8");
  const handler = /generate_handler!\[([\s\S]*?)\]/.exec(rust)?.[1] ?? "";
  const registered = [...handler.matchAll(/commands::(\w+)/g)]
    .map((m) => m[1])
    .filter((c): c is string => c !== undefined)
    .sort();

  report("commands were found on both sides", wanted.length > 0 && registered.length > 0, `${wanted.length} called, ${registered.length} registered`);
  check("every command this page calls exists in the shell", wanted.filter((c) => !registered.includes(c)), []);
  check("and every command the shell registers is called", registered.filter((c) => !wanted.includes(c)), []);
  /*
   * A computed command name makes the census above vacuous, so it is refused
   * outright — the two `host_credential_*` names are picked by a ternary over two
   * *literals*, which this still sees.
   */
  check("no command name is assembled from a variable", /invoke(?:<[^>]*>)?\(\s*[^"a-z]/.test(native.replace(/invoke<T>\(command/g, "")), false);
}

/* ------------------------------------------------------------------ *
 * The seams keep their rules, and gain an arm
 * ------------------------------------------------------------------ */
{
  const download = stripComments(src("ui/download.ts"));
  /*
   * ⚠ **The line `download.ts`'s own docblock calls the one that must not change**,
   * asserted for the first time here: it was enforced by prose alone, and a native
   * arm arriving above it is exactly the edit that could have moved it.
   */
  check(
    "the download seam still re-types the blob",
    /new Blob\(\[blob\], \{ type: "application\/octet-stream" \}\)/.test(download),
    true,
  );
  check("and the native arm returns before it rather than beside it", /if \(inNativeShell\(\)\) \{\s*void saveNative\(blob, filename\);\s*return;/.test(download), true);
  /* The three negatives that docblock states, turned into assertions. */
  check(
    "nothing in this app opens a URL in a new browsing context",
    files.filter((f) => /window\.open\(/.test(stripComments(src(f)))),
    [],
  );
  check(
    "and nothing binds an iframe to one",
    files.filter((f) => /<iframe[^>]*\bsrc=\{/.test(stripComments(src(f)))),
    [],
  );

  const clipboard = stripComments(src("ui/clipboard.ts"));
  check("the clipboard seam still carries its fallback", /execCommand\("copy"\)/.test(clipboard), true);
  check("and asks the platform first", /if \(inNativeShell\(\)\) return await copyNative\(text\);/.test(clipboard), true);

  /*
   * The scheme allowlist stays three long and stays in `links.ts`. `nativecheck`
   * compares it to the shell's copy; this asserts the page's own reuse of it, which
   * is what makes the click interceptor one policy rather than a fourth.
   */
  const links = stripComments(src("ui/links.ts"));
  check("the openable scheme list is still exactly three", /new Set\(\["http:", "https:", "mailto:"\]\)/.test(links), true);
  check("and the interceptor decides with it rather than its own copy", /openableHref\(anchor\.getAttribute\("href"\)/.test(stripComments(src("native.ts"))), true);
}

/* ------------------------------------------------------------------ *
 * The install command names the server, not the page
 * ------------------------------------------------------------------ */
{
  /*
   * ⚠ **Three call sites, and only two of them were ever asserted.** Under a custom
   * scheme `installCommand(location.origin)` prints
   * `curl -fsSL 'tauri://localhost/install.sh' | sh` — an installer that joins
   * nothing, on the one screen whose whole job is to be copied. Swept rather than
   * named, so a fourth screen drawing it is covered by arriving.
   */
  const offenders = files.filter((f) => /installCommand\(\s*(?:window\.)?location\.origin\s*\)/.test(stripComments(src(f))));
  check("no screen builds the install command out of its own origin", offenders, []);
  const callers = files.filter((f) => /installCommand\(/.test(stripComments(src(f))) && f !== "enrollment.ts");
  report("there are install-command screens to sweep", callers.length >= 3, `${callers.length} call sites`);
  check(
    "and every one of them asks where the control plane is",
    callers.filter((f) => !/installCommand\(controlPlaneOrigin\(\)\)/.test(stripComments(src(f)))),
    [],
  );
}

/* ------------------------------------------------------------------ *
 * The credential: the browser arm, unchanged
 * ------------------------------------------------------------------ */

const cp = await import("../src/cp.js");
const holder = (globalThis as Record<string, unknown>)["window"] as Record<string, unknown>;

interface Call {
  command: string;
  args: Record<string, unknown>;
}
const calls: Call[] = [];
let answer: (call: Call) => Promise<unknown> = async () => undefined;

function enterShell(): void {
  holder["__TAURI__"] = {
    core: {
      invoke: async (command: string, args: unknown): Promise<unknown> => {
        const call = { command, args: (args ?? {}) as Record<string, unknown> };
        calls.push(call);
        return await answer(call);
      },
    },
  };
}
function leaveShell(): void {
  delete holder["__TAURI__"];
}

process.stdout.write("\nthe credential, in a browser\n");
{
  storage.clear();
  cp.setSession("rs_browser");
  check("a session is written under the new name", storage.get("reemoat.credential"), "rs_browser");
  check("and read back from memory", cp.currentCredential()?.value, "rs_browser");
  cp.clearSession();
  check("clearing removes it rather than blanking it", storage.has("reemoat.credential"), false);
  check("nothing was asked of a shell that is not there", calls.length, 0);
}

/* ------------------------------------------------------------------ *
 * The credential: the native arm
 * ------------------------------------------------------------------ */

process.stdout.write("\nthe credential, in the shell\n");
{
  storage.clear();
  calls.length = 0;
  enterShell();
  check("the shell is detected", cp.currentCredential(), null);

  cp.setSession("rs_native");
  check("the credential is held in memory exactly as in a browser", cp.currentCredential()?.value, "rs_native");
  check("and handed to the operating system's store", calls.map((c) => c.command), ["host_credential_set"]);
  check("with the value and nothing else", calls[0]?.args, { value: "rs_native" });
  /*
   * ⚠ **The assertion this whole section exists for.** All three names, because the
   * two pre-rename ones are read on the next page load in preference to nothing —
   * so a value left under either is a credential a later launch would adopt out of
   * unprotected storage.
   */
  check(
    "and never to localStorage under any of the three names",
    ["reemoat.credential", "remoslop.credential", "remoslop.apiKey"].map((k) => storage.has(k)),
    [false, false, false],
  );

  calls.length = 0;
  cp.clearSession();
  check("signing out clears the memory copy", cp.currentCredential(), null);
  check("and asks the store to forget it", calls.map((c) => c.command), ["host_credential_clear"]);
  check("still touching no browser storage", [...storage.keys()], []);
  leaveShell();
}

/* ------------------------------------------------------------------ *
 * Hydration: what the store adopts, and what it may not overwrite
 * ------------------------------------------------------------------ */

process.stdout.write("\nadopting what the keyring held\n");
{
  storage.clear();
  cp.clearSession();
  cp.adoptHydratedCredential("rs_fromkeyring");
  check("a keyring credential is adopted", cp.currentCredential()?.value, "rs_fromkeyring");
  check("and its kind is read off the prefix", cp.currentCredential()?.kind, "session");
  cp.adoptHydratedCredential("rs_second");
  /*
   * **A credential adopted since wins**, which is the same reasoning `cpFetch` uses
   * about a late 401: a sign-in that completed while the keyring read was in flight
   * is newer than what the keyring held, and an async read landing afterwards must
   * not put the old one back.
   */
  check("but it never replaces one already held", cp.currentCredential()?.value, "rs_fromkeyring");
  cp.clearSession();
  cp.adoptHydratedCredential(null);
  check("and a keyring with nothing in it adopts nothing", cp.currentCredential(), null);

  const boot = await import("../src/native.js");
  check("a browser is never hydrating", boot.nativeHydrating(), false);
  check("and has no host to describe", boot.nativeBoot(), null);
  check("so the control plane is this page's own origin", boot.controlPlaneOrigin(), "http://127.0.0.1");
}

/* ------------------------------------------------------------------ *
 * The transport, and the two ways a host can get a refusal wrong
 * ------------------------------------------------------------------ */

process.stdout.write("\nthe control-plane transport\n");
{
  const { cpSend } = await import("../src/native.js");
  const fetched: { path: string; init: unknown }[] = [];
  const original = (globalThis as Record<string, unknown>)["fetch"];
  (globalThis as Record<string, unknown>)["fetch"] = async (path: string, init: unknown): Promise<Response> => {
    fetched.push({ path, init });
    return new Response('{"ok":true}', { status: 200 });
  };

  leaveShell();
  calls.length = 0;
  const browserAnswer = await cpSend("/v1/me", { method: "GET" });
  check("in a browser the path goes to fetch untouched", fetched.map((f) => f.path), ["/v1/me"]);
  check("and the answer is the browser's own", await browserAnswer.json(), { ok: true });
  check("nothing reached the shell", calls.length, 0);

  enterShell();
  calls.length = 0;
  fetched.length = 0;
  answer = async () => ({ status: 200, statusText: "OK", body: '{"ok":true}' });
  const shellAnswer = await cpSend("/v1/me", { method: "GET", headers: { authorization: "Bearer rs_x" } });
  check("in the shell nothing reaches the page's fetch", fetched.length, 0);
  check("the one command carries the request", calls.map((c) => c.command), ["host_cp"]);
  /*
   * ⚠ **A path, never a URL.** The base URL lives in the host process, so this is
   * the assertion that `cp.ts`'s oldest rule — the credential goes to one origin and
   * nowhere else — is enforced somewhere the page cannot reach. A `req.path` that
   * were ever absolute would make the host a general-purpose proxy for this page.
   */
  const sent = calls[0]?.args["req"] as Record<string, unknown>;
  check("as a path rather than a URL", sent["path"], "/v1/me");
  check("with no origin named by the page", sent["origin"], null);
  check("and only the headers cp.ts built", sent["headers"], [["authorization", "Bearer rs_x"]]);
  check("the answer is rebuilt as a Response", shellAnswer.status, 200);
  check("and its body survives", await shellAnswer.json(), { ok: true });

  /*
   * A refusal the control plane authored comes back as a `Response`, so `parseBody`
   * reads the error envelope exactly as it does in a browser.
   */
  const { ApiError, readJson } = await import("../src/http.js");
  answer = async () => ({ status: 401, statusText: "Unauthorized", body: '{"error":{"code":"session_expired","message":"gone"}}' });
  const refused = await cpSend("/v1/me");
  let caught: unknown = null;
  await readJson(refused).catch((error: unknown) => {
    caught = error;
  });
  check("a refusal is an ApiError with the server's own code", caught instanceof ApiError && caught.code, "session_expired");

  /*
   * ⚠ **And a failure is a rejection, never a status.** `isTransportFailure` is a
   * negation — anything that is not an `ApiError` — so a host that answered a
   * transport failure as a 401 would sign the whole fleet out on the first subway
   * tunnel, with the table in the previous section still green.
   */
  const { isTransportFailure } = await import("../src/http.js");
  answer = async () => {
    throw new Error("could not reach the server");
  };
  let thrown: unknown = null;
  await cpSend("/v1/me").catch((error: unknown) => {
    thrown = error;
  });
  check("a host failure rejects rather than answering", thrown instanceof Error, true);
  check("and reads as a transport failure rather than a credential one", isTransportFailure(thrown), true);
  const { authFailure } = await import("../src/account.js");
  check("so it never ends the session", authFailure(thrown), null);

  /* A bodiless status must not be handed a body; `new Response` throws on one. */
  answer = async () => ({ status: 204, statusText: "No Content", body: "" });
  check("a 204 is rebuilt without throwing", (await cpSend("/v1/me")).status, 204);

  (globalThis as Record<string, unknown>)["fetch"] = original;
  leaveShell();
}

/* ------------------------------------------------------------------ *
 * The rule a transport swap loses silently
 * ------------------------------------------------------------------ */

process.stdout.write("\na refusal about a credential that is no longer held\n");
{
  /*
   * ⚠ **The sharpest hazard in the whole migration, driven over the native
   * transport.** `cpFetch` captures `const sent = credential` before building the
   * header and tears down only while `credential === sent`; its docblock records the
   * exact ten-second race — a slow call sent with an expired token, a wake, a
   * sign-in that succeeds, and then the old request answering `401 session_expired`
   * and clearing the *new* credential. The window is `CP_TIMEOUT_MS` wide whichever
   * transport is carrying the request, so the rule has to hold on both.
   */
  storage.clear();
  enterShell();
  cp.setSession("rs_stale");

  // Initialized rather than nullable: a `let x: (() => void) | null = null` assigned
  // inside a Promise executor is still `null` to the compiler at the call below.
  let release = (): void => undefined;
  const parked = new Promise<void>((resolve) => {
    release = () => resolve();
  });
  answer = async () => {
    await parked;
    return { status: 401, statusText: "Unauthorized", body: '{"error":{"code":"session_expired","message":"gone"}}' };
  };

  const inFlight = cp.me().catch((error: unknown) => error);
  cp.setSession("rs_fresh");
  check("a sign-in during the call replaces the credential", cp.currentCredential()?.value, "rs_fresh");
  release();
  const landed = await inFlight;
  check("the caller is still told the call failed", (landed as { code?: string }).code, "session_expired");
  check("but the credential it was not about is untouched", cp.currentCredential()?.value, "rs_fresh");

  /* And the ordinary case still signs you out, or the rule above is vacuous. */
  calls.length = 0;
  answer = async () => ({ status: 401, statusText: "Unauthorized", body: '{"error":{"code":"session_expired","message":"gone"}}' });
  await cp.me().catch(() => undefined);
  check("a refusal about the credential in hand does clear it", cp.currentCredential(), null);
  check("and the store is told to forget it", calls.some((c) => c.command === "host_credential_clear"), true);

  leaveShell();
  storage.clear();
}
