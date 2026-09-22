/**
 * Who may run `deploy/agents.sh` right now.
 *
 * ⚠ **The script has a lock of its own and it is not enough, because of what it
 * answers with.** A contended run is a warning on stderr and `exit 0` — the right
 * answer for the three callers that contract this script never fails, and
 * indistinguishable, for the fourth, from a successful run that found nothing to
 * do. An install somebody pressed would draw that as *installed*. `--fail-if-locked`
 * gives that one caller a status it can read, and this gate is the half that keeps
 * the two runs from meeting in the first place, so the flag is the backstop rather
 * than the mechanism.
 *
 * ⚠ **And the script's lock cannot see everything this does.** It is `mkdir` on a
 * directory in the filesystem, so it catches an *orphan* — a previous daemon's
 * detached run, which nothing here can enumerate. This is a field in one process's
 * memory, so it catches the two runs this daemon starts. Neither subsumes the
 * other and both are needed.
 *
 * ⚠ **First come, first served — and what differs is the *cost* of losing, which
 * is where the asymmetry actually is.** This paragraph used to read *an install
 * wins and the daily refresh yields*, and {@link AgentScriptGate.tryHold} has
 * never done that: it refuses whoever arrives second, whichever kind that is. So
 * an install pressed while the daily tick holds the gate is the **refused** side,
 * `server.ts` answers it `409 install_busy` — *this machine is refreshing its
 * agents; try again in a moment*. ⚠ **`daemoncheck` pins the two halves and not
 * the pair**: that `tryHold` refuses an install under a held `update`, and,
 * separately, that the route answers `409 install_busy` — driven there with an
 * *install* holding, so the `update` arm and the sentence it draws are reached by
 * no driver.
 *
 * Preemption is deliberately not built: what the loser of that race would have to
 * be is a script killed mid-write, which is the corruption both layers here exist
 * to prevent.
 *
 * ⚠ **The re-arm is the half that is asymmetric.** A refused install is a `409`
 * in front of somebody who can press it again in a minute. A refused refresh has
 * nobody watching it at all, and `AgentUpdates` arms `nextDelay()` — a day ± 10 %
 * — after *every* tick, so its refused tick re-arms `FIRST_RUN_DELAY_MS` instead:
 * without that, a run skipped because somebody installed for three minutes
 * silently costs the whole fleet a day's refresh.
 */

/** Who holds the script, and since when. */
export interface ScriptHolder {
  kind: "update" | "install";
  /** The harness an install is for, or `null` for a run over all of them. */
  agent: string | null;
  since: number;
}

export class AgentScriptGate {
  private held: ScriptHolder | null = null;

  /**
   * Take the gate, or answer `false` because somebody else has it.
   *
   * Not re-entrant and deliberately not counted: there is exactly one script and
   * two callers, and a depth counter would let a caller that forgot one release
   * hold it for the life of the process.
   */
  tryHold(kind: "update" | "install", agent: string | null = null, now = Date.now()): boolean {
    if (this.held !== null) return false;
    this.held = { kind, agent, since: now };
    return true;
  }

  /**
   * Give it back, and only if this is the caller that took it.
   *
   * ⚠ **Identity-checked, like every other release in this daemon.** A `finally`
   * that released unconditionally would hand the gate away on the path where
   * `tryHold` had just answered `false` — so a refused daily run would release the
   * install it had just lost to, and the next tick would start a second script
   * over the first one's staging directory.
   *
   * ⚠ **The identity is the `kind` and not the *holder*, which is a narrower
   * check than the paragraph above sounds.** It tells the two callers apart, since
   * there is exactly one of each; it cannot tell one install from the next one. So
   * a caller that released twice would, on its second release, free whatever
   * install had taken the gate in between. What made that reachable was
   * `AgentInstallRuns.settle` being entered twice on a spawn failure, and that is
   * closed where it happened, by `InstallRun.beginSettle`. Handing out an opaque
   * token from `tryHold` and comparing it here is the fix that would make the
   * check total; it is not built, because `src/agentupdate.ts` holds the other two
   * call sites and nothing reaches the state any more.
   */
  release(kind: "update" | "install"): void {
    if (this.held?.kind === kind) this.held = null;
  }

  /** Who has it, for the sentence a refusal carries. `null` when nobody does. */
  get holder(): ScriptHolder | null {
    return this.held;
  }
}
