import { request as httpRequest, type ClientRequest, type IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket } from "ws";
import {
  FRAME,
  LengthReader,
  MAX_FRAME_PAYLOAD,
  MessageAssembler,
  NoiseHandshake,
  decodeFrame,
  decodeJson,
  encodeFrame,
  encodeJsonFrame,
  encodeMessageFrames,
  frameLength,
  tryEncodeJsonFrame,
  type CipherState,
  type CloseFrame,
  type OpenFrame,
  type RequestFrame,
  type StaticKey,
} from "@reemoat/protocol";
import type { TokenVerifier } from "./auth.js";
import { jwkThumbprint, x25519Jwk } from "./token.js";

/**
 * The daemon's end of an encrypted session with an app.
 *
 * One of these owns one relayed stream. It runs the `Noise_IK` handshake as
 * responder, checks the capability the app presents against the key the handshake
 * authenticated, and then serves that app's requests against this daemon's own
 * loopback listener with Node's own HTTP and WebSocket clients.
 *
 * ⚠ **Nothing in `server.ts`, `session.ts` or `registry.ts` changes for this**,
 * which is the property to defend in review. The bytes that reach the daemon's
 * listener are the bytes Node produced from a real request against a real socket,
 * so the 404 shape six readers depend on, the 409-carrying-a-success-body, gzip,
 * and the whole attach discipline are all untouched — they are on the far side of
 * a loopback connection, exactly as they were when the relay was the one making
 * it.
 *
 * ⚠ **There is no unencrypted path through here and no way to negotiate one.**
 * A stream that cannot complete the handshake, or presents a capability this
 * daemon will not accept, is destroyed. The refusal is a closed stream rather than
 * a message, because below a failed handshake there is no key to send a message
 * under — an asymmetry worth naming, since every other refusal in this codebase
 * can say why.
 */

/** How long one relayed request may sit without the daemon answering. */
const UPSTREAM_IDLE_TIMEOUT_MS = 120_000;

/** Bodies are chunked to fit one Noise message. */
const BODY_CHUNK_BYTES = MAX_FRAME_PAYLOAD;

/**
 * How long a refusal is given to reach the app before the session is torn down.
 *
 * Short, because the only thing being waited on is one small frame already handed
 * to the stream. It exists so a peer that has stopped reading cannot hold an
 * upstream connection open by never acknowledging the goodbye.
 */
const FAIL_FLUSH_TIMEOUT_MS = 2_000;

/**
 * An RFC 9110 token: what Node requires of a method and of a header name.
 *
 * ⚠ **Checked here because `http.request` answers with a *throw*, and the throw
 * lands where nothing catches it.** Measured on this runtime: a method of
 * `"G ET"` raises `ERR_INVALID_HTTP_TOKEN`, a header named `"bad name"` raises
 * the same, and a header value carrying CRLF raises `ERR_INVALID_CHAR` — all
 * three from values the *app* chose, in a call that used to sit outside any
 * `try`. The frame loop is `async`, so such a throw became an unhandled
 * rejection: the session wedged rather than refusing, and the app waited out its
 * whole timeout against a daemon that had already stopped reading.
 *
 * The regex is a refusal in this file's own words; the `try` around the call is
 * the backstop for the next check Node adds. Both, because either alone is one
 * runtime change away from being the whole defence.
 */
const HTTP_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/**
 * What Node will let into a header value — `checkInvalidHeaderChar`'s own set.
 *
 * No CR, no LF, no NUL and no other control character, which is the request
 * smuggling case: a value with a CRLF in it is two headers, or a header and a
 * body, on the far side of a serializer that was never asked.
 */
const HTTP_FIELD_VALUE = /^[\t\u0020-\u007e\u0080-\u00ff]*$/;

/**
 * The two header names the app may not write, because they describe the
 * **message** rather than the request.
 *
 * ⚠ **`HTTP_FIELD_VALUE` closes CRLF-in-a-value and this closes the other door
 * into the same room.** Measured on this runtime (node 26.3.0): a `REQUEST` frame
 * carrying `{"content-length":"0"}` with `body: true`, followed by one
 * `REQUEST_BODY` frame holding a whole second request, makes Node serialize the
 * head with `content-length: 0` and then write those bytes onto the loopback
 * socket unchanged — it validates the *characters* in a header value and never
 * compares a declared length against what was actually written. The daemon's own
 * listener then parses what follows the empty body as a **pipelined request** and
 * serves it: a second request on any route, with a method, a path and an
 * `Authorization` header the app chose. That is the smuggling case this file
 * already refuses one spelling of, arriving through the body instead of through a
 * value — and it walks straight past the `authorization` skip in
 * {@link SecureSession.startRequest}, which is the rule it defeats rather than a
 * neighbour of it.
 *
 * Measured too, and it is the bound rather than the hole: `http.globalAgent`
 * destroys a socket that answers more than it was asked, so the smuggled response
 * is **not** handed to a later request through the pool. The damage is one
 * unattributed request against this daemon, not cross-session response poisoning.
 * It is refused anyway, because *"the credential on every inner request is the one
 * this session authenticated"* is either true or it is not.
 *
 * **Refused rather than dropped.** Nothing in `packages/web` has ever written
 * either name — a body travels as frames and Node derives both headers from what
 * is actually sent — so a frame carrying one is not a client this end has, and a
 * silent drop would answer it with a request subtly different from the one it
 * asked for. `transfer-encoding` rides along for the same reason pointed the other
 * way: declaring it hands Node a framing it did not choose, and TE-beside-CL is
 * the pair every desync opens with.
 *
 * This is the narrow form of the allowlist `packages/native/src-tauri/src/proxy.rs`
 * can afford. `FORWARDED` there is two names because that proxy serves the four
 * call sites in `cp.ts`; this one carries the whole daemon API, so it cannot
 * enumerate what may pass and names what may not instead.
 */
const FRAMING_HEADERS = new Set(["content-length", "transfer-encoding"]);

/** `ws` throws a `RangeError` above this: a close reason rides in a control frame. */
const MAX_CLOSE_REASON_BYTES = 123;

/**
 * Whether `ws` will take this as a close code rather than throw.
 *
 * ⚠ **Measured on ws 8.21.3, and the throw is peer-reachable.** `WebSocket.close`
 * validates through `Sender.close`, which answers
 * `TypeError("First argument must be a valid error code number")` for anything
 * outside its table — so a `CLOSE` frame carrying `{"code":1005}` or
 * `{"code":9999}` is a throw out of the frame loop from a number the app wrote.
 * 1004, 1005 and 1006 are refused there because they are codes a receiver
 * *reports* locally and nobody sends, and so are 2999 and 5000.
 *
 * **Deliberately one code narrower than ws accepts**: 1014 passes there today and
 * stops here. That is the safe direction to be wrong in — a code this refuses and
 * ws would have taken costs one refusal, while a code this accepts and ws refuses
 * is the crash back again — so this tracks the registered range rather than one
 * library's table, and a future ws that narrowed to match the specification would
 * not take this file with it.
 */
function isCloseCode(code: unknown): code is number {
  if (typeof code !== "number" || !Number.isInteger(code)) return false;
  if (code >= 3000 && code <= 4999) return true;
  return code >= 1000 && code <= 1013 && code !== 1004 && code !== 1005 && code !== 1006;
}

export type SecureEventKind = "handshake_failed" | "refused" | "crypto_failure" | "opened" | "closed";

export interface SecureSessionOptions {
  /** The relayed stream, already answered `200`. Opaque bytes in both directions. */
  stream: Duplex;
  /** This machine's static. Its private half never leaves this process. */
  staticKey: StaticKey;
  /** Whatever decides what a capability entitles the caller to. */
  verifier: TokenVerifier;
  /** Where this daemon's own HTTP server is listening. */
  local: { host: string; port: number };
  /**
   * How long this daemon may hold a request of its own without answering — **and
   * how long a dial may sit without the socket opening.**
   *
   * One option for both, because they are the same question asked of the two
   * things this session makes on the app's behalf, and a second field would be a
   * bound no existing caller could set: `src/relay/tunnel.ts` passes this one
   * through and nothing passes anything else. See {@link SecureSession.openSocket}
   * for what the dial half covers and what it deliberately leaves unbounded.
   *
   * ⚠ **The seam moved with the bound.** It was `upstreamTimeoutMs` on the relay's
   * proxy, and its docblock gave the reason it was a seam rather than a constant:
   * *"the behaviour is a two-minute wait, and a driver that had to spend two
   * minutes to see it would not assert it at all."* That is still true and the
   * bound is still 120 s — what changed is which process owns it, so the seam
   * follows it here rather than being dropped and the case with it.
   */
  upstreamTimeoutMs?: number;
  onEvent?: (kind: SecureEventKind, detail: string) => void;
}

/**
 * Serve one encrypted session. Returns immediately; the session lives on the
 * stream's own events.
 */
export function serveSecureSession(options: SecureSessionOptions): void {
  new SecureSession(options);
}

class SecureSession {
  private readonly reader = new LengthReader();
  private readonly handshake: NoiseHandshake;
  private send: CipherState | null = null;
  private receive: CipherState | null = null;
  private peerThumbprint: string | null = null;
  /** The capability this session was opened with, once it has been accepted. */
  private capability: string | null = null;
  private authorized = false;
  private closed = false;
  /**
   * Refused, but not yet torn down.
   *
   * ⚠ **`fail()` used to guard on `closed`, which `fail()` does not set.** It
   * deliberately leaves the session open for {@link FAIL_FLUSH_TIMEOUT_MS} so the
   * `FAILED` frame flushes, and `consume`'s per-message guard reads `closed` too —
   * so every frame already pulled out of the same TCP chunk by `LengthReader` was
   * still decrypted and dispatched *after* the refusal, and each further refusal
   * re-entered `fail()`: another write onto an ended stream, another
   * `once("close")` listener and another timer. `consume` and `dispatch` are
   * synchronous past the handshake, so one 64 KiB chunk of minimum-size bad frames
   * registered thousands of each in a single tick and tripped
   * `MaxListenersExceededWarning` — which is a write to stderr originating in
   * `src/`, and CLAUDE.md allows exactly two of those, neither of them here.
   *
   * {@link write} reads it as well, and that is the same flag doing a second job:
   * a refused session owes the peer one `FAILED` frame and nothing else, while
   * the response and the socket it was driving go on emitting for a while yet.
   */
  private failed = false;

  /**
   * What this connection is carrying, and it may only ever carry one thing.
   *
   * ⚠ **The rule is protocol law and this is the end that has to enforce it.**
   * `frames.ts` states it — *"there is no stream id and no multiplexer here, and
   * that is the decision rather than a simplification"* — and the app's
   * `Connection` holds it with a throw before it writes anything. That is the
   * polite end. Here a second `REQUEST` or `OPEN` used to overwrite `upstream`,
   * `socket` and `requestBody`, which **orphans** whatever the first was driving:
   * `destroy()` can no longer reach it, so a peer that sends `OPEN` twice leaves a
   * loopback socket alive with nothing holding it, and two answers interleave on
   * one wire with nothing to tell them apart. A rule only the honest end keeps is
   * not a rule, and this is the trust boundary.
   *
   * Back to `"none"` when the answer is complete or the socket has closed, because
   * the app's pool hands an idle connection out again — a connection that never
   * cleared this would refuse the second request on every reuse.
   */
  private carrying: "none" | "request" | "socket" = "none";

  /** The loopback response this session is currently reading, if any. */
  private upstream: IncomingMessage | null = null;
  /**
   * The request that will produce it, held from the moment it is made.
   *
   * ⚠ **`upstream` alone was not enough to let go of a request, and neither was
   * letting go of this one the moment the *answer* ended.** Two cases, measured
   * separately on this runtime (node 26.3.0):
   *
   * *The head has not come back* — which is every cancelled request and every one
   * that timed out. `upstream` is assigned inside the `"response"` listener, so
   * there was nothing for `destroy()` to reach, and the loopback socket stayed
   * open until `UPSTREAM_IDLE_TIMEOUT_MS` fired two minutes after the app had
   * stopped waiting. That is the case this field was added for, and it still
   * holds: measured, the timeout callback fires and the socket goes with it.
   *
   * *The head has come back and the request side never ended* — a 404, a 401, a
   * 405 or an early 413 on a `body: true` request, which is this daemon's own
   * listener answering before it reads rather than anything a hostile peer has to
   * do. The 413 is the byte counter's (`src/uploads.ts:647` → `src/server.ts:3426`)
   * and its `quota` sibling (`uploads.ts:651` → `server.ts:3430`), never
   * `server.ts:3384`'s declared-length one — that one reads `content-length`, and
   * {@link FRAMING_HEADERS} makes writing that header a refusal here, so no app on
   * this path can reach it. **Cancelling does not save it either**, which is the
   * half worth measuring rather than assuming: all three of those refusals
   * `cancelBody` the request first, and measured on this runtime (node 26.3.0)
   * that destroys the server's `IncomingMessage` and leaves the *client's* handle
   * exactly as the un-cancelled 404 does — the 413 still arrives, `complete` and
   * all. `response.on("end")` released this field while the `ClientRequest` under
   * it was still writable: measured there, `writableEnded` and `destroyed` are
   * both `false`, the far side of the loopback hop still holds an open socket,
   * and a later write onto it is accepted. **The idle bound does not save this
   * one.** Node clears the request's socket timeout inside `responseOnEnd`, so
   * the callback `setTimeout` installs below never runs once a head has come
   * back — twelve such requests left twelve sockets open twenty times the bound
   * later, with nothing at all coming to collect them. One file descriptor per
   * occurrence, held for as long as the app keeps the session, in the process
   * that owns this machine's live agents. `response.on("end")` **destroys** the
   * request rather than dropping it for exactly that reason.
   *
   * The two halves are separate fields because they are separate objects with
   * separate lifetimes, and letting go of one is not letting go of the other.
   */
  private upstreamRequest: ClientRequest | null = null;
  private socket: WebSocket | null = null;
  /**
   * The socket's inbound reassembly, fresh per socket.
   *
   * `null` means nothing is carrying a socket, which is what makes a `MESSAGE`
   * racing the daemon's own `CLOSE` something to ignore rather than refuse.
   */
  private assembler: MessageAssembler | null = null;
  private requestBody: ((chunk: Uint8Array | null) => void) | null = null;

  /**
   * Everything that touches Noise state, serialized.
   *
   * ⚠ **`consume` is `async` and was being called from a listener with `void`.**
   * It awaits the handshake's DH steps, so a second `"data"` event lands while the
   * first is suspended — and two readers on one `CipherState` advance the nonce
   * out from under each other, which fails as a tag mismatch and looks exactly
   * like an attack. `packages/web/src/e2ee.ts` installs this same promise chain at
   * the other end and writes down that reason; this end had the hazard with the
   * measurement sitting in the mirror file and no fix.
   */
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly options: SecureSessionOptions) {
    this.handshake = NoiseHandshake.start({ initiator: false, staticKey: options.staticKey });

    options.stream.on("data", (chunk: Buffer) => {
      this.queue = this.queue.then(() => this.consume(chunk)).catch(() => {
        // Nothing in `consume` is supposed to reject — every failure inside it is
        // answered with `fail` or `destroy`. This is the backstop that keeps the
        // next one from becoming an unhandled rejection in the process that owns
        // this machine's live agents.
        this.destroy("the frame loop failed");
      });
    });
    options.stream.on("error", () => this.destroy("stream error"));
    options.stream.on("close", () => this.destroy("stream closed"));
  }

  private emit(kind: SecureEventKind, detail: string): void {
    this.options.onEvent?.(kind, detail);
  }

  /**
   * End the session and let go of everything it was driving.
   *
   * ⚠ **`destroy()`, never `end()`, and that was a data-integrity bug rather than
   * a leak.** This used to call `this.requestBody?.(null)`, and what that closure
   * does with `null` is `upstream.end()` — so tearing the session down
   * **submitted** whatever part of the body had arrived to this daemon's own
   * listener as though the app had finished sending it. A cancelled upload became
   * a short upload the daemon then acted on, with the client already gone and
   * nothing left to notice. On a teardown the only honest verb is the one that
   * abandons the request.
   */
  private destroy(detail: string): void {
    if (this.closed) return;
    this.closed = true;
    this.requestBody = null;
    this.carrying = "none";
    this.upstreamRequest?.destroy();
    this.upstreamRequest = null;
    this.upstream?.destroy();
    this.upstream = null;
    this.socket?.terminate();
    this.socket = null;
    this.assembler = null;
    this.options.stream.destroy();
    this.emit("closed", detail);
  }

  /**
   * Seal and write one frame — and **nothing goes out after a refusal but the
   * refusal itself.**
   *
   * ⚠ **The things this session drives do not stop when it is refused.** `fail()`
   * ends the stream and then deliberately holds the session open for
   * {@link FAIL_FLUSH_TIMEOUT_MS} so its one frame flushes; meanwhile a loopback
   * response goes on emitting `"data"`, and a `ws` dial that failed emits
   * `"error"` — which refuses — **and then** `"close"`, whose arm writes a `CLOSE`
   * frame one tick later. Measured on this runtime: a write onto an ended stream
   * does not throw, so {@link sealAndWrite}'s `catch` never sees it. It returns
   * `false` and the stream emits `ERR_STREAM_WRITE_AFTER_END`, which the
   * constructor's own `"error"` handler turns into `destroy()` on the very next
   * tick. Measured end to end on an `OPEN` against a route that is not a socket —
   * the ordinary way to reach this — the session reported `closed: stream error`
   * where it now reports `closed: tunnel_failed`, having torn itself down instead
   * of waiting out the window. That late frame never reached the peer either way
   * (both runs delivered `READY` and `FAILED` and nothing else), so the guard
   * suppresses nothing the far end was going to read; what it buys back is the
   * flush window and the refusal's own reason.
   *
   * `fail()` writes its own frame through {@link sealAndWrite}, which is this
   * without the guard, because it is the one frame a refused session still owes.
   */
  private write(frame: Uint8Array): void {
    if (this.failed) return;
    this.sealAndWrite(frame);
  }

  /** Never throws upward; a write failure ends the session. */
  private sealAndWrite(frame: Uint8Array): void {
    if (this.closed || this.send === null) return;
    try {
      this.options.stream.write(frameLength(this.send.encrypt(new Uint8Array(0), frame)));
    } catch {
      this.destroy("could not write to the stream");
    }
  }

  /**
   * Refuse, and make sure the refusal is actually read.
   *
   * ⚠ **The frame was being written and then thrown away.** `destroy()` ends the
   * stream immediately, and a `write` that has not flushed yet goes with it — so
   * a truncated answer reached the app as a channel that simply stopped, which is
   * a *transport* failure rather than the refusal it is. The difference matters:
   * a transport failure is retried, and a `502 truncated` is not, so the lost
   * frame turned "the daemon gave up on this body" into an endless retry loop.
   * That is Q6.103's defect wearing new clothes — the discipline survived the
   * rewrite and the delivery of it did not.
   *
   * `end()` rather than `destroy()`, so the frame is flushed before the stream
   * closes, with the teardown hung off `close` — which the stream emits either
   * way, including when the peer is already gone.
   */
  private fail(code: number, reason: string): void {
    if (this.closed || this.failed) return;
    this.failed = true;
    // The refusal is about this connection as a whole, so nothing it was carrying
    // may take another byte — see {@link failed} and {@link requestBody}.
    this.requestBody = null;
    // {@link write} refuses once `failed` is set, and this is the frame that
    // exemption exists for.
    this.sealAndWrite(encodeJsonFrame(FRAME.FAILED, { code, reason } satisfies CloseFrame));
    this.options.stream.end();
    this.options.stream.once("close", () => this.destroy(reason));
    // A peer that never reads leaves `close` pending, so the session is not left
    // holding an upstream for ever waiting to be allowed to say goodbye.
    setTimeout(() => this.destroy(reason), FAIL_FLUSH_TIMEOUT_MS).unref();
  }

  private async consume(chunk: Buffer): Promise<void> {
    if (this.closed) return;
    let messages: Uint8Array[];
    try {
      messages = this.reader.push(new Uint8Array(chunk));
    } catch {
      this.destroy("unframeable bytes");
      return;
    }

    for (const message of messages) {
      if (this.closed || this.failed) return;
      if (this.send === null) {
        await this.doHandshake(message);
        continue;
      }
      let frame: Uint8Array;
      try {
        frame = this.receive!.decrypt(new Uint8Array(0), message);
      } catch {
        /*
         * ⚠ **A tag failure destroys the session and sends nothing.**
         *
         * There is no key to answer under that the peer would trust, and the far
         * end cannot distinguish our refusal from an attacker's anyway. Tearing
         * the stream down is the only honest response, and it is what stops one
         * injected frame from desynchronising a session permanently.
         */
        this.emit("crypto_failure", "a frame failed to authenticate");
        this.destroy("bad ciphertext");
        return;
      }
      this.dispatch(frame);
    }
  }

  private async doHandshake(message: Uint8Array): Promise<void> {
    try {
      await this.handshake.readMessage(message);
      const reply = await this.handshake.writeMessage();
      this.options.stream.write(frameLength(reply));
      const transport = this.handshake.split();
      this.send = transport.send;
      this.receive = transport.receive;
      const remote = this.handshake.remoteStaticKey;
      if (remote === null) throw new Error("no peer key");
      this.peerThumbprint = jwkThumbprint(x25519Jwk(remote));
    } catch (error) {
      this.emit("handshake_failed", error instanceof Error ? error.message : String(error));
      this.destroy("handshake failed");
    }
  }

  /**
   * One frame, and **nothing it does may unwind the frame loop.**
   *
   * ⚠ **A throw here discarded every frame behind it, silently.** The loop in
   * `consume` walks the messages `LengthReader` has already pulled out of one TCP
   * chunk, so an exception escaping this call exits that loop with every message
   * behind it already consumed and gone — no `FAILED` frame, no close, nothing on
   * the wire at all. The session wedges and the app waits out its whole timeout
   * against a daemon that has stopped answering, which is strictly worse than the
   * refusal it should have been. Every peer-reachable throw found so far is
   * refused by hand at the frame that carries it — a close code, a close reason, a
   * `send` before the socket is open, a method, a header name, a header value —
   * and this is the backstop for the next one, because every one of those read as
   * obviously fine until it was measured.
   */
  private dispatch(frame: Uint8Array): void {
    try {
      this.handle(frame);
    } catch (error) {
      this.emit("refused", error instanceof Error ? error.message : String(error));
      this.fail(400, "unusable frame");
    }
  }

  private handle(frame: Uint8Array): void {
    const decoded = decodeFrame(frame);
    if (decoded === null) return this.fail(400, "empty frame");

    if (!this.authorized) {
      if (decoded.type !== FRAME.HELLO) return this.fail(401, "the first frame must present a capability");
      const hello = decodeJson<{ capability: string }>(decoded.payload);
      if (hello === null || typeof hello.capability !== "string") return this.fail(400, "unreadable capability");

      /*
       * The capability is checked against **this channel**, so the key the
       * handshake authenticated is what it has to name. A capability copied off
       * another device verifies perfectly and is refused here.
       */
      const verified = this.options.verifier.verify(hello.capability, Date.now(), {
        peerKeyThumbprint: this.peerThumbprint,
      });
      if (!verified.ok) {
        this.emit("refused", verified.code);
        return this.fail(401, verified.code);
      }
      this.authorized = true;
      this.capability = hello.capability;
      this.write(encodeFrame(FRAME.READY));
      this.emit("opened", verified.principal.deviceId ?? verified.principal.subject);
      return;
    }

    switch (decoded.type) {
      case FRAME.REQUEST:
        if (this.carrying !== "none") return this.fail(400, "this connection is already carrying something");
        return this.startRequest(decoded.payload);
      /*
       * ⚠ **These two consult `carrying` like every other arm.** They were the
       * only pair that did not, and `requestBody` outlived the request that made
       * it: `response.on("end")` resets `upstream`, `upstreamRequest` and
       * `carrying` but left the closure installed, and `startRequest`'s no-body
       * branch never set it at all. On a pooled connection that let a peer declare
       * `body: true`, never send `REQUEST_END`, take the answer, then write
       * `REQUEST_BODY` into the finished request's orphaned `ClientRequest` and
       * `.end()` it — which on a keep-alive socket whose server has already
       * answered is what a pipelined request is made of.
       *
       * ⚠ **But a late body frame is IGNORED rather than refused, and that
       * distinction is the whole of this arm.** The first spelling of this guard
       * refused the session, and it broke an ordinary client: the app's send loop
       * (`packages/web/src/e2ee.ts`) exits on `failure` or `closed`, and
       * `RESPONSE_END` is neither — it settles the caller's promise and leaves the
       * loop writing. So any listener that answers *before* reading the body —
       * `uploads.ts`'s `MAX_UPLOADS_PER_SESSION`, its rate check, any 401/404/405
       * on a `body: true` request — made every remaining frame of a body over
       * 65518 bytes arrive here with `carrying === "none"`, and tore down a
       * session that already had its answer. `request()` then threw instead of
       * returning the 413 it was holding.
       *
       * Ignoring is safe *because* of the sibling fix in `response.on("end")`:
       * the orphan is `destroy()`ed there rather than released, so there is no
       * longer a writable handle for these bytes to be smuggled into. The pooled
       * connection is not at risk; only the frames are late. This is exactly the
       * argument `FRAME.MESSAGE` below already makes for a message that raced the
       * daemon's own `CLOSE`.
       *
       * What is still a refusal is a body frame on a connection carrying a
       * **socket**. Nothing legitimate produces that, and the pipelining shape
       * above is what it would be reaching for.
       */
      case FRAME.REQUEST_BODY:
        if (this.carrying === "socket") return this.fail(400, "this connection is carrying a socket");
        if (this.requestBody === null) return;
        this.requestBody(decoded.payload);
        return;
      case FRAME.REQUEST_END:
        if (this.carrying === "socket") return this.fail(400, "this connection is carrying a socket");
        if (this.requestBody === null) return;
        this.requestBody(null);
        this.requestBody = null;
        return;
      case FRAME.OPEN:
        if (this.carrying !== "none") return this.fail(400, "this connection is already carrying something");
        return this.openSocket(decoded.payload);
      case FRAME.MESSAGE: {
        // Nothing is carrying a socket: ignore, exactly as this case always has.
        // A `MESSAGE` that raced the daemon's own `CLOSE` arrives here in the
        // ordinary course of a socket ending, and is not a protocol violation.
        if (this.assembler === null) return;
        if (!this.assembler.push(decoded.payload)) return this.fail(400, "socket message too large");
        return;
      }
      /*
       * ⚠ **The terminator is the only thing that says a message is whole**, and
       * this arm had to land in the same change as the send side below: both
       * `default:` arms fail the session, so an end that sends `MESSAGE_END`
       * against one that has never heard of it is a session that dies on its first
       * socket message. Nothing is released, so that flag day is inside this tree
       * and not on the wire.
       *
       * The bytes go out as bytes. `MessageAssembler` hands back the
       * concatenation and this forwards it unchanged, which is what keeps a chunk
       * boundary landing inside a multi-byte UTF-8 sequence from becoming a
       * U+FFFD: nothing here decodes, so nothing here can decode a piece.
       */
      case FRAME.MESSAGE_END: {
        if (this.assembler === null) return;
        const whole = this.assembler.end();
        // `null` means the bound was passed and the held chunks were dropped, so
        // there is no message to deliver and delivering what survived would be a
        // hole. It is only reachable if the `push` above ignored its own answer.
        if (whole === null) return this.fail(400, "socket message too large");
        /*
         * ⚠ **`readyState` is checked because `send` throws.** Measured on ws
         * 8.21.3: `send` raises `"WebSocket is not open: readyState 0
         * (CONNECTING)"`, and the window between this daemon dialling its own
         * listener and the socket opening is one the peer controls — it knows the
         * window closed because `OPENED` says so. This socket is read-only by
         * design (`server.ts`: the handler registers `onOpen`, `onClose` and
         * `onError` and no `onMessage`), so an inbound message is already a
         * protocol violation; the point of the check is that it becomes a refusal
         * with words on it rather than a throw out of the frame loop.
         */
        if (this.socket === null || this.socket.readyState !== WebSocket.OPEN) {
          return this.fail(400, "a message arrived before the socket was open");
        }
        this.socket.send(whole);
        return;
      }
      case FRAME.CLOSE: {
        const close = decodeJson<CloseFrame>(decoded.payload);
        /*
         * ⚠ **Both halves are validated before `ws` is given either.** See
         * {@link isCloseCode} for the code; the reason is the same defect in the
         * other field, since `ws` answers `RangeError("The message must not be
         * greater than 123 bytes")` for a long one — a close reason travels in a
         * control frame, which is 125 bytes whole. Refused rather than clamped,
         * because a close this end had to rewrite is not the close the app asked
         * for, and every other value in this file is carried whole or refused.
         *
         * The `?? 1000` and `?? ""` are the same defaults this arm has always
         * had: a `CLOSE` with nothing in it means "close it normally".
         */
        const code = close?.code ?? 1000;
        const reason = close?.reason ?? "";
        if (!isCloseCode(code)) return this.fail(400, "unusable close code");
        if (typeof reason !== "string" || Buffer.byteLength(reason, "utf8") > MAX_CLOSE_REASON_BYTES) {
          return this.fail(400, "unusable close reason");
        }
        this.socket?.close(code, reason);
        return;
      }
      default:
        return this.fail(400, `unexpected frame ${decoded.type}`);
    }
  }

  /**
   * Resolve a path the app chose against this daemon's own listener, or refuse.
   *
   * ⚠ **The join is not the check.** That sentence is
   * `packages/native/src-tauri/src/proxy.rs`'s, about the same defect on the other
   * leg of the same client, and this end had it in its worst form: the target was
   * built by concatenation — `` `ws://${host}:${port}${wanted.path}` ``. Measured
   * on this runtime, a path of `"@evil.example/x"` makes that string
   * `ws://127.0.0.1:7887@evil.example/x`, and the WHATWG parser reads
   * `127.0.0.1:7887` as **userinfo** and `evil.example` as the host. So the daemon
   * dials a host the app named, over the network, carrying
   * `Authorization: Bearer <this session's capability>` — a full SSRF with the
   * fleet's own credential attached, from any device holding a grant.
   *
   * `new URL` closes the userinfo door and opens two more: `//evil.example` and
   * `/\evil.example` both start with `/` and both resolve to another origin, which
   * is why the origin is **compared** afterwards rather than trusted to the join.
   * A reference that is not absolute is refused outright rather than resolved,
   * because `new URL("@evil.example/x", base)` quietly becomes
   * `/@evil.example/x` — an answer to a request the app did not make.
   *
   * **What is sent is what was checked**: the caller takes the resolved path, not
   * the string the app wrote. Checking one string and sending another is the
   * parser differential this exists to close.
   *
   * The base is bracketed for an IPv6 literal, because `localAddress` in
   * `scripts/daemon.ts` answers `::1` for a wildcard bind on an IPv6 host and
   * `new URL("ws://::1:7887")` throws — the concatenated form was already broken
   * there and said nothing about it.
   */
  private loopback(scheme: "http" | "ws", path: string): URL | null {
    if (!path.startsWith("/") || path.startsWith("//")) return null;
    const host = this.options.local.host.includes(":")
      ? `[${this.options.local.host}]`
      : this.options.local.host;
    const base = `${scheme}://${host}:${this.options.local.port}`;
    try {
      // Parsed rather than compared as a string: on port 80 `origin` drops the
      // port, and a comparison against the base *text* would then refuse every
      // request a daemon bound there ever served.
      const origin = new URL(base).origin;
      const target = new URL(path, base);
      return target.origin === origin ? target : null;
    } catch {
      // Not a URL either way — a base this daemon cannot describe, or a path the
      // parser will not take. Both are this session's refusal, not a throw.
      return null;
    }
  }

  private startRequest(payload: Uint8Array): void {
    const wanted = decodeJson<RequestFrame>(payload);
    if (wanted === null || typeof wanted.method !== "string" || typeof wanted.path !== "string") {
      return this.fail(400, "unreadable request");
    }
    // See {@link HTTP_TOKEN}: `http.request` throws on a method that is not one,
    // and a throw here is a wedged session rather than a refused request.
    if (!HTTP_TOKEN.test(wanted.method)) return this.fail(400, "unreadable request");
    const target = this.loopback("http", wanted.path);
    if (target === null) return this.fail(400, "unreadable request");

    /*
     * ⚠ **The credential on every inner request is the one this session
     * authenticated, and a client-supplied one is replaced rather than merged.**
     *
     * The channel proved which device is calling, and the capability presented at
     * `HELLO` was checked against it. Letting a request carry a *different*
     * credential would mean the binding held for the handshake and not for the
     * traffic — one capability opening the session and another doing the work,
     * which is the kind of gap that reads as fine until somebody looks. Pinning it
     * here also means the app never resends it, so a capability appears exactly
     * once per session instead of on every request.
     *
     * This is the mirror of the relay's own rule that its metadata never enters a
     * proxied request. There the point is that the carrier may not inject; here
     * the point is that the **endpoint** must, because it is the only party that
     * knows what the channel proved.
     */
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(wanted.headers ?? {})) {
      const lowered = name.toLowerCase();
      if (lowered === "authorization") continue;
      // A name or a value Node would throw on is a refusal here, with this
      // session's own words — see {@link HTTP_TOKEN} and {@link HTTP_FIELD_VALUE}.
      if (typeof value !== "string" || !HTTP_TOKEN.test(name) || !HTTP_FIELD_VALUE.test(value)) {
        return this.fail(400, "unreadable request");
      }
      // Whoever describes the message decides where it ends, and the app writing
      // that is how a second request rides in on the body — see
      // {@link FRAMING_HEADERS}, which is measured rather than precautionary.
      if (FRAMING_HEADERS.has(lowered)) return this.fail(400, "unreadable request");
      headers[name] = value;
    }
    if (this.capability !== null) headers["authorization"] = `Bearer ${this.capability}`;

    let upstream: ClientRequest;
    try {
      upstream = httpRequest({
        host: this.options.local.host,
        port: this.options.local.port,
        method: wanted.method,
        // The **resolved** path, which is the one the origin check agreed to.
        path: `${target.pathname}${target.search}`,
        headers,
      });
    } catch {
      // The backstop for a check this file does not know about yet. `httpRequest`
      // validates the method, every header name and every header value, and each
      // of those throws is reachable from a frame the app wrote.
      return this.fail(400, "unreadable request");
    }
    this.carrying = "request";
    this.upstreamRequest = upstream;

    /*
     * The bound that used to live in the relay, now one hop closer to what it
     * bounds. Destroyed **with** an error, because `ClientRequest.destroy()`
     * emits no `'error'` and a silent destroy after the head has gone reaches
     * nobody — which is the measurement `relay/proxy.ts` records.
     */
    upstream.setTimeout(this.options.upstreamTimeoutMs ?? UPSTREAM_IDLE_TIMEOUT_MS, () =>
      upstream.destroy(new Error("upstream idle")),
    );
    upstream.on("error", () => this.fail(502, "tunnel_failed"));

    upstream.on("response", (response) => {
      this.upstream = response;
      const answered: Record<string, string> = {};
      for (const [name, value] of Object.entries(response.headers)) {
        if (value === undefined) continue;
        answered[name] = Array.isArray(value) ? value.join(", ") : String(value);
      }
      /*
       * ⚠ **The one description in this file that is not one this file chose.**
       * `encodeJsonFrame` throws above `MAX_HEADER_JSON_BYTES`, and these are
       * whatever headers the loopback listener put on the answer, assembled inside
       * an `http` `"response"` listener that sits outside the frame loop's `try` —
       * so a throw there is an unhandled rejection where the honest outcome is the
       * connection failing with something the app can see. `tryEncodeJsonFrame`
       * exists for this caller, and its own docblock says so.
       */
      const head = tryEncodeJsonFrame(FRAME.RESPONSE, {
        status: response.statusCode ?? 502,
        statusText: response.statusMessage ?? "",
        headers: answered,
      });
      if (head === null) return this.fail(502, "the answer's head is too large to carry");
      this.write(head);

      /*
       * ⚠ **Named rather than inline, because a paused response can still *end* —
       * and nothing was taking its resume back off the stream.** The pause below
       * is strictly sequential: a paused response emits no further `"data"`, so at
       * most one of these is ever outstanding. That reads as *"it cannot
       * accumulate"* right until the **last** chunk is the one that pauses.
       * Measured on this runtime (node 26.3.0): `"end"` fires on an
       * `IncomingMessage` paused inside its own `"data"` handler, so the
       * `once("drain")` registered there is still installed when the `"end"` arm
       * runs — and that arm removed nothing. With the session's outbound queue
       * already past the mark (a peer whose h2 window has shut), twelve short
       * answers on one pooled connection left twelve listeners on a stream that
       * outlives every request on it, each pinning its dead `IncomingMessage`, and
       * the eleventh printed `MaxListenersExceededWarning` — a write to stderr
       * originating in `src/`, which CLAUDE.md allows in exactly two places,
       * neither of them here.
       *
       * The **fourth** site of one defect in this file, and the count is grepped
       * rather than remembered: {@link failed} records it arriving through a
       * refused session, `upstream.once("close", resume)` below through an upload's
       * pause cycles, and `resumeSocket` through an `OPEN`/`CLOSE` cycle. This is
       * the one that survived all three fixes, because here "at most one
       * outstanding" was *true* and it leaked anyway.
       *
       * No `paused` flag beside it, unlike its two siblings: they guard against a
       * source that keeps emitting after the pause (`upstream.write()` answering
       * `false` again, another socket `"message"`), and a paused `IncomingMessage`
       * emits nothing more. Removal is the whole fix here.
       */
      // A block body, not an expression one: `IncomingMessage.resume()` answers
      // itself, and an arrow annotated `: void` is checked against that directly.
      const resumeResponse = (): void => {
        response.resume();
      };

      response.on("data", (chunk: Buffer) => {
        for (let at = 0; at < chunk.length; at += BODY_CHUNK_BYTES) {
          // `chunk` is a `Buffer`, so `subarray` is already a `Uint8Array` view
          // and `encodeFrame`'s `out.set(payload, 1)` takes any typed array. The
          // `new Uint8Array(…)` that used to wrap this copied every response body
          // in the fleet for nothing.
          this.write(encodeFrame(FRAME.RESPONSE_BODY, chunk.subarray(at, at + BODY_CHUNK_BYTES)));
        }
        /*
         * Backpressure, end to end. The relay grants this stream's h2 window on
         * consumption, so a browser that stops reading eventually stops this
         * write from draining — and pausing the loopback response here is what
         * carries that all the way back to the daemon's own outbound queue.
         */
        if (this.options.stream.writableLength > BODY_CHUNK_BYTES * 8) {
          response.pause();
          this.options.stream.once("drain", resumeResponse);
        }
      });
      response.on("end", () => {
        this.upstream = null;
        // The answer is over, so there is nothing left to resume and this is the
        // only moment anything can take the listener off — see its docblock for
        // what twelve of them cost. A no-op when the pause never happened or its
        // `drain` already fired, which is the ordinary case.
        this.options.stream.off("drain", resumeResponse);
        // Its lifetime is `carrying`'s, not the response's. See the REQUEST_BODY arm.
        this.requestBody = null;
        // The connection carries nothing again, which is what lets the app's pool
        // hand it out for the next request. See {@link carrying}.
        this.carrying = "none";
        /*
         * ⚠ **`complete` is the difference between an answer and a truncation**,
         * and it is why `RESPONSE_END` and `FAILED` are different frames. A body
         * that stopped short of its `content-length` must reach the app as a
         * failure, never as a shorter answer it would then parse and believe.
         */
        if (response.complete) this.write(encodeFrame(FRAME.RESPONSE_END));
        else this.fail(502, "truncated");
        /*
         * ⚠ **The answer being complete is not the request being complete.** A
         * listener that answers without reading the body *to the end* — a 404, a
         * 401, a 405, an upload refused by the byte counter or the session quota
         * after reading up to `MAX_UPLOAD_BYTES` of it — ends the response while
         * this `ClientRequest` is still writable, and letting go of the handle
         * here put its loopback socket beyond `destroy()`'s reach with nothing
         * else coming to collect it. Cancelling the body on the way out, which
         * those two upload refusals do, does not change that: it destroys the
         * server's `IncomingMessage` and not the connection. {@link upstreamRequest}
         * carries both measurements and the reason the idle bound does not cover
         * this case.
         *
         * **Destroyed rather than ended**, for {@link destroy}'s own reason one
         * screen up: `end()` submits the part of the body that arrived as though
         * the app had finished sending it, and on a keep-alive socket whose
         * server has already answered, those bytes are what a pipelined request
         * is made of. Guarded on `writableEnded`, so a request that really did
         * end keeps its connection poolable — `carrying` went back to `"none"`
         * above either way, because it is this handle's lifetime being extended
         * and not the connection's busy state.
         *
         * After the frame rather than before it, and with no argument. Measured:
         * `ClientRequest.destroy()` with no error emits `close` and no `'error'`,
         * so the `"error"` listener above cannot turn a delivered answer into a
         * `502` — and writing `RESPONSE_END` first means a runtime that ever
         * started emitting one would find the answer already on the wire.
         */
        if (!upstream.writableEnded) upstream.destroy();
        this.upstreamRequest = null;
      });
      response.on("error", () => this.fail(502, "tunnel_failed"));
    });

    if (wanted.body) {
      /*
       * ⚠ **Backpressure on the way up, which the rewrite dropped.** The old shape
       * was `stream.pipe(socket)`, which propagates it by construction; this one
       * ignored `write`'s answer while `stream.on("data")` held the h2 stream in
       * flowing mode, so a 100 MiB upload accumulated in *this daemon's* heap —
       * the process that owns the agents, the event log and the store — at
       * whatever rate the relay could deliver it.
       *
       * The mirror of what the response direction does one screen up: pause the
       * source, resume it when the destination has taken what it holds. Measured
       * on this runtime, the very first 65518-byte `write` answers `false` before
       * the loopback socket is even connected (a `ClientRequest` buffers against a
       * 16 KiB high-water mark), and `"drain"` does arrive once it connects and
       * flushes — so the pause is eager and the resume is real.
       *
       * `"close"` is listened for beside `"drain"` because a request that is
       * destroyed before it drains would otherwise leave this stream paused for
       * ever, and a paused stream is a session that never reads another frame.
       * `paused` is what keeps several false writes from stacking up resumes.
       */
      let paused = false;
      const resume = (): void => {
        if (!paused) return;
        paused = false;
        this.options.stream.resume();
      };
      /*
       * ⚠ **`close` is registered once, not once per pause.** `drain` is consumed
       * each cycle; `close` fires only at the end of the request, so hanging it
       * off the pause branch left one listener per cycle with nothing to remove
       * them — and a `ClientRequest` buffers against 16 KiB while a frame carries
       * 65518, so nearly every write pauses. A 10 MiB upload is ~160 cycles, past
       * Node's default `maxListeners` of 10, and the warning is a stderr write
       * from `src/`. See {@link failed} for the other half of that defect.
       */
      upstream.once("close", resume);
      this.requestBody = (chunk) => {
        if (chunk === null) {
          upstream.end();
          return;
        }
        if (upstream.write(chunk) || paused) return;
        paused = true;
        this.options.stream.pause();
        upstream.once("drain", resume);
      };
    } else {
      this.requestBody = null;
      upstream.end();
    }
  }

  private openSocket(payload: Uint8Array): void {
    const wanted = decodeJson<OpenFrame>(payload);
    if (wanted === null || typeof wanted.path !== "string") return this.fail(400, "unreadable open");
    // The same guard, and this is the site it was measured on: see {@link loopback}.
    const target = this.loopback("ws", wanted.path);
    if (target === null) return this.fail(400, "unreadable open");

    /*
     * The same rule for a socket, and here it also retires `?token=`.
     *
     * A browser cannot set a header on a WebSocket handshake, which is the whole
     * reason the daemon reads a credential out of the query string at all — and
     * `SECURITY.md` lists that as a leak path, because a query string is what ends
     * up in a log. Inside a channel we own, this hop is made by Node, so it can
     * carry a header like any other request and the credential stops travelling in
     * a URL on the last leg.
     */

    /*
     * ⚠ **`followRedirects` written down, because the origin check has no say
     * over a second address.** {@link loopback} decides where this dial *starts*;
     * a `3xx` with a `Location` decides where it ends, and a redirect followed
     * off-origin is the SSRF this file exists to close, re-entered through the
     * answer instead of through the path. `ws` 8.21.3 defaults it to `false`
     * (`initAsClient`'s own options object) and drops `authorization` on a
     * cross-host hop when it is on, so nothing is being fixed here — this is the
     * sentence `packages/native/src-tauri/src/proxy.rs` already writes as
     * `redirect::Policy::none()`, said on this leg too rather than left as a
     * library default that no check in this tree would notice changing.
     */
    let socket: WebSocket;
    try {
      socket = new WebSocket(target, {
        followRedirects: false,
        headers: this.capability === null ? {} : { authorization: `Bearer ${this.capability}` },
      });
    } catch {
      // `ws` validates the URL in its constructor and throws for one it will not
      // dial. The origin check above should have caught anything that gets here;
      // this is the refusal rather than the unhandled rejection either way.
      return this.fail(400, "unreadable open");
    }
    this.carrying = "socket";
    this.socket = socket;
    // One per socket, fresh: an assembler carrying a half-finished message from a
    // previous socket would deliver it as the beginning of the next one.
    this.assembler = new MessageAssembler();

    /*
     * ⚠ **A dial that connects and never upgrades used to wedge the connection for
     * good.** `carrying` goes to `"socket"` the moment the `WebSocket` is
     * constructed, because that is the only moment there is — the object exists
     * before the TCP connect, let alone the 101. So a listener that accepts the
     * connection and never answers the upgrade leaves this session carrying a
     * socket that does not exist: every later `REQUEST` and `OPEN` is refused
     * "already carrying something", no `OPENED` and no `CLOSE` ever arrives, and
     * **nothing at all times it out**. The peer waits out its own timeout against a
     * daemon that has stopped answering and is never told why, which is
     * {@link dispatch}'s wedged-session defect reached through the dial rather than
     * through a throw. No hostile peer is needed: a dev server mid-restart is that
     * listener.
     *
     * Expiry `fail()`s rather than quietly closing, so the app draws the cause.
     * The refusal is also what aborts the dial — `fail()` tears the session down
     * within {@link FAIL_FLUSH_TIMEOUT_MS}, and `destroy()`'s `terminate()` on a
     * `CONNECTING` socket is `ws`'s own `abortHandshake` (`websocket.js:492-498`).
     *
     * ⚠ **`ws`'s `handshakeTimeout` is deliberately *not* used, and this is the
     * note that keeps it from being rediscovered and added.** It exists on 8.21.3
     * (`websocket.js:767` assigns it to `opts.timeout`; `:888-892` aborts on it)
     * and it is the wrong bound twice over. It maps onto `http.request`'s
     * `timeout`, which is socket **inactivity** rather than elapsed time, so a
     * listener dribbling a byte at a time without ever finishing the upgrade
     * escapes it and does not escape this. And its expiry arrives as an ordinary
     * `"error"`, which the arm at the foot of this method answers
     * `502 tunnel_failed` — the generic transport failure this bound exists to
     * replace with a sentence. Setting both would leave the library's able to fire
     * only second, i.e. never, which is a bound that cannot fail: the shape this
     * repository keeps shipping by accident.
     *
     * **An *open* socket is deliberately still unbounded** — the daemon's event
     * stream is long-lived by design. The neighbouring candidate, opened but the
     * `OPENED` frame never written, needs no cover either: the `"open"` arm writes
     * it synchronously in the same tick, and every way that write can fail already
     * ends the session ({@link sealAndWrite}'s `catch` destroys, and {@link write}'s
     * `failed` guard only ever skips a frame on a session already being torn down).
     */
    const dialBound = this.options.upstreamTimeoutMs ?? UPSTREAM_IDLE_TIMEOUT_MS;
    const dialTimer = setTimeout(() => {
      // The state itself rather than a flag of our own: `CONNECTING` is true only
      // while the dial has neither opened nor been aborted, so a timer that
      // outlived its socket down some path this file does not foresee is a no-op
      // rather than a refusal aimed at whatever came next.
      if (socket.readyState !== WebSocket.CONNECTING) return;
      this.fail(502, "the socket never opened");
    }, dialBound);
    dialTimer.unref();

    socket.on("open", () => {
      // Cleared rather than left to the guard above, because this is the same
      // accumulation class {@link failed}, the upload path's `once("close")` and
      // `resumeSocket` each record: `socket.on("close")` below puts `carrying`
      // back to `"none"`, so a peer may `OPEN`/`CLOSE` all session long, and one
      // retained dial timer per cycle (two minutes each by default), each pinning
      // the dead `socket` it captured, is exactly what they were written about.
      clearTimeout(dialTimer);
      this.write(encodeFrame(FRAME.OPENED));
    });
    /*
     * ⚠ **`MESSAGE`×n then `MESSAGE_END`, and the terminator is the whole fix.**
     * This loop used to write the chunks and nothing else, so a receiver with no
     * boundary to read raised **each chunk as its own message**. The daemon sends
     * an event batch as one WebSocket message of up to `BATCH_MAX_BYTES` (512 KiB)
     * and a control snapshot measured around 93 KB — both far above the 65518 a
     * frame holds — so on the encrypted path those arrived as eight, or two,
     * different messages, each one JSON cut mid-token. `stream.ts` drops what it
     * cannot parse **and leaves the cursor where it was**, so the next reconnect
     * asked for the same batch, split it the same way and dropped it again: a
     * transcript that stalls for good, with nothing logged, on big sessions only,
     * and only away from loopback.
     *
     * `encodeMessageFrames` rather than a loop written here, because every chunk
     * has to stay at or under `MAX_FRAME_PAYLOAD` and one implementation is how
     * that stays true across two packages that may not import one another. It is also
     * what makes a zero-length message survive — no chunks and a terminator, which
     * the far end hands back as zero bytes rather than as nothing.
     */
    /*
     * ⚠ **This direction pauses too.** The response path pauses on
     * `writableLength` and the upload path pauses on `upstream.write()`'s answer;
     * this one wrote every frame of every batch unconditionally, and it defeated
     * the defence that was already there. On the direct path a stalled client
     * raises `raw.bufferedAmount` past `SOCKET_HIGH_WATER`, `flush` stops, the
     * queue grows and `MAX_QUEUE_BYTES` collapses the socket with
     * `lagged{slow_consumer}`. On the encrypted path the loopback `ws` client
     * below drains greedily, so `bufferedAmount` stays near zero, that ceiling
     * never fires, and the bytes pile up instead in the relay Duplex's unbounded
     * writable buffer — inside the process that owns this machine's live agents,
     * against a phone whose h2 window is shut.
     */
    let socketPaused = false;
    const resumeSocket = (): void => {
      if (!socketPaused) return;
      socketPaused = false;
      socket.resume();
    };
    /*
     * ⚠ **Once per socket, and taken off again when the socket goes.** `drain` is
     * consumed each cycle and `close` is not — but `openSocket` is itself a cycle:
     * `socket.on("close")` below puts `carrying` back to `"none"`, so a peer may
     * `OPEN`/`CLOSE` all session long, and every pass left one more listener on a
     * stream that outlives every socket on it. Measured on this runtime, fourteen
     * legal cycles took the count from one to fifteen and the eleventh printed
     * `MaxListenersExceededWarning` — which is a write to stderr originating in
     * `src/`, the defect {@link failed} records arriving through a different door.
     * Each retained closure also pinned the dead `socket` it had captured.
     */
    this.options.stream.once("close", resumeSocket);
    socket.on("message", (data: Buffer) => {
      for (const frame of encodeMessageFrames(data)) this.write(frame);
      if (socketPaused || this.options.stream.writableLength <= BODY_CHUNK_BYTES * 8) return;
      socketPaused = true;
      socket.pause();
      this.options.stream.once("drain", resumeSocket);
    });
    /*
     * The daemon's own close code, carried whole. `stream.ts`'s close-code table
     * is the client's entire model of why a stream ended — `4401` re-mints, `4404`
     * gives up, `4003` backs off — so anything that rewrote or defaulted a code
     * here would silently change what the app does about it.
     */
    socket.on("close", (code: number, reason: Buffer) => {
      // The other half of the pair above. The `"error"` arm needs none: `ws`
      // follows every `"error"` it raises with a close (`emitErrorAndClose`,
      // `websocket.js:1053-1062`), so this runs anyway — and it refuses, which
      // ends the session regardless.
      clearTimeout(dialTimer);
      this.write(encodeJsonFrame(FRAME.CLOSE, { code, reason: reason.toString("utf8") } satisfies CloseFrame));
      this.socket = null;
      // Whatever was part-assembled goes with the socket rather than being
      // delivered — the `RESPONSE_END`-versus-`FAILED` rule again — and the
      // connection is carrying nothing, which is the state the app's own
      // `Connection` moves to when it reads this same frame.
      this.assembler = null;
      this.carrying = "none";
      // Both, because `resumeSocket` is registered on two of this stream's events
      // and either may still be outstanding: `close` once per socket above, and
      // `drain` if this socket was paused when it closed. Resuming a socket that
      // has already gone is a no-op, so what these remove is dead weight either
      // way — see the registration above for what it weighed. A socket that
      // errors without ever closing takes the whole session with it (`fail()`),
      // so nothing can accumulate behind that path.
      this.options.stream.off("close", resumeSocket);
      this.options.stream.off("drain", resumeSocket);
    });
    socket.on("error", () => this.fail(502, "tunnel_failed"));
  }
}
