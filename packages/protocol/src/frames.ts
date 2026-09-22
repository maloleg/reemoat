/**
 * What travels inside the encrypted channel, once the handshake is done.
 *
 * **One connection carries one thing at a time**, the way HTTP/1.1 keep-alive
 * does: a request and its answer, or a socket and its messages. There is no
 * stream id and no multiplexer here, and that is the decision rather than a
 * simplification — see the note on concurrency below.
 *
 * ⚠ **Why the daemon parses this and the browser does not parse HTTP.** The
 * relay's own docblock already made this argument about itself: *"a CONNECT
 * stream is a byte pipe, so `http.request({createConnection})` lets Node
 * serialize the request, decide chunked-versus-content-length, and raise
 * `upgrade` for a 101 — all the HTTP/1.1 detail we would otherwise be
 * hand-writing and getting subtly wrong."* Splicing raw bytes from the app
 * straight to the daemon's loopback listener would move exactly that
 * hand-writing into the **webview** — an HTTP/1.1 response reader and an RFC 6455
 * client, which is where desync bugs with security consequences live. Moving the
 * parse from the relay to the daemon keeps Node doing it, three feet from the
 * server that produced the bytes.
 *
 * That does **not** weaken *"the tunnel carries opaque bytes, not parsed HTTP"*.
 * That is a property of the tunnel and of the relay, and both keep it — the relay
 * in fact gains it, since it stops parsing anything at all. The daemon is one
 * **endpoint** of the encrypted session and is supposed to understand what it
 * terminates.
 *
 * ## Concurrency, and why there are no stream ids
 *
 * Today every browser request gets its own h2 stream with its own
 * `STREAM_WINDOW_BYTES` window, and backpressure is h2's, granted on
 * consumption. Collapsing a machine's whole traffic onto one encrypted session
 * would put every request behind one window — so a paused download would stall
 * the live event socket — and the only fix for that is per-stream credit
 * accounting, which is reimplementing the half of HTTP/2 that is already
 * underneath. A pool of connections keeps the existing behaviour exactly:
 * one connection, one stream, one window, and `MAX_STREAMS_PER_SUBJECT` still
 * bounding one caller.
 *
 * The cost is a handshake per new connection, which `Noise_IK` makes one round
 * trip, and which a warm pool pays once.
 *
 * ## Message boundaries, and the one rule both halves now share
 *
 * A frame is at most `MAX_FRAME_PAYLOAD` bytes, so **anything larger than that
 * arrives in pieces and something has to say when the pieces are a whole thing.**
 * The request half always did: `RESPONSE_BODY` frames accumulate and
 * `RESPONSE_END` delivers. The socket half did not, and the absence was invisible
 * because it only bites above 65518 bytes — see `MESSAGE_END`, which is that half's
 * terminator and the reason both now read the same way.
 *
 * ⚠ **Reassembly is over bytes, never over text.** A chunk boundary falls at a
 * byte count, so it can land in the middle of a multi-byte UTF-8 sequence;
 * decoding each piece on arrival turns that sequence into U+FFFD and the JSON
 * around it into something the reducer silently drops. Both ends concatenate
 * first — `MessageAssembler` here — and decode the whole once.
 */

/** Every frame begins with one byte saying what it is. */
export const FRAME = {
  /** initiator → responder. The capability, as the first transport message. */
  HELLO: 0x01,
  /** responder → initiator. The capability was accepted. */
  READY: 0x02,

  /** initiator → responder. `{method, path, headers}`. */
  REQUEST: 0x10,
  /** initiator → responder. A chunk of the request body. */
  REQUEST_BODY: 0x11,
  /** initiator → responder. The request body is complete. */
  REQUEST_END: 0x12,

  /** responder → initiator. `{status, statusText, headers}`. */
  RESPONSE: 0x20,
  /** responder → initiator. A chunk of the response body. */
  RESPONSE_BODY: 0x21,
  /** responder → initiator. The answer is complete and **whole**. */
  RESPONSE_END: 0x22,

  /** initiator → responder. `{path}` — open a socket rather than send a request. */
  OPEN: 0x30,
  /** responder → initiator. The socket is open. */
  OPENED: 0x31,
  /**
   * Either direction. **One chunk of one socket message**, never a message.
   *
   * Even a message small enough for a single frame is a `MESSAGE` and then a
   * `MESSAGE_END`: the receiver is never asked to infer a boundary from a length.
   */
  MESSAGE: 0x32,
  /** Either direction. `{code, reason}` — the socket's own close, carried whole. */
  CLOSE: 0x33,
  /**
   * Either direction. The `MESSAGE` frames since the last one are a whole message.
   *
   * ⚠ **Without it, one socket message became several, and the failure was
   * silent.** `MESSAGE` frames are cut to `MAX_FRAME_PAYLOAD`, and a receiver with
   * no terminator raised each one as its own message. The daemon sends an event
   * batch as one WebSocket message of up to `BATCH_MAX_BYTES` (512 KiB), and a
   * control snapshot measured around 93 KB — both comfortably over 65518 — so on
   * the encrypted path those arrived as eight, or two, *different* messages, each
   * one JSON cut mid-token. Then `stream.ts` drops what it cannot parse **and
   * leaves the cursor where it was**, so the next reconnect asks for the same
   * batch, splits it the same way and drops it again: a transcript that stalls for
   * good, with nothing logged, on big sessions only, and only away from loopback.
   *
   * **A terminator rather than a continuation bit in the type byte**, for three
   * reasons, and the first decided it:
   *
   * - The request half already works this way. A reader that has implemented
   *   `RESPONSE_BODY`/`RESPONSE_END` has implemented this — which matters because
   *   the two ends live in packages that may not import one another, so each is
   *   written against this file rather than against the other. Two shapes for *"a
   *   thing arrives in pieces"* in one protocol is a second thing to get right for
   *   nothing.
   * - A flag bit stops the type byte being a value compared with `===` and makes it
   *   a field to mask. Every `switch (decoded.type)` at both ends would need the
   *   mask, and the one that forgot it would fall to `default`, which on both ends
   *   fails the session. Where the safety net is drivers rather than a type system,
   *   a wire constant that stays one byte and one comparison is worth more than the
   *   frame it would save.
   * - It keeps *complete* and *gave up* different bytes, which is the
   *   `RESPONSE_END`-versus-`FAILED` argument again (Q6.103): a connection that
   *   dies mid-message delivers nothing, rather than delivering the part that
   *   arrived as though it were the message.
   *
   * The cost is one extra frame — two length bytes, a type byte and a 16-byte tag,
   * so 19 on the wire, plus one nonce — for every socket message including the
   * small ones that used to fit in one. That is the price of the receiver never
   * having to guess, and the stream sends batches rather than one message per
   * event.
   *
   * `0x34` because it is the next free byte: the socket block is contiguous
   * (`OPEN` 0x30, `OPENED` 0x31, `MESSAGE` 0x32, `CLOSE` 0x33), so there is no
   * gap before `CLOSE` to take. `CLOSE` is not renumbered to 0x34 to put this
   * beside `MESSAGE`, because a wire constant is not renumbered to make a source
   * file read in order.
   */
  MESSAGE_END: 0x34,

  /**
   * Either direction. `{code, reason}` — this connection failed.
   *
   * ⚠ **Separate from `RESPONSE_END`, and that separation is the whole of
   * Q6.103 surviving this rewrite.** The natural shape for a framed protocol is
   * one "the stream ended" frame, and with one frame a daemon whose upstream died
   * mid-body is indistinguishable from one that finished — so the app resolves a
   * short body as if it were the answer. Two frames make "complete" and "gave up"
   * different bytes, and the app throws on the second.
   */
  FAILED: 0x40,
} as const;

export type FrameType = (typeof FRAME)[keyof typeof FRAME];

/**
 * The largest payload one frame may carry.
 *
 * A Noise transport message is at most 65535 bytes including its 16-byte tag, and
 * one byte here is the frame type. Bodies are chunked to fit; nothing above this
 * layer needs to know the number.
 */
export const MAX_FRAME_PAYLOAD = 65535 - 16 - 1;

/**
 * How much JSON a header frame may carry.
 *
 * Bounded because the alternative is a caller describing a request in a megabyte
 * of header names. The daemon's own `MAX_BODY_BYTES` bounds the body; this bounds
 * the description of it.
 *
 * ⚠ **Derived rather than written down beside `MAX_FRAME_PAYLOAD`.** It was
 * `64 * 1024`, which is eighteen bytes *larger* than a frame can hold, so
 * `encodeJsonFrame` admitted descriptions `encodeFrame` then threw on — an
 * eighteen-byte window in which the refusal came from the wrong layer, with the
 * wrong words, from inside a listener that has no `try` around it. Two bounds
 * stated as a pair have to be one expression, or they are a pair that agrees until
 * somebody edits one of them.
 */
export const MAX_HEADER_JSON_BYTES = MAX_FRAME_PAYLOAD;

/**
 * The largest socket message either end will put back together.
 *
 * A terminator means the receiver holds chunks until one arrives, so without a
 * bound a peer that sends `MESSAGE` frames and never a `MESSAGE_END` grows the
 * other end's heap for as long as it cares to. This is the number the daemon's own
 * WebSocket listener already enforces on the direct path — `maxPayload`, set to
 * `MAX_BODY_BYTES`, 1 MiB — so an inbound message above it is refused three feet
 * later anyway and reassembling it first would only mean holding a megabyte in
 * order to throw it away.
 *
 * ⚠ **The outbound direction is bounded in `src/server.ts`, and it was bounded by
 * an estimate rather than by this.** `StreamConnection.flush` batched against
 * `BATCH_MAX_BYTES` — half of this — accumulating `estimateBytes`, which charges
 * `String.length`, **UTF-16 units of the unescaped string**, while what reaches
 * this layer is `JSON.stringify` in UTF-8. Measured by replaying that ceiling's
 * own arithmetic over real events: four `text` events of CJK are charged 469 KiB
 * and are **1406 KiB** on the wire, and four `agent_log` lines of ESC — which is
 * what a coding CLI's stderr is made of, six bytes per charged unit — are charged
 * the same 469 KiB and are **2813 KiB**. Both are past this bound. `src/e2ee.ts`'s
 * `socket.on("message")` runs `encodeMessageFrames` over whatever it is handed
 * with no check of its own, so the receiver refused the message here, the channel
 * failed, and `stream.ts` reconnected with the cursor unchanged onto the same
 * batch — which was `MESSAGE_END`'s own permanent stall relocated from 65518
 * bytes to this number rather than defended against by it.
 *
 * **The repair was in `src/server.ts` and not in this number**, which would only
 * have moved the cliff. `flush` encodes each event once and cuts the batch on
 * `Buffer.byteLength` of the string it is about to write, so a batch is at most
 * `max(BATCH_MAX_BYTES, one event)` **in the bytes that arrive here**. The one
 * event it takes whatever it weighs is what keeps an oversized event from
 * producing an empty batch for ever, and `DEFAULT_MAX_EVENT_BYTES` — 128 KiB
 * charged, so at most ~768 KiB once every unit escapes to six bytes — is what
 * leaves the other half of this bound as headroom rather than as work. What this
 * bound is *for* is still only the first paragraph — a peer that sends `MESSAGE`
 * and never `MESSAGE_END` — and it does that.
 *
 * ⚠ **That ~768 KiB is the worst case only for the events `truncateEvent`
 * actually cuts, and it took a second defect to notice.** `truncateEvent` returns
 * six of its nineteen labels unchanged on purpose — a truncated question is an
 * unanswerable question — so for those arms the ceiling is whatever the field
 * carries, not `DEFAULT_MAX_EVENT_BYTES`. Measured on this branch,
 * `elicitation_request.message` was bounded by **nothing**: the elicitation
 * form's 32 KiB backstop weighs the form, of which `message` is not a field, and
 * the clip that used to bound it had been retired. One agent-minted question over
 * ~1 MiB is one event, taken unconditionally as the first of a batch, refused
 * here, and reconnected onto for ever — this number's own stall on a different
 * trigger. The repair is an ingest bound rather than a number here, again:
 * `MAX_ELICITATION_MESSAGE_CHARS` (4096 code units, at most 16 KiB of UTF-8) in
 * `src/session.ts`.
 *
 * ⚠ **So the headroom sentence above holds for the arms that converge on
 * `maxBytes`, and for those only — an earlier draft of this paragraph claimed it
 * held for all of them, and that claim was false on the day it was written.**
 * The draft said the headroom held "because every arm that refuses to shrink is
 * bounded at ingest", in the same change that added `src/server.ts`'s inventory
 * saying `context_cleared` and `session_started` rely on nothing at all — one
 * commit carrying both halves of a contradiction. It is the worse kind of stale
 * comment, because it tells the next reader the property is guaranteed, which is
 * exactly what stops them re-checking.
 *
 * **Measured 2026-09-18, and re-run 2026-09-19 after the first census turned out
 * to be short**, by replaying `truncateEvent` at `DEFAULT_MAX_EVENT_BYTES` and
 * weighing `JSON.stringify` in UTF-8, the way `flush` now weighs a batch.
 *
 * ⚠ **The 2026-09-18 version of this paragraph said "three doors" and named the
 * one that reaches this ceiling. It was a closed enumeration produced by reading
 * the switch by hand, and it was wrong** — `agent_config` was a fourth and a
 * *nearer* one, at **7 766 choices** against `plan.entries`' ~9 500, in the same
 * switch the whole time. The correction is not a fourth bullet: it is that this
 * comment stopped counting. What replaces the count is a driver —
 * `daemoncheck.after-the-turn-and-config`'s census replays every arm of
 * `truncateEvent` at `DEFAULT_MAX_EVENT_BYTES`, weighs each against this constant,
 * and differences the labels it swept against `SessionEvent`'s own union in both
 * directions, so a label with no fixture fails rather than being skipped. **Run it
 * to enumerate the doors; do not read a number out of this paragraph.** The
 * `agent_config` half is closed: `toConfigOptions` in `src/session.ts` bounds a
 * configuration at ingest, and the census asserts the event that produces no
 * longer reaches this ceiling.
 *
 * What the census reported on 2026-09-19, with each fixture built at the largest
 * shape this daemon's own ingest bounds permit, is that these arms can still
 * exceed it — **at least these, on that construction**, which is the strongest
 * thing a fixture census can say:
 *
 * - `plan.entries` — **1 100 027 bytes at 10 000 entries**, *after* truncation,
 *   which is past this constant and stalls. The arm does run, but it budgets
 *   **per item** against a 64-byte floor, so what it bounds is the size of an
 *   entry and never the count: 1 000 entries of 500 characters come out at
 *   145 027 and 3 entries of a megabyte each come out at 131 148 — the cut works
 *   perfectly on content and not at all on cardinality, and `session.ts` pushes
 *   the agent's array through uncapped. **~9 500 entries is the cliff** once the
 *   per-item budget has floored, at ~110 bytes an entry on the wire.
 * - `context_cleared` — a `return event` arm carrying two agent-minted session
 *   ids bounded nowhere in `src/`: two of 400 000 characters are charged 800 064
 *   and weigh 800 074, past `src/server.ts`'s `BATCH_MAX_BYTES` and inside this.
 * - `session_started` — the same ids, and sharper: `estimateBytes` charges it a
 *   **flat 192** against 800 109 on the wire, so `truncateEvent` is never entered
 *   on it at all and the under-report is ~4 000×. That number is not only this
 *   bound's: the per-session byte budget and `MAX_QUEUE_BYTES` read it too.
 * - `agent_config` **was a fourth and is not one any more**, recorded because a
 *   reader who finds it absent from this list should know it was here rather than
 *   assume nobody looked. Unbounded it weighed **5 418 664 bytes** after
 *   truncation on the census's own hostile fixture; bounded at ingest the same
 *   fixture comes through at ~35 KiB.
 *
 *   ⚠ **It took three bounds, not one, and the third was missed for a whole
 *   revision after the other two read as done.** `toConfigOptions` and `toModes`
 *   stand on `session/new` and `session/resume`; a `current_mode_update`
 *   notification reaches `updateConfig` directly and wrote its `currentModeId`
 *   through with no bound at all. Measured through a real registry and a stub
 *   agent over real streams: a 2 MB id logged an `agent_config` of **2 098 061
 *   bytes**, and 916 with the bound. Nothing in the type system connects the
 *   three, so the guard against a fourth path is the label census in
 *   `scripts/daemoncheck.after-the-turn-and-config.ts` rather than this list.
 *
 * ⚠ **Bounding those two session ids at ingest was considered and refused**, and
 * the reason is this repository's own rule about which agent-minted ids may be
 * clipped. `messageId` and `toolCallId` are clipped precisely because they never
 * leave this fleet; an async task id and a permission's `optionId` are *refused*
 * rather than clipped because they round-trip to the agent, where a clipped one
 * names nothing. An agent session id is the extreme case of the second kind — it
 * is `AcpClient`'s routing key and rides every `session/prompt`,
 * `session/cancel` and `session/close` — so clipping it addresses a conversation
 * that does not exist, and refusing an over-long one at `session/new` turns a
 * large event into a session that cannot start. Clipping only the *copy on the
 * event* was refused too: `ContextClearedEvent` exists to answer why a
 * transcript and an agent disagree about what was said, and a halved id answers
 * that wrongly rather than briefly — `truncateEvent`'s own arm says a clipped id
 * names nothing. The door with no round-trip argument against it is
 * `plan.entries`, so that is the one to bound first if this is ever closed.
 *
 * What is left open is therefore narrower than what was fixed, and that is the
 * whole argument for recording it rather than closing it: reaching this ceiling
 * now needs a session id or a plan hundreds of kilobytes wide, which is a
 * different shape of agent from the ~1 MiB *question* measured above, where the
 * oversized field was prose an agent writes on purpose.
 *
 * ⚠ **Nothing holds this constant and `src/server.ts`'s `BATCH_MAX_BYTES` to each
 * other.** `packages/web` may not import `src/`, which is the same reason
 * `RELAY_CHANNEL_PATH` exists as two literals — except that a drift here shows up
 * as one large message refused rather than as a fleet that cannot connect, which
 * is why the pair is a comment and not a driver.
 *
 * What *is* a driver, and is a different claim: `daemoncheck.after-the-turn-and-config`
 * imports this constant and weighs every `truncateEvent` arm against it. That
 * holds the **events** to this number. It still holds nothing to the 512 KiB one
 * file over, so the halving in that pair is as unchecked as this paragraph has
 * always said.
 */
export const MAX_SOCKET_MESSAGE_BYTES = 1024 * 1024;

/** What an initiator says first, carrying the capability it was minted. */
export interface HelloFrame {
  capability: string;
}

/** A request, as the daemon will make it against its own loopback listener. */
export interface RequestFrame {
  method: string;
  path: string;
  headers: Record<string, string>;
  /** Whether any `REQUEST_BODY` frames follow. */
  body: boolean;
}

/** The answer's head. Always precedes any body frame. */
export interface ResponseFrame {
  status: number;
  statusText: string;
  headers: Record<string, string>;
}

/** Open a socket at `path` rather than send a request. */
export interface OpenFrame {
  path: string;
}

/** A socket closing, or a connection giving up. */
export interface CloseFrame {
  code: number;
  reason: string;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** One frame: a type byte, then its payload. */
export function encodeFrame(type: FrameType, payload: Uint8Array = new Uint8Array(0)): Uint8Array {
  if (payload.length > MAX_FRAME_PAYLOAD) throw new Error("frame payload is too large");
  const out = new Uint8Array(payload.length + 1);
  out[0] = type;
  out.set(payload, 1);
  return out;
}

/** A frame carrying JSON, which every control frame does. */
export function encodeJsonFrame(type: FrameType, value: unknown): Uint8Array {
  const frame = tryEncodeJsonFrame(type, value);
  if (frame === null) throw new Error("frame description is too large");
  return frame;
}

/**
 * The same frame, refused with `null` rather than thrown.
 *
 * `encodeJsonFrame` throws and should keep throwing everywhere the description is
 * something this codebase chose — a `{path}`, a `{code, reason}`, a capability:
 * one of those exceeding a frame is a bug here, and a bug should read like one.
 * The response head is the one description that is **not** chosen here. It is
 * whatever headers the loopback listener put on the answer, assembled inside an
 * `http` `"response"` listener that sits outside the session's `fail()`
 * discipline — so a throw there is an unhandled rejection that takes the process's
 * mood with it, where the honest outcome is the connection failing with a `502`
 * the app can see. That one caller takes this and fails on `null`, the same
 * posture `decodeJson`'s callers hold for input they did not choose.
 */
export function tryEncodeJsonFrame(type: FrameType, value: unknown): Uint8Array | null {
  const json = encoder.encode(JSON.stringify(value));
  if (json.length > MAX_HEADER_JSON_BYTES) return null;
  return encodeFrame(type, json);
}

/**
 * One socket message, as the frames that carry it: `MESSAGE`×n then `MESSAGE_END`.
 *
 * Both ends split with this rather than each writing its own loop, because the
 * two loops would be in two files written by two people, and every chunk has to
 * stay at or under `MAX_FRAME_PAYLOAD` — which is `encodeFrame`'s own throw, not
 * the assembler's bound: `MessageAssembler` counts only the total against
 * `MAX_SOCKET_MESSAGE_BYTES` and applies no per-chunk check at all. A zero-length
 * message is legal on a WebSocket and survives as no chunks and a terminator,
 * which `MessageAssembler` gives back as zero bytes rather than as nothing.
 */
export function encodeMessageFrames(message: Uint8Array): Uint8Array[] {
  const frames: Uint8Array[] = [];
  for (let at = 0; at < message.length; at += MAX_FRAME_PAYLOAD) {
    frames.push(encodeFrame(FRAME.MESSAGE, message.subarray(at, at + MAX_FRAME_PAYLOAD)));
  }
  frames.push(encodeFrame(FRAME.MESSAGE_END));
  return frames;
}

/** The type and payload of a frame, or `null` for an empty one. */
export function decodeFrame(frame: Uint8Array): { type: number; payload: Uint8Array } | null {
  if (frame.length === 0) return null;
  return { type: frame[0]!, payload: frame.subarray(1) };
}

/**
 * The JSON a control frame carried, or `null`.
 *
 * `null` rather than a throw, and every caller treats it as a protocol error it
 * has to answer for — the same posture `parseClaims` takes one package over, and
 * for the same reason: this parses bytes that arrived over a network, so a caller
 * has to handle bad input whatever this does.
 */
export function decodeJson<T>(payload: Uint8Array): T | null {
  if (payload.length > MAX_HEADER_JSON_BYTES) return null;
  try {
    const parsed: unknown = JSON.parse(decoder.decode(payload));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed as T;
  } catch {
    // Not JSON. The caller answers with a refusal rather than guessing.
    return null;
  }
}

/**
 * The receiving half of `encodeMessageFrames`: chunks in, one message out.
 *
 * One of these per socket, and it is the only place the bound lives — a bound
 * each end enforced for itself would be a bound one end eventually did not.
 *
 * **Bytes, and decoded only once at the end.** A chunk boundary is a byte count
 * and can fall inside a multi-byte UTF-8 sequence, so decoding a chunk on arrival
 * would put a U+FFFD where a character was and hand the reducer JSON it drops
 * without saying so. `TextDecoder` with `{stream: true}` would also answer, but it
 * makes the decoder itself stateful and pairs a second piece of per-socket state
 * with this one; concatenating is what the response half already does, and it
 * hands the caller bytes, which is what a binary message would need anyway.
 *
 * The payloads pushed in are `decodeFrame`'s views into a plaintext buffer, and
 * they are held until `end()`. That is safe because both ends decrypt each Noise
 * message into a **fresh** array — a reader that ever decrypts into a reused
 * buffer has to copy on the way in.
 */
export class MessageAssembler {
  private chunks: Uint8Array[] = [];
  private bytes = 0;
  private overflowed = false;

  /**
   * One `MESSAGE` payload. `false` once the message is past
   * `MAX_SOCKET_MESSAGE_BYTES`, which the caller answers by failing the
   * connection — held chunks are dropped at that point, so carrying on would
   * deliver a hole.
   */
  push(payload: Uint8Array): boolean {
    if (this.overflowed) return false;
    if (this.bytes + payload.length > MAX_SOCKET_MESSAGE_BYTES) {
      this.overflowed = true;
      this.chunks = [];
      this.bytes = 0;
      return false;
    }
    this.chunks.push(payload);
    this.bytes += payload.length;
    return true;
  }

  /**
   * `MESSAGE_END` arrived: the whole message, or `null` if the bound was passed.
   *
   * `null` rather than a short message, for the reason `RESPONSE_END` and `FAILED`
   * are separate frames — a caller that ignored `push`'s answer must not then be
   * handed something that looks like a message. Ready for the next one either way.
   */
  end(): Uint8Array | null {
    if (this.overflowed) {
      this.overflowed = false;
      return null;
    }
    const out = new Uint8Array(this.bytes);
    let at = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, at);
      at += chunk.length;
    }
    this.chunks = [];
    this.bytes = 0;
    return out;
  }
}

/* ------------------------------------------------------------------ *
 * Length-prefixed framing over a byte stream
 *
 * Both legs underneath — the app's WebSocket to the relay, and the relay's h2
 * CONNECT stream to the daemon — deliver bytes rather than messages:
 * `createWebSocketStream` collapses WebSocket message boundaries, and an h2
 * stream never had any. So the Noise messages are self-delimiting.
 * ------------------------------------------------------------------ */

/** A Noise message on the wire: two bytes of length, then the ciphertext. */
export function frameLength(message: Uint8Array): Uint8Array {
  if (message.length > 65535) throw new Error("noise message is too large to frame");
  const out = new Uint8Array(message.length + 2);
  out[0] = (message.length >> 8) & 0xff;
  out[1] = message.length & 0xff;
  out.set(message, 2);
  return out;
}

/**
 * Reassembles length-prefixed messages out of an arbitrary byte stream.
 *
 * Stateful on purpose: a message is split across reads whenever it is larger than
 * one TCP segment, which for a transcript page is always. A reader that assumed
 * one read is one message would work on a laptop and fail on a phone.
 */
export class LengthReader {
  private held = new Uint8Array(0);

  /** Feed bytes in; take whole messages out. */
  push(chunk: Uint8Array): Uint8Array[] {
    const merged = new Uint8Array(this.held.length + chunk.length);
    merged.set(this.held);
    merged.set(chunk, this.held.length);

    const out: Uint8Array[] = [];
    let at = 0;
    for (;;) {
      if (merged.length - at < 2) break;
      const length = (merged[at]! << 8) | merged[at + 1]!;
      if (merged.length - at - 2 < length) break;
      out.push(merged.slice(at + 2, at + 2 + length));
      at += 2 + length;
    }
    this.held = merged.subarray(at);
    return out;
  }
}
