/**
 * The Telegram Mini App bridge, hand-written, with no script from anybody else.
 *
 * This app opens inside Telegram as a mini app, where the client draws its own
 * chrome over or above the page: **✕ Close** by default, and **‹ Back** instead
 * once the page asks for one. Asking is one of the two things this module does, so
 * the session list closes the app and a conversation goes back to the list —
 * reported from a phone, where Close was the only option at every depth.
 *
 * The other is asking **where that chrome is**, which is a number only Telegram
 * knows: `env(safe-area-inset-*)` reads 0 inside a mini-app webview whatever the
 * device, so the page cannot see the notch either. Both answers are events; see
 * {@link watchTelegramInsets} and {@link telegramInsets}.
 *
 * **No `telegram-web-app.js`, and two independent reasons.** The document is
 * served `script-src 'self'`, so a CDN script is refused before it runs; and
 * nothing in this repository loads code from anywhere else. Neither is a
 * limitation here, because that script is a **wrapper**: on iOS and Android
 * Telegram injects the transport itself as `TelegramWebviewProxy`, and the SDK's
 * whole job on this path is `JSON.stringify` plus a version check. Verified
 * against the real file rather than from memory — see the shapes below.
 *
 * **Owning `window.Telegram` is safe here for the same reason.** Telegram
 * delivers events by *calling* `window.Telegram.WebView.receiveEvent`, so
 * something must define it; normally that is the SDK. Under `script-src 'self'`
 * the SDK can never load, so there is no second writer to collide with. If that
 * header is ever relaxed, this becomes a real collision and the remedy is to
 * stop defining it and read theirs.
 *
 * **The iframe transport is deliberately absent.** Telegram Desktop and Web embed
 * a mini app in an `<iframe>` and expect `window.parent.postMessage`; the control
 * plane sends `frame-ancestors 'none'` and `X-Frame-Options`, so those clients
 * cannot load this page at all and the arm would be unreachable code. Adding it is
 * the *second* half of allowing Telegram to frame a document whose purpose is
 * approving shell commands with a tap — see the CSP's own docblock. Do both or
 * neither.
 *
 * Everything here answers "not in Telegram" in an ordinary browser, so nothing
 * below runs and nothing changes.
 */

/** What Telegram injects into its own webview, and nothing else does. */
interface Proxy {
  postEvent?: (eventType: string, eventData: string) => void;
}

interface TelegramGlobal {
  WebView?: { receiveEvent?: (eventType: string, eventData?: unknown) => void };
}

function proxy(): Proxy | null {
  const held = (window as unknown as { TelegramWebviewProxy?: Proxy }).TelegramWebviewProxy;
  return typeof held?.postEvent === "function" ? held : null;
}

/**
 * Whether this page is running inside Telegram at all.
 *
 * Keyed on the transport being there rather than on the launch parameters, which
 * is the narrower and more honest test: what everything below needs is somewhere
 * to post to, and a hash somebody pasted is not that.
 */
export function inTelegram(): boolean {
  return proxy() !== null;
}

/**
 * The mini-app API version this client speaks, or `null` outside Telegram.
 *
 * Read from `tgWebAppVersion` in the launch hash, which is where Telegram puts
 * it. Parsed defensively for `router.ts`'s reason one module over: this runs
 * during startup, and a malformed hash somebody pasted must produce a `null`
 * rather than an exception nothing catches.
 *
 * ⚠ It shares the fragment with the mailed-link tokens, and they do not collide:
 * `readGateToken` accepts only a `t=` parameter whose value is token-shaped, and
 * Telegram writes `tgWebApp*` names.
 */
export function telegramVersion(): string | null {
  try {
    const raw = window.location.hash.startsWith("#")
      ? window.location.hash.slice(1)
      : window.location.hash;
    return new URLSearchParams(raw).get("tgWebAppVersion");
  } catch {
    return null;
  }
}

/**
 * Whether this client is new enough for a feature, by Telegram's own rule.
 *
 * Segment-wise on integers, so `6.10` is above `6.9` — a string compare answers
 * the opposite, and the back button's own gate is `6.1`. A version that will not
 * parse counts as **too old**: refusing a control is a control that is not there,
 * while asking an old client for one is a request it answers by doing nothing,
 * which is a back button drawn nowhere and a page that thinks it has one.
 */
export function versionAtLeast(version: string | null, wanted: string): boolean {
  if (version === null) return false;
  const mine = version.split(".");
  const theirs = wanted.split(".");
  for (let at = 0; at < Math.max(mine.length, theirs.length); at += 1) {
    const a = Number.parseInt(mine[at] ?? "0", 10);
    const b = Number.parseInt(theirs[at] ?? "0", 10);
    if (!Number.isFinite(a)) return false;
    if (a !== b) return a > b;
  }
  return true;
}

/** Bot API 6.1, which is where `web_app_setup_back_button` starts existing. */
const BACK_BUTTON_SINCE = "6.1";

/**
 * The version as it was **at launch**, because the fragment does not survive one.
 *
 * ⚠ **This is the whole of why the back button never appeared, and the defect is
 * two modules away.** `router.ts`'s `navigate` calls
 * `history.pushState(state, "", path)` with a path that carries no fragment, and
 * that replaces the *whole* URL — so Telegram's launch parameters are gone the
 * first time anybody opens anything. {@link telegramVersion} then answered `null`
 * on every screen but the one the app started on, {@link versionAtLeast} read that
 * as "too old", and {@link setTelegramBack} returned before posting: Telegram was
 * never asked for a back button and went on drawing **✕ Close** at every depth,
 * which is what was reported from a phone. Closing the mini app was the only
 * control on a conversation screen.
 *
 * It is not a bug `webcheck` could have caught as it was written: the driver sets
 * `location.hash` immediately before each call, so the read always succeeded. What
 * is asserted now is the sequence that actually happens — latch, navigate away
 * from the fragment, ask — which is the one this got wrong.
 *
 * `null` until {@link telegramReady} runs, and the read below falls back to the
 * live fragment while it is: that keeps the old behaviour as the floor rather than
 * making a back button conditional on one call in `main.tsx` having happened.
 *
 * **And it is written to `sessionStorage`, because a *reload* loses it too.** A
 * latch survives navigation and nothing more, and this app reloads itself in
 * anger — `store.ts` and `KeysSection` both assign `window.location.href = "/"` on
 * sign-out, and `ErrorBoundary` offers the same. Telegram's own
 * `telegram-web-app.js` does exactly this and for exactly this reason: it copies
 * the launch parameters into `sessionStorage` and merges them back on every load,
 * because losing the fragment is expected rather than particular to us. Their
 * docs say so outright — *"If the application uses hash routing, it may lose the
 * initial hash after some time. Therefore, it's advisable to save this data during
 * the initial launch."*
 *
 * Only the **version** is kept, never `tgWebAppData`. That parameter is a signed
 * credential naming a Telegram account, this app authenticates against its own
 * control plane and has never read it, and a copy of it in `sessionStorage` would
 * be a credential this origin stores for no reason at all.
 */
let launched: string | null = null;

/** Ours, and namespaced like every other key this origin owns. */
const LAUNCH_VERSION_KEY = "reemoat.telegramVersion";

function rememberLaunch(version: string): void {
  try {
    window.sessionStorage.setItem(LAUNCH_VERSION_KEY, version);
  } catch {
    // Private browsing, storage disabled, or a webview that has none. The latch
    // above still covers every path that does not reload, which is most of them.
  }
}

function recallLaunch(): string | null {
  try {
    return window.sessionStorage.getItem(LAUNCH_VERSION_KEY);
  } catch {
    return null;
  }
}

function launchVersion(): string | null {
  return launched ?? telegramVersion() ?? recallLaunch();
}

function post(eventType: string, eventData: unknown = {}): void {
  const held = proxy();
  if (held === null) return;
  try {
    held.postEvent?.(eventType, JSON.stringify(eventData));
  } catch {
    // The bridge is somebody else's code in somebody else's webview. A throw
    // here must cost the chrome and never the app: every caller is decoration.
  }
}

/**
 * Tell Telegram the page is up, so it takes its loading placeholder away.
 *
 * Fired once, from `main.tsx`, and unconditional past `inTelegram` — an app that
 * never says this is one Telegram keeps a spinner over.
 *
 * **It also latches the launch version, and this is the right moment because it is
 * the only one that means *launch*.** It runs from `main.tsx`'s module body, before
 * `createRoot` and therefore before any effect can call `navigate` and take the
 * fragment away — see {@link launched} for what that costs when it is read later
 * instead.
 */
export function telegramReady(): void {
  launched = telegramVersion() ?? recallLaunch();
  if (launched !== null) rememberLaunch(launched);
  post("web_app_ready");
}

/** Callers of the back button, so a press reaches whatever is on screen now. */
let onBack: (() => void) | null = null;
let listening = false;

/**
 * Start receiving events, by defining the function Telegram calls.
 *
 * Idempotent, and installed lazily on the first `setTelegramBack` rather than at
 * import: a module body that writes a global on a page that is not in Telegram is
 * a global nobody asked for.
 */
function listen(): void {
  if (listening) return;
  listening = true;
  const global = window as unknown as { Telegram?: TelegramGlobal };
  const existing = global.Telegram ?? {};
  const view = existing.WebView ?? {};
  const previous = view.receiveEvent;
  view.receiveEvent = (eventType: string, eventData?: unknown): void => {
    // Chained rather than replaced. Nothing else defines this today — see the
    // docblock — and a handler that silently drops somebody else's events is the
    // kind of thing that is only ever found much later.
    previous?.(eventType, eventData);
    if (eventType === "back_button_pressed") onBack?.();
    if (eventType === "safe_area_changed") receiveInset("device", eventData);
    if (eventType === "content_safe_area_changed") receiveInset("chrome", eventData);
  };
  existing.WebView = view;
  global.Telegram = existing;
}

/** Bot API 8.0, which is where the two safe-area events start existing. */
const SAFE_AREA_SINCE = "8.0";

/**
 * The two numbers Telegram will state, once asked, or `null` before it has.
 *
 * `null` is not zero and the difference is the whole design: a client older than
 * 8.0 never answers, and a page that read that as "no chrome to avoid" would draw
 * its header under a floating ✕ — which is the defect the 3.25rem literal was
 * measured to fix. Only a client that actually answers moves anything.
 */
let deviceInset: Insets | null = null;
let chromeInset: Insets | null = null;

interface Insets {
  top: number;
  bottom: number;
}

/** A number Telegram sent, or `null` for anything that is not one. */
function inset(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Read one of the two payloads, defensively, and write what it means.
 *
 * The payload arrives **already parsed** on the injected transport — the SDK's own
 * handlers read `eventData.top` with no `JSON.parse` — but a string is accepted
 * too, for `telegramVersion`'s reason one screen up: this is somebody else's
 * webview and a shape we did not expect must cost nothing rather than throw
 * through a handler Telegram called into.
 */
function receiveInset(which: "device" | "chrome", raw: unknown): void {
  let data = raw;
  if (typeof data === "string") {
    try {
      data = JSON.parse(data) as unknown;
    } catch {
      return;
    }
  }
  if (typeof data !== "object" || data === null) return;
  const held = data as { top?: unknown; bottom?: unknown };
  const next: Insets = { top: inset(held.top) ?? 0, bottom: inset(held.bottom) ?? 0 };
  if (which === "device") deviceInset = next;
  else chromeInset = next;
  writeInsets(telegramInsets(deviceInset, chromeInset));
}

/**
 * How much room to leave at each edge, in CSS pixels, or `null` while unanswered.
 *
 * ⚠ **The two are added, and that is the one thing here measured from documents
 * rather than from a device.** `safeAreaInset` is *"the device's safe area insets,
 * accounting for system UI elements like notches or navigation bars"* — "the space
 * to avoid at the top of the **screen**". `contentSafeAreaInset` is *"the safe area
 * for displaying content within the app, free from overlapping Telegram UI
 * elements"* — "the space to avoid at the top of the **content area**", i.e. of
 * what is left after the first. Nested, therefore additive, and that is how
 * Telegram's own SDK leaves them: it writes four CSS properties per object and
 * combines nothing, so every page doing this adds them.
 *
 * It is the direction to be wrong in if it is wrong. Over-adding costs a band of
 * empty space; taking the larger of the two instead would put the header under
 * Telegram's pill on a notched phone, which is the failure that started all of
 * this. **What settles it is one screenshot in fullscreen mode**, where both are
 * non-zero — in the ordinary presentation Telegram reserves its own header above
 * the webview and reports `0` for both, which is the case that was reported.
 */
export function telegramInsets(
  device: { top: number; bottom: number } | null,
  chrome: { top: number; bottom: number } | null,
): Insets | null {
  if (device === null && chrome === null) return null;
  return {
    top: (device?.top ?? 0) + (chrome?.top ?? 0),
    bottom: (device?.bottom ?? 0) + (chrome?.bottom ?? 0),
  };
}

/**
 * Hand the answer to the stylesheet, which is where the decision is spent.
 *
 * ⚠ **`--tg-chrome-*` and deliberately not Telegram's own spelling.** The SDK
 * writes `--tg-safe-area-inset-top` and `--tg-content-safe-area-inset-top` onto the
 * same element; taking those names would make this page a second writer of
 * properties somebody else's script owns, which is the collision this module's
 * docblock says `window.Telegram` is one relaxed header away from. One name, ours,
 * with theirs cited here.
 */
function writeInsets(values: Insets | null): void {
  if (values === null) return;
  const root = document.documentElement;
  root.style.setProperty("--tg-chrome-top", `${values.top}px`);
  root.style.setProperty("--tg-chrome-bottom", `${values.bottom}px`);
}

/**
 * Ask Telegram where its own chrome is, once, at launch.
 *
 * ⚠ **`listen()` before `post()`, and that ordering is the whole function.** Both
 * answers arrive as *events*, so a request posted before the receiver exists is a
 * request answered into nothing — and the symptom would be the 3.25rem band never
 * going away, i.e. indistinguishable from not having built this.
 *
 * Gated on 8.0 rather than asked unconditionally: an older client answers nothing,
 * and a request it ignores is indistinguishable from one it has not got round to,
 * so the gate is what makes "no answer" mean "no answer" rather than "wait".
 */
export function watchTelegramInsets(): void {
  if (!inTelegram()) return;
  if (!versionAtLeast(launchVersion(), SAFE_AREA_SINCE)) return;
  listen();
  post("web_app_request_safe_area");
  post("web_app_request_content_safe_area");
}

/**
 * Show or hide Telegram's back button, and say what a press does.
 *
 * `null` hides it, which is what makes the client draw **Close** again — the two
 * are one control and one call, so "Close on the list, Back inside" is this
 * function being given `null` at the root and a destination everywhere else.
 *
 * The handler is replaced rather than accumulated: there is one back button and
 * one screen under it, and a stack of stale closures is how a press ends up
 * navigating to where you were three screens ago.
 */
export function setTelegramBack(go: (() => void) | null): void {
  if (!inTelegram()) return;
  // The launch value, never the live fragment — {@link launched} says why.
  if (!versionAtLeast(launchVersion(), BACK_BUTTON_SINCE)) return;
  listen();
  onBack = go;
  post("web_app_setup_back_button", { is_visible: go !== null });
}
