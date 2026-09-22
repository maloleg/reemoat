#!/usr/bin/env node
import { generateKeyPairSync } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  ALL_SCOPES,
  AUTH_LEEWAY_MS,
  CompositeVerifier,
  NO_CHANNEL,
  SharedSecretVerifier,
  SignedTokenVerifier,
  enrollmentIgnored,
  type ChannelIdentity,
} from "../src/auth.js";
import { generateStaticKey } from "@reemoat/protocol";
import { codeFingerprint, enroll, EnrollError, parseEnrollResponse } from "../src/enroll.js";
import { jwkThumbprint, publicKeyToJwk, signToken, x25519Jwk, type TokenClaims } from "../src/token.js";

/**
 * The regression driver for token verification.
 *
 * `harness.ts` is the regression test for the session paths; this is the same
 * idea for the auth paths, and it exists for the same reason: there is no test
 * framework here, so "testable" has to mean "drivable from `scripts/`".
 *
 * Everything below is offline and deterministic — keys are generated in
 * process, `now` is passed in rather than read from the clock. That matters
 * most for the expiry and skew cases, which are otherwise only reachable by
 * waiting five minutes or changing the system time.
 *
 * Run it after touching `src/token.ts`, `src/auth.ts` or `src/enroll.ts`:
 *   pnpm authcheck
 */

let failures = 0;

function check(name: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) {
    process.stdout.write(`  ok    ${name}\n`);
    return;
  }
  failures += 1;
  process.stdout.write(`  FAIL  ${name}\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}\n`);
}

function codeOf(result: { ok: boolean; code?: string }): string {
  return result.ok ? "(accepted)" : (result.code ?? "?");
}

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const attacker = generateKeyPairSync("ed25519");
const kid = "k_authcheck";
const identity = {
  machineId: "m_self",
  issuer: "reemoat-cp",
  keys: [{ kid, jwk: publicKeyToJwk(publicKey) }],
};

// A fixed instant, so every boundary below is exact rather than approximate.
const now = 1_800_000_000_000;
const iat = Math.floor(now / 1000);
/*
 * The device this installation is, and the channel it calls over.
 *
 * Generated here rather than fixed, because nothing below depends on the *value*
 * — only on two keys being different, which is the property every binding case is
 * about. `alice` is the device holding the capability; `mallory` is a second
 * installation that holds a copy of it and nothing else.
 */
const aliceDevice = generateStaticKey();
const malloryDevice = generateStaticKey();
const aliceThumbprint = jwkThumbprint(x25519Jwk(aliceDevice.publicKey));
const malloryThumbprint = jwkThumbprint(x25519Jwk(malloryDevice.publicKey));
const aliceChannel: ChannelIdentity = { peerKeyThumbprint: aliceThumbprint };

const claims: TokenClaims = {
  iss: "reemoat-cp",
  sub: "u_alice",
  aud: "m_self",
  jti: "t_1",
  iat,
  nbf: iat,
  exp: iat + 300,
  scp: ["session:read", "session:write", "not:a:real:scope"],
  cnf: { jkt: aliceThumbprint },
  dev: "dv_alice",
};

const skews: string[] = [];
const signed = new SignedTokenVerifier({ identity, onSuspectedClockSkew: (detail) => skews.push(detail) });
const good = signToken(claims, kid, privateKey);

process.stdout.write("\nsigned tokens\n");
const accepted = signed.verify(good, now, aliceChannel);
check("a well-formed token is accepted", accepted.ok, true);
if (accepted.ok) {
  check("subject is carried through", accepted.principal.subject, "u_alice");
  check("unknown scopes are dropped, not fatal", accepted.principal.scopes, ["session:read", "session:write"]);
  check("expiry is exposed in ms", accepted.principal.expiresAt, (iat + 300) * 1000);
  check("jti is carried through", accepted.principal.tokenId, "t_1");
}

process.stdout.write("\nforgery\n");
// The one that turns a single grant into a grant on the whole fleet.
check(
  "a token for another machine is refused",
  codeOf(signed.verify(signToken({ ...claims, aud: "m_other" }, kid, privateKey), now)),
  "wrong_machine",
);
check(
  "a token from another issuer is refused",
  codeOf(signed.verify(signToken({ ...claims, iss: "somebody-else" }, kid, privateKey), now)),
  "wrong_issuer",
);
check(
  "a token signed by another key is refused",
  codeOf(signed.verify(signToken(claims, kid, attacker.privateKey), now)),
  "bad_signature",
);
check(
  "a token naming an unknown key is refused",
  codeOf(signed.verify(signToken(claims, "k_unknown", privateKey), now)),
  "unknown_key",
);

// alg confusion, in both of its usual shapes.
const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
const payload = b64(claims);
check(
  'alg:"none" is refused',
  codeOf(signed.verify(`${b64({ alg: "none", typ: "reemoat+jwt", kid })}.${payload}.`, now)),
  "malformed_token",
);
check(
  "an HMAC alg is refused",
  codeOf(signed.verify(`${b64({ alg: "HS256", typ: "reemoat+jwt", kid })}.${payload}.AAAA`, now)),
  "malformed_token",
);
check(
  "a foreign typ is refused",
  codeOf(signed.verify(`${b64({ alg: "EdDSA", typ: "JWT", kid })}.${payload}.AAAA`, now)),
  "malformed_token",
);
// Non-canonical base64url would otherwise make one token into a family of them,
// all verifying against one signature, which would make jti meaningless.
check(
  "padded base64url is refused",
  codeOf(signed.verify(`${b64({ alg: "EdDSA", typ: "reemoat+jwt", kid })}==.${payload}.AA`, now)),
  "malformed_token",
);
/*
 * The other two segments, and the character that actually motivated the check.
 *
 * `Buffer.from(s, "base64url")` silently skips what it does not recognise, so
 * `"ab!cd"` and `"abcd"` decode identically. Padding on the header covered only
 * one third of the surface; without the re-encode comparison in `b64uDecode` the
 * *payload* variant verifies against the real signature, which is the case that
 * turns one token into a family of them and makes `jti` stop identifying one.
 */
const [goodHeader, goodPayload, goodSignature] = good.split(".") as [string, string, string];
check(
  "a non-canonical payload is refused",
  codeOf(signed.verify(`${goodHeader}.${goodPayload}!.${goodSignature}`, now)),
  "malformed_token",
);
check(
  "a non-canonical signature is refused",
  codeOf(signed.verify(`${goodHeader}.${goodPayload}.${goodSignature}!`, now)),
  "malformed_token",
);

process.stdout.write("\nthe clock\n");
const expMs = (iat + 300) * 1000;
const nbfMs = iat * 1000;
check("accepted exactly at the far edge of leeway", signed.verify(good, expMs + AUTH_LEEWAY_MS, aliceChannel).ok, true);
check("refused one ms past it", codeOf(signed.verify(good, expMs + AUTH_LEEWAY_MS + 1, aliceChannel)), "token_expired");
check("accepted exactly at the near edge of leeway", signed.verify(good, nbfMs - AUTH_LEEWAY_MS, aliceChannel).ok, true);
check("refused one ms before it", codeOf(signed.verify(good, nbfMs - AUTH_LEEWAY_MS - 1, aliceChannel)), "token_not_yet_valid");

skews.length = 0;
const late = signed.verify(good, expMs + AUTH_LEEWAY_MS + 30_000, aliceChannel);
check("a near miss reports suspected skew", skews.length, 1);
// The number itself, not just that something was reported: a client that cannot
// see how far outside the window it fell cannot tell a wrong clock from a token
// that simply died, which is the entire purpose of returning it.
check("and says how far outside the window it fell", late.ok ? null : late.skewMs, 30_000);
skews.length = 0;
signed.verify(good, expMs + AUTH_LEEWAY_MS + 3_600_000, aliceChannel);
check("a wild miss does not", skews.length, 0);

/*
 * The same pair on the `nbf` side.
 *
 * "Clock skew is reported in both directions, deliberately" was only half driven:
 * both existing cases sit past `exp`, so the `token_not_yet_valid` branch — the
 * one a phone with a *fast* clock hits — never reported anything here.
 */
skews.length = 0;
const early = signed.verify(good, nbfMs - AUTH_LEEWAY_MS - 30_000, aliceChannel);
check("a near miss the other way reports skew too", skews.length, 1);
check("and says how far the other way", early.ok ? null : early.skewMs, 30_000);
skews.length = 0;
signed.verify(good, nbfMs - AUTH_LEEWAY_MS - 3_600_000, aliceChannel);
check("a wild miss the other way does not", skews.length, 0);

process.stdout.write("\nthe shared secret\n");
const shared = new SharedSecretVerifier("hunter2");
check("the right secret is accepted", shared.verify("hunter2").ok, true);
check("a wrong secret is refused", codeOf(shared.verify("hunter3")), "bad_credential");
check("an empty credential is refused", codeOf(shared.verify("")), "missing_token");
const sharedOk = shared.verify("hunter2");
check("it grants every scope", sharedOk.ok ? [...sharedOk.principal.scopes] : null, [...ALL_SCOPES]);
check("it never expires", sharedOk.ok ? sharedOk.principal.expiresAt : "?", null);

/* ------------------------------------------------------------------ *
 * The device binding
 *
 * A capability names the key its holder must be able to prove it has, and the
 * daemon compares that name against the static key the encrypted channel
 * authenticated. This is the section that says a capability is not a bearer
 * token: a copy of one, taken out of a log or a proxy or a query string, is worth
 * nothing to whoever took it.
 *
 * ⚠ **It is authentication and not authorization.** Nothing here widens or
 * narrows what a grant reaches — a grant is still `(user, machine)` and still
 * full access to that machine. What it removes is the ability to use somebody
 * else's capability.
 * ------------------------------------------------------------------ */

process.stdout.write("\nthe device a capability was minted for\n");
{
  check("a capability presented by the device it names is accepted", signed.verify(good, now, aliceChannel).ok, true);
  if (signed.verify(good, now, aliceChannel).ok) {
    const principal = signed.verify(good, now, aliceChannel);
    check(
      "and the installation is carried through for the audit trail",
      principal.ok ? principal.principal.deviceId : "?",
      "dv_alice",
    );
  }

  /*
   * The theft case, and it is the whole point. Mallory holds a byte-for-byte copy
   * of a capability that verifies perfectly — right signature, right issuer, right
   * machine, well inside its lifetime — and cannot use it.
   */
  check(
    "the same capability from another device is refused",
    codeOf(signed.verify(good, now, { peerKeyThumbprint: malloryThumbprint })),
    "wrong_device",
  );
  /*
   * ⚠ **The downgrade, in its two shapes, and both must be refusals.**
   *
   * A capability with no `cnf` is what a control plane older than this daemon
   * mints. It gets its own code because the remedy is different — that is an
   * operator's problem, where `wrong_device` is the caller's — and it must never
   * be accepted, or every capability could be stripped of its binding by whoever
   * could alter a claim.
   */
  const { cnf: _dropped, ...unbound } = claims;
  check(
    "a capability naming no device is refused over a channel that names one",
    codeOf(signed.verify(signToken(unbound, kid, privateKey), now, aliceChannel)),
    "unbound_capability",
  );
  /*
   * And a `cnf` that is present but malformed must read as *malformed*, never as
   * absent. If it read as absent it would fall to the code above, which is a
   * refusal — but the same leniency in a verifier that tolerated an absent one
   * would be the downgrade itself, so the strictness is asserted where it lives.
   */
  const malformed = { ...claims, cnf: { jkt: "" } } as unknown as TokenClaims;
  check(
    "a confirmation claim that is present and malformed is malformed, not absent",
    codeOf(signed.verify(signToken(malformed, kid, privateKey), now, aliceChannel)),
    "malformed_token",
  );

  /*
   * The order matters and is asserted rather than assumed. `aud` stays the first
   * question about a capability's addressee, because it is the fleet-wide one; the
   * device binding is strictly narrower and sits below it.
   */
  check(
    "a capability for another machine reports the machine, not the device",
    codeOf(signed.verify(signToken({ ...claims, aud: "m_other" }, kid, privateKey), now, NO_CHANNEL)),
    "wrong_machine",
  );
  /*
   * And the binding is asked *before* the clock, so an expired capability that was
   * never for this device does not send somebody to go and fix a clock that is
   * fine. `skewMs` on the wrong answer costs an afternoon.
   */
  check(
    "an expired capability from the wrong device reports the device",
    codeOf(signed.verify(good, expMs + AUTH_LEEWAY_MS + 1, { peerKeyThumbprint: malloryThumbprint })),
    "wrong_device",
  );
  /*
   * ⚠ **And the one shape that must NOT be a refusal**, or the daemon loses
   * loopback the day an old Authority is still minting: no channel, no `cnf`.
   * That is the desktop app on this computer talking to its own daemon, and it is
   * the path that has to keep working with the internet switched off. The
   * operating system has already established that the caller is the uid owning
   * this daemon's database, its signing keys and every transcript — a stronger
   * statement than a key, not a weaker one.
   *
   * ⚠ **This block used to claim that spelling `NO_CHANNEL` out was itself the
   * security property** — that a default the other way would mean every call site
   * which forgot it quietly accepted bearer capabilities. That is the inverse of
   * the code: both `verify` signatures in `src/auth.ts` *default* to this
   * constant, and that file's docblock carries the correction and what it would
   * take to make the original claim true. So the last case below asserts the fact
   * the gate actually rests on instead — `server.ts` calls
   * `verifier.verify(readCredential(c))` with no channel at all, and reaches this
   * path through that default and through nothing else.
   */
  check("loopback accepts a capability with no channel to bind to", signed.verify(good, now, NO_CHANNEL).ok, true);
  check(
    "and one that names no device at all",
    signed.verify(signToken(unbound, kid, privateKey), now, NO_CHANNEL).ok,
    true,
  );
  check(
    "but it is still the same machine check",
    codeOf(signed.verify(signToken({ ...claims, aud: "m_other" }, kid, privateKey), now, NO_CHANNEL)),
    "wrong_machine",
  );
  /*
   * And the same capability with the argument left off, which is the shape the
   * auth gate uses and the shape no case here had ever driven.
   *
   * Every case above spells `NO_CHANNEL`; `server.ts`'s
   * `verifier.verify(readCredential(c))` spells nothing and arrives here through
   * the parameter default. A default that named a device would answer
   * `unbound_capability` to this while every case above that spells the constant
   * stayed green — a change with no other symptom in this driver, and with
   * loopback going dark as its symptom in production.
   */
  check(
    "and the default channel answers exactly as naming it does",
    codeOf(signed.verify(signToken(unbound, kid, privateKey), now)),
    "(accepted)",
  );
}

process.stdout.write("\nboth modes at once\n");
const both = new CompositeVerifier(signed, shared);
check("a secret still works", both.verify("hunter2", now).ok, true);
check("a signed token still works", both.verify(good, now, aliceChannel).ok, true);
// Routed by shape, so a signed token that fails for a real reason reports that
// reason rather than being retried as a secret and coming back as garbage.
check(
  "a bad signed token keeps its own failure",
  codeOf(both.verify(signToken({ ...claims, aud: "m_other" }, kid, privateKey), now)),
  "wrong_machine",
);

process.stdout.write("\nthe enrollment response\n");
const enrolled = parseEnrollResponse({
  machineId: "m_self",
  issuer: "reemoat-cp",
  keys: [{ kid, jwk: publicKeyToJwk(publicKey) }, { kid: "k_junk", jwk: { kty: "oct", k: "nope" } }],
});
check("usable keys survive", enrolled.keys.length, 1);
check("an unusable key is dropped, not fatal", enrolled.keys[0]?.kid, kid);
for (const [name, body] of [
  ["no machineId", { issuer: "x", keys: [{ kid, jwk: publicKeyToJwk(publicKey) }] }],
  ["no issuer", { machineId: "m", keys: [{ kid, jwk: publicKeyToJwk(publicKey) }] }],
  ["no keys at all", { machineId: "m", issuer: "x", keys: [] }],
  ["only unusable keys", { machineId: "m", issuer: "x", keys: [{ kid: "k", jwk: { kty: "oct" } }] }],
] as const) {
  let threw = false;
  try {
    parseEnrollResponse(body);
  } catch {
    threw = true;
  }
  check(`an enrollment response with ${name} is refused`, threw, true);
}

/* ------------------------------------------------------------------ *
 * The one request this daemon ever makes
 *
 * Loopback only, so this stays offline and deterministic. Two things are pinned
 * here: the shape of `enroll`'s failure handling, which the parser cases above
 * cannot reach at all, and the request it puts on the wire — its method, its path,
 * its content type and the body — which nothing anywhere read until the stub
 * below started keeping them.
 * ------------------------------------------------------------------ */

process.stdout.write("\nthe enrollment request\n");
{
  /*
   * Headers, then silence.
   *
   * `fetch` resolves as soon as the *headers* arrive, so a control plane that
   * answers 200 and then stalls the body would hang startup for ever if the
   * timeout were cleared at that point. `enroll` therefore clears its timer after
   * reading the body, and this is the case that says so.
   */
  const stalling = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.write("{");
  });
  await new Promise<void>((resolve) => stalling.listen(0, "127.0.0.1", () => resolve()));
  const stallPort = (stalling.address() as AddressInfo).port;

  /*
   * Raced against a watchdog, because the regression here produces *no answer*
   * rather than a wrong one.
   *
   * Move `enroll`'s `clearTimeout(timer)` up to just after `fetch` resolves — the
   * exact edit the docblock above says this case exists to catch — and
   * `await response.json()` waits on a server that has written `"{"` and stopped.
   * ⚠ **Measured 2026-09-17 against exactly that shape on Node 26.3.0**: with the
   * timer cleared at the headers, the body promise was still pending 20s into a
   * 250ms timeout, and nothing on the client side was ever going to end it. So
   * `enroll` never settles, the `await` never returns, and the `check` below never
   * runs — nor does any section under it. A driver that hangs is the worst shape a
   * regression can take, because it reports no name at all; the watchdog turns it
   * into a FAIL that says `(never settled)`.
   *
   * `.then(onOk, onErr)` rather than `try`/`catch` around the race, so that when
   * the watchdog wins, the rejection of the still-pending `enroll` is already
   * handled and cannot surface as an unhandled rejection.
   */
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  const code = await Promise.race([
    enroll({ controlPlane: `http://127.0.0.1:${stallPort}`, code: "ec_test", timeoutMs: 250 }).then(
      () => "(no error)",
      (error: unknown) => (error instanceof EnrollError ? error.code : "(not an EnrollError)"),
    ),
    new Promise<string>((resolve) => {
      // 10s against a path that answers in 250ms on loopback: wide enough that a
      // loaded box cannot trip it, narrow enough to be a test result rather than
      // a job timeout.
      watchdog = setTimeout(() => resolve("(never settled)"), 10_000);
    }),
  ]);
  clearTimeout(watchdog);
  check("a control plane that answers and then stalls is a timeout", code, "timeout");
  stalling.close();

  // A refusal is a refusal, not a retry-forever. Codes are single use, so the
  // second boot with a spent code has to fail loudly rather than quietly.
  const refusing = createServer((_req, res) => {
    res.writeHead(409, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { code: "code_spent", message: "already used" } }));
  });
  await new Promise<void>((resolve) => refusing.listen(0, "127.0.0.1", () => resolve()));
  const refusePort = (refusing.address() as AddressInfo).port;
  let refusedCode = "(no error)";
  try {
    await enroll({ controlPlane: `http://127.0.0.1:${refusePort}`, code: "ec_spent", timeoutMs: 2_000 });
  } catch (error) {
    refusedCode = error instanceof EnrollError ? error.code : "(not an EnrollError)";
  }
  check("a refused code is reported as such", refusedCode, "code_rejected");
  refusing.close();

  /*
   * ⚠ **What `enroll` actually puts on the wire, which nothing had ever read.**
   *
   * The machine-key re-pin has three links and only the two ends were driven.
   * `relaycheck` drives the far one — `POST /v1/enroll` reading `machineKey` off
   * the body, `setMachineKey` replacing the pin — against bodies it types out
   * itself, and it reads `scripts/daemon.ts` to watch the field being handed to
   * this function. Between them sits the step nothing executed: whether `enroll`
   * serializes it at all. That is the link that was broken for a release, and
   * `EnrollOptions.machineKey` records what it cost.
   *
   * ⚠ **The size of that gap, stated exactly rather than dramatically.** Deleting
   * `payload["machineKey"] = machineKey` on its own does *not* get past
   * `pnpm typecheck`: the root `tsconfig` sets `noUnusedLocals`, so the `machineKey`
   * binding on the line above it is left read by nothing and `tsc` names it. What
   * no compiler here can see is every edit that keeps that line and changes what it
   * does, and each of those is why one of the cases below exists:
   *
   *   - the field spelled `machine_key`, or that pair of lines deleted *together*
   *     — the second is green, because `options.machineKey` then goes unread and an
   *     interface field nothing reads is not an unused local. Both are caught by
   *     the two assertions on `ec_announced`'s body, which read the key's value and
   *     then the whole key set.
   *   - the assignment made unconditional, so a daemon with nothing to announce
   *     announces `""`. Caught by `ec_silent`.
   *   - the `.trim()` dropped. Caught by `ec_blank` and `ec_padded`, one on each
   *     side of the `length > 0` test.
   *
   * So this stub keeps the request rather than dropping it. The two servers above
   * underscore their request argument because nothing read it — this is the same
   * server with the request kept, and the capture is complete before `enroll`
   * returns because the response is written inside the `end` handler.
   *
   * ⚠ **The method and the path are kept beside the body**, because a mistake in
   * either is invisible from `enroll`'s own error. A `POST` that moved to the
   * wrong path comes back 404, and `enroll` reports every non-2xx through one
   * branch: `EnrollError("code_rejected", …)`, whose message is "the control plane
   * refused this enrollment code". So the only symptom of an address that is wrong
   * for every daemon in the fleet is an operator auditing enrollment codes that
   * were in fact never read.
   *
   * The content type is the weakest of the three and is kept anyway:
   * `readJsonObject` on the far end parses the body without consulting it, so
   * nothing in this repository depends on it *today* — but `enroll` sets it
   * deliberately, and a request that stops declaring JSON is one a proxy or a
   * gateway in front of that route may refuse, with no symptom reachable from
   * here. Same argument as the padded-key case below: what this section pins is
   * the shape `enroll` is answerable for on the only end that can be asked here.
   */
  interface Recorded {
    method: string;
    path: string;
    contentType: string;
    body: string;
  }
  const posted: Recorded[] = [];
  const recording = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      posted.push({
        method: req.method ?? "(none)",
        path: req.url ?? "(none)",
        contentType: req.headers["content-type"] ?? "(none)",
        body: Buffer.concat(chunks).toString("utf8"),
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ machineId: "m_self", issuer: "reemoat-cp", keys: [{ kid, jwk: publicKeyToJwk(publicKey) }] }));
    });
  });
  await new Promise<void>((resolve) => recording.listen(0, "127.0.0.1", () => resolve()));
  const recordPort = (recording.address() as AddressInfo).port;

  /*
   * A real key, made the way `ensureMachineKey` makes the daemon's: base64url of
   * the raw X25519 public half, which is 43 characters. `enroll` checks no shape,
   * so the fixture is documentation rather than a constraint — but a stand-in
   * string would have left the thing a reader wants to see, that all 43 characters
   * arrive unaltered, looking like a coincidence.
   */
  const announced = Buffer.from(generateStaticKey().publicKey).toString("base64url");

  const bodyOf = (index: number): Record<string, unknown> => {
    const raw = posted[index]?.body;
    /*
     * An object either way, so a request that never arrived fails the `code`
     * assertion below by name instead of throwing here. A driver that dies
     * mid-section prints a stack and leaves every section under it unrun, which
     * reads as a far larger failure than the one that happened.
     */
    if (raw === undefined) return { "(no request arrived)": index };
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { "(not an object)": raw };
      return parsed as Record<string, unknown>;
    } catch {
      // Not JSON at all. The raw bytes say more in a FAIL line than a parser's
      // message would.
      return { "(unparseable)": raw };
    }
  };

  const exchangeErrors: string[] = [];
  const post = async (options: { code: string; machineKey?: string }): Promise<void> => {
    try {
      await enroll({ controlPlane: `http://127.0.0.1:${recordPort}`, timeoutMs: 2_000, ...options });
    } catch (error) {
      exchangeErrors.push(`${options.code}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  await post({ code: "ec_announced", machineKey: announced });
  await post({ code: "ec_silent" });
  await post({ code: "ec_blank", machineKey: "  \n\t " });
  await post({ code: " ec_padded \n", machineKey: `  ${announced}\n` });

  /*
   * A diagnostic rather than a liveness check, and labelled as one: an empty list
   * is also what no calls at all would leave, which is the shape of every
   * assertion this repository has caught being green because it could not fail.
   * The count on the next line is the liveness check — fewer requests give a
   * smaller number — and the four distinct codes are what prove which captured
   * body is which.
   */
  check("no exchange threw", exchangeErrors, []);
  check("four requests reached the stub", posted.length, 4);

  /*
   * Where each one was posted and how, which no assertion anywhere had read.
   *
   * A set rather than four literals, so that a fifth `post({…})` above does not
   * have to be typed out again down here — and an exact array rather than a floor,
   * because the failure a floor structurally cannot see is a *skipped* item: a
   * request that never happened does not lower a count, it fails to raise one.
   * Zero requests give `[]`, which equals none of the three expectations below;
   * one diverging request gives a two-element array, which equals none of them
   * either. `posted.length` above stays the liveness check.
   */
  const distinct = (pick: (entry: Recorded) => string): string[] => [...new Set(posted.map(pick))].sort();
  check("every one of them is a POST", distinct((entry) => entry.method), ["POST"]);
  check("to /v1/enroll and nothing else", distinct((entry) => entry.path), ["/v1/enroll"]);
  check("declaring itself JSON", distinct((entry) => entry.contentType), ["application/json"]);

  const withKey = bodyOf(0);
  check("the code a daemon redeems reaches the wire", withKey["code"], "ec_announced");
  check("and the machine key beside it, unaltered", withKey["machineKey"], announced);
  // The whole body rather than only that both fields are in it: a third field is
  // a new dialect to a control plane that predates it, and additive in both
  // directions is the property this shape buys.
  check("and those two are the whole body", Object.keys(withKey).sort(), ["code", "machineKey"]);

  /*
   * ⚠ **Absent, not `null` and not `""`.** A daemon older than machine keys sent
   * exactly `{ code }`, and keeping that shape when there is nothing to announce
   * is the whole of why this is additive rather than a dialect.
   *
   * `in` rather than a comparison against `undefined`, because those are different
   * facts and only one of them is the contract — and because `check` compares with
   * `JSON.stringify`, under which a body that never arrived answers `undefined`
   * too and passes. The case above is the control that says this same capture
   * *does* surface a key when one was announced, and asserting each body's own
   * `code` is what stops "no machineKey" being satisfied by "no body".
   */
  const silent = bodyOf(1);
  check("a daemon with no key to announce still sends its code", silent["code"], "ec_silent");
  check("and the field is absent rather than null", "machineKey" in silent, false);

  /*
   * The branch `options.machineKey?.trim() ?? ""` exists for, and the one nothing
   * reached. It is the half of that line with teeth: drop the trim and a
   * whitespace-only key goes on the wire, `parseMachineKey` refuses it to `null`
   * on the far side, `setMachineKey` never runs, and the enrollment succeeds
   * anyway — a re-pin that silently did not happen, which is the exact failure
   * this whole chain exists to repair.
   */
  const blank = bodyOf(2);
  check("whitespace is not a key to announce", blank["code"], "ec_blank");
  check("and it is absent too, not empty", "machineKey" in blank, false);

  /*
   * The same trim observed where it decides a *value* rather than a presence.
   *
   * Nothing downstream depends on it today, and saying so beats inventing a
   * consequence: `parseMachineKey` trims what arrives before measuring it, and
   * `hashCredential` trims the code. What this pins is the shape `enroll` is
   * answerable for on the only end that can be asked here — which is the whole
   * reason the block above can be read as a statement about absence rather than
   * about whitespace.
   */
  const padded = bodyOf(3);
  check("a padded code reaches the wire trimmed", padded["code"], "ec_padded");
  check("and so does a padded key", padded["machineKey"], announced);

  recording.close();

  /*
   * The fingerprint, which is the whole of "a restart with the same enrollment
   * code makes no network call". Codes are single use, so a daemon that
   * re-exchanged on every boot would fail to start the second time — and the
   * comparison has to survive the trimming both `enroll` and the daemon do.
   */
  check("the same code fingerprints the same across a restart", codeFingerprint(" ec_test\n"), codeFingerprint("ec_test"));
  check(
    "a different code does not",
    codeFingerprint("ec_test") === codeFingerprint("ec_other"),
    false,
  );
  /*
   * And that it is a fingerprint rather than the code.
   *
   * The two above are both satisfied by handing `code.trim()` straight back —
   * same in, same out; different in, different out — which is the one
   * implementation `codeFingerprint`'s own docblock rules out by name: it exists
   * so that "this daemon was started with the same code as last time" is
   * answerable *without keeping a live credential on disk*, and `daemon.ts`
   * persists the result as `codeFp`. A single-use enrollment code sitting in that
   * column in the clear is a credential nobody decided to store, and neither
   * assertion above would have gone red for it.
   *
   * The width is asserted because it is a stored format rather than a detail:
   * widening the digest makes every existing `codeFp` stop matching, which
   * re-enrolls a fleet on codes that are already spent. That should have to come
   * through here.
   */
  const fingerprinted = codeFingerprint("ec_test");
  check("a fingerprint does not carry the code it was made from", fingerprinted.includes("ec_test"), false);
  check("and it is a fixed-width hex digest", /^[0-9a-f]{32}$/.test(fingerprinted), true);
}

process.stdout.write("\na daemon that enrolled and is about to ignore it\n");
{
  /*
   * The missing half of a check `daemon.ts` already makes.
   *
   * It refuses to start for the opposite mismatch — `REEMOAT_AUTH=signed` with
   * no stored identity exits 2 — and said nothing about a stored identity with no
   * `REEMOAT_AUTH`. Measured 2026-08-01 on a machine enrolled as `m_ffeaf8c7`:
   * restarting it without the variable (which lived in a shell rather than in
   * `.env`) brought it up as `shared_secret`, and **both** routes to it vanished
   * at once — a browser holds a control-plane token, which that mode does not
   * verify, and the relay tunnel is never dialled either. `/health` answered 200
   * throughout, so the daemon looked healthy while being unreachable.
   */
  const enrolled = { machineId: "m_ffeaf8c7" };
  const warning = enrollmentIgnored(undefined, enrolled);
  check("an enrolled daemon with no REEMOAT_AUTH is warned about", warning !== null, true);
  // Naming the machine is what makes the line actionable rather than a lecture:
  // it is the fact that proves the daemon *did* enroll, which is the thing an
  // operator reading `auth: shared_secret` cannot otherwise see.
  check("and the warning names the machine it enrolled as", (warning ?? "").includes("m_ffeaf8c7"), true);
  check("and says what is lost, not just what is set", (warning ?? "").includes("relay"), true);

  /*
   * Unset and explicitly `shared_secret` are different things, and that is the
   * whole discrimination.
   *
   * Unset means nobody decided and the default answered for them. An explicit
   * value means somebody did — and `.env.example` is clear that dropping an
   * enrolled daemon to the shared secret is a supported break-glass move, because
   * enrolling a machine you reach over the network is exactly when you can lock
   * yourself out of it. Warning there would be shouting at the one operator who
   * most needs the path to stay quiet and available.
   */
  check("an explicit shared_secret is a decision, not a mistake", enrollmentIgnored("shared_secret", enrolled), null);
  check("so is an explicit signed", enrollmentIgnored("signed", enrolled), null);
  check("and an explicit both", enrollmentIgnored("both", enrolled), null);
  // Empty counts as unset, because `resolveAuthMode` already treats it that way —
  // `REEMOAT_AUTH=` in a file is not a decision either.
  check("an empty value is unset, not a decision", enrollmentIgnored("   ", enrolled) !== null, true);

  /*
   * The common case stays silent. A daemon that never enrolled is the
   * single-machine shape `shared_secret` exists for, and the opposite direction
   * is already an exit-2 in `daemon.ts` rather than anything this reports.
   */
  check("a daemon that never enrolled is not warned at", enrollmentIgnored(undefined, null), null);
  check("nor is one that never enrolled and asked for signed", enrollmentIgnored("signed", null), null);
}

process.stdout.write(failures === 0 ? "\nall green\n\n" : `\n${failures} FAILED\n\n`);
process.exit(failures === 0 ? 0 : 1);
