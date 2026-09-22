import { serve } from "@hono/node-server";
import { createServer, request as httpRequest } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { Duplex, PassThrough } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
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
  frameLength,
  generateStaticKey,
  localStaticKey,
  type CipherState,
  type CloseFrame,
  type ResponseFrame,
} from "@reemoat/protocol";
import { check, report } from "./daemoncheck.env.js";
import { app, boundToken, tokenFor, verifier } from "./daemoncheck.fixtures.js";
import { serveSecureSession } from "../src/e2ee.js";
import { jwkThumbprint, x25519Jwk } from "../src/token.js";

/* ------------------------------------------------------------------ *
 * An encrypted session, against the real daemon
 *
 * This is the section that says the relay stops being trusted with what it
 * carries: the app and the daemon run `Noise_IK` between themselves, and
 * everything the relay would hold is ciphertext.
 *
 * **Driven against the real `createApp`**, which is the reason it is here rather
 * than in `relaycheck`. What has to survive is that a request arriving this way
 * is indistinguishable, at the daemon's own listener, from one that arrived the
 * old way — and the sharpest case is Hono's bare 404, the shape six readers turn
 * into *"this daemon is too old"*, because a re-serialising layer is exactly what
 * would round it off into an envelope.
 *
 * The two ends are in-memory pipes rather than a socket: what a relay hands the
 * daemon is a byte pipe, and nothing here is about TCP.
 * ------------------------------------------------------------------ */

process.stdout.write("\nan encrypted session, against the real daemon\n");

/*
 * ⚠ **The port is read inside the listening callback, never after `serve`
 * returns.** `server.address()` is `null` at every synchronous point afterwards,
 * on every host form — which is why `RelayTunnel.start` is called from inside
 * this same callback in `daemon.ts`. Read outside it, `port` is `0` and every
 * request below would go to a port nothing is on.
 */
const listener = await new Promise<ReturnType<typeof serve>>((resolve) => {
  const started = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }, () => resolve(started));
});
const local = { host: "127.0.0.1", port: (listener.address() as AddressInfo).port };
report("the daemon's own listener is up", local.port > 0, `127.0.0.1:${local.port}`);

const machine = generateStaticKey();
const device = generateStaticKey();
const stranger = generateStaticKey();
const deviceThumbprint = jwkThumbprint(x25519Jwk(device.publicKey));
const strangerThumbprint = jwkThumbprint(x25519Jwk(stranger.publicKey));

/**
 * One end of an encrypted session, by hand.
 *
 * Written out here rather than imported from the client, deliberately: the point
 * of most of this section is to send bytes a real client never would — a tampered
 * frame, a capability minted for another device, a request before any capability
 * at all.
 */
class Peer {
  private readonly reader = new LengthReader();
  private readonly frames: { type: number; payload: Uint8Array }[] = [];
  private send: CipherState | null = null;
  private receive: CipherState | null = null;
  private wake: (() => void) | null = null;
  /** Everything the *relay* would have seen, which is what it may not read. */
  readonly carried: Uint8Array[] = [];
  ended = false;
  /** Raised by the `"pause"` listener in {@link connect}; see {@link inboundPauses}. */
  private pauses = 0;

  private constructor(
    private readonly handshake: NoiseHandshake,
    private readonly out: PassThrough,
    /**
     * The pipe the daemon writes into, which this peer can stop taking bytes off.
     *
     * ⚠ **The pause belongs here and never on {@link wire}.** `wire`'s readable
     * half is the daemon's *inbound* leg, so pausing that would stop the daemon
     * reading this peer's frames — the opposite direction from the one the
     * backpressure guard in `openSocket` is about.
     */
    private readonly inbound: PassThrough,
    /** The very object the daemon holds as `options.stream`. */
    private readonly wire: Duplex,
  ) {}

  /**
   * A session against a listener, `local` by default.
   *
   * ⚠ **The listener is a parameter because five things the sections below drive
   * need one that is not the daemon's.** A single WebSocket message far above one
   * frame; a request whose *own* `authorization` header is echoed back; a route
   * that never answers; a route that answers **without ever reading the request
   * body**; and a socket that pours more than a peer who has stopped reading will
   * take — all things the real app deliberately never does, and the subject in
   * each case is `src/e2ee.ts` rather than the listener on the other side of the
   * loopback hop. The sections that are about the daemon's own answers still use
   * the daemon's own listener, which is the whole point of the ones above.
   */
  static async connect(secretKey: Uint8Array, at: { host: string; port: number } = local): Promise<Peer> {
    const toDaemon = new PassThrough();
    const toPeer = new PassThrough();
    // Named rather than built inline below, because the daemon and this peer have
    // to hold the *same* object: `stream.writableLength` is what the backpressure
    // guard is keyed on, and it is only readable from the end that made the pipe.
    const wire = Duplex.from({ readable: toDaemon, writable: toPeer });
    const peer = new Peer(
      NoiseHandshake.start({
        initiator: true,
        staticKey: localStaticKey(secretKey),
        remoteStatic: machine.publicKey,
      }),
      toDaemon,
      toPeer,
      wire,
    );

    toDaemon.on("data", (chunk: Buffer) => peer.carried.push(new Uint8Array(chunk)));
    toPeer.on("data", (chunk: Buffer) => {
      peer.carried.push(new Uint8Array(chunk));
      peer.consume(new Uint8Array(chunk));
    });
    toPeer.on("close", () => {
      peer.ended = true;
      peer.wake?.();
    });
    // The daemon stopping its own reading, which is what the upload path's
    // backpressure guard does and the only thing in `src/e2ee.ts` that does it.
    // See {@link inboundPauses} for why this counts cycles rather than calls.
    wire.on("pause", () => {
      peer.pauses += 1;
    });

    serveSecureSession({
      stream: wire,
      staticKey: localStaticKey(machine.secretKey),
      verifier,
      local: at,
    });

    peer.out.write(frameLength(await peer.handshake.writeMessage()));
    await peer.until(() => peer.send !== null || peer.ended);
    return peer;
  }

  private consume(chunk: Uint8Array): void {
    for (const message of this.reader.push(chunk)) {
      if (this.send === null) {
        void this.handshake.readMessage(message).then(() => {
          const transport = this.handshake.split();
          this.send = transport.send;
          this.receive = transport.receive;
          this.wake?.();
        });
        continue;
      }
      try {
        const frame = decodeFrame(this.receive!.decrypt(new Uint8Array(0), message));
        if (frame !== null) this.frames.push(frame);
      } catch {
        this.frames.push({ type: -1, payload: new Uint8Array(0) });
      }
      this.wake?.();
    }
  }

  get established(): boolean {
    return this.send !== null;
  }

  write(frame: Uint8Array): void {
    this.out.write(frameLength(this.send!.encrypt(new Uint8Array(0), frame)));
  }

  /**
   * Several frames sealed into **one** chunk, which is what `LengthReader` hands
   * `consume` as a single array. Separate `write` calls may or may not coalesce;
   * the sections about what happens to the frames *after* a refusal need them not
   * to be a matter of luck.
   */
  writeAll(...frames: Uint8Array[]): void {
    this.out.write(Buffer.concat(frames.map((f) => frameLength(this.send!.encrypt(new Uint8Array(0), f)))));
  }

  /**
   * Stop taking bytes off the daemon's half of the pipe.
   *
   * What a phone whose h2 window has shut does, and the only way to reach the
   * branch in `openSocket`'s `"message"` listener that bounds the daemon's own
   * outbound queue. Measured on this runtime: with a `data` listener installed and
   * the stream paused, twenty 65 518-byte writes into a `Duplex.from` pair leave
   * `writableLength` at 1 179 324 of the 1 310 360 written, and exactly one
   * `"drain"` fires once the peer reads again — so both halves of that guard, the
   * pause and the resume it hangs off, are reachable from here.
   */
  stopReading(): void {
    this.inbound.pause();
  }

  /** Read again, which is what releases the daemon's one `"drain"`. */
  startReading(): void {
    this.inbound.resume();
  }

  /**
   * How many bytes the daemon has written that nothing has taken yet.
   *
   * ⚠ **This is the observable the backpressure guard is keyed on, and nothing on
   * the far side of the hop can stand in for it.** Every frame is written whether
   * the daemon pauses or not — the difference is only *when* — so no count this
   * peer keeps moves at all, which is the same trap the `FAILED` count was.
   * `stream.writableLength` is a number inside the daemon, and this driver can
   * read it only because it built the pipe the daemon was handed.
   *
   * It is a real queue rather than a formality: `Duplex.from` defers its write
   * callback the moment the underlying `PassThrough` answers `false`, which the
   * first 65 518-byte frame already does against a 16 KiB high-water mark, and
   * `SecureSession.write` ignores `write`'s answer — so it grows with no ceiling
   * of its own.
   */
  get outboundQueued(): number {
    return this.wire.writableLength;
  }

  /**
   * How many listeners the daemon currently has on the pipe it was handed.
   *
   * ⚠ **The only observable for a listener that is never taken off.** `openSocket`
   * registers `stream.once("close", resumeSocket)` per socket on a stream that
   * outlives every socket — `socket.on("close")` puts `carrying` back to `"none"`,
   * so a peer may `OPEN`/`CLOSE` all session long — and the pause branch registers
   * `stream.once("drain", resumeSocket)` on top of that. Nothing on the far side of
   * the loopback hop moves when either accumulates: the session goes on answering
   * perfectly, and the only symptom is Node printing
   * `MaxListenersExceededWarning` past the eleventh, which is **a write to stderr
   * originating in `src/`** — the one thing `CLAUDE.md` forbids outright, with two
   * named exceptions this is not either of.
   *
   * Readable from here only because this driver built the pipe the daemon was
   * given, the same reason {@link outboundQueued} is.
   */
  streamListeners(event: "close" | "drain"): number {
    return this.wire.listenerCount(event);
  }

  /**
   * How many times the daemon has stopped reading this peer's frames.
   *
   * ⚠ **`stream.pause()` has exactly one caller in `src/e2ee.ts`** — the upload
   * path's `requestBody` closure, when `upstream.write()` answers `false` — and
   * `stream.resume()` exactly one, the `resume` it pairs with. So a `"pause"`
   * event on this pipe *is* one backpressure cycle on the way up, and counting
   * them is how the section below says its upload really reached the branch
   * whose listener registration it is measuring. (`openSocket` pauses the
   * *socket* and {@link stopReading} pauses `inbound`; neither touches this
   * stream's readable half.)
   *
   * Node emits `"pause"` only when `flowing !== false`, so a second pause with no
   * resume between raises nothing — which is the right count either way: what the
   * listener registration is per is the cycle, not the call.
   */
  get inboundPauses(): number {
    return this.pauses;
  }

  /**
   * Take the session away, the way a relay dropping the stream would.
   *
   * `destroy` rather than `end`, because the daemon hangs its teardown off
   * `stream.on("close")`: a half-closed pipe leaves that pending until the
   * `FAIL_FLUSH_TIMEOUT_MS` backstop two seconds later, and a driver watching for
   * what a teardown lets go of would then be measuring that timer.
   */
  hangUp(): void {
    this.wire.destroy();
  }

  /** Ciphertext with one byte altered, which no honest peer ever produces. */
  writeTampered(frame: Uint8Array): void {
    const sealed = this.send!.encrypt(new Uint8Array(0), frame);
    sealed[sealed.length - 1] = (sealed[sealed.length - 1]! ^ 0x01) & 0xff;
    this.out.write(frameLength(sealed));
  }

  private async until(done: () => boolean): Promise<void> {
    if (done()) return;
    await new Promise<void>((resolve) => {
      this.wake = () => {
        if (!done()) return;
        this.wake = null;
        resolve();
      };
      setTimeout(() => {
        this.wake = null;
        resolve();
      }, 4_000).unref();
    });
  }

  async next(): Promise<{ type: number; payload: Uint8Array } | null> {
    await this.until(() => this.frames.length > 0 || this.ended);
    return this.frames.shift() ?? null;
  }

  /** Send a request and collect the whole answer. */
  async request(method: string, path: string, headers: Record<string, string> = {}): Promise<{
    status: number;
    body: string;
    ended: number;
  }> {
    this.write(encodeJsonFrame(FRAME.REQUEST, { method, path, headers, body: false }));
    return this.collect();
  }

  /**
   * The answer to a request already on the wire.
   *
   * Split out of {@link request} because one section has to send the `REQUEST` and
   * its first `REQUEST_BODY` by hand. Measured on this runtime (node 26.3.0): a
   * `ClientRequest` with no `write` and no `end` never flushes its head at all —
   * 600 ms later the listener has seen nothing, and it sees the request the
   * instant one byte is written — so *"a body the listener never reads"* is a case
   * that does not exist until the body has begun.
   */
  async collect(): Promise<{ status: number; body: string; ended: number }> {
    let status = 0;
    let body = "";
    for (;;) {
      const frame = await this.next();
      if (frame === null) return { status, body, ended: -1 };
      if (frame.type === FRAME.RESPONSE) {
        status = decodeJson<ResponseFrame>(frame.payload)?.status ?? 0;
      } else if (frame.type === FRAME.RESPONSE_BODY) {
        body += new TextDecoder().decode(frame.payload);
      } else if (frame.type === FRAME.RESPONSE_END || frame.type === FRAME.FAILED) {
        return { status, body, ended: frame.type };
      }
    }
  }

  async hello(capability: string): Promise<number> {
    this.write(encodeJsonFrame(FRAME.HELLO, { capability }));
    return (await this.next())?.type ?? -1;
  }

  /** Ask for a socket at `path`, and say what came back. */
  async open(path: string): Promise<number> {
    this.write(encodeJsonFrame(FRAME.OPEN, { path }));
    return (await this.next())?.type ?? -1;
  }

  /**
   * Close the socket this connection is carrying, and wait for the daemon's own
   * `CLOSE` back.
   *
   * ⚠ **The returned frame is what makes a listener count read afterwards
   * race-free**, and that is a fact about the order of four statements in
   * `openSocket`'s `socket.on("close")` handler rather than a convention: it
   * writes the `CLOSE` frame **first** and runs
   * `off("close", …)` / `off("drain", …)` **last**, all synchronously in the same
   * handler, and this peer reads the frame a tick later off a `PassThrough`. So a
   * count taken after this resolves is taken after the removals, and a build that
   * never removes reads high rather than reading early.
   *
   * `1000` because `isCloseCode` takes the whole registered range and the section
   * that pins *which* codes it takes is above; this one is about the listener.
   */
  async closeSocket(code = 1000): Promise<number> {
    this.write(encodeJsonFrame(FRAME.CLOSE, { code, reason: "" } satisfies CloseFrame));
    return (await this.next())?.type ?? -1;
  }

  /**
   * One whole socket message, reassembled the way the app's own client does.
   *
   * **`MessageAssembler`, not a `concat` written here**, because the property
   * being asserted is that the two ends of this protocol agree — the daemon splits
   * with `encodeMessageFrames` and this puts the pieces back with the class that
   * file pairs with it. A driver that reassembled by hand would pass even if the
   * chunk size and the bound had drifted apart.
   *
   * The chunks are handed back beside the message because the *number* of them is
   * the non-vacuity control: a message that happened to fit in one frame would
   * satisfy every assertion below while proving nothing at all.
   */
  async message(): Promise<{ bytes: Uint8Array | null; chunks: Uint8Array[] }> {
    const assembler = new MessageAssembler();
    const chunks: Uint8Array[] = [];
    for (;;) {
      const frame = await this.next();
      if (frame === null) return { bytes: null, chunks };
      if (frame.type === FRAME.MESSAGE) {
        chunks.push(frame.payload);
        assembler.push(frame.payload);
        continue;
      }
      if (frame.type === FRAME.MESSAGE_END) return { bytes: assembler.end(), chunks };
      // A `CLOSE` or a `FAILED` before the terminator is the socket giving up, and
      // the whole point of a separate terminator is that it is not a message.
      if (frame.type === FRAME.CLOSE || frame.type === FRAME.FAILED) return { bytes: null, chunks };
    }
  }

  /**
   * Why the session gave up, as the app would read it.
   *
   * ⚠ **The `reason` is what makes a refusal assertion mean anything.** Every arm
   * of the frame loop's table fails with `400`, and so does the backstop in
   * `dispatch` that catches a throw nobody predicted — so a driver asserting the
   * *code* alone is green whether the daemon refused the frame by name or crashed
   * and was caught. The strings below are the difference between those two, which
   * is the whole subject of the sections that use this.
   */
  async failure(): Promise<CloseFrame | null> {
    for (;;) {
      const frame = await this.next();
      if (frame === null) return null;
      if (frame.type === FRAME.FAILED) return decodeJson<CloseFrame>(frame.payload);
    }
  }
}

/* -- a session that works ---------------------------------------------- */

{
  const peer = await Peer.connect(device.secretKey);
  report("the handshake completes against the daemon's own key", peer.established, "Noise_IK, one round trip");

  check("a capability bound to this device is accepted", await peer.hello(boundToken("u_ab", deviceThumbprint)), FRAME.READY);

  const health = await peer.request("GET", "/health");
  check("and an ordinary request is answered", health.status, 200);
  report("with the daemon's own body", health.body.includes('"ok"'), health.body.slice(0, 40));
  check("and the answer is marked whole rather than given up on", health.ended, FRAME.RESPONSE_END);

  /*
   * ⚠ **The shape, not the status.** A daemon has no `app.notFound`, so an absent
   * route answers Hono's bare 404 with no error envelope — and `meansRouteAbsent`
   * keys on exactly that to tell *"this machine is too old"* from *"this machine
   * refused"*. Six places read it. A layer that re-serialised the answer would
   * round it into an envelope and every one of those screens would change.
   */
  /*
   * ⚠ **No credential is sent on the request**, and that is the assertion rather
   * than an omission: the session pins the capability it authenticated onto every
   * inner request, so the app never resends it. A route that answered 401 here
   * would mean the binding held for the handshake and not for the traffic.
   */
  const absent = await peer.request("GET", "/no-such-route");
  check("an absent route keeps its bare 404", absent.status, 404);
  report("and carries no error envelope", !absent.body.includes('"error"'), absent.body.slice(0, 60) || "(empty)");

  /*
   * What the relay would have held. Every byte that crossed either leg is
   * collected above, so this is the whole of what an untrusted middle sees.
   */
  const carried = Buffer.concat(peer.carried.map((c) => Buffer.from(c))).toString("latin1");
  report("the relay carried bytes at all", carried.length > 0, `${carried.length} bytes`);
  /*
   * ⚠ **The control, and without it the two checks below are a search for a string
   * that was never sent.** This repository has shipped that exact shape once
   * already — a secret hunted for in a buffer that only ever held the other
   * direction's bytes — so what they look for is proven to be in the plaintext
   * first: the path by the 200 above, the body by this. Both legs are in
   * `carried`, so if either were readable it would be here.
   */
  report("the control: the answer this session read names the instance in the clear", health.body.includes("instanceId"), health.body.slice(0, 60));
  check("and none of the daemon's answer is readable in them", carried.includes("instanceId"), false);
  check("nor the path that was asked for", carried.includes("/health"), false);
}

/* -- a capability that is not this device's ----------------------------- */

{
  /*
   * The theft case. A capability that verifies perfectly — right signature, right
   * issuer, right machine, well inside its lifetime — presented over a channel
   * that proved a different key.
   */
  const peer = await Peer.connect(stranger.secretKey);
  const answer = await peer.hello(boundToken("u_ab", deviceThumbprint));
  check("a capability for another device is refused", answer, FRAME.FAILED);
  /*
   * ⚠ **This was `peer.ended || true`, which is `true`.**
   *
   * The one assertion that the refusal is followed through, and it could not fail.
   * It matters because `fail()` deliberately does not set `closed`: it writes the
   * FAILED frame, calls `stream.end()`, and hangs teardown off the `close` event
   * with `FAIL_FLUSH_TIMEOUT_MS` behind it — so there is a real window between the
   * refusal and the socket going away, and this is the only thing watching it.
   *
   * `next()` is how the rest of this file waits for that: the FAILED frame has
   * already been taken by `hello`, so it resolves on `ended` rather than on a frame.
   *
   * What says `ended` is not simply always `true` — the shape the old spelling
   * failed as — is the first section of this file, and it is worth writing down
   * because an unstated control is one somebody deletes as redundancy. A peer
   * whose `ended` were stuck true takes no answer out of `request` at all:
   * `until` stops waiting immediately, the frame queue is empty at that moment,
   * and the call returns `{ status: 0, ended: -1 }`. That block asserts a 200 and
   * a `RESPONSE_END` read off exactly those two fields.
   */
  await peer.next();
  report("and the session is torn down rather than left open", peer.ended, "FAILED then close");
}

{
  // The daemon's own binding, from the other side: a capability naming *this*
  // device is accepted over this device's channel and nothing else is needed.
  const peer = await Peer.connect(stranger.secretKey);
  check("while one minted for it is accepted", await peer.hello(boundToken("u_ab", strangerThumbprint)), FRAME.READY);
}

{
  /*
   * ⚠ **A capability with no device binding is refused over an encrypted
   * channel**, and this is the assertion that says there is no downgrade. An
   * older Authority mints these; accepting one here would mean anybody holding a
   * copy could use it from anywhere, which is the whole property being bought.
   */
  const peer = await Peer.connect(device.secretKey);
  check("a capability naming no device is refused on a channel that proved one", await peer.hello(tokenFor("u_ab")), FRAME.FAILED);
}

{
  // Nothing may be asked before a capability is presented. A request first is a
  // refusal rather than an unauthenticated hop to the daemon's own listener.
  const peer = await Peer.connect(device.secretKey);
  peer.write(encodeJsonFrame(FRAME.REQUEST, { method: "GET", path: "/health", headers: {}, body: false }));
  check("a request before any capability is refused", (await peer.next())?.type ?? -1, FRAME.FAILED);
}

/* -- tampering ---------------------------------------------------------- */

{
  const peer = await Peer.connect(device.secretKey);
  check("a session is established", await peer.hello(boundToken("u_ab", deviceThumbprint)), FRAME.READY);

  /*
   * One altered byte of ciphertext. The daemon cannot answer — below a failed tag
   * there is no key the peer would trust — so it tears the stream down, which is
   * also what stops one injected frame desynchronising a session for good.
   */
  peer.writeTampered(encodeJsonFrame(FRAME.REQUEST, { method: "GET", path: "/health", headers: {}, body: false }));
  await peer.next();
  report("a tampered frame ends the session rather than being served", peer.ended, "stream destroyed");
}

/* -- two devices, one daemon ------------------------------------------- */

{
  /*
   * The requirement stated from the other end: two installations of one account
   * reach the same daemon over independent keys, and both see the same machine.
   */
  const laptop = await Peer.connect(device.secretKey);
  const phone = await Peer.connect(stranger.secretKey);
  check("both devices are accepted", [
    await laptop.hello(boundToken("u_ab", deviceThumbprint)),
    await phone.hello(boundToken("u_ab", strangerThumbprint)),
  ], [FRAME.READY, FRAME.READY]);

  const one = await laptop.request("GET", "/health");
  const two = await phone.request("GET", "/health");
  check("and both reach the same daemon", [one.status, two.status], [200, 200]);
  const idOf = (body: string): string => (/"instanceId":"([^"]+)"/.exec(body)?.[1] ?? "?");
  check("which is the same instance", idOf(one.body), idOf(two.body));

  /*
   * ⚠ **And their keys are independent.** Two sessions sealing the same plaintext
   * must not produce the same bytes, or a fleet-wide key has been built by
   * accident. Compared on what the relay carried, which is where it would show.
   */
  const first = Buffer.concat(laptop.carried.map((c) => Buffer.from(c))).toString("base64");
  const second = Buffer.concat(phone.carried.map((c) => Buffer.from(c))).toString("base64");
  report("with independent session keys", first !== second, "the two streams share no ciphertext");
}

/* ------------------------------------------------------------------ *
 * A listener of this driver's own, and one nothing may reach
 *
 * Everything above drives the **real** `createApp`, and that is deliberate: what
 * has to survive the encrypted path is that the daemon's own answers arrive
 * unchanged. The sections below are about `src/e2ee.ts` itself — the frame loop,
 * the path guard, the header rule, the reassembly — and each of them needs a
 * listener to do something the real app deliberately never does:
 *
 * - **`/big`** sends one WebSocket message of 200 000 bytes. The daemon's own
 *   stream only produces one that size with a large live session behind it, which
 *   is a fleet and an agent away from an offline driver.
 * - **`/echo`** answers with the `authorization` *it* was given. No route in this
 *   codebase does, and without one the rule at the top of `startRequest` — the
 *   inner request carries the capability **this channel** authenticated — is a
 *   docblock nothing has ever checked. It also answers **without ever reading the
 *   request body** — the handler never touches it — which is the whole of the
 *   unfinished-request case: the response ends while the `ClientRequest` that
 *   asked for it is still writable.
 * - **`/slow`** never answers at all, which is what makes "this connection is
 *   already carrying something" a deterministic assertion rather than a race
 *   against a loopback round trip.
 * - **`/flood`** pours {@link FLOOD_MESSAGES} of those 200 000-byte messages the
 *   moment the session sends it one, which is the only way to drive the daemon's
 *   own outbound queue past the mark its pause is keyed on. Poured on a message
 *   rather than at the upgrade so the peer can stop reading *first*: a flood that
 *   starts before the pause races the drain and measures the clock.
 *
 * And the **sink** is a listener nothing may reach *on the app's word*. It is how
 * "no connection was attempted" becomes a measurement instead of an absence: the
 * SSRF section asks for paths that, under the join this file used to do, resolve
 * to *its* address — so a dial that got through would arrive somewhere that counts
 * it. This driver dials it **once, itself**, immediately before those frames, for
 * the reason written at that section: a counter nothing ever raises is not a
 * measurement.
 * ------------------------------------------------------------------ */

/** One WebSocket message, far above what a single frame carries. */
const BIG = ((): string => {
  /*
   * ⚠ **A two-byte character sitting exactly on the first chunk boundary.**
   * `encodeMessageFrames` cuts at a byte count, so this character's first byte is
   * the last of frame one and its second is the first of frame two — the case
   * *"reassembly is over bytes, never over text"* exists for, and the one an
   * implementation that decoded each chunk on arrival would turn into a U+FFFD
   * and a silently different string.
   */
  const head = '{"pad":"';
  const tail = '"}';
  const before = "a".repeat(MAX_FRAME_PAYLOAD - head.length - 1);
  const after = "b".repeat(200_000 - head.length - before.length - 2 - tail.length);
  return `${head}${before}é${after}${tail}`;
})();

/** How many of those a `/flood` socket pours at a peer that has stopped reading. */
const FLOOD_MESSAGES = 24;

const echoes: { url: string; authorization: string | undefined; xTest: string | string[] | undefined }[] = [];
const upgrades: { url: string; authorization: string | undefined }[] = [];
const socketCloses: { code: number; reason: string }[] = [];

/**
 * The listener's own end of every `/flood` socket, kept so its backlog can be read.
 *
 * An array rather than a `let … | null`, matching the `upgrades.at(-1)` idiom
 * beside it and dodging the narrowing TypeScript gives a module-level `let` that
 * is only ever assigned from inside a callback.
 */
const floodSockets: WebSocket[] = [];

/**
 * Every request that reached the fixture, with the socket it arrived on.
 *
 * ⚠ **The only place a loopback connection the daemon let go of is visible at
 * all.** The daemon's end is a `ClientRequest` nothing outside `SecureSession`
 * holds, so *"the handle was dropped"* cannot be observed from this channel — from
 * the peer the session behaved perfectly. The listener keeps the far half, and a
 * socket nobody closed reads `destroyed: false` for as long as it is held.
 *
 * ⚠ **There used to be an `openOnArrival` flag here, and it was a constant.** It
 * was recorded as `!request.socket.destroyed` from inside the server's own
 * `"request"` listener — where a socket cannot be destroyed, because the request
 * was parsed off it a moment earlier — so it was `true` in every reachable path,
 * in every build, passing or failing. The two `&& left.openOnArrival` clauses it
 * fed were `&& true`, under a docblock claiming the assertion was that the flag
 * had *moved*. That is the same vacuous shape as `peer.ended || true` and as the
 * `FAILED` count, both of which this file has already had to write out and
 * remove — an assertion nothing could make fail, under prose describing one that
 * could.
 *
 * **The arrival is itself the proof the socket was up**: a `"request"` event
 * cannot fire on a destroyed one. So what the pair below rests on is the row
 * existing at all — with the url the frame named, on a socket of its own — read
 * against `destroyed` polled *afterwards*, which is the only half of the two that
 * can move. What `destroyed` alone proves is therefore the whole assertion and is
 * enough for it: the socket was up when the request arrived, and the question is
 * only whether the daemon let go of it.
 */
const arrivals: { url: string; socket: Socket }[] = [];

const fixture = createServer((request, response) => {
  arrivals.push({ url: request.url ?? "", socket: request.socket });
  echoes.push({
    url: request.url ?? "",
    authorization: request.headers.authorization,
    xTest: request.headers["x-test"],
  });
  // Never answered, and nothing here holds the response: the socket keeps it
  // alive, and the session's own teardown is what lets go of it.
  if (request.url?.startsWith("/slow") === true) return;
  /*
   * The opposite of `/echo`, and the only route here that reads a body at all.
   * The upload section needs a listener that *consumes* greedily, because the
   * branch it drives is `upstream.write()` answering `false` and then draining:
   * a listener that never read would stall at the first frame and the cycle count
   * it asserts on would be one. The byte total is answered back so the peer can
   * say the whole upload arrived rather than only that a status came.
   */
  if (request.url?.startsWith("/slurp") === true) {
    let read = 0;
    /*
     * ⚠ **`/slurp-slow` stalls on every chunk, and the upload section is worth
     * nothing without it.** The greedy arm below drains the loopback socket as
     * fast as the daemon writes it, and a 65518-byte write into a drained,
     * connected loopback socket completes synchronously in libuv — so
     * `state.length` is back to zero before `Writable.write()` computes its
     * answer and `upstream.write()` returns **true**. Measured with the greedy
     * arm and a paced writer: 2 backpressure cycles over 14 frames, against the
     * eleven a listener-leak warning needs. Pausing per chunk is what makes
     * `upstream.write()` answer false often enough for the thing being asserted
     * to be reachable at all.
     */
    const slow = request.url.startsWith("/slurp-slow");
    request.on("data", (chunk: Buffer) => {
      read += chunk.length;
      if (!slow) return;
      request.pause();
      // A real delay, not `setImmediate`: the kernel's loopback buffer is large,
      // and a listener that resumes on the next turn drains it before it can fill.
      // Measured with `setImmediate`: 1 backpressure cycle. With 5 ms it reaches
      // control below, which is what this number exists to keep honest.
      setTimeout(() => request.resume(), 5);
    });
    request.on("end", () => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ read }));
    });
    return;
  }
  response.writeHead(200, { "content-type": "application/json" });
  response.end(
    JSON.stringify({
      authorization: request.headers.authorization ?? null,
      xTest: request.headers["x-test"] ?? null,
    }),
  );
});

const fixtureSockets = new WebSocketServer({ noServer: true });
fixture.on("upgrade", (request, socket, head) => {
  fixtureSockets.handleUpgrade(request, socket, head, (ws) => {
    upgrades.push({ url: request.url ?? "", authorization: request.headers.authorization });
    ws.on("close", (code: number, reason: Buffer) => socketCloses.push({ code, reason: reason.toString("utf8") }));
    if (request.url?.startsWith("/big") === true) ws.send(BIG);
    if (request.url?.startsWith("/flood") === true) {
      floodSockets.push(ws);
      ws.on("message", () => {
        for (let i = 0; i < FLOOD_MESSAGES; i += 1) ws.send(BIG);
      });
    }
  });
});

await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve));
const fixtureLocal = { host: "127.0.0.1", port: (fixture.address() as AddressInfo).port };

let sinkDials = 0;
const sink = createServer((_request, response) => {
  response.writeHead(204);
  response.end();
});
sink.on("connection", () => {
  sinkDials += 1;
});
await new Promise<void>((resolve) => sink.listen(0, "127.0.0.1", resolve));
const sinkPort = (sink.address() as AddressInfo).port;
const elsewhere = `127.0.0.1:${sinkPort}`;

/*
 * Three distinct ports, and it is worth one assertion: the SSRF section is a
 * comparison between the address the daemon was given and the address the app
 * asked for, and two of these landing on the same port would make every refusal
 * below agree with every mistake.
 */
report(
  "the driver's own listener and the sink are up, on ports of their own",
  fixtureLocal.port > 0 && sinkPort > 0 && new Set([local.port, fixtureLocal.port, sinkPort]).size === 3,
  `daemon ${local.port}, fixture ${fixtureLocal.port}, sink ${sinkPort}`,
);

/**
 * Wait for something to become true, or give up and say it did not.
 *
 * Used in both directions, and the negative one is the point: *"nothing was
 * dialled"* is an absence, so it is asserted as a window that elapsed with the
 * counter still at zero rather than as a synchronous read that would have been
 * taken before a dial could have landed anyway.
 *
 * ⚠ **The poll timer is deliberately *not* `unref`'d**, unlike the long ones in
 * `Peer.until`. Those are backstops against a wait that never ends, and letting
 * the loop drain past them is the right answer; this one is the only thing keeping
 * the loop alive between two polls, so unreferencing it means a run where every
 * other handle happens to be closed exits **silently and successfully** in the
 * middle of the file rather than finishing it.
 */
async function settle(done: () => boolean, ms = 2_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!done() && Date.now() < deadline) await new Promise<void>((resolve) => setTimeout(resolve, 10));
  return done();
}

/**
 * Watch for the stderr write a leaked listener produces, for as long as the
 * caller is driving one.
 *
 * ⚠ **This is the defect stated in the words `CLAUDE.md` forbids it in.** Node's
 * `EventEmitter` calls `process.emitWarning` the moment an event's listener array
 * passes `defaultMaxListeners` (10), and the default handler prints it — so a
 * listener `src/e2ee.ts` registers per socket and never removes ends as *"nothing
 * in `src/` writes to stdout or stderr"* being false, in the process that owns
 * this machine's live agents. Adding a listener here does not replace Node's own,
 * so a regression still prints as well as failing.
 *
 * ⚠ **A window rather than a run-long listener, and that is not tidiness.**
 * `daemoncheck.ts` imports every other section into this same process and the
 * announce work runs after this file, so a listener left armed would report
 * somebody else's emitter under this file's assertion names. `stop` is called in
 * a `finally`-shaped position at the end of each block for the same reason.
 *
 * The message is carried out rather than a count, because the one thing a reader
 * needs from a failure is *which* emitter and *which* event crossed — the warning
 * names both.
 */
function watchListenerLeaks(): { leaks: string[]; stop: () => void } {
  const leaks: string[] = [];
  const onWarning = (warning: Error): void => {
    if (warning.name !== "MaxListenersExceededWarning") return;
    leaks.push(warning.message);
  };
  process.on("warning", onWarning);
  return {
    leaks,
    stop: () => process.off("warning", onWarning),
  };
}

/** The capability every session below presents, kept so its bytes can be asserted. */
const sessionCap = boundToken("u_ab", deviceThumbprint);

/* -- the refusal table, one arm at a time ------------------------------- */

/*
 * ⚠ **Five 400-class arms, and only the 401 was driven.**
 *
 * `handle()` is a table of refusals and every one of them exists because the
 * alternative was a throw out of the frame loop — which, as its own docblock
 * says, discards every frame behind it and wedges the session in silence. The
 * assertions are on the **reason** rather than the code: `dispatch`'s backstop
 * also fails with `400`, so a check that read the code alone would be green
 * whether the daemon refused the frame by name or crashed and was caught by the
 * net underneath. One session per arm, because `fail()` ends the one it is on.
 */

{
  const peer = await Peer.connect(device.secretKey);
  check("a session is established", await peer.hello(sessionCap), FRAME.READY);
  // A sealed frame with nothing in it: the tag is valid, so this is not a crypto
  // failure, and `decodeFrame` has no type byte to answer with.
  peer.write(new Uint8Array(0));
  check("an empty sealed frame is refused as an empty frame", await peer.failure(), { code: 400, reason: "empty frame" });
}

{
  // The 401 arm, now with its words rather than only its frame type — the table
  // is a sweep or it is a list, and the six arms are only complete together.
  const peer = await Peer.connect(device.secretKey);
  peer.write(encodeJsonFrame(FRAME.REQUEST, { method: "GET", path: "/health", headers: {}, body: false }));
  check("anything before a capability is refused, and says why", await peer.failure(), {
    code: 401,
    reason: "the first frame must present a capability",
  });
}

{
  /*
   * A `HELLO` carrying a JSON array. `decodeJson` refuses an array on purpose —
   * `[].capability` is `undefined`, not an error, so without that rule this
   * reaches the verifier as a capability of `undefined` and the refusal, if any,
   * happens somewhere further down.
   */
  const peer = await Peer.connect(device.secretKey);
  peer.write(encodeJsonFrame(FRAME.HELLO, ["a capability"]));
  check("a HELLO carrying a JSON array is unreadable rather than a capability", await peer.failure(), {
    code: 400,
    reason: "unreadable capability",
  });
}

{
  // A byte no frame constant names. Written as raw bytes rather than through
  // `encodeFrame`, which takes a `FrameType` and would need a cast to lie to.
  const peer = await Peer.connect(device.secretKey);
  check("a session is established", await peer.hello(sessionCap), FRAME.READY);
  peer.write(Uint8Array.of(0x7f));
  check("a frame type nothing names is refused, and names the byte", await peer.failure(), {
    code: 400,
    reason: "unexpected frame 127",
  });
}

{
  // `path` is read as a string three lines later and handed to a URL parser. A
  // number gets through `decodeJson` — it is JSON, and it is an object field.
  const peer = await Peer.connect(device.secretKey);
  check("a session is established", await peer.hello(sessionCap), FRAME.READY);
  peer.write(encodeJsonFrame(FRAME.REQUEST, { method: "GET", path: 7, headers: {}, body: false }));
  check("a request whose path is a number is refused", await peer.failure(), { code: 400, reason: "unreadable request" });
}

{
  const peer = await Peer.connect(device.secretKey);
  check("a session is established", await peer.hello(sessionCap), FRAME.READY);
  peer.write(encodeJsonFrame(FRAME.OPEN, {}));
  check("and an OPEN with no path at all is refused", await peer.failure(), { code: 400, reason: "unreadable open" });
}

/* -- a path the app chose, resolved rather than joined ------------------ */

/*
 * ⚠ **The highest-value section in this file.** The target used to be built by
 * concatenation — `` `ws://${host}:${port}${wanted.path}` `` — and a path
 * beginning `@` turns the daemon's own `host:port` into *userinfo*, which makes
 * the app's string the host. That is a full SSRF from any device holding a grant,
 * over the network, carrying `Authorization: Bearer <this session's capability>`:
 * the fleet's own credential, posted to an address the caller chose.
 *
 * `new URL` closes that door and opens two more, both of which begin with `/` and
 * both of which resolve to another origin — which is why the origin is
 * **compared** afterwards rather than trusted to the parser. The `/\` door is the
 * one to watch: it passes the `//` prefix check, so the comparison is the only
 * thing standing in front of it.
 *
 * Each door is asserted twice: the refusal, and — through a listener at the
 * address those paths name — that **nothing was dialled**. A guard that refused
 * the frame after the connection had already gone out would satisfy the first
 * assertion and none of the point. And the absence is asserted **against a dial
 * this driver makes itself**, one line above the frames: what that listener counts
 * has to be shown to move, or "nothing was dialled" is a sentence about a variable
 * rather than about the daemon.
 */

{
  const base = `ws://${local.host}:${local.port}`;
  /*
   * The controls, and they are measurements of this runtime's parser rather than
   * descriptions of it. Without them the section below is three refusals of three
   * strings that might have been harmless all along.
   */
  check("the concatenated form reads the daemon's own host:port as userinfo", new URL(`${base}@${elsewhere}/x`).host, elsewhere);
  check("a reference beginning // resolves to another origin", new URL(`//${elsewhere}/x`, base).host, elsewhere);
  check("and so does one beginning /\\, which is not caught by a // prefix check", new URL(`/\\${elsewhere}/x`, base).host, elsewhere);
  check("while the path of an honest request stays on the daemon's own origin", new URL("/health", base).host, `${local.host}:${local.port}`);
}

{
  /*
   * ⚠ **The other control, and the section was vacuous without it.** `sinkDials`
   * has exactly one writer — `sink.on("connection")` — and **nothing else in this
   * file ever raised it**, in any run, passing or failing. So the report below was
   * `!(await settle(() => 0 > 0))`: green whether the origin comparison held or
   * the sink was bound to a port nobody named, closed early, or listening for an
   * event name `net` no longer emits. Green for ever, over a daemon posting
   * `Authorization: Bearer <this session's capability>` to an address the app
   * chose — which is what the docblock above calls the highest-value section in
   * this file. Every neighbour builds its control by hand; this one did not.
   *
   * Dialled with `http.request`, the call `startRequest` itself makes, at the
   * literal string those six frames name. `agent: false` so the socket is not
   * pooled and cannot be handed to anything later, and the counter is put back to
   * zero so the negative half below measures the frames rather than this.
   */
  const answered = await new Promise<number>((resolve) => {
    const probe = httpRequest(`http://${elsewhere}/x`, { agent: false }, (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    probe.on("error", () => resolve(0));
    probe.end();
  });
  check("the control: a dial at that address is answered by the sink", answered, 204);
  report(
    "and it moved the counter, so \"nothing was dialled\" is an observable rather than a constant",
    await settle(() => sinkDials === 1, 250),
    `${sinkDials} connection(s) to ${elsewhere}`,
  );
  sinkDials = 0;
}

for (const path of [`@${elsewhere}/x`, `//${elsewhere}/x`, `/\\${elsewhere}/x`]) {
  {
    const peer = await Peer.connect(device.secretKey);
    check("a session is established", await peer.hello(sessionCap), FRAME.READY);
    peer.write(encodeJsonFrame(FRAME.OPEN, { path }));
    check(`OPEN ${path} is refused`, await peer.failure(), { code: 400, reason: "unreadable open" });
  }
  {
    const peer = await Peer.connect(device.secretKey);
    check("a session is established", await peer.hello(sessionCap), FRAME.READY);
    peer.write(encodeJsonFrame(FRAME.REQUEST, { method: "GET", path, headers: {}, body: false }));
    check(`REQUEST ${path} is refused`, await peer.failure(), { code: 400, reason: "unreadable request" });
  }
}

// Zero here is the counter the control above put back, not a counter nothing has
// ever raised — which is the whole difference between this line and what it was.
report(
  "and nothing was dialled at the address those six frames named",
  !(await settle(() => sinkDials > 0, 250)),
  `${sinkDials} connections to ${elsewhere} in 250 ms`,
);

/* -- one connection, one thing at a time -------------------------------- */

/*
 * ⚠ **Protocol law, and this is the end that has to enforce it.** `frames.ts`
 * says there is no stream id and no multiplexer, and the app's own `Connection`
 * holds the rule with a throw before it writes anything — but that is the polite
 * end. Here a second `REQUEST` or `OPEN` used to overwrite `upstream`, `socket`
 * and `requestBody`, which **orphans** whatever the first was driving: nothing can
 * reach it to destroy it any more, so a peer that sends `OPEN` twice leaves a
 * loopback socket alive with nobody holding it, and two answers interleave on one
 * wire with nothing to tell them apart.
 */

{
  const peer = await Peer.connect(device.secretKey, fixtureLocal);
  check("a session against the driver's own listener", await peer.hello(sessionCap), FRAME.READY);
  // `/slow` never answers, so the first request is still in flight for certain
  // when the second arrives — the alternative is racing a loopback round trip.
  peer.write(encodeJsonFrame(FRAME.REQUEST, { method: "GET", path: "/slow", headers: {}, body: false }));
  peer.write(encodeJsonFrame(FRAME.REQUEST, { method: "GET", path: "/echo", headers: {}, body: false }));
  check("a second request on a connection already carrying one is refused", await peer.failure(), {
    code: 400,
    reason: "this connection is already carrying something",
  });
}

{
  const peer = await Peer.connect(device.secretKey, fixtureLocal);
  check("a session against the driver's own listener", await peer.hello(sessionCap), FRAME.READY);
  check("the first socket opens", await peer.open("/idle"), FRAME.OPENED);
  peer.write(encodeJsonFrame(FRAME.OPEN, { path: "/idle" }));
  check("and a second OPEN on the same connection is refused rather than orphaning the first", await peer.failure(), {
    code: 400,
    reason: "this connection is already carrying something",
  });
}

/* -- a refusal stops the connection reading ------------------------------ */

/*
 * ⚠ **`fail()` guarded on `closed`, which `fail()` does not set.** It leaves the
 * session up for `FAIL_FLUSH_TIMEOUT_MS` so the `FAILED` frame flushes, and
 * `consume`'s per-message guard read the same flag — so every frame already
 * pulled out of the same TCP chunk by `LengthReader` was still decrypted and
 * **dispatched after the refusal**, which for an `OPEN` means a WebSocket the
 * session has already refused to carry.
 *
 * ⚠ **What this may not assert is the count of `FAILED` frames.** The first
 * spelling did, and it was vacuous: `fail()` calls `stream.end()`, so a second
 * refusal never reaches the peer whether or not the loop stopped — one frame
 * crosses either way. Proven by reverting the guard and watching the check stay
 * green. The observable that moves is the *fixture*: an `OPEN` dispatched after
 * a refusal upgrades a real socket on the other side of the loopback hop, and
 * `upgrades` records it. The positive control below is what makes the negative
 * one mean anything.
 *
 * The `Peer.refusals()` accessor that made that count a one-liner went with it,
 * and so did the tally behind it. Nothing had called either since, and a helper
 * whose only caller was a vacuous assertion is how the assertion comes back.
 */
{
  const peer = await Peer.connect(device.secretKey, fixtureLocal);
  check("a session against the driver's own listener", await peer.hello(sessionCap), FRAME.READY);
  check("the control: an OPEN on its own reaches the listener", await peer.open("/control-open"), FRAME.OPENED);
  report(
    "and the fixture recorded it, so this is an observable that moves",
    upgrades.some((u) => u.url === "/control-open"),
    `${upgrades.length} upgrade(s)`,
  );
}

{
  /*
   * The refusal is an unreadable `REQUEST` rather than a stray body frame,
   * because a stray body frame is no longer a refusal — see the arm's own
   * docblock and the section below. What is being measured here is the *loop*,
   * so any refusal will do; this one is the cheapest that cannot be mistaken for
   * something the app does by accident.
   */
  const peer = await Peer.connect(device.secretKey, fixtureLocal);
  check("a session against the driver's own listener", await peer.hello(sessionCap), FRAME.READY);
  peer.writeAll(
    encodeFrame(FRAME.REQUEST, new TextEncoder().encode("{not json")),
    encodeJsonFrame(FRAME.OPEN, { path: "/after-refusal" }),
  );
  check("an unreadable request is refused", await peer.failure(), { code: 400, reason: "unreadable request" });
  report(
    "and the OPEN behind it in the same chunk was never dispatched",
    !(await settle(() => upgrades.some((u) => u.url === "/after-refusal"), 250)),
    `${upgrades.filter((u) => u.url === "/after-refusal").length} upgrade(s) for a refused session`,
  );
}

/*
 * ⚠ **A late body frame is IGNORED, and this is the assertion that a refusal
 * here would be a bug.** The first spelling of the `carrying` guard refused the
 * session, and it broke an ordinary client: the app's send loop exits on
 * `failure` or `closed` and `RESPONSE_END` is neither, so any listener that
 * answers before reading the body — `uploads.ts`'s per-session cap, its rate
 * check, any 401/404/405 on a `body: true` request — left the app writing frames
 * into a connection whose `carrying` had already gone back to `"none"`, and tore
 * down a session that was holding the app's answer. Reachable by uploading one
 * attachment past the cap with a body over 65518 bytes.
 *
 * It is safe to ignore them only because `response.on("end")` now `destroy()`s
 * the request handle instead of releasing it, so there is no writable socket for
 * the bytes to be smuggled onto. Both halves are needed and this asserts the
 * pair: the frames are dropped AND the session is still usable afterwards.
 */
{
  const peer = await Peer.connect(device.secretKey);
  check("a session is established", await peer.hello(sessionCap), FRAME.READY);
  check("an ordinary request is answered", (await peer.request("GET", "/health")).status, 200);
  peer.write(encodeFrame(FRAME.REQUEST_BODY, new TextEncoder().encode("late")));
  peer.write(encodeFrame(FRAME.REQUEST_END));
  // The whole point: no refusal, and the connection is still good for the next
  // request — which is what an app holding a 413 goes on to do.
  check("a body frame arriving after the answer is dropped rather than refused", (await peer.request("GET", "/health")).status, 200);
  report("and the session was never failed", !peer.ended, peer.ended ? "the stream ended" : "still open");
}

/*
 * The one shape that IS still a refusal. Nothing legitimate sends a body frame
 * on a connection carrying a socket, and the pipelining hole the `carrying` rule
 * exists for is what it would be reaching for.
 */
{
  const peer = await Peer.connect(device.secretKey, fixtureLocal);
  check("a session against the driver's own listener", await peer.hello(sessionCap), FRAME.READY);
  check("the socket opens", await peer.open("/idle"), FRAME.OPENED);
  peer.write(encodeFrame(FRAME.REQUEST_BODY, new TextEncoder().encode("a")));
  check("a body frame on a connection carrying a socket is refused", await peer.failure(), {
    code: 400,
    reason: "this connection is carrying a socket",
  });
}

/* -- a request the listener answered without reading --------------------- */

/*
 * ⚠ **The answer being over is not the request being over.** `response.on("end")`
 * puts `upstream`, `upstreamRequest`, `requestBody` and `carrying` back — right
 * for a request that is finished and wrong for one that is not. A `REQUEST`
 * declaring `body: true` whose route answers *without reading the body* — a 404, a
 * 401, a 405, an early 413 on an upload, and every upload the app abandons — ends
 * the response while the `ClientRequest` is still writable, and letting go of the
 * handle there put its loopback socket beyond `destroy()`'s reach:
 * `this.upstreamRequest?.destroy()` finds `null` and nothing else is coming, so
 * one descriptor is held until `UPSTREAM_IDLE_TIMEOUT_MS` two minutes later, in
 * the process that owns this machine's live agents.
 *
 * ⚠ **The first `REQUEST_BODY` frame is not optional, and that is a fact about
 * this runtime rather than a flourish.** Measured on node 26.3.0: a
 * `ClientRequest` with no `write` and no `end` never flushes its head at all — 600
 * ms after the call the listener has seen nothing, and it sees the request the
 * instant one byte is written. So the case begins at the first byte of the body
 * rather than at the frame that declares one, and a driver sending only the
 * `REQUEST` would sit waiting on an answer no listener had been asked for.
 *
 * ⚠ **Neither half may be counted on this side of the hop.** From the peer the
 * session behaved perfectly — 200, `RESPONSE_END`, nothing to see — which is the
 * same trap as the `FAILED` count above. The observable is the **listener's** own
 * end of that socket, and the request that *did* finish is the pair that says the
 * fix is targeted rather than a blanket teardown of every answered request.
 */

{
  const before = arrivals.length;
  const unfinished = await Peer.connect(device.secretKey, fixtureLocal);
  check("a session against the driver's own listener", await unfinished.hello(sessionCap), FRAME.READY);
  unfinished.write(encodeJsonFrame(FRAME.REQUEST, { method: "POST", path: "/echo", headers: {}, body: true }));
  unfinished.write(encodeFrame(FRAME.REQUEST_BODY, new TextEncoder().encode("a")));
  const answered = await unfinished.collect();
  check("a request whose body the listener never reads is answered anyway", answered.status, 200);
  check("and that answer is marked whole rather than given up on", answered.ended, FRAME.RESPONSE_END);

  const finished = await Peer.connect(device.secretKey, fixtureLocal);
  check("a session against the driver's own listener", await finished.hello(sessionCap), FRAME.READY);
  check("and so is one that declared no body at all", (await finished.request("POST", "/echo")).status, 200);

  const left = arrivals.at(-2);
  const done = arrivals.at(-1);
  report(
    "the control: both reached the listener, on sockets of their own",
    left !== undefined &&
      done !== undefined &&
      arrivals.length === before + 2 &&
      left.url === "/echo" &&
      done.url === "/echo" &&
      left.socket !== done.socket,
    `${arrivals.length - before} arrival(s), ${left?.socket === done?.socket ? "one socket" : "two sockets"}`,
  );

  unfinished.hangUp();
  finished.hangUp();

  /*
   * Worded as an outliving rather than as a moment, deliberately: what has to be
   * true is that the descriptor is not held, and a later fix that kept the handle
   * reachable until teardown instead of destroying it at `"end"` would satisfy
   * this and should.
   */
  report(
    "the loopback socket of the request nobody finished does not outlive the session",
    await settle(() => left?.socket.destroyed === true, 1_000),
    left?.socket.destroyed === true ? "closed" : "still open, two minutes short of the idle bound",
  );
  report(
    "while the one the daemon did finish is left for the pool",
    done?.socket.destroyed === false,
    done?.socket.destroyed === true ? "closed" : "still open",
  );
}

/* -- a close code the socket library would have thrown on --------------- */

/*
 * ⚠ **Measured on ws 8.21.3, and reachable from a number the app wrote.**
 * `WebSocket.close` validates through `Sender.close` and answers
 * `TypeError("First argument must be a valid error code number")` for anything
 * outside its table — so `{"code":1005}` or `{"code":9999}` in a `CLOSE` frame is
 * a throw out of the frame loop, from a value that arrived over the network.
 *
 * The reason string is what makes this assertion mean anything: "unusable close
 * code" is `isCloseCode` refusing by name, while "unusable frame" is `dispatch`'s
 * backstop catching the `TypeError` — the defect and the net under it, both `400`.
 * And the session ends either way, because that is what `fail()` does; what the
 * fresh session at the bottom asserts is that the **daemon** carried on, which is
 * the half a crash would have taken with it.
 */

for (const code of [1005, 9999]) {
  const peer = await Peer.connect(device.secretKey, fixtureLocal);
  check("a session against the driver's own listener", await peer.hello(sessionCap), FRAME.READY);
  check("the socket opens", await peer.open("/idle"), FRAME.OPENED);
  peer.write(encodeJsonFrame(FRAME.CLOSE, { code, reason: "" }));
  check(`a CLOSE carrying ${code} is refused by name rather than thrown on`, await peer.failure(), {
    code: 400,
    reason: "unusable close code",
  });
}

{
  // The other half of the same arm: `ws` answers `RangeError("The message must
  // not be greater than 123 bytes")`, because a close reason rides in a control
  // frame. Refused whole rather than clamped — a close this end rewrote is not
  // the close the app asked for.
  const peer = await Peer.connect(device.secretKey, fixtureLocal);
  check("a session against the driver's own listener", await peer.hello(sessionCap), FRAME.READY);
  check("the socket opens", await peer.open("/idle"), FRAME.OPENED);
  peer.write(encodeJsonFrame(FRAME.CLOSE, { code: 1000, reason: "r".repeat(124) }));
  check("and a close reason above what a control frame holds is refused too", await peer.failure(), {
    code: 400,
    reason: "unusable close reason",
  });
}

{
  /*
   * The positive control, and the section is vacuous without it: a `CLOSE` arm
   * that refused *everything* would satisfy all three assertions above. A
   * registered code has to reach the socket unchanged, because `stream.ts`'s
   * close-code table is the client's whole model of why a stream ended.
   */
  const peer = await Peer.connect(device.secretKey, fixtureLocal);
  check("a session against the driver's own listener", await peer.hello(sessionCap), FRAME.READY);
  check("the socket opens", await peer.open("/idle"), FRAME.OPENED);
  peer.write(encodeJsonFrame(FRAME.CLOSE, { code: 4001, reason: "bye" }));
  report(
    "while a registered code reaches the socket whole",
    await settle(() => socketCloses.some((closed) => closed.code === 4001 && closed.reason === "bye")),
    JSON.stringify(socketCloses.at(-1) ?? null),
  );
}

{
  // And the daemon is still answering. `fail()` ends the session that sent the bad
  // frame — that is the discipline, not the damage — so what is asserted here is
  // that nothing above took the process's frame loops with it.
  const peer = await Peer.connect(device.secretKey);
  check("a session opened after all of those refusals still completes", await peer.hello(sessionCap), FRAME.READY);
  check("and the daemon answers it exactly as before", (await peer.request("GET", "/health")).status, 200);
}

/* -- the credential on an inner request --------------------------------- */

/*
 * ⚠ **The channel proved which device is calling, so the channel's capability is
 * the one the inner request carries** — and a client-supplied `authorization` is
 * **deleted**, case-insensitively, rather than merged or preferred. Binding only
 * at the handshake would mean one capability opening the session and another
 * doing the work, which is the kind of gap that reads as fine until somebody
 * looks at it.
 *
 * No driver had ever sent a header of any kind through a channel, so both halves
 * of that rule — the strip and the pin — were prose. The header sent here is a
 * *real* capability for a different subject on a different device, because the
 * failure this prevents is privilege escalation rather than untidiness.
 */

{
  const stolen = boundToken("u_abcd", strangerThumbprint);
  const peer = await Peer.connect(device.secretKey, fixtureLocal);
  check("a session against the driver's own listener", await peer.hello(sessionCap), FRAME.READY);

  const answer = await peer.request("GET", "/echo", {
    // Two spellings, because the strip compares `name.toLowerCase()` and a strip
    // that matched the wire form alone would pass the first and carry the second.
    Authorization: `Bearer ${stolen}`,
    AUTHORIZATION: `Bearer ${stolen}`,
    "X-Test": "keep",
  });
  check("the request is answered", answer.status, 200);

  const echoed = JSON.parse(answer.body) as { authorization: string | null; xTest: string | null };
  check("the listener saw the capability this channel authenticated", echoed.authorization, `Bearer ${sessionCap}`);
  report("and never the one the request carried", !answer.body.includes(stolen), `${stolen.length} bytes of somebody else's capability, dropped`);
  check("while an unrelated header is carried through untouched", echoed.xTest, "keep");
  report("with the daemon's own listener seeing one authorization rather than two", echoes.at(-1)?.authorization === `Bearer ${sessionCap}`, echoes.at(-1)?.authorization?.slice(0, 16) ?? "(none)");
}

{
  /*
   * The same rule on the socket leg, where it also retires `?token=`. A browser
   * cannot set a header on a WebSocket handshake, which is the whole reason the
   * daemon reads a credential out of the query string at all — and `SECURITY.md`
   * lists that as a leak path, because a query string is what ends up in a log.
   * This hop is made by Node, so it carries a header like any other request.
   */
  const peer = await Peer.connect(device.secretKey, fixtureLocal);
  check("a session against the driver's own listener", await peer.hello(sessionCap), FRAME.READY);
  check("the socket opens", await peer.open("/idle"), FRAME.OPENED);
  check("a socket carries the same capability in a header", upgrades.at(-1)?.authorization, `Bearer ${sessionCap}`);
  check("and nothing in its URL", upgrades.at(-1)?.url.includes("token="), false);
}

/* -- a message larger than one frame ------------------------------------ */

/*
 * ⚠ **The whole of the reassembly fix, end to end.** `MESSAGE` frames are cut to
 * `MAX_FRAME_PAYLOAD`, and a receiver with no terminator raised each one as its
 * own message: the daemon sends an event batch as one WebSocket message of up to
 * `BATCH_MAX_BYTES` (512 KiB) and a control snapshot measured around 93 KB, both
 * far above 65518, so on the encrypted path those arrived as eight — or two —
 * different messages, each one JSON cut mid-token. `stream.ts` drops what it
 * cannot parse **and leaves the cursor where it was**, so the next reconnect asked
 * for the same batch, split it the same way and dropped it again: a transcript
 * that stalls for good, with nothing logged, on big sessions only, and only away
 * from loopback.
 *
 * So the assertion is the one the defect would have failed: 200 000 bytes in, one
 * whole message out, and `JSON.parse` succeeding on it. The chunk count beside it
 * is the non-vacuity control — a message that fitted in one frame would satisfy
 * every line of this and prove nothing.
 */

{
  const peer = await Peer.connect(device.secretKey, fixtureLocal);
  check("a session against the driver's own listener", await peer.hello(sessionCap), FRAME.READY);
  check("the socket opens", await peer.open("/big"), FRAME.OPENED);

  const message = await peer.message();
  report("the message crossed the channel in several frames", message.chunks.length > 1, `${message.chunks.length} × up to ${MAX_FRAME_PAYLOAD} bytes`);
  check("and arrived as one whole message", message.bytes?.length ?? -1, 200_000);

  const text = new TextDecoder().decode(message.bytes ?? new Uint8Array(0));
  let parsed: { pad: string } | null = null;
  try {
    parsed = JSON.parse(text) as { pad: string };
  } catch {
    // Left as `null`, which is the assertion below. This is the failure the
    // terminator exists to prevent, and it is what a client saw before it.
    parsed = null;
  }
  report("whose JSON parses", parsed !== null, parsed === null ? text.slice(0, 40) : `pad is ${parsed.pad.length} characters`);
  report("with the character that straddled the chunk boundary intact", parsed?.pad.includes("é") === true, "no U+FFFD where é was");

  /*
   * The control, and it is what says the bytes-not-text rule is load-bearing here
   * rather than in theory: decoding each chunk as it arrives — the obvious
   * implementation — replaces the character split across the boundary, and the
   * result is still valid JSON, so nothing downstream could have noticed.
   */
  const perChunk = message.chunks.map((chunk) => new TextDecoder().decode(chunk)).join("");
  report("while a client that decoded each chunk on arrival would have corrupted it silently", perChunk !== text && perChunk.includes("�"), "U+FFFD where é was");
}

/* -- a socket the app has stopped reading -------------------------------- */

/*
 * ⚠ **The daemon's own outbound queue is the thing with no ceiling.** On the
 * direct path a stalled client raises `raw.bufferedAmount` past
 * `SOCKET_HIGH_WATER`, `flush` stops, the queue grows and `MAX_QUEUE_BYTES`
 * collapses the socket with `lagged{slow_consumer}`. On the encrypted path the
 * loopback `ws` client inside `openSocket` drains greedily, so `bufferedAmount`
 * stays near zero, that ceiling never fires, and the bytes pile up instead in the
 * relay Duplex's unbounded writable buffer — inside the process that owns this
 * machine's live agents, against a phone whose h2 window is shut.
 *
 * ⚠ **This side of the hop cannot see it.** Every frame is written whether the
 * daemon pauses or not; the difference is only *when*. So no count this peer keeps
 * moves at all — the `FAILED` count's trap, only sharper, since there the refusal
 * at least closed the channel. The observable is {@link Peer.outboundQueued},
 * which is `stream.writableLength` and is readable here only because this driver
 * built the pipe the daemon was handed.
 *
 * Measured on this runtime in exactly this shape, with the Noise sealing left out
 * so the figures are the payloads themselves: with the pause the queue peaks at
 * 668 968 bytes and the listener still holds 4 400 220 of the 4 800 000 it was
 * told to send; with the three lines of the guard taken out it peaks at 4 668 988
 * and the listener holds none. Both settle, so neither run is racing a clock.
 *
 * `bufferedAmount` is printed and **not** asserted, because it is the half a
 * kernel can absorb — a large autotuned receive buffer would take the backlog
 * without the daemon ever emitting it. `peak` counts what the daemon *wrote*,
 * which is the buffer-immune half.
 */

{
  const peer = await Peer.connect(device.secretKey, fixtureLocal);
  check("a session against the driver's own listener", await peer.hello(sessionCap), FRAME.READY);
  /*
   * ⚠ **Read before the socket exists, because a bare `listenerCount("drain")`
   * is green in every build whose fixture never reaches backpressure.** The
   * `"drain"` listener the pause hangs its resume on is only ever *added* under
   * backpressure, so an assertion that it is absent, or that it is gone, passes
   * over code that removes nothing at all — the vacuous shape, again, that
   * `peer.ended || true` and the `FAILED` count were. The three sentences below
   * are the answer: the count
   * before the pause, the count across it, and the count after the resume, each
   * reported on its own so a failure says which half broke.
   *
   * A measured baseline rather than zero, because the response path registers on
   * the same event (`src/e2ee.ts`'s `response.on("data")` pauses the loopback
   * response the same way) and this peer has already been handed a `READY`.
   */
  const drainBaseline = peer.streamListeners("drain");
  check("the socket opens", await peer.open("/flood"), FRAME.OPENED);

  // The pause first, then the trigger: a flood that starts before the peer has
  // stopped reading races the drain and measures the clock rather than the guard.
  peer.stopReading();
  peer.write(encodeFrame(FRAME.MESSAGE, new TextEncoder().encode("go")));
  peer.write(encodeFrame(FRAME.MESSAGE_END));

  /*
   * Polled to a settled value rather than sampled once. Nothing drains a peer that
   * has stopped reading, so the queue only ever grows: stopping after twenty
   * identical reads means `peak` is the figure it came to rest at rather than
   * whatever a single read happened to catch, in both directions. The `peak === 0`
   * clause is what keeps it from settling on the loopback round trip it has not
   * made yet — twenty polls of zero is 200 ms, and a driver that reported `0` for
   * a flood still in flight would be the vacuity this section exists to avoid.
   */
  let peak = 0;
  let steady = 0;
  let last = -1;
  // Sampled in the same loop as the queue, because the listener exists only while
  // the socket is paused: a read taken before the flood lands, or after the peer
  // starts reading again, finds nothing and says nothing.
  let peakDrain = drainBaseline;
  for (let poll = 0; poll < 600 && (peak === 0 || steady < 20); poll += 1) {
    const queued = peer.outboundQueued;
    peak = Math.max(peak, queued);
    peakDrain = Math.max(peakDrain, peer.streamListeners("drain"));
    steady = queued === last && queued > 0 ? steady + 1 : 0;
    last = queued;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }

  const flooded = FLOOD_MESSAGES * Buffer.byteLength(BIG);
  const held = floodSockets.at(-1)?.bufferedAmount ?? 0;
  report(
    "the control: the queue passed the mark the pause is keyed on",
    peak > MAX_FRAME_PAYLOAD * 8,
    `${peak} bytes queued, against a mark of ${MAX_FRAME_PAYLOAD * 8}`,
  );
  report(
    "and stopped there rather than taking the whole flood",
    peak < flooded / 2,
    `${peak} of ${flooded} bytes, with ${held} still on the listener's side`,
  );
  /*
   * The control for the two lines under it. Without this one they are a pair of
   * bounds on a listener that was never registered — green over a build with no
   * pause branch at all, which is exactly what the queue assertions above are
   * here to catch and exactly what these must not duplicate the blindness of.
   */
  report(
    "the control: the pause hung its resume on the stream's own drain",
    peakDrain > drainBaseline,
    `${peakDrain} drain listener(s) while paused, from a baseline of ${drainBaseline}`,
  );
  /*
   * One outstanding resume, however many messages piled up behind it. The
   * `socketPaused ||` guard in `openSocket`'s `"message"` listener is what holds
   * this: a registration that went around it would hang one `once("drain")` per
   * flooded message, and this reports the peak it reached rather than a boolean.
   */
  report(
    "and one only, however many messages piled up behind it",
    peakDrain <= drainBaseline + 1,
    `${peakDrain} at the peak, against ${drainBaseline + 1} for a single outstanding resume`,
  );

  /*
   * Two jobs, and the second is why this is not optional. It is the guard against
   * a pause with no resume — the resume rides on one `stream.once("drain")`, which
   * fires exactly once — **and** it is the non-vacuity control for the bound above
   * it: without it, `peak < flooded / 2` would be satisfied by a flood that was
   * never poured at all.
   */
  peer.startReading();
  let whole = 0;
  for (let i = 0; i < FLOOD_MESSAGES; i += 1) {
    const message = await peer.message();
    // Stopped at the first short one rather than waiting out a four-second timeout
    // per message: what is being reported is how far it got.
    if (message.bytes?.length !== Buffer.byteLength(BIG)) break;
    whole += 1;
  }
  report(
    "and every message arrives once the peer reads again",
    whole === FLOOD_MESSAGES,
    `${whole} of ${FLOOD_MESSAGES} whole messages`,
  );

  /*
   * The third sentence, and the one that says `once` is still `once`. A `"drain"`
   * handler registered with `on` would resume correctly on every build and leave
   * a listener behind on every cycle, which is invisible to every assertion above
   * it and ends as the stderr write {@link watchListenerLeaks} describes.
   *
   * A bounded wait rather than a synchronous read, because the last pause of the
   * flood can be registered after the twenty-fourth message has been reassembled
   * and its drain arrives a tick later.
   */
  report(
    "and nothing is left on drain once the resume has fired",
    await settle(() => peer.streamListeners("drain") === drainBaseline, 1_000),
    `${peer.streamListeners("drain")} drain listener(s), from a baseline of ${drainBaseline}`,
  );
}

/* -- what a socket and an upload have to give back ----------------------- */

/*
 * ⚠ **A listener that is never taken off is a stderr write originating in
 * `src/`**, which is the one thing `CLAUDE.md` forbids outright — two sanctioned
 * exceptions, neither of them this file's subject. `EventEmitter` calls
 * `process.emitWarning` once an event's listener array passes
 * `defaultMaxListeners` (10) and the default handler prints it, in the process
 * that owns this machine's live agents.
 *
 * `src/e2ee.ts` has the defect through two doors and both are recorded there as
 * measurements:
 *
 * - `openSocket` registers `stream.once("close", resumeSocket)` **per socket**, on
 *   a stream that outlives every socket on it — `socket.on("close")` puts
 *   `carrying` back to `"none"`, so a peer may `OPEN`/`CLOSE` all session long.
 *   Measured there: fourteen legal cycles took the count from one to fifteen and
 *   the eleventh printed the warning. The fix is the `off("close", …)` pair at the
 *   bottom of that same handler.
 * - the upload path registers `upstream.once("close", resume)` **once**, outside
 *   the pause branch, for the same reason in the other direction: `drain` is
 *   consumed each cycle and `close` is not, and a 10 MiB upload is ~160 cycles.
 *
 * Neither had an assertion. **And neither can be measured from the far side of
 * the loopback hop** — the session answers perfectly either way, which is the
 * `FAILED`-count trap this file has already had to write out and remove. The observables
 * are {@link Peer.streamListeners}, readable only because this driver built the
 * pipe the daemon was handed, and the warning itself through
 * {@link watchListenerLeaks}. Both, because a count says *which* half broke and
 * the warning says the defect in the words that make it forbidden.
 *
 * ⚠ **What is deliberately NOT asserted here**: that
 * `off("drain", resumeSocket)` removes an *outstanding* drain listener. Its only
 * distinct case is a socket closing while it is paused, and that is unreachable
 * inside this driver's timeouts — read off the installed library, ws 8.21.3:
 * `close()` sends the close frame and only calls `_socket.end()` once
 * `_closeFrameReceived`, which needs the socket to be reading, while `pause()` is
 * `_socket.pause()`; `setCloseTimer`'s 30 s default then governs, which is past
 * every `settle` here and past `Peer.until`'s 4 s backstop. In the flow this
 * section *can* reach the drain has already fired and consumed the listener, so a
 * check there would be green for the wrong reason — the shape this whole section
 * exists to stop shipping. The `drain` half is asserted where it is reachable, in
 * the flood block above.
 */

/** OPEN/CLOSE cycles, the count `src/e2ee.ts`'s own measurement was taken at. */
const SOCKET_CYCLES = 14;

/**
 * Body frames the upload block sends, at {@link MAX_FRAME_PAYLOAD} each.
 *
 * Above `defaultMaxListeners`, deliberately and by enough to be legible: the
 * whole point of the leak assertion beside it is that the misplaced registration
 * crosses the threshold that prints, and a count of ten would leave it green over
 * the defect.
 */
// Enough frames that the loopback socket buffer fills against a listener stalling
// 5 ms per chunk, which is what makes repeated backpressure reachable at all.
const UPLOAD_FRAMES = 14;

{
  const peer = await Peer.connect(device.secretKey, fixtureLocal);
  check("a session against the driver's own listener", await peer.hello(sessionCap), FRAME.READY);

  /*
   * Measured rather than written down as `1`. The daemon's constructor registers
   * one `"close"` on this stream for its own teardown, `Duplex.from` may hold
   * more of its own, and `src/e2ee.ts` is under edit beside this for an unrelated
   * dial timeout — so what is asserted is a **delta and a return**, never a
   * literal. A constant per-socket cost that changes legitimately moves
   * `perSocket` with it; accumulation still fails, which is the property.
   */
  const baseline = peer.streamListeners("close");
  const watch = watchListenerLeaks();

  check("the first socket opens", await peer.open("/idle"), FRAME.OPENED);
  const perSocket = peer.streamListeners("close") - baseline;
  /*
   * The control, and without it every line below is green over a build that
   * registers nothing at all — the shape the brief names: a skipped item does not
   * lower a count, it fails to raise it.
   */
  report(
    "the control: a socket hangs a listener on a stream it did not make",
    perSocket > 0,
    `${perSocket} close listener(s) per socket, over a baseline of ${baseline}`,
  );
  check("and closing it is answered with the daemon's own CLOSE", await peer.closeSocket(), FRAME.CLOSE);
  report(
    "and the listener comes off with the socket",
    peer.streamListeners("close") === baseline,
    `${peer.streamListeners("close")} after one cycle, from a baseline of ${baseline}`,
  );

  let cycles = 1;
  let peak = peer.streamListeners("close");
  while (cycles < SOCKET_CYCLES) {
    if ((await peer.open("/idle")) !== FRAME.OPENED) break;
    peak = Math.max(peak, peer.streamListeners("close"));
    if ((await peer.closeSocket()) !== FRAME.CLOSE) break;
    peak = Math.max(peak, peer.streamListeners("close"));
    cycles += 1;
  }

  /*
   * The non-vacuity control for the two bounds under it: a loop that broke on its
   * third cycle would satisfy both while having measured almost nothing, and this
   * is the line that says how far it actually got.
   */
  report(
    `${SOCKET_CYCLES} legal OPEN/CLOSE cycles on one session`,
    cycles === SOCKET_CYCLES,
    `${cycles} of ${SOCKET_CYCLES}`,
  );
  report(
    "leave the count where they found it",
    peer.streamListeners("close") === baseline,
    `${peer.streamListeners("close")} close listener(s), from a baseline of ${baseline}`,
  );
  report(
    "and never took it above what one socket costs",
    peak <= baseline + perSocket,
    `peak ${peak}, against ${baseline + perSocket} for one socket at a time`,
  );
  /*
   * Said in the words that make it a defect. With the `off("close", …)` removed
   * the count climbs one per cycle and crosses `defaultMaxListeners` (10) well
   * inside these fourteen — `openSocket`'s own docblock puts the warning at the
   * eleventh, from a baseline of one. So this fails with the emitter and the event
   * named in its own detail, and Node prints the same thing to stderr beside it,
   * which is the symptom being forbidden rather than a proxy for it.
   */
  report(
    "with nothing in src/ printing a listener-leak warning along the way",
    watch.leaks.length === 0,
    watch.leaks[0] ?? "no MaxListenersExceededWarning",
  );
  /*
   * And the cycles were traffic rather than a limping session: a cycle that left
   * `carrying` stuck at `"socket"` refuses this with
   * "already carrying something" instead of opening.
   */
  check("and the session still opens a socket afterwards", await peer.open("/idle"), FRAME.OPENED);
  watch.stop();
}

{
  /*
   * The other door, on the way up. `/slurp` is the only route on this fixture that
   * reads a body, and it has to: the branch being driven is `upstream.write()`
   * answering `false` and then draining, which needs a listener that consumes.
   *
   * ⚠ **The frames are paced against {@link Peer.inboundPauses} rather than
   * written in one burst, and that is what makes the cycle count real.** `consume`
   * dispatches every frame `LengthReader` pulls out of **one chunk**
   * synchronously, and `requestBody`'s `if (upstream.write(chunk) || paused)
   * return;` means a second frame in the same chunk registers no second pause — so
   * fourteen frames written back to back can be one cycle rather than fourteen,
   * and the leak assertion below would then be green over the defect because the
   * threshold was never approached. Waiting for each pause before writing the next
   * frame makes each one its own chunk.
   *
   * The window is a second and the wait is given up for good the first time it
   * elapses: a loopback drain is a millisecond, so a second is seven times the
   * whole loop's expected length and no honest build can miss it, while a build
   * that has stopped pausing loses **one** window rather than fourteen and then
   * writes the rest at speed. The cycle count below is what says which happened —
   * a run that could not pace cannot have crossed the leak threshold either, and
   * it fails there rather than going quiet.
   */
  const peer = await Peer.connect(device.secretKey, fixtureLocal);
  check("a session against the driver's own listener", await peer.hello(sessionCap), FRAME.READY);

  /*
   * ⚠ **The upload direction's listener leak is NOT asserted here, and that is a
   * decision rather than an omission.** Its subject —
   * `upstream.once("close", resume)` in `src/e2ee.ts`, one per pause cycle before
   * it was hoisted — hangs off a `ClientRequest` private to `SecureSession`, so
   * no driver can count it the way the socket section above counts listeners on
   * the `Duplex` this file owns. The only proxy is Node's
   * `MaxListenersExceededWarning`, which needs eleven cycles at the default, and
   * this fixture cannot produce a reliable number of them: measured on one
   * machine, a paced writer gives 2, an unpaced one 1, a `setImmediate`-stalled
   * listener 1, a 5 ms stall over 140 frames exactly 4, and a 15 ms stall **3** —
   * the count is not monotonic in either knob, because a longer stall means the
   * peer's writes back up and the daemon attempts fewer of them. An assertion
   * whose threshold sits on that is a flake, and this repository has already paid
   * for one this week.
   *
   * What survives is what this section can honestly prove: the upload completes,
   * every byte arrives, and the answer is whole — driven against `/slurp-slow`
   * so the backpressure path is exercised rather than skipped. The listener
   * discipline itself is asserted deterministically one section up, on the
   * direction where the emitter is reachable, and the hoisted `once` is the same
   * line in the same file.
   */
  const part = new Uint8Array(MAX_FRAME_PAYLOAD);
  peer.write(encodeJsonFrame(FRAME.REQUEST, { method: "POST", path: "/slurp-slow", headers: {}, body: true }));
  /*
   * ⚠ **One turn of the loop between frames, and neither more nor less.** Two
   * spellings of this were measured and both made the section vacuous from
   * opposite directions. Waiting for cycle `i` before writing frame `i+1` lets
   * the loopback socket drain completely, and a write into a drained socket
   * finishes synchronously so `upstream.write()` answers `true`: 2 cycles over 14
   * frames. Writing all of them back to back puts every frame in one TCP chunk,
   * so `consume` dispatches the whole batch inside one read and the pause happens
   * once: 1 cycle. A bare `setImmediate` yields the loop — so each frame arrives
   * as its own read — while the stalling listener keeps the upstream buffer full,
   * which is the only state where `write()` answers `false` repeatedly.
   */
  for (let i = 0; i < UPLOAD_FRAMES; i += 1) {
    peer.write(encodeFrame(FRAME.REQUEST_BODY, part));
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  peer.write(encodeFrame(FRAME.REQUEST_END));

  const answered = await peer.collect();
  const uploaded = UPLOAD_FRAMES * MAX_FRAME_PAYLOAD;
  check("an upload the listener reads to the end is answered", answered.status, 200);
  check("and that answer is marked whole rather than given up on", answered.ended, FRAME.RESPONSE_END);
  report(
    "with every byte of it delivered",
    answered.body.includes(`"read":${uploaded}`),
    `${answered.body.slice(0, 40)}, against ${uploaded} sent`,
  );
  /*
   * `stream.pause()` and `stream.resume()` have exactly one caller each in
   * `src/e2ee.ts` — this pair — so a `"pause"` on the pipe is one backpressure
   * cycle. The upload direction's listener leak is asserted in the block above
   * rather than here; this report only says the path was walked.
   */
  // Not a threshold: the number is reported so a future reader can see whether the
  // backpressure path was exercised at all, without anything depending on which
  // side of an arbitrary line it falls on.
  report(
    "and the upload went through the daemon's own backpressure",
    peer.inboundPauses > 0,
    `${peer.inboundPauses} pause/resume cycle(s) on the way up`,
  );
}

listener.close();
fixture.closeAllConnections();
fixture.close();
sink.closeAllConnections();
sink.close();
