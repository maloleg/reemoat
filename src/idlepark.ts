import { IDLE_PARK_SWEEP_MS } from "./registry.js";

/**
 * Letting go of the agents nobody is using.
 *
 * **The problem this exists for is memory, and it was measured before it was
 * built** (2026-09-09, the development machine, `phys_footprint`). Five live
 * sessions held 1 984 MB: a claude session is 259–341 MB — an ACP bridge plus the
 * CLI under it — and an opencode session 447–476 MB. Of that, 1 384 MB belonged
 * to three sessions nobody had touched in 48.7 hours, all of them `idle`, holding
 * no turn and no unanswered question. Sampled twice twelve minutes apart, they
 * moved by under 2%: **an idle agent does not give memory back on its own.**
 *
 * Nothing in the daemon released them. `MAX_LIVE_SESSIONS` counts what is
 * running, but only `create()` ever checks it, so the ceiling bounded how many
 * conversations somebody could *open* and never how many agents a machine ends up
 * holding — and at the measured mean of ~397 MB, its default of 64 is ~25 GB.
 *
 * **What makes this cheap is that the way back already existed.** Parking is
 * `stop("parked")`, and coming back is the same `session/resume` the daemon
 * performs after every one of its own restarts — measured at 1 292 ms p50 for
 * claude resuming on its own, 2 376 ms p90, over the 28 reattaches that make up
 * that row of Q2.224's 120. So the trade is ~397 MB against ~1.3 s, and
 * `IDLE_PARK_MS` is where that arithmetic is written down.
 *
 * **What this class is, therefore, is a clock and nothing else.** Every decision
 * about *whether* a session may be released lives in `ManagedSession.parkable`,
 * and the ordering in `SessionRegistry.parkIdleSessions`. That split is on
 * purpose: the preconditions are invariants about a session and belong beside the
 * status they are derived from, while "how often to look" is a policy that a
 * driver has to be able to fake.
 *
 * ⚠ **It drives two sweeps now, and that is one clock rather than a second job.**
 * The other is `SessionRegistry.abandonWedgedTurns` — giving up on a turn the
 * agent has never answered, `TURN_SILENCE_MS`. It belongs on this timer and not on
 * one of its own for the reason this class's own docblock gives about shapes: a
 * second self-rescheduling `unref`'d `setTimeout` with its own re-entrancy guard
 * and its own idempotent shutdown is a second set of the same mistakes. What the
 * two sweeps share is the clock and nothing else — each has its own port, its own
 * `enabled` thunk and its own report, because a machine that keeps its agents
 * resident has not thereby asked to keep a session claiming to be working for
 * ever.
 *
 * They run in one tick, park first. The order is deliberate and it is the only
 * coupling between them: abandoning a turn makes a session `idle`, which is the
 * state `parkable` requires — so running the reaper first would offer the park
 * sweep a session that became eligible one statement ago and had not been quiet
 * for a second. Half an hour later it goes, measured from the ending, which is
 * what the threshold means.
 *
 * Shaped on `AgentUpdates`, deliberately and down to the details — a static
 * factory, though unlike `AgentUpdates` it always arms, because `enabled` is a
 * thunk read at every tick rather than a mode fixed at construction (see
 * {@link IdleParking.start}), a self-rescheduling `setTimeout` rather
 * than an interval, `unref()` so housekeeping is never a reason for the process to
 * stay alive, a re-entrancy guard against an injected schedule that fires twice,
 * and an idempotent `shutdown`. A second shape for the same job is a second set of
 * mistakes.
 */
export interface IdleParkOptions {
  /**
   * Release the agents that have been quiet long enough, and answer which.
   *
   * `SessionRegistry.parkIdleSessions` is what fills this. A port rather than the
   * registry itself, so the drivers can drive the schedule without a fleet.
   */
  park: () => Promise<string[]>;
  /**
   * Whether to run at all.
   *
   * ⚠ **A thunk, not a boolean, for the reason `elicitationAllowed` is one:**
   * `daemon.ts` builds the registry before it has finished reading the
   * environment, and a value captured at construction would be stale.
   *
   * ⚠ **It gates {@link park} alone.** It used to gate the tick, which was the
   * same thing while there was one sweep and is a trap now: reading it for both
   * would make `REEMOAT_IDLE_PARK_MINUTES=0` switch off a policy nobody pointed
   * it at.
   */
  enabled?: () => boolean;
  /**
   * Give up on the turns no agent has answered, and answer which.
   *
   * `SessionRegistry.abandonWedgedTurns` fills this, a port for the reason
   * {@link park} is one. Synchronous, unlike its neighbour, and that is a fact
   * about what it does rather than a convenience: it pushes one event into a queue
   * a generator is already parked on, where parking stops a process.
   */
  reap?: () => readonly string[];
  /** Whether *that* one runs. Its own switch; see {@link enabled}. */
  reapEnabled?: () => boolean;
  /** Injected so a driver can run this with no clock. Must answer an `unref`-able handle or a fake. */
  schedule?: (fn: () => void, ms: number) => { cancel: () => void };
  /** How often to look. Defaults to {@link IDLE_PARK_SWEEP_MS}. */
  sweepMs?: number;
  /**
   * Told what was released, so the daemon can say so on stdout.
   *
   * **Reported rather than silent, and this is the one thing about parking a
   * person can notice.** An agent that vanished with nothing said is
   * indistinguishable from one that crashed, and the transcript's own `status`
   * event is only visible to somebody already looking at that session. The
   * operator reading a daemon log needs the fleet-level line.
   */
  onParked?: (ids: readonly string[]) => void;
  /**
   * Told which turns were given up on, for {@link onParked}'s reason and one of
   * its own.
   *
   * A session's own transcript carries the `turn_end{abandoned}`, so the person
   * reading that conversation is told. Nobody else is — and an agent that stops
   * answering is a fleet-level fact about an adapter or a build, which is exactly
   * the kind of thing an operator finds by reading a daemon log and cannot find
   * any other way.
   */
  onAbandoned?: (ids: readonly string[]) => void;
}

export class IdleParking {
  private timer: { cancel: () => void } | null = null;
  private stopped: Promise<void> | null = null;
  private running = false;

  private constructor(private readonly options: IdleParkOptions) {}

  /**
   * Arms the sweep and returns the handle that disarms it.
   *
   * Always armed, even when `enabled()` currently answers false — unlike
   * `AgentUpdates.start`, which can decide once because its mode is fixed at
   * construction. Here the answer can change under a running daemon (the thunk is
   * read from the environment `daemon.ts` has not finished reading yet), so the
   * question is asked at every tick instead. A disabled sweep costs one timer that
   * wakes a minute apart and returns immediately.
   */
  static start(options: IdleParkOptions): IdleParking {
    const parking = new IdleParking(options);
    parking.arm();
    return parking;
  }

  /** Idempotent, like every other shutdown here. */
  shutdown(): Promise<void> {
    return (this.stopped ??= this.doShutdown());
  }

  private async doShutdown(): Promise<void> {
    this.timer?.cancel();
    this.timer = null;
    /*
     * A sweep in flight is not awaited, and unlike `AgentUpdates` that costs
     * nothing to reason about: what it is doing is stopping sessions, and the
     * shutdown that follows stops every one of them anyway. The worst case is one
     * session written with `parked` a moment before it would have been written
     * with `daemon_shutdown` — and `doStop`'s `exitRecord ??=` means the first
     * writer wins, so it is that and not a rewrite.
     *
     * ⚠ That difference is worth stating rather than leaving to be rediscovered:
     * a session parked at the instant of a shutdown comes back on a *prompt*
     * rather than at the next boot, because `autoResumable` answers `parked` that
     * way. `parkIdleSessions` therefore checks `shuttingDown` between sessions, so
     * the window is one session wide rather than the whole sweep.
     */
  }

  private arm(): void {
    if (this.stopped !== null) return;
    const schedule =
      this.options.schedule ??
      ((fn, ms) => {
        const handle = setTimeout(fn, ms);
        // Or a daemon with nothing else to do would be held open by this alone.
        handle.unref();
        return { cancel: () => clearTimeout(handle) };
      });
    this.timer = schedule(() => void this.tick(), this.options.sweepMs ?? IDLE_PARK_SWEEP_MS);
  }

  private async tick(): Promise<void> {
    this.timer = null;
    if (this.stopped !== null) return;
    /*
     * A sweep still going when a tick fires is skipped rather than queued.
     * Through this class's own schedule that is unreachable — the next timer is
     * armed only after the sweep settles — so what the guard is for is an injected
     * `schedule` that fires twice, where the second pass would otherwise be
     * stopping sessions the first is already inside `stop()` on.
     */
    if (!this.running) {
      this.running = true;
      try {
        if (this.options.enabled?.() ?? true) {
          const parked = await this.options.park();
          if (parked.length > 0) this.options.onParked?.(parked);
        }
        /*
         * After the park and inside the same guard. ⚠ **Not in a second `try`**:
         * one throw must not cost the other sweep its turn, and it does not —
         * `abandonWedgedTurns` is synchronous and touches no process, so the only
         * way it throws is a bug, and a bug there that silently skipped parking
         * would be a memory leak nobody could see. If it ever grows an await, this
         * is the line that needs splitting.
         */
        if (this.options.reapEnabled?.() ?? true) {
          const abandoned = this.options.reap?.() ?? [];
          if (abandoned.length > 0) this.options.onAbandoned?.(abandoned);
        }
      } catch {
        // A sweep is housekeeping and the next one is a minute away. There is
        // nothing to report that the session's own transcript does not already
        // carry, and a throw here would be the one way this timer stops arming.
      } finally {
        this.running = false;
      }
    }
    this.arm();
  }
}
