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
  type CipherState,
  type CloseFrame,
  type ResponseFrame,
  type StaticKey,
} from "@reemoat/protocol";
/*
 * ⚠ **An import cycle, and a deliberate one: `machine.ts` imports this file at
 * its top.** The ceiling a reassembled answer is held to is that module's number
 * — it already owns *"the largest file this client will pull into memory"* — and
 * a second copy of a memory bound is two numbers that agree until somebody
 * raises one of them. The cycle is safe because the binding is read inside a
 * frame handler rather than at module evaluation: whichever of the two modules
 * is evaluated first, by the time a `RESPONSE_BODY` arrives both have finished.
 * ⚠ A module-level alias for it here — `const MAX_RESPONSE_BYTES =
 * MAX_DOWNLOAD_BYTES` — would sit in the binding's temporal dead zone and throw
 * on import, so there is not one.
 */
import { MAX_DOWNLOAD_BYTES } from "./machine";
import { hostDeviceDh, nativeBoot } from "./native";

/**
 * The app's end of an encrypted channel to a remote daemon.
 *
 * ⚠ **This is the half that makes the encryption take effect.** The daemon has
 * spoken `Noise_IK` since `src/e2ee.ts` landed, and the relay has carried opaque
 * bytes since `handleChannel` did — but a daemon that *also* accepts plaintext
 * and a client that only speaks it is a fleet with the feature built and none of
 * it in use. Nothing here is optional: a machine this app cannot open a channel
 * to is reported unreachable, and there is no mode to fall back to.
 *
 * ## What the handshake proves, in both directions
 *
 * **That this is the expected machine.** `IK`'s second message is encrypted under
 * a key mixed from `ee` and `se`, so reading it at all requires the responder to
 * hold the private half of the static public key the Authority named when it
 * minted the capability. A relay that routed this connection to the wrong machine
 * — by mistake or otherwise — cannot produce that message, and this class never
 * reaches {@link Connection.ready}. There is no certificate and no name to check:
 * the key *is* the identity, learned from the Authority on the same call that
 * said where the machine was.
 *
 * **That this is the expected device.** The initiator's static is this
 * installation's device key, whose private half lives in the operating system's
 * keyring and is used from Rust — the page holds a Diffie-Hellman oracle and
 * never the key. So the daemon can compare the key it authenticated against the
 * one the Authority wrote into the capability, offline, with no lookup. That is
 * what makes a capability copied out of a log worth nothing: the copier can
 * replay the bytes and cannot answer the handshake.
 *
 * ## One connection carries one thing
 *
 * A small pool per machine, used the way HTTP/1.1 keep-alive is used, rather than
 * one session with a multiplexer inside it. `packages/protocol/src/frames.ts`
 * carries the argument: every request gets its own h2 stream and its own window
 * today, and collapsing them onto one would need per-stream credit accounting,
 * which is reimplementing the half of HTTP/2 already underneath. A live event
 * stream takes a connection of its own and keeps it.
 *
 * ## What this module is not
 *
 * It is **not** a second opinion about what a transport failure is. `http.ts`'s
 * `isTransportFailure` is a negation — *not an `ApiError`* — and a second
 * predicate would eventually disagree with it, in one of two ways that are both
 * bad: every subway tunnel signs the fleet out, or nobody ever is. So everything
 * thrown from here for a *transport* reason is a plain `Error`, and the one thing
 * that is not is {@link ChannelRefused}, which is the daemon answering.
 */

/* ------------------------------------------------------------------ *
 * Where the relay serves a channel
 * ------------------------------------------------------------------ */

/**
 * The relay path an encrypted channel is opened on.
 *
 * ⚠ **A second copy of `RELAY_CHANNEL_PATH` in
 * `packages/control-plane/src/relay/listener.ts`, and `webcheck.e2ee.ts` is the
 * one thing that compares the two literals** — `relaycheck` imports the
 * listener's copy and never reads this file. They cannot be one: the relay may
 * import exactly five files
 * from the repository root and `@reemoat/protocol` is not in its image, while
 * this package may import neither `src/` nor the control plane. That is the same
 * trade `wire.ts` makes for the daemon's event vocabulary — with a much sharper
 * failure, because a client dialling a path the relay does not serve is not a
 * wrong word on a screen, it is a fleet where no machine is reachable at all.
 */
export const RELAY_CHANNEL_PATH = "/__relay/channel";

/* ------------------------------------------------------------------ *
 * Bounds
 * ------------------------------------------------------------------ */

/** Bodies are chunked to fit one Noise transport message. */
const BODY_CHUNK_BYTES = MAX_FRAME_PAYLOAD;

/**
 * How much may sit in the socket's send buffer before the next chunk waits.
 *
 * This is where an upload's progress comes from, and it is honest progress rather
 * than a number invented by a timer: a chunk is reported once the socket has
 * taken it, and the socket stops taking them when the far end stops reading. So
 * the bar tracks the network instead of the loop that fed it — which is the one
 * thing `XMLHttpRequest` was kept for, now free.
 */
const SEND_HIGH_WATER_BYTES = 512 * 1024;

/** How often the drain check re-reads `bufferedAmount`. No event exists for it. */
const DRAIN_POLL_MS = 25;

/**
 * How long a channel may take to become usable — connected, handshaken, ready.
 *
 * Covers the WebSocket dial, one Noise round trip, and the daemon's answer to
 * `HELLO`. Deliberately shorter than any request budget: nothing behind it is
 * work, and a channel that has not come up in this long is a path that is not
 * going to carry a request either.
 */
const CHANNEL_READY_TIMEOUT_MS = 20_000;

/** How many spare open connections a machine keeps between requests. */
const MAX_IDLE_CONNECTIONS = 2;

/**
 * How close to a capability's expiry a pooled connection stops being reused.
 *
 * ⚠ **Not a second timer, and specifically not a fourth party to Q5.24.** A live
 * connection is never torn down by this number — the daemon's own re-check is
 * what ends one, exactly as it does on the direct path. This decides only whether
 * an *idle* connection is handed out again, because the capability it presented
 * at `HELLO` is the one pinned onto every request it will ever carry: reusing it
 * past `exp` buys a guaranteed `401` instead of a fresh handshake.
 */
const REUSE_MARGIN_MS = 30_000;

/* ------------------------------------------------------------------ *
 * base64url, without Node
 * ------------------------------------------------------------------ */

/*
 * `packages/web/tsconfig.json` compiles with `types: []` on purpose, so there is
 * no `Buffer` here and there must not be one. These are the browser's own
 * primitives, and the alphabet is the unpadded URL-safe one every other side of
 * this fleet already speaks: Rust's `URL_SAFE_NO_PAD`, the daemon's strict
 * decoder, and the Authority's JWK thumbprints.
 */

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) return null;
  try {
    const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
    const out = new Uint8Array(binary.length);
    for (let at = 0; at < binary.length; at += 1) out[at] = binary.charCodeAt(at);
    return out;
  } catch {
    // Not decodable. A caller treats this as "no key", which is a state it
    // already has to handle for a machine that has never announced one.
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * What a caller sees
 * ------------------------------------------------------------------ */

/**
 * The daemon refused this channel, and said why.
 *
 * ⚠ **The one thing thrown from this module that is not a transport failure**,
 * and it carries the verifier's own code — `wrong_device`, `unbound_capability`,
 * `token_expired`, `wrong_machine`. Distinct from `ApiError` deliberately: an
 * `ApiError` is an answer to a *request*, parsed out of an error envelope the
 * daemon's HTTP layer wrote, and this is the channel itself being refused before
 * any request existed.
 */
export class ChannelRefused extends Error {
  readonly status: number;
  readonly reason: string;

  constructor(status: number, reason: string) {
    super(`the daemon refused this channel: ${reason}`);
    this.name = "ChannelRefused";
    this.status = status;
    this.reason = reason;
  }

  static is(error: unknown): error is ChannelRefused {
    return error instanceof ChannelRefused;
  }
}

/** One request, as the daemon will make it against its own listener. */
export interface ChannelRequest {
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: Uint8Array | null;
  /** Fraction in `[0, 1]`, as the socket takes each chunk. */
  onProgress?: ((fraction: number) => void) | undefined;
  signal?: AbortSignal | undefined;
  timeoutMs: number;
}

/** What came back. `body` is bytes, because a download is not text. */
export interface ChannelResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: Uint8Array;
}

/**
 * The part of `WebSocket` that `stream.ts` actually uses.
 *
 * Four members, and that is the whole of it — measured off the class rather than
 * guessed: `onmessage`, `onclose`, `onerror` (each assigned and later set to
 * `null` by `closeQuietly`) and a no-argument `close()`. There is no `onopen`,
 * no `send` and no `readyState`, because the socket is read-only by rule (Q5.75)
 * and rotation waits for a `hello` *frame* rather than for an open event.
 *
 * Declared with the DOM's own event types rather than narrower ones, so that a
 * real `WebSocket` satisfies this structurally and the local arm needs no wrapper
 * at all. The cost is that {@link ChannelSocket} builds genuine `MessageEvent`
 * and `CloseEvent` objects — which is the right cost: a close code arriving as a
 * real `CloseEvent` is what keeps `stream.ts`'s 4401/4404/4003 table working
 * without a single line of it knowing which path it is on.
 */
export interface StreamSocket {
  onmessage: ((event: MessageEvent) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  close(): void;
}

/**
 * Every encrypted connection to one machine, as its one caller sees it.
 *
 * ⚠ **An interface because it is a seam, and the seam is what makes the routing
 * rules testable at all.** `machine.ts` holds several rules that have nothing to
 * do with cryptography — which arm a stale `wrong_machine` falls back to, that a
 * `no_tunnel` drops the route belief, that a `token_expired` retries once — and
 * every one of them needs a relay arm that *answers*. Driving those through a
 * real channel would mean a driver standing up a relay, a tunnel, a daemon, a
 * device key and a Noise responder to assert a fallback, which is the shape of
 * check that does not get written. `SmtpDialer`, `SessionRuntime` and `RelayView`
 * are the same trade in this codebase already.
 *
 * What it is **not** is a switch. There is one implementation that ships
 * ({@link MachineChannel}) and `webcheck.e2ee.ts` drives that one against a real
 * `Noise_IK` responder; nothing selects between them at run time and no
 * configuration can.
 */
export interface Channel {
  request(wanted: ChannelRequest): Promise<ChannelResponse>;
  openSocket(path: string): StreamSocket;
  dispose(): void;
}

/** How a {@link Channel} is made. Replaced only by a driver. */
export type ChannelFactory = (options: ChannelOptions) => Channel;

/** The one that ships. */
export const openChannel: ChannelFactory = (options) => new MachineChannel(options);

/** What a channel needs to know, per machine. */
export interface ChannelOptions {
  /** Where the relay is, as the Authority named it. */
  relayUrl: string;
  /** The machine's X25519 static, base64url, from `POST /v1/tokens`. */
  machineKey: string;
  /** A live capability and the instant it dies, on this device's clock. */
  credential: () => Promise<{ token: string; expiresAt: number }>;
  /**
   * Re-register this installation's key and mint again.
   *
   * Called at most once per channel, and only for `wrong_device` — the state a
   * reset credential store leaves behind, where the shell holds a key the
   * Authority has never been told about. Minting *succeeds* there, because the
   * Authority has a key on file and no way to know it is stale, so the daemon is
   * the first party in the fleet that can see the disagreement. It answers
   * `wrong_device`, and this is the remedy applied at the point of the refusal.
   */
  onWrongDevice: () => Promise<void>;
  /**
   * This installation's Noise static, or `null` where the shell holds none.
   *
   * Defaulted to {@link deviceStaticKey}, which reads the shell's boot payload
   * and forwards every `dh` across the bridge — so nothing that ships passes
   * this. It is a parameter for one reason: `hostReady` fires at *module import*,
   * so a driver cannot install a fake shell late enough to be seen, and a real
   * key held by the driver is what lets the whole channel — handshake, framing,
   * pooling, the socket adapter — be driven rather than stubbed.
   */
  deviceKey?: () => StaticKey | null;
}

/* ------------------------------------------------------------------ *
 * The device's static key
 * ------------------------------------------------------------------ */

/**
 * This installation's Noise static, with the private half left in the shell.
 *
 * ⚠ **`dh` is the only thing that crosses the bridge, and that is the whole
 * design.** `credential.rs` wrote the rule down before there was anything to put
 * behind it — *"a key this process can read is a key this process can leak"* — so
 * the two operations in `IK` that need the static (`ss` and `se`) are calls into
 * Rust that answer a shared secret, and every other operation in the handshake
 * uses an ephemeral this page generated and holds. What the page has is a
 * Diffie-Hellman oracle scoped to itself: strictly less than the key, and gone
 * when the origin changes.
 *
 * `null` where the shell has no key — a real state on a machine whose credential
 * store would not answer. The caller turns that into a sentence about this
 * installation rather than into a session with weaker properties.
 */
function deviceStaticKey(): StaticKey | null {
  const boot = nativeBoot();
  const encoded = boot?.devicePublicKey ?? null;
  if (encoded === null) return null;
  const publicKey = fromBase64Url(encoded);
  if (publicKey === null || publicKey.length !== 32) return null;
  return {
    publicKey,
    async dh(peer: Uint8Array): Promise<Uint8Array> {
      const shared = fromBase64Url(await hostDeviceDh(toBase64Url(peer)));
      // The shell refuses a non-contributory result itself, so anything that is
      // not 32 bytes here is a bridge that answered something else entirely.
      if (shared === null || shared.length !== 32) throw new Error("the shell answered an unusable shared secret");
      return shared;
    },
  };
}

/* ------------------------------------------------------------------ *
 * One connection
 * ------------------------------------------------------------------ */

const EMPTY = new Uint8Array(0);
const encoder = new TextEncoder();
const decoder = new TextDecoder();

type Waiter<T> = { resolve: (value: T) => void; reject: (error: Error) => void };

/** What a connection is currently carrying, if anything. */
type Carrying =
  | { kind: "none" }
  | {
      kind: "request";
      waiter: Waiter<ChannelResponse>;
      head: ResponseFrame | null;
      chunks: Uint8Array[];
      bytes: number;
    }
  | { kind: "socket"; sink: ChannelSocket };

class Connection {
  private readonly socket: WebSocket;
  private readonly reader = new LengthReader();
  private readonly handshake: NoiseHandshake;
  private send: CipherState | null = null;
  private receive: CipherState | null = null;
  private carrying: Carrying = { kind: "none" };

  /**
   * Everything that touches Noise state, serialized.
   *
   * The handshake's DH steps are `await`s across the Tauri bridge, so a second
   * `onmessage` can land while the first is suspended — and two readers on one
   * `CipherState` would advance the nonce out from under each other, which fails
   * as a tag mismatch and looks exactly like an attack. A promise chain is the
   * cheapest correct answer: there is one socket and the work per message is
   * small.
   */
  private queue: Promise<void> = Promise.resolve();

  private readyWaiters: Waiter<void>[] = [];
  private isReady = false;
  private failure: Error | null = null;
  private closed = false;

  constructor(
    url: string,
    staticKey: StaticKey,
    remoteStatic: Uint8Array,
    private readonly capability: string,
    /** The capability's own deadline, which bounds reuse and nothing else. */
    readonly expiresAt: number,
    /**
     * Called exactly once, the moment this connection stops existing.
     *
     * ⚠ **The pool's bookkeeping hangs off this rather than off the call sites
     * that close a connection**, because there are many of them, spread across
     * `release`, the request timeout, the caller's abort, `dispatch`'s `CLOSE`,
     * `fail`, both `ChannelSocket` paths, `acquire`'s stale-connection drop,
     * `connect`'s catch arm and `MachineChannel.dispose` itself — and a `Set`
     * maintained at each is a `Set` that is wrong at whichever one was added last.
     * The count is deliberately not written down: the last one said seven when
     * there were eleven.
     * Handing the owner one callback is the only shape where forgetting is not
     * possible.
     */
    private readonly onClosed: () => void,
  ) {
    this.handshake = NoiseHandshake.start({ initiator: true, staticKey, remoteStatic });
    this.socket = new WebSocket(url);
    this.socket.binaryType = "arraybuffer";

    this.socket.onopen = (): void => {
      this.run(async () => {
        this.raw(frameLength(await this.handshake.writeMessage()));
      });
    };
    this.socket.onmessage = (event): void => {
      // Binary only. The relay writes bytes into a `createWebSocketStream`, which
      // sends them as binary frames; anything else on this socket is not ours.
      if (!(event.data instanceof ArrayBuffer)) return;
      const chunk = new Uint8Array(event.data);
      this.run(() => this.consume(chunk));
    };
    this.socket.onerror = (): void => {
      // Always followed by `close`. The browser gives no reason here, and `close`
      // is where the one handler lives.
    };
    this.socket.onclose = (): void => {
      this.fail(new Error("the channel closed"));
    };
  }

  get usable(): boolean {
    return !this.closed && this.failure === null && this.carrying.kind === "none";
  }

  /** Whether an idle connection is worth handing out again. See {@link REUSE_MARGIN_MS}. */
  get fresh(): boolean {
    return this.usable && this.isReady && Date.now() < this.expiresAt - REUSE_MARGIN_MS;
  }

  private run(step: () => Promise<void>): void {
    this.queue = this.queue.then(step).catch((error: unknown) => {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    });
  }

  /** Connected, handshaken, and the capability accepted. */
  ready(): Promise<void> {
    if (this.failure !== null) return Promise.reject(this.failure);
    if (this.isReady) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      this.readyWaiters.push({ resolve, reject });
    });
  }

  /**
   * Stop using this connection, and settle whatever was riding it.
   *
   * ⚠ **A close is a *settlement*, not only a teardown, and the absence of that
   * was invisible.** This used to null the handlers, close the socket and stop.
   * But `MachineChannel.request` closes a connection when the caller aborts —
   * and `close` deliberately does not call {@link Connection.fail} — so the
   * promise `request` was awaiting stayed pending **for ever**, and the only
   * thing that ever settled it was the timeout it was racing. On an upload that
   * budget is `uploadDeadlines(file.size).hardMs`, which is minutes for a large
   * file, so removing a chip appeared to do nothing at all: no error, no
   * progress, no callback, until a timer nobody was waiting for finally fired.
   * Anything carried is rejected here now, which is what the pool's own docblock
   * has always claimed happens.
   *
   * Idempotent, and it does not become `fail`. `fail` is the *verdict* — a bad
   * tag, the daemon's refusal, an unexpected frame — and it settles its waiters
   * before it calls this, so control arrives here with nothing left to settle and
   * with `failure` already holding the error everybody was handed. A close with
   * no verdict behind it is a plain `Error`, because by this module's rule the
   * only thing thrown from here that is not one is {@link ChannelRefused}.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.socket.onmessage = null;
    this.socket.onclose = null;
    this.socket.onerror = null;
    this.socket.onopen = null;
    try {
      this.socket.close();
    } catch {
      // Already closing or closed. Nothing above needs to know.
    }
    const carrying = this.carrying;
    this.carrying = { kind: "none" };
    const waiters = this.readyWaiters;
    this.readyWaiters = [];
    const error = this.failure ?? new Error("the channel was closed");
    for (const waiter of waiters) waiter.reject(error);
    if (carrying.kind === "request") carrying.waiter.reject(error);
    if (carrying.kind === "socket") carrying.sink.transportEnded(error);
    this.onClosed();
  }

  /**
   * End this connection and everything riding it.
   *
   * ⚠ **Fatal by design, including for one bad frame.** There is no resynchronise
   * here and there must not be: a `CipherState` whose nonce has diverged produces
   * a tag failure on every subsequent message, so "skip it and carry on" is a
   * session that never works again while appearing to try. `src/e2ee.ts` takes
   * the same view from the other end, for the same reason.
   */
  private fail(error: Error): void {
    if (this.failure !== null) return;
    this.failure = error;
    const carrying = this.carrying;
    this.carrying = { kind: "none" };
    const waiters = this.readyWaiters;
    this.readyWaiters = [];
    this.close();
    for (const waiter of waiters) waiter.reject(error);
    if (carrying.kind === "request") carrying.waiter.reject(error);
    if (carrying.kind === "socket") carrying.sink.transportEnded(error);
  }

  /** A length-prefixed message straight onto the wire, outside the cipher. */
  private raw(bytes: Uint8Array): void {
    if (this.closed) return;
    try {
      /*
       * The cast narrows `ArrayBufferLike` to `ArrayBuffer`, which `BufferSource`
       * requires and which is true of every value reaching here: each one is a
       * freshly allocated `new Uint8Array(n)` out of `frameLength`. The DOM lib
       * excludes `SharedArrayBuffer`-backed views because they can be mutated
       * mid-send, and nothing in this file ever holds one.
       */
      this.socket.send(bytes as Uint8Array<ArrayBuffer>);
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error("could not write to the channel"));
    }
  }

  /** One sealed frame. */
  private write(frame: Uint8Array): void {
    /*
     * ⚠ **`closed` is checked here rather than only in {@link raw}.** `raw` drops
     * the bytes, but the `encrypt` above it had already run — so a cancelled
     * upload went on sealing every remaining 65518-byte chunk and throwing each
     * away. On the phone this client is shaped around that is ChaCha20-Poly1305
     * over the rest of the file for nothing.
     */
    if (this.closed) return;
    if (this.send === null) return this.fail(new Error("the channel is not established"));
    this.raw(frameLength(this.send.encrypt(EMPTY, frame)));
  }

  private async consume(chunk: Uint8Array): Promise<void> {
    if (this.closed || this.failure !== null) return;
    let messages: Uint8Array[];
    try {
      messages = this.reader.push(chunk);
    } catch {
      return this.fail(new Error("the channel sent unframeable bytes"));
    }

    for (const message of messages) {
      if (this.closed || this.failure !== null) return;
      if (this.send === null) {
        await this.finishHandshake(message);
        continue;
      }
      let frame: Uint8Array;
      try {
        frame = this.receive!.decrypt(EMPTY, message);
      } catch {
        return this.fail(new Error("a frame on this channel could not be authenticated"));
      }
      this.dispatch(frame);
    }
  }

  /**
   * The responder's answer, and the proof it is the right machine.
   *
   * ⚠ **This is the whole of the machine's authentication and there is nothing
   * else to add.** `IK`'s second message carries an AEAD tag under a key mixed
   * from `ee` and `se`, so it can only be produced by something holding the
   * private half of the static this handshake was started with. Reaching the line
   * after `readMessage` *is* the check — which is why there is no comparison here
   * to read, and why the absence of one is worth a paragraph.
   */
  private async finishHandshake(message: Uint8Array): Promise<void> {
    await this.handshake.readMessage(message);
    const transport = this.handshake.split();
    this.send = transport.send;
    this.receive = transport.receive;
    /*
     * The capability rides the first *transport* message rather than the
     * handshake payload. `IK`'s first message is encrypted to a static key alone
     * — no forward secrecy, and nothing stopping a verbatim replay — so a
     * capability in it would be replayable off the wire for its whole lifetime.
     * Here both ephemerals are fresh. It still costs no round trip, because it
     * goes out with the request that follows it.
     */
    this.write(encodeJsonFrame(FRAME.HELLO, { capability: this.capability }));
  }

  private dispatch(frame: Uint8Array): void {
    const decoded = decodeFrame(frame);
    if (decoded === null) return this.fail(new Error("an empty frame arrived on this channel"));

    switch (decoded.type) {
      case FRAME.READY: {
        this.isReady = true;
        const waiters = this.readyWaiters;
        this.readyWaiters = [];
        for (const waiter of waiters) waiter.resolve();
        return;
      }
      case FRAME.FAILED: {
        const close = decodeJson<CloseFrame>(decoded.payload);
        /*
         * The daemon's own refusal, kept as a refusal.
         *
         * A `401 wrong_device` must not reach the caller as "the network broke" —
         * it is the one failure in this file that somebody can act on, and the
         * channel acts on it itself one layer up.
         */
        return this.fail(new ChannelRefused(close?.code ?? 502, close?.reason ?? "the channel failed"));
      }
      case FRAME.RESPONSE: {
        if (this.carrying.kind !== "request") return this.fail(new Error("a response arrived with nothing waiting"));
        const head = decodeJson<ResponseFrame>(decoded.payload);
        if (head === null) return this.fail(new Error("an unreadable response head arrived"));
        this.carrying.head = head;
        return;
      }
      case FRAME.RESPONSE_BODY: {
        if (this.carrying.kind !== "request") return;
        /*
         * ⚠ **The ceiling is enforced here, while the frames arrive, because by
         * the time `machine.ts` can look the memory is already spent.** That
         * module's `MAX_DOWNLOAD_BYTES` check reads `content-length`, and over
         * `fetch` it ran *before* `response.blob()` — an oversized file was
         * refused rather than made resident, which was the whole point of it.
         * Over a channel the same check runs after `request` has returned, so
         * every byte has been accumulated, copied once more into the contiguous
         * array `RESPONSE_END` builds, and copied a third time into a `Blob`.
         * `machine.ts`'s own docblock admits the regression and calls itself a
         * second line of defence; this is the first one. The route serves any
         * regular file under the workspace, which includes the 2 GiB binary the
         * agent just built, so on a phone the symptom of not having this is the
         * tab dying rather than a refusal anybody can read.
         *
         * Checked *before* the chunk is held, so the frame that crosses the line
         * is never retained either, and against what actually arrived rather than
         * against a declared length — which also covers the answer that declares
         * no length at all, a case `content-length` cannot see.
         *
         * A plain `Error`, so `http.ts`'s `isTransportFailure` treats it as one:
         * this is not the daemon refusing the channel, and {@link ChannelRefused}
         * is reserved for that. The legible `413` for the ordinary case is still
         * `machine.ts`'s, off the declared length, one layer up.
         */
        if (this.carrying.bytes + decoded.payload.length > MAX_DOWNLOAD_BYTES) {
          return this.fail(new Error("the answer to this request is larger than this client will hold"));
        }
        this.carrying.chunks.push(decoded.payload);
        this.carrying.bytes += decoded.payload.length;
        return;
      }
      case FRAME.RESPONSE_END: {
        if (this.carrying.kind !== "request") return;
        const carrying = this.carrying;
        const head = carrying.head;
        this.carrying = { kind: "none" };
        if (head === null) return this.fail(new Error("a response ended before it began"));
        const body = new Uint8Array(carrying.bytes);
        let at = 0;
        for (const part of carrying.chunks) {
          body.set(part, at);
          at += part.length;
        }
        carrying.waiter.resolve({
          status: head.status,
          statusText: head.statusText,
          headers: head.headers,
          body,
        });
        return;
      }
      case FRAME.OPENED: {
        if (this.carrying.kind === "socket") this.carrying.sink.opened();
        return;
      }
      /*
       * ⚠ **A `MESSAGE` frame is a *chunk*, never a message, and reading it as
       * one was a permanent silent stall.** Frames are cut to
       * `MAX_FRAME_PAYLOAD` — 65518 bytes — while the daemon sends an event batch
       * as one WebSocket message of up to `BATCH_MAX_BYTES` (512 KiB), and a
       * control snapshot measured around 93 KB. Raising each frame as its own
       * `MessageEvent` therefore handed `stream.ts` eight, or two, pieces of JSON
       * each cut mid-token; it drops what it cannot parse **and leaves the cursor
       * where it was**, so the next reconnect asked for the same batch, split it
       * the same way and dropped it again. A transcript that never moves, with
       * nothing logged, on large sessions only, and only away from loopback.
       *
       * `MESSAGE_END` is the only thing that says a message is whole — not a
       * short frame, not a length, not a timer — which is the same shape
       * `RESPONSE_BODY`/`RESPONSE_END` has always had on the request half. Both
       * arms ignore a frame arriving with nothing carrying a socket, exactly as
       * the single `MESSAGE` case used to.
       */
      case FRAME.MESSAGE: {
        if (this.carrying.kind !== "socket") return;
        if (this.carrying.sink.messageChunk(decoded.payload)) return;
        return this.fail(new Error("a socket message on this channel outgrew what may be reassembled"));
      }
      case FRAME.MESSAGE_END: {
        if (this.carrying.kind !== "socket") return;
        if (this.carrying.sink.messageEnd()) return;
        /*
         * `end()` answering `null` means the bound was passed on an earlier frame
         * and the arm above did not act on it — unreachable as written, and kept
         * as a refusal rather than an assumption because the alternative is
         * handing the reducer a message with a hole in it.
         */
        return this.fail(new Error("a socket message on this channel outgrew what may be reassembled"));
      }
      case FRAME.CLOSE: {
        if (this.carrying.kind !== "socket") return;
        const close = decodeJson<CloseFrame>(decoded.payload);
        const sink = this.carrying.sink;
        this.carrying = { kind: "none" };
        /*
         * The daemon's own close code, carried whole and never defaulted into
         * something friendlier. `stream.ts`'s table is the client's entire model
         * of why a stream ended — 4401 re-mints, 4404 gives up, 4003 backs off —
         * so inventing a code here would silently change what the app does about
         * it. `1006` only where the daemon sent nothing at all, which is what an
         * abnormal close means everywhere else too.
         */
        sink.daemonClosed(close?.code ?? 1006, close?.reason ?? "");
        this.close();
        return;
      }
      default:
        return this.fail(new Error(`an unexpected frame ${String(decoded.type)} arrived on this channel`));
    }
  }

  /** Wait until the socket has taken what it already holds. */
  private drain(): Promise<void> {
    if (this.closed || this.socket.bufferedAmount <= SEND_HIGH_WATER_BYTES) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const tick = setInterval(() => {
        if (this.closed || this.failure !== null || this.socket.bufferedAmount <= SEND_HIGH_WATER_BYTES) {
          clearInterval(tick);
          resolve();
        }
      }, DRAIN_POLL_MS);
    });
  }

  /** Send one request and wait for the whole answer. */
  async request(wanted: ChannelRequest): Promise<ChannelResponse> {
    await this.ready();
    if (this.carrying.kind !== "none") throw new Error("this channel is already carrying something");

    const body = wanted.body ?? null;
    const answer = new Promise<ChannelResponse>((resolve, reject) => {
      this.carrying = { kind: "request", waiter: { resolve, reject }, head: null, chunks: [], bytes: 0 };
    });

    this.write(
      encodeJsonFrame(FRAME.REQUEST, {
        method: wanted.method,
        path: wanted.path,
        headers: wanted.headers ?? {},
        body: body !== null && body.length > 0,
      }),
    );

    if (body !== null && body.length > 0) {
      /*
       * ⚠ **`closed` as well as `failure`, because a cancel is not a failure.**
       * `close()` deliberately does not `fail()` — see its docblock — and
       * `failure` was this loop's only exit, so an aborted or timed-out upload
       * kept iterating to the end: `drain()` returns at once once closed, so the
       * loop ran flat out, and `onProgress` walked the bar to 1 on a transfer the
       * person had already cancelled. Only the caller's promise was settled by
       * the abort path; the producer was never told.
       */
      for (let at = 0; at < body.length; at += BODY_CHUNK_BYTES) {
        await this.drain();
        if (this.failure !== null) throw this.failure;
        if (this.closed) return await answer;
        this.write(encodeFrame(FRAME.REQUEST_BODY, body.subarray(at, at + BODY_CHUNK_BYTES)));
        wanted.onProgress?.(Math.min(1, (at + BODY_CHUNK_BYTES) / body.length));
      }
      this.write(encodeFrame(FRAME.REQUEST_END));
    }

    return await answer;
  }

  /** Take this connection over for one socket, for as long as it lives. */
  adopt(sink: ChannelSocket, path: string): void {
    this.carrying = { kind: "socket", sink };
    this.write(encodeJsonFrame(FRAME.OPEN, { path }));
  }
}

/* ------------------------------------------------------------------ *
 * A socket over a channel
 * ------------------------------------------------------------------ */

/**
 * One live event stream, wearing enough of `WebSocket` for `stream.ts`.
 *
 * Constructed synchronously and connected afterwards, exactly as `WebSocket`
 * itself is — which is what lets `stream.ts`'s `open()` stay a one-line change
 * and keeps rotation, the `Math.max` cursor, the `seq <= lastAppliedSeq` dedup
 * and the hole check untouched. A failure before the daemon's socket is open
 * arrives as a `1006` close, which is what the class already does the right thing
 * with: back off and try again.
 */
class ChannelSocket implements StreamSocket {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  private connection: Connection | null = null;
  private done = false;

  /**
   * The chunks of the message currently arriving, if one is.
   *
   * One per socket, which is what makes the rule statable at all: a connection
   * carries one socket, so the only frames that can arrive between a message's
   * chunks and its terminator are `CLOSE` and `FAILED` — and either of those
   * abandons the part-assembled message rather than delivering the piece that
   * got here. That is the `RESPONSE_END`-versus-`FAILED` rule again (Q6.103),
   * one layer down.
   */
  private readonly assembler = new MessageAssembler();

  constructor(open: Promise<Connection>, path: string) {
    open.then(
      (connection) => {
        if (this.done) {
          connection.close();
          return;
        }
        this.connection = connection;
        connection.adopt(this, path);
      },
      (error: unknown) => {
        this.transportEnded(error instanceof Error ? error : new Error(String(error)));
      },
    );
  }

  close(): void {
    this.done = true;
    this.connection?.close();
    this.connection = null;
  }

  /** The daemon's socket is open. Nothing above waits for this; `hello` does. */
  opened(): void {
    // Deliberately empty. `stream.ts` never assigns `onopen` — it waits for the
    // daemon's own `hello` frame, which is the only event that carries a cursor.
  }

  /**
   * One `MESSAGE` frame. `false` once the message has outgrown its bound.
   *
   * `MessageAssembler` holds the frame's payload — a view into the plaintext
   * this frame was decrypted into — until the terminator arrives, which is safe
   * because every Noise message is decrypted into a **fresh** array at both ends.
   * A reader that ever decrypts into a reused buffer has to copy on the way in.
   *
   * A `false` is the connection's to answer, not this class's: the assembler has
   * already dropped what it held, so carrying on would deliver a hole.
   */
  messageChunk(payload: Uint8Array): boolean {
    // Nothing is listening any more, so nothing is worth accumulating. The
    // terminator below takes the same exit and the assembler stays empty.
    if (this.done) return true;
    return this.assembler.push(payload);
  }

  /**
   * `MESSAGE_END`: the frames since the last one are one message. `false` if the
   * bound was passed and the caller carried on anyway.
   *
   * ⚠ **Concatenate the bytes, then decode once — never decode a chunk.** A
   * chunk boundary is a byte count, so it can land inside a multi-byte UTF-8
   * sequence; a non-streaming decode of that piece puts a U+FFFD where the
   * character was. Measured on the protocol side: a 95519-byte message with an
   * `é` straddling the 65518 boundary comes back ending in `�` decoded per
   * frame, and byte-identical concatenated first. `TextDecoder({stream: true})`
   * would also answer, but it pairs a second piece of per-socket state with the
   * assembler and cannot hand back bytes if a binary message ever arrives.
   *
   * Decoded as text, which is what this socket carries and all it has ever
   * carried: the daemon's stream frames are JSON and `stream.ts` drops anything
   * whose `data` is not a string. A binary frame would therefore be dropped on
   * the direct path too, so decoding it here changes nothing about what reaches
   * the reducer — it only keeps the two paths identical.
   *
   * A zero-length message is legal on a WebSocket and survives as it should: no
   * chunks, one terminator, and an empty string raised rather than nothing.
   */
  messageEnd(): boolean {
    if (this.done) return true;
    const whole = this.assembler.end();
    if (whole === null) return false;
    this.onmessage?.(new MessageEvent("message", { data: decoder.decode(whole) }));
    return true;
  }

  daemonClosed(code: number, reason: string): void {
    if (this.done) return;
    this.done = true;
    this.connection = null;
    this.onclose?.(new CloseEvent("close", { code, reason, wasClean: true }));
  }

  /** The channel underneath died. Indistinguishable from a socket dropping. */
  transportEnded(error: Error): void {
    if (this.done) return;
    this.done = true;
    this.connection = null;
    this.onerror?.(new Event("error"));
    this.onclose?.(new CloseEvent("close", { code: 1006, reason: error.message, wasClean: false }));
  }
}

/* ------------------------------------------------------------------ *
 * One machine's channels
 * ------------------------------------------------------------------ */

/**
 * Every encrypted connection to one machine.
 *
 * One of these per `MachineConnection`, rebuilt when the machine's key or relay
 * changes — both of which arrive on the same `POST /v1/tokens` answer, so they
 * cannot disagree with each other about one machine.
 */
export class MachineChannel implements Channel {
  private readonly idle: Connection[] = [];

  /**
   * Every connection this channel has open, idle or in use.
   *
   * ⚠ **`idle` is not that set and never was**, which is what made
   * {@link MachineChannel.dispose} a lie in three docblocks at once: `acquire`
   * pops a connection off `idle` before handing it out, and `openSocket` never
   * puts one there at all. So the two connections that matter most — the one
   * carrying a request right now, and the **live event stream**, which by design
   * takes a connection of its own and keeps it for hours — were tracked nowhere.
   * `machine.ts` disposes where it drops the route belief or rebuilds on a new
   * machine key or relay, and its comment says disposing *"removes the whole
   * question"*; without this the event stream kept running over the stale key and
   * the stale relay, answering to nothing, which is the one connection whose
   * survival is silent because it is supposed to sit quiet for minutes.
   *
   * Maintained by the callback each {@link Connection} is built with rather than
   * at the call sites that close one — see that parameter for why.
   */
  private readonly live = new Set<Connection>();

  private recovered = false;

  constructor(private readonly options: ChannelOptions) {}

  /**
   * Give up every connection. Called when the machine's key or route moves.
   *
   * *Every* one: the idle pool, whatever is carrying a request, and the socket
   * connection that is not pooled at all. A disposed socket reaches `stream.ts`
   * as a `1006`, which is the state it already does the right thing with — back
   * off, reconnect, and come back through `machine.ts` onto whatever key and
   * relay are current by then.
   */
  dispose(): void {
    this.idle.length = 0;
    // A copy, because `close()` removes the connection from this set as it goes.
    for (const connection of [...this.live]) connection.close();
    this.live.clear();
  }

  /**
   * One request over a channel, borrowed from the pool and given back.
   *
   * The timeout and the caller's abort both **end the connection** rather than
   * cancelling the request on it. There is no cancel frame and there should not
   * be one: the daemon may still be part-way through answering, and a connection
   * whose next bytes are the tail of an abandoned answer is a connection that
   * will mis-attribute them. One handshake is cheap; a mis-attributed response is
   * not.
   *
   * ⚠ **Ending the connection is only half of what an abort owes**, and for a
   * while it was the only half written down. `abort` was `connection.close()`,
   * which nulls the handlers and closes the socket and deliberately does *not*
   * call `fail` — so nothing rejected, and the request settled only when the
   * timeout it was racing fired. On an upload that budget is
   * `uploadDeadlines(file.size).hardMs`: minutes for a large file, during which
   * removing a chip looked like it did nothing. `machine.ts`'s upload has
   * `if (signal.aborted) throw error` and expects the rejection promptly. It is
   * belt and braces now — the listener rejects the race here, and
   * {@link Connection.close} settles anything it drops — because either alone is
   * silent about the window the other covers.
   *
   * A `DOMException` named `AbortError`, which is what the `fetch`/`XHR` arm of
   * `machine.ts` already rejects a cancelled upload with. Nothing in this client
   * reads the name — `signal.aborted` is what every caller checks — but two
   * transports answering one cancel with two different shapes is a difference
   * waiting to be depended on.
   */
  async request(wanted: ChannelRequest): Promise<ChannelResponse> {
    const connection = await this.acquire();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancel: ((error: Error) => void) | null = null;
    const abort = (): void => {
      connection.close();
      cancel?.(new DOMException("the request was cancelled", "AbortError"));
    };
    try {
      const raced = new Promise<never>((_resolve, reject) => {
        cancel = reject;
        timer = setTimeout(() => {
          connection.close();
          reject(new Error("the request timed out"));
        }, wanted.timeoutMs);
      });
      wanted.signal?.addEventListener("abort", abort, { once: true });
      /*
       * A signal that has already fired never calls a listener added after it,
       * and `acquire()` above is an `await` — a dial and a handshake, so a real
       * window. Without this, a cancel that landed during it would be a cancel
       * nobody ever hears, which is the same symptom this whole paragraph is
       * about arriving through a different door.
       */
      if (wanted.signal?.aborted === true) abort();
      const answer = await Promise.race([connection.request(wanted), raced]);
      this.release(connection);
      return answer;
    } catch (error) {
      connection.close();
      throw error;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      wanted.signal?.removeEventListener("abort", abort);
    }
  }

  /**
   * A socket on a channel of its own, held for the socket's lifetime.
   *
   * Never pooled. A live event stream sits quiet for minutes at a time and then
   * delivers a burst, which is exactly the connection a request must not have to
   * queue behind — and the reason there is a pool rather than a multiplexer in
   * the first place.
   */
  openSocket(path: string): StreamSocket {
    return new ChannelSocket(this.connect(), path);
  }

  private async acquire(): Promise<Connection> {
    for (;;) {
      const held = this.idle.pop();
      if (held === undefined) break;
      if (held.fresh) return held;
      held.close();
    }
    return await this.connect();
  }

  private release(connection: Connection): void {
    if (!connection.fresh || this.idle.length >= MAX_IDLE_CONNECTIONS) {
      connection.close();
      return;
    }
    this.idle.push(connection);
  }

  /**
   * Open one channel, with the one refusal this client can fix by itself.
   *
   * ⚠ **`wrong_device` is recoverable and is recovered here.** A credential store
   * that was reset out from under the app leaves the shell holding a key the
   * Authority has never been told about — and minting still *succeeds*, because
   * the Authority has a key on file and nothing to compare it against. The daemon
   * is the first party in the fleet that can see the disagreement, and it says so
   * on the handshake. Re-registering the same device id writes the new key into
   * the row in place, so no device slot is spent and nobody signs in again.
   *
   * **Once per channel**, for `mint`'s reason: a re-registration that does not
   * take must surface as the refusal it is rather than as a loop against the
   * Authority.
   */
  private async connect(): Promise<Connection> {
    try {
      return await this.dial();
    } catch (error) {
      if (!ChannelRefused.is(error) || error.reason !== "wrong_device" || this.recovered) throw error;
      this.recovered = true;
      await this.options.onWrongDevice();
      return await this.dial();
    }
  }

  private async dial(): Promise<Connection> {
    const staticKey = (this.options.deviceKey ?? deviceStaticKey)();
    if (staticKey === null) {
      throw new Error("this installation has no device key, so it cannot reach a machine over the relay");
    }
    const remoteStatic = fromBase64Url(this.options.machineKey);
    if (remoteStatic === null || remoteStatic.length !== 32) {
      throw new Error("this machine has not announced a usable key");
    }

    const { token, expiresAt } = await this.options.credential();
    const url = new URL(RELAY_CHANNEL_PATH, this.options.relayUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    /*
     * The credential rides the query on this hop and on no other. A browser
     * cannot set a header on a WebSocket handshake, which is the whole reason
     * `?token=` exists at all — and this is now where it stops: inside the
     * channel the capability is a frame, and the daemon puts it on its own
     * loopback request as a header.
     */
    url.searchParams.set("token", token);

    const connection: Connection = new Connection(url.toString(), staticKey, remoteStatic, token, expiresAt, () =>
      this.live.delete(connection),
    );
    this.live.add(connection);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        connection.ready(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("the channel did not come up")), CHANNEL_READY_TIMEOUT_MS);
        }),
      ]);
    } catch (error) {
      connection.close();
      throw error;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    return connection;
  }
}

/* ------------------------------------------------------------------ *
 * Bodies
 * ------------------------------------------------------------------ */

/** Whatever a caller handed `fetch`, as the bytes a frame carries. */
export async function bodyBytes(body: BodyInit | null | undefined): Promise<Uint8Array | null> {
  if (body === undefined || body === null) return null;
  if (typeof body === "string") return encoder.encode(body);
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (body instanceof Blob) return new Uint8Array(await body.arrayBuffer());
  // `FormData`, `URLSearchParams` and `ReadableStream` reach no call site in this
  // client — every one passes a string or a `Blob` — so this is a refusal rather
  // than a conversion nobody would exercise.
  throw new Error("this body cannot be sent over an encrypted channel");
}

/** A response body as text, for the paths that parse an envelope. */
export function bodyText(body: Uint8Array): string {
  return decoder.decode(body);
}
