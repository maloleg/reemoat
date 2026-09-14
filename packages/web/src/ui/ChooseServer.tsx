import { useState, type FormEvent, type ReactNode } from "react";
import { parseInstanceConfig } from "../instance";
import { nativeBoot, probeServer, setNativeServer } from "../native";
import { Button, FIELD, SETTINGS_HEADING } from "./bits";

/**
 * Which Reemoat this application talks to.
 *
 * **Reached by state, not by a URL**, which is why it is filed beside `SignIn.tsx`
 * rather than in `ui/gate/`. `ForcedPasswordChange` is the precedent and the
 * argument is the same one: a `GateScreen` member is a *route*, `parseGateScreen`
 * is shared with the router, and the web build would then parse and draw `/server`
 * — a screen that cannot do anything in a browser, where the server is the origin
 * this page was served by. As a phase it is unreachable there instead: `App.tsx`
 * branches on `state.host`, which is `null` in a browser and for ever.
 *
 * The other half of the payoff is that **no compile-enforced switch changes**.
 * `depthOf`, `sheetKind`, `sheetTitle`, `screenOf` and `upFrom` all switch over
 * `Route`; `isSheet`, `isOverlayPath` and `sheetUpLabel` are the three that take a
 * new arm in silence. A route would have been eight edits and a case table; a
 * phase is none.
 *
 * **Nothing here validates the address**, and that is deliberate. The host process
 * normalizes it — scheme filled in, host lowercased, a default port dropped, path
 * and query discarded — and answers either the one canonical spelling or a sentence
 * saying why it is not an address. One authority, because two normalizers is two
 * spellings of one origin, which is two credential keys, one of which a sign-out
 * would not reach.
 *
 * **And it probes before it adopts.** A typo that is a perfectly good URL would
 * otherwise strand somebody in an app with no server that answers and no way back
 * to this screen — the failure `GateCard` already refuses one screen over. So this
 * asks the candidate two public questions and only writes anything down if one of
 * them answered like a Reemoat.
 */

/** What a probe learned, in the only three shapes worth telling apart. */
type Found = { kind: "reemoat" } | { kind: "stranger" } | { kind: "unreachable"; why: string };

/**
 * Two questions, and the second one is why an older instance is still adoptable.
 *
 * `GET /v1/instance` is the useful one — it parses, so a body in a shape this
 * client cannot read is distinguishable from no body at all. But a control plane
 * rolled back past the release that added it answers **404**, and `cp.ts` records
 * that this is *not* an outage and must not be drawn as one. So a 404 falls through
 * to `GET /v1/jwks`, which every control plane that has ever existed serves
 * unauthenticated, and whose answer nothing else on the web serves by accident.
 *
 * Both are above the control plane's auth gate, so neither needs a credential —
 * which is the whole reason this screen can ask anything at all.
 */
async function probe(address: string): Promise<Found> {
  try {
    const instance = await probeServer(address, "/v1/instance");
    if (instance.ok) {
      return parseInstanceConfig(await instance.json().catch(() => null)) === null
        ? { kind: "stranger" }
        : { kind: "reemoat" };
    }
    const jwks = await probeServer(address, "/v1/jwks");
    if (!jwks.ok) return { kind: "stranger" };
    const keys = (await jwks.json().catch(() => null)) as { keys?: unknown } | null;
    return Array.isArray(keys?.keys) ? { kind: "reemoat" } : { kind: "stranger" };
  } catch (cause: unknown) {
    /*
     * A rejection here is the host saying the request was never answered — a
     * refused address, an unreachable host, or a normalization it would not accept.
     * Its message is already a sentence somebody can act on, which is why it is
     * shown rather than replaced.
     */
    return { kind: "unreachable", why: cause instanceof Error ? cause.message : "could not reach that address" };
  }
}

export function ChooseServer(): ReactNode {
  const [address, setAddress] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const durable = nativeBoot()?.durable !== false;

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const typed = address.trim();
    if (busy || typed.length === 0) return;
    setBusy(true);
    setError(null);
    void (async () => {
      const found = await probe(typed);
      if (found.kind === "unreachable") {
        setError(found.why);
        setBusy(false);
        return;
      }
      if (found.kind === "stranger") {
        setError("Something answered at that address, but it is not a Reemoat control plane.");
        setBusy(false);
        return;
      }
      try {
        await setNativeServer(typed);
      } catch (cause: unknown) {
        setError(cause instanceof Error ? cause.message : "could not save that address");
        setBusy(false);
        return;
      }
      /*
       * ⚠ **A reload rather than an in-memory unwind**, and `signOut` takes the same
       * path for the same reason: every machine connection, every minted token, every
       * route memo and every open socket in this process was derived from a credential
       * for a *different fleet*. Rebuilding that by hand is a teardown nobody can
       * prove complete; starting again is one that cannot be incomplete.
       *
       * `/` rather than `reload()`, because a path from the previous server names
       * nothing on this one.
       */
      window.location.assign("/");
    })();
  };

  // Chrome from `FIELD`, layout here — `SignIn`'s line, and the two screens are
  // read one after the other.
  const field = `mt-1 w-full ${FIELD}`;

  return (
    <div className="flex min-h-full items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <h1 className="text-xl font-semibold">Reemoat</h1>
        <p className="mt-1 text-sm text-muted">Which server should this connect to?</p>

        <form onSubmit={submit}>
          <label htmlFor="server-address" className={`mt-4 block ${SETTINGS_HEADING}`}>
            Server address
          </label>
          <input
            id="server-address"
            name="url"
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            /* `url` rather than `off`: a password manager offering the address you
               typed last time is the right behaviour on a screen somebody reaches
               once per machine. */
            autoComplete="url"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="go"
            inputMode="url"
            placeholder="app.reemoat.com"
            className={field}
          />

          {error !== null && <p className="mt-2 text-sm text-danger">{error}</p>}

          <Button type="submit" tone="primary" disabled={busy || address.trim().length === 0} className="mt-4 w-full">
            {busy ? "Checking…" : "Continue"}
          </Button>
        </form>

        {/*
          What a server *is*, because this is the one screen where somebody may not
          know — and the honest answer names both possibilities rather than only the
          hosted one. `deploy/install.sh control-plane` is the whole of running your
          own; the author runs one for people who would rather not.
        */}
        <div className="mt-8 space-y-2 text-sm text-muted">
          <p>
            A control plane holds your account and the machines you have added. Run one yourself, or use one somebody
            runs for you.
          </p>
          {/*
            ⚠ **The same sentence `cp.ts` already has for a browser with storage
            disabled, because it is the same state.** There a private window has no
            durable storage; here a machine has no unlocked credential store — most
            often a Linux box with no keyring running. One state, one wording, from one
            decision: two spellings of one state is a defect this repository has
            shipped before and a driver now pins.
          */}
          {!durable && (
            <p className="text-fg">
              This computer has no credential store Reemoat can use, so it will ask you to sign in again after it
              restarts.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
