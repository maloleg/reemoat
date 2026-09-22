import type { DatabaseSync } from "node:sqlite";

/**
 * The X25519 static a machine is known by, and the rule for recording it.
 *
 * A machine generates this key itself and announces the public half on every
 * tunnel dial. This service records it and hands it to an app when it mints a
 * capability, which is what lets the app establish that it reached the machine it
 * meant rather than trusting the relay's routing.
 *
 * **The whole of the policy is: pin the first one, accept the same one silently,
 * refuse a different one.** Trust on first use, chosen deliberately over the two
 * alternatives. Always adopting the newest would make the check decorative —
 * whoever could write the row could stand in the middle of every session. Never
 * adopting would mean a machine could never be re-keyed at all, and a lost
 * `machine_keys` table would be unrecoverable without a support conversation.
 * Refusing the dial says what happened at the moment it happens, to the one
 * person who can act on it, and re-enrollment is the way back.
 */

/** What a dial's announcement did to the row. */
export type MachineKeyPin = "pinned" | "unchanged" | "mismatch";

/**
 * Record an announced key.
 *
 * ⚠ **One conditional `UPDATE`, then `changes`.** Read-then-write leaves a window
 * two dials can both pass — and `reconnectDelayMs` puts a whole fleet's dials
 * inside one second after a relay restart, so that window is not theoretical. The
 * `machine_key IS NULL` clause is what makes the first writer win and the second
 * fall through to the comparison below rather than overwriting.
 */
export function pinMachineKey(db: DatabaseSync, machineId: string, announced: string, now = Date.now()): MachineKeyPin {
  const claimed = db
    .prepare("UPDATE machines SET machine_key = ?, machine_key_set_at = ? WHERE id = ? AND machine_key IS NULL")
    .run(announced, now, machineId);
  if (claimed.changes === 1) return "pinned";

  const held = machineKeyFor(db, machineId);
  /*
   * `null` here means the row is gone, not that it is unpinned — the UPDATE above
   * would have claimed an unpinned one. A machine that stopped existing between
   * two statements is not a key disagreement, and calling it one would refuse a
   * dial with a message about the wrong thing.
   */
  if (held === null) return "unchanged";
  return held === announced ? "unchanged" : "mismatch";
}

/** The key an app should expect from this machine, or `null` if none is pinned. */
export function machineKeyFor(db: DatabaseSync, machineId: string): string | null {
  const row = db.prepare("SELECT machine_key FROM machines WHERE id = ?").get(machineId);
  if (!row) return null;
  return row["machine_key"] == null ? null : String(row["machine_key"]);
}

/**
 * Record a key at enrollment, whatever is already there.
 *
 * The one place a pin is replaced rather than compared, and it is the rotation
 * story: redeeming an enrollment code already retires the machine's live tunnel
 * key, so it is already the act that says *this machine is starting again*. A
 * daemon that lost its key generates a new one and the operator redeems a fresh
 * code, which is one command rather than a support conversation.
 *
 * Bound to a single-use code handled by the API process, so unlike the dial this
 * path does not go through the relay at all.
 */
export function setMachineKey(db: DatabaseSync, machineId: string, announced: string, now = Date.now()): void {
  db.prepare("UPDATE machines SET machine_key = ?, machine_key_set_at = ? WHERE id = ?").run(announced, now, machineId);
}
