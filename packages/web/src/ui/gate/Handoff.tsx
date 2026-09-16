import type { ReactNode } from "react";
import type { InstanceConfig } from "../../instance";
import { Button, LINK } from "../bits";
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
 */
export function Handoff({
  config,
  title = "Reemoat runs in its own app",
  lead,
}: {
  config: InstanceConfig | null;
  title?: string;
  lead?: string;
}): ReactNode {
  /*
   * `config === null` — the instance has not answered yet, or could not be read —
   * draws the same thing as "no download configured", deliberately. Both mean
   * *this page cannot offer you a build*, the remedy is identical, and a third
   * state would be a spinner on a card whose whole content is one sentence.
   */
  const download = config?.appDownload ?? null;

  return (
    <GateCard title={title} lead={lead ?? "Everything else happens there: your machines, your agents, your sessions."}>
      {download === null ? (
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
            */}
          <a href={download} rel="noreferrer">
            <Button tone="primary" className="mt-4 w-full">
              Download Reemoat
            </Button>
          </a>
          <p className="mt-2 text-xs text-muted">Then sign in there with the account you just used.</p>
        </>
      )}
    </GateCard>
  );
}
