import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * The control plane's durable state.
 *
 * Deliberately shaped like the daemon's `store/sqlite.ts` — same synchronous
 * `node:sqlite`, same idempotent schema re-applied on open, same 0700/0600
 * discipline — because it is the same kind of thing and a reader who knows one
 * should not have to learn the other.
 *
 * It is more sensitive, though. The daemon's database holds transcripts; this
 * one holds the private key that mints every token in the fleet. Losing it is
 * not "somebody reads your conversations", it is "somebody is every user on
 * every machine".
 */

export const CP_SCHEMA_VERSION = 1;

const BUSY_TIMEOUT_MS = 250;

export interface OpenControlStoreOptions {
  path: string;
}

export interface ControlStore {
  db: DatabaseSync;
  close(): void;
}

export function openControlStore(options: OpenControlStoreOptions): ControlStore {
  const inMemory = options.path === ":memory:";
  if (!inMemory) {
    mkdirSync(dirname(options.path), { recursive: true, mode: 0o700 });
  }

  const db = new DatabaseSync(options.path, { timeout: BUSY_TIMEOUT_MS });

  if (!inMemory) {
    // The directory, not just the file — SQLite writes `-wal` and `-shm` beside
    // it on its own schedule, with whatever the umask says, and those carry the
    // same bytes until a checkpoint folds them back. `mkdirSync(mode)` above
    // does not cover an upgrade into an existing 0755 directory, because that
    // mode applies only to directories it actually created.
    try {
      chmodSync(dirname(options.path), 0o700);
    } catch {
      // A filesystem without POSIX modes is not a reason to refuse to start.
    }
    try {
      chmodSync(options.path, 0o600);
    } catch {
      // Same.
    }
  }

  applyPragmas(db, inMemory);
  applyControlPlaneSchema(db);

  return {
    db,
    close() {
      try {
        db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      } catch {
        // On the way out; an un-checkpointed WAL is recovered on the next open.
      }
      try {
        db.close();
      } catch {
        // Already closed.
      }
    },
  };
}

/* ------------------------------------------------------------------ *
 * Authorization queries
 *
 * These live here rather than inline in `app.ts` because the relay asks the same
 * questions the token minter does, and two hand-written versions of "may this
 * user reach this machine" is exactly how the two drift apart. `app.ts` had them
 * inline while it was the only caller; it is not any more.
 * ------------------------------------------------------------------ */

/**
 * Prepared statements, once per database rather than once per call.
 *
 * All three readers below sit on the relay's per-request authorization path —
 * `authorize` asks every one of them before a byte is forwarded — so
 * `db.prepare(...)` inline meant re-compiling three statements on every proxied
 * request and every WebSocket upgrade, synchronously, on the event loop that also
 * carries the tunnels.
 *
 * `SqliteEventStore` already sets this precedent on the daemon side and says why:
 * `stats()` is on `snapshot()`, so it must be a lookup rather than three index
 * scans. Same reasoning, different hot path.
 *
 * Keyed by the database handle so tests that open several in-memory databases
 * cannot collide, and weak so a closed database is not retained by its cache.
 */
interface Statements {
  grant: ReturnType<DatabaseSync["prepare"]>;
  machine: ReturnType<DatabaseSync["prepare"]>;
  user: ReturnType<DatabaseSync["prepare"]>;
}

const statementCache = new WeakMap<DatabaseSync, Statements>();

function statements(db: DatabaseSync): Statements {
  let held = statementCache.get(db);
  if (held === undefined) {
    held = {
      grant: db.prepare("SELECT scopes FROM grants WHERE user_id = ? AND machine_id = ?"),
      machine: db.prepare("SELECT id, name, enrolled_at, revoked_at FROM machines WHERE id = ?"),
      user: db.prepare("SELECT id, name, disabled_at FROM users WHERE id = ?"),
    };
    statementCache.set(db, held);
  }
  return held;
}

/**
 * The scopes `userId` holds on `machineId`, or `null` for no grant at all.
 *
 * `null` and `[]` are different answers and both are refusals: no grant, versus a
 * grant carrying nothing usable. Callers that need to tell an operator why keep
 * that distinction.
 */
export function grantFor(db: DatabaseSync, userId: string, machineId: string): string[] | null {
  const row = statements(db).grant.get(userId, machineId);
  if (!row) return null;
  return String(row["scopes"])
    .split(/\s+/)
    .filter((entry) => entry.length > 0);
}

export interface MachineRow {
  id: string;
  name: string;
  enrolled: boolean;
  revoked: boolean;
}

export function machineById(db: DatabaseSync, machineId: string): MachineRow | null {
  const row = statements(db).machine.get(machineId);
  if (!row) return null;
  return {
    id: String(row["id"]),
    name: String(row["name"]),
    enrolled: row["enrolled_at"] !== null,
    revoked: row["revoked_at"] !== null,
  };
}

/** A user that exists and is not disabled, or `null`. Read live on every relayed request. */
export function activeUser(db: DatabaseSync, userId: string): { id: string; name: string } | null {
  const row = statements(db).user.get(userId);
  if (!row || row["disabled_at"] !== null) return null;
  return { id: String(row["id"]), name: String(row["name"]) };
}

function applyPragmas(db: DatabaseSync, inMemory: boolean): void {
  // Returns a row, so it cannot go through exec().
  const mode = db.prepare("PRAGMA journal_mode = WAL").get();
  const journal = typeof mode?.["journal_mode"] === "string" ? mode["journal_mode"] : "";
  if (!inMemory && journal.toLowerCase() !== "wal") {
    throw new Error(
      `could not enable WAL journalling (got "${journal}"). ` +
        "A networked or read-only filesystem is the usual cause.",
    );
  }
  /*
   * FULL here, unlike the daemon's NORMAL.
   *
   * The daemon trades durability for latency because its writes are on the
   * agent's synchronous emit path and a lost tail of transcript is survivable.
   * What would be lost here is "this enrollment code was redeemed" — which, lost,
   * makes a single-use code usable twice. That is the one property this table
   * exists to guarantee, so it gets the fsync.
   *
   * ⚠ **"A handful per administrative action" is what this used to say, and it
   * stopped being true.** The relay writes `relay_tunnels` on every register,
   * unregister and 5s flush, and `machines.daemon_*` on every dial — and
   * `reconnectDelayMs` draws from a 1s window, so a relay restart lands a whole
   * fleet's dials inside one second, each an fsync on the event loop carrying
   * every tunnel there is. It is still the right trade for the enrollment
   * property above; what changed is that it now has a cost worth measuring rather
   * than one worth waving at. Both of those writes are wrapped and best-effort,
   * so what they pay under contention is the 250ms busy timeout and then silence.
   */
  db.exec("PRAGMA synchronous = FULL");
  db.exec("PRAGMA foreign_keys = OFF");
}

/**
 * The whole schema, as one call — and the reason it is one call.
 *
 * ⚠ **Every driver built its database by hand**, with
 * `db.exec(readFileSync(schema.sql))` and nothing else: eight sites in `relaycheck`
 * alone. That was harmless while `schema.sql` *was* the schema, and stopped being
 * harmless the moment `migrate()` existed — a driver applying the file alone
 * tests against a database production never has, and the failure lands on the
 * column the migration adds, which is the one thing the change was about. Found
 * by exactly that: an assertion on `machines.daemon_version` against a test
 * database that had no such column.
 *
 * So "apply the schema" is a function rather than a line somebody copies, and the
 * two halves cannot come apart again. `checkSchemaVersion` runs between them, in
 * that order, for the daemon's stated reason: a file from a newer build must be
 * refused *before* it is handed to a migration written against an older one.
 */
export function applyControlPlaneSchema(db: DatabaseSync): void {
  db.exec(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
  checkSchemaVersion(db);
  migrate(db);
}

/**
 * Columns added to tables that already exist, and the rule that keeps a weekly
 * deploy from being a one-way door.
 *
 * `schema.sql` is re-applied on every open and is entirely
 * `CREATE TABLE IF NOT EXISTS`, so a **new table** arrives by itself and always
 * has. A new **column** on an existing table does not — SQLite ignores the rest
 * of a CREATE for a table that exists — so until this function there was no way
 * to add one at all. That is the half the daemon's `store/sqlite.ts` has had all
 * along, ported here rather than invented, so a reader who knows one knows both.
 *
 * ⚠ **The rule, and it is the whole reason this is safe to run weekly:
 * additions only, and `CP_SCHEMA_VERSION` does not move for them.** A nullable
 * column an older control plane never selects is invisible to it — every read in
 * this package names its columns, so an older build finds exactly what it asks
 * for — which means yesterday's image still starts against today's database and
 * a rollback is a rollback rather than an outage. `checkSchemaVersion` refuses a
 * database written by a *newer* build, so bumping the version to buy nothing
 * would convert a working rollback into a refused start.
 *
 * The version therefore moves only for a change that genuinely makes old code
 * wrong: a column whose meaning changed, a table whose rows an older build would
 * mis-read. Dropping or renaming is that, and neither belongs here — do it as a
 * deliberate two-release migration, not as a line in this function.
 *
 * `deploycheck` asserts the shape rather than trusting the comment: every
 * statement here is an `ALTER TABLE ... ADD COLUMN`, and nothing here is a DROP
 * or a RENAME.
 */
function migrate(db: DatabaseSync): void {
  /*
   * One `table_info` read per table this function touches, taken before any
   * `ALTER` — a second table's columns were read off `machines` for as long as
   * there was only one table here, and a lookup keyed on the wrong table
   * answers "missing" for a column that exists, which `addColumn` then survives
   * only by the race clause below. Each statement is a plain double-quoted
   * literal rather than a template over the table name, because that is what
   * `deploycheck` reads this function's SQL off — a literal it cannot see is a
   * statement it cannot refuse.
   */
  const columnsOf = (pragma: string): Set<string> =>
    new Set(db.prepare(pragma).all().map((column) => String(column["name"])));
  const machines = columnsOf("PRAGMA table_info(machines)");
  const users = columnsOf("PRAGMA table_info(users)");
  const apiKeys = columnsOf("PRAGMA table_info(api_keys)");
  const userSessions = columnsOf("PRAGMA table_info(user_sessions)");
  const has = (name: string): boolean => machines.has(name);

  /*
   * What build last dialled in, and what protocol version it agreed.
   *
   * Nullable with no DEFAULT, which is the honest value twice over: it is what
   * every machine that predates these columns deserves, and it is also what a
   * machine that has not dialled since they shipped will keep saying. Nothing
   * distinguishes "never reported" from "reported nothing", and nothing needs to.
   *
   * On `machines` rather than `relay_tunnels` because a tunnel row does not
   * outlive the tunnel, and the machine a rollout most needs to see is the one
   * that has been offline for a month.
   */
  addColumn(db, has("daemon_version"), "ALTER TABLE machines ADD COLUMN daemon_version TEXT");
  addColumn(db, has("daemon_protocol"), "ALTER TABLE machines ADD COLUMN daemon_protocol INTEGER");
  addColumn(db, has("daemon_seen_at"), "ALTER TABLE machines ADD COLUMN daemon_seen_at INTEGER");
  /*
   * And which build of each coding-agent CLI it would launch, as the compact
   * string `AGENT_CLIS_HEADER` carries (`claude=2.1.259;codex=0.153.1`), stored
   * as text rather than as columns per harness because the harness list is the
   * daemon's to grow and a column per name would put the relay back in lockstep
   * with it. Nullable for the three reasons above and a fourth — a daemon that
   * has a CLI for nothing sends no header at all — and, like the rest of the
   * row, an addition an older build never selects.
   */
  addColumn(db, has("daemon_agents"), "ALTER TABLE machines ADD COLUMN daemon_agents TEXT");
  /*
   * **Whose code this machine enrolled with**, as an id — a user's, or a
   * provisioning key's, because `POST /v1/provision` mints with the *key's* id
   * and that is the case most worth naming rather than the one to discard.
   *
   * ⚠ **Who *minted* the code, never who redeemed it, and the difference is this
   * field's sharpest limit.** The value is `enrollment_codes.created_by`, set by
   * `mintEnrollmentCode` for whoever asked. `POST /v1/enroll` is a public route —
   * it sits above `app.use("/v1/*", callerAuth(db))` because *the credential is
   * the body*, and a daemon redeeming a code presents no account at all — so
   * there is no identity of a redeemer to record. `used_from` records the address
   * and is deliberately forensic rather than shown.
   *
   * So the shape this does **not** catch: a code *you* minted, leaked, and
   * redeemed on somebody else's hardware. `created_by` is your own id, the route
   * reports `null`, and the row draws nothing — which reads as *I enrolled this
   * myself*, because you did mint it. What the field catches is the composition it
   * was built for, where the machine is registered and enrolled by somebody else;
   * a leaked code of your own is a different failure with a different remedy
   * (mint again, which supersedes), and this column is not evidence about it.
   * Every sentence about this field says "enrolled with" for that reason, and any
   * that says "brought online" has drifted back.
   *
   * ⚠ "discard" rather than the SQL verb, and not by accident: `deploycheck`
   * reads this whole function body — comments included — and refuses the two
   * destructive keywords anywhere in it, because a migration that removes or
   * renames a column is a deliberate two-release change rather than a line here.
   * The matcher is blunt on purpose, so prose has to route around it too.
   *
   * **It is a column rather than a join to `enrollment_codes`, and that is the
   * whole point of it.** Derived from that table it was wrong four ways, each
   * one reverting to `null` — which the route reports as *you enrolled this
   * yourself*: the rows are swept seven days after a code is used, so the answer
   * expired; `created_by` is left dangling on `DELETE /v1/admin/users/:id` on
   * purpose (`schema.sql` says so at `users.disabled_at`), so an `INNER JOIN
   * users` dropped it the moment the enroller's account went; `POST
   * /v1/provision` writes a `pk_` id no `users` row matches, so every
   * provisioned machine reported nothing at all; and `used_at` is stamped by
   * four *burn* paths as well as by redemption (`superseded`, `revoked`,
   * `user_disabled`, `user_deleted`), so the owner pressing "new enrollment
   * code" twice — the likeliest reaction to noticing something odd — overwrote
   * the name with their own. Written at the redemption that sets `enrolled_at`,
   * from the same statement, none of the four is reachable.
   *
   * Nullable with no DEFAULT, for the reason every column above is: NULL is the
   * honest answer for a machine that predates this and for one that has never
   * enrolled.
   *
   * ⚠ **NULL means *unknown*, and the route must not report it as "you" — which
   * it did.** `enrolledByFor` folded the empty value and the caller's own id into
   * one `null`, and both surfaces draw nothing for `null`, so on the day this
   * shipped every already-enrolled machine in the fleet read as self-enrolled. It
   * splits on `enrolled_at` now: NULL **and** enrolled says so out loud, NULL and
   * never-enrolled keeps the silence it has earned, and only an id matching the
   * caller reports nothing. The predicate `enrolled_at IS NOT NULL AND enrolled_by
   * IS NULL` is total for "before this was recorded", which is why the column is
   * written as NULL rather than `''` at the one place that writes it.
   *
   * ⚠ **A name here does not by itself mean a substitution.** `install.sh`'s
   * daemon wizard is `cpctl admin addmachine --owner` then `cpctl admin enroll`,
   * so *every* wizard-installed machine names the admin who ran the installer.
   * The field says who brought this online, which the owner is expected to
   * recognise; it does not say whether they should have.
   */
  addColumn(db, has("enrolled_by"), "ALTER TABLE machines ADD COLUMN enrolled_by TEXT");
  /*
   * When somebody last chose their own password, and when a key last signed a
   * request — two facts the settings screen draws beside the row they belong to
   * ("Changed 3 mo ago", "last used 2 d ago"). Both nullable with no DEFAULT,
   * for the reason the `machines` columns above are: NULL is the honest answer
   * for every row that predates them, and the screen has a word for it ("Set",
   * "never used") rather than a fabricated date. `schema.sql` says what writes
   * each; an older build selects neither, so the version does not move.
   */
  addColumn(db, users.has("password_changed_at"), "ALTER TABLE users ADD COLUMN password_changed_at INTEGER");
  addColumn(db, apiKeys.has("last_used_at"), "ALTER TABLE api_keys ADD COLUMN last_used_at INTEGER");
  /*
   * Which installation a sign-in belongs to. `schema.sql` says what NULL means
   * and why there are three ways to get one; an older build selects this column
   * nowhere, so the version stays where it is.
   *
   * ⚠ **It is guarded on `userSessions`, and reaching for `has()` here is the one
   * mistake this function has already made once.** `has()` asks `machines`, which
   * will never carry a column of this name — so the guard would be false for ever,
   * the `ALTER` would be attempted on every open by both processes rather than
   * once, and the only thing standing between that and `exit(2)` would be
   * `addColumn`'s duplicate-name clause, which is measured as a *one-shot* window
   * and is not a licence to re-roll the race at every restart. The three readers
   * above exist so each table answers for itself; a fourth table needs a fourth.
   */
  addColumn(db, userSessions.has("device_id"), "ALTER TABLE user_sessions ADD COLUMN device_id TEXT");
  /*
   * And the index over it, which is the one index in this service that cannot
   * live in `schema.sql`.
   *
   * ⚠ **Ordering, and it is not a preference.** `applyControlPlaneSchema` runs
   * the file, then the version gate, then this — so an index in `schema.sql`
   * naming a column this function has not added yet fails with
   * `no such column: device_id` against every database that already exists,
   * which is every deployment. Measured: it takes `openControlStore` down, and
   * `main.ts` answers that with `exit(2)` under a unit that restarts. Here, one
   * statement after the `ALTER`, it is correct on a fresh database and on an
   * upgraded one alike.
   *
   * ⚠ **It is also the reason `deploycheck` allows a third statement shape.**
   * That driver refuses anything here that is not an `ALTER … ADD COLUMN` or a
   * `PRAGMA`, because those are the two that cannot make an older build wrong.
   * An idempotent `CREATE INDEX` is the third with that property — it changes no
   * row, no column and no meaning, and an older build simply never uses it — and
   * the check names it explicitly rather than loosening to a wildcard.
   *
   * What it is for: retiring a device ends every session bound to it, which is
   * one `WHERE device_id = ?`. Unindexed that is a scan of every session in the
   * fleet, inside a transaction, against `synchronous = FULL`, on the process
   * the relay shares — the cost `idx_grants_machine` was added to remove from
   * the same shape of question one table over.
   */
  db.exec("CREATE INDEX IF NOT EXISTS idx_user_sessions_device ON user_sessions (device_id)");
}

/**
 * One `ADD COLUMN`, and the reason it is not just `if (!has) exec`.
 *
 * ⚠ **Two processes open this database and both run `migrate()`.** `compose.yml`
 * gives the API and the relay the same volume with **no `depends_on`** — that
 * absence is deliberate and documented, the relay must serve with the API down —
 * so `compose.sh up -d`, a host reboot under `restart: unless-stopped`, and a
 * docker-daemon restart all start the two together. `PRAGMA table_info` is then a
 * read, and the `ALTER` after it is a write with no lock between them: both see
 * the column missing, one adds it, the other gets `duplicate column name` out of
 * `openControlStore`, and `main.ts` answers that with `exit(2)`.
 *
 * Measured on the upgrade path — an existing database opened by two new
 * processes at once — at **4 runs in 8**, against 0 in 8 both before the upgrade
 * and after it. So it is a one-shot window per database, on exactly the restart
 * where this migration is new, and the loser can be the relay: the whole fleet's
 * reachability, gone until the unit restarts it. That is the crash-loop-takes-the-
 * relay outcome the header of `schema.sql` argues against, arriving through the
 * mechanism added to prevent it.
 *
 * Losing the race is therefore **success, not an error**: the column exists,
 * which is all the caller wanted. Only that one error is swallowed — anything
 * else (a table that is not there, a disk that is full, a file that is not a
 * database) still throws, because those are the failures a start must not
 * survive. `BEGIN IMMEDIATE` around the whole function was the alternative and is
 * worse: it converts the same race into a `SQLITE_BUSY` against the 250 ms
 * timeout, which is the same crash with a less obvious cause.
 */
function addColumn(db: DatabaseSync, present: boolean, statement: string): void {
  if (present) return;
  try {
    db.exec(statement);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/duplicate column name/i.test(message)) throw error;
  }
}

function checkSchemaVersion(db: DatabaseSync): void {
  const row = db.prepare("PRAGMA user_version").get();
  const found = Number(row?.["user_version"] ?? 0);
  if (found > CP_SCHEMA_VERSION) {
    throw new Error(
      `this file was written by a newer control plane (schema v${found}, this is v${CP_SCHEMA_VERSION}). ` +
        "Old code reading new columns mis-parses rather than fails, so it refuses instead.",
    );
  }
  if (found !== CP_SCHEMA_VERSION) db.exec(`PRAGMA user_version = ${CP_SCHEMA_VERSION}`);
}
