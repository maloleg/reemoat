import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { store } from "./store";
import { GateApp } from "./ui/gate/GateApp";
import { RootErrorBoundary } from "./ui/ErrorBoundary";

/**
 * The gate's entry point — the one the control plane serves.
 *
 * ⚠ **`store.bootstrap()` is deliberately not called here, and that is the whole
 * difference from `main.tsx`.** Bootstrap reads the credential out of the host,
 * lists machines, opens connections and starts a four-second poll: every one of
 * those is about supervising a fleet, and none of them has anything to do with
 * signing up or spending a mailed link. Calling it would have this page mint
 * tokens and open sockets for a person who is on it precisely because they do not
 * have the app yet.
 *
 * What this surface genuinely needs is the configuration — it decides whether
 * sign-up is open, whether an address is required, whether the legal documents
 * are published, and where the app can be downloaded — and it is the one call
 * `bootstrap` makes *before* the credential check, for that reason.
 *
 * Fetched through `refreshConfig`, which is `loadConfig`'s public door.
 * `loadConfig` stays private: it is `bootstrap`'s first statement and its
 * placement there is asserted behaviourally, so a second caller reaching past
 * the public method would be a second thing to keep true of it.
 *
 * **No wake detection and no Telegram**, for the same reason: both are about an
 * app that stays open and comes back. This is a page somebody visits once.
 */
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
