import { Suspense, lazy, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { parseGateRoute } from "../../gate";
import type { InstanceConfig } from "../../instance";
import { usePathname } from "../../router";
import { legalPublishable, legalTitle, type LegalDoc } from "../../legal";
import { store } from "../../gateStore";
import { Button, Spinner } from "../bits";
import { Gate } from "./Gate";
import { GateCard, HANDOFF_LABEL, HANDOFF_PATH, ToHandoff } from "./GateCard";
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
 * same card on screen — the footers, Confirm's button, both "Go to your machines"
 * and the incomplete-link remedy — and so did browser Back. Only the register
 * path appeared to work, because `adoptSession` notifies the store first.
 * `usePathname` is the subscription with none of the vocabulary; `navigate` was
 * already imported across this bundle, so the module was in it either way.
 *
 * The server refuses every other path with the JSON envelope, so the fallback
 * below is only ever reached by a client-side navigation — and it sends somebody
 * somewhere useful rather than drawing an error about a URL they did not type.
 */

const LegalScreen = lazy(async () => ({ default: (await import("../legal/LegalScreen")).LegalScreen }));

export function GateApp(): ReactNode {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const route = parseGateRoute(usePathname());

  if (route.name === "legal") return <LegalRoute doc={route.doc} config={state.config} />;
  if (route.name === "gate") return <Gate screen={route.screen} state={state} />;
  return <Handoff config={state.config} />;
}

/**
 * One of the three documents, and the three things that can be true before there
 * is one to draw.
 *
 * ⚠ **A component of its own because the wait needs state, and the wait with no
 * state was a bare, textless, footerless spinner for ever.** `state.config.legal`
 * is whether this deployment *claims* the documents, so this screen genuinely has
 * to wait for it — drawing before the answer lands would put one operator's
 * contract on a fork's screen for a frame. What it cannot do is wait unbounded:
 * `gate-main.tsx` fires `store.refreshConfig()` exactly once, that method's catch
 * is bare and load-bearing (a control plane rolled back past `/v1/instance`
 * answers 404, and that is not an outage to draw), and this bundle has no
 * bootstrap, no poll and no wake detection to ask again with — `gateStore.ts` is
 * the whole of its state. So one failed read left `config` `null` with nothing in
 * the world about to ask again, and this branch drew a spinner on an otherwise
 * empty page until the tab was closed.
 *
 * **That is verbatim the defect `signupScreen` was introduced to fix one screen
 * over**, whose docblock records it in those words, and the remedy is the same
 * pair: a `settled` flag latched when an attempt *finishes* — whatever it
 * produced — and a retry that re-arms the probe. A read that landed and left the
 * config `null` is a real answer, and this is where it stops being a spinner.
 *
 * `legalPublishable()` is the other half of "is there anything to draw": a
 * required `OPERATOR` field still holding `TODO` renders verbatim into prose that
 * names a data processor, so an unfinished document must not be served. Both of
 * its failures land on the handoff below, with a lead that says which.
 */
function LegalRoute({ doc, config }: { doc: LegalDoc; config: InstanceConfig | null }): ReactNode {
  const [settled, setSettled] = useState(false);
  /** Bumped by Try again, and the only reason the probe below can run twice. */
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    // Nothing to ask once it is known. On the ordinary visit this fires anyway,
    // because the first render happens before `gate-main`'s own read lands — one
    // extra `GET /v1/instance` on a page whose whole content is a document, which
    // is the price `Register` already pays for the same guarantee.
    if (config !== null) return;
    let live = true;
    // `refreshConfig` swallows the failure, by design, so this cannot be a
    // `catch`: what is observed is that the attempt is over.
    void store.refreshConfig().then(() => {
      if (live) setSettled(true);
    });
    return () => {
      live = false;
    };
  }, [config, attempt]);

  if (config === null) {
    /*
     * **Asked, and it did not answer.**
     *
     * Deliberately not "this instance publishes no documents": nothing here knows
     * that, and saying it would turn a control plane that was briefly unreachable
     * into a permanent refusal in the reader's head — about a contract they may
     * have been linked to from a sign-up form in another tab. What is offered is
     * the act that can change the answer, plus the way off the card that every
     * other card on this surface has. The retry re-arms the probe rather than
     * reloading the page, because a reload on a phone is a gesture nobody finds
     * and this is one request.
     */
    if (settled) {
      return (
        <GateCard
          title="Cannot show this document"
          lead="This control plane did not say which documents it publishes, so this page cannot tell whether this is one of them. It may be down, or it may be older than this screen."
          footer={<ToHandoff />}
        >
          <Button
            tone="primary"
            className="mt-4 w-full"
            onClick={() => {
              setSettled(false);
              setAttempt((previous) => previous + 1);
            }}
          >
            Try again
          </Button>
        </GateCard>
      );
    }
    return <Waiting doc={doc} />;
  }

  if (config.legal && legalPublishable()) {
    return (
      <Suspense fallback={<Waiting doc={doc} />}>
        {/*
          * `up` is the handoff rather than a history entry, and the **label is
          * handed over with it**. A document reached from here is reached by
          * somebody who has no app yet: `App.tsx` computes `up` from a route
          * stack this surface does not have, and `legalUpLabel` picks between
          * "Back to your machines" and "Back to sign in" — the app's two roots,
          * neither of which exists on this origin. The boolean stopped being
          * enough the moment there were two bundles with two roots, so the one
          * caller that is outside the app says what its control is called rather
          * than being described to a function that cannot know. `signedIn` is
          * still `false` and still honest: there is no fleet here to be signed in
          * to. It simply no longer decides the words.
          */}
        <LegalScreen doc={doc} up={HANDOFF_PATH} signedIn={false} upLabel={HANDOFF_LABEL} />
      </Suspense>
    );
  }

  /*
   * **Not published here, and the card says so rather than looking like a
   * mis-click.**
   *
   * This fell straight through to the bare handoff, so somebody handed a
   * privacy-policy link got an unrelated download page with nothing connecting
   * the two. It is still the handoff — that is the one page this surface always
   * has, and "not found" would be a dead end — but it arrives under a heading
   * about the address that was opened.
   *
   * The two reasons are told apart in the lead because they have different
   * audiences: `legal === false` is an instance that never claimed the documents
   * and is nobody's error, while a claim with `legalPublishable()` false is a
   * fork that turned `REEMOAT_CP_LEGAL_DOCUMENTS` on without replacing `OPERATOR`
   * — a misconfiguration only its operator can fix, and one `/register` already
   * refuses to submit into.
   */
  return (
    <Handoff
      config={config}
      title="No document at this address"
      lead={
        config.legal
          ? "This server claims its own legal documents but has not finished writing them, so there is nothing to show yet."
          : "This server publishes no legal documents, so this address names nothing on it."
      }
    />
  );
}

/**
 * The wait, and it is a card rather than a centred spinner.
 *
 * Under the document's own title, because that much is known from the address
 * alone and a heading is what tells somebody the page they asked for is the page
 * that is loading. With a footer, under the rule `webcheck` states over the gate
 * screens: **a card somebody can only wait on is the one card that must always
 * say how to leave it**, whether the wait is a second or permanent.
 *
 * Shared with the `Suspense` fallback so a slow chunk and a slow config look like
 * one wait rather than two different pages.
 */
function Waiting({ doc }: { doc: LegalDoc }): ReactNode {
  return (
    <GateCard title={legalTitle(doc)} footer={<ToHandoff />}>
      <div className="mt-6 flex justify-center">
        <Spinner />
      </div>
    </GateCard>
  );
}
