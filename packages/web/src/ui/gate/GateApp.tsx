import { Suspense, lazy, useSyncExternalStore, type ReactNode } from "react";
import { parseGateRoute } from "../../gate";
import { usePathname } from "../../router";
import { legalPublishable } from "../../legal";
import { store } from "../../store";
import { Spinner } from "../bits";
import { Gate } from "./Gate";
import { Handoff } from "./Handoff";

/**
 * The whole of what a browser is served.
 *
 * **Not `App.tsx` with the product removed — a different surface with a
 * different job.** `App` supervises a fleet and needs a credential, machines,
 * sockets and a wake path. This one does four things a person does *about their
 * account*, in a browser, before or instead of having the app: sign up, spend a
 * mailed link, read the documents, and find out where to get the app. It ends by
 * pointing at the app every time, because the app is the product.
 *
 * ⚠ **The routing here is deliberately not `router.ts`'s `Route`.** That union
 * covers sessions, machines, settings and plugins — every arm of which is a screen
 * this bundle does not contain — so parsing it here would put an arm somebody
 * could navigate to and find nothing behind. What a browser can reach is a short
 * closed list, and `parseGateRoute` is it.
 *
 * ⚠ **The *subscription* is that module's, and skipping it was a defect.** The
 * pathname was read during render with nothing telling this component when it
 * changed, so every control on this surface pushed a history entry and left the
 * same card on screen — `BackToSignIn`, Confirm's "Sign in", both "Go to your
 * machines", the incomplete-link remedy and the legal cross-links — and so did
 * browser Back. Only the register path appeared to work, because `adoptSession`
 * notifies the store first. `usePathname` is the subscription with none of the
 * vocabulary; `navigate` was already imported across this bundle, so the module
 * was in it either way.
 *
 * The server refuses every other path with the JSON envelope, so the fallback
 * below is only ever reached by a client-side navigation — and it sends somebody
 * somewhere useful rather than drawing an error about a URL they did not type.
 */

const LegalScreen = lazy(async () => ({ default: (await import("../legal/LegalScreen")).LegalScreen }));

export function GateApp(): ReactNode {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const route = parseGateRoute(usePathname());

  if (route.name === "legal") {
    /*
     * ⚠ **Waits on the configuration exactly as `App.tsx` does, and for the same
     * reason.** `state.config.legal` is whether this deployment *claims* the
     * documents; drawing before the answer lands would put one operator's
     * contract on a fork's screen for a frame. `legalPublishable()` is whether
     * they are finished — a required field left unfilled means there is nothing
     * honest to render.
     */
    if (state.config === null) return <Waiting />;
    if (state.config.legal && legalPublishable()) {
      return (
        <Suspense fallback={<Waiting />}>
          {/*
            * `up` is the handoff rather than a history entry, and `signedIn` is
            * flatly `false`. A document reached from here is reached by somebody
            * who has no app yet — `App.tsx` computes `up` from a route stack
            * this surface does not have, and there is no session on this origin
            * to be signed in to.
            */}
          <LegalScreen doc={route.doc} up="/app" signedIn={false} />
        </Suspense>
      );
    }
    // Not claimed here: the address names nothing, so it falls through to the
    // one page this surface always has.
    return <Handoff config={state.config} />;
  }

  if (route.name === "gate") return <Gate screen={route.screen} state={state} />;
  return <Handoff config={state.config} />;
}

function Waiting(): ReactNode {
  return (
    <div className="flex min-h-full flex-col items-center justify-center gap-3 p-6">
      <Spinner />
    </div>
  );
}
