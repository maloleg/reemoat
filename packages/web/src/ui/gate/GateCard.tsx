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
 * The handoff's own address — the one place every control on this surface goes.
 *
 * ⚠ **A hand mirror of `APP_HANDOFF_PATH` in `packages/control-plane/src/app.ts`,
 * and it has to be one.** That constant is the third member of the served list —
 * `[...GATE_SCREEN_PATHS, ...LEGAL_DOC_PATHS, APP_HANDOFF_PATH]` — and everything
 * else on this origin answers the JSON envelope. Copied rather than imported for
 * the reason `wire.ts` states pointing the other way: two packages, two tsconfigs,
 * and a runtime image that carries no web `src` at all. `relaycheck` reads both
 * sides off disk, asserts the two lists against this bundle's own tables, and
 * asserts that the handoff's address is neither a screen nor a document.
 *
 * ⚠ **And this literal is compared against that one**, by `relaycheck` under *the
 * gate's addresses, on both sides*: it reads `APP_HANDOFF_PATH` out of `app.ts`
 * and `HANDOFF_PATH` out of this file and asserts *"and it is the server's address
 * with the slash the server adds"*. Against `` `/${handoff}` `` rather than the two
 * captures, deliberately — comparing them directly passes loudest when it has
 * measured nothing, since renaming both constants leaves `"" === ""`, while a
 * double miss against the built string is `""` against `"/"` and fails. It reads
 * this file with comments **stripped** and anchors on `const HANDOFF_PATH = "…"`,
 * which is why this docblock may name `APP_HANDOFF_PATH` and quote `/app` without
 * answering for the code below it.
 *
 * ⚠ **This paragraph said nothing compared them, and that expired rather than
 * being wrong when it was written.** The two screen lists were checked because
 * they were already tables on both sides; the handoff was checked for *existing*
 * and for not colliding, because until the constant below was introduced the
 * client had no name for it at all — `parseGateRoute` reaches the handoff as its
 * fallback for every unknown path, so `/app` worked without ever being written
 * down here. That is the history of the mirror, not the state of it.
 *
 * ⚠ **Every way off a gate screen used to be `navigate("/", true)`, and `/` is the
 * one address here the control plane deliberately answers `404` at.** `relaycheck`
 * asserts that refusal: `/` belongs to the **app**, and the app is not in this
 * image to be served — a browser holds no device key, so it could load the product
 * and reach no machine at all. The gate bundle routes `/` to the handoff
 * client-side, `parseGateRoute` having no other answer for an unknown path, so on
 * screen it looked right; what `replaceState` had actually written into the address
 * bar only showed on a reload, a bookmark, a shared link or a tab restored after
 * signing up, confirming, resetting or verifying, and what it showed was raw
 * `{"error":{"code":"not_found"}}`. Navigating to the handoff's own address is the
 * fix. Adding `/` to the served list is the other one and is refused, because it
 * hands the app's address to the gate.
 *
 * ⚠ **Here rather than in `Handoff.tsx`, where it would read more naturally.**
 * This module is the one thing `ui/gate/` shares with the **app** bundle —
 * `ForcedPasswordChange` renders a `GateCard`, and `webcheck` names that as the
 * single allowed edge while asserting the app reaches no other file in this
 * directory. An import from here into `Handoff.tsx` would drag the handoff screen
 * into the app's closure and fail that check. A string costs the app nothing; a
 * screen would.
 */
export const HANDOFF_PATH = "/app";

/**
 * What every control that goes there is called.
 *
 * Named after where it goes rather than "Back", which is `Header`'s standing rule
 * and `legalUpLabel`'s one bundle over. One destination, one label: `GateApp`
 * hands this same string to `LegalScreen` rather than letting it pick from the
 * app's two answers, neither of which names anything that exists here.
 */
export const HANDOFF_LABEL = "Where to get the app";

/**
 * The way off a gate screen, and the one place each card keeps for it.
 *
 * ⚠ **This was `BackToSignIn`, and the rename is the fix rather than a tidy-up.**
 * It named a screen this bundle does not contain. The gate carries no sign-in form
 * at `/`: `Gate` renders `SignIn` on exactly one branch — `/verify` with no session
 * — and `parseGateRoute` sends `/` to the handoff. So every footer here, the
 * confirmation's "Sign in" and three "Go to your machines" buttons made three
 * different promises and landed on one card headed *"Reemoat runs in its own
 * app"*. The label is the destination's now, and there is exactly one destination.
 *
 * **No `children` override, deliberately.** It had one and it was used once, to
 * say "Go to your machines" over `/verify`'s spinner — a second promise about a
 * screen that is not here either, justified by the fact that the reader is
 * certainly signed in. Being signed in on this origin buys a session and no
 * machines: the fleet is reachable from the app and from nowhere else. One
 * control, one label.
 *
 * **`replace`, always**, and it is the rule rather than a preference on this one
 * control: the entry being replaced is the one holding a token in its fragment,
 * so overwriting it is what stops Back returning to a spent link. Every
 * navigation out of a gate screen does this, and `webcheck` reads these files to
 * assert that none of them forgets.
 */
export function ToHandoff(): ReactNode {
  return (
    <button
      type="button"
      onClick={() => navigate(HANDOFF_PATH, true)}
      className="tap text-xs text-muted hover:text-fg"
    >
      {HANDOFF_LABEL}
    </button>
  );
}
