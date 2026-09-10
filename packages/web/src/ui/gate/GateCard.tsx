import type { ReactNode } from "react";
import { navigate } from "../../router";

/**
 * ⚠ **There was a `SourceNotice` here and it has been taken off every screen.**
 *
 * It drew `Source · <version> · AGPL-3.0` under all six pre-auth forms, from
 * `GET /v1/instance`'s `source` field, as the AGPL §13 offer — argued at length
 * as belonging on the *signed-out* screens specifically, since §13 is about
 * anybody who interacts with the program over a network and the people who most
 * need the offer are the ones a modified instance never lets in.
 *
 * It is gone by decision rather than by accident, which is the whole reason this
 * comment is here instead of nothing: somebody finding `source` on the wire with
 * no reader will want to "restore" it, and this is the note saying not to. The
 * field itself **stays** and must — `pincheck` asserts `SOURCE_URL` against this
 * repository's own `package.json`, `relaycheck` asserts the served value,
 * `webcheck` lifts the literal straight out of `app.ts`, and
 * `deploy/ci-release.sh` derives the image's `org.opencontainers.image.source`
 * label from it. What changed is that nothing draws it.
 *
 * See `docs/DECISIONS.md` Q3.440 for where the offer is made now.
 *
 * ⚠ **The consent box under `/register` is not that notice coming back.** One
 * sentence above is narrower than it reads: *"nothing draws it"* is true of the
 * §13 offer and was never a rule about legal text in general. §13 is an
 * obligation the **licence** places on whoever runs this, toward anybody who
 * interacts with it over a network, and Q3.440 decided it is discharged in
 * `LICENSE`, in `README.md` and in the image's OCI label rather than on a screen
 * — all of which is unchanged: no screen draws the source URL, the version or
 * the licence name, and `source` on the wire still has no reader.
 *
 * Consent runs the other way. It is a term of an act somebody is about to
 * perform, at the moment they perform it, and **nothing in a tarball can carry
 * it**. So it sits inside `Register`'s own `<form>`, before the button that
 * performs the act — and deliberately **not** in this card's `footer`, which is
 * the one place each screen keeps for the way back, under a rule, and is
 * therefore chrome about the page rather than a term of the thing being done.
 * The documents are `packages/web/src/legal/`. Q3.598, Q3.599.
 */

/**
 * The box every pre-auth screen sits in, and `SignIn`'s box too.
 *
 * Six screens, one layout. `SignIn` adopts it in the same change that adds the
 * other five, because six independent copies of `flex min-h-full items-center
 * justify-center` around a `max-w-sm` is exactly the drift `FIELD` exists to
 * close, one level up.
 *
 * Sized against `html, body, #root { height: 100% }` with `min-h-full` rather
 * than `AppShell`'s `h-dvh`: these render **outside** the shell, which is what
 * the loading screen already does and for the same reason — there is no rail, no
 * header and nothing to lay out beside.
 */
export function GateCard({
  title,
  lead,
  children,
  footer,
}: {
  title: string;
  lead?: string;
  children: ReactNode;
  /** Usually the way back. Kept out of `children` so every screen has one place for it. */
  footer?: ReactNode;
}): ReactNode {
  return (
    <div className="flex min-h-full items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <h1 className="text-xl font-semibold">{title}</h1>
        {lead !== undefined && <p className="mt-1 text-sm text-muted">{lead}</p>}
        {children}
        {footer !== undefined && <div className="mt-5 border-t border-edge pt-4">{footer}</div>}
      </div>
    </div>
  );
}

/**
 * Back to the sign-in screen.
 *
 * **`replace`, always**, and it is the rule rather than a preference on this one
 * control: the entry being replaced is the one holding a token in its fragment,
 * so overwriting it is what stops Back returning to a spent link. Every
 * navigation out of a gate screen does this, and `webcheck` reads these files to
 * assert that none of them forgets.
 */
export function BackToSignIn({ children = "Back to sign in" }: { children?: ReactNode }): ReactNode {
  return (
    <button type="button" onClick={() => navigate("/", true)} className="tap text-xs text-muted hover:text-fg">
      {children}
    </button>
  );
}
