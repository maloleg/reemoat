---
paths:
  - packages/web/src/telegram.ts
  - packages/web/src/main.tsx
  - packages/web/src/index.css
  - packages/web/scripts/webcheck.navigation-and-telegram.ts
---

# Running inside Telegram

This app opens as a Telegram mini app, in a webview owned by somebody else, with
that client's own chrome drawn over or above it. **Everything here is a fact about
Telegram rather than a decision of ours**, and each one was a defect on a phone
before it was written down. `telegram.ts` is the whole bridge; it was globbed by
no rule at all until this file existed, which is why two of the three below
shipped twice.

## The bridge is hand-written, and stays that way

**No `telegram-web-app.js`, and two independent reasons.** The document is served
`script-src 'self'`, so a CDN script is refused before it runs; and nothing in
this repository loads code from anywhere else. Neither is a limitation, because
that script is a **wrapper**: on iOS and Android Telegram injects the transport
itself as `TelegramWebviewProxy`, and the SDK's whole job on this path is
`JSON.stringify` plus a version check.

**Owning `window.Telegram` is safe for the same reason.** Telegram delivers events
by *calling* `window.Telegram.WebView.receiveEvent`, so something must define it;
normally that is the SDK, and under `script-src 'self'` the SDK can never load. If
that header is ever relaxed this becomes a real collision, and the remedy is to
stop defining it and read theirs. `listen()` chains rather than replaces for the
same reason, and is installed lazily so a page that is not in Telegram writes no
global.

**The iframe transport is deliberately absent.** Telegram Desktop and Web embed a
mini app in an `<iframe>` and expect `window.parent.postMessage`; the control
plane sends `frame-ancestors 'none'` and `X-Frame-Options`, so those clients
cannot load this page at all and the arm would be unreachable code. Adding it is
the *second* half of allowing Telegram to frame a document whose purpose is
approving shell commands with a tap. Do both or neither. `webcheck` asserts the
absence over the file with comments stripped — the docblock names the thing it
refuses, so an unstripped sweep fails on its own explanation.

**`inTelegram()` is keyed on the transport being injected**, never on the launch
parameters: what everything below needs is somewhere to post to, and a hash
somebody pasted is not that. `main.tsx` writes `data-telegram` on that answer.

## ⚠ The launch fragment does not survive a navigation

`router.ts`'s `navigate` calls `history.pushState(state, "", path)` with a
path-only URL, which replaces the **whole** URL — so `#tgWebAppVersion=…` is gone
the first time anybody opens anything.

Read live, `telegramVersion()` therefore answered `null` on every screen but the
one the app started on, `versionAtLeast` read that as *too old* by its own
fail-closed rule, and `setTelegramBack` returned before posting. **The only
`web_app_setup_back_button` this app ever successfully sent was the one on the
list, and it sends `is_visible: false`** — the single call that survived was the
one that *hides* the control. ✕ Close at every depth, and closing the app was the
only exit from a conversation.

So the version is **latched at `telegramReady`**, which runs from `main.tsx`'s
module body before `createRoot` and therefore before any effect can navigate, and
mirrored into `sessionStorage` because a *reload* loses it too — this app assigns
`window.location.href = "/"` on sign-out and offers the same from the error
boundary. Telegram's own SDK does exactly this, for exactly this reason, and their
docs say so: *"If the application uses hash routing, it may lose the initial hash
after some time."* Only the **version** is kept, never `tgWebAppData` — that is a
signed credential naming a Telegram account, this app has never read it, and a
copy in `sessionStorage` would be a credential this origin stores for no reason.

`webcheck` was green over all of it because the driver set `location.hash`
immediately before each call, which is the one condition the real app never
satisfies. What is asserted now is the sequence that actually happens: latch,
wipe the fragment, ask.

## One control, and `upFrom` is what points it

Telegram draws **✕ Close** until a mini app asks for a back button and **‹ Back**
once it has — they are one control, so "Close on the list, Back inside" is
`upFrom` answering `null` at the root and a destination everywhere else. The same
function the app's own leading control reads, because two back affordances that
disagree is worse than one. The handler is replaced rather than accumulated:
there is one back button and one screen under it, and a stack of stale closures
is how a press navigates to where you were three screens ago.

## ⚠ Where the chrome is, is a number only Telegram knows

**`env(safe-area-inset-*)` reads 0 inside a mini-app webview whatever the device**
(Telegram-iOS #1377, open). So the page cannot see the notch either, and any
`max()` against `env()` in here has exactly one live term.

There are **three** states and `[data-telegram]` distinguishes none of them:

1. Telegram floats its chrome **over** the page — ✕ Close and ⌄ ⋯ on top of the
   header. The page must spend the room. This is what the 3.25rem was measured
   against, reported with a screenshot: the session title was clipped behind it.
2. Telegram draws its header as a **bar above** the webview, which is the ordinary
   presentation. It overlaps nothing, the honest inset is 0, and the literal is
   52px of empty band under a bar that already reserved its own space. Reported
   with a second screenshot, five weeks later.
3. A client too old to say which.

So the number is **asked for**: `watchTelegramInsets` posts
`web_app_request_safe_area` and `web_app_request_content_safe_area`, the answers
arrive as `safe_area_changed` / `content_safe_area_changed`, and `telegramInsets`
writes `--tg-chrome-top` / `--tg-chrome-bottom` on the root. **`listen()` before
`post()`** — the answers are events, so a request sent before the receiver exists
is answered into nothing, and the symptom is indistinguishable from not having
built this.

**The two are added.** `safeAreaInset` is the space to avoid at the top of the
*screen*; `contentSafeAreaInset` is the space to avoid at the top of the *content
area*, i.e. of what the first leaves. Nested, therefore additive, and Telegram's
SDK writes four properties per object and combines nothing. ⚠ This is the one
thing here read from documents rather than measured on a device — and it is the
direction to be wrong in, because over-adding costs a band of empty space while
taking the larger would put the header back under the pill. **What settles it is
one screenshot in fullscreen mode**, where both are non-zero; in the ordinary
presentation both are 0.

**3.25rem is now the value of the pre-8.0 fallback rather than a floor under the
answer**, which is what bounds the change to clients that reply: state 3 keeps
exactly the header it had. `0.5rem` leads the `max()` so that an answer of `0`
falls back to the ordinary `.pt-safe` floor rather than to nothing. Still a
`max()` and still never an addition *at that line* — Q3.443's rule is untouched;
the one addition is between Telegram's own two numbers.

**The bottom edge had the same defect and nobody reported it**, because nothing
under the approve buttons *looks* wrong — it is 12px where the home indicator
wanted 34, which is what `viewport-fit=cover` was supposed to buy and silently
did not. The fallback is `0px`, so a client that cannot answer keeps today's
screen exactly.

⚠ **Neither inset may be written as a Tailwind `pt-*`/`pb-*` utility beside these
classes.** `.pt-safe`/`.pb-safe` are declared **unlayered** in `index.css` while
Tailwind emits every utility inside `@layer utilities`, and an unlayered rule
beats a layered one regardless of specificity. `Composer.tsx` records the same
trap and names the existing casualties.

## Not built

**Nothing posts `web_app_expand` or `web_app_request_fullscreen`.** The app takes
whatever presentation Telegram gives it, which is why state 2 above is the common
one. Adding either changes which state is normal and therefore what the insets
report — measure again before and after.

**Nothing reads `tgWebAppData`.** Identity here is this fleet's own credential;
a Telegram account is not a user of this product.

| File | Holds |
|---|---|
| `packages/web/src/telegram.ts` | The whole bridge: `inTelegram`, the version and its latch, `setTelegramBack`, `telegramInsets`, `watchTelegramInsets` |
| `packages/web/src/main.tsx` | The three launch statements, in order: the marker, `telegramReady` (which latches), `watchTelegramInsets` (which reads the latch) |
| `packages/web/src/index.css` | `.pt-safe`/`.pb-safe` and their `[data-telegram]` overrides |
| `packages/web/scripts/webcheck.navigation-and-telegram.ts` | `versionAtLeast` and `telegramInsets` driven pure; the transport driven against a stub; the CSS and `main.tsx` read off disk |
