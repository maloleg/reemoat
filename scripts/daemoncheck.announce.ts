import { chmodSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { check, report } from "./daemoncheck.env.js";
import { tmp } from "./tmp.js";
import { ANNOUNCE_VERSION, announcePath, removeAnnounce, writeAnnounce } from "../src/announce.js";

/* ------------------------------------------------------------------ *
 * What a daemon says about itself to the computer it is running on
 *
 * **The file is the security argument, so the mode is the assertion.** A client on
 * this machine has to carry a machine token to prove anything to a daemon, and a
 * token shown to the wrong listener is a 300-second bearer spendable through the
 * relay from anywhere. What makes this safe rather than a port probe is that the
 * announcement lives somewhere only this uid can write — so the whole of what is
 * being checked here is that it actually does, including on an upgrade into a
 * directory that already existed with wider permissions.
 *
 * `packages/native/src-tauri/src/local.rs` is the only reader; `nativecheck`
 * compares the two shapes off disk, since neither language can see the other.
 * ------------------------------------------------------------------ */

process.stdout.write("\nannouncing a daemon to its own computer\n");

const home = tmp("daemoncheck-announce-");

const announce = {
  v: ANNOUNCE_VERSION,
  machineId: "m_ab12",
  host: "127.0.0.1",
  port: 7887,
  instanceId: "i_x",
  authMode: "signed" as const,
};

{
  writeAnnounce(announce, home);
  const path = announcePath(home);
  check("it lands where a client looks for it", path, join(home, ".reemoat", "daemon.json"));
  check("and round-trips as itself", JSON.parse(readFileSync(path, "utf8")) as unknown, announce);

  /*
   * ⚠ **0600 and 0700, and the second one is the one that matters.** A file another
   * OS user can *write* is a file that can name a port they control, which is the
   * whole attack this design exists to close — a harvested machine token, spendable
   * from anywhere through the relay. `store/sqlite.ts` makes the same argument for
   * the database beside it.
   */
  check("the file is readable by nobody else", statSync(path).mode & 0o777, 0o600);
  check("nor is the directory holding it", statSync(join(home, ".reemoat")).mode & 0o777, 0o700);
}

{
  /*
   * **The upgrade case, which `mkdirSync(mode)` does not cover.** That mode applies
   * only to directories it actually created, so a `~/.reemoat` that already exists
   * at 0755 — every machine enrolled before this shipped — would keep its mode and
   * the announcement would be world-readable. `store/sqlite.ts` learnt this for the
   * WAL files; the same `chmodSync` is why it holds here.
   */
  const older = tmp("daemoncheck-announce-old-");
  mkdirSync(join(older, ".reemoat"), { recursive: true });
  chmodSync(join(older, ".reemoat"), 0o755);
  writeAnnounce(announce, older);
  check("an existing wide directory is narrowed rather than left", statSync(join(older, ".reemoat")).mode & 0o777, 0o700);
  rmSync(older, { recursive: true, force: true });
}

{
  /*
   * **Published by a rename, so a reader never sees half a file.** The reader is a
   * separate process polling on its own schedule; a partial write is a parse
   * failure, which degrades to the relay — but a temporary file left behind is a
   * file somebody finds in `~/.reemoat` and wonders about.
   */
  writeAnnounce({ ...announce, port: 7899 }, home);
  check("a second write replaces the first", (JSON.parse(readFileSync(announcePath(home), "utf8")) as { port: number }).port, 7899);
  const leftovers = readdirSafe(join(home, ".reemoat")).filter((name) => name !== "daemon.json");
  check("and leaves no temporary file behind", leftovers, []);
}

{
  removeAnnounce(home);
  report("a clean shutdown stops advertising", !existsSafe(announcePath(home)), announcePath(home));
  /*
   * Twice, because a daemon that never announced — `shared_secret`, or one that
   * could not write — still runs this on the way out, and a shutdown path that
   * threw there would turn a tidy-up into a failed stop.
   */
  removeAnnounce(home);
  report("and doing it twice is not an error", true, "no throw on a second remove");
}

{
  /*
   * A daemon whose home is not writable at all. The caller reports and carries on:
   * every client can still reach this machine the way every other one does.
   */
  const blocked = join(tmp("daemoncheck-announce-blocked-"), "not-a-directory");
  writeFileSync(blocked, "");
  let threw = false;
  try {
    writeAnnounce(announce, blocked);
  } catch {
    threw = true;
  }
  report("an unwritable home throws rather than half-announcing", threw, "caller reports and continues");
  check("and nothing was created", existsSafe(announcePath(blocked)), false);
}

rmSync(home, { recursive: true, force: true });

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function existsSafe(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}
