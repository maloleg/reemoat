import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import * as cp from "./cp";
import { store } from "./gateStore";
import { provideSignInAuth } from "./signInAuth";
import { GateApp } from "./ui/gate/GateApp";
import { RootErrorBoundary } from "./ui/ErrorBoundary";

/**
 * The gate's entry point — the one the control plane serves.
 *
 * ⚠ **`gateStore.ts`, not `store.ts`, and that is the whole difference from
 * `main.tsx`.** The app's store is about supervising a fleet: it reads the
 * credential out of the host, lists machines, opens connections and starts a
 * four-second poll. None of that has anything to do with signing up or spending a
 * mailed link, and having it here would mint tokens and open sockets for somebody
 * who is on this page precisely because they do not have the app yet.
 *
 * That used to be a **restraint** — this file called `refreshConfig` and pointedly
 * not `bootstrap` — and a restraint was not enough. `AppStore.login` ends in
 * `await this.bootstrap()`, and so did the `adoptSession` that used to sit beside
 * it, so one tap later every one of those things happened anyway: signing in on
 * `/verify`, or registering on an instance with no mail, ran the whole fleet
 * start-up on the sign-up page. There is nothing to decline now, because there is
 * nothing linked in to decline — `adoptSession` moved into `gateStore.ts` with
 * the two screens that call it, and that store has no bootstrap to end in.
 *
 * ⚠ **The reason it is a separate store rather than a tidier call graph is bytes
 * on a phone.** `store.ts` value-imports `machine.ts`, which value-imports
 * `e2ee.ts`, which imports `@reemoat/protocol` — so this bundle carried the Noise
 * handshake, the cipher state and the frame codec to nine addresses that cannot
 * use them: a browser holds no device key, and four of those addresses are opened
 * by a mail client, typically on mobile data. `vite.gate.config.ts` holds the
 * measurement and `gateStore.ts` the argument.
 *
 * What this surface genuinely needs is the configuration — it decides whether
 * sign-up is open, whether an address is required, whether the legal documents are
 * published, and where the app can be downloaded. It is read once, here, because
 * three screens below then have something to render from; each of them re-asks for
 * itself when this read lands empty, since `refreshConfig`'s catch is bare by
 * design and a signed-out tab has nothing else that would ever ask again.
 *
 * **No wake detection either**, for the reason above's other half: it is about an
 * app that stays open and comes back. This is a page somebody visits once.
 */
/*
 * ⚠ **Which store this bundle is, said from the entry point rather than from the
 * store's own module body — and the placement is the whole of why it is correct.**
 *
 * `cp.onSignedOut` keeps one handler and `provideSignInAuth` one store; both are
 * last-writer-wins. `store.ts` registers itself from its own tail, and in `dist`
 * that is unambiguous because there is one store. Here it is not: `ui/SignIn.tsx`
 * is drawn by both bundles, so whether the app's store is also evaluated in this
 * program — and if so, whether its body runs before or after `gateStore.ts`'s —
 * is decided by the shape of the import graph, which is not a thing either store
 * can see. An entry point's body is the one position in a program that is
 * guaranteed to run after every module it pulls in, so this is the only wiring
 * that cannot be reordered out from under itself.
 *
 * What it prevents, concretely: an involuntary sign-out — an expired session on
 * `/verify` — landing in a store no screen on this surface is subscribed to, so
 * the sign-in form never appears and the card above it goes on naming somebody
 * who is no longer signed in.
 */
cp.onSignedOut((failure) => store.handleSignedOut(failure));
provideSignInAuth(store);

const root = document.getElementById("root");
if (root === null) throw new Error("no #root");

void store.refreshConfig();

createRoot(root).render(
  <StrictMode>
    <RootErrorBoundary>
      <GateApp />
    </RootErrorBoundary>
  </StrictMode>,
);
