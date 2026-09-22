import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

import type { AgentId } from "./acp/agents.js";
import type { AgentScriptGate, ScriptHolder } from "./agentscript.js";
import { PACKAGE_ROOT, RUN_TIMEOUT_MS, updateEnv } from "./agentupdate.js";
import { readFrom } from "./transcript.js";

/**
 * Putting a harness on this machine, because somebody asked for it.
 *
 * ⚠ **This is the half of the posture change that a person is in.** Nothing
 * installs an agent CLI by itself any more: the bootstrap installs none, the daily
 * timer runs `--refresh-only` and moves only what is already here, and a harness
 * arrives on a machine when somebody presses a button about it. `deploy/agents.sh
 * --only <agent>` is what that press runs, and this file is the run.
 *
 * Modelled on {@link AgentLoginRuns} — one run, a transcript with a cursor, a TTL
 * sweep, a `done`/`exit` record — and different from it on four counts, each of
 * which was a decision rather than a difference that fell out:
 *
 * **One slot for the whole daemon, not one per agent.** `deploy/agents.sh` holds a
 * single `mkdir` lock. A `Map<AgentId, …>` would let a screen start five runs of
 * which four are answered by that lock with a warning and `exit 0` — four
 * transcripts that end, look finished, and installed nothing.
 *
 * **A second start is refused, never superseded.** A login supersedes because its
 * commonest end is a closed tab leaving a pty waiting on stdin, and refusing there
 * would be a permanent wall in front of the one person who cannot get past it.
 * Neither half holds here: an install waits on nobody, and killing a half-done
 * `npm i -g` or a vendor installer mid-write is exactly the corruption the
 * script's lock exists to prevent.
 *
 * ⚠ **And `cancel` is held to that same line now, which for several releases it
 * was not.** It SIGKILLs the whole process group on demand, so the sentence above
 * described a rule two paths in this file kept and a third broke. `ensure_npm`
 * stages under `$TOOLCHAIN` and repoints with a `ln`+`mv`, so the npm door
 * survives a kill at any instant — but claude's, codex's and opencode's vendor
 * installers write straight into `~/.local/bin` and `~/.local/share/claude` with
 * no staging, and `MANAGED_CLI_DIRS` means `LocalRuntime.agentCli` then *executes*
 * whatever file is left at that path. A Stop at the wrong second left a truncated
 * binary for this daemon to spawn as a harness. So a Stop is refused once the
 * checkpoint *announcing* a write outside `$TMP` has been parsed, which is what
 * {@link InstallRunView.cancellable} answers and what {@link MID_WRITE_PHASES}
 * names.
 *
 * ⚠ **Which leaves a window one line of stdout wide, and it is worth stating
 * rather than rounding off.** The script prints the checkpoint and *then* writes,
 * and {@link InstallRun.append} moves the phase only for a line that has arrived
 * whole — so between that `printf` and its newline reaching this process,
 * `cancellable` still answers for the previous phase and a Stop is signalled.
 * Measured 2026-09-22: with the checkpoint's bytes held in the carry and no
 * newline yet, `cancellable` is still `true` and {@link AgentInstallRuns.cancel}
 * answers `true`; the newline alone moves the phase to `install`, `cancellable` to
 * `false` and the cancel to a refusal. The guarantee is therefore *refused from
 * the checkpoint onwards* and not *refused while a write is in flight*: closing
 * the difference would need the script to wait on an acknowledgement from this
 * daemon, and it is spawned `stdio: ["ignore", …]` with nothing to wait on.
 *
 * The {@link RUN_TIMEOUT_MS} deadline is deliberately **not** held to the refusal:
 * see {@link AgentInstallRuns.cancel}.
 *
 * **The TTL runs from the *end*, and copying `LoginRun.expired` would be a bug.**
 * That one measures from `startedAt` and kills a live pty at ten minutes, which is
 * right for a flow waiting on a person. Here ten minutes from the start would kill
 * a legitimate download on a slow link. A **running** run is bounded only by
 * {@link RUN_TIMEOUT_MS}; only a finished record ages out.
 *
 * **The verdict is a measurement, never the exit status.** `deploy/agents.sh`
 * exits 0 having printed `install failed; this machine has no copy of it until the
 * next run` — it must, because three of its four callers contract that it never
 * fails. So "did this work" is answered by asking the machine again, through
 * {@link AgentInstallOptions.verify}, after the caches that would answer stale
 * have been dropped. Same posture as the login wizard re-probing rather than
 * trusting macOS `script`'s status, for a different reason: an exit code here is a
 * contract about the *script*, not about the machine.
 */

/** How long a finished record stays readable. Measured from `endedAt`. */
export const INSTALL_RETAIN_MS = 10 * 60 * 1000;

/** How often {@link INSTALL_RETAIN_MS} is actually checked. `agentauth.ts`'s number. */
const SWEEP_INTERVAL_MS = 60_000;

/** The transcript ceiling, front-dropped. `agentauth.ts`'s number, for one act. */
const MAX_OUTPUT_BYTES = 64 * 1024;

/** How much of the tail a client that lost the transcript still gets as a sentence. */
const MAX_DETAIL_CHARS = 2000;

/**
 * What happened, once the run has ended.
 *
 * ⚠ **`installed` and `failed` are decided by asking the machine, not by reading
 * `exit`.** See the file docblock: a failed install exits 0. `locked` is the one
 * outcome the status *does* carry, and only because `--fail-if-locked` was passed
 * to make it carry one.
 */
export type InstallOutcome =
  | "running"
  | "installed"
  | "failed"
  | "locked"
  | "timeout"
  | "cancelled"
  | "spawn_failed";

/** Where a run has got to, as the script's own checkpoints report it. */
export type InstallPhase = "start" | "download" | "install" | "link" | "done" | "failed";

const PHASES: readonly InstallPhase[] = ["start", "download", "install", "link", "done", "failed"];

/**
 * The phases in which `deploy/agents.sh` has a write outside `$TMP` in flight, and
 * so the phases a Stop may not signal into. Read by {@link InstallRun.cancellable}.
 *
 * ⚠ **Both ends of this are measured off the script rather than reasoned about.**
 * `download` is printed *before* the `curl -o "$TMP/<agent>.sh"`, so a kill there
 * loses a file the EXIT trap was going to remove anyway. `install` is printed
 * before two very different things — `attempt`'s vendor installer, which writes
 * into `~/.local/bin` in place, and `ensure_npm`'s `npm i -g --prefix "$_stage"`,
 * which does not — and `link` before the `ln`+`mv` that repoints
 * `$TOOLCHAIN/bin/<agent>`. Only the npm half of `install` is safe, and the phase
 * line does not say which half it is in, so both are refused.
 *
 * ⚠ **`done` and `failed` are deliberately absent**: they are printed after the
 * per-agent work returns, so nothing is in flight there — a Stop in that window is
 * allowed and is very nearly a no-op.
 */
const MID_WRITE_PHASES: readonly InstallPhase[] = ["install", "link"];

/**
 * Which pipe a chunk of output arrived on.
 *
 * ⚠ **It is a parameter because line framing is per stream, and one shared
 * `carry` spliced them.** `deploy/agents.sh` prints `step:`, `say` and `note` on
 * stdout and `warn` on stderr; with one held-back partial line between them, a
 * stderr write landing between two stdout chunks concatenated the halves of a
 * checkpoint that was about to parse. `readStep`'s `^step: … $` then answered
 * `null`, the progress indicator stuck on the previous phase, and the transcript
 * showed one spliced line — for any run that warns, which is every run that had
 * anything to report.
 */
export type InstallStream = "stdout" | "stderr";

/**
 * One `step:` line from `deploy/agents.sh`, or `null` for anything else.
 *
 * ⚠ **The emitter is in this repository and `deploycheck` imports *this function*
 * to drive it**, which is the whole difference from `ui/login.ts`'s posture. There,
 * a vendor's sentences are the only thing there is, so the parse is a guess with a
 * raw-transcript fallback. Here both ends are ours, so the grammar is one line and
 * the driver holds them to each other — the trick `MANAGED_CLI_DIRS` already uses
 * for the other list that file shares with `src/`.
 *
 * ⚠ **It exists because the script is silent for minutes.** `attempt` and
 * `ensure_npm` send every vendor installer's and npm's own output to `/dev/null`,
 * deliberately, so the transcript is one header line and then nothing until a
 * harness has already finished. A progress indicator fed by that had nothing to
 * move.
 *
 * Unknown agents and unknown phases answer `null` rather than throwing: this reads
 * a stream, and one malformed line must not end a run that is working.
 */
export function readStep(line: string): { agent: string; phase: InstallPhase } | null {
  const match = /^step: (\S+) (\S+)$/.exec(line.trim());
  if (match === null) return null;
  const [, agent, phase] = match;
  if (agent === undefined || phase === undefined) return null;
  if (!(PHASES as readonly string[]).includes(phase)) return null;
  return { agent, phase: phase as InstallPhase };
}

/** What a client sees of a run. The mirror of this rides `wire.ts`. */
export interface InstallRunView {
  installId: string;
  agent: AgentId;
  startedAt: number;
  endedAt: number | null;
  done: boolean;
  outcome: InstallOutcome;
  exit: { code: number | null; signal: string | null } | null;
  /** The newest checkpoint the script reported, or `null` before the first. */
  phase: InstallPhase | null;
  /** The tail of what it said, for a client that lost the transcript. */
  detail: string | null;
  /** Bytes of output discarded off the front of the buffer, if it ever filled. */
  dropped: number;
  /** Total output produced so far. A client's cursor is an offset into this. */
  cursor: number;
  /**
   * Whether a Stop would be honoured right now. See {@link MID_WRITE_PHASES}.
   *
   * ⚠ **It rides the view so the button can disappear rather than answer.** The
   * cancel route has one refusal and it is `404 install_not_found`, which for a
   * run that plainly exists is a false sentence — so the client is told the truth
   * before it presses, and the refusal is the backstop rather than the interface.
   * An older client that does not read this still gets the refusal, and a
   * misleading 404 is a far cheaper failure than a truncated harness binary.
   */
  cancellable: boolean;
}

export interface InstallChunk extends InstallRunView {
  /** Output since the requested cursor. Empty when there is nothing new. */
  chunk: string;
  /** True when the requested cursor pointed at output that has been discarded. */
  gap: boolean;
}

export type InstallStart =
  | { kind: "ok"; view: InstallRunView }
  /**
   * ⚠ **{@link ScriptHolder} itself, never a copy of its fields.** The same three
   * were written out inline here and again as the fallback below, while `server.ts`
   * ships this straight to the client as the `409 install_busy` detail — so a
   * field added to the gate's holder would have reached neither, and a structural
   * type still assigns, so nothing would have said so.
   */
  | { kind: "busy"; holder: ScriptHolder }
  | { kind: "spawn_failed"; detail: string };

/** One process, its transcript, and what it turned out to have done. */
class InstallRun {
  private buffer = "";
  /** How much has been discarded off the front. `dropped + buffer.length` is the cursor. */
  private droppedBytes = 0;
  /**
   * A trailing partial line per stream, held back so `readStep` never sees half of
   * one — and **one per stream** rather than one shared, which is
   * {@link InstallStream}'s whole reason.
   */
  private readonly carries: Record<InstallStream, string> = { stdout: "", stderr: "" };
  private exitRecord: { code: number | null; signal: string | null } | null = null;
  private phase_: InstallPhase | null = null;
  private outcome_: InstallOutcome = "running";
  private endedAt_: number | null = null;
  /** Set by {@link beginSettle}, before the first await of the settle that owns it. */
  private settling = false;

  readonly startedAt = Date.now();

  constructor(
    readonly installId: string,
    readonly agent: AgentId,
    private readonly kill: () => void,
  ) {}

  get done(): boolean {
    return this.endedAt_ !== null;
  }

  get outcome(): InstallOutcome {
    return this.outcome_;
  }

  /**
   * Whether a Stop would be signalled, rather than refused. See
   * {@link MID_WRITE_PHASES} for what the two refused phases are, and
   * {@link AgentInstallRuns.cancel} for why the refusal exists at all.
   */
  get cancellable(): boolean {
    if (this.done) return false;
    return this.phase_ === null || !MID_WRITE_PHASES.includes(this.phase_);
  }

  view(): InstallRunView {
    return {
      installId: this.installId,
      agent: this.agent,
      startedAt: this.startedAt,
      endedAt: this.endedAt_,
      done: this.done,
      outcome: this.outcome_,
      exit: this.exitRecord,
      phase: this.phase_,
      detail: this.buffer.trim().slice(-MAX_DETAIL_CHARS) || null,
      dropped: this.droppedBytes,
      cursor: this.droppedBytes + this.buffer.length,
      cancellable: this.cancellable,
    };
  }

  read(since: number): InstallChunk {
    return { ...this.view(), ...readFrom(this.buffer, this.droppedBytes, since) };
  }

  /**
   * Take output, keeping the newest {@link MAX_OUTPUT_BYTES}.
   *
   * ⚠ **The cap runs after every mutation, carry included** — `agentauth.ts`'s
   * measured rule, restated rather than shared because the two buffers have
   * nothing else in common (no pty, no escape sequences, no `scrub`). A cap
   * applied only to the appended chunk lets the buffer grow by the carry.
   */
  append(text: string, stream: InstallStream = "stdout"): void {
    const whole = this.carries[stream] + text;
    const lastBreak = whole.lastIndexOf("\n");
    // Whole lines go to the transcript; a partial one waits, or `readStep` sees
    // half of a checkpoint and answers `null` for a line that was about to parse.
    const complete = lastBreak === -1 ? "" : whole.slice(0, lastBreak + 1);
    this.carries[stream] = lastBreak === -1 ? whole : whole.slice(lastBreak + 1);
    if (complete.length === 0) return;
    for (const line of complete.split("\n")) {
      const step = readStep(line);
      // Only this harness's checkpoints: a `--only` run reports one agent, but a
      // caller passing several would otherwise have the phase jump between them.
      if (step !== null && step.agent === this.agent) this.phase_ = step.phase;
    }
    this.buffer += complete;
    this.cap();
  }

  /**
   * The one statement bounding the buffer, so that {@link append}'s rule holds
   * without being written twice. It was, identically, in both callers — and the
   * rule it states is the one that is cheaper to keep in a single place than to
   * keep in step.
   */
  private cap(): void {
    if (this.buffer.length <= MAX_OUTPUT_BYTES) return;
    const cut = this.buffer.length - MAX_OUTPUT_BYTES;
    this.buffer = this.buffer.slice(cut);
    this.droppedBytes += cut;
  }

  /**
   * Flush every held partial line, at the one moment nothing more is coming.
   *
   * Stdout first, then stderr, because a run whose last two writes are a `warn`
   * and a half-finished `note` reads better with the script's own stream order
   * than with whichever pipe happened to be flushed first.
   */
  private flushCarry(): void {
    for (const stream of ["stdout", "stderr"] as const) {
      if (this.carries[stream].length === 0) continue;
      this.buffer += this.carries[stream];
      this.carries[stream] = "";
    }
    this.cap();
  }

  end(exit: { code: number | null; signal: string | null }, outcome: InstallOutcome): void {
    if (this.endedAt_ !== null) return;
    this.flushCarry();
    this.exitRecord = exit;
    this.outcome_ = outcome;
    this.endedAt_ = Date.now();
  }

  /**
   * Claim this run for the one `settle` allowed to finish it.
   *
   * ⚠ **A terminal flag set *before* the first await, because `done` is set after
   * the last one.** On a spawn failure Node emits both `error` and `close`, so
   * `sink.close` is called twice and {@link AgentInstallRuns.settle} is entered
   * twice — and `if (run.done) return` excluded neither, since `end()` is reached
   * only after `await onFinished(...)`. Both entries got past the guard, both ran
   * the caller's invalidation, and both released the script gate: the second one
   * against a `kind` a *new* holder may have taken inside that window, which is
   * the cross-release `AgentScriptGate.release`'s own docblock warns about.
   */
  beginSettle(): boolean {
    if (this.settling || this.endedAt_ !== null) return false;
    this.settling = true;
    return true;
  }

  /**
   * Signal the script, and answer whether anything was signalled.
   *
   * ⚠ **`false` here is a refusal rather than a failure**, and the caller turns it
   * into one — see {@link AgentInstallRuns.cancel} and {@link cancellable}.
   */
  cancel(): boolean {
    if (this.done || !this.cancellable) return false;
    this.kill();
    return true;
  }

  expired(now: number): boolean {
    // ⚠ From `endedAt`, never `startedAt`: a running install is bounded by the
    // script's own deadline and must not be swept out from under itself.
    return this.endedAt_ !== null && now - this.endedAt_ > INSTALL_RETAIN_MS;
  }
}

export interface AgentInstallOptions {
  gate: AgentScriptGate;
  /**
   * Whether this harness's CLI resolves *now*.
   *
   * ⚠ **Called after {@link onFinished}'s invalidation and never before**, or it
   * reads the miss `findOnPath` cached when the tile was drawn — misses live 30 s —
   * and reports a successful install as a failure.
   */
  verify: (agent: AgentId) => Promise<boolean>;
  /**
   * Everything that has to forget what it knew about this harness, in order.
   *
   * Injected rather than reached for, because the things that need clearing sit
   * on three different objects and `AgentAskRuns.forget` is not on the interface
   * `server.ts` holds. `scripts/daemon.ts` wires it, where all three are in scope.
   */
  onFinished: (agent: AgentId) => Promise<void> | void;
  onWarning: (detail: string) => void;
  /** Where the harnesses come from, passed through to the script. */
  source?: "vendor" | "npm";
  channel?: "stable" | "latest";
  /** Injected for the drivers. The real one spawns `deploy/agents.sh`. */
  spawnScript?: (agent: AgentId, args: readonly string[], run: InstallSink) => { kill: () => void };
}

/** What a spawned script reports back into a run. */
export interface InstallSink {
  /** `stream` defaults to stdout, which is where every line with a grammar arrives. */
  append: (text: string, stream?: InstallStream) => void;
  close: (exit: { code: number | null; signal: string | null }, outcome: InstallOutcome) => void;
}

export class AgentInstallRuns {
  /** One at a time, daemon-wide. See the file docblock. */
  private current: InstallRun | null = null;
  private readonly sweepTimer: NodeJS.Timeout;
  private stopped = false;

  constructor(private readonly options: AgentInstallOptions) {
    this.sweepTimer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    // A person who closed the tab produces no traffic, so the sweep may not be
    // driven by one — and it must not hold the process open either.
    this.sweepTimer.unref();
  }

  start(agent: AgentId): InstallStart {
    if (this.stopped) return { kind: "spawn_failed", detail: "this daemon is shutting down" };
    this.sweep();
    /*
     * ⚠ **A finished record is replaced; a running one refuses.** There is no
     * process behind the first, so nothing is interrupted — and refusing there
     * would leave somebody staring at a ten-minute-old failure with no way to try
     * again.
     */
    if (this.current !== null && !this.current.done) {
      return { kind: "busy", holder: { kind: "install", agent: this.current.agent, since: this.current.startedAt } };
    }
    if (!this.options.gate.tryHold("install", agent)) {
      const holder = this.options.gate.holder;
      return {
        kind: "busy",
        holder: holder ?? { kind: "update", agent: null, since: Date.now() },
      };
    }
    const installId = `in_${randomBytes(6).toString("hex")}`;
    const args = ["--only", agent, "--fail-if-locked"];
    if (this.options.source === "npm") args.push("--source", "npm");
    args.push("--channel", this.options.channel ?? "latest");

    let run: InstallRun | null = null;
    const sink: InstallSink = {
      append: (text, stream) => run?.append(text, stream),
      close: (exit, outcome) => {
        if (run === null) return;
        void this.settle(run, exit, outcome);
      },
    };
    let handle: { kill: () => void };
    try {
      handle = (this.options.spawnScript ?? spawnAgentsScript)(agent, args, sink);
    } catch (error) {
      this.options.gate.release("install");
      return { kind: "spawn_failed", detail: error instanceof Error ? error.message : String(error) };
    }
    run = new InstallRun(installId, agent, handle.kill);
    this.current = run;
    return { kind: "ok", view: run.view() };
  }

  /**
   * What a finished run turns out to have done, and the order it is decided in.
   *
   * ⚠ **Invalidate, then ask.** `findOnPath` caches hits for ever and misses for
   * 30 s, so asking first reads the miss recorded when the tile was drawn and
   * calls a successful install a failure. A set-shaped assertion passes on the one
   * ordering that is wrong, which is why `daemoncheck` drives this as a sequence.
   *
   * ⚠ **And it happens here rather than in the poll route.** A login with nobody
   * polling changed nothing on disk; an install with nobody polling changed the
   * binaries, and a closed tab must not leave this daemon launching a CLI it
   * believes is absent.
   *
   * ⚠ **Entered at most once, and `run.done` was not what held that.** The guard
   * was `if (run.done) return`, and `done` is set by `run.end()` *below* the
   * `await` — so the two `sink.close` calls Node makes on a spawn failure both got
   * past it, both ran {@link AgentInstallOptions.onFinished} (three cache drops
   * and a resume pass, in `scripts/daemon.ts`), and both released the script gate.
   * {@link InstallRun.beginSettle} latches synchronously instead, which is where
   * the whole argument for it lives.
   */
  private async settle(
    run: InstallRun,
    exit: { code: number | null; signal: string | null },
    outcome: InstallOutcome,
  ): Promise<void> {
    if (!run.beginSettle()) return;
    try {
      await this.options.onFinished(run.agent);
    } catch (error) {
      this.options.onWarning(
        `install ${run.installId} (${run.agent}): could not refresh what this machine knows: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
    let settled = outcome;
    if (outcome === "running") {
      /*
       * The script ended and said nothing conclusive, which is its ordinary case:
       * it exits 0 whether or not the vendor answered. So the machine is asked.
       */
      let present = false;
      try {
        present = await this.options.verify(run.agent);
      } catch {
        // A probe that threw is not evidence the install failed; but it is not
        // evidence it worked either, and `failed` is the arm that offers a retry.
        present = false;
      }
      settled = present ? "installed" : "failed";
    }
    run.end(exit, settled);
    this.options.gate.release("install");
  }

  read(installId: string, since: number): InstallChunk | null {
    const run = this.current;
    if (run === null || run.installId !== installId) return null;
    return run.read(Math.max(0, since));
  }

  /** The run this daemon is holding, for a client that has no id of its own. */
  live(): InstallRunView | null {
    this.sweep();
    return this.current?.view() ?? null;
  }

  /**
   * Stop a run on demand — and only while stopping it is safe.
   *
   * ⚠ **Refused once the checkpoint announcing a write outside `$TMP` has been
   * parsed** — the phase rather than the write itself, and the file docblock has
   * the one-line window that difference leaves. It is the guarantee that docblock
   * and {@link shutdown} both claim and this method used to break: it SIGKILLs the
   * whole process group, and three of the five harnesses arrive by a vendor
   * installer that writes into `~/.local/bin` with no staging, at a path
   * `MANAGED_CLI_DIRS` then hands to the spawn. The refused window is
   * {@link MID_WRITE_PHASES}; {@link InstallRunView.cancellable}
   * is the same answer on the wire, so a client can withdraw the button rather
   * than discover the refusal.
   *
   * ⚠ **{@link RUN_TIMEOUT_MS} is deliberately not held to this**, and the
   * asymmetry is the point: a run that has hung for the whole 20-minute budget is
   * not going to complete that write either, and `deploy/agents.sh`'s own lock
   * comment is written for exactly that kill — *the daemon's deadline is a
   * `SIGKILL` to the whole group, which runs no trap* — so the next run takes the
   * lock over rather than waiting on a pid that has gone.
   *
   * `false` for an id nothing is holding and `false` for a refusal are the same
   * answer to `server.ts`, which is the one wart here and is why the view carries
   * the bit.
   */
  cancel(installId: string): boolean {
    const run = this.current;
    if (run === null || run.installId !== installId) return false;
    return run.cancel();
  }

  private sweep(now = Date.now()): void {
    if (this.current !== null && this.current.expired(now)) this.current = null;
  }

  /**
   * Stop sweeping and refuse new runs.
   *
   * ⚠ **A run in flight is deliberately not killed**, which is `AgentUpdates`'
   * argument verbatim: it writes outside this repository, into the vendors' own
   * directories, and a SIGKILL partway through an `npm i -g` leaves a tree the
   * next run has to repair. The daemon is going away; the install is not its to
   * abandon halfway.
   */
  shutdown(): void {
    this.stopped = true;
    clearInterval(this.sweepTimer);
  }
}

/**
 * The real spawn: `deploy/agents.sh`, detached, under {@link updateEnv}.
 *
 * ⚠ **Streamed rather than buffered to completion**, which is the one thing
 * `runScript` in `agentupdate.ts` does differently — that one has nobody watching
 * and only needs the tail. The deadline kills the **process group**, for its
 * reason: what is under this is `bash` running a vendor's installer with `npm`
 * under that, and signalling the direct child alone orphans the rest.
 */
function spawnAgentsScript(
  _agent: AgentId,
  args: readonly string[],
  sink: InstallSink,
): { kill: () => void } {
  const script = join(PACKAGE_ROOT, "deploy", "agents.sh");
  const child = spawn(script, [...args], {
    env: updateEnv(),
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  let timedOut = false;
  let stopped = false;
  /**
   * ⚠ **One `sink.close` per spawn, latched here and again behind the sink.**
   * Node emits **both** `error` and `close` for a spawn that failed, so this
   * closed the sink twice, and what is behind the sink is an `async settle` whose
   * own guard was not set until after an await —
   * {@link InstallRun.beginSettle} is that other half and carries the argument.
   * Both, because only one of them is reachable from a driver: nothing may drive
   * *this* function, which spawns `deploy/agents.sh` for real as this uid.
   */
  let closed = false;
  const killGroup = (): void => {
    /*
     * ⚠ **Never signal a pid that has already gone.** `-pid` names a process
     * *group*, and between the child being reaped and `close` reaching the event
     * loop the run is still not `done` — so a cancel landing in that window sent
     * a SIGKILL to a group id the kernel may have handed to something else.
     * `exitCode`/`signalCode` are set synchronously at the reap, which narrows it
     * further than the latch alone does.
     */
    if (closed || child.exitCode !== null || child.signalCode !== null) return;
    try {
      if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
    } catch {
      // Already gone; `close` is on its way.
    }
  };
  const deadline = setTimeout(() => {
    timedOut = true;
    killGroup();
  }, RUN_TIMEOUT_MS);
  deadline.unref();
  const finish = (
    exit: { code: number | null; signal: string | null },
    outcome: InstallOutcome,
  ): void => {
    if (closed) return;
    closed = true;
    clearTimeout(deadline);
    sink.close(exit, outcome);
  };
  // `agentauth.ts`'s idiom, and for its reason: a multi-byte sequence split
  // across two chunks becomes a permanent U+FFFD without a decoder.
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  // ⚠ Named, not merged: the two pipes frame their own lines. See {@link InstallStream}.
  child.stdout.on("data", (chunk: string) => sink.append(chunk, "stdout"));
  child.stderr.on("data", (chunk: string) => sink.append(chunk, "stderr"));
  child.on("error", (error) => {
    sink.append(`${error.message}\n`, "stderr");
    finish({ code: null, signal: null }, "spawn_failed");
  });
  child.on("close", (code, signal) => {
    /*
     * ⚠ **`3` is the one status this script carries a meaning in**, and it exists
     * because every other outcome is `exit 0` — see `--fail-if-locked`. Everything
     * else answers `running`, which is `settle`'s signal to go and ask the machine
     * rather than read a code.
     */
    const outcome: InstallOutcome = timedOut
      ? "timeout"
      : stopped
        ? "cancelled"
        : code === 3
          ? "locked"
          : "running";
    finish({ code, signal }, outcome);
  });
  return {
    kill: () => {
      stopped = true;
      clearTimeout(deadline);
      killGroup();
    },
  };
}
