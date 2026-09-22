import { useEffect, useState, type ReactNode } from "react";
import type { InstanceConfig } from "../../instance";
import { store } from "../../gateStore";
import { Button, LINK, Spinner } from "../bits";
import { GateCard } from "./GateCard";

/**
 * Where somebody goes after doing the one thing a browser is for here.
 *
 * **The handoff is the point of this whole surface.** Signing up, confirming a
 * link and resetting a password are things a person does in a browser because
 * that is where a mailed link opens; *using* Reemoat is the app. So every gate
 * flow ends here rather than at a screen that looks like a product with nothing
 * in it — which is what a browser reaching the app's own sign-in would be, since
 * the control plane serves no app to sign in to.
 *
 * ⚠ **It never claims a download exists.** `appDownload` is `null` on every
 * instance that has not been configured with one, which today is every instance:
 * this repository publishes no signed build — `signingIdentity: null`, no
 * updater artifacts, no `dmg`, and `ci-release.sh` uploads nothing — so a
 * compiled-in URL or a confident button would be a lie on a fork and a lie here.
 * Absent, the card says so and points at building from source, which is the
 * true answer.
 *
 * ⚠ **And it used to claim the opposite one, which is the same defect the other
 * way round.** *No answer* and *no build* drew the same sentence, on purpose and
 * wrongly: `config === null` also covers a read that has not landed and a read
 * that failed, `gate-main.tsx` fires `store.refreshConfig()` exactly once with no
 * poll and no wake path, and `loadConfig`'s catch is bare and load-bearing. So on
 * an instance that *had* set `REEMOAT_CP_APP_DOWNLOAD_URL`, one missed `GET
 * /v1/instance` told every visitor for the rest of that tab's life that the
 * server publishes no build, with nothing on screen able to ask again — and on
 * the ordinary visit the primary call to action changed under the reader's eyes
 * mid-paint, because the first render always happens before that read lands.
 *
 * The shape is `LegalRoute`'s in `GateApp.tsx`, deliberately rather than a second
 * invention: a `settled` flag latched when an attempt *finishes* — whatever it
 * produced — and a Try again that re-arms the probe. Its docblock traces the pair
 * back to `signupScreen(config, settled)`, which was introduced for this exact
 * defect one screen over. Both of those got the pair while this card was left on
 * the old shape — and three flows were routed to end here in the same breath.
 *
 * It pays `LegalRoute`'s cost too, and for the same reason: one extra `GET
 * /v1/instance` on the ordinary visit, because `gate-main` has already fired one,
 * `loadConfig` does not dedupe, and a component cannot see a request in flight.
 * One request against a permanent false negative is the trade that was already
 * made twice on this surface.
 *
 * ⚠ **`title` and `lead` are what every flow ends with, and for a while nobody
 * passed either.** Confirming an account, spending a reset link and verifying an
 * address each ended on a card of their own whose only control went *here*,
 * labelled three different ways — so three flows made three promises and arrived
 * at one generic page. They end at this card now, each carrying its own heading,
 * which is what the two props were put here for. The defaults are the bare visit
 * to `/app`, where nothing has just happened.
 *
 * `children` is the one sentence a flow sometimes has left to say before the card
 * gets to the download — the reset's surviving API keys are the only case today.
 * Above the download block rather than below it, because it is about the thing
 * that just happened and the block is about what to do next.
 */
export function Handoff({
  config,
  title = "Reemoat runs in its own app",
  lead,
  children,
}: {
  config: InstanceConfig | null;
  title?: string;
  lead?: string;
  children?: ReactNode;
}): ReactNode {
  const [settled, setSettled] = useState(false);
  /** Bumped by Try again, and the only reason the probe below can run twice. */
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    // Nothing to ask once it is known. On the ordinary visit this fires anyway,
    // because the first render happens before `gate-main`'s own read lands —
    // `LegalRoute` pays exactly this and the docblock above says what it buys.
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

  /*
   * ⚠ **`config?.appDownload ?? null`, which is what this was, collapsed three
   * states into two.** A config that answered `appDownload: null` is the server
   * saying it publishes no build; a `null` config is the server not having said
   * anything, and the sentence below is only ever true of the first. Read off a
   * config that is known to have answered, so the collapse cannot come back by
   * somebody shortening the expression.
   */
  const download = config === null ? null : config.appDownload;

  return (
    <GateCard title={title} lead={lead ?? "Everything else happens there: your machines, your agents, your sessions."}>
      {children}
      {config === null ? (
        settled ? (
          /*
           * **Asked, and it did not answer** — `LegalRoute`'s arm, in this card's
           * words. Deliberately not "there is no build": nothing here knows that,
           * and a control plane that was briefly unreachable would become a
           * permanent refusal in the reader's head, on the one page whose whole
           * job is to hand somebody the app. What is offered is the act that can
           * change the answer, and it re-arms the probe rather than reloading the
           * page — a reload on a phone is a gesture nobody finds, and this is one
           * request.
           */
          <>
            <p className="mt-4 text-sm text-muted">
              This server could not be asked whether it publishes a build. It may be down, or it may be older than this
              screen.
            </p>
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
          </>
        ) : (
          // The read is in flight. A spinner under the heading rather than a
          // sentence, because the heading is what every flow arrives here for
          // and the block below it is the only part still unknown.
          <div className="mt-6 flex justify-center">
            <Spinner />
          </div>
        )
      ) : download === null ? (
        <p className="mt-4 text-sm text-muted">
          This server does not publish a build. You can build the app from source — see{" "}
          <a className={LINK} href="https://github.com/rends-east/reemoat/blob/main/docs/NATIVE.md">
            docs/NATIVE.md
          </a>{" "}
          — or ask whoever runs this server where to get it.
        </p>
      ) : (
        <>
          {/*
            * A plain anchor rather than a router navigation: this leaves the
            * origin. `rel="noreferrer"` because the address is one the operator
            * configured and this page has no business telling it where the
            * person came from — the same posture `openableHref` takes for agent
            * output, applied to a link an admin chose rather than an agent.
            *
            * ⚠ **The anchor *is* the button, and it used to contain one.** This
            * was a `<Button>` nested inside this `<a>` — `Button` renders a real
            * `<button type="button">`, so that was interactive content inside
            * interactive content: two tab stops for one control, a screen reader
            * announcing a link that contains a button, and Enter and Space
            * behaving differently here from every other link in this client. It
            * was the only site in the app that did it; the `docs/NATIVE.md` link
            * four lines above is the ordinary shape.
            *
            * ⚠ **Styled rather than swapped for a `<button>` that opens the URL**,
            * because an anchor is what carries middle-click, ⌘-click, *Copy link
            * address* and — in the shell — `native.ts`'s capture-phase interceptor,
            * which reads `href` off an anchor and hands it to `openableHref`. A
            * scripted `window.open` has none of those.
            *
            * The class string is `BUTTON_TONE.primary` and `BUTTON_SIZE.md`
            * written out, which is the price of not being a `<button>`: `Button`
            * is not parameterised over its element and adding an `as` prop to a
            * primitive with 46 call sites to serve one link is the larger change.
            * Written whole rather than composed, because a padding or a height
            * appended to a Tailwind class string loses to whichever utility the
            * sheet emits later — the trap `BUTTON_SIZE`'s own docblock measures.
            */}
          <a
            href={download}
            rel="noreferrer"
            className="tap press mt-4 inline-flex min-h-11 w-full items-center justify-center gap-1.5 rounded-md bg-fg px-3 text-sm font-medium text-ink hover:bg-fg/85"
          >
            Download Reemoat
          </a>
          <p className="mt-2 text-xs text-muted">Then sign in there with the account you just used.</p>
        </>
      )}
    </GateCard>
  );
}
