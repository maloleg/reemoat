import type { DatabaseSync } from "node:sqlite";
import { newId } from "./keys.js";

/**
 * The installations somebody signs in from.
 *
 * A session is a bearer token with an expiry; a **device** is the computer or the
 * phone that keeps producing them, and it outlives every session bound to it.
 * That is the whole of what this file adds: revoking one installation without
 * touching the others was not expressible before, because the only per-sign-in
 * record there was is `user_session_origins`, whose two fields are a caller's own
 * claim about itself and are documented as recognition rather than identification.
 *
 * **A device id is not a credential**, and every rule here follows from that. It
 * is stored unhashed and returned in full, unlike everything in `keys.ts`,
 * because holding one authorizes nothing: it is read only *after* a session token
 * has already resolved, and only to ask whether that installation has since been
 * revoked. The client keeps it in ordinary configuration for the same reason —
 * `packages/native/src-tauri/src/config.rs` makes the argument for the server
 * address and it transfers word for word.
 *
 * **A device is not an authorization subject either.** Grants stay
 * `(user_id, machine_id)`, so two devices of one person reach exactly the same
 * machines, and `relay/authorize.ts` reads nothing here. What a revocation buys
 * is immediate at this service and nothing at all further down: a machine token
 * already minted keeps working for its remaining life. `SECURITY.md` carries the
 * window rather than this file implying a boundary it does not have.
 *
 * Everything is synchronous, like the rest of this service's storage.
 */

/**
 * How many devices one person may have registered at once.
 *
 * ⚠ **Over the cap this **refuses**, and that is deliberately the opposite of
 * `MAX_SESSIONS_PER_USER`, which evicts.** The sessions rule argues that "being
 * unable to sign in on a new device because of an old one is the wrong failure",
 * and it is right — about sessions, because a session *is* the thing you are
 * trying to get. It does not transfer here: a sign-in succeeds perfectly well
 * with no device bound, so refusing the registration costs a sentence saying
 * "retire one" rather than the sign-in.
 *
 * And eviction here would be a weapon rather than a convenience. Anybody holding
 * one live session — which is exactly the case per-device revocation exists to
 * contain — could register twenty times and evict, revoke and sign out every real
 * device the owner has, while their own newest session survived the sweep. The
 * owner's remedy is the one thing they would no longer be signed in to reach.
 *
 * Larger than the session cap on purpose, and the relationship is worth stating
 * because otherwise one of the two numbers gets "corrected": at most ten of these
 * hold a live session at any moment, and the eleventh sign-in retires the oldest
 * *session* while leaving its device registered. That installation then asks for
 * a password again and keeps its identity, which is the right outcome.
 */
export const MAX_DEVICES_PER_USER = 20;

/**
 * How long a revoked device is kept before it is swept.
 *
 * `user_sessions` keeps a revoked row for seven days and its docblock explains
 * why the number is neither zero nor the full lifetime: short because almost
 * nothing reads it, non-zero because deleting on revocation makes the day
 * something *does* read it unanswerable. The same reasoning applies with one
 * extra reader — `listDevices` returns recently revoked rows, so this is also how
 * long "that laptop was retired on Tuesday" stays on the screen.
 *
 * Thirty days rather than seven for that reason alone: the sessions list is a
 * live inventory, while this is the answer to a question somebody asks after
 * noticing something, which is measured in weeks.
 */
export const DEVICE_REVOKED_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * How much of a caller-supplied device string to keep.
 *
 * Clamped at ingest rather than at render, which is `user_session_origins`' rule
 * and is stated twice in this package because remembering it at render is the
 * half that fails. `POST /v1/login` carries a 64 KiB body bound and sits above
 * THE LINE, so without this any successful sign-in could write a 64 KiB device
 * name into the file that also holds the fleet's signing key and is fsynced on
 * every write — and then drag it through every listing afterwards.
 */
export const MAX_DEVICE_NAME_CHARS = 128;
export const MAX_DEVICE_PLATFORM_CHARS = 32;
/**
 * And the id a caller may offer back, bounded for the same reason and on the same
 * route. Longer than the ids this service mints — `newId("dv")` — because the
 * bound is a backstop against a 64 KiB body, never a shape check: whether an id
 * names anything is {@link liveDeviceFor}'s question and it asks the database.
 */
const MAX_DEVICE_ID_CHARS = 64;

export interface DeviceRow {
  id: string;
  name: string;
  platform: string;
  createdAt: number;
  revokedAt: number | null;
  /**
   * When a session of this device was last used, or `null` for one that has
   * never held a live session.
   *
   * **Derived, never stored.** See the `devices` table comment in `schema.sql`:
   * a column here would need a writer, and both available writers are failures
   * this package already carries intervals to avoid. This is
   * `MAX(user_sessions.last_seen_at)` over the device's own sessions, which is a
   * value that already exists and already moves at most once every fifteen
   * minutes.
   */
  lastSeenAt: number | null;
  /**
   * Whether this installation has registered an X25519 public key, and when.
   *
   * ⚠ **A boolean rather than the key.** The screen's question is *can this
   * installation reach a machine* — one word — and answering it with 43 bytes of
   * base64url would put a value on a row for somebody to copy, compare or paste
   * into a support conversation, none of which is a thing anybody should do with
   * it. `false` for a row registered before keys existed and for one whose
   * credential store lost the key; both draw the same sentence, because both have
   * the same remedy.
   */
  hasKey: boolean;
  keySetAt: number | null;
}

/** Clamp a caller-supplied string, mapping empty to `null` so absence has one shape. */
function clamp(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed.slice(0, max);
}

/**
 * What a caller may say about an installation. Every part is clamped here.
 *
 * The key is **optional and refused to `null` rather than refusing the
 * registration**, for the reason a device id that will not bind is ignored rather
 * than refused: a client older than this sends none, and one that sent something
 * malformed has a bug that must not cost somebody the ability to sign in. An
 * installation with no key registers, appears in the list, and is told it cannot
 * reach a machine yet — which is a sentence with a remedy, where a refused
 * sign-in is a loop.
 */
export function readDeviceInput(
  value: unknown,
): { name: string; platform: string; publicKey: string | null } | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const name = clamp(record["name"], MAX_DEVICE_NAME_CHARS);
  const platform = clamp(record["platform"], MAX_DEVICE_PLATFORM_CHARS);
  if (name === null || platform === null) return null;
  return { name, platform, publicKey: readDevicePublicKey(record["publicKey"]) };
}

/**
 * An X25519 public key as a caller offers it: base64url, exactly 32 raw bytes.
 *
 * Strict about the alphabet as well as the length, for `b64uDecode`'s reason:
 * `Buffer.from(s, "base64url")` silently skips what it does not recognise, so two
 * different strings can decode alike — and here that would mean a capability
 * naming a key by a spelling the daemon computes differently, which reads as
 * "wrong device" for a device that is right.
 */
export function readDevicePublicKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const key = value.trim();
  if (key.length !== DEVICE_PUBLIC_KEY_CHARS) return null;
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : null;
}

/** 32 raw bytes in base64url is 43 characters, with no padding. */
export const DEVICE_PUBLIC_KEY_CHARS = 43;

/** The `id` a caller offered, bounded — see {@link MAX_DEVICE_ID_CHARS}. */
export function readDeviceId(value: unknown): string | null {
  return clamp(value, MAX_DEVICE_ID_CHARS);
}

/**
 * The live device with this id **belonging to this user**, or `null`.
 *
 * ⚠ **The `user_id` clause is the whole of this function and may not be
 * loosened.** A device id arrives from a client that chose it — over
 * `POST /v1/login`, which is above THE LINE and therefore reached before any
 * caller is known, and over `POST /v1/me/devices`. Resolved without the owner
 * clause, one account could bind its session to another account's device: the
 * victim's Revoke would then sign the attacker out (harmless) and, far worse, the
 * attacker's session would inherit the victim's `revoked_at`, so the victim could
 * be signed out at will by a stranger — and `GET /v1/me/sessions` would hand the
 * attacker the victim's device name, which on the native shell is their computer's
 * host name.
 *
 * Revoked rows answer `null` too, which is what makes "an id we will not bind"
 * one question rather than two at every call site.
 */
export function liveDeviceFor(db: DatabaseSync, userId: string, deviceId: string): string | null {
  const row = db
    .prepare("SELECT id FROM devices WHERE id = ? AND user_id = ? AND revoked_at IS NULL")
    .get(deviceId, userId);
  return row === undefined ? null : String(row["id"]);
}

export class DeviceLimitError extends Error {
  constructor() {
    super("device limit reached");
    this.name = "DeviceLimitError";
  }
}

/**
 * Adopt the device a caller named, or register a new one.
 *
 * ⚠ **An id we will not bind is *ignored*, never refused, and that rule is what
 * stops the sign-in loop.** The alternative — answer an error for a revoked id —
 * reads as the safe choice and is a trap: the native shell keeps the id it was
 * given, so a client holding a revoked one would sign in, be refused on its very
 * next request, sign out, sign in again with the same stored id, and loop with no
 * exit but somebody deleting a file by hand. Registering a fresh row terminates,
 * and it gives up nothing: the revoked row stays revoked, and its sessions stay
 * ended. Revocation retires *that installation's access*, not the computer's
 * right to ask again with a password.
 *
 * Throws {@link DeviceLimitError} at the cap. See {@link MAX_DEVICES_PER_USER}
 * for why that is a refusal rather than an eviction.
 */
export function adoptDevice(
  db: DatabaseSync,
  userId: string,
  offeredId: string | null,
  input: { name: string; platform: string; publicKey?: string | null },
  now = Date.now(),
): string {
  if (offeredId !== null) {
    const adopted = liveDeviceFor(db, userId, offeredId);
    if (adopted !== null) {
      // The name and the platform are refreshed rather than kept: a computer can
      // be renamed, and the row exists so a person can recognise it.
      db.prepare("UPDATE devices SET name = ?, platform = ? WHERE id = ?").run(input.name, input.platform, adopted);
      /*
       * ⚠ **A key is written in place on the row rather than making a new one, and
       * that is what keeps a re-key from spending a slot.**
       *
       * A credential store that was reset takes the key with it, so this
       * installation comes back with a new one and the same id. Registering a
       * fresh *device* for it would walk straight into `MAX_DEVICES_PER_USER` —
       * the failure this file already avoids for the id by ignoring a retired one
       * rather than refusing it. Re-keying an installation somebody could retire
       * outright buys an attacker nothing they did not already have.
       */
      if (input.publicKey != null) setDeviceKey(db, userId, adopted, input.publicKey, now);
      return adopted;
    }
  }

  // Counted live, so retiring one makes room immediately — the mirror of
  // `machine_owners`, where a revoke has to release the slot by hand or it is
  // spent for ever.
  const live = db
    .prepare("SELECT COUNT(*) AS n FROM devices WHERE user_id = ? AND revoked_at IS NULL")
    .get(userId);
  if (Number(live?.["n"] ?? 0) >= MAX_DEVICES_PER_USER) throw new DeviceLimitError();

  const id = newId("dv");
  db.prepare(
    "INSERT INTO devices (id, user_id, name, platform, created_at, public_key, key_set_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(id, userId, input.name, input.platform, now, input.publicKey ?? null, input.publicKey == null ? null : now);
  return id;
}

/**
 * Record an installation's X25519 public key.
 *
 * **Every statement carries `user_id`**, which is this file's oldest rule and is
 * not weakened by the key arriving: without the owner clause this would be a
 * cross-account primitive for overwriting somebody else's key, which is a way to
 * take their installation off the network.
 *
 * ⚠ **Proof of possession is not demanded here, and that is a decision rather
 * than an omission.** The obvious shape — a challenge the device answers with its
 * key — would stop nothing that matters: anybody holding the session could
 * register a key of their own on a device of their own, and a session is what
 * this route already requires. What actually enforces the binding is one layer
 * further on and cannot be skipped: the daemon compares this key against the one
 * the encrypted handshake authenticated, so an installation that registers a key
 * it does not hold simply cannot connect to anything. The column is attested by
 * use, which is the property the old refusal of this column asked for.
 */
export function setDeviceKey(db: DatabaseSync, userId: string, deviceId: string, publicKey: string, now = Date.now()): void {
  db.prepare("UPDATE devices SET public_key = ?, key_set_at = ? WHERE id = ? AND user_id = ?").run(
    publicKey,
    now,
    deviceId,
    userId,
  );
}

/**
 * The key a capability minted for this installation must name, or `null`.
 *
 * Read by device id alone. Unlike every other statement here that is not a
 * mistake: the caller is the mint, and the id it passes came out of a session
 * this service has already resolved — the owner clause was applied when the
 * session was, and asking again would suggest the id were caller-supplied.
 */
export function deviceKeyFor(db: DatabaseSync, deviceId: string): string | null {
  const row = db.prepare("SELECT public_key FROM devices WHERE id = ? AND revoked_at IS NULL").get(deviceId);
  if (!row) return null;
  return row["public_key"] == null ? null : String(row["public_key"]);
}

/**
 * Has this device been revoked?
 *
 * Read on the authentication path, by `resolveSession`, and **only when the
 * resolved row carries a `device_id`** — so a browser, a `cpctl` key and every
 * session that predates devices pay nothing at all, and a native one pays one
 * primary-key lookup.
 *
 * ⚠ **This exists as a second statement rather than as a `LEFT JOIN` on
 * `resolveSession`'s own query, and the reason is not style.** That query selects
 * its columns unqualified and reads the row by bare key; `devices` shares `id`
 * and `revoked_at` with `user_sessions`. Joined, `row["revoked_at"]` becomes the
 * *device's* — NULL for a live device and NULL for a session with no device —
 * and session revocation silently stops working everywhere: signing out, "sign
 * out everywhere", a password change and both admin sweeps all keep answering
 * 200 while the revoked token goes on authenticating. Written with bare names
 * instead, the statement throws at `prepare`, which is lazy, so the service
 * starts green and then fails every signed-in request. Two statements cannot have
 * either bug.
 */
export function deviceRevoked(db: DatabaseSync, deviceId: string): boolean {
  const row = db.prepare("SELECT revoked_at FROM devices WHERE id = ?").get(deviceId);
  // A row that is not there is not a revocation: it is an id naming nothing,
  // which is what a swept row leaves behind. The session's own expiry bounds it.
  if (row === undefined) return false;
  return row["revoked_at"] !== null;
}

/**
 * Retire one device and end every session it holds.
 *
 * Both statements carry `user_id`, and the second one goes through the device's
 * own id rather than through a list of session ids, so it cannot touch another
 * device's rows — which is the property the whole feature is bought for.
 *
 * Returns `null` when there is no such live device **for this caller**. The route
 * answers the same 404 for that and for "no such device at all", which is the
 * anti-mapping rule `DELETE /v1/machines/:id/grants/me` already keeps: without
 * it, the difference between 404 and 200 tells a stranger which device ids exist.
 */
export function revokeDevice(
  db: DatabaseSync,
  userId: string,
  deviceId: string,
  now = Date.now(),
): { sessionsRevoked: number } | null {
  db.exec("BEGIN");
  try {
    const changed = db
      .prepare("UPDATE devices SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL")
      .run(now, deviceId, userId);
    if (changed.changes !== 1) {
      db.exec("ROLLBACK");
      return null;
    }
    const sessions = db
      .prepare(
        "UPDATE user_sessions SET revoked_at = ? WHERE device_id = ? AND user_id = ? AND revoked_at IS NULL",
      )
      .run(now, deviceId, userId);
    db.exec("COMMIT");
    return { sessionsRevoked: Number(sessions.changes) };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/**
 * This person's devices, newest first — live ones **and recently revoked ones**.
 *
 * ⚠ **The revoked rows are the point rather than clutter.** `user_sessions`'
 * docblock records the shape of mistake this avoids: rows were being kept for a
 * list that then filtered them out, so the retention existed without the feature.
 * Here the reader's sharpest question arrives *after* something has gone wrong —
 * "did I retire that laptop, and when" — and a list that simply had one fewer row
 * cannot answer it. Bounded by the cap plus whatever the sweep has not yet taken,
 * so it needs no paging.
 */
export function listDevices(db: DatabaseSync, userId: string, now = Date.now()): DeviceRow[] {
  const rows = db
    .prepare(
      "SELECT d.id, d.name, d.platform, d.created_at, d.revoked_at, d.public_key, d.key_set_at, " +
        // Derived rather than stored — see `DeviceRow.lastSeenAt`. LEFT, because a
        // device that has never held a session is still a device, and NULL is the
        // honest answer for it.
        "(SELECT MAX(s.last_seen_at) FROM user_sessions s WHERE s.device_id = d.id) AS last_seen_at " +
        "FROM devices d WHERE d.user_id = ? AND (d.revoked_at IS NULL OR d.revoked_at > ?) " +
        "ORDER BY d.created_at DESC",
    )
    .all(userId, now - DEVICE_REVOKED_RETENTION_MS);
  return rows.map((row) => ({
    id: String(row["id"]),
    name: String(row["name"]),
    platform: String(row["platform"]),
    createdAt: Number(row["created_at"]),
    revokedAt: row["revoked_at"] === null ? null : Number(row["revoked_at"]),
    lastSeenAt: row["last_seen_at"] === null || row["last_seen_at"] === undefined ? null : Number(row["last_seen_at"]),
    hasKey: row["public_key"] != null,
    keySetAt: row["key_set_at"] == null ? null : Number(row["key_set_at"]),
  }));
}

/**
 * Remove rows that can never be adopted again.
 *
 * Run at startup beside the other sweeps, deliberately not on a timer — the live
 * set is bounded by the cap, so this is housekeeping rather than a bound, and a
 * timer would be a second thing writing to this database for no reason anybody
 * can observe. `pruneSessions` states the same rule one file over.
 *
 * The second statement is the belt: `DELETE /v1/admin/users/:id` sweeps this
 * table by hand, so an orphan means somebody added a delete path and forgot — and
 * nothing cascades here to catch it. `pruneSessions` collects orphaned origins
 * for exactly this reason and phrases it the same way.
 */
export function pruneDevices(db: DatabaseSync, now = Date.now()): number {
  const changed = db
    .prepare("DELETE FROM devices WHERE revoked_at IS NOT NULL AND revoked_at <= ?")
    .run(now - DEVICE_REVOKED_RETENTION_MS);
  db.exec("DELETE FROM devices WHERE user_id NOT IN (SELECT id FROM users)");
  return Number(changed.changes);
}
