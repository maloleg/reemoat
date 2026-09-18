import { generateStaticKey } from "@reemoat/protocol";
import { jwkThumbprint, x25519Jwk } from "./token.js";
import type { SqliteMachineKeyStore, StoredMachineKey } from "./store/sqlite.js";

/**
 * The X25519 static an app authenticates this machine by.
 *
 * **Generated here and never anywhere else.** Every other credential this daemon
 * holds was issued to it — the enrollment code was typed in, the tunnel key and
 * the signing keys came back from the control plane. This one is the first thing
 * the machine knows that nobody handed it, and that asymmetry is the point: an
 * Authority that is compromised can mint a capability for a device it controls,
 * but it cannot produce this key, so it cannot decrypt what an app sends here.
 *
 * ⚠ **It is announced, never asked for.** The public half rides the tunnel
 * handshake beside `DAEMON_VERSION_HEADER`, which keeps *"the daemon makes
 * exactly one control-plane request, ever"* literally true — a dial is a
 * connection the daemon opens, and telling somebody a fact on it is not asking
 * them for one. That is also what lets a machine enrolled before this existed
 * migrate with **no re-enrollment**: it generates a key at its next start and
 * announces it at its next dial, and nobody has to touch the host.
 *
 * ⚠ **Two daemons cannot both mint one, and that is held in two places on
 * purpose.** `claimDaemonLock` refuses the second daemon on a file before any
 * store is handed out — the fast path, and a caller's discipline — and
 * `machine_keys_one_live`, the partial unique index over `retired_at IS NULL`,
 * refuses the second live *row* if a future caller ever gets past the lock, which
 * is what makes the claim true of the store rather than merely cited by it. What
 * the two of them prevent is specific: `active()` orders `created_at DESC`, so a
 * second live row means every later start announces the **later** key — the one
 * the Authority did not pin on first enrollment — and every dial is refused 409
 * for ever, with nothing on the machine saying why.
 */
export function ensureMachineKey(store: SqliteMachineKeyStore, now = Date.now()): StoredMachineKey {
  const existing = store.active();
  if (existing !== null) return existing;

  const { secretKey, publicKey } = generateStaticKey();
  const fresh = {
    kth: jwkThumbprint(x25519Jwk(publicKey)),
    publicKey: Buffer.from(publicKey).toString("base64url"),
    privateKey: Buffer.from(secretKey).toString("base64url"),
    createdAt: now,
  };
  store.save(fresh);

  /*
   * Read back rather than returning what was just written.
   *
   * ⚠ **Not because `save` is `DO NOTHING` on conflict, which is what this said
   * and which cannot happen on a race.** `kth` is the thumbprint of the public
   * half `generateStaticKey()` produced above — a fresh keypair on every call,
   * never a value read from anywhere — so two processes arriving here together
   * generate two different keys and hash to two different primary keys: the `kth`
   * conflict is unreachable and absorbs nothing. (This cited the referent as "four
   * lines up", which it had not been for a long time — the call is above the
   * object literal, not inside the paragraph. It is the load-bearing step of the
   * whole argument, so it is named rather than counted now: a positional
   * reference rots on the next edit and says nothing when it does.)
   *
   * Where two racers *do* collide is `machine_keys_one_live`, the partial unique
   * index over `retired_at IS NULL`: the loser's INSERT is refused,
   * `SqliteMachineKeyStore.save` absorbs that one constraint failure, and the
   * loser therefore wrote **nothing**. So `fresh` above is a private half the
   * database does not hold, and returning it would hand a live session a secret
   * nothing can ever find again — while the winner's row is what this machine is
   * actually known by. `active()` is the query every later start
   * asks, so returning *its* answer is the only way this start and every next one
   * name the same row as the machine's key. One indexed lookup, once in the life
   * of a machine.
   */
  const stored = store.active();
  if (stored === null) throw new Error("the machine key could not be read back after writing it");
  return stored;
}
