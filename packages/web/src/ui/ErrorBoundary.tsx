import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "./bits";

/**
 * The one thing standing between a render that throws and a blank page.
 *
 * React unmounts the **whole tree** when a render, a lifecycle or an effect
 * throws and nothing above it catches — so before this existed, one bad row took
 * the app to an empty `#root`: no message, no control, and on a phone no console
 * to find out why. `Composer.tsx` names that consequence in its own docblock,
 * where a hook order that changes mid-session is the way in; roughly seven
 * hundred lines of this package render **agent output**, which is untrusted text
 * quoting an untrusted repository, and that is the other one.
 *
 * It is at the root and there is only one, deliberately. A boundary per screen
 * would keep more of the app alive after a throw, and it would also be several
 * places to decide what a broken screen looks like — while what somebody on a
 * phone needs from any of them is the same two things: what happened, and a way
 * back. Reloading is a real remedy here because no state worth keeping lives in
 * this tab: the daemon is the source of truth, sessions are re-listed on wake,
 * and `resume()` re-opens every socket.
 *
 * **A class, and it has to be.** `componentDidCatch` has no hook, which is why
 * this is the only class component in the package.
 */
export class RootErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: unknown): { error: Error } {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    /*
     * **The one `console` call in this package, and it is here so the error is
     * not swallowed.** A boundary that catches and says nothing is worse than no
     * boundary: the blank page at least announced itself. The screen below is
     * what a phone gets; this is what a desktop devtools gets, and it carries the
     * component stack, which the message alone does not.
     */
    console.error("render failed", error, info.componentStack);
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (error === null) return this.props.children;
    return (
      <div className="flex min-h-full items-center justify-center bg-surface p-6 text-fg">
        <div className="w-full max-w-sm">
          <h1 className="text-xl font-semibold">Something in this screen broke</h1>
          {/* The message verbatim, because the alternative is asking somebody to
              report "it went blank". It is `wrap-anywhere` for the same reason
              every other agent-shaped string here is: it may be one long token. */}
          <p className="mt-1 text-sm text-muted wrap-anywhere">{error.message}</p>
          <p className="mt-3 text-sm text-muted">
            Nothing on the machine is affected — agents keep running, and reloading re-attaches to them.
          </p>
          {/*
           * ⚠ **Two controls, because Reload alone is a loop on the screen this is
           * most likely to catch.** The docblock above says what somebody on a
           * phone needs is "what happened, and a way back", and for four releases
           * there was no way back: a render that throws *deterministically* — agent
           * output quoting an untrusted repository is the named way in — re-throws
           * the moment the same route re-mounts, so Reload returns to the same
           * broken screen for ever.
           *
           * `window.location.assign` rather than `navigate`, and that is the whole
           * of why this is not one line shorter: `state.error` is never cleared, so
           * a client-side navigation would leave this panel drawn over wherever it
           * went. Only a new document clears the boundary.
           *
           * `/` is a fixed destination taken from nothing, which is this app's
           * standing rule for a leading control and the reason `history.back()` is
           * banned everywhere else — here it would be the worse version of the same
           * defect, since the entry behind this one is the route that just threw.
           */}
          <div className="mt-4 flex flex-wrap gap-2">
            <Button tone="primary" onClick={() => window.location.reload()}>
              Reload
            </Button>
            <Button tone="plain" onClick={() => window.location.assign("/")}>
              Go to sessions
            </Button>
          </div>
        </div>
      </div>
    );
  }
}
