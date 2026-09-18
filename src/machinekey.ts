import { generateStaticKey, localStaticKey } from "@reemoat/protocol";
import type { StaticKey } from "@reemoat/protocol";
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
 * the Authority did not pin on first enrollment — and every dial is refused 409.
 *
 * ⚠ **"For ever, with nothing on the machine saying why" is no longer the end of
 * that sentence, and that is a repair rather than a second defence.**
 * `machineKeyRotation` below turns the first 409 into a promotion of the other
 * key this file already holds, so a machine that lost the race before the lock
 * was fixed recovers on its next dial instead of needing `cpctl admin clearkey`.
 * It does not make a second live row acceptable: the two defences above are what
 * stop one being created, and the rotation only cleans up after the ones that
 * already exist on disk.
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

/** One key, in the two shapes a dial needs it in. */
export interface AnnouncedMachineKey {
  /** The thumbprint, for the sentence a human reads. */
  kth: string;
  /** The public half, base64url, as `MACHINE_KEY_HEADER` carries it. */
  machineKey: string;
  /** The private half, as the Noise responder needs it. Never leaves this process. */
  staticKey: StaticKey;
}

/** The two halves of a stored row, as `RelayTunnel` takes them. */
export function announceableMachineKey(key: StoredMachineKey): AnnouncedMachineKey {
  return {
    kth: key.kth,
    machineKey: key.publicKey,
    staticKey: localStaticKey(new Uint8Array(Buffer.from(key.privateKey, "base64url"))),
  };
}

/**
 * What to announce after the Authority refused what this machine announced.
 *
 * ⚠ **This exists because the repair one file over has to guess, and the guess
 * is wrong for half the population it reaches.**
 * `migrateMachineKeysToOneLive` finds a file that lost the two-daemon startup
 * race — two rows, both live — and must leave exactly one live, because
 * `machine_keys_one_live` admits exactly one. It keeps the **oldest**, on the
 * argument that the racer which generated first also enrolled first and is
 * therefore the one trust-on-first-use pinned. That is right for a machine
 * nobody has touched. It is backwards for a machine whose operator already ran
 * `cpctl admin clearkey`: that one restarted, announced `active()` — the
 * **newest** — the Authority pinned *that*, and the machine has been working on
 * it ever since. Retiring it turns a working machine into a permanent 409.
 * Flipping the order swaps which population is broken and fixes nothing.
 *
 * **Both are guesses from a timestamp about a fact that lives on the Authority,
 * so the fact is read from the Authority instead.** A 409 at the dial *is* the
 * answer to "is this the pinned key", arriving from the only party that knows.
 * On one, `RelayTunnel` calls this, gets the next key this machine holds — live
 * or retired, since `promote` is reversible and a retirement keeps the private
 * half — announces that instead, and dials again. Population A announces the
 * oldest and connects; population B is refused once, promotes the newest, and
 * connects. Neither needs an operator.
 *
 * **Finite, and each key tried at most once per process.** `tried` starts
 * holding the key the daemon booted announcing and every candidate is added
 * before it is promoted, so the walk is bounded by the number of rows on disk
 * and `null` — the terminal 409 sentence, unchanged — is reached in at most that
 * many dials. Anything weaker here is a redial loop against the relay.
 *
 * ⚠ **A machine holding exactly one key must be unaffected, and that is the
 * property to defend in review.** The legitimate 409s the tunnel's docblock
 * names — a host restored from backup, a wiped `~/.reemoat`, a machine id reused
 * for a rebuilt box — all have one row, which is already in `tried`, so this
 * answers `null` on its first call and nothing is promoted, nothing is retired,
 * and the words the operator reads are the ones they read before.
 */
export function machineKeyRotation(
  store: SqliteMachineKeyStore,
  announcing: StoredMachineKey,
): () => AnnouncedMachineKey | null {
  const tried = new Set<string>([announcing.kth]);
  return () => {
    for (const candidate of store.all()) {
      if (tried.has(candidate.kth)) continue;
      tried.add(candidate.kth);
      /*
       * `false` means the row vanished between the read and the promotion, which
       * nothing in this daemon does — it is answered by moving on rather than by
       * throwing, because the caller is a socket handler on the dial path and
       * this file's whole contract is that the relay cannot break the daemon.
       *
       * ⚠ **That contract is a claim about this file's own returns and never was
       * a claim about the store underneath it.** `store.all()` above is a SELECT
       * and `store.promote()` here is a `BEGIN`/UPDATE/`COMMIT`, and both throw
       * on `SQLITE_BUSY` — which the dial path is more exposed to than most,
       * since this daemon's own writers are live while it dials. Guarding them
       * here would make the walk silently skip a row with nowhere to say why, so
       * the guard is at the caller instead, in `tunnel.ts`'s 409 arm, where
       * `onEvent` exists to carry the reason: a throw from here is answered as
       * `null`, which is the pre-rotation behaviour exactly. The walk still
       * converges, because `tried` is added to *above* rather than after a
       * successful promotion — so a candidate whose promotion threw is not
       * offered again on the next dial.
       */
      if (!store.promote(candidate.kth)) continue;
      return announceableMachineKey(candidate);
    }
    return null;
  };
}
