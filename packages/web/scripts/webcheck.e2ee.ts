import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { Duplex } from "node:stream";
import { WebSocketServer, createWebSocketStream } from "ws";
import { MAX_FRAME_PAYLOAD, generateStaticKey, localStaticKey } from "@reemoat/protocol";
import { check, report, sleep } from "./webcheck.env.js";
import { serveSecureSession } from "../../../src/e2ee.js";
import { SignedTokenVerifier } from "../../../src/auth.js";
import { jwkThumbprint, publicKeyToJwk, signToken, x25519Jwk, type TokenClaims } from "../../../src/token.js";
import { MachineChannel, RELAY_CHANNEL_PATH, bodyBytes, type StreamSocket } from "../src/e2ee.js";
/*
 * ⚠ **The ceiling is read from the module that owns it rather than written down
 * here.** `Connection`'s own docblock refuses a module-level alias for
 * `MAX_DOWNLOAD_BYTES` because of an import cycle; a *driver* has no such
 * problem, and a second copy of a memory bound in a check is two numbers that
 * agree until somebody raises one of them — at which point the assertion passes
 * by sending less than the bound it is supposed to be crossing.
 */
import { MAX_DOWNLOAD_BYTES } from "../src/machine.js";

/* ------------------------------------------------------------------ *
 * The client's half of the encrypted channel, against the real daemon's
 *
 * ⚠ **This is the section that says the two halves actually meet.**
 * `daemoncheck.e2ee.ts` drives the real `serveSecureSession` with a hand-written
 * client, so it can send bytes an honest client never would. This one is the
 * mirror and it is the more important of the two: the **real**
 * `MachineChannel` — the code that ships in the app — against the **real**
 * `serveSecureSession`, with a real `Noise_IK` handshake between them and a real
 * HTTP server on the far side. Nothing on either side of the crypto is a stub.
 *
 * What sits between them is a WebSocket spliced to a byte pipe, which is exactly
 * what `packages/control-plane/src/relay/proxy.ts`'s `handleChannel` does — and
 * **every byte it carries is recorded**, so the claim the whole phase rests on
 * is asserted here from the client's side rather than argued.
 *
 * The device key is held by this driver rather than by the shell. `hostReady`
 * fires at module import, so no driver can install a fake shell late enough to be
 * seen; `ChannelOptions.deviceKey` exists for exactly this, and what it buys is
 * that the handshake, the framing, the pool, the socket adapter and the
 * `wrong_device` recovery are all the shipped code rather than a description of
 * it.
 * ------------------------------------------------------------------ */

process.stdout.write("\nthe app's encrypted channel, against the real daemon session\n");

/* ------------------------------------------------------------------ *
 * A daemon-shaped listener
 * ------------------------------------------------------------------ */

/** The one string that must never appear in anything the relay carried. */
const SECRET_BODY = "the-quick-brown-fox-jumped-over-a-diff";
/** And the one path, because a request line is as revealing as a body. */
const SECRET_PATH = "/sessions/s_confidential/changes";

let daemonSaw: { method: string; path: string; auth: string | undefined }[] = [];

const daemon = createServer((req: IncomingMessage, res: ServerResponse) => {
  const path = req.url ?? "/";
  daemonSaw.push({ method: req.method ?? "?", path, auth: req.headers.authorization });

  if (path === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, instanceId: "i_e2ee" }));
    return;
  }
  if (path === SECRET_PATH) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ diff: SECRET_BODY }));
    return;
  }
  if (path === "/bytes") {
    const payload = new Uint8Array(200_000);
    for (let at = 0; at < payload.length; at += 1) payload[at] = at % 251;
    res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(payload.length) });
    res.end(payload);
    return;
  }
  if (path === "/echo") {
    const parts: Buffer[] = [];
    req.on("data", (chunk: Buffer) => parts.push(chunk));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ bytes: Buffer.concat(parts).length }));
    });
    return;
  }
  /*
   * A request that is never answered, for the two budgets that are supposed to
   * end one without the daemon's help: the caller's `AbortSignal` and
   * `timeoutMs`. Nothing is written and nothing is scheduled — the socket is let
   * go when the channel underneath it dies, which is `src/e2ee.ts`'s `destroy()`
   * calling `upstreamRequest.destroy()`, so this route leaves nothing behind for
   * the process to wait on at exit.
   */
  if (path === "/hang") return;
  /*
   * More bytes than this client will hold, written a megabyte at a time.
   *
   * ⚠ **Streamed rather than allocated**, and the difference is the difference
   * between a driver and an out-of-memory. The point of the assertion is that the
   * *app* refuses to accumulate this, so the daemon side must not be the thing
   * that makes 100 MiB resident: one reused block, `write` until it says to wait,
   * and `drain` to carry on.
   *
   * A kibibyte past the bound rather than exactly on it, so the frame that
   * crosses the line is unambiguous. No `content-length`, deliberately: this is
   * the case `machine.ts`'s declared-length check cannot see, which is the whole
   * reason the ceiling is also enforced against what actually arrives.
   */
  if (path === "/flood") {
    res.writeHead(200, { "content-type": "application/octet-stream" });
    const block = Buffer.alloc(1024 * 1024, 7);
    let written = 0;
    const pump = (): void => {
      while (written <= MAX_DOWNLOAD_BYTES) {
        written += block.length;
        if (!res.write(block)) {
          res.once("drain", pump);
          return;
        }
      }
      res.end();
    };
    pump();
    return;
  }
  // Hono's bare 404, which six readers turn into "this daemon is too old". It has
  // to survive the round trip unchanged; an enveloping layer is what would round
  // it off.
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("404 Not Found");
});

const daemonPort = await new Promise<number>((resolve) => {
  daemon.listen(0, "127.0.0.1", () => resolve((daemon.address() as AddressInfo).port));
});
report("a daemon-shaped listener is up", daemonPort > 0, `127.0.0.1:${daemonPort}`);

/* ------------------------------------------------------------------ *
 * A signed identity, and capabilities bound to a device
 * ------------------------------------------------------------------ */

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const identity = {
  machineId: "m_e2ee",
  issuer: "reemoat-cp",
  keys: [{ kid: "k_webcheck", jwk: publicKeyToJwk(publicKey) }],
};
const verifier = new SignedTokenVerifier({ identity });

const machineKey = generateStaticKey();
const device = generateStaticKey();
const stranger = generateStaticKey();

function capability(jkt: string, lifetimeSeconds = 300): string {
  const iat = Math.floor(Date.now() / 1000);
  const claims: TokenClaims = {
    iss: "reemoat-cp",
    sub: "u_1",
    aud: "m_e2ee",
    jti: `t_${String(iat)}_${String(Math.round(lifetimeSeconds))}`,
    iat,
    nbf: iat,
    exp: iat + lifetimeSeconds,
    scp: ["session:read", "session:write"],
    cnf: { jkt },
  };
  return signToken(claims, "k_webcheck", privateKey);
}

const deviceThumbprint = jwkThumbprint(x25519Jwk(device.publicKey));
const strangerThumbprint = jwkThumbprint(x25519Jwk(stranger.publicKey));

/* ------------------------------------------------------------------ *
 * A relay that carries bytes and is watched doing it
 * ------------------------------------------------------------------ */

/** Everything that crossed the relay, in both directions. */
let carried: Uint8Array[] = [];
/**
 * Whether {@link carried} is being filled.
 *
 * ⚠ **Off for the one section that moves more than this process should hold.**
 * The download-ceiling assertion pushes a hundred megabytes past the relay, in
 * both directions, and recording it would keep a fifth of a gigabyte of
 * ciphertext alive for the rest of the run to prove nothing that the sections
 * above have not already proved about far smaller payloads. It is switched back
 * on immediately afterwards, because the sections below it — *two devices, two
 * sessions, nothing shared* in particular — assert over `carried` and would pass
 * trivially against an empty list.
 *
 * ⚠ **That last sentence is an assertion now rather than only a warning.** It
 * described the hazard exactly and nothing held it: `frames.length - new
 * Set(frames).size === 0` is `0 - 0 === 0` over an empty list, so leaving this
 * `false` — or clearing `carried` from a section inserted above — bought a green
 * tick about a wire nobody had looked at. That section opens with
 * `report("the wire really was recorded", …)` for that reason.
 */
let recording = true;
/**
 * Ciphertext the app has handed the relay, in bytes.
 *
 * Counted rather than kept, so it costs nothing where {@link recording} is off and
 * retains nothing anywhere.
 *
 * ⚠ **A precondition, never the assertion.** It is the thing that tells an
 * upload which *stopped* apart from one that never started, which is the state a
 * naive "the client went quiet" check passes in. It cannot hold a cancellation
 * itself: `close()` closes the WebSocket and `raw()` drops on `closed` before it
 * touches it, so no byte can cross after a cancel whatever the body loop above it
 * does — an assertion that the wire went quiet is green with the fix reverted.
 */
let appToRelayBytes = 0;
/** How many channels were opened, which is how a pool is observed. */
let channelsOpened = 0;
/**
 * And how many were closed, which is the only way a *disposed* one is observed.
 *
 * The app's own `onclose` says the socket ended; this says the connection
 * underneath it did. `MachineChannel.dispose` is supposed to give up the socket
 * connection too — the one that is never pooled and sits quiet for hours — and a
 * client that only nulled its handlers would satisfy the first and not this.
 */
let channelsClosed = 0;
/** Flip to corrupt one byte of the next frame heading for the app. */
let tamperNext = false;

const relay = createServer();
const relaySockets = new WebSocketServer({ noServer: true });

relay.on("upgrade", (req, socket, head) => {
  socket.on("error", () => socket.destroy());
  const url = new URL(req.url ?? "/", "http://relay");
  if (url.pathname !== RELAY_CHANNEL_PATH) {
    socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  // Authorization, to the extent this section needs it: the real one is
  // `relaycheck`'s, and what matters here is that a channel carries a credential
  // at all — the app puts it in the query because a browser cannot set a header.
  if (url.searchParams.get("token") === null) {
    socket.write("HTTP/1.1 401 missing_token\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }

  relaySockets.handleUpgrade(req, socket, head, (ws) => {
    channelsOpened += 1;
    const fromApp = new Duplex({
      read() {},
      write(chunk: Buffer, _encoding, done) {
        if (recording) carried.push(new Uint8Array(chunk));
        // Unconditional, unlike the recording above it: this is the far side of a
        // real WebSocket hop, and it is the only thing that can say an upload was
        // ever under way. See {@link appToRelayBytes}.
        appToRelayBytes += chunk.length;
        toDaemon.push(chunk);
        done();
      },
    });
    const toDaemon = new Duplex({
      read() {},
      write(chunk: Buffer, _encoding, done) {
        if (recording) carried.push(new Uint8Array(chunk));
        const out = new Uint8Array(chunk);
        if (tamperNext) {
          tamperNext = false;
          out[out.length - 1] = (out[out.length - 1]! ^ 0x01) & 0xff;
        }
        fromApp.push(out);
        done();
      },
    });

    const carrier = createWebSocketStream(ws);
    carrier.pipe(fromApp);
    fromApp.pipe(carrier);

    serveSecureSession({
      stream: toDaemon,
      staticKey: localStaticKey(machineKey.secretKey),
      verifier,
      local: { host: "127.0.0.1", port: daemonPort },
    });

    const shut = (): void => {
      carrier.destroy();
      fromApp.destroy();
      toDaemon.destroy();
    };
    ws.on("close", () => {
      channelsClosed += 1;
      shut();
    });
    carrier.on("error", shut);
  });
});

const relayPort = await new Promise<number>((resolve) => {
  relay.listen(0, "127.0.0.1", () => resolve((relay.address() as AddressInfo).port));
});
const relayUrl = `http://127.0.0.1:${String(relayPort)}`;
report("a relay that only moves bytes is up", relayPort > 0, relayUrl);

/* ------------------------------------------------------------------ *
 * Opening one
 * ------------------------------------------------------------------ */

function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

let registrations = 0;
let mints = 0;

function channelFor(
  options: {
    key?: Uint8Array;
    secret?: Uint8Array;
    jkt?: string;
    lifetimeSeconds?: number;
    onWrongDevice?: () => Promise<void>;
  } = {},
): MachineChannel {
  const secret = options.secret ?? device.secretKey;
  return new MachineChannel({
    relayUrl,
    machineKey: toBase64Url(options.key ?? machineKey.publicKey),
    credential: async () => {
      mints += 1;
      const seconds = options.lifetimeSeconds ?? 300;
      return {
        token: capability(options.jkt ?? deviceThumbprint, seconds),
        expiresAt: Date.now() + seconds * 1_000,
      };
    },
    onWrongDevice:
      options.onWrongDevice ??
      (async () => {
        registrations += 1;
      }),
    deviceKey: () => localStaticKey(secret),
  });
}

const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

{
  const channel = channelFor();
  const answer = await channel.request({ method: "GET", path: SECRET_PATH, timeoutMs: 5_000 });
  check("an ordinary request is answered through the channel", answer.status, 200);
  check("with the daemon's own body", JSON.parse(text(answer.body)), { diff: SECRET_BODY });
  check("and the daemon saw the path the app asked for", daemonSaw.at(-1)?.path, SECRET_PATH);

  /*
   * ⚠ **The claim the whole phase exists for, asserted from the client's side.**
   *
   * Everything above crossed a relay that recorded every byte. None of it is
   * readable there: not the answer, not the request line, not the capability. A
   * relay that was compromised outright — the operator, the host, the TLS
   * terminator — holds this and nothing more.
   */
  const wire = Buffer.concat(carried.map((one) => Buffer.from(one))).toString("latin1");
  report("the relay carried bytes at all", wire.length > 200, `${String(wire.length)} bytes`);
  check("and the daemon's answer is not in them", wire.includes(SECRET_BODY), false);
  check("nor the path that was asked for", wire.includes("s_confidential"), false);
  check("nor the capability that opened it", wire.includes("eyJ"), false);

  /*
   * The credential the daemon's own listener saw, which is the other half: the
   * app sent it once, at the handshake, and `src/e2ee.ts` pinned it onto the
   * request. That is what retires `?token=` on the last hop.
   */
  report(
    "the daemon's listener was given the capability as a header",
    (daemonSaw.at(-1)?.auth ?? "").startsWith("Bearer ey"),
    daemonSaw.at(-1)?.auth === undefined ? "no authorization header" : "Bearer …",
  );

  channel.dispose();
}

/* ------------------------------------------------------------------ *
 * The shapes a re-serialising layer would round off
 * ------------------------------------------------------------------ */

{
  const channel = channelFor();
  const missing = await channel.request({ method: "GET", path: "/nope", timeoutMs: 5_000 });
  check("a bare 404 survives the round trip as itself", [missing.status, text(missing.body)], [404, "404 Not Found"]);
  check("and it is not wrapped in an error envelope", text(missing.body).startsWith("{"), false);

  const bytes = await channel.request({ method: "GET", path: "/bytes", timeoutMs: 10_000 });
  check("a body larger than one Noise message arrives whole", bytes.body.length, 200_000);
  const intact = bytes.body.every((byte, at) => byte === at % 251);
  report("and every byte of it is the one the daemon wrote", intact, "200000 bytes, chunked and reassembled");
  check("with the daemon's own content-length beside it", bytes.headers["content-length"], "200000");

  channel.dispose();
}

/* ------------------------------------------------------------------ *
 * A body going the other way, with progress somebody can watch
 * ------------------------------------------------------------------ */

{
  const channel = channelFor();
  const seen: number[] = [];
  const payload = new Uint8Array(180_000);
  const answer = await channel.request({
    method: "POST",
    path: "/echo",
    body: payload,
    onProgress: (fraction) => seen.push(fraction),
    timeoutMs: 10_000,
  });
  check("a request body arrives whole", JSON.parse(text(answer.body)), { bytes: 180_000 });
  report("progress was reported more than once", seen.length > 1, `${String(seen.length)} reports`);
  check("it never exceeds one", seen.filter((one) => one > 1), []);
  check("and it ends at one", seen.at(-1), 1);
  /*
   * ⚠ **This is what retires `XMLHttpRequest` on the relay arm.** `fetch` reports
   * no upload progress and a `ReadableStream` body is Chromium-only, which is why
   * `sendWithProgress` exists at all — and over a channel the bytes are handed to
   * a socket one chunk at a time, so the fraction is the loop rather than a
   * number invented beside it.
   */
  report("progress is monotonic", seen.every((one, at) => at === 0 || one >= seen[at - 1]!), seen.length + " reports");

  channel.dispose();
}

/* ------------------------------------------------------------------ *
 * A caller that changes its mind, and how long that takes
 * ------------------------------------------------------------------ */

{
  /*
   * ⚠ **The assertion is the *clock*, not the rejection.** `abort` used to be
   * `connection.close()` alone, which nulls the handlers and closes the socket
   * and deliberately does **not** call `Connection.fail` — so nothing rejected
   * and the request settled only when the timeout it was racing fired. A check
   * that merely awaited the rejection would have been green against that, after
   * a wait: the budget on an upload is `uploadDeadlines(file.size).hardMs`,
   * minutes for a large file, during which removing a chip looked like it did
   * nothing at all. So the timeout here is deliberately enormous and the
   * measurement is how much of it was spent.
   *
   * `/hang` is a route that never answers, which is the only way to be sure the
   * settlement came from the abort rather than from the daemon getting there
   * first.
   */
  const channel = channelFor();
  const controller = new AbortController();
  const startedAt = Date.now();
  const pending = channel.request({
    method: "GET",
    path: "/hang",
    timeoutMs: 120_000,
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 50);
  let cancelled: { name: string; message: string } | null = null;
  try {
    await pending;
  } catch (error) {
    cancelled = { name: (error as Error).name, message: (error as Error).message };
  }
  const spent = Date.now() - startedAt;
  report("a cancelled request rejects rather than hanging", cancelled !== null, cancelled?.message ?? "it resolved");
  /*
   * Two seconds against a two-minute budget: wide enough that a slow machine
   * never earns a red build, and narrow enough that the failure this exists for
   * — settling on the timeout instead — cannot fit inside it.
   */
  report("and it does so promptly rather than on the request's own timeout", spent < 2_000, `${String(spent)}ms of 120000`);
  /*
   * ⚠ **`AbortError`, because two transports answering one cancel with two
   * different shapes is a difference waiting to be depended on.** The `fetch`/
   * `XHR` arm of `machine.ts` rejects a cancelled upload with a `DOMException`
   * named this, and `upload`'s own `if (signal.aborted) throw error` hands
   * whatever it caught straight to the caller.
   */
  check("named as the cancellation it is", cancelled?.name, "AbortError");

  /*
   * And the window `acquire()` opens: a signal that fired *before* the listener
   * was added never calls it, and the `await` above it is a dial and a
   * handshake. Without the explicit re-check a cancel that landed during those
   * would be a cancel nobody ever hears — the same symptom through a different
   * door.
   */
  const already = new AbortController();
  already.abort();
  const secondStartedAt = Date.now();
  let refused = "";
  try {
    await channel.request({ method: "GET", path: "/hang", timeoutMs: 120_000, signal: already.signal });
  } catch (error) {
    refused = (error as Error).name;
  }
  check("a signal that had already fired is honoured too", refused, "AbortError");
  report(
    "and just as promptly",
    Date.now() - secondStartedAt < 2_000,
    `${String(Date.now() - secondStartedAt)}ms of 120000`,
  );

  channel.dispose();
}

/* ------------------------------------------------------------------ *
 * What a cancel stops, on the producing side
 * ------------------------------------------------------------------ */

{
  /*
   * ⚠ **The section above is about the caller's promise; this one is about the
   * loop still running behind it.**
   *
   * `MachineChannel.request`'s abort and its timeout both call
   * `connection.close()`, and `close()` deliberately does not become `fail` — its
   * own docblock says so, because `fail` is the *verdict* and a cancel is not one.
   * `failure` was the body loop's only exit, so a cancelled upload went on
   * iterating; `drain()` returns immediately once the connection is closed, so it
   * ran flat out, sealing every remaining 65518-byte chunk with ChaCha20-Poly1305 and
   * walking `onProgress` all the way to 1 on a transfer the person had already
   * cancelled. On the phone this client is shaped around that is the rest of the
   * file encrypted for nothing, with the bar filling up to say so.
   *
   * ⚠ **`onProgress` is the only honest observable here, and the obvious
   * alternative is vacuous.** `raw()` already opens with `if (this.closed) return`,
   * and `close()` has already closed the WebSocket — so not one byte can cross the
   * relay after a cancel whatever the loop above does. A check that counted frames
   * and found the wire had gone quiet is green with the fix reverted — a seventh
   * entry on this repository's list of assertions that could not fail — so it is
   * deliberately not written. {@link appToRelayBytes} is for the opposite
   * direction: saying the upload had started at all.
   *
   * The cancel is fired from *inside* `onProgress`, which makes this deterministic
   * rather than a race with a timer: `abort()` runs its listener synchronously, so
   * the close lands between two iterations rather than at whatever chunk a clock
   * happened to catch.
   */
  const CHUNKS = 16;
  const CANCEL_AFTER = 3;
  /*
   * `BODY_CHUNK_BYTES` **is** `MAX_FRAME_PAYLOAD`, read here from the module that
   * owns it rather than written down a second time. That is what makes the exact
   * counts below legible — sixteen chunks, sixteen reports — and if the client ever
   * chunks a body at some other size, these counts are the thing that says so.
   */
  const payload = new Uint8Array(MAX_FRAME_PAYLOAD * CHUNKS);

  {
    /*
     * The positive control, and it is the half that makes the cancelled run mean
     * anything: an upload that stopped because it was cancelled and an upload that
     * never started both report no progress at all. If the fixture ever stops
     * producing progress, this block goes red first and names the reason.
     */
    const channel = channelFor();
    const echoes = daemonSaw.filter((one) => one.path === "/echo").length;
    const seen: number[] = [];
    const answer = await channel.request({
      method: "POST",
      path: "/echo",
      body: payload,
      onProgress: (fraction) => seen.push(fraction),
      timeoutMs: 60_000,
    });
    check("an upload nobody cancels arrives whole", JSON.parse(text(answer.body)), { bytes: payload.length });
    check("with one progress report per chunk", seen.length, CHUNKS);
    check("and the last of them is one", seen.at(-1), 1);
    check("and the daemon was asked exactly once", daemonSaw.filter((one) => one.path === "/echo").length - echoes, 1);
    channel.dispose();
  }

  {
    const channel = channelFor();
    const echoes = daemonSaw.filter((one) => one.path === "/echo").length;
    const crossedBefore = appToRelayBytes;
    const controller = new AbortController();
    const seen: number[] = [];
    let cancelled = "";
    try {
      await channel.request({
        method: "POST",
        path: "/echo",
        body: payload,
        onProgress: (fraction) => {
          seen.push(fraction);
          if (seen.length === CANCEL_AFTER) controller.abort();
        },
        // Enormous, for the reason the section above this one gives: the one thing
        // that must never be what settles this is the request's own timeout.
        timeoutMs: 120_000,
        signal: controller.signal,
      });
    } catch (error) {
      cancelled = (error as Error).name;
    }
    /*
     * ⚠ **A beat, deliberately, and the assertion below is worth very little
     * without it.** The rejection reaches this `catch` a few microtasks after the
     * abort, while a loop with no `closed` exit is still sweeping the remaining
     * thirteen chunks — every iteration of it a microtask, since `drain()` returns
     * an already-resolved promise once the connection is closed. Reading `seen`
     * straight out of the catch would therefore catch the regression mid-sweep and
     * could count almost anything. `sleep` is a `setTimeout`, so the whole
     * microtask queue has drained by the time it returns and a reverted loop has
     * finished reporting all sixteen.
     */
    await sleep(100);
    check("a cancelled upload rejects as the cancellation it is", cancelled, "AbortError");
    /*
     * ⭐ **The one this whole section exists for.** Revert
     * `if (this.closed) return await answer;` in `Connection.request`'s body loop
     * and `failure` is its only exit again — which a cancel never sets — so all
     * sixteen iterations run and this reads sixteen against three.
     */
    check("⭐ and the loop behind it stops where the cancel landed", seen.length, CANCEL_AFTER);
    /*
     * The same revert, named as the symptom somebody actually sees: the sixteenth
     * report is `Math.min(1, …)` over the whole body, so the bar fills to the end on
     * a transfer that was cancelled a fifth of the way in. Written as a filter
     * rather than as `seen.at(-1) < 1` so the comparison stays an array of exact
     * values and never a float ordering.
     */
    check("so the bar never reaches one", seen.filter((one) => one >= 1), []);
    /*
     * And the preconditions, both measured on the far side of a real loopback hop
     * rather than beside the object under test: the relay counted the bytes and the
     * daemon's own listener saw the request. Without these, "it stopped" is also
     * what a client that buffered the whole body, or never sent any of it, would
     * report — the state in which three progress reports would be green for the
     * wrong reason. A wait loop rather than a fixed sleep, so a slow machine costs
     * latency instead of a red build.
     */
    const echoed = (): number => daemonSaw.filter((one) => one.path === "/echo").length - echoes;
    for (let at = 0; at < 200 && (appToRelayBytes - crossedBefore <= MAX_FRAME_PAYLOAD || echoed() === 0); at += 1) {
      await sleep(10);
    }
    report(
      "the cancelled upload really was under way",
      appToRelayBytes - crossedBefore > MAX_FRAME_PAYLOAD,
      `${String(appToRelayBytes - crossedBefore)} bytes crossed the relay`,
    );
    check("and the daemon really had the request", echoed(), 1);
    channel.dispose();
  }
}

/* ------------------------------------------------------------------ *
 * An answer larger than this client will hold
 * ------------------------------------------------------------------ */

{
  /*
   * ⚠ **The ceiling is enforced while the frames arrive, because by the time
   * `machine.ts` can look the memory is already spent.**
   *
   * That module's `MAX_DOWNLOAD_BYTES` check reads `content-length`, and over
   * `fetch` it ran *before* `response.blob()` — an oversized file was refused
   * rather than made resident, which was the whole point of it. Over a channel
   * the same check runs after `request` has returned, so every byte has been
   * accumulated, copied again into the contiguous array `RESPONSE_END` builds,
   * and copied a third time into a `Blob`. The route serves any regular file
   * under the workspace, which includes the 2 GiB binary the agent just built,
   * so on a phone the symptom of not having this is the tab dying rather than a
   * refusal anybody can read.
   *
   * `/flood` sends no `content-length`, so this is also the case the declared
   * length cannot see — which is why the bound is checked against what actually
   * arrived.
   *
   * ⚠ **And the message, not merely the rejection.** A connection that simply
   * died would satisfy "it threw"; what has to be true is that the client said
   * what it refused, in a sentence, and that it is a plain `Error` rather than a
   * {@link ChannelRefused} — this is not the daemon refusing anything, and
   * `http.ts`'s `isTransportFailure` has to keep treating it as weather.
   */
  recording = false;
  const channel = channelFor();
  let refused = "";
  let reason: unknown;
  try {
    await channel.request({ method: "GET", path: "/flood", timeoutMs: 120_000 });
  } catch (error) {
    refused = error instanceof Error ? error.message : String(error);
    reason = (error as { reason?: string }).reason;
  }
  check(
    "an answer past the ceiling fails the connection with a legible sentence",
    refused,
    "the answer to this request is larger than this client will hold",
  );
  check("and not as a refusal the daemon made", reason, undefined);
  channel.dispose();
  recording = true;
  carried = [];
}

/* ------------------------------------------------------------------ *
 * Reaching the wrong machine, and being told
 * ------------------------------------------------------------------ */

{
  /*
   * ⚠ **The machine's authentication, and there is no comparison to read.**
   * `IK`'s second message is sealed under a key mixed from `ee` and `se`, so only
   * something holding the private half of the static this handshake started with
   * can produce one. Starting with somebody else's key therefore cannot complete
   * — which is what stops a relay routing an app to a machine of its choosing.
   */
  const wrong = generateStaticKey();
  const dialled = channelsOpened;
  const channel = channelFor({ key: wrong.publicKey });
  let refused = "";
  try {
    await channel.request({ method: "GET", path: "/health", timeoutMs: 6_000 });
  } catch (error) {
    refused = error instanceof Error ? error.message : String(error);
  }
  report("a channel to the wrong machine key never comes up", refused !== "", refused || "it came up");
  /*
   * ⚠ **And it failed the *handshake*, rather than never reaching one.** The report
   * above is satisfied by any non-empty message, which includes every local throw
   * `dial()` can raise before a socket exists — an unusable machine key, no device
   * key, a relay URL `new URL` will not take. Those are real refusals, and they are
   * not this property: each of them would leave "the machine's authentication"
   * green while no `Noise_IK` was ever run at all. The relay's own counter is on
   * the far side of a real WebSocket hop and says a channel was opened and did not
   * come up. Exactly one, because `connect()` rethrows anything that is not a
   * `wrong_device` refusal without dialling a second time.
   */
  check("having dialled and failed the handshake rather than refusing locally", channelsOpened - dialled, 1);
  check("and nothing reached the daemon's listener", daemonSaw.filter((one) => one.path === "/health").length, 0);
  channel.dispose();
}

/* ------------------------------------------------------------------ *
 * A capability minted for another device
 * ------------------------------------------------------------------ */

{
  /*
   * The handshake succeeds — this really is the right machine, and the caller
   * really does hold *a* device key. What fails is the binding: the capability
   * names somebody else's key, so it is worth nothing here. That is the whole of
   * "a stolen capability is useless off the device it was minted for", driven
   * from the side that would do the stealing.
   */
  const channel = channelFor({ jkt: strangerThumbprint });
  let reason = "";
  try {
    await channel.request({ method: "GET", path: "/health", timeoutMs: 6_000 });
  } catch (error) {
    reason = (error as { reason?: string }).reason ?? (error as Error).message;
  }
  check("a capability minted for another device is refused at the handshake", reason, "wrong_device");
  channel.dispose();
}

/* ------------------------------------------------------------------ *
 * The one refusal this client can fix by itself
 * ------------------------------------------------------------------ */

{
  /*
   * ⚠ **The re-keyed installation, and the bug this closes.**
   *
   * A credential store reset out from under the app leaves the shell holding a
   * key the Authority has never been told about — and minting *succeeds*, because
   * the Authority has a key on file and nothing to compare it against. So
   * `device_key_required` never fires and the disagreement is invisible until the
   * daemon sees it, which it can only do over an encrypted channel. Before this,
   * that installation simply stopped being able to reach anything remote with
   * nothing saying why.
   *
   * Now: the daemon answers `wrong_device`, the channel re-registers the same
   * device id — which writes the key in place, spending no device slot — mints
   * again, and retries. Once.
   */
  registrations = 0;
  let named = strangerThumbprint;
  const channel = new MachineChannel({
    relayUrl,
    machineKey: toBase64Url(machineKey.publicKey),
    credential: async () => ({ token: capability(named), expiresAt: Date.now() + 300_000 }),
    onWrongDevice: async () => {
      registrations += 1;
      named = deviceThumbprint;
    },
    deviceKey: () => localStaticKey(device.secretKey),
  });

  const answer = await channel.request({ method: "GET", path: "/health", timeoutMs: 6_000 });
  check("a re-keyed installation recovers on its own", answer.status, 200);
  check("having re-registered exactly once", registrations, 1);
  channel.dispose();
}

{
  // And the guard: a re-registration that does not take must surface as the
  // refusal it is rather than as a loop against the Authority.
  registrations = 0;
  const channel = channelFor({
    jkt: strangerThumbprint,
    onWrongDevice: async () => {
      registrations += 1;
    },
  });
  let reason = "";
  try {
    await channel.request({ method: "GET", path: "/health", timeoutMs: 6_000 });
  } catch (error) {
    reason = (error as { reason?: string }).reason ?? (error as Error).message;
  }
  check("a recovery that does not take is reported rather than retried", [reason, registrations], ["wrong_device", 1]);
  channel.dispose();
}

/* ------------------------------------------------------------------ *
 * The pool
 * ------------------------------------------------------------------ */

{
  channelsOpened = 0;
  const channel = channelFor();
  await channel.request({ method: "GET", path: "/health", timeoutMs: 5_000 });
  await channel.request({ method: "GET", path: "/health", timeoutMs: 5_000 });
  await channel.request({ method: "GET", path: "/health", timeoutMs: 5_000 });
  check("three requests share one connection", channelsOpened, 1);
  channel.dispose();
}

{
  /*
   * ⚠ **An idle connection past its capability's life is not handed out again.**
   *
   * The capability presented at `HELLO` is the one `src/e2ee.ts` pins onto every
   * request the connection will ever carry, so reusing it past `exp` buys a
   * guaranteed 401 rather than a fresh handshake. This is *not* a second timer
   * against Q5.24 — nothing here tears a live connection down; it decides only
   * what the pool hands back.
   */
  channelsOpened = 0;
  // Inside `REUSE_MARGIN_MS` from the moment it is minted, so the connection is
  // stale the instant it is idle.
  const channel = channelFor({ lifetimeSeconds: 20 });
  await channel.request({ method: "GET", path: "/health", timeoutMs: 5_000 });
  await channel.request({ method: "GET", path: "/health", timeoutMs: 5_000 });
  check("a connection near its capability's expiry is replaced instead", channelsOpened, 2);
  channel.dispose();
}

/* ------------------------------------------------------------------ *
 * One byte changed in flight
 * ------------------------------------------------------------------ */

{
  /*
   * A relay that alters what it carries. There is no resynchronise and there must
   * not be: a `CipherState` whose nonce has diverged fails every later frame, so
   * "skip it and carry on" is a session that never works again while appearing to
   * try. The honest answer is that the channel ends.
   */
  const channel = channelFor();
  await channel.request({ method: "GET", path: "/health", timeoutMs: 5_000 });
  tamperNext = true;
  let failed = "";
  try {
    await channel.request({ method: "GET", path: SECRET_PATH, timeoutMs: 5_000 });
  } catch (error) {
    failed = error instanceof Error ? error.message : String(error);
  }
  /*
   * ⚠ **The message, not its non-emptiness.**
   *
   * This was `failed !== ""`, which the `timeoutMs` race above satisfies on its own.
   * So the regression this block exists for — a bad tag skipped instead of ending
   * the channel, which the paragraph above calls "a session that never works again
   * while appearing to try" — produced a hang, then a timeout, then a green check.
   * The two failures are the two things that must not read alike, so the assertion
   * has to name which one happened.
   */
  check("a frame altered in flight ends the channel", failed, "a frame on this channel could not be authenticated");
  check("and it is not reported as a refusal the daemon made", (failed as string).includes("refused"), false);
  check("nor as the timeout that used to satisfy this check", (failed as string).includes("timed out"), false);
  tamperNext = false;
  channel.dispose();
}

/* ------------------------------------------------------------------ *
 * A live socket over a channel
 * ------------------------------------------------------------------ */

/**
 * One socket message built so that a character falls across a frame boundary.
 *
 * ⚠ **This is the half of reassembly that a length check cannot catch.** Frames
 * are cut at a **byte** count, so a chunk boundary can land in the middle of a
 * multi-byte UTF-8 sequence — and a receiver that decodes each chunk on arrival
 * puts a U+FFFD where the character was and hands the reducer JSON it silently
 * drops. A fixture made only of ASCII is byte-identical either way, so it is
 * green over exactly the implementation this exists to refuse.
 *
 * The prefix is all one-byte characters, so a character offset is a byte offset,
 * and the `é` is placed to begin at `MAX_FRAME_PAYLOAD - 1`: its first byte is
 * the last byte of frame one and its second byte is the first of frame two. The
 * position is asserted below rather than trusted, because a fixture that stopped
 * straddling would make the whole section pass by not exercising anything.
 */
const STRADDLE_HEAD = '{"type":"events","straddle":"';
const BIG_MESSAGE = `${STRADDLE_HEAD}${"a".repeat(MAX_FRAME_PAYLOAD - 1 - STRADDLE_HEAD.length)}é","tail":"${"z".repeat(40_000)}"}`;

const sockets = new WebSocketServer({ server: daemon, path: "/stream" });
/*
 * Three behaviours on one path, selected by the query.
 *
 * `ws`'s `path` option matches the pathname alone, so one server answers all of
 * them — and one server is what the assertions about the *credential* and the
 * *query* one section down are written against. The two extra modes exist
 * because the ordinary one closes itself after 60ms, which is right for the
 * close-code assertion and is a race against anything else.
 */
sockets.on("connection", (ws, req) => {
  const path = req.url ?? "/stream";
  daemonSaw.push({ method: "GET", path, auth: req.headers.authorization });
  // One message too large for a frame, and then nothing: the section that asks
  // for this closes the socket itself, having counted what arrived.
  if (path.includes("big=1")) {
    ws.send(BIG_MESSAGE);
    return;
  }
  // A socket the daemon never ends, which is the state a live event stream
  // spends hours in and the only state in which disposing can be observed.
  if (path.includes("quiet=1")) {
    ws.send(JSON.stringify({ type: "hello", instanceId: "i_e2ee" }));
    return;
  }
  ws.send(JSON.stringify({ type: "hello", instanceId: "i_e2ee" }));
  ws.send(JSON.stringify({ type: "events", events: [{ seq: 1 }] }));
  // The daemon's own close code, which `stream.ts`'s table is the client's entire
  // model of. 4401 is "your token died"; it must arrive as itself.
  setTimeout(() => ws.close(4401, "token_expired"), 60);
});

{
  const channel = channelFor();
  const socket: StreamSocket = channel.openSocket("/stream?since=7");
  const frames: string[] = [];
  let closed: { code: number; reason: string } | null = null;
  socket.onmessage = (event): void => {
    frames.push(String((event as MessageEvent).data));
  };
  socket.onclose = (event): void => {
    closed = { code: event.code, reason: event.reason };
  };

  for (let at = 0; at < 200 && closed === null; at += 1) await sleep(10);

  check("a socket over a channel delivers the daemon's frames", frames.length, 2);
  check("as strings, which is what the transcript reducer requires", typeof frames[0], "string");
  check("in order", frames.map((one) => (JSON.parse(one) as { type: string }).type), ["hello", "events"]);
  /*
   * ⚠ **The close code arrives whole.** `stream.ts` reads 4401 as "re-mint and
   * rotate", 4404 as "give up" and 4003 as "back off" — so a channel that
   * defaulted or rewrote a code would silently change what the app does about it,
   * in a way no type would catch.
   */
  check("and the daemon's own close code survives the channel", closed, { code: 4401, reason: "token_expired" });
  check("the socket's query reached the daemon", daemonSaw.at(-1)?.path, "/stream?since=7");
  report(
    "and its credential was a header rather than a query parameter",
    (daemonSaw.at(-1)?.auth ?? "").startsWith("Bearer ey") && !(daemonSaw.at(-1)?.path ?? "").includes("token="),
    daemonSaw.at(-1)?.path ?? "(none)",
  );
  channel.dispose();
}

/* ------------------------------------------------------------------ *
 * One socket message, however many frames it took
 * ------------------------------------------------------------------ */

{
  /*
   * ⚠ **The stall that was permanent, silent, and only above 65518 bytes.**
   *
   * A `MESSAGE` frame is a *chunk*. The daemon sends an event batch as one
   * WebSocket message of up to `BATCH_MAX_BYTES` (512 KiB) and a control snapshot
   * measured around 93 KB — both far over what one frame holds — so a client that
   * raised each frame as its own `MessageEvent` handed `stream.ts` eight, or two,
   * pieces of JSON each cut mid-token. That reducer drops what it cannot parse
   * **and leaves the cursor where it was**, so the next reconnect asked for the
   * same batch, split it the same way and dropped it again: a transcript that
   * never moves, with nothing logged, on large sessions only, and only away from
   * loopback.
   *
   * So the assertion is a count first — *one* event, not two — and the parse
   * second.
   */
  const bytes = new TextEncoder().encode(BIG_MESSAGE);
  report(
    "the fixture is larger than one frame can carry",
    bytes.length > MAX_FRAME_PAYLOAD,
    `${String(bytes.length)} bytes against ${String(MAX_FRAME_PAYLOAD)}`,
  );
  /*
   * ⚠ **And it really does straddle**, which nothing else here can tell. The
   * first byte at or above 0x80 is the first byte of the `é`; if it sits anywhere
   * but immediately before the boundary, this section is a test of ASCII
   * concatenation wearing a UTF-8 label.
   */
  check(
    "with a multi-byte character beginning in the last byte of the first frame",
    bytes.findIndex((byte) => byte >= 0x80),
    MAX_FRAME_PAYLOAD - 1,
  );

  const channel = channelFor();
  const socket: StreamSocket = channel.openSocket("/stream?big=1");
  const frames: string[] = [];
  socket.onmessage = (event): void => {
    frames.push(String((event as MessageEvent).data));
  };
  for (let at = 0; at < 300 && frames.length === 0; at += 1) await sleep(10);
  // A beat past the first arrival, so a second `MessageEvent` — which is exactly
  // the regression — has somewhere to show up rather than being missed by a loop
  // that stopped at one.
  await sleep(120);

  check("a message larger than a frame arrives as one message", frames.length, 1);
  let parsed: { straddle?: string; tail?: string } | null = null;
  try {
    parsed = JSON.parse(frames[0] ?? "null") as { straddle?: string; tail?: string };
  } catch {
    // Left null, which the assertion below names. A throw here would end the
    // driver on the one failure it is built to report.
  }
  report("and it parses as the JSON the daemon sent", parsed !== null, frames[0]?.slice(0, 40) ?? "(nothing arrived)");
  /*
   * ⚠ **The replacement character, asserted by its absence over the whole
   * string.** Decoding per frame turns the straddling `é` into `�` and
   * leaves every other character alone — so the message still parses, still has
   * the right shape, and is wrong in one position. Nothing but this notices.
   */
  check("with the character that straddled the boundary intact", parsed?.straddle?.endsWith("é"), true);
  check("and no replacement character anywhere in it", (frames[0] ?? "").includes("�"), false);
  check("and the bytes after the boundary are the ones that followed it", parsed?.tail?.length, 40_000);

  socket.close();
  channel.dispose();
}

/* ------------------------------------------------------------------ *
 * Disposing gives up the connection that is not in the pool
 * ------------------------------------------------------------------ */

{
  /*
   * ⚠ **`idle` is not the set of open connections and never was**, which made
   * `dispose` a lie in three docblocks at once: `acquire` pops a connection off
   * `idle` before handing it out, and `openSocket` never puts one there at all.
   * So the connection that matters most — the **live event stream**, which by
   * design takes a connection of its own and keeps it for hours — was tracked
   * nowhere. `machine.ts` disposes where it drops the route belief or rebuilds on
   * a new machine key or relay, and its comment says disposing *"removes the
   * whole question"*; without this the event stream kept running over the stale
   * key and the stale relay, answering to nothing.
   *
   * Silent by construction: the one connection whose survival cannot be noticed
   * is the one that is *supposed* to sit quiet for minutes. Hence `quiet=1` — a
   * socket the daemon never ends — and hence two assertions, because either half
   * alone can be satisfied by the wrong thing. The app's `onclose` says the
   * socket ended; the relay's counter says the connection underneath it did, and
   * a client that only nulled its handlers would pass the first.
   */
  const closedBefore = channelsClosed;
  const channel = channelFor();
  const socket: StreamSocket = channel.openSocket("/stream?quiet=1");
  const frames: string[] = [];
  let closed: { code: number; reason: string } | null = null;
  socket.onmessage = (event): void => {
    frames.push(String((event as MessageEvent).data));
  };
  socket.onclose = (event): void => {
    closed = { code: event.code, reason: event.reason };
  };

  for (let at = 0; at < 300 && frames.length === 0; at += 1) await sleep(10);
  check("a socket the daemon holds open is delivering", frames.length, 1);
  check("and nothing has closed it", closed, null);

  channel.dispose();
  for (let at = 0; at < 300 && closed === null; at += 1) await sleep(10);
  /*
   * A `1006` with the channel's own words, which is what `stream.ts` already does
   * the right thing with: back off, reconnect, and come back through `machine.ts`
   * onto whatever key and relay are current by then. Asserted as the whole event
   * rather than as the code alone, because the code is shared with a socket that
   * merely dropped and the reason is what says this was deliberate.
   */
  check("⭐ disposing the channel ends the live socket", closed, { code: 1006, reason: "the channel was closed" });

  for (let at = 0; at < 300 && channelsClosed === closedBefore; at += 1) await sleep(10);
  report(
    "and the connection under it is gone from the relay too",
    channelsClosed > closedBefore,
    `${String(channelsClosed - closedBefore)} channel(s) closed`,
  );
}

/* ------------------------------------------------------------------ *
 * Two devices, two sessions, nothing shared
 * ------------------------------------------------------------------ */

{
  /*
   * The multi-device requirement, stated as a property of the keys rather than of
   * the screens: two installations reach the same daemon at the same time and
   * derive independent session keys. There is no fleet-wide or user-wide
   * symmetric key for either of them to be a copy of.
   */
  carried = [];
  const second = generateStaticKey();
  const secondThumbprint = jwkThumbprint(x25519Jwk(second.publicKey));
  const one = channelFor();
  const two = channelFor({ secret: second.secretKey, jkt: secondThumbprint });

  const answers = await Promise.all([
    one.request({ method: "GET", path: "/health", timeoutMs: 6_000 }),
    two.request({ method: "GET", path: "/health", timeoutMs: 6_000 }),
  ]);
  check("two devices reach the same daemon at once", answers.map((a) => a.status), [200, 200]);
  check(
    "and both see the same instance",
    answers.map((a) => (JSON.parse(text(a.body)) as { instanceId: string }).instanceId),
    ["i_e2ee", "i_e2ee"],
  );
  /*
   * Ciphertext for the same plaintext, under two independent sessions. Any shared
   * key — fleet-wide, user-wide, or a handshake that reused an ephemeral — shows
   * up here as a repeated frame.
   */
  const frames = carried.map((one) => Buffer.from(one).toString("base64"));
  /*
   * ⚠ **The recording itself, asserted rather than assumed.** The check below is
   * `0 - 0 === 0` over an empty list — the hazard {@link recording}'s own docblock
   * names and that nothing held. `recording` left off by a section inserted above,
   * or `carried` cleared between here and the two requests, and "no frame appears
   * twice" is a green tick about a wire nobody looked at. Two handshakes and two
   * request/response pairs are a dozen frames or so; the floor is deliberately far
   * below that, so it can fire only on an empty or near-empty list.
   */
  report("the wire really was recorded", frames.length > 4, `${String(frames.length)} frames`);
  check("with no frame appearing twice on the wire", frames.length - new Set(frames).size, 0);

  one.dispose();
  two.dispose();
}

/* ------------------------------------------------------------------ *
 * The two literals that have to agree
 * ------------------------------------------------------------------ */

{
  /*
   * ⚠ **A client dialling a path the relay does not serve is a fleet where no
   * machine is reachable.** The constant cannot be shared — the relay may import
   * exactly five files from the repository root and carries no `@reemoat/protocol`
   * in its image, and this package may import neither `src/` nor the control
   * plane — so it is two literals and this is the only thing in the tree that
   * compares them. `relaycheck` does not: it imports `RELAY_CHANNEL_PATH` from
   * the listener and never opens `packages/web/src/e2ee.ts`, so it is blind to
   * the app's half. Deleting this block leaves the pair uncompared.
   */
  const listener = readFileSync(new URL("../../control-plane/src/relay/listener.ts", import.meta.url), "utf8");
  /*
   * ⚠ **Anchored at the start of a line, because this is a regex over raw source.**
   * A copy of the declaration quoted inside a docblock reads ` * export const …`,
   * so the anchor is what keeps this reading the code rather than the prose beside
   * it — which is a failure this repository has already shipped once, a pattern
   * that matched the docblock four lines above the code it was written for. No `$`
   * terminator, so a CRLF checkout cannot break it.
   */
  const declared = /^export const RELAY_CHANNEL_PATH = "([^"]+)";/m.exec(listener)?.[1] ?? null;
  report("the relay declares a channel path at all", declared !== null, String(declared));
  check("and the app dials exactly that path", RELAY_CHANNEL_PATH, declared);
}

/* ------------------------------------------------------------------ *
 * Bodies this transport will and will not carry
 * ------------------------------------------------------------------ */

{
  check("a string body becomes its UTF-8 bytes", Array.from((await bodyBytes("hi")) ?? []), [104, 105]);
  check("nothing becomes nothing", await bodyBytes(null), null);
  check("and undefined too", await bodyBytes(undefined), null);
  check(
    "a Blob is read whole",
    Array.from((await bodyBytes(new Blob([new Uint8Array([7, 8, 9])]))) ?? []),
    [7, 8, 9],
  );
  /*
   * ⚠ **A refusal rather than a conversion.** `FormData` and a streaming body
   * reach no call site in this client — every one passes a string or a `Blob` —
   * and quietly serialising one of them would be a guess about a wire format
   * nobody had chosen. A throw is the answer that gets noticed.
   */
  let refused = "";
  try {
    await bodyBytes(new URLSearchParams({ a: "b" }));
  } catch (error) {
    refused = (error as Error).message;
  }
  /*
   * ⚠ **The message, not its non-emptiness.** This was `refused !== ""`, which any
   * throw at all satisfies — including the `body.arrayBuffer is not a function`
   * that a reordered `instanceof` chain raises on the way into the `Blob` arm,
   * which is a bug wearing this check's pass. Same repair as the tamper block's,
   * on this file's other `x !== ""`.
   */
  check(
    "a body shape nothing sends is refused rather than guessed at",
    refused,
    "this body cannot be sent over an encrypted channel",
  );
}

/* ------------------------------------------------------------------ *
 * The half of the cancellation that nothing can observe
 * ------------------------------------------------------------------ */

/**
 * Source with its comments taken out, which is what every assertion over source in
 * this repository owes.
 *
 * ⚠ **Not a formality in this one case.** The guard the section below is about
 * carries a docblock four lines above it that names both halves of the pattern —
 * `closed`, `encrypt`, and the order they have to go in — in prose. So a regex over
 * raw source can match the paragraph and pass over code that stopped holding, which
 * is a failure this repository has already shipped: a pattern matched against raw
 * source that hit the docblock four lines above the code.
 *
 * Line comments are stripped per line rather than across the file, so nothing a
 * `//` opens can swallow the statement on the line beneath it.
 */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, "").trim())
    .filter((line) => line !== "")
    .join("\n");
}

{
  /*
   * ⚠ **A source assertion, and the only honest kind available for this one.**
   *
   * *What a cancel stops, on the producing side* holds the **loop** half of the
   * cancellation fix, on `onProgress`, which is an observable that really moves.
   * This is the other half — `Connection.write` returning on `closed` **before** it
   * reaches `this.send.encrypt(...)` — and it has no behavioural observable at all.
   * `raw()` already drops on `closed`, and by the time anything is closed the
   * WebSocket is closed too, so whether the frame was sealed on the way to being
   * thrown away changes nothing anybody outside the object can count. What it
   * changes is that a cancelled upload does not run ChaCha20-Poly1305 over the rest
   * of a file on a phone.
   *
   * It is held separately rather than folded into the loop's assertion for
   * `e2ee.md`'s own reason: **two defences under one assertion is either redundancy
   * or two properties sharing a name, and only knocking them out one at a time says
   * which.** The loop guard is the one that fires on a cancelled upload; this one
   * is what catches a `write` racing a close from anywhere else — the `HELLO` in
   * `finishHandshake`, the `OPEN` in `adopt`.
   */
  const source = readFileSync(new URL("../src/e2ee.ts", import.meta.url), "utf8");
  const HEAD = "private write(frame: Uint8Array): void {";
  const opens = source.indexOf(HEAD);
  const ends = source.indexOf("\n  }", opens);
  /*
   * Said out loud, because this driver reads a file it does not own: a method that
   * has been renamed or reflowed fails here with its own sentence, rather than
   * leaving the assertion below to fail as though a guard had been deleted.
   */
  report(
    "`Connection.write` is still where it was",
    opens > 0 && ends > opens,
    opens > 0 ? HEAD : "no method with that signature",
  );
  const body = withoutComments(opens > 0 && ends > opens ? source.slice(opens + HEAD.length, ends) : "");
  /*
   * The ordering, stated as one predicate: the guard is present **and** it comes
   * before the seal. Both mutations that would put the bug back — deleting the
   * guard, and moving it below the `encrypt` — fail this, and the two controls
   * underneath run each of them rather than arguing about them.
   */
  const guardsTheSeal = (text: string): boolean => {
    const guard = text.indexOf("if (this.closed) return;");
    const seal = text.indexOf(".encrypt(");
    return guard !== -1 && seal > guard;
  };
  report("it drops a frame before it seals one", guardsTheSeal(body), body.split("\n")[0] ?? "(an empty method body)");
  /*
   * ⚠ **The negative controls, executed rather than reasoned about.** An assertion
   * whose failure is the whole point needs proof that its predicate can fail, and
   * "the guard is there" and "this check cannot tell the difference" read exactly
   * alike in a green run. These two put the same predicate over the same body with
   * the guard deleted, and with it moved below the seal, and require a `false` from
   * each. Loosen the pattern into something a mutated body also satisfies and they
   * are what goes red.
   */
  const deleted = body.replace("if (this.closed) return;", "").trim();
  const moved = `${deleted}\nif (this.closed) return;`;
  report("and the check can tell when the guard is gone", !guardsTheSeal(deleted), "the predicate fails with it removed");
  report("or when it has moved below the seal", !guardsTheSeal(moved), "the predicate fails with it reordered");
}

sockets.close();
relay.close();
daemon.close();
relaySockets.close();
daemonSaw = [];
