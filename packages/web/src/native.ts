import { openableHref } from "./ui/links";

/**
 * The native shell, from inside the page.
 *
 * **Hand-written, feature-detected, and with no dependency of its own** — the same
 * three properties as `telegram.ts`, for the same three reasons. This app runs in
 * an ordinary browser, in a Telegram mini app, and in a Tauri window, and the way
 * it stays one app is that each of those is a module answering "not here" when it
 * is not there. Every export below has a browser arm, and no call site branches.
 *
 * ⚠ **No `@tauri-apps/*` package is imported, and that is a property rather than a
 * simplification.** `packages/web` is the bundle the control plane's image serves,
 * so a native-only module in its dependency tree would ship to every browser in
 * the fleet. `app.withGlobalTauri` in `tauri.conf.json` puts the one function this
 * needs on `window`, and `TauriCore` below is the whole of what is assumed about
 * it. `pnpm nativecheck` asserts both halves, because either alone would pass
 * while the other broke.
 *
 * **What the shell is for, in one list.** Four things the webview cannot do for
 * itself, and nothing else:
 *
 *   1. reach the control plane, which mounts no CORS at all (`src/cors.ts` is the
 *      daemon's and the relay's; `packages/control-plane/src/app.ts` has none),
 *   2. keep a sign-in in the operating system's credential store rather than in
 *      `localStorage`, keyed on the server it belongs to,
 *   3. open a link in the real browser,
 *   4. write a file through a save panel.
 *
 * Everything else — the relay, the daemons, the WebSocket, the cursor rules, the
 * make-before-break rotation, `sendWithProgress`'s upload progress — stays in the
 * webview and is the same code the browser client runs. `.claude/rules/native-shell.md`
 * carries the four reasons that split is a count rather than a habit.
 */

/**
 * What `withGlobalTauri` injects, and the only thing assumed about it.
 *
 * `invoke` is the whole surface: the commands are this app's own, declared in
 * `packages/native/src-tauri/src/commands.rs`, and an app-defined command needs no
 * entry in a capability file — so `commands.rs` *is* the capability surface and
 * this interface is the client for it.
 */
interface TauriCore {
  invoke?: <T>(command: string, args?: unknown, options?: { headers?: Record<string, string> }) => Promise<T>;
}

interface TauriGlobal {
  core?: TauriCore;
}

/**
 * Keyed on the transport existing, never on a user-agent string or a build flag.
 *
 * `telegram.ts`'s `proxy()` one file over, and the idiom is the point: the only
 * honest question is "is the thing that carries a call actually here", and a
 * `import.meta.env`-style flag would answer it wrongly in exactly the case that
 * matters — a native build whose bridge failed to inject.
 */
function core(): TauriCore | null {
  const held = (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__;
  return typeof held?.core?.invoke === "function" ? held.core : null;
}

export function inNativeShell(): boolean {
  return core() !== null;
}

/**
 * Call a command, or throw.
 *
 * Unlike `telegram.ts`'s `post`, this does **not** swallow. There every caller is
 * decoration and a throw must cost the chrome rather than the app; here a caller
 * is a control-plane request or a sign-in being saved, and a failure that reads as
 * a success is the worse outcome. Each caller below decides what to do with it.
 */
async function invoke<T>(command: string, args?: unknown, options?: { headers?: Record<string, string> }): Promise<T> {
  const held = core();
  if (held?.invoke === undefined) throw new TypeError("not running in the Reemoat shell");
  return await held.invoke<T>(command, args, options);
}

/** What the first paint needs, and it arrives in one round trip. */
export interface NativeBoot {
  /** The chosen control-plane origin, or `null` where nobody has chosen one. */
  server: string | null;
  /**
   * The credential for that server, out of the OS keyring.
   *
   * It lives in this page's memory from here, exactly as it does in a browser, and
   * **never in `localStorage`**. Holding the value in the shell instead was
   * considered and refused: `cpFetch` attributes a 401 by comparing
   * `credential === sent` by identity, and a handle it cannot compare would lose
   * the rule that stops a late 401 signing you out of a session you just started.
   */
  credential: string | null;
  platform: string;
  appVersion: string;
  /**
   * `false` where this machine's credential store took a canary and lost it — a
   * Linux box with no unlocked keyring, most often. The app works for the session
   * and asks for the password again next time, which is the state `cp.ts` already
   * has a sentence for; this is the same state arriving by a different cause, and
   * it must draw the same words.
   */
  durable: boolean;
}

let boot: NativeBoot | null = null;
let hydrating = inNativeShell();

/**
 * One call, started at import, awaited by `store.bootstrap()`.
 *
 * ⚠ **The ordering this exists for.** `cp.ts` reads its credential
 * **synchronously in the module body**, because a module is imported once and that
 * is what makes the migration rule testable without a DOM. A keyring is async. So
 * rather than making `currentCredential()` async — which would ripple into every
 * call site and into `webcheck`'s module-evaluation order — the native arm starts
 * empty and is filled here, and `nativeHydrating()` is what stops the store
 * drawing the sign-in screen in the frame before it lands.
 *
 * The two alternatives were both worse and both are recorded rather than
 * rediscovered. An `await` gate in `main.tsx` moves `installWakeDetection()` and
 * the Telegram launch sequence into an async body, and that ordering is asserted
 * off disk. Injecting the value with Tauri's `initialization_script` is fixed at
 * window creation, so the reload in `store.signOut()` would re-inject the
 * credential `clearSession()` had just deleted — which is exactly the defect
 * `setSession`'s own docblock records having shipped once.
 */
export const hostReady: Promise<NativeBoot | null> = inNativeShell()
  ? invoke<NativeBoot>("host_boot")
      .then((answer) => {
        boot = answer;
        return answer;
      })
      .catch(() => null)
      .finally(() => {
        hydrating = false;
      })
  : Promise.resolve(null);

/**
 * True only between this module's import and `hostReady` settling, and only in the
 * shell.
 *
 * Synchronous, because `inNativeShell()` is: the global is injected before any
 * page script runs, so the answer to "will there be a credential" is knowable in
 * the first frame even though the credential itself is not.
 */
export function nativeHydrating(): boolean {
  return hydrating;
}

/** What the shell answered, once it has. `null` in a browser, for ever. */
export function nativeBoot(): NativeBoot | null {
  return boot;
}

/**
 * Where the control plane is.
 *
 * `location.origin` in a browser, which is what every caller used to pass
 * directly. In the shell it is the chosen server — and the callers that matter are
 * the ones printing an install command: `installCommand(location.origin)` under a
 * custom scheme prints `curl -fsSL 'tauri://localhost/install.sh' | sh`, an
 * installer that joins nothing.
 *
 * ⚠ Not the relay, and never derived from this. A machine's relay URL arrives per
 * machine from `POST /v1/tokens`; the two addresses are unrelated by design, and a
 * client that derived one from the other would break the first fleet that moved
 * its relay.
 */
export function controlPlaneOrigin(): string {
  return boot?.server ?? window.location.origin;
}

/**
 * What may cross the bridge on a control-plane request, stated as a type.
 *
 * Deliberately narrower than `RequestInit`. A `FormData`, a `ReadableStream` or a
 * `Blob` body has no representation on the other side, and all four call sites in
 * `cp.ts` pass a string or nothing — so this type is complete, and widening it is
 * the edit that would otherwise silently drop a body.
 */
export interface CpInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

interface CpAnswer {
  status: number;
  statusText: string;
  body: string;
}

/** Statuses a `Response` may not carry a body for; `new Response` throws otherwise. */
const BODILESS = new Set([204, 205, 304]);

function answerToResponse(answer: CpAnswer): Response {
  const body = BODILESS.has(answer.status) || answer.body.length === 0 ? null : answer.body;
  return new Response(body, { status: answer.status, statusText: answer.statusText });
}

/**
 * Send a `/v1` request, wherever this app is running.
 *
 * **In a browser this is `fetch` and nothing else**, which is what makes the web
 * build provably unchanged: same function, same arguments, same `Response`.
 *
 * In the shell it goes through the host process, because the control plane mounts
 * no CORS middleware at all — deliberately, on its side: `vite.config.ts` proxies
 * `/v1` in dev *"instead of making dev the one place a CORS rule has to exist for
 * the control plane"*. A webview `fetch` from `tauri://localhost` would preflight
 * and be refused, and the remedy nobody wants is a CORS layer on the one service
 * that has never needed one.
 *
 * ⚠ **A path is sent, never a URL.** The base lives in the host process, so
 * `cp.ts`'s oldest rule — *the credential is sent here and nowhere else* — is
 * enforced somewhere the page cannot reach, which is stronger than same-origin
 * rather than weaker.
 *
 * ⚠ **A failure is a rejection, never a status.** `isTransportFailure` in
 * `http.ts` is a *negation* — anything that is not an `ApiError` — and `errorText`
 * narrows on `instanceof Error`, so the host's failures are re-thrown as
 * `TypeError`. Get this backwards and either a subway tunnel signs the whole fleet
 * out, or a real `401 session_expired` never signs anybody out at all.
 */
export async function cpSend(path: string, init: CpInit = {}): Promise<Response> {
  if (!inNativeShell()) return await fetch(path, init);
  return answerToResponse(await hostCall(path, init, null));
}

/**
 * The same request against an origin that has not been adopted yet.
 *
 * The server picker's own verb, and the only caller that names an origin at all:
 * every other call takes the stored one. Kept separate from `cpSend` rather than
 * given an optional argument, so "which origin does a control-plane call go to" has
 * exactly one answer at every other call site in this app.
 */
export async function probeServer(origin: string, path: string, init: CpInit = {}): Promise<Response> {
  return answerToResponse(await hostCall(path, init, origin));
}

async function hostCall(path: string, init: CpInit, origin: string | null): Promise<CpAnswer> {
  const headers = Object.entries(init.headers ?? {}).map(([name, value]) => [name, value] as [string, string]);
  const request = {
    path,
    method: init.method ?? "GET",
    headers,
    body: init.body ?? null,
    origin,
  };
  /*
   * The caller's `AbortSignal` cannot cancel an `invoke`, so it is raced rather
   * than passed. `CP_TIMEOUT_MS` stays the one number that decides how long a
   * control-plane call may take; the host's own timeout is a backstop against a
   * socket that neither answers nor closes, set deliberately longer so it can
   * never become a second policy.
   */
  const call = invoke<CpAnswer>("host_cp", { req: request }).catch((error: unknown) => {
    throw new TypeError(error instanceof Error ? error.message : String(error));
  });
  const signal = init.signal;
  if (signal === undefined) return await call;
  return await Promise.race([
    call,
    new Promise<never>((_, reject) => {
      if (signal.aborted) {
        reject(new DOMException("aborted", "AbortError"));
        return;
      }
      signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    }),
  ]);
}

/**
 * Save or clear the credential in the OS store.
 *
 * Fire-and-forget with the same posture as `setSession`'s `try`: in-memory is a
 * usable degraded mode and an exception here must not stop the caller. A machine
 * whose keyring is unusable is exactly the `durable: false` state, and the app
 * already has a sentence for it.
 */
export function setNativeCredential(value: string | null): void {
  if (!inNativeShell()) return;
  void invoke(value === null ? "host_credential_clear" : "host_credential_set", value === null ? {} : { value }).catch(
    () => undefined,
  );
}

/**
 * Adopt a server, and answer the one canonical spelling of it.
 *
 * **The host normalizes, and this returns its answer** rather than computing one
 * here. One authority on "which server is this" is the whole point: two
 * normalizers is two spellings of one origin, which is two credential keys, one of
 * which a sign-out would not reach. So there is deliberately no validator in this
 * file — the form submits, and the host answers either the origin or a sentence.
 */
export async function setNativeServer(url: string): Promise<string> {
  return await invoke<string>("host_set_server", { url });
}

/** The clipboard, through the platform rather than through the webview. */
export async function copyNative(text: string): Promise<boolean> {
  try {
    await invoke("host_copy_text", { text });
    return true;
  } catch {
    return false;
  }
}

/**
 * Hand a file to the person who asked for it, through a real save panel.
 *
 * **Raw bytes, never JSON.** The client's download bound is 100 MiB, and that as a
 * JSON array of numbers is roughly 600 MB of string — so the body is an
 * `ArrayBuffer`, which Tauri carries over its own IPC protocol as bytes, and the
 * filename rides in a header because a header is the only other field a raw
 * request has. Percent-encoded, because a header value is ASCII and a filename is
 * the one field somebody definitely did not type in ASCII.
 *
 * `false` where the panel was dismissed, which is not a failure.
 */
export async function saveNative(blob: Blob, filename: string): Promise<boolean> {
  const bytes = await blob.arrayBuffer();
  return await invoke<boolean>("host_save_file", bytes, {
    headers: { "x-reemoat-filename": encodeURIComponent(filename) },
  });
}

/**
 * Send a link to the browser instead of to this window.
 *
 * ⚠ **Installed from the module body, gated on the shell, and that is the whole
 * reason `main.tsx` needs no line for any of this.** `telegram.ts` is called from
 * there because it has chrome to configure and a readiness to announce; this has
 * neither. In a browser nothing is installed at all, so the driver's `window` stub
 * — which has a `location` and a `localStorage` and no more — is never touched.
 *
 * **Capture phase, and `openableHref` is the decision.** Reusing that function
 * rather than re-deriving the rule is what keeps one allowlist: `links.ts` holds
 * the argument for why the list is three schemes long, and a second copy here
 * would be a second policy on a page that renders agent output. The shell carries
 * a third copy as a backstop, and `pnpm nativecheck` compares it to this one's
 * source.
 *
 * A modified click is left alone: on a desktop those are the shortcuts that mean
 * "not the default thing", and `preventDefault` on them would be this app deciding
 * it knows better.
 */
function interceptExternalLinks(): void {
  document.addEventListener(
    "click",
    (event) => {
      if (event.defaultPrevented) return;
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      const anchor = target.closest("a[href]");
      if (anchor === null) return;
      const href = openableHref(anchor.getAttribute("href") ?? undefined);
      if (href === null) return;
      event.preventDefault();
      void invoke("host_open_external", { url: href }).catch(() => undefined);
    },
    true,
  );
}

if (inNativeShell()) interceptExternalLinks();
