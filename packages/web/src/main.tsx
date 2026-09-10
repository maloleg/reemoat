import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./index.css";
import { installWakeDetection } from "./resume";
import { store } from "./store";
import { inTelegram, telegramReady, watchTelegramInsets } from "./telegram";
import { RootErrorBoundary } from "./ui/ErrorBoundary";

const root = document.getElementById("root");
if (root === null) throw new Error("no #root");

/*
 * Wake detection and bootstrap are installed once, outside React.
 *
 * Deliberately not in an effect: StrictMode mounts twice in development, and a
 * resume path that runs twice would mint two tokens per machine and open two
 * sockets per session — which is exactly the bug this design exists to avoid,
 * introduced by the tool meant to reveal it.
 */
installWakeDetection();
void store.bootstrap();

/*
 * And Telegram, if this is running inside it.
 *
 * Here for the reason above — once, outside React — and because it is the same
 * kind of statement: the page is up. Telegram keeps its own loading placeholder
 * over a mini app until it hears this. A no-op everywhere else; `inTelegram`
 * answers on the transport being injected, so an ordinary browser sets nothing
 * and reads nothing.
 *
 * The `<html>` marker is what `index.css` hangs the header inset off, and it is
 * an attribute rather than a class so nothing in Tailwind's scan has to know
 * about it.
 *
 * ⚠ **The marker is keyed on the transport and the inset used to be keyed on the
 * marker, which is the asymmetry that produced a band of empty screen.** Being in
 * Telegram says nothing about how Telegram is presenting us: it draws its header
 * as a bar *above* the webview in the ordinary case and floats a pill *over* the
 * page in fullscreen, and a literal spent on the strength of `[data-telegram]`
 * alone pays for the second in both. `watchTelegramInsets` asks for the number
 * instead — see its docblock for why it must come after `telegramReady`, which is
 * what latches the version its own gate reads.
 */
if (inTelegram()) {
  document.documentElement.dataset["telegram"] = "";
  telegramReady();
  watchTelegramInsets();
}

/*
 * The boundary is **inside** `StrictMode` and wraps everything React renders.
 *
 * Nothing above it can be caught — an error thrown while this module is
 * evaluating, or by `createRoot` itself, is still a blank page — so it is as high
 * as a boundary can usefully go. See `RootErrorBoundary` for why there is one
 * rather than one per screen.
 */
createRoot(root).render(
  <StrictMode>
    <RootErrorBoundary>
      <App />
    </RootErrorBoundary>
  </StrictMode>,
);
