import type { IncomingMessage, ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import type { Duplex } from "node:stream";
import { WebSocketServer, createWebSocketStream } from "ws";
import { corsHeaders } from "../../../../src/cors.js";
import { MAX_TUNNEL_MESSAGE_BYTES, STREAM_ENCRYPTION_NOISE_IK } from "../../../../src/relay/protocol.js";
import { bearerToken } from "../../../../src/http.js";
import { createRelayAuthorizer } from "./authorize.js";
import type { TunnelRegistry } from "./registry.js";

/**
 * The browser-facing half of the relay.
 *
 * Every request is authorized, then forwarded down the tunnel belonging to the
 * machine named by the token's `aud`. Both steps are here and in that order:
 * **nothing reaches a tunnel before the grant check passes.**
 *
 * The forwarding itself is deliberately dull. A CONNECT stream is a byte pipe, so
 * `http.request({createConnection: () => stream})` lets Node serialize the
 * request, decide chunked-versus-content-length, and raise `upgrade` for a 101 —
 * all the HTTP/1.1 detail we would otherwise be hand-writing and getting subtly
 * wrong. Verified against a real daemon-shaped server for both an ordinary
 * request and a WebSocket upgrade.
 *
 * The daemon re-verifies the caller's token when the request arrives, because the
 * request arrives at its real listener carrying the caller's real credentials.
 * The check here is additive; the relay is never trusted to have done it.
 */

export interface RelayProxyOptions {
  db: DatabaseSync;
  issuer: string;
  registry: TunnelRegistry;
  onEvent?: (event: string, detail: string) => void;
  /**
   * How long a daemon may take to answer a channel's `CONNECT`.
   *
   * A seam rather than a constant only, for the reason `SmtpDialer` and
   * `AgentProcess` are seams: a driver that had to spend the real number to see
   * the behaviour would not assert it at all.
   *
   * ⚠ **This used to be `upstreamTimeoutMs`, the bound on how long a daemon could
   * hold a proxied *request*.** There are no proxied requests any more, and the
   * bound did not disappear — it moved to `src/e2ee.ts`, one hop closer to what it
   * bounds, on the side of the encryption that can see a request at all. What is
   * left here is the bound on *reachability*, which is the only thing this process
   * can still measure. See {@link CHANNEL_OPEN_TIMEOUT_MS}.
   */
  channelTimeoutMs?: number;
}

export interface RelayProxy {
  handleRequest(req: IncomingMessage, res: ServerResponse): void;
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void;
  /**
   * An encrypted channel: authorize, open a stream, splice, understand nothing.
   *
   * Named apart from {@link handleUpgrade} because it is not the same act. That
   * one *proxies* — it serializes a request with Node's HTTP client and copies a
   * 101 back — and this one only carries bytes. Merging them would put a parse on
   * the path of the thing whose whole purpose is that nothing here parses it.
   */
  handleChannel(req: IncomingMessage, socket: Duplex, head: Buffer): void;
}

/*
 * ⚠ **`UPSTREAM_IDLE_TIMEOUT_MS` moved rather than vanished.**
 *
 * It was 120 s here: the "nobody is ever coming back" bound on a daemon that took
 * a stream and then said nothing. That bound still exists and is still 120 s — it
 * lives in `src/e2ee.ts` now, on the side of the encryption that can see a request
 * at all, three feet from the listener that produces the answer. So does the
 * `response.complete` check it was paired with, which is Q6.103's truncation
 * discipline and is why `RESPONSE_END` and `FAILED` are different frames.
 *
 * What is left in this process is the bound below, which is about *reachability*
 * rather than about work.
 */

/**
 * How long a daemon may take to answer a channel's `CONNECT` with its `200`.
 *
 * ⚠ **The WebSocket handshake is deliberately completed *after* this answer**,
 * which is what this bound exists to make finite. A daemon that has not learned
 * the encrypted mode refuses the stream with `501`, and a daemon that is wedged
 * answers nothing at all — and the browser's `WebSocket` API surfaces neither a
 * status nor a body, only "it closed". Waiting for the daemon first turns both
 * into an HTTP refusal on the upgrade, which is at least legible in this relay's
 * own log, and it means a channel that opens has a daemon behind it rather than
 * merely a tunnel.
 *
 * Short, because nothing behind it is work: the daemon answers this before it has
 * read a byte of the handshake, so the only thing being waited on is one h2
 * round trip down a socket that is already up. {@link UPSTREAM_IDLE_TIMEOUT_MS}
 * is the bound on *work*; this one is the bound on *reachability*.
 */
const CHANNEL_OPEN_TIMEOUT_MS = 10_000;

/**
 * How much a channel may have queued toward the app before this relay gives up.
 *
 * `createWebSocketStream` gives real backpressure — `pipe` stops reading from the
 * h2 stream while `ws.send`'s callback is outstanding, and the h2 window then
 * stops being granted, which is the same chain that carries "the phone stopped
 * reading" all the way back to the daemon today. This is the valve *behind* that,
 * for the case the chain cannot cover: a socket that is neither draining nor
 * erroring, which is what a dead phone on a live TCP connection looks like.
 *
 * Equal to `MAX_TUNNEL_BUFFERED_BYTES` for the tunnel, and should be just as
 * unreachable.
 */
const MAX_CHANNEL_BUFFERED_BYTES = 8 * 1024 * 1024;

export function createRelayProxy(options: RelayProxyOptions): RelayProxy {
  const { db, registry } = options;
  const onEvent = options.onEvent ?? ((): void => {});
  const channelTimeoutMs = options.channelTimeoutMs ?? CHANNEL_OPEN_TIMEOUT_MS;
  const authorizer = createRelayAuthorizer(db, options.issuer);
  /*
   * The channel's WebSocket server, and it exists only to do the handshake.
   *
   * `noServer` because the listener already decided which path this is, and the
   * refusal paths need the raw socket rather than a `WebSocket`. Nothing is ever
   * read off the resulting connection as a *message*: `createWebSocketStream`
   * collapses it straight back into bytes, because message boundaries are the
   * app's business and this process is not in it.
   */
  const channels = new WebSocketServer({ noServer: true, maxPayload: MAX_TUNNEL_MESSAGE_BYTES });

  return {
    /**
     * Anything that is not a channel.
     *
     * ⚠ **This used to be the whole of the relay and it is now a refusal**, which
     * is the single largest thing Phase 5 changed about this process. It
     * authorized a request, serialized it onto a `CONNECT` stream with Node's own
     * HTTP client, and copied the answer back — so every prompt, diff, file and
     * line of terminal output in the fleet passed through this function as
     * plaintext. `SECURITY.md` said so in as many words: *"It is written to route
     * and never to parse, but that is a discipline in the code rather than a
     * property of the protocol."* It is a property of the protocol now, and the
     * way it was made one is that the code which could parse is gone.
     *
     * The refusal is deliberately **not** authorized first. There is nothing to
     * authorize *for*: no credential makes this path work, so checking one would
     * only tell a caller whether their token was good for a service that no
     * longer exists. It opens no stream and touches `requestsProxied` for the same
     * reason a preflight never did.
     *
     * `426` rather than `404`, matching `TUNNEL_PATH`'s own answer to a
     * non-upgrade request: the endpoint is real, and what is wrong is the shape of
     * the connection being asked for.
     */
    handleRequest(req, res) {
      onEvent("proxy_retired", `${req.method ?? "?"} ${pathOf(req)}`);
      sendJson(res, 426, {
        error: {
          code: "upgrade_required",
          message:
            "this relay carries encrypted channels only: open a WebSocket to /__relay/channel. " +
            "A plaintext request cannot be proxied to a daemon any more, by design — the relay " +
            "is not able to read what it carries",
          detail: null,
        },
      });
    },

    /**
     * A WebSocket upgrade that is not a channel.
     *
     * The same refusal in the shape this path can answer in, and it is reachable
     * only for a path the listener did not recognise — `/__relay/tunnel` goes to
     * the endpoint and `/__relay/channel` goes below. What used to arrive here was
     * a browser opening `/sessions/:id/stream`, which is now a frame inside a
     * channel rather than a connection of its own.
     */
    handleUpgrade(req, socket, _head) {
      socket.on("error", () => socket.destroy());
      onEvent("proxy_retired", `upgrade ${pathOf(req)}`);
      refuseUpgrade(socket, 426, "upgrade_required");
    },

    /**
     * An encrypted channel between one app and one machine.
     *
     * ⚠ **This is the path on which the relay stops being trusted with anything.**
     * Everything above forwards a *request* — it reads a method, a path and every
     * header, and it could read a body. This reads a token, decides whether the
     * caller holds a grant, and then moves bytes between two sockets. The Noise
     * handshake, the capability and every request inside run between the app and
     * the daemon; this process holds no key material for them and could not
     * decrypt a byte if it were compromised outright. That is the whole of what
     * Phase 5 buys, and it is bought *here*.
     *
     * Authorization is unchanged and still happens first: the same `authorize`,
     * the same live user / machine / grant rows, the same refusals. A relay that
     * cannot read the traffic is not a relay that lets anybody through — those are
     * different properties and both are wanted.
     */
    handleChannel(req, socket, head) {
      // First, for `handleUpgrade`'s reason: Node has already removed its own
      // `socketOnError`, and every refusal below writes to this socket.
      socket.on("error", () => socket.destroy());

      const auth = authorizer.authorize(readToken(req));
      if (!auth.ok) {
        onEvent("channel_refused", `${auth.code} ${pathOf(req)}`);
        return refuseUpgrade(socket, auth.status, auth.code);
      }

      const tunnel = registry.get(auth.machineId);
      if (tunnel === null) {
        onEvent("channel_no_tunnel", auth.machineId);
        return refuseUpgrade(socket, 503, "no_tunnel");
      }

      /*
       * The mode is named here and nowhere else in this process.
       *
       * `open` used to write `none` itself, which made the carrier the party that
       * chose. It is a parameter now precisely so that this — the one call site
       * that wants encryption — is the thing that says so, and so that a future
       * mode is a new value at a call site rather than an edit to the registry.
       */
      const stream = tunnel.open(auth.subject, STREAM_ENCRYPTION_NOISE_IK);
      if (stream === null) {
        onEvent("channel_no_tunnel", `${auth.machineId} (stream limit)`);
        return refuseUpgrade(socket, 503, "no_tunnel");
      }

      /*
       * Wait for the daemon's `200` before completing the WebSocket handshake.
       *
       * The ordering is the point. A daemon too old to know this mode answers
       * `501` on the stream, and a browser that has already upgraded would see
       * that as an opaque close with nothing to say — indistinguishable from a
       * network drop, and therefore retried for ever. Answering the *upgrade*
       * with a status instead keeps the distinction in this relay's log, and
       * leaves the app's own refusal — "that machine has not announced a key" —
       * the thing a person actually reads, decided before a socket is dialled.
       */
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        stream.destroy();
        onEvent("channel_timeout", auth.machineId);
        refuseUpgrade(socket, 504, "tunnel_timeout");
      }, channelTimeoutMs);
      // Not `unref`: this relay is a long-lived process and the timer is cleared
      // on every exit from this function. `unref` here would only hide a leak.
      const settle = (): boolean => {
        if (settled) return false;
        settled = true;
        clearTimeout(timer);
        return true;
      };

      stream.once("error", () => {
        if (!settle()) return socket.destroy();
        onEvent("channel_failed", auth.machineId);
        refuseUpgrade(socket, 502, "tunnel_failed");
      });

      stream.once("response", (headers) => {
        if (!settle()) return;
        const status = Number(headers[":status"] ?? 0);
        if (status !== 200) {
          /*
           * The daemon refused the mode. It is running, it dialled in, and it
           * cannot speak this — which on a fleet mid-update is an ordinary state
           * and not an error, so it is reported as its own event rather than
           * folded into `channel_failed`.
           */
          stream.destroy();
          onEvent("channel_unsupported", `${auth.machineId} answered ${String(status)}`);
          return refuseUpgrade(socket, 501, "encryption_unsupported");
        }

        channels.handleUpgrade(req, socket, head, (ws) => {
          const carrier = createWebSocketStream(ws);

          /*
           * The valve. See {@link MAX_CHANNEL_BUFFERED_BYTES} — this is behind the
           * backpressure rather than instead of it, and reaching it means the
           * chain did not work, which is a reason to end the connection rather
           * than to grow.
           */
          const valve = setInterval(() => {
            if (ws.bufferedAmount > MAX_CHANNEL_BUFFERED_BYTES) {
              onEvent("channel_backpressure", `${auth.machineId} ${String(ws.bufferedAmount)} bytes`);
              ws.terminate();
            }
          }, 1_000);
          valve.unref();

          const done = (): void => {
            clearInterval(valve);
            carrier.destroy();
            stream.destroy();
          };

          /*
           * Both directions, and nothing between them. There is no place in these
           * two lines to read a request line, strip a header or notice a body,
           * which is the property the whole phase rests on.
           */
          carrier.pipe(stream);
          stream.pipe(carrier);

          carrier.on("error", done);
          stream.on("error", done);
          stream.on("close", done);
          ws.on("close", done);
          onEvent("channel_open", auth.machineId);
        });
      });
    },
  };
}

/**
 * A request's path, with the query string dropped — safe to log.
 *
 * Never log `req.url` on either path. A browser cannot set headers on a
 * WebSocket, so the credential arrives as `?token=<JWS>`; interpolating the raw
 * URL into a log line writes a live bearer token to stderr, and from there to
 * journald or whatever ships the container's logs.
 *
 * The tokens on the refusal paths are the *worst* ones to leak, not the most
 * harmless. `no_scopes`, `machine_not_found` (a deleted grant or a revoked
 * machine), `user_disabled` and `machine_over_limit` all refuse tokens that are
 * cryptographically intact and unexpired — and the daemon never asks this service
 * anything, so such a token is still accepted on the direct path for the rest of
 * its lifetime. A revocation that stops working at the relay is precisely when
 * the token in the log becomes a working credential for whoever can read the log.
 * The fourth is the *most* reversible of them and therefore the likeliest to be
 * refused in bulk while somebody is watching the logs to find out why.
 *
 * `auth.code` says why it was refused, and `authorize` already returns `tokenId`
 * and `subject` for anyone who needs to identify the caller. None of those are
 * credentials.
 */
function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? "/", "http://relay").pathname;
  } catch {
    // An unparseable request target. There is nothing safe to quote from it, and
    // quoting it raw is the one thing this function exists to prevent.
    return "(unparseable)";
  }
}

/**
 * The caller's token: `Authorization: Bearer`, else `?token=`.
 *
 * The same rule as the daemon's `readCredential`, and it matters that it is the
 * same: a *present* header is authoritative even when malformed, rather than
 * falling through to the query parameter. Falling through means a client sending
 * `authorization: bearer x` — lowercase, which some send — silently takes a
 * different code path from the one it thinks it is on.
 */
function readToken(req: IncomingMessage): string | null {
  // `=== null` and not falsiness: `bearerToken` answers `""` for a present but
  // malformed header, and that must be refused rather than fall through to the
  // query — the same rule as the daemon's `readCredential`, and it matters that
  // it is the same, which is now true by construction rather than by copy.
  const fromHeader = bearerToken(req.headers.authorization);
  if (fromHeader !== null) return fromHeader;
  try {
    return new URL(req.url ?? "/", "http://relay").searchParams.get("token");
  } catch {
    /*
     * An unparseable request target, guarded for the same reason `pathOf` is —
     * and this is the copy that mattered, because this one runs *first*.
     *
     * llhttp and the WHATWG URL parser do not agree about what a request target
     * is. Measured: `GET //% HTTP/1.1` is accepted by Node's HTTP parser and
     * handed over as `req.url` verbatim, and `new URL("//%", "http://relay")`
     * throws `Invalid URL` (so do `/\` and `//[`). Unguarded, that throw escaped
     * the `'request'`/`'upgrade'` emit *before* `authorize`, so no credential was
     * needed to reach it: `main.ts`'s `uncaughtException` backstop kept the
     * process alive, and nothing wrote a response or destroyed the socket —
     * `requestTimeout` was already cleared and `keepAliveTimeout` only arms once
     * a response is sent. One unauthenticated line per leaked socket, against the
     * only ingress this system has, until the fd limit stops every daemon
     * dialling in and every browser reaching any machine.
     *
     * `null` rather than a throw puts it on the existing refusal path as
     * `401 missing_token`, which is the honest answer: there is no readable
     * credential here. `pathOf` logs `(unparseable)` beside it.
     */
    return null;
  }
}

/*
 * ⚠ **`forwardHeaders` and `stripHopByHop` are gone, and so is the only thing
 * that ever needed them.**
 *
 * They were the relay's rule about what may cross a hop: drop `connection`,
 * `transfer-encoding` and the rest; drop any client-supplied copy of a
 * `reemoat-*` header so `reemoat-sub` could not be forged; append this hop to
 * `x-forwarded-for`. Every one of those existed because this process assembled a
 * request. It does not assemble one any more.
 *
 * Q5.10's invariant — *"the relay's own metadata never enters the proxied
 * request"* — is not weakened by their removal; it is made unfalsifiable. There
 * is no proxied request to enter. `reemoat-*` headers still ride the `CONNECT`
 * handshake and still stop at the daemon's tunnel code, and a client cannot put
 * one anywhere at all, because a client's bytes are ciphertext this process
 * cannot open let alone edit.
 *
 * The `x-forwarded-for` append is the one thing genuinely given up, and it cost
 * nothing: nothing under `src/` reads it. The Authority's throttle reads its own,
 * on its own listener, and is untouched.
 */

/**
 * The relay's own answers — refusals, `no_tunnel`, `tunnel_failed`.
 *
 * These carry CORS headers because they are the relay speaking, not the daemon:
 * nothing proxied ever reaches this function, and a response the browser cannot
 * read is one the client cannot distinguish from a network failure. That
 * distinction is the whole point of these codes — "this machine is asleep"
 * (`no_tunnel`) and "your token died" (`token_expired`) call for completely
 * different behaviour, and a client that sees neither will guess wrong.
 *
 * Proxied responses are untouched: they arrive with the daemon's own CORS headers
 * and pass through `stripHopByHop`, which is not in this path.
 */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    ...corsHeaders(),
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

/** No WebSocket exists yet, so the refusal is a status line on the raw socket. */
function refuseUpgrade(socket: Duplex, status: number, code: string): void {
  try {
    socket.write(`HTTP/1.1 ${status} ${code}\r\nConnection: close\r\n\r\n`);
  } catch {
    // Peer already gone.
  }
  socket.destroy();
}
