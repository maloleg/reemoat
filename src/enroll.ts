import { createHash } from "node:crypto";
import { jwkToPublicKey } from "./token.js";
import { describeError } from "./http.js";

/**
 * The one and only time this daemon talks to a control plane.
 *
 * An enrollment code is exchanged, exactly once, for a machine id and the
 * public keys that verify tokens addressed to it. All of that is then written
 * to the local database and this module is never called again — not to refresh
 * a key, not to check a revocation list, not to renew anything. That is what
 * makes a control-plane outage invisible to a running daemon, and it is a
 * property worth defending: any future "just poll for X" turns every daemon
 * into something that stops working when the control plane does.
 *
 * The consequence, stated where it will be read: rotating the control plane's
 * signing key requires re-enrolling every daemon. The key set is plural so old
 * and new can be trusted at once while that happens.
 *
 * What travels *up* is the code and, since machines began holding a static of
 * their own, the public half of that key — see {@link EnrollOptions.machineKey}.
 * It rides this request rather than a second one for the reason there is only
 * ever one: redeeming a code is already the act that says *this machine is
 * starting again*, so it is also where the key the Authority pins is replaced.
 */

export type EnrollErrorCode =
  | "unreachable"
  /**
   * The operating system refused a connection to an address on this network.
   *
   * Separated from `unreachable` because the remedy is nothing like it: the
   * network is fine and the control plane is up — see {@link localNetworkBlocked}.
   */
  | "local_network"
  | "timeout"
  | "code_rejected"
  | "bad_response"
  | "no_usable_keys";

/**
 * Whether the operating system refused the connection rather than the network.
 *
 * ⚠ **Measured 2026-09-15 on macOS 15, and it is invisible from inside this
 * process.** A daemon started by Reemoat.app is a child of it, so the app is the
 * *responsible process* for Local Network Privacy — and until somebody grants
 * that, a connect to a private-subnet address fails with `EHOSTUNREACH` while the
 * very same address answers `ping` and `curl` from a terminal one second later.
 * The same daemon started from a shell inherits the terminal's permission and
 * works, which is why every earlier measurement of this missed it.
 *
 * It is `unreachable`'s twin and must not be filed under it: `unreachable` means
 * *wait, the network or the server is down*, and this means *nothing is down and
 * waiting will not help*. The two are told apart by the errno and the address
 * rather than by any message, because `fetch` says `fetch failed` to both.
 *
 * Only a private address counts. `EHOSTUNREACH` reaching a public one is an
 * ordinary routing failure, and offering somebody a privacy setting for it would
 * send them to a switch that changes nothing.
 */
function localNetworkBlocked(error: unknown): boolean {
  const cause = error instanceof Error ? (error as { cause?: unknown }).cause : undefined;
  if (!(cause instanceof Error)) return false;
  const code = (cause as { code?: unknown }).code;
  if (code !== "EHOSTUNREACH" && code !== "ENETUNREACH") return false;
  const address = (cause as { address?: unknown }).address;
  return typeof address === "string" && isPrivateAddress(address);
}

/** RFC1918, link-local, and their IPv6 equivalents. */
function isPrivateAddress(address: string): boolean {
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/.exec(address);
  if (v4 !== null) {
    const first = Number(v4[1]);
    const second = Number(v4[2]);
    return (
      first === 10 ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) ||
      (first === 169 && second === 254)
    );
  }
  const v6 = address.toLowerCase();
  // fc00::/7 (unique local) and fe80::/10 (link local).
  return /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6);
}

/**
 * What `fetch failed` actually was.
 *
 * ⚠ **`fetch` in undici reports every transport failure as the same two words,
 * and the reason is one level down in `cause`.** Measured 2026-09-15 on a machine
 * whose control plane sits behind a private CA: `~/Library/Logs/reemoat/daemon.log`
 * held 2019 lines of `could not reach the control plane … fetch failed` and not one
 * word about a certificate, while the same request with `NODE_EXTRA_CA_CERTS` set
 * answered 200. The cause said `UNABLE_TO_VERIFY_LEAF_SIGNATURE` the whole time.
 *
 * Appended here rather than inside `describeError`, which every error envelope in
 * this fleet goes through: the hidden-cause problem is `fetch`'s, and this is the
 * one call site where a wrong answer costs somebody a day.
 */
function causeOf(error: unknown): string {
  const cause = error instanceof Error ? (error as { cause?: unknown }).cause : undefined;
  if (!(cause instanceof Error)) return "";
  const code = (cause as { code?: unknown }).code;
  return ` (${typeof code === "string" && code.length > 0 ? `${code}: ` : ""}${cause.message})`;
}

export class EnrollError extends Error {
  constructor(
    readonly code: EnrollErrorCode,
    message: string,
    readonly detail: unknown = null,
  ) {
    super(message);
    this.name = "EnrollError";
  }
}

export interface EnrollResult {
  machineId: string;
  issuer: string;
  keys: { kid: string; jwk: unknown }[];
  /**
   * The long-lived credential this daemon holds a relay tunnel with, or `null`
   * from a control plane too old to issue one.
   *
   * Everything else enrollment hands over is *public* — a machine id is a name
   * and a public key is public — so none of it lets the daemon prove who it is on
   * a later connection. This is the only secret in the exchange, and it exists so
   * that a daemon dialling the relay can be identified rather than believed.
   *
   * Rotated by re-enrolling, like the signing keys, because one rotation story is
   * better than two.
   */
  tunnelKey: string | null;
  /** Where to dial for a relay tunnel, or `null` when the control plane runs none. */
  relayUrl: string | null;
}

export interface EnrollOptions {
  controlPlane: string;
  code: string;
  /**
   * The public half of this machine's X25519 static, base64url, when it has one.
   *
   * **Optional here and load-bearing for the fleet.** The other way this key
   * reaches the control plane is the tunnel dial, which pins it *trust on first
   * use* — and a machine row already holding a different key refuses the dial
   * with a 409 rather than adopting the new one. The recovery the Authority
   * documents for that refusal is re-enrollment, and this field is the whole of
   * it: redeeming a code already retires the machine's tunnel credential, so it
   * is the one moment that means *this machine is starting again*, and the
   * enrollment route replaces the pin outright when a key arrives beside the
   * code.
   *
   * ⚠ **Nothing sent one until this existed, and the failure was silent and
   * permanent.** The route read `machineKey` off the body and this client posted
   * `{ code }` alone, so the replace path was unreachable: a host whose local
   * database was lost — a restored backup, a wiped `~/.reemoat` — re-enrolled
   * against the same machine row, generated a fresh key at its next start,
   * announced it, and was refused on every dial for ever, retrying on its
   * backoff while the app drew the machine as not connected. The only remedies
   * left were hand-editing the control plane's SQLite or abandoning the machine
   * id with its grants and its history.
   *
   * Omitted from the body rather than sent empty by a caller that has none, for
   * the reason the dial omits its header: a daemon that predates this and one
   * with nothing to say are the same silence on the wire. A control plane older
   * than this ignores the field, and one that cannot read it refuses it to
   * `null` rather than refusing the enrollment — so neither direction is a flag
   * day.
   */
  machineKey?: string;
  /** Startup is not allowed to hang on a control plane that accepts and stalls. */
  timeoutMs?: number;
}

const DEFAULT_ENROLL_TIMEOUT_MS = 15_000;

/**
 * A stable fingerprint of an enrollment code.
 *
 * Stored instead of the code so that "this daemon was started with the same
 * code as last time" is answerable without keeping a live credential on disk.
 * That comparison is the whole of the re-enrollment rule: same fingerprint,
 * do nothing; different fingerprint, exchange again.
 */
export function codeFingerprint(code: string): string {
  return createHash("sha256").update(code.trim(), "utf8").digest("hex").slice(0, 32);
}

export async function enroll(options: EnrollOptions): Promise<EnrollResult> {
  const url = new URL("/v1/enroll", options.controlPlane);
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? DEFAULT_ENROLL_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  /*
   * The code, and the key this machine answers on when it has one.
   *
   * Built as an object rather than inlined so the field can be *absent* instead
   * of `null`: the body a daemon older than machine keys sent was exactly
   * `{ code }`, and keeping that shape when there is nothing to announce is what
   * makes this additive in both directions rather than a new dialect.
   */
  const machineKey = options.machineKey?.trim() ?? "";
  const payload: Record<string, unknown> = { code: options.code.trim() };
  if (machineKey.length > 0) payload["machineKey"] = machineKey;

  let body: unknown;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    // Inside the timeout, not after it. `fetch` resolves as soon as the headers
    // arrive, so a control plane that answers `200` and then stalls the body
    // would hang startup for ever if the timer were cleared here — which is the
    // precise failure this timeout exists to prevent. Aborting the signal after
    // the response resolves still tears down the body stream.
    body = await response.json().catch((error: unknown) => {
      /*
       * An abort here is the timeout firing *during the body*, which is the exact
       * case the comment above is about — so it has to be rethrown.
       *
       * A blanket `() => null` swallowed it, and the effect was subtle: the abort
       * never reached the handler below, `response.ok` was still true for the 200
       * whose headers had arrived, and startup failed with `bad_response` — "the
       * control plane sent something malformed" — for a control plane that had in
       * fact simply stopped talking. Measured by `pnpm authcheck`'s stalling-server
       * case, which is why that case exists.
       *
       * Anything else really is a body that would not parse, and staying lenient
       * there is deliberate: `parseEnrollResponse` gives a better message for it.
       */
      if (controller.signal.aborted) throw error;
      return null;
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new EnrollError("timeout", `the control plane at ${url.origin} did not answer within ${timeoutMs / 1000}s`);
    }
    throw new EnrollError(
      localNetworkBlocked(error) ? "local_network" : "unreachable",
      `could not reach the control plane at ${url.origin}: ${describeError(error)}${causeOf(error)}`,
    );
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    // The control plane's own error code, when it sent one. A code that was
    // already redeemed and a code that never existed are different problems and
    // the operator has to be able to tell them apart.
    const detail = readError(body);
    throw new EnrollError(
      "code_rejected",
      `the control plane refused this enrollment code (${response.status}${detail ? `: ${detail}` : ""})`,
      body,
    );
  }

  return parseEnrollResponse(body);
}

/** Split out from the fetch so the shape rules can be exercised without a server. */
export function parseEnrollResponse(body: unknown): EnrollResult {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new EnrollError("bad_response", "the control plane did not return a JSON object");
  }
  const fields = body as Record<string, unknown>;
  const machineId = fields["machineId"];
  const issuer = fields["issuer"];
  const rawKeys = fields["keys"];

  if (typeof machineId !== "string" || machineId.length === 0) {
    throw new EnrollError("bad_response", "the enrollment response carried no machineId");
  }
  if (typeof issuer !== "string" || issuer.length === 0) {
    throw new EnrollError("bad_response", "the enrollment response carried no issuer");
  }
  if (!Array.isArray(rawKeys) || rawKeys.length === 0) {
    throw new EnrollError("bad_response", "the enrollment response carried no keys");
  }

  const keys: { kid: string; jwk: unknown }[] = [];
  for (const entry of rawKeys) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const kid = record["kid"];
    const jwk = record["jwk"];
    if (typeof kid !== "string" || kid.length === 0) continue;
    // Parsed now, not at first use. A key that cannot be turned into an Ed25519
    // public key is worthless, and finding that out at enrollment — where an
    // operator is watching — beats finding out on the first request months
    // later, when the symptom is "every token is rejected".
    if (jwkToPublicKey(jwk) === null) continue;
    keys.push({ kid, jwk });
  }

  if (keys.length === 0) {
    throw new EnrollError(
      "no_usable_keys",
      "the control plane returned keys, but none of them was a usable Ed25519 public key",
    );
  }

  /*
   * The relay fields are optional in both directions, and neither direction is a
   * failure.
   *
   * A control plane with no relay omits them; a daemon that finds them missing
   * simply never dials one and behaves exactly as it did before any of this
   * existed. Making either an error would mean a relay could not be introduced
   * without a synchronised fleet upgrade, which is the opposite of what
   * "additive" is supposed to buy.
   */
  const rawTunnelKey = fields["tunnelKey"];
  const tunnelKey = typeof rawTunnelKey === "string" && rawTunnelKey.length > 0 ? rawTunnelKey : null;

  let relayUrl: string | null = null;
  const relay = fields["relay"];
  if (typeof relay === "object" && relay !== null && !Array.isArray(relay)) {
    const url = (relay as Record<string, unknown>)["url"];
    if (typeof url === "string" && url.length > 0) {
      // Parsed here, where an operator is watching, rather than at first dial —
      // the same reason the keys above are parsed at enrollment.
      try {
        relayUrl = new URL(url).toString();
      } catch {
        throw new EnrollError("bad_response", `the control plane offered a relay at an unparseable URL: ${url}`);
      }
    }
  }

  return { machineId, issuer, keys, tunnelKey, relayUrl };
}

function readError(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const error = (body as Record<string, unknown>)["error"];
  if (typeof error !== "object" || error === null) return null;
  const fields = error as Record<string, unknown>;
  const code = fields["code"];
  const message = fields["message"];
  if (typeof code === "string" && typeof message === "string") return `${code} — ${message}`;
  return typeof code === "string" ? code : null;
}

