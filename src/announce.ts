import { chmodSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Where this daemon is, for a client on the same computer.
 *
 * **A file, deliberately, rather than a well-known port.** The native app could
 * simply try `127.0.0.1:7887` — the daemon is usually there — and that design was
 * built and taken back out, because the probe has to carry a credential to be
 * worth anything and a probe that carries one hands it to whatever answered. A
 * machine token is a 300-second bearer for a machine, spendable **through the
 * relay** from anywhere, so a different OS user who binds that port before the
 * daemon does harvests one per wake. That is a privilege escalation this daemon
 * would have created rather than found.
 *
 * A file closes it by the only mechanism that actually holds on a shared host:
 * it lives in a `0700` directory this uid owns, so nobody else can write it. The
 * app therefore never spends a token on a listener it has not already been told
 * about by something only the daemon's own user could have said. The `aud` check
 * is still what *establishes* the machine — see `SignedTokenVerifier.verify` —
 * and this file is only what stops the question being asked of a stranger.
 *
 * It buys two more things that a fixed port cannot. A daemon on a custom
 * `REEMOAT_PORT` is reachable with nothing typed anywhere; and so is one on
 * `REEMOAT_PORT=0`, which has no port to guess at all.
 *
 * ⚠ **It is not a credential and it is not a device id.** Every field here is
 * either public (the port, which anyone on the host can see with `lsof`) or
 * already readable by this uid out of `~/.reemoat/reemoat.db`, which holds the
 * machine id, the signing keys and every transcript. Nothing is added to what a
 * process running as this user already has; what is added is a *statement* it can
 * trust about which of the things it already has is listening where.
 */
export const ANNOUNCE_VERSION = 1;

/**
 * The file's whole content.
 *
 * ⚠ **This shape is written down twice** — here, and as `Stored` in
 * `packages/native/src-tauri/src/local.rs`, which is the only reader. Not
 * `LocalDaemon` beside it: that is the smaller thing the reader hands the page,
 * and it carries neither `v` nor `host` nor `port` nor `authMode`. A field renamed
 * on one side and not the other is a local route that silently stops being
 * offered, with no error anywhere, so `nativecheck` reads both off disk and
 * asserts the key sets are the same. Same hazard and the same remedy as
 * `OPENABLE`/`OPENABLE_SCHEMES` one file over.
 */
export interface LocalAnnounce {
  v: number;
  /** What a token's `aud` has to be for this daemon to accept it. */
  machineId: string;
  /** Always loopback. The reader refuses anything else rather than trusting it. */
  host: string;
  port: number;
  /**
   * Regenerated on every start, so a client can tell a restart from a reconnect.
   * Carried because `GET /health` answers it too and the two must agree.
   */
  instanceId: string;
  /**
   * Only the two modes that accept a control-plane token. A `shared_secret`
   * daemon announces nothing at all — it has no identity to announce — so this
   * can never be that value, and the reader refuses it if it somehow is.
   */
  authMode: "signed" | "both";
}

/** `~/.reemoat/daemon.json`, always — see {@link writeAnnounce}. */
export function announcePath(home: string = homedir()): string {
  return join(home, ".reemoat", "daemon.json");
}

/**
 * Publish where this daemon is listening.
 *
 * **Under `homedir()` and never under `dirname(REEMOAT_DB)`**, even though the
 * database is the thing this sits beside by default. The reader is a desktop app
 * with no access to this process's environment: it cannot know that variable, so
 * a path derived from it is a path nothing can find. Two daemons on one account
 * with different databases are therefore last-writer-wins, and that is safe
 * rather than merely tolerable — the file names a machine id, the client checks
 * it against the machine it wants, and a mismatch declines. The worst a stale or
 * losing file can do is cost one refused connection.
 *
 * Written to a temporary name and renamed, so a reader never sees half a file.
 * `rename` within one directory is atomic on every filesystem this runs on.
 *
 * Best-effort throughout: a daemon that cannot write this still serves every
 * request through the relay, which is what every other client uses. It is not a
 * reason to refuse to start, and the caller reports rather than throws.
 */
export function writeAnnounce(announce: LocalAnnounce, home: string = homedir()): void {
  const path = announcePath(home);
  const tmp = `${path}.${process.pid}.tmp`;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  try {
    // The same argument `store/sqlite.ts` makes for the database: `mkdirSync`'s
    // mode applies only to directories it actually created, so an upgrade into an
    // existing 0755 ~/.reemoat would leave this world-readable. The directory is
    // the durable answer; this file's own mode is the belt.
    chmodSync(dirname(path), 0o700);
  } catch {
    // A filesystem with no POSIX modes. The write below still happens, and the
    // contents are not secret — see the ⚠ on ANNOUNCE_VERSION.
  }
  writeFileSync(tmp, `${JSON.stringify(announce, null, 2)}\n`, { mode: 0o600 });
  try {
    // `writeFileSync`'s mode is masked by the umask, so it is not enough on its
    // own: 0600 under a 0022 umask lands as 0600, and under a umask somebody has
    // widened it does not. Set it explicitly before the rename publishes it.
    chmodSync(tmp, 0o600);
  } catch {
    // As above.
  }
  renameSync(tmp, path);
}

/**
 * Stop advertising.
 *
 * Called on a clean shutdown so a stopped daemon is not offered as a local route.
 * A crash leaves the file behind and that costs one refused connection on the
 * next probe, which is why nothing depends on this running — it is tidiness, not
 * a guarantee.
 *
 * ⚠ **`unlinkSync` rather than `rmSync(force)`, and the reason is prose rather
 * than behaviour.** For a regular path this uid wrote the two are the same call:
 * `force` suppresses `ENOENT` and nothing else, which is exactly what the catch
 * below does. What differs is what the word costs elsewhere. Six load-bearing
 * comments argue containment from there being **one** `rmSync` in this codebase
 * — `worktree.ts:497`, `paths.ts:33` and `:50`, `uploads.ts:1068`,
 * `plugins/host.ts:1473` and `.claude/rules/files-paths-git.md:88` — and
 * `paths.ts`'s guard is *stated* as the guard on that one call site, so a second
 * `rmSync` anywhere in `src/` silently converts all six into claims that read as
 * true and are not. This one deletes, by name, a file it wrote itself into a
 * `0700` directory; it is not the recursive delete over a path somebody else
 * chose that the guard exists for, and it must not be spelled like one.
 */
export function removeAnnounce(home: string = homedir()): void {
  try {
    unlinkSync(announcePath(home));
  } catch (error) {
    // Already gone is the ordinary case — a daemon that never got as far as
    // announcing, or a second shutdown path arriving after the first. Anything
    // else is rethrown, because that is what `force: true` did.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
