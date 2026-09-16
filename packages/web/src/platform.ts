/**
 * Which operating system this client is running on, and the one place a sentence
 * is allowed to name it.
 *
 * ⚠ **There are two platform vocabularies in this app and they agree on exactly
 * one spelling, which is what makes a mixed-up call look right in review.**
 *
 * This one is the **client's**, out of `NativeBoot.platform`, which is Rust's
 * `std::env::consts::OS`: `macos`, `windows`, `linux`. The other is a **daemon's**,
 * `SystemInfo.os` over the wire, which is Node's `process.platform`: `darwin`,
 * `win32`, `linux` — read by `osName` in `ui/agentCard.ts`. `linux` is the shared
 * word. Neither function may be called with the other's value, and `webcheck`
 * asserts they never cross.
 *
 * Its own module rather than a helper inside `store.ts` for the reason `gate.ts`
 * and `nav.ts` are their own modules: a driver has to import it with no DOM and
 * no store, and the census that keeps a sentence from naming an OS anywhere else
 * needs one file to point at.
 */

/**
 * The platforms this client says anything different about, plus everything else.
 *
 * ⚠ **`other` is a real member rather than a gap.** `std::env::consts::OS` also
 * answers `freebsd`, `ios` and `android`, and it crosses the bridge as a plain
 * string — so a union of three would be a lie the compiler could not catch. An
 * unrecognised value falls here and gets the sentence that is true everywhere,
 * which is `wire.ts`'s standing rule: an unknown value fails toward *keep
 * working* rather than toward a blank screen.
 */
export type HostPlatform = "macos" | "windows" | "linux" | "other";

/**
 * What the host said about itself, narrowed. Total over `string` by construction.
 *
 * `null` and `undefined` answer `"other"` for the same reason an unrecognised
 * string does: a browser has no host to ask, and the sentence that is true
 * everywhere is the honest one to draw for somebody nothing told us about.
 */
export function hostPlatform(raw: string | null | undefined): HostPlatform {
  switch (raw) {
    case "macos":
      return "macos";
    case "windows":
      return "windows";
    case "linux":
      return "linux";
    default:
      return "other";
  }
}

/**
 * Why a daemon this app started could not reach a server on this network, and
 * what to do about it — per platform, because only one of them has a remedy
 * anybody has measured.
 *
 * ⚠ **The classifier that produces this state is platform-neutral and the
 * sentence was not.** `localNetworkBlocked` in `src/enroll.ts` keys on an errno —
 * `EHOSTUNREACH` or `ENETUNREACH` to an RFC1918 or link-local address — so the
 * daemon exits `EXIT_LOCAL_NETWORK_BLOCKED` on any Unix, while the string this
 * replaces said *"macOS is not letting Reemoat reach servers on this network …
 * Allow it under System Settings → Privacy & Security → Local Network"*. On a
 * Linux box behind a firewall that is a remedy that names a screen which does not
 * exist.
 *
 * **Only the macOS arm names an operating system, and that is the property
 * `webcheck` asserts** rather than the prose. Local Network Privacy is a
 * measurement — 2026-09-15 on macOS 15, the daemon being a child of this app and
 * therefore this app being the responsible process, `EHOSTUNREACH` on an address
 * that answers `ping` from a terminal a second later. Nothing equivalent has been
 * measured on Windows or Linux, so the other arms state the *fact* and point at
 * the evidence rather than guessing at a fix. `deploy/bootstrap.sh`'s refusal for
 * an unsupported init system is the model: name what is missing, do not invent a
 * remedy.
 *
 * `LOGS_POINTER` is appended by the caller, so no arm here names that screen.
 */
export function localNetworkDetail(platform: HostPlatform): string {
  switch (platform) {
    case "macos":
      return (
        "macOS is not letting Reemoat reach servers on this network, so the daemon could not sign in. " +
        "Allow it under System Settings → Privacy & Security → Local Network, then reopen Reemoat."
      );
    case "windows":
    case "linux":
    case "other":
      return (
        "This computer refused the connection to the server's network, so the daemon could not sign in. " +
        "Nothing is down and waiting will not help."
      );
    default: {
      /*
       * ⚠ **Not decoration.** This function answers `string`, `undefined`
       * inhabits it, and a `switch` falling off the end returns exactly that — so
       * a fifth member added to `HostPlatform` would compile clean and draw a
       * blank sentence. `AgentGlyph` shipped that shape for four releases.
       */
      const exhaustive: never = platform;
      return exhaustive;
    }
  }
}
