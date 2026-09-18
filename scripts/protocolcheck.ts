#!/usr/bin/env node
import { readFileSync } from "node:fs";
import {
  CipherState,
  FRAME,
  MAX_FRAME_PAYLOAD,
  MAX_HEADER_JSON_BYTES,
  MAX_SOCKET_MESSAGE_BYTES,
  MessageAssembler,
  NoiseHandshake,
  decodeFrame,
  decodeJson,
  encodeFrame,
  encodeJsonFrame,
  encodeMessageFrames,
  frameLength,
  localStaticKey,
  publicFromSecret,
  randomSecretKey,
  tryEncodeJsonFrame,
  type Ephemeral,
} from "@reemoat/protocol";

/**
 * The regression driver for `packages/protocol`.
 *
 * **This is the only driver in the tree whose subject is a specification written
 * by somebody else**, and that is what shapes it. Every other check here asserts
 * a decision this repository made; this one asserts that our bytes are the bytes
 * the Noise Protocol Framework says they should be — because a handshake that
 * only ever talks to itself round-trips perfectly while interoperating with
 * nothing, and would go on doing so through a nonce written big-endian, an HKDF
 * borrowed from RFC 5869, or a protocol name hashed when it should have been
 * padded. Each of those is a real way to get this wrong and none of them shows
 * up in a self-test.
 *
 * So the first section drives the **official cross-implementation vectors**, with
 * the ephemerals pinned to the ones the vector fixes, and compares whole messages
 * byte for byte in both roles. `packages/protocol/vectors/noise.txt` carries the
 * `Noise_IK_25519_ChaChaPoly_BLAKE2s` entry from snow's `snow.txt`, which is the
 * set every serious implementation is checked against.
 *
 * ⚠ **The vector file is `.txt` rather than `.json`, and that is not cosmetic.**
 * `docscheck`'s `SOURCE_EXT` includes `json`, so a vector file under `packages/`
 * with that extension joins the corpus every cited symbol is grepped against —
 * and a few kilobytes of foreign hex is exactly the material that lets a stale
 * `DECISIONS.md` pointer "resolve" against nothing real. `txt` is also the
 * extension the official vector files ship with, so the safe name is the natural
 * one.
 *
 * **Two subjects underneath the vectors are this repository's own**, and both are
 * here because the specification has nothing to say about them:
 *
 * - **The top of the nonce's range.** Revision 34 reserves `2^64 - 1`, so the
 *   guard has to be `>=`, and it was `>` — a single message sealed under the
 *   reserved value, which a conforming peer refuses to open. Nothing could reach
 *   that branch: `counter` is private and the only way to `2^64` was to send
 *   `2^64` messages, so the defect sat inside a guard every green run of this file
 *   walked past. `CipherState.at` exists for this section alone, and these
 *   assertions are what keeps a driver-only seam honest.
 * - **The frame table.** `frames.ts` had no driver at all, and it is where the two
 *   bounds that must agree live: `MAX_HEADER_JSON_BYTES` was written as
 *   `64 * 1024`, eighteen bytes *larger* than one frame can hold, so a description
 *   in that window was admitted by the layer that owns the bound and thrown on by
 *   the layer underneath — a refusal arriving from the wrong place, with the wrong
 *   words, from inside a listener with no `try` around it. It is derived now, and
 *   asserted here as the **relation** rather than as two numbers, because two
 *   numbers agree right up until somebody edits one of them.
 *
 * Offline, deterministic, no fleet and no agent — so it joins `pnpm check`.
 *
 *   pnpm protocolcheck
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

function report(name: string, ok: boolean, detail: string): void {
  if (ok) {
    process.stdout.write(`  ok    ${name}  (${detail})\n`);
    return;
  }
  failures += 1;
  process.stdout.write(`  FAIL  ${name}  (${detail})\n`);
}

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");
const unhex = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, "hex"));

/** A generator that hands out the vector's pinned ephemerals, in order. */
function pinned(...secrets: readonly string[]): () => Ephemeral {
  let at = 0;
  return () => {
    const secret = secrets[at];
    at += 1;
    if (secret === undefined) throw new Error("protocolcheck: the handshake asked for an ephemeral the vector does not pin");
    const secretKey = unhex(secret);
    return { secretKey, publicKey: publicFromSecret(secretKey) };
  };
}

interface Vector {
  protocol_name: string;
  init_prologue: string;
  init_static: string;
  init_ephemeral: string;
  init_remote_static: string;
  resp_static: string;
  resp_ephemeral: string;
  messages: { payload: string; ciphertext: string }[];
}

const vectorFile = JSON.parse(
  readFileSync(new URL("../packages/protocol/vectors/noise.txt", import.meta.url), "utf8"),
) as { source: string; vectors: Vector[] };

const vector = vectorFile.vectors.find((v) => v.protocol_name === "Noise_IK_25519_ChaChaPoly_BLAKE2s");
if (vector === undefined) throw new Error("protocolcheck: the IK vector is missing from the vendored file");

/* ------------------------------------------------------------------ *
 * The official vectors
 * ------------------------------------------------------------------ */

process.stdout.write("\nNoise_IK_25519_ChaChaPoly_BLAKE2s against the published vectors\n");

const prologue = unhex(vector.init_prologue);
const initStatic = localStaticKey(unhex(vector.init_static));
const respStatic = localStaticKey(unhex(vector.resp_static));

/*
 * The non-vacuity control, and it earns its place: if the vector's
 * `init_remote_static` were not in fact the responder's public key, every
 * comparison below would be against a handshake nobody could have.
 */
check("the vector's remote static really is the responder's public key", hex(respStatic.publicKey), vector.init_remote_static);
report("the vector carries handshake messages and transport messages", vector.messages.length === 4, `${vector.messages.length} messages`);

{
  const initiator = NoiseHandshake.start({
    initiator: true,
    staticKey: initStatic,
    remoteStatic: unhex(vector.init_remote_static),
    prologue,
    ephemeral: pinned(vector.init_ephemeral),
  });
  const responder = NoiseHandshake.start({
    initiator: false,
    staticKey: respStatic,
    prologue,
    ephemeral: pinned(vector.resp_ephemeral),
  });

  const first = vector.messages[0]!;
  const written = await initiator.writeMessage(unhex(first.payload));
  check("message 1 is byte-for-byte the published ciphertext", hex(written), first.ciphertext);

  const readBack = await responder.readMessage(unhex(first.ciphertext));
  check("and the responder reads the payload out of the published bytes", hex(readBack), first.payload);

  /*
   * The check the whole feature rests on. `IK` transmits the initiator's static
   * key encrypted inside message 1, and on the daemon that key **is the device
   * key** — comparing it to the one inside the Authority-signed capability is the
   * entire binding. If this ever answered the wrong thing, a capability would
   * verify against a device that did not send it.
   */
  check(
    "the responder learns the initiator's static key, which is the device binding",
    hex(responder.remoteStaticKey ?? new Uint8Array(0)),
    hex(initStatic.publicKey),
  );

  const second = vector.messages[1]!;
  const reply = await responder.writeMessage(unhex(second.payload));
  check("message 2 is byte-for-byte the published ciphertext", hex(reply), second.ciphertext);
  check("and the initiator reads its payload", hex(await initiator.readMessage(unhex(second.ciphertext))), second.payload);

  report("both ends finished the handshake", initiator.complete && responder.complete, "split available on both");

  const fromInitiator = initiator.split();
  const fromResponder = responder.split();

  /*
   * ⚠ Both ends deriving the same *pair* is not the property. The property is
   * that each end's `send` is the other end's `receive` — get that backwards and
   * a self-test still passes, because both ends are wrong in the same direction.
   */
  const third = vector.messages[2]!;
  check(
    "the first transport message matches the vector",
    hex(fromInitiator.send.encrypt(new Uint8Array(0), unhex(third.payload))),
    third.ciphertext,
  );
  check(
    "and the responder opens it with the key pointed the other way",
    hex(fromResponder.receive.decrypt(new Uint8Array(0), unhex(third.ciphertext))),
    third.payload,
  );

  const fourth = vector.messages[3]!;
  check(
    "the reply transport message matches the vector",
    hex(fromResponder.send.encrypt(new Uint8Array(0), unhex(fourth.payload))),
    fourth.ciphertext,
  );
  check(
    "and the initiator opens that one",
    hex(fromInitiator.receive.decrypt(new Uint8Array(0), unhex(fourth.ciphertext))),
    fourth.payload,
  );

  check("both ends agree on the handshake hash", hex(fromInitiator.handshakeHash), hex(fromResponder.handshakeHash));
}

/* ------------------------------------------------------------------ *
 * A live handshake, with nothing pinned
 *
 * The vectors prove we agree with everybody else. These prove the parts a vector
 * cannot reach: that two sessions are independent, that tampering is refused, and
 * that a failed open does not move the counter.
 * ------------------------------------------------------------------ */

process.stdout.write("\na live handshake\n");

async function establish(
  machine = respStatic,
  claimed: Uint8Array = respStatic.publicKey,
  device = initStatic,
): Promise<{ initiator: NoiseHandshake; responder: NoiseHandshake }> {
  const initiator = NoiseHandshake.start({ initiator: true, staticKey: device, remoteStatic: claimed });
  const responder = NoiseHandshake.start({ initiator: false, staticKey: machine });
  await responder.readMessage(await initiator.writeMessage());
  await initiator.readMessage(await responder.writeMessage());
  return { initiator, responder };
}

{
  const one = await establish();
  const two = await establish();

  const sealOne = one.initiator.split().send.encrypt(new Uint8Array(0), new TextEncoder().encode("prompt"));
  const sealTwo = two.initiator.split().send.encrypt(new Uint8Array(0), new TextEncoder().encode("prompt"));

  /*
   * Two devices — or the same device twice — must never share a key. This is the
   * one assertion standing between us and a fleet-wide symmetric key, which is
   * the failure the whole design is arranged to make impossible rather than
   * merely unlikely.
   */
  report("two sessions seal the same plaintext differently", hex(sealOne) !== hex(sealTwo), "independent session keys");

  let opened = false;
  try {
    two.responder.split().receive.decrypt(new Uint8Array(0), sealOne);
    opened = true;
  } catch {
    // Expected: a session's keys are its own.
  }
  report("and one session cannot open the other's traffic", !opened, "cross-session open refused");
}

{
  const { initiator, responder } = await establish();
  const send = initiator.split().send;
  const receive = responder.split().receive;

  const sealed = send.encrypt(new Uint8Array(0), new TextEncoder().encode("a diff nobody else may read"));
  const tampered = Uint8Array.from(sealed);
  tampered[0] = (tampered[0]! ^ 0x01) & 0xff;

  let accepted = false;
  try {
    receive.decrypt(new Uint8Array(0), tampered);
    accepted = true;
  } catch {
    // Expected: Poly1305 refuses it.
  }
  report("a flipped bit is refused rather than delivered", !accepted, "one byte of ciphertext altered");

  /*
   * ⚠ **The counter must not have moved.** The specification says a failed open
   * does not advance it, and the reason is availability rather than tidiness:
   * anybody who can inject one bad frame into the stream could otherwise
   * desynchronise the two ends permanently, turning a tamper attempt into a
   * denial of service that outlives it.
   */
  report("and the refusal did not advance the nonce", receive.nonce === 0n, `nonce ${receive.nonce}`);
  report("so the genuine frame still opens", hex(receive.decrypt(new Uint8Array(0), sealed)).length > 0, `nonce now ${receive.nonce}`);
}

{
  /*
   * The impersonation case, and it is the reason for IK rather than XX.
   *
   * An app is told a machine's public key by the Authority. If a different
   * machine answers — a relay pointing the stream somewhere else — the handshake
   * has to fail, and it must fail at the *responder*, which cannot open a message
   * that was not encrypted to it.
   */
  const impostor = localStaticKey(randomSecretKey());
  const initiator = NoiseHandshake.start({ initiator: true, staticKey: initStatic, remoteStatic: respStatic.publicKey });
  const responder = NoiseHandshake.start({ initiator: false, staticKey: impostor });

  let reached = false;
  try {
    await responder.readMessage(await initiator.writeMessage());
    reached = true;
  } catch {
    // Expected: `es` mixed a different key, so `DecryptAndHash` fails.
  }
  report("a machine that is not the expected one cannot complete the handshake", !reached, "wrong responder static");
}

{
  // An initiator with no remote static is refused where it is written rather
  // than failing later inside a DH, which would name neither end.
  let refused = "";
  try {
    NoiseHandshake.start({ initiator: true, staticKey: initStatic });
  } catch (error) {
    refused = error instanceof Error ? error.message : String(error);
  }
  report("an IK initiator with no responder key is refused up front", refused.includes("static key"), refused || "(not refused)");
}

{
  /*
   * The prologue is authenticated, and a mismatch has to fail.
   *
   * It costs nothing to send — both ends already know the protocol name, the
   * negotiated mode and the machine id — and it is what stops a handshake
   * recorded in one context being replayed into another. Asserting it is the only
   * way to know the argument is wired to anything.
   */
  const initiator = NoiseHandshake.start({
    initiator: true,
    staticKey: initStatic,
    remoteStatic: respStatic.publicKey,
    prologue: new TextEncoder().encode("m_alice"),
  });
  const responder = NoiseHandshake.start({
    initiator: false,
    staticKey: respStatic,
    prologue: new TextEncoder().encode("m_bob"),
  });

  let agreed = false;
  try {
    await responder.readMessage(await initiator.writeMessage());
    agreed = true;
  } catch {
    // Expected: the prologue is mixed into `h` before anything else.
  }
  report("two ends that disagree about the prologue cannot handshake", !agreed, "different machine ids");
}

{
  // A handshake message replayed into a finished handshake is refused rather
  // than quietly re-running a step.
  const { initiator } = await establish();
  let replayed = false;
  try {
    await initiator.readMessage(new Uint8Array(96));
    replayed = true;
  } catch {
    // Expected: there is no third message in IK.
  }
  report("a message after the handshake is over is refused", !replayed, "IK has two messages");
}

{
  // A truncated handshake message must be refused rather than read past its end.
  const initiator = NoiseHandshake.start({ initiator: true, staticKey: initStatic, remoteStatic: respStatic.publicKey });
  const responder = NoiseHandshake.start({ initiator: false, staticKey: respStatic });
  const full = await initiator.writeMessage();

  let short = false;
  try {
    await responder.readMessage(full.subarray(0, 20));
    short = true;
  } catch {
    // Expected.
  }
  report("a truncated handshake message is refused", !short, `${full.length} bytes cut to 20`);
}

{
  // A cipher with no key is the pre-`MixKey` state and must pass bytes through,
  // which is what makes the first `MixHash` of an unencrypted `e` work.
  const bare = new CipherState(null);
  const message = new TextEncoder().encode("plain");
  check("a keyless cipher state is a pass-through", hex(bare.encrypt(new Uint8Array(0), message)), hex(message));
}

/* ------------------------------------------------------------------ *
 * The top of the nonce's range
 *
 * The one branch in `noise.ts` that no amount of driving could reach until a seam
 * was cut for it. A session starts both cipher states at zero and never says so
 * to the other end, so the only route to the ceiling was `2^64` messages — and a
 * guard nothing can reach is a guard nobody has read carefully, which is how `>`
 * survived: it lets exactly one message be sealed under the value revision 34
 * **reserves**, and a conforming peer refuses to open that message. The failure
 * would arrive after a session had run long enough that nobody was watching, and
 * would look like a tag failure, which is the one thing in this protocol that
 * already means *somebody is attacking you*.
 *
 * So `CipherState.at` exists, it is documented as drivers-only, and this section
 * is the whole of its justification.
 * ------------------------------------------------------------------ */

process.stdout.write("\nthe top of the nonce's range\n");

/**
 * `2^64 - 1`, the value revision 34 §5.1 reserves.
 *
 * Written out here rather than imported, because `noise.ts` deliberately does not
 * export it — nothing in a session has any business naming a nonce, and a
 * constant a session can reach is one a session eventually uses. Stating the
 * specification's number in the driver is also what makes this a check rather
 * than a tautology: an implementation that moved its own ceiling would disagree
 * with the specification here instead of agreeing with a copy of itself.
 */
const RESERVED_NONCE = (1n << 64n) - 1n;

{
  const key = new Uint8Array(32).fill(7);
  const ad = new Uint8Array(0);
  const plaintext = new TextEncoder().encode("one message past the end");

  const exhausted = CipherState.at(key, RESERVED_NONCE);

  let sealing = "(not refused)";
  try {
    exhausted.encrypt(ad, plaintext);
  } catch (error) {
    sealing = error instanceof Error ? error.message : String(error);
  }
  report("a cipher standing on the reserved nonce refuses to seal", sealing.includes("nonce exhausted"), sealing);

  /*
   * ⚠ **Both directions, and the receiving one is the half that is easy to
   * forget.** A guard on `encrypt` alone still refuses to *produce* the message
   * nobody can open, and then happily opens one — so a peer that reached the
   * ceiling by its own arithmetic would drive this end past it. The assertion is
   * on the *words*, because a 32-byte ciphertext under a real key fails the tag
   * check too, and a `report` that only asked "did it throw" would pass either
   * way.
   */
  let opening = "(not refused)";
  try {
    exhausted.decrypt(ad, new Uint8Array(32));
  } catch (error) {
    opening = error instanceof Error ? error.message : String(error);
  }
  report("and refuses to open one", opening.includes("nonce exhausted"), opening);
  report("with the counter left exactly where it was", exhausted.nonce === RESERVED_NONCE, `nonce ${exhausted.nonce}`);
}

{
  /*
   * The other side of `>=` versus `>`: the last nonce the specification allows is
   * `2^64 - 2`, and it has to be usable — a ceiling one message early is a bug in
   * the safe direction, but it is still a disagreement with every other
   * implementation, and this is the only place it would ever show.
   */
  const key = new Uint8Array(32).fill(9);
  const ad = new Uint8Array(0);
  const plaintext = new TextEncoder().encode("the last message this key may seal");

  const sender = CipherState.at(key, RESERVED_NONCE - 1n);
  const sealed = sender.encrypt(ad, plaintext);
  report("the last legal nonce still seals a message", sealed.length === plaintext.length + 16, `${sealed.length} bytes, tag included`);
  report("and spends itself doing it", sender.nonce === RESERVED_NONCE, `nonce ${sender.nonce}`);

  let again = "(not refused)";
  try {
    sender.encrypt(ad, plaintext);
  } catch (error) {
    again = error instanceof Error ? error.message : String(error);
  }
  report("so the next one is refused rather than sealed under the reserved value", again.includes("nonce exhausted"), again);

  const receiver = CipherState.at(key, RESERVED_NONCE - 1n);
  check("and the far end opens what it sealed", hex(receiver.decrypt(ad, sealed)), hex(plaintext));
}

{
  /*
   * ⚠ **The seam may not change the ordinary case.** Both ends of a real
   * transport start at zero, so a cipher handed `0n` has to be the one the
   * constructor builds, byte for byte — otherwise `at` is a second way to make a
   * cipher state and the drivers are exercising something the fleet does not run.
   */
  const key = new Uint8Array(32).fill(3);
  const ad = new Uint8Array(0);
  const message = new TextEncoder().encode("the first frame of a session");
  check(
    "a cipher handed a starting counter of zero is the one a session builds",
    hex(CipherState.at(key, 0n).encrypt(ad, message)),
    hex(new CipherState(key).encrypt(ad, message)),
  );

  let above = "(not refused)";
  try {
    CipherState.at(key, RESERVED_NONCE + 1n);
  } catch (error) {
    above = error instanceof Error ? error.message : String(error);
  }
  report("a starting counter outside the 64-bit range is refused where it is written", above.includes("64-bit"), above);

  let below = "(not refused)";
  try {
    CipherState.at(key, -1n);
  } catch (error) {
    below = error instanceof Error ? error.message : String(error);
  }
  report("in both directions", below.includes("64-bit"), below);
}

/* ------------------------------------------------------------------ *
 * The frames inside the channel
 *
 * `frames.ts` is the other half of this package and had no driver at all. What is
 * asserted here is not "the encoder encodes" — it is the three bounds that have to
 * agree with each other, stated as relations rather than as numbers, because a
 * pair of numbers agrees until somebody edits one of them:
 *
 *   payload ≤ MAX_FRAME_PAYLOAD · header JSON ≤ MAX_FRAME_PAYLOAD · sealed ≤ 65535
 *
 * The middle one is the measured defect: `MAX_HEADER_JSON_BYTES` was `64 * 1024`,
 * eighteen bytes larger than a frame, so descriptions in that window passed the
 * layer that owns the bound and threw from the layer below.
 * ------------------------------------------------------------------ */

process.stdout.write("\nthe frames inside the channel\n");

{
  const largest = encodeFrame(FRAME.MESSAGE, new Uint8Array(MAX_FRAME_PAYLOAD));
  check("a frame may carry MAX_FRAME_PAYLOAD bytes behind its type byte", largest.length, MAX_FRAME_PAYLOAD + 1);

  let over = "(not refused)";
  try {
    encodeFrame(FRAME.MESSAGE, new Uint8Array(MAX_FRAME_PAYLOAD + 1));
  } catch (error) {
    over = error instanceof Error ? error.message : String(error);
  }
  report("and one byte more is refused", over === "frame payload is too large", over);

  /*
   * ⚠ **Why `MAX_FRAME_PAYLOAD` is `65535 - 16 - 1` and not a round number**, in
   * one assertion: the largest frame, once sealed, is exactly the largest thing
   * the two-byte length prefix can describe. Asserted through a real `CipherState`
   * rather than by adding 16 in the driver, so the day the AEAD's tag changes size
   * this fails here instead of on a phone.
   */
  const sealed = new CipherState(new Uint8Array(32).fill(1)).encrypt(new Uint8Array(0), largest);
  check("a full frame, sealed, is exactly what a length prefix can describe", sealed.length, 65535);
  check("so the largest frame still frames", frameLength(sealed).length, 65537);

  let unframeable = "(not refused)";
  try {
    frameLength(new Uint8Array(65536));
  } catch (error) {
    unframeable = error instanceof Error ? error.message : String(error);
  }
  report("while anything above 65535 is refused rather than silently truncated by the prefix", unframeable === "noise message is too large to frame", unframeable);
}

{
  report(
    "the header bound cannot exceed what one frame carries",
    MAX_HEADER_JSON_BYTES <= MAX_FRAME_PAYLOAD,
    `${MAX_HEADER_JSON_BYTES} ≤ ${MAX_FRAME_PAYLOAD}`,
  );

  /** A description whose JSON is exactly `bytes` long: `{"pad":"…"}` is ten. */
  const description = (bytes: number): { pad: string } => ({ pad: "x".repeat(bytes - 10) });
  check("the fixture description is the size it claims", JSON.stringify(description(MAX_HEADER_JSON_BYTES)).length, MAX_HEADER_JSON_BYTES);

  check(
    "a description at exactly the bound encodes",
    encodeJsonFrame(FRAME.REQUEST, description(MAX_HEADER_JSON_BYTES)).length,
    MAX_FRAME_PAYLOAD + 1,
  );

  /*
   * ⚠ **The words are the assertion.** "frame description is too large" is this
   * layer refusing; "frame payload is too large" is `encodeFrame` throwing
   * underneath — which is precisely what the eighteen-byte window produced, and
   * what a reader chasing the refusal would have gone to the wrong file for.
   */
  let over = "(not refused)";
  try {
    encodeJsonFrame(FRAME.REQUEST, description(MAX_HEADER_JSON_BYTES + 1));
  } catch (error) {
    over = error instanceof Error ? error.message : String(error);
  }
  report("one byte more is refused by the layer that owns the bound", over === "frame description is too large", over);

  /*
   * The same value through the one caller that did not choose its own
   * description. A response head is whatever the loopback listener put on the
   * answer, assembled outside the frame loop's `try`, so it needs a `null` rather
   * than a throw — and the pair is only a pair if both are driven.
   */
  report(
    "and answers null, rather than throwing, for the one caller that did not choose it",
    tryEncodeJsonFrame(FRAME.RESPONSE, description(MAX_HEADER_JSON_BYTES + 1)) === null,
    "tryEncodeJsonFrame",
  );
}

{
  const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

  check("a control frame's JSON is read back", decodeJson<{ a: number }>(bytes('{"a":1}')), { a: 1 });
  /*
   * ⚠ **An array is JSON and is not a frame.** Every caller reads named fields off
   * what this returns, and `[].capability` is `undefined` rather than an error —
   * so without this arm a peer sends `["…"]` and the refusal happens somewhere
   * downstream, if at all. `null` is the same shape: `typeof null === "object"`.
   */
  check("an array is refused rather than handed back as an object", decodeJson(bytes("[1,2,3]")), null);
  check("so is JSON's own null", decodeJson(bytes("null")), null);
  check("bytes that are not JSON at all are refused", decodeJson(bytes("not json")), null);
  check(
    "and a payload above the header bound is refused before it is parsed",
    decodeJson(new Uint8Array(MAX_HEADER_JSON_BYTES + 1)),
    null,
  );

  check("an empty frame decodes to nothing, rather than to frame type zero", decodeFrame(new Uint8Array(0)), null);
  const decoded = decodeFrame(encodeFrame(FRAME.MESSAGE, bytes("hi")));
  check("and a frame gives back its type and its payload", [decoded?.type, new TextDecoder().decode(decoded?.payload)], [FRAME.MESSAGE, "hi"]);
}

/* ------------------------------------------------------------------ *
 * One socket message, in pieces
 *
 * The half of the protocol that had no terminator, and the failure it caused was
 * silent: a receiver with no boundary to read raised **each chunk** as its own
 * message, so a 512 KiB event batch arrived as eight JSON fragments, every one of
 * them dropped by a reducer that then left the cursor where it was. `MESSAGE_END`
 * is the fix and this is the assertion that the two halves of it agree — the
 * splitter's chunk size and the assembler's bound are one number, in one file, on
 * purpose, because the two ends live in packages that may not import each other.
 * ------------------------------------------------------------------ */

process.stdout.write("\none socket message, in pieces\n");

{
  /*
   * ⚠ **A two-byte character placed exactly on the first chunk boundary**, which
   * is the case the rule *"reassembly is over bytes, never over text"* exists for.
   * A chunk boundary is a byte count: it can fall inside a multi-byte UTF-8
   * sequence, and an implementation that decoded each chunk as it arrived would
   * put a U+FFFD where the character was and hand the reducer JSON it drops
   * without saying so. The control at the bottom of this block is what says that
   * hazard is real rather than theoretical.
   */
  const head = '{"pad":"';
  const tail = '"}';
  const before = "a".repeat(MAX_FRAME_PAYLOAD - head.length - 1);
  const after = "b".repeat(200_000 - head.length - before.length - 2 - tail.length);
  const text = `${head}${before}é${after}${tail}`;
  const message = new TextEncoder().encode(text);

  check("the fixture message is 200 000 bytes", message.length, 200_000);
  report("which is more than one frame can carry", message.length > MAX_FRAME_PAYLOAD, `${MAX_FRAME_PAYLOAD} bytes per frame`);

  const frames = encodeMessageFrames(message);
  check(
    "so it travels as several MESSAGE frames and one terminator",
    [frames.length, frames[frames.length - 1]![0], frames[frames.length - 1]!.length],
    [5, FRAME.MESSAGE_END, 1],
  );

  const assembler = new MessageAssembler();
  let refused = 0;
  for (const frame of frames.slice(0, -1)) {
    if (!assembler.push(frame.subarray(1))) refused += 1;
  }
  report("every chunk is taken", refused === 0, `${frames.length - 1} chunks`);

  const whole = assembler.end();
  check("and the terminator hands back the message, byte for byte", hex(whole ?? new Uint8Array(0)), hex(message));

  const parsed = JSON.parse(new TextDecoder().decode(whole ?? new Uint8Array(0))) as { pad: string };
  report("which parses, with the character on the boundary intact", parsed.pad.includes("é"), `${parsed.pad.length} characters`);

  /*
   * The control. Decoding each chunk as it arrives is the obvious implementation
   * and it is the wrong one — and it fails *quietly*: what comes back is still
   * valid JSON, with one character replaced, which is the kind of corruption
   * nothing downstream can detect.
   */
  const perChunk = frames
    .slice(0, -1)
    .map((frame) => new TextDecoder().decode(frame.subarray(1)))
    .join("");
  report(
    "while decoding each chunk as it arrives corrupts the boundary silently",
    perChunk !== text && perChunk.includes("�"),
    "U+FFFD where é was, and still parses",
  );
}

{
  /*
   * A zero-length message is legal on a WebSocket, and it is the one case a
   * length-based reader gets wrong in the other direction: no chunks at all, so
   * "nothing arrived" and "an empty message arrived" have to be different answers.
   */
  const frames = encodeMessageFrames(new Uint8Array(0));
  check("a zero-length message is a terminator and nothing else", [frames.length, frames[0]![0]], [1, FRAME.MESSAGE_END]);

  const assembler = new MessageAssembler();
  const whole = assembler.end();
  report("and comes back as zero bytes rather than as nothing at all", whole !== null && whole.length === 0, "an empty message is a message");
}

{
  /*
   * ⚠ **The bound exists because a terminator is a promise the peer makes.** A
   * receiver holds chunks until `MESSAGE_END` arrives, so a peer that sends
   * `MESSAGE` for ever and never a terminator grows this heap for as long as it
   * cares to. Past the bound the held chunks are dropped — so `end()` must answer
   * `null` rather than what survived, for the `RESPONSE_END`-versus-`FAILED`
   * reason: a caller that ignored `push`'s answer must not then be handed
   * something that looks like a message.
   */
  const assembler = new MessageAssembler();
  const chunk = new Uint8Array(MAX_FRAME_PAYLOAD);
  let taken = 0;
  let stopped = false;
  while (taken * MAX_FRAME_PAYLOAD < MAX_SOCKET_MESSAGE_BYTES + MAX_FRAME_PAYLOAD) {
    if (!assembler.push(chunk)) {
      stopped = true;
      break;
    }
    taken += 1;
  }
  report("the assembler stops taking chunks past MAX_SOCKET_MESSAGE_BYTES", stopped, `${taken} × ${MAX_FRAME_PAYLOAD} bytes taken`);
  report("and refuses every chunk after the one that overflowed", !assembler.push(chunk), "still overflowed");
  check("the terminator then answers null rather than a short message", assembler.end(), null);

  const next = assembler.push(new Uint8Array(4)) ? assembler.end() : null;
  report("while the same assembler is ready for the next message", next?.length === 4, `${next?.length ?? -1} bytes`);
}

process.stdout.write(failures === 0 ? "\nall green\n" : `\n${failures} failure(s)\n`);
process.exit(failures === 0 ? 0 : 1);
