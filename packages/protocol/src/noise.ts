import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { blake2s } from "@noble/hashes/blake2.js";
import { hmac } from "@noble/hashes/hmac.js";

/**
 * `Noise_IK_25519_ChaChaPoly_BLAKE2s`, written to the Noise Protocol Framework
 * (revision 34) rather than invented.
 *
 * **What is hand-written here is the handshake the specification describes, and
 * nothing below it.** Every primitive comes from `@noble/*`: X25519, ChaCha20-
 * Poly1305, BLAKE2s and HMAC. The state machine is the part a library would have
 * given us too, and `protocolcheck` drives it against the official
 * cross-implementation test vectors — fixed ephemerals, byte-for-byte, in both
 * roles — so "we implemented Noise" is an assertion rather than a claim.
 *
 * **Why IK.** The app already learns a machine's static public key from the
 * Authority when it mints a capability, which is exactly IK's precondition: the
 * initiator knows the responder's static key before it says anything. That is
 * what lets the app establish that it reached the **expected machine** instead of
 * trusting the relay's routing, and it costs one round trip rather than XX's two.
 * The initiator's static *is the device key*, so the handshake itself proves the
 * caller holds it — which is the whole reason a stolen capability is worth
 * nothing off the device it was minted for.
 *
 * ⚠ **The capability is not sent in the handshake payload.** IK's first message
 * is encrypted to a static key alone: it has no forward secrecy and nothing stops
 * an eavesdropper replaying it verbatim. So the capability rides the first
 * *transport* message, after `ee`/`se`, where both ephemerals are fresh. It still
 * costs no extra round trip, because it travels with the first request.
 *
 * That rule is **not enforced here, deliberately.** This file implements the
 * specification, and the specification allows a payload in every handshake
 * message — the published vectors carry one in all four, which is how they check
 * it. Refusing it here would mean refusing the vectors. The rule belongs to the
 * layer that decides what to send, and it is asserted there.
 *
 * ⚠ **`dh` is asynchronous, and that is a requirement rather than a style.** In
 * the app the initiator's static key lives in the operating system's keyring and
 * is used from Rust — the page never holds it, so the two DH operations that
 * involve it (`ss` and `se`) are calls across the Tauri bridge. Making the seam
 * async here is what lets one implementation serve both ends; the daemon's own
 * static answers immediately.
 */

/** X25519, BLAKE2s and ChaCha20-Poly1305 all agree on 32. */
const KEY_BYTES = 32;

/** BLAKE2s-256. Also `DHLEN` for 25519, which is why one constant serves both. */
const HASH_BYTES = 32;

/** Poly1305. */
const TAG_BYTES = 16;

/**
 * The full protocol name, and it is 33 bytes.
 *
 * That matters: the specification says a name of `HASHLEN` bytes or fewer is
 * used *as* the initial `h`, zero-padded, and anything longer is hashed. This one
 * is longer by a single byte, so it is hashed — and a reader checking the
 * handshake by hand against a vector will otherwise get the first `MixHash`
 * wrong.
 */
const PROTOCOL_NAME = "Noise_IK_25519_ChaChaPoly_BLAKE2s";

/**
 * A static keypair whose private half may be somewhere this process cannot read.
 *
 * The daemon's implementation holds the secret and answers from memory; the
 * app's forwards to the native shell, which holds the device key in the keyring
 * and returns a shared secret rather than the key. `credential.rs` wrote that
 * interface down before there was anything to put behind it: *"a key this process
 * can read is a key this process can leak."*
 */
export interface StaticKey {
  readonly publicKey: Uint8Array;
  dh(peerPublicKey: Uint8Array): Promise<Uint8Array>;
}

/** An X25519 keypair this process holds outright. The daemon's machine key. */
export function localStaticKey(secretKey: Uint8Array): StaticKey {
  const publicKey = x25519.getPublicKey(secretKey);
  return {
    publicKey,
    dh: (peer: Uint8Array): Promise<Uint8Array> => Promise.resolve(x25519.getSharedSecret(secretKey, peer)),
  };
}

/** A fresh X25519 keypair: 32 secret bytes and the public key they imply. */
export function generateStaticKey(): { secretKey: Uint8Array; publicKey: Uint8Array } {
  const secretKey = x25519.utils.randomSecretKey();
  return { secretKey, publicKey: x25519.getPublicKey(secretKey) };
}

/**
 * The public key a secret implies.
 *
 * Re-exported rather than left to the caller because **a consumer of this package
 * must not import `@noble/*` itself.** pnpm's strict layout means a dependency of
 * this package is not resolvable from a package that merely depends on *it* — the
 * same shape as the `jose` gotcha `token.ts` records — so reaching past this
 * module for a primitive fails at run time rather than at the typecheck. Anything
 * a caller legitimately needs is exported from here.
 */
export function publicFromSecret(secretKey: Uint8Array): Uint8Array {
  return x25519.getPublicKey(secretKey);
}

/** 32 secret bytes from the platform CSPRNG, via the curve's own generator. */
export function randomSecretKey(): Uint8Array {
  return x25519.utils.randomSecretKey();
}

/** An ephemeral keypair. Injectable so the vectors can pin it; random otherwise. */
export interface Ephemeral {
  secretKey: Uint8Array;
  publicKey: Uint8Array;
}

function randomEphemeral(): Ephemeral {
  const secretKey = x25519.utils.randomSecretKey();
  return { secretKey, publicKey: x25519.getPublicKey(secretKey) };
}

function concat(...parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/**
 * HKDF as the Noise specification defines it, which is *not* RFC 5869's.
 *
 * There is no `info` and no length parameter: each output is one HMAC block, and
 * the second and third chain the previous output in front of the counter byte.
 * Reaching for a general HKDF and passing an empty `info` gives different bytes.
 */
function hkdf(chainingKey: Uint8Array, material: Uint8Array, outputs: 2 | 3): Uint8Array[] {
  const tempKey = hmac(blake2s, chainingKey, material);
  const first = hmac(blake2s, tempKey, Uint8Array.of(1));
  const second = hmac(blake2s, tempKey, concat(first, Uint8Array.of(2)));
  if (outputs === 2) return [first, second];
  return [first, second, hmac(blake2s, tempKey, concat(second, Uint8Array.of(3)))];
}

/**
 * The 96-bit ChaCha20-Poly1305 nonce Noise specifies: 32 zero bits, then the
 * 64-bit counter **little-endian**.
 *
 * Big-endian here is the classic way to write something that interoperates with
 * nothing and looks fine in a round trip against itself, which is exactly what
 * the vectors exist to catch.
 */
function nonceBytes(counter: bigint): Uint8Array {
  const out = new Uint8Array(12);
  new DataView(out.buffer).setBigUint64(4, counter, true);
  return out;
}

/**
 * `2^64 - 1`, which the specification **reserves**. Reaching it is a refusal,
 * never a wrap.
 *
 * Revision 34, §5.1: incrementing `n` to `2^64 - 1` "signals an error to the
 * caller" rather than producing a message, so the last nonce that may seal
 * anything is `2^64 - 2` and the reserved value is never used. The guards below
 * are therefore `>=` rather than `>`. They were `>`, which used the reserved value
 * itself for one message: a frame this implementation would happily produce and a
 * conforming peer would refuse to open, right at the point where a session has run
 * long enough that nobody is watching.
 *
 * Named for what it is rather than `MAX_NONCE`, because a constant called that
 * invites exactly the `>` it was written with.
 */
const RESERVED_NONCE = (1n << 64n) - 1n;

/**
 * One direction's key and counter.
 *
 * Exported because the transport half of a session is two of these, and because
 * a driver has to be able to hand one a nonce to prove the refusal at the top —
 * which, until `at` existed, it could not. `counter` is private with a getter and
 * no setter, so the exhaustion branch was reachable only by sealing `2^64`
 * messages, which is to say never: the off-by-one above sat in an unreachable
 * guard through every green `protocolcheck` run. A claim in a docblock that no
 * driver can actually drive is the shape of defect this codebase has the least
 * defence against, since the drivers are the whole safety net.
 */
export class CipherState {
  private counter = 0n;

  constructor(private readonly key: Uint8Array | null) {}

  /**
   * A cipher state that starts at `counter` rather than at zero. **Drivers only.**
   *
   * ⚠ **Nothing in a session may call this.** Both ends of a transport start at
   * zero and never say so to each other; one that started anywhere else would fail
   * every frame and be indistinguishable from a tag failure. It exists so
   * `protocolcheck` can stand a cipher one message short of `RESERVED_NONCE`, watch
   * it seal that last message, and watch it refuse the next — the assertion that
   * distinguishes `>` from `>=`, and the only way to reach that branch inside a
   * driver's lifetime.
   */
  static at(key: Uint8Array | null, counter: bigint): CipherState {
    if (counter < 0n || counter > RESERVED_NONCE) throw new Error("noise: a nonce outside the 64-bit range");
    const state = new CipherState(key);
    state.counter = counter;
    return state;
  }

  get hasKey(): boolean {
    return this.key !== null;
  }

  /** What the next message will be sealed under. For assertions only. */
  get nonce(): bigint {
    return this.counter;
  }

  encrypt(associatedData: Uint8Array, plaintext: Uint8Array): Uint8Array {
    if (this.key === null) return plaintext;
    if (this.counter >= RESERVED_NONCE) throw new Error("noise: nonce exhausted");
    const sealed = chacha20poly1305(this.key, nonceBytes(this.counter), associatedData).encrypt(plaintext);
    this.counter += 1n;
    return sealed;
  }

  decrypt(associatedData: Uint8Array, ciphertext: Uint8Array): Uint8Array {
    if (this.key === null) return ciphertext;
    if (this.counter >= RESERVED_NONCE) throw new Error("noise: nonce exhausted");
    // The counter advances only on success, which is the specification's wording
    // and is load-bearing: advancing on a failed open would let anybody who can
    // inject one bad frame desynchronise the two ends for good.
    const opened = chacha20poly1305(this.key, nonceBytes(this.counter), associatedData).decrypt(ciphertext);
    this.counter += 1n;
    return opened;
  }
}

/** `ck`, `h`, and the cipher they feed. Internal to the handshake. */
class SymmetricState {
  chainingKey: Uint8Array;
  hash: Uint8Array;
  cipher: CipherState = new CipherState(null);

  constructor(protocolName: string) {
    const name = new TextEncoder().encode(protocolName);
    if (name.length <= HASH_BYTES) {
      const padded = new Uint8Array(HASH_BYTES);
      padded.set(name);
      this.hash = padded;
    } else {
      this.hash = blake2s(name);
    }
    this.chainingKey = this.hash;
  }

  mixKey(material: Uint8Array): void {
    const [chainingKey, temp] = hkdf(this.chainingKey, material, 2);
    this.chainingKey = chainingKey!;
    this.cipher = new CipherState(temp!.slice(0, KEY_BYTES));
  }

  mixHash(data: Uint8Array): void {
    this.hash = blake2s(concat(this.hash, data));
  }

  encryptAndHash(plaintext: Uint8Array): Uint8Array {
    const ciphertext = this.cipher.encrypt(this.hash, plaintext);
    this.mixHash(ciphertext);
    return ciphertext;
  }

  decryptAndHash(ciphertext: Uint8Array): Uint8Array {
    const plaintext = this.cipher.decrypt(this.hash, ciphertext);
    this.mixHash(ciphertext);
    return plaintext;
  }

  split(): [CipherState, CipherState] {
    const [first, second] = hkdf(this.chainingKey, new Uint8Array(0), 2);
    return [new CipherState(first!.slice(0, KEY_BYTES)), new CipherState(second!.slice(0, KEY_BYTES))];
  }
}

/** The two transport keys, already pointed the right way for this role. */
export interface NoiseTransport {
  send: CipherState;
  receive: CipherState;
  /** `h` at the end of the handshake. The channel binding, if one is ever wanted. */
  handshakeHash: Uint8Array;
}

export interface NoiseOptions {
  initiator: boolean;
  staticKey: StaticKey;
  /** The responder's static public key. Required of an initiator — IK knows it. */
  remoteStatic?: Uint8Array | undefined;
  prologue?: Uint8Array | undefined;
  /** Pinned by the vectors, random everywhere else. */
  ephemeral?: (() => Ephemeral) | undefined;
}

/**
 * `IK`, as two message patterns:
 *
 * ```
 *   <- s                  (pre-message: the initiator already knows it)
 *   ...
 *   -> e, es, s, ss
 *   <- e, ee, se
 * ```
 */
type Token = "e" | "s" | "ee" | "es" | "se" | "ss";
const MESSAGES: readonly (readonly Token[])[] = [
  ["e", "es", "s", "ss"],
  ["e", "ee", "se"],
];

export class NoiseHandshake {
  private readonly symmetric: SymmetricState;
  private readonly newEphemeral: () => Ephemeral;
  private ephemeral: Ephemeral | null = null;
  private remoteStatic: Uint8Array | null;
  private remoteEphemeral: Uint8Array | null = null;
  private step = 0;
  private transport: NoiseTransport | null = null;

  private constructor(
    private readonly initiator: boolean,
    private readonly staticKey: StaticKey,
    remoteStatic: Uint8Array | null,
    prologue: Uint8Array,
    newEphemeral: () => Ephemeral,
  ) {
    this.remoteStatic = remoteStatic;
    this.newEphemeral = newEphemeral;
    this.symmetric = new SymmetricState(PROTOCOL_NAME);
    this.symmetric.mixHash(prologue);
    // The one pre-message in IK is the responder's static key, and both ends mix
    // it — the initiator the copy it was given, the responder its own.
    this.symmetric.mixHash(initiator ? remoteStatic! : staticKey.publicKey);
  }

  static start(options: NoiseOptions): NoiseHandshake {
    if (options.initiator && (options.remoteStatic === undefined || options.remoteStatic.length !== KEY_BYTES)) {
      // IK cannot begin without it, and answering later with a confusing DH
      // failure would hide which of the two ends was misconfigured.
      throw new Error("noise: an IK initiator needs the responder's static key");
    }
    return new NoiseHandshake(
      options.initiator,
      options.staticKey,
      options.remoteStatic ?? null,
      options.prologue ?? new Uint8Array(0),
      options.ephemeral ?? randomEphemeral,
    );
  }

  /** Whether the handshake is over. `split()` answers only once it is. */
  get complete(): boolean {
    return this.transport !== null;
  }

  /**
   * The peer's static public key, once the handshake has authenticated it.
   *
   * On the daemon this is **the device key**, and comparing it to the one inside
   * the Authority-signed capability is the whole of the binding check.
   */
  get remoteStaticKey(): Uint8Array | null {
    return this.remoteStatic;
  }

  private async mixDh(token: Token): Promise<void> {
    const local = this.initiator;
    switch (token) {
      case "ee":
        this.symmetric.mixKey(x25519.getSharedSecret(this.ephemeral!.secretKey, this.remoteEphemeral!));
        return;
      case "es":
        this.symmetric.mixKey(
          local
            ? x25519.getSharedSecret(this.ephemeral!.secretKey, this.remoteStatic!)
            : await this.staticKey.dh(this.remoteEphemeral!),
        );
        return;
      case "se":
        this.symmetric.mixKey(
          local
            ? await this.staticKey.dh(this.remoteEphemeral!)
            : x25519.getSharedSecret(this.ephemeral!.secretKey, this.remoteStatic!),
        );
        return;
      case "ss":
        this.symmetric.mixKey(await this.staticKey.dh(this.remoteStatic!));
        return;
      default:
        throw new Error(`noise: ${token} is not a DH token`);
    }
  }

  /** Write the next handshake message, carrying `payload`. */
  async writeMessage(payload: Uint8Array = new Uint8Array(0)): Promise<Uint8Array> {
    const tokens = MESSAGES[this.step];
    if (tokens === undefined) throw new Error("noise: the handshake has no more messages to write");
    if (this.step % 2 === 0 !== this.initiator) throw new Error("noise: it is the other end's turn to write");

    const parts: Uint8Array[] = [];
    for (const token of tokens) {
      if (token === "e") {
        this.ephemeral = this.newEphemeral();
        parts.push(this.ephemeral.publicKey);
        this.symmetric.mixHash(this.ephemeral.publicKey);
      } else if (token === "s") {
        parts.push(this.symmetric.encryptAndHash(this.staticKey.publicKey));
      } else {
        await this.mixDh(token);
      }
    }
    parts.push(this.symmetric.encryptAndHash(payload));
    this.step += 1;
    this.maybeSplit();
    return concat(...parts);
  }

  /** Read the next handshake message and return the payload it carried. */
  async readMessage(message: Uint8Array): Promise<Uint8Array> {
    const tokens = MESSAGES[this.step];
    if (tokens === undefined) throw new Error("noise: the handshake has no more messages to read");
    if (this.step % 2 === 0 === this.initiator) throw new Error("noise: it is this end's turn to write");

    let rest = message;
    const take = (n: number): Uint8Array => {
      if (rest.length < n) throw new Error("noise: handshake message is short");
      const head = rest.subarray(0, n);
      rest = rest.subarray(n);
      return head;
    };

    for (const token of tokens) {
      if (token === "e") {
        this.remoteEphemeral = take(KEY_BYTES);
        this.symmetric.mixHash(this.remoteEphemeral);
      } else if (token === "s") {
        const sealed = take(this.symmetric.cipher.hasKey ? KEY_BYTES + TAG_BYTES : KEY_BYTES);
        this.remoteStatic = this.symmetric.decryptAndHash(sealed);
      } else {
        await this.mixDh(token);
      }
    }
    const payload = this.symmetric.decryptAndHash(rest);
    this.step += 1;
    this.maybeSplit();
    return payload;
  }

  private maybeSplit(): void {
    if (this.step < MESSAGES.length) return;
    const [first, second] = this.symmetric.split();
    // `c1` is always initiator -> responder. Pointing them here rather than at
    // the call site is what stops one end reading with the key it writes under.
    this.transport = this.initiator
      ? { send: first, receive: second, handshakeHash: this.symmetric.hash }
      : { send: second, receive: first, handshakeHash: this.symmetric.hash };
  }

  /** The transport keys. Throws while the handshake is still in flight. */
  split(): NoiseTransport {
    if (this.transport === null) throw new Error("noise: the handshake is not finished");
    return this.transport;
  }
}
