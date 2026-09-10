import { join } from "node:path";
import { PassThrough } from "node:stream";
import { AgentUnavailableError, type AgentId, type AgentLaunchConfig } from "../src/acp/agents.js";
import { AgentLoginRuns } from "../src/agentauth.js";
import {
  MemoryEventStore,
  type ExitReason,
  type PersistedSession,
  type SessionExit,
  type SessionStore,
} from "../src/events.js";
import { SessionRegistry, autoResumable, resumeBackoffMs, MAX_IDLE_RELEASE_MINUTES, SessionLimitError } from "../src/registry.js";
import { IdleParking } from "../src/idlepark.js";
import { LocalRuntime } from "../src/runtime/local.js";
import type { AgentProcess } from "../src/runtime/types.js";
import { createApp } from "../src/server.js";
import { check, report } from "./daemoncheck.env.js";
import {
  users,
  now,
  tokenFor,
  verifier,
  storeOf,
  rowFor,
  credentials,
  stubAgentConfig,
} from "./daemoncheck.fixtures.js";

/*
 * Which sessions come back by themselves, and how a status is derived.
 *
 * Pure and offline: this is the rule the whole feature turns on — "a session is
 * stopped only if a human stopped it" — and the two ways to get it wrong are
 * both silent. Widen it and a session somebody deliberately killed is handed a
 * fresh agent on the next deploy; narrow it and a conversation quietly does not
 * come back, which nobody notices until they go looking for it.
 */
process.stdout.write("\nwhich sessions the daemon brings back\n");
{
  const exitOf = (reason: ExitReason): SessionExit => ({
    reason,
    at: now,
    detail: null,
    agentHandle: null,
    agentConfirmedDead: true,
  });
  const boot = (reason: ExitReason): boolean => autoResumable(exitOf(reason), "a_1", "boot");
  const typed = (reason: ExitReason): boolean => autoResumable(exitOf(reason), "a_1", "prompt");

  // The whole table, both triggers. Exhaustiveness needs no assertion here — the
  // `switch` has no `default` arm, so a new `ExitReason` is a compile error.
  check("a graceful restart comes back at boot", boot("daemon_shutdown"), true);
  check("and so does a crash", boot("daemon_restarted"), true);
  /*
   * ⚠ **Stopped: never at boot, and now yes on a prompt.** The `false` on both
   * triggers was how the daemon avoided overruling a person — and a prompt is not
   * the daemon deciding anything, it is that person typing into the conversation.
   * What forced it is the composer becoming unconditional: a box that answers
   * `409 session_terminal` is worse than no box.
   */
  check("a session somebody stopped never comes back on its own", boot("stopped"), false);
  check("but typing into it starts it again", typed("stopped"), true);
  check("nor does one that never started", [boot("start_failed"), boot("start_timeout")], [false, false]);
  /*
   * `agent_kill_failed` is legacy and stays out, and this line is the guard
   * against somebody "fixing" it: it used to *replace* the caller's reason
   * whenever a kill went unconfirmed, so a row carrying it may be a user's Stop
   * wearing a different word — and `agentConfirmedDead: false` means the old
   * agent may still be holding the conversation file.
   */
  check("nor an ambiguous legacy kill", [boot("agent_kill_failed"), typed("agent_kill_failed")], [false, false]);
  /*
   * The one asymmetry, and the reason it exists: an agent that quit on its own
   * under a daemon that never went anywhere was not ended *by* the daemon. The
   * boot pass has no recency fence, so resuming it would hand a fresh process to
   * a conversation whose owner watched it die three days ago. A prompt is
   * somebody explicitly asking, and "it crashed, let me carry on" should work.
   */
  check("an agent that quit on its own waits to be asked", [boot("agent_exited"), typed("agent_exited")], [false, true]);
  /*
   * ⚠ **The second asymmetry, and it is a reversal.** `agent_signed_out` answered
   * `false` on both triggers, and that made the state unreachable from inside the
   * app: `reloadCredentials` is the only other reversal and every one of its
   * callers is an in-app credential write, so a CLI that refreshed its own token —
   * or somebody signing in from their own terminal — was left with a conversation
   * nothing could bring back, under a notice claiming they were signed out.
   *
   * It follows `agent_exited`'s split for `agent_exited`'s reason. A prompt is a
   * person asking for *this* conversation now, and by then the credential
   * situation may be anything at all; a boot pass is nobody asking, and starting
   * an agent that cannot authenticate at 4am is how a fleet spends a morning on
   * it. What a revoked credential now costs is one error row per message somebody
   * chooses to send — see `onAuthFailure`, which no longer ends anything.
   */
  check("a signed-out conversation waits to be asked too", [boot("agent_signed_out"), typed("agent_signed_out")], [false, true]);
  // No conversation to return to means nothing to return to it with, whatever
  /*
   * ⚠ **Parked splits the other way from everything above it: `false` at boot is
   * the load-bearing half.**
   *
   * Every other reversal in this table is about a prompt being allowed to revive
   * something. Here the prompt half is obvious — it is the *only* way back, since
   * no client draws a Resume control for a parked session — and the boot half is
   * the one that matters: a boot pass that un-parked everything would hand back
   * all the memory parking released, at the worst possible moment, all at once.
   * Both are pinned so neither can be "simplified" into the `daemon_shutdown` row.
   */
  check("a released agent is not brought back by a boot pass", boot("parked"), false);
  check("and comes back when somebody types", typed("parked"), true);

  // the reason says.
  check(
    "and nothing resumes without an agent session id",
    (["daemon_shutdown", "daemon_restarted", "agent_exited"] as ExitReason[]).map((reason) =>
      autoResumable(exitOf(reason), null, "prompt"),
    ),
    [false, false, false],
  );

  const statusOf = (reason: ExitReason): string => {
    const store = storeOf([
      { ...rowFor(`s_${reason}`, join(users, "u_alice", "proj")), exit: exitOf(reason), agentSessionId: "a_1" },
    ]);
    const own = new SessionRegistry(new MemoryEventStore(), store);
    own.restore({ reapOrphans: false });
    return own.get(`s_${reason}`)?.status ?? "missing";
  };

  /*
   * `daemon_shutdown` derives `interrupted`, and that is the correction this
   * whole change rests on. It used to derive `exited` — the *same value* as a
   * user's Stop — so the ordinary deploy, much the commonest way a session is
   * interrupted, was indistinguishable from somebody ending it on purpose, while
   * `interrupted` was reachable only through the hard-kill path.
   *
   * Both are pinned, so a future edit cannot swap them and stay green.
   */
  check("a graceful shutdown reads as interrupted", statusOf("daemon_shutdown"), "interrupted");
  check("and so does a crash", statusOf("daemon_restarted"), "interrupted");
  check("a stop reads as exited", statusOf("stopped"), "exited");
  check("an agent quitting reads as exited", statusOf("agent_exited"), "exited");
  check("a failed start reads as failed", [statusOf("start_failed"), statusOf("start_timeout")], ["failed", "failed"]);
  /*
   * ⚠ **The pin this whole feature turns on, and the only thing standing between
   * a parked session and the word "exited".**
   *
   * `ManagedSession.status` reads `endedWithDaemon` first and then falls through
   * a `switch` whose `default:` answers `exited`. `parked` is deliberately not a
   * daemon exit reason — the boot pass must not un-park anything — so without its
   * own arm it lands in that `default` and every quiet conversation on the machine
   * reports the same value as one somebody pressed Stop on. It compiles clean:
   * unlike `autoResumable` one section up, this switch has a default, so the
   * compiler has nothing to say. Asserted against `exited` explicitly as well as
   * for `parked`, because the failure is a *collapse* of two states into one and
   * an equality alone would still pass if `exited` were what both returned.
   */
  check("a released agent reads as parked", statusOf("parked"), "parked");
  check("and not as exited, which is what nobody deciding looks like", statusOf("parked") === statusOf("stopped"), false);

  // Full jitter — drawn from `[0, capped)` — and not the ±20% band the relay
  // uses. A boot pass retries N sessions whose attempts began together, so a
  // narrow band keeps them synchronised and they collide again every round.
  check("no jitter means no wait at all", [1, 2, 5].map((n) => resumeBackoffMs(n, () => 0)), [0, 0, 0]);
  check(
    "and the ceiling grows then clamps",
    [1, 2, 3, 4, 5, 6, 9].map((n) => resumeBackoffMs(n, () => 0.999999)),
    [1999, 3999, 7999, 15999, 31999, 59999, 59999],
  );
}

/*
 * The boot pass, against a fake agent that really answers `session/resume`.
 *
 * The assertion that carries this section is not "the status changed" — it is
 * that the agent was sent `session/resume` with the id and cwd it was supposed
 * to get. A resume that silently sent `session/new` would leave the session
 * `idle` with a fresh, empty conversation, which is indistinguishable from
 * success at every level above this one and is the exact failure the whole
 * feature exists to avoid.
 */
process.stdout.write("\nputting agents back on interrupted sessions\n");
{
  const acp = await import("@agentclientprotocol/sdk");

  interface Rig {
    runtime: LocalRuntime;
    launches: () => number;
    resumes: () => { sessionId: string; cwd: string; mcpServers: unknown }[];
    fileIoAtResume: () => boolean[];
    peak: () => number;
    /**
     * How many of this rig's agents have been shut down.
     *
     * `endStdin` rather than `kill`, because that is the first rung of
     * `AcpClient.doClose`'s ladder and this stub's `waitForExit` answers `true`,
     * so a signal is never reached — which is what makes the count readable at
     * all. It exists for one case: an agent that is *never* disposed is an
     * orphan, and an orphan is invisible from every other observable this rig
     * has.
     */
    disposed: () => number;
    /** What `session/set_config_option` was actually asked for, in order. */
    configSets: () => { id: string; value: unknown }[];
  }

  /**
   * A runtime whose agent is a pair of pipes, made fresh per launch.
   *
   * Fresh per launch because a `PassThrough` that has been ended is spent — the
   * older cases in this file work around it by declaring a second fake agent by
   * hand, which does not scale to a pass that starts one per session.
   */
  const rigWith = (options: {
    resume: boolean;
    failResume?: boolean;
    /** Answer `session/resume` with JSON-RPC -32002, as claude does for a lost conversation. */
    forgotten?: boolean;
    /**
     * Refuse `session/resume` with -32603 *only* while the client declares the
     * file-IO capability — kimi 0.29.2's behaviour for a session left in plan
     * mode, measured 2026-08-05.
     */
    hatesFileIo?: boolean;
    stallMs?: number;
    /**
     * Take a prompt and never answer it, so the turn stays open.
     *
     * The one state the parking rules exist to protect: an agent working is an
     * agent that must not notice the client left. Nothing else in this file needs
     * a turn that outlives the call that started it, which is why the option is
     * here rather than in the shared fixtures.
     */
    stallPrompt?: boolean;
    /**
     * Publish one `select` option from `session/new` and `session/resume`, and
     * accept `session/set_config_option` on it.
     *
     * The only rig here that answers *anything* about configuration, because it is
     * the only section that needs to: parking keeps a session's controls live and
     * defers the tap, so both halves — what a released session still offers, and
     * what a returning agent is sent — are unobservable without an agent that has
     * an option to offer in the first place.
     */
    config?: boolean;
  }): Rig => {
    let launched = 0;
    let opened = 0;
    let live = 0;
    let peak = 0;
    let ended = 0;
    let declaredFileIo = false;
    const fileIoAtResume: boolean[] = [];
    const resumes: { sessionId: string; cwd: string; mcpServers: unknown }[] = [];
    const configSets: { id: string; value: unknown }[] = [];
    /*
     * ACP's wire shape — `type`/`currentValue`/`options` — and **not** this
     * daemon's own `kind`/`value`/`choices`. Written the internal way first, which
     * is why this comment exists: `toConfigOptions` reads `option.type`, so the
     * parsed option had `kind: undefined` and no choices, both validation guards
     * were skipped, and a model no agent offers was accepted and then sent. The
     * driver caught it; nothing else would have.
     */
    const modelOption = {
      id: "model",
      name: "Model",
      description: null,
      category: "model",
      type: "select",
      currentValue: "opus",
      options: [
        { value: "opus", name: "Opus" },
        { value: "sonnet", name: "Sonnet" },
      ],
    };
    const withValue = (value: unknown) => ({ ...modelOption, currentValue: value });

    class ResumeRig extends LocalRuntime {
      override describe(agent: AgentId): AgentLaunchConfig {
        return stubAgentConfig(agent);
      }

      override async launch(): Promise<AgentProcess> {
        launched += 1;
        const toAgent = new PassThrough();
        const toClient = new PassThrough();
        const send = (message: unknown): void => {
          toClient.write(`${JSON.stringify(message)}\n`);
        };
        let buffer = "";
        toAgent.on("data", (chunk: Buffer) => {
          buffer += chunk.toString("utf8");
          for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
            const line = buffer.slice(0, nl);
            buffer = buffer.slice(nl + 1);
            if (line.trim().length === 0) continue;
            const message = JSON.parse(line) as Record<string, any>;
            const id = message["id"];
            switch (message["method"]) {
              case acp.methods.agent.initialize:
                declaredFileIo =
                  (message["params"] as any)?.clientCapabilities?.fs?.readTextFile === true;
                send({
                  jsonrpc: "2.0",
                  id,
                  result: {
                    protocolVersion: acp.PROTOCOL_VERSION,
                    // The capability is a marker object, exactly as both real
                    // adapters send it — `supportsSessionResume` reads `!= null`
                    // rather than `=== true` for that reason.
                    agentCapabilities: options.resume ? { sessionCapabilities: { resume: {} } } : {},
                    authMethods: [],
                  },
                });
                break;
              // Needed by the recovery path — a cleared conversation the agent
              // never wrote down is replaced with a fresh one, and that goes
              // through `session/new` rather than `session/resume`.
              case acp.methods.agent.session.new:
                opened += 1;
                send({
                  jsonrpc: "2.0",
                  id,
                  result: {
                    sessionId: `conv_${opened}`,
                    ...(options.config === true ? { configOptions: [modelOption] } : {}),
                  },
                });
                break;
              case acp.methods.agent.session.setConfigOption: {
                const params = message["params"] as Record<string, any>;
                configSets.push({ id: String(params["configId"]), value: params["value"] });
                // Answered with the whole list, the way both adapters do, so the
                // daemon's own listener folds the new value in rather than the
                // driver asserting against a state nothing published.
                send({
                  jsonrpc: "2.0",
                  id,
                  result: { configOptions: [withValue(params["value"])] },
                });
                break;
              }
              case acp.methods.agent.session.resume: {
                const params = message["params"] as Record<string, any>;
                fileIoAtResume.push(declaredFileIo);
                resumes.push({
                  sessionId: String(params["sessionId"]),
                  cwd: String(params["cwd"]),
                  mcpServers: params["mcpServers"],
                });
                live += 1;
                peak = Math.max(peak, live);
                // A real handshake is not instantaneous, and without a gap here
                // every resume would complete before the next began — which
                // would make the concurrency bound below unfalsifiable.
                setTimeout(() => {
                  live -= 1;
                  if (options.hatesFileIo === true && declaredFileIo) {
                    send({ jsonrpc: "2.0", id, error: { code: -32603, message: "Internal error" } });
                  } else if (options.forgotten === true) {
                    // Byte-for-byte what `RequestError.resourceNotFound` produces.
                    send({
                      jsonrpc: "2.0",
                      id,
                      error: { code: -32002, message: `Resource not found: ${String(params["sessionId"])}` },
                    });
                  } else if (options.failResume === true) {
                    send({ jsonrpc: "2.0", id, error: { code: -32000, message: "no such conversation" } });
                  } else {
                    send({
                      jsonrpc: "2.0",
                      id,
                      result: options.config === true ? { configOptions: [modelOption] } : {},
                    });
                  }
                }, options.stallMs ?? 15);
                break;
              }
              case acp.methods.agent.session.prompt:
                if (options.stallPrompt === true) break;
                send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
                break;
              default:
                if (id !== undefined) send({ jsonrpc: "2.0", id, result: {} });
            }
          }
        });
        return {
          stdin: toAgent,
          stdout: toClient,
          stderr: new PassThrough(),
          handle: null,
          onceStartError: () => () => {},
          onceExit: () => () => {},
          hasExited: false,
          waitForExit: async () => true,
          endStdin: () => {
            ended += 1;
            toAgent.end();
          },
          kill: async () => {},
        } as unknown as AgentProcess;
      }
    }

    return {
      runtime: new ResumeRig(),
      launches: () => launched,
      resumes: () => resumes,
      fileIoAtResume: () => fileIoAtResume,
      peak: () => peak,
      disposed: () => ended,
      configSets: () => configSets,
    };
  };

  const interruptedRow = (id: string, reason: ExitReason, agentSessionId: string | null, create = true) => {
    const root = join(users, "u_alice", `wt_${id}`);
    const row = create
      ? rowFor(id, root)
      : { ...rowFor(id, join(users, "u_alice", "proj")), workspace: { ...rowFor(id, join(users, "u_alice", "proj")).workspace, root: join(users, "u_alice", "gone_forever"), requestedCwd: join(users, "u_alice", "gone_forever") } };
    return {
      ...row,
      agentSessionId,
      // One turn, because that is what a session with a conversation *has*.
      // Zero would say the agent never ran anything, which is now a fact the
      // resume path reads: an untouched conversation has no transcript on disk,
      // so it is opened fresh rather than resumed. A fixture claiming both an
      // agent session id and no turns describes a session that cannot exist.
      turnCounter: 1,
      exit: { reason, at: now, detail: null, agentHandle: null, agentConfirmedDead: true },
    };
  };

  // No wall clock anywhere in the pass: `random` pins the jitter and `delay`
  // makes the backoff free, so these run at the speed of the pipes.
  const options = { random: () => 0, delay: async (): Promise<void> => {} };

  {
    const rig = rigWith({ resume: true });
    const store = storeOf([
      // Three turns already spent, so "numbering continues" below is a claim
      // with something to be wrong about.
      { ...interruptedRow("s_back", "daemon_restarted", "a_back"), turnCounter: 3 },
      interruptedRow("s_stopped", "stopped", "a_stopped"),
      interruptedRow("s_noid", "daemon_shutdown", null),
    ]);
    const own = new SessionRegistry(new MemoryEventStore(), store, undefined, rig.runtime);
    own.restore({ reapOrphans: false });
    const report = await own.autoResume({ ...options, concurrency: 1 });

    const back = own.get("s_back");
    check("an interrupted session comes back idle", back?.status, "idle");
    check("with its exit cleared", back?.exit, null);
    check("and the agent's own id untouched", back?.agentSessionId, "a_back");
    check("a stopped one is left alone", own.get("s_stopped")?.status, "exited");
    check("and one with nothing to reattach to is not even considered", own.get("s_noid")?.status, "interrupted");
    check("the report counts what it did", [report.considered, report.resumed], [1, 0 + 1]);

    /*
     * The load-bearing assertion of this whole file's new section. `session/new`
     * would leave the session `idle` too, with an empty conversation and no way
     * to tell from the outside.
     */
    check("the agent was actually asked to resume", rig.resumes().length, 1);
    check(
      "with the id and cwd it was supposed to get",
      rig.resumes()[0],
      { sessionId: "a_back", cwd: back?.cwd, mcpServers: [] },
    );

    /*
     * Turn numbering continues from the persisted counter rather than starting
     * again. A resume that reset it would make "turn 4" mean the fourth turn
     * since the last crash instead of the fourth of the conversation — which is
     * wrong in a way nobody would notice until they were reading a transcript
     * trying to work out what happened.
     */
    const promptResult = back?.prompt("hello");
    check(
      "a prompt after a resume continues the turn count",
      promptResult?.kind === "accepted" ? promptResult.turn : promptResult?.kind,
      4,
    );
    await own.shutdown();
  }

  /*
   * **A harness with no CLI on the machine costs no attempt and is not given up
   * on.** Measured 2026-09-04 on the dev stand, the first deploy after the
   * vendored CLIs went (Q4.114): the stand's own deploy path restarts the daemon
   * without running `deploy/agents.sh` first, so three opencode sessions met
   * `opencode not found on this daemon's PATH` three times each and were marked
   * `attempts_exhausted` — a verdict for the daemon's life — while the updater
   * installed opencode five minutes later and nothing re-drove them. An attempt
   * is for a failure a retry might not repeat; a verdict is for a fact a retry
   * cannot change; a missing binary repeats exactly until the install lands and
   * then does not. So it is `agent_missing`: the reason goes on the snapshot as
   * `waiting` with no attempt spent, the session stays in every later pass's
   * queue, and the pass the daemon starts after the update brings it back.
   */
  {
    const rig = rigWith({ resume: true });
    const store = storeOf([interruptedRow("s_nocli", "daemon_restarted", "a_nocli")]);
    const own = new SessionRegistry(new MemoryEventStore(), store, undefined, rig.runtime);
    own.restore({ reapOrphans: false });
    const describe = rig.runtime.describe.bind(rig.runtime);
    let installed = false;
    // `describe` is what `resolveAgent` reaches through, and a missing CLI is a
    // refusal there — before any spawn — so this is the shape the real refusal
    // takes, with its real class and its real sentence.
    rig.runtime.describe = (agent: AgentId): AgentLaunchConfig => {
      if (!installed) {
        throw new AgentUnavailableError("opencode not found on this daemon's PATH. deploy/agents.sh installs it (or `curl -fsSL https://opencode.ai/install | bash`).", {
          installable: true,
        });
      }
      return describe(agent);
    };
    const outcomes: string[] = [];
    const first = await own.autoResume({ ...options, concurrency: 1, onOutcome: (one) => void outcomes.push(`${one.result}:${one.attempt}`) });
    const waiting = own.get("s_nocli");
    check("a harness with no CLI is reported as missing, once, with no attempt spent", outcomes, ["agent_missing:0"]);
    check("and counted as deferred rather than failed", [first.considered, first.deferred, first.failed, first.resumed], [1, 1, 0, 0]);
    check("the session is still interrupted", waiting?.status, "interrupted");
    check("not given up on", waiting?.resumeAbandoned, null);
    check("and its snapshot says it is waiting, and why, with no attempt on it", [waiting?.snapshot().resume?.state, waiting?.snapshot().resume?.attempts, waiting?.snapshot().resume?.error?.code], ["waiting", 0, "agent_unavailable"]);
    check("without an error event in its log", waiting?.snapshot().lastSeq, own.get("s_nocli")?.snapshot().lastSeq);
    check("and nothing was spawned to find that out", rig.launches(), 0);
    // The install lands, and the pass the daemon starts afterwards picks it up.
    installed = true;
    const second = await own.autoResume({ ...options, concurrency: 1, onOutcome: (one) => void outcomes.push(`${one.result}:${one.attempt}`) });
    check("the pass after the install brings it back", [second.considered, second.resumed, own.get("s_nocli")?.status], [1, 1, "idle"]);
    check("on its first attempt, since the deferral spent none", outcomes.at(-1), "resumed:1");
    check("and the snapshot has forgotten the wait", own.get("s_nocli")?.snapshot().resume ?? null, null);
    await own.shutdown();
  }

  /*
   * ⚠ **Only the absence the installer repairs is deferred.** `AgentUnavailableError`
   * is also what a missing adapter package, an unknown plugin harness and a
   * contributed program that is gone throw, and none of those is something
   * `deploy/agents.sh` can put back. Deferred, such a session sat "reconnecting"
   * for the daemon's life — no attempt spent, nothing to settle it, and the
   * installer run for nothing on its account. So the plain class, with no
   * `installable`, spends attempts and settles to `attempts_exhausted` exactly as
   * it did before the installer existed, and the client's stalled sentence and
   * Reconnect button are what a person sees.
   */
  {
    const rig = rigWith({ resume: true });
    const store = storeOf([interruptedRow("s_noadapter", "daemon_restarted", "a_noadapter")]);
    const own = new SessionRegistry(new MemoryEventStore(), store, undefined, rig.runtime);
    own.restore({ reapOrphans: false });
    rig.runtime.describe = (): AgentLaunchConfig => {
      throw new AgentUnavailableError("claude-agent-acp not found on PATH; run `pnpm install` in the project root.");
    };
    const outcomes: string[] = [];
    const report = await own.autoResume({ ...options, concurrency: 1, onOutcome: (one) => void outcomes.push(one.result) });
    check("an absence the installer cannot repair spends the attempts as before", outcomes, ["failed", "failed", "attempts_exhausted"]);
    check("and is failed rather than deferred", [report.considered, report.deferred, report.failed], [1, 0, 1]);
    check("with the verdict on the snapshot", own.get("s_noadapter")?.snapshot().resume?.state, "failed");
    check("and nothing spawned to reach it", rig.launches(), 0);
    await own.shutdown();
  }

  /*
   * **Two passes over one registry run one after the other, never together.**
   * The pass after an agent update can start while the boot pass is still waiting
   * out a backoff, and two passes driving `resume()` on one session is a race
   * nothing below is built for. The second waits; what the first brought back is
   * not in its queue.
   */
  {
    const rig = rigWith({ resume: true, stallMs: 40 });
    const store = storeOf([interruptedRow("s_one", "daemon_restarted", "a_one"), interruptedRow("s_two", "daemon_restarted", "a_two")]);
    const own = new SessionRegistry(new MemoryEventStore(), store, undefined, rig.runtime);
    own.restore({ reapOrphans: false });
    const order: string[] = [];
    const a = own.autoResume({ ...options, concurrency: 1, onOutcome: (one) => void order.push(`a:${one.sessionId}`) });
    const b = own.autoResume({ ...options, concurrency: 1, onOutcome: (one) => void order.push(`b:${one.sessionId}`) });
    const [ra, rb] = await Promise.all([a, b]);
    check("the first pass resumes both", [ra.considered, ra.resumed], [2, 2]);
    check("and the second, queued behind it, finds nothing left to do", [rb.considered, rb.resumed], [0, 0]);
    check("in that order", order.every((one) => one.startsWith("a:")), true);
    check("with each agent asked to resume exactly once", rig.resumes().length, 2);
    await own.shutdown();
  }

  /*
   * What bounds session creation, which used to be nothing at all.
   *
   * `create()` resolved a cwd, ran a real `git worktree add` and spawned an
   * agent, once per request, unbounded. The only thing counting sessions was
   * `SqliteSessionStore.prune`, and that counts in order to **delete**: it kept
   * the newest `maxSessions` by creation and took every other transcript with it
   * at the next boot (it takes only inactive rows now and never leaves fewer than
   * `DEFAULT_MIN_SESSIONS`, but past the cap it is still a deletion — the
   * store-and-worktrees module drives that half). So a loop of `POST /sessions`
   * on a shared machine was a way to destroy
   * the owner's conversations, and `sqlite.ts`'s own comment beside the cap had
   * written the precondition down — "with one person there is nobody to take it
   * from" — which a grant makes false.
   *
   * Driven here rather than through the route because the rig is what makes a
   * *live* session reachable in an offline driver: `autoResume` clears the exit
   * record, which is exactly what `terminal` reads.
   */
  {
    const rig = rigWith({ resume: true });
    const store = storeOf([interruptedRow("s_live", "daemon_restarted", "a_live")]);
    const own = new SessionRegistry(new MemoryEventStore(), store, undefined, rig.runtime);
    own.restore({ reapOrphans: false });

    check("a restored session is not live until it is resumed", own.liveSessionCount, 0);
    await own.autoResume({ ...options, concurrency: 1 });
    check("and is live once an agent is back in front of it", own.liveSessionCount, 1);

    const refusal = async (cwd: string): Promise<string> =>
      own.create({ agent: "kimi", cwd }).then(
        () => "created",
        (error: unknown) => (error instanceof SessionLimitError ? error.reason : (error as Error).name),
      );

    /*
     * **The ordering is the assertion.** The cwd below does not exist, so
     * `resolveCwd` would throw `PathError` — and it must never get the chance.
     * A refusal that reaches the filesystem first is one that spends a bounded
     * probe and a libuv threadpool slot per request, on the one path a caller can
     * aim at a stalled network mount.
     */
    const gone = join(users, "u_alice", "no_such_dir_at_all");
    own.setSessionLimits({ live: 1 });

    /*
     * ⚠ **At the ceiling with something idle, the slot is *taken* rather than the
     * request refused — and the old assertion here read `too_many_sessions`.**
     *
     * `s_live` is idle, so `create` releases its agent and proceeds; the request
     * then dies on the path, which is what says it got past the ceiling. That is
     * the whole change: the ceiling used to refuse on sight and tell a person to
     * *stop* a conversation — destructive, and their job — while the daemon was
     * holding an agent doing nothing that it could release losslessly. The
     * conversation is untouched, and the `parked` reason below is what says the
     * slot came from a release rather than from something ending.
     */
    check("at the ceiling, a create takes a quiet session's slot", await refusal(gone), "PathError");
    check("and takes it losslessly, without ending anything", [own.get("s_live")?.status, own.get("s_live")?.exit?.reason], ["parked", "parked"]);
    check("so the machine is still inside its ceiling", own.liveSessionCount, 0);

    /*
     * And the half that keeps the ceiling a ceiling: with nothing releasable it
     * still refuses, before it touches the filesystem.
     *
     * `s_busy` is resumed and then given a prompt this rig never answers, so its
     * status is `running` and `parkCandidates` cannot take it. **The ordering is
     * the assertion**: the cwd does not exist, so `resolveCwd` would throw
     * `PathError` and must never get the chance — a refusal that reaches the
     * filesystem first spends a bounded probe and a libuv threadpool slot per
     * request, on the one path a caller can aim at a stalled network mount.
     */
    const busyStore = storeOf([interruptedRow("s_busy_cap", "daemon_restarted", "a_busy_cap")]);
    const busyRig = rigWith({ resume: true, stallPrompt: true });
    const busy = new SessionRegistry(new MemoryEventStore(), busyStore, undefined, busyRig.runtime);
    busy.restore({ reapOrphans: false });
    await busy.autoResume({ ...options, concurrency: 1 });
    busy.get("s_busy_cap")?.prompt("keep working");
    busy.setSessionLimits({ live: 1 });
    check("the one live session is working", busy.get("s_busy_cap")?.status, "running");
    const refusedBusy = await busy
      .create({ agent: "kimi", cwd: gone })
      .then(() => "created", (error: unknown) => (error instanceof SessionLimitError ? error.reason : (error as Error).name));
    check("with nothing to take, the ceiling still refuses before it touches the path", refusedBusy, "too_many_sessions");
    check("and the working session was not touched", busy.get("s_busy_cap")?.status, "running");
    await busy.shutdown();

    /*
     * Raising it lets the same request through to the ordinary failure, which is
     * what says the guard above refused for the reason it claimed rather than
     * because everything here fails.
     */
    own.setSessionLimits({ live: 8 });
    check("and with room it reaches the path check as before", await refusal(gone), "PathError");

    /*
     * ⚠ **Releasing switched off must not become "cannot start anything".**
     *
     * `releaseOneSlot` weighed `effectiveIdleParkMs` *before* it asked whether
     * there was any room, so a machine with `REEMOAT_IDLE_PARK_MINUTES=0` — or
     * `idleReleaseMinutes: 0` saved from the settings screen — refused every
     * create at zero live sessions out of eight, under a sentence claiming every
     * one of them was busy. No case combined the off switch with a create, which
     * is the only reason it was not caught; both halves are pinned here now.
     */
    own.setSessionLimits({ live: 8, idleParkMs: 0 });
    check("a machine that never releases still starts sessions", await refusal(gone), "PathError");
    check("and says so about itself", own.idleParkEnabled, false);
    check("and its sweep really does release nothing", await own.parkIdleSessions(now + 365 * 24 * 60 * 60_000), []);

    /*
     * And the refusal the off switch *is* for: at the ceiling, with an idle agent
     * that could be taken, on a machine whose owner said never take one. That is
     * the eviction being declined rather than the room check being skipped.
     */
    await own.get("s_live")?.resume();
    check("with a quiet agent back in front of that conversation", own.get("s_live")?.status, "idle");
    own.setSessionLimits({ live: 1, idleParkMs: 0 });
    check("but at the ceiling it declines to take one anyway", await refusal(gone), "too_many_sessions");
    check("and the quiet session it would have taken is untouched", own.get("s_live")?.status, "idle");
    own.setSessionLimits({ live: 8, idleParkMs: 45 * 60_000 });

    /*
     * The other half, and it is needed: stopping a session makes it non-live, so
     * a create-and-stop loop walks straight past a ceiling while still writing
     * the rows the prune deletes. A refused create **does** spend a slot, which
     * is the deliberate trade — the alternative is doing the expensive part
     * before deciding whether to.
     */
    own.setSessionLimits({ burst: 2, refillMs: 600_000 });
    check("the first creation inside the burst is only refused by the path", await refusal(gone), "PathError");
    check("and so is the second", await refusal(gone), "PathError");
    check("the third is rate limited", await refusal(gone), "session_rate_limited");

    const waited = await own.create({ agent: "kimi", cwd: gone }).then(
      () => -1,
      (error: unknown) => (error instanceof SessionLimitError ? error.retryAfterSeconds : -1),
    );
    report("and says how long to wait", waited > 0 && waited <= 600, `retryAfterSeconds: ${waited}`);

    /*
     * The bucket refills by elapsed time rather than on a timer, so a short
     * refill is the whole of what a driver needs — no clock seam, no wall time
     * spent, and the arithmetic is the one that runs in production.
     */
    own.setSessionLimits({ burst: 1, refillMs: 1 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    check("a slot comes back on its own", await refusal(gone), "PathError");

    await own.shutdown();
  }

  /*
   * ⚠ **A boot pass may not evict, and it was doing exactly that.**
   *
   * `doResume` makes room before it starts, and the whole licence for that is
   * written about somebody typing: being told your own conversation is
   * unavailable is worse than briefly holding one agent over a soft ceiling. A
   * boot pass is this codebase's canonical case of *nobody* asking — the split
   * `autoResumable` already makes between `boot` and `prompt` — and it reached
   * the same call.
   *
   * The two orders are opposed, which is what turned it from waste into loss:
   * `autoResumePass` queues most-recently-active first, `parkCandidates` takes
   * least-recently-active. So each wake past the ceiling parked the session
   * before it, and the pass ended holding fewer conversations than it had
   * started — having spent a spawn, a `session/close` and a confirmed SIGKILL on
   * each one it threw away. `.env.example` promises the opposite in as many
   * words: a daemon coming back from a deploy restores the work it was holding.
   */
  {
    const rig = rigWith({ resume: true });
    const store = storeOf([
      interruptedRow("s_boot_a", "daemon_restarted", "a_boot_a"),
      interruptedRow("s_boot_b", "daemon_restarted", "a_boot_b"),
      interruptedRow("s_boot_c", "daemon_restarted", "a_boot_c"),
    ]);
    const own = new SessionRegistry(new MemoryEventStore(), store, undefined, rig.runtime);
    own.restore({ reapOrphans: false });
    // Below the three that are coming back, so every wake after the second is
    // one the old code would have made room for by parking an earlier one.
    own.setSessionLimits({ live: 2, idleParkMs: 45 * 60_000 });
    await own.autoResume({ ...options, concurrency: 1 });

    const reasons = ["s_boot_a", "s_boot_b", "s_boot_c"].map((id) => own.get(id)?.exit?.reason ?? "live");
    check("a restart parks nothing it just brought back", reasons, ["live", "live", "live"]);
    check("and holds every conversation, over the ceiling rather than under it", own.liveSessionCount, 3);

    /*
     * And the ceiling still means something for the act it is for: a *person*
     * asking for capacity. The same registry, one line later, takes a quiet
     * agent — which is what says the assertion above is about the trigger rather
     * than about eviction being broken.
     */
    const gone = join(users, "u_alice", "no_such_dir_at_all");
    const outcome = await own.create({ agent: "kimi", cwd: gone }).then(
      () => "created",
      (error: unknown) => (error instanceof SessionLimitError ? error.reason : (error as Error).name),
    );
    check("but somebody asking for a new one still frees a slot", outcome, "PathError");
    check("by taking the least recently used, which is the first one back", own.get("s_boot_a")?.exit?.reason, "parked");

    await own.shutdown();
  }

  /*
   * Letting go of an agent nobody is using, and every reason not to.
   *
   * **The measurements this exists for are in `IDLE_PARK_MS` and Q2.224** — a
   * resident agent is ~397 MB and comes back in ~1.3s — and none of that is
   * assertable here. What is assertable is the part that goes wrong silently: a
   * session released while somebody was mid-turn, a released session that reads
   * as stopped, and a released session the prune then deletes.
   *
   * Driven through the real registry rather than by calling `parkable` on a
   * hand-built object, because the whole precondition is `status === "idle"` and
   * `status` is *derived* — a fixture that sets it directly would be asserting
   * against the very thing under test.
   */
  {
    const rig = rigWith({ resume: true, stallPrompt: true });
    const store = storeOf([
      interruptedRow("s_quiet", "daemon_restarted", "a_quiet"),
      interruptedRow("s_busy", "daemon_restarted", "a_busy"),
    ]);
    const own = new SessionRegistry(new MemoryEventStore(), store, undefined, rig.runtime);
    own.restore({ reapOrphans: false });
    await own.autoResume({ ...options, concurrency: 1 });

    const quiet = own.get("s_quiet");
    const busy = own.get("s_busy");
    check("two conversations, two agents", [own.liveSessionCount, quiet?.status, busy?.status], [2, "idle", "idle"]);

    /*
     * Nothing is parked before the threshold, and this is asserted *first*
     * because it is what makes every "was parked" below mean something. A sweep
     * that took everything regardless of age would satisfy all of them.
     */
    check("a session that has just spoken is left alone", await own.parkIdleSessions(now), []);
    check("and it still has its agent", own.liveSessionCount, 2);

    /*
     * ⚠ **The one the whole feature is judged on: an agent mid-turn is not
     * touched.** `s_busy` has a prompt in flight that this rig never answers, so
     * `turn !== null`, so `status` is `running`, so `parkable` refuses — and the
     * agent never learns that anybody stopped watching. Written against a real
     * open turn rather than a mocked status, because a mock of `status` is a mock
     * of the predicate.
     */
    const sent = busy?.prompt("keep working");
    check("the busy one is working", [sent?.kind, busy?.status], ["accepted", "running"]);

    const later = now + 31 * 60_000;
    const parked = await own.parkIdleSessions(later);
    check("the quiet one is released", parked, ["s_quiet"]);
    check("and the working one is not, however long the turn runs", busy?.status, "running");
    check("so the machine holds one agent for two conversations", own.liveSessionCount, 1);

    /*
     * What "released" means, stated as the four facts a person would check. The
     * third is the one with a defect behind it: `exited` is what the derivation's
     * `default:` arm answers, and it is the word for a conversation somebody
     * ended.
     */
    check("the conversation is still there", own.get("s_quiet") !== undefined, true);
    check("with the agent's own id kept, which is what it comes back on", quiet?.agentSessionId, "a_quiet");
    check("and it does not read as stopped", quiet?.status, "parked");
    check("nor as something the daemon is coming back for by itself", quiet?.exit?.reason, "parked");

    /*
     * The refusals, each on its own row, because a single collapsed condition
     * would satisfy a test that asserted them together. Every one of these is a
     * session the sweep can see and must not take.
     */
    check("a session already released is not released again", await own.parkIdleSessions(later), []);

    /*
     * ⚠ **A person may end a released conversation, and this was broken the day
     * parking landed.**
     *
     * `stop()` memoises: a parked session's `stopping` promise has already
     * resolved, so `DELETE /sessions/:id` handed it straight back, `doStop` never
     * ran, and the route answered `200` with a snapshot still reading `parked`.
     * Pressing Stop did nothing, twice, forever — and the only way to end such a
     * conversation was to send a message, wait for the agent to come back, and
     * stop *that*. Before parking, a quiet session was live and Stop simply
     * worked, which is what makes this a regression rather than a gap.
     *
     * Both halves are pinned: that the reason is now the person's, and that the
     * status follows it. Asserting only the status would stay green if `parked`
     * were left on the row and something downstream started mapping it to
     * `exited`.
     */
    await quiet?.stop("stopped");
    check("a person can end a released conversation", quiet?.exit?.reason, "stopped");
    check("and it reads as ended, because this time somebody decided", quiet?.status, "exited");
    check("and it is not brought back at the next boot", autoResumable(quiet?.exit ?? null, quiet?.agentSessionId ?? null, "boot"), false);
    // The other trigger disagrees on purpose: `stopped` answers `true` on a
    // prompt, so a message *does* revive a conversation somebody ended. Pinned
    // here because the label above used to claim the opposite.
    check("but a message does bring it back, which is the other half of that arm", autoResumable(quiet?.exit ?? null, quiet?.agentSessionId ?? null, "prompt"), true);

    await own.shutdown();
  }

  /*
   * A released session survives a restart still released, and a message is what
   * brings it back — through the real route, because the route is where the
   * decision is made.
   *
   * The restart half matters more than it looks. `markInterrupted` is what a boot
   * pass runs over the rows it finds, and it is written `if (this.exitRecord)
   * return;` — so a parked row keeps its own exit rather than being relabelled
   * `daemon_restarted`, which would put it straight back into the boot pass and
   * undo the whole feature at the next deploy. Nothing else asserts that the
   * guard covers this new reason.
   */
  {
    const rig = rigWith({ resume: true });
    const rows = [interruptedRow("s_wake", "daemon_restarted", "a_wake")];
    // A store that keeps what is written to it, so the second registry below sees
    // the row the first one left rather than the fixture.
    const saved = new Map<string, PersistedSession>(rows.map((row) => [row.id, row]));
    const store: SessionStore = {
      put: (row) => void saved.set(row.id, row),
      list: () => [...saved.values()],
      remove: (id) => void saved.delete(id),
    };
    const first = new SessionRegistry(new MemoryEventStore(), store, undefined, rig.runtime);
    first.restore({ reapOrphans: false });
    await first.autoResume({ ...options, concurrency: 1 });
    check("released after a quiet spell", await first.parkIdleSessions(now + 31 * 60_000), ["s_wake"]);
    check("and written down that way", saved.get("s_wake")?.exit?.reason, "parked");
    await first.shutdown();

    const second = new SessionRegistry(new MemoryEventStore(), store, undefined, rig.runtime);
    second.restore({ reapOrphans: false });
    check("a restart finds it still released, not interrupted", second.get("s_wake")?.status, "parked");
    const boot = await second.autoResume({ ...options, concurrency: 1 });
    check("and the boot pass leaves it alone", [boot.resumed, second.get("s_wake")?.status], [0, "parked"]);
    check("so the machine comes up holding no agent for it", second.liveSessionCount, 0);

    const routed = createApp({
      registry: second,
      verifier,
      instanceId: "i_park",
      startedAt: now,
      credentials,
      roots: [users],
      logins: new AgentLoginRuns({ runtime: second.sessionRuntime, onWarning: () => {} }),
    }).app;
    const woke = await routed.fetch(
      new Request("http://d/sessions/s_wake/prompt", {
        method: "POST",
        headers: { authorization: `Bearer ${tokenFor("u_alice")}`, "content-type": "application/json" },
        body: JSON.stringify({ text: "carry on" }),
      }),
    );
    check("a message wakes it", woke.status, 202);
    check("on the same conversation the agent already had", rig.resumes().at(-1)?.sessionId, "a_wake");
    check("and it is live again", [second.get("s_wake")?.status, second.liveSessionCount], ["idle", 1]);

    await second.shutdown();
  }

  /*
   * At the ceiling, a wake takes a slot rather than being refused.
   *
   * **This is what turns `MAX_LIVE_SESSIONS` into a memory budget.** The cap is
   * checked in exactly one place — `create()` — and resume has always been
   * outside it, deliberately, because refusing to restore work after a deploy is
   * worse than being briefly over. That was safe while nothing ever parked; once
   * parking is ordinary, a fleet of released sessions waking one by one would
   * walk straight past the ceiling and the feature would buy nothing.
   *
   * So the wake evicts instead: least recently active first, one slot, never a
   * refusal. Both halves are pinned, and the second is the one with a person on
   * the other end of it.
   */
  {
    const rig = rigWith({ resume: true, stallPrompt: true });
    const store = storeOf([
      interruptedRow("s_old", "daemon_restarted", "a_old"),
      interruptedRow("s_new", "daemon_restarted", "a_new"),
      interruptedRow("s_want", "daemon_restarted", "a_want"),
    ]);
    const own = new SessionRegistry(new MemoryEventStore(), store, undefined, rig.runtime);
    own.restore({ reapOrphans: false });
    await own.autoResume({ ...options, concurrency: 1 });
    // Park all three, then wake two in a known order so that "least recently
    // active" has something to be wrong about: `s_new` spoke after `s_old`.
    await own.parkIdleSessions(now + 31 * 60_000);
    await own.get("s_old")?.resume();
    await own.get("s_new")?.resume();
    check("two agents resident, one conversation still released", [own.liveSessionCount, own.get("s_want")?.status], [2, "parked"]);

    /*
     * ⚠ **The threshold is lowered to 1ms, and that is the fixture rather than a
     * shortcut.** `makeRoomForWake` reads the *real* clock — it runs on the wake
     * path, where there is no test-supplied instant to thread through — while
     * `parkIdleSessions` takes one. So at the default half hour these sessions,
     * resumed moments ago, are correctly not candidates, and the first draft of
     * this block asserted an eviction that must not have happened: the machine
     * went one over instead, which is this section's *second* property arriving
     * early. Lowering the threshold is what makes the first one reachable.
     */
    own.setSessionLimits({ live: 2, idleParkMs: 1 });
    await own.get("s_want")?.resume();
    check("the machine stays at its ceiling", own.liveSessionCount, 2);
    check("the wake was not refused", own.get("s_want")?.status, "idle");
    check("and the slot came from the least recently used", own.get("s_old")?.status, "parked");
    check("while the one used more recently kept its agent", own.get("s_new")?.status, "idle");

    /*
     * And the refusal that is deliberately absent. Every remaining session is
     * mid-turn, so there is nothing idle to take — a machine genuinely doing that
     * much work. Going one over the soft ceiling is the right answer, because the
     * alternative is telling somebody who just typed that their own conversation
     * is unavailable.
     */
    own.get("s_new")?.prompt("keep working");
    own.get("s_want")?.prompt("keep working");
    check("nothing left to take", [own.get("s_new")?.status, own.get("s_want")?.status], ["running", "running"]);
    await own.get("s_old")?.resume();
    check("the wake still happens", own.get("s_old")?.status, "idle");
    check("and the machine is knowingly one over rather than refusing somebody", own.liveSessionCount, 3);

    await own.shutdown();
  }

  /*
   * The schedule itself, driven by hand.
   *
   * **A scheduler nothing drives is a scheduler nobody knows is broken** — the
   * sentence `daemoncheck.agent-login-and-launch.ts` puts on `AgentUpdates`, and
   * it applies harder here: every branch below is unreachable from a machine that
   * is merely left running, and each of them fails *quietly*. A sweep that stopped
   * re-arming would look exactly like a fleet with nothing idle on it.
   *
   * The timer and the sweep are both injected, so this runs at no wall-clock cost
   * and asserts the wiring rather than the timing.
   */
  {
    const armed: { delay: number; fire: () => void }[] = [];
    const reported: string[][] = [];
    let sweeps = 0;
    let allowed = true;
    let parked: string[] = [];
    const parking = IdleParking.start({
      park: async () => {
        sweeps += 1;
        return parked;
      },
      enabled: () => allowed,
      schedule: (fire, delay) => {
        const entry = { delay, fire };
        armed.push(entry);
        return {
          cancel: () => {
            const at = armed.indexOf(entry);
            if (at >= 0) armed.splice(at, 1);
          },
        };
      },
      onParked: (ids) => void reported.push([...ids]),
    });

    check("a sweep is armed at start", [armed.length, armed[0]?.delay], [1, 60_000]);
    check("and nothing has run yet", sweeps, 0);

    // One tick, and the next is armed only after it settles — a self-rescheduling
    // timeout rather than an interval, so a slow sweep can never overlap itself.
    const first = armed.shift();
    first?.fire();
    await new Promise((resolve) => setTimeout(resolve, 0));
    check("a tick sweeps once and arms the next", [sweeps, armed.length], [1, 1]);
    check("and says nothing when nothing was released", reported, []);

    parked = ["s_a", "s_b"];
    armed.shift()?.fire();
    await new Promise((resolve) => setTimeout(resolve, 0));
    check("what it released is reported, so a vanished agent is never silent", reported, [["s_a", "s_b"]]);

    /*
     * Switched off at the source rather than by not arming: the thunk is read at
     * every tick because `daemon.ts` finishes reading its environment after the
     * registry exists, so a value captured at construction would be stale for the
     * whole life of the process.
     */
    allowed = false;
    parked = ["s_c"];
    armed.shift()?.fire();
    await new Promise((resolve) => setTimeout(resolve, 0));
    check("a disabled sweep does not sweep", sweeps, 2);
    check("but keeps its timer, so switching it back on needs no restart", armed.length, 1);

    allowed = true;
    armed.shift()?.fire();
    await new Promise((resolve) => setTimeout(resolve, 0));
    check("and picks up again when it is allowed", sweeps, 3);

    await parking.shutdown();
    check("shutdown disarms it", armed.length, 0);
    await parking.shutdown();
    check("and is idempotent, like every other shutdown here", armed.length, 0);
  }

  /*
   * Choosing a model on a session whose agent has been released.
   *
   * **The rule, and it is the owner's: a tap does not wake anything, and the
   * setting is really in force from the next message.** Both halves are here
   * because either alone is a different feature. Recording without applying is a
   * control that lies; applying by waking is a second way back for a design whose
   * whole answer to "where did my agent go" is *send a message*, and it would
   * spend ~400 MB on a glance at a settings row.
   *
   * What makes the strip live enough to tap at all is that parking keeps the
   * published options where every other stop clears them — so the first assertion
   * here is that they survived, and the rest is meaningless without it.
   */
  {
    const rig = rigWith({ resume: true, config: true });
    const store = storeOf([interruptedRow("s_cfg", "daemon_restarted", "a_cfg")]);
    const own = new SessionRegistry(new MemoryEventStore(), store, undefined, rig.runtime);
    own.restore({ reapOrphans: false });
    await own.autoResume({ ...options, concurrency: 1 });
    const cfg = own.get("s_cfg");
    check("the agent offers a model", cfg?.snapshot().agentConfig?.options.map((o) => o.id), ["model"]);

    await own.parkIdleSessions(now + 31 * 60_000);
    check("released", cfg?.status, "parked");
    /*
     * ⚠ The controls are still published. Cleared — which is what every other
     * stop does — the client falls to its own memory, draws the row faint and
     * refuses the tap, so a session you could re-model at 29 minutes you could not
     * at 31, with nothing on screen saying why.
     */
    check("and its controls are still offered", cfg?.snapshot().agentConfig?.options.map((o) => o.id), ["model"]);

    const before = rig.launches();
    const set = await cfg?.setConfigOption("model", "sonnet");
    check("choosing a model is accepted rather than refused", set?.kind, "ok");
    check("the choice is on the session at once", cfg?.snapshot().agentConfig?.options[0]?.value, "sonnet");
    /*
     * The two halves of "does not wake", asserted separately: no process was
     * started, and the session did not quietly stop being released. A tap that
     * woke the agent would satisfy the value assertion above and fail both of
     * these.
     */
    check("no agent was started for it", rig.launches(), before);
    check("and it is still released", cfg?.status, "parked");
    check("nothing has been sent to any agent", rig.configSets(), []);

    /*
     * Validation is the live path's, run against the remembered options — so a
     * value the agent does not offer is refused without one, rather than recorded
     * and then silently dropped at the wake by `restoreConfig`'s own guard.
     */
    const bad = await cfg?.setConfigOption("model", "no-such-model");
    check("a value the agent does not offer is still refused", bad?.kind, "invalid_value");
    const missing = await cfg?.setConfigOption("nonsense", "x");
    check("and so is an option it never had", missing?.kind, "unknown_option");

    // And now the half that makes the recording mean anything.
    await cfg?.resume();
    check("the wake sends the choice to the fresh agent", rig.configSets(), [{ id: "model", value: "sonnet" }]);
    check("which is live again on the chosen model", [cfg?.status, cfg?.snapshot().agentConfig?.options[0]?.value], ["idle", "sonnet"]);

    await own.shutdown();
  }

  /*
   * And the negative that keeps the arm narrow: a session somebody *stopped* is
   * not a session whose settings are pending. Its controls went with its agent —
   * `doStop` clears them for every reason but `parked` — so there is nothing to
   * tap and the refusal is the ordinary one.
   */
  {
    const rig = rigWith({ resume: true, config: true });
    const store = storeOf([interruptedRow("s_off", "daemon_restarted", "a_off")]);
    const own = new SessionRegistry(new MemoryEventStore(), store, undefined, rig.runtime);
    own.restore({ reapOrphans: false });
    await own.autoResume({ ...options, concurrency: 1 });
    const off = own.get("s_off");
    await off?.stop("stopped");
    check("a stopped session keeps no controls", off?.snapshot().agentConfig?.options ?? [], []);
    const set = await off?.setConfigOption("model", "sonnet");
    check("and a choice on one is refused, not deferred", set?.kind, "terminal");

    await own.shutdown();
  }

  /*
   * The one setting on this a person can change, and the precedence that makes it
   * worth having.
   *
   * ⚠ **The daemon's config is env only, and this does not relax that.** What is
   * stored here is the narrow class whose owner is the person *using* the machine:
   * their own trade between memory and a ~1.3s wait.
   *
   * What is worth asserting is therefore the precedence itself — a stored value
   * beats the env file, so `REEMOAT_IDLE_PARK_MINUTES` is the default for a
   * machine nobody has set rather than a policy anything has to explain itself
   * against. ⚠ **This paragraph used to argue that the wire needed a `source` to
   * say which of the two was winning; it does not, and the assertions below would
   * fail if it did** — they deep-equal the whole payload as `{ idleReleaseMinutes:
   * … }`. The field existed for one round, the owner removed the line on the screen
   * that was its only reader, and it went with it. Left as written it read as a
   * requirement rather than as history. See `MachineSettingsView`.
   */
  {
    const rig = rigWith({ resume: true });
    const kept = new Map<string, string>();
    const settings = {
      read: (key: string) => kept.get(key) ?? null,
      write: (key: string, value: string) => void kept.set(key, value),
    };
    const own = new SessionRegistry(new MemoryEventStore(), storeOf([]), undefined, rig.runtime);
    own.restore({ reapOrphans: false });
    // What an env file asked for, exactly as `daemon.ts` injects it.
    own.setSessionLimits({ idleParkMs: 45 * 60_000 });
    own.setMachineSettingsStore(settings);

    const routed = createApp({
      registry: own,
      verifier,
      instanceId: "i_settings",
      startedAt: now,
      credentials,
      roots: [users],
      machineSettings: settings,
      logins: new AgentLoginRuns({ runtime: own.sessionRuntime, onWarning: () => {} }),
    }).app;
    const call = async (method: string, body?: unknown): Promise<[number, any]> => {
      const response = await routed.fetch(
        new Request("http://d/settings", {
          method,
          headers: { authorization: `Bearer ${tokenFor("u_alice")}`, "content-type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      );
      return [response.status, await response.json()];
    };

    const [readStatus, read] = await call("GET");
    check("with nothing stored, the configuration is what is in force", [readStatus, read.settings], [200, { idleReleaseMinutes: 45 }]);

    const [saveStatus, saved] = await call("PATCH", { idleReleaseMinutes: 5 });
    check("saving answers with what is now in force", [saveStatus, saved.settings], [200, { idleReleaseMinutes: 5 }]);
    /*
     * ⚠ **Applied to the *running* daemon, not at the next restart.** The route
     * calls `applyMachineSettings` before it answers, so this is the observable
     * that says the number reached the sweep rather than only the table — and it
     * is the half a caller cannot check for itself.
     */
    check("and the running daemon is already using it", own.idleParkEnabled, true);
    const store2 = storeOf([interruptedRow("s_five", "daemon_restarted", "a_five")]);
    const live = new SessionRegistry(new MemoryEventStore(), store2, undefined, rig.runtime);
    live.restore({ reapOrphans: false });
    live.setSessionLimits({ idleParkMs: 45 * 60_000 });
    live.setMachineSettingsStore(settings);
    await live.autoResume({ ...options, concurrency: 1 });
    check("a session quiet past the saved five minutes is released", await live.parkIdleSessions(now + 6 * 60_000), ["s_five"]);
    check("which the configured forty-five would not have taken", live.machineSettings(), { idleReleaseMinutes: 5 });
    await live.shutdown();

    // `0` is a real answer rather than "unset", and has to survive the round trip
    // as one — a falsy value read as absent is how a switch turns itself back on.
    /*
     * ⚠ `0` is a real answer and has to survive the round trip as one — a falsy
     * value read as absent is how a switch turns itself back on. It is also now the
     * *only* way to say "never": the `null` that forgot the stored value went with
     * the line on the screen that was the only thing able to express the difference.
     */
    const [, off] = await call("PATCH", { idleReleaseMinutes: 0 });
    check("zero is stored as a choice, not read as unset", off.settings, { idleReleaseMinutes: 0 });
    check("and nothing is released while it says so", own.idleParkEnabled, false);
    const [nullStatus] = await call("PATCH", { idleReleaseMinutes: null });
    check("and null is no longer a way to ask for the configuration back", nullStatus, 400);

    const [unknownStatus, unknown] = await call("PATCH", { somethingElse: 5 });
    check("a setting this daemon does not have is refused", [unknownStatus, unknown.error.code], [400, "unknown_setting"]);
    const [badStatus, bad] = await call("PATCH", { idleReleaseMinutes: -1 });
    check("and so is a value outside the bound", [badStatus, bad.error.code], [400, "invalid_setting"]);
    const [fracStatus, frac] = await call("PATCH", { idleReleaseMinutes: 1.5 });
    check("and half a minute", [fracStatus, frac.error.code], [400, "invalid_setting"]);
    const [hugeStatus] = await call("PATCH", { idleReleaseMinutes: MAX_IDLE_RELEASE_MINUTES + 1 });
    check("and more than the ceiling", hugeStatus, 400);
    // The refusals left the stored `0` exactly as it was — one row, unchanged.
    check("none of which changed what is stored", [...kept.entries()], [["idleReleaseMinutes", "0"]]);

    /*
     * ⚠ **And the shape every refusal above misses: a body with more than one key
     * in it.**
     *
     * All five are one key — `null`, an unknown name, `-1`, `1.5`, and one over the
     * ceiling — so each is refused before anything is written, and the assertion
     * above passes over the defect it looks like it covers. The route validated and
     * wrote in the same pass, so a *valid* key ahead of a bad one was persisted and
     * then the request answered `400` — and the early return skipped
     * `applyMachineSettings`, leaving the table saying one thing and the running
     * daemon another until the next restart. A refused request silently moved
     * machine-wide policy, at the next boot, with nothing on any screen saying so.
     *
     * Reachable with today's one-member union because the second key does not have
     * to be *valid* to be second: `anythingElse` is refused as unknown, and by then
     * `idleReleaseMinutes` had already been written.
     *
     * ⚠ **The three rows below do not each catch it, and which one does is worth
     * writing down** — measured by reverting the fix in a scratch copy and running
     * this file. The table row fails. The drift row fails. The `idleParkEnabled`
     * row **passes**, and can never do otherwise: under the bug the *registry* is
     * the half that stayed right — `applyMachineSettings` was skipped, so it went
     * on holding the old number — and it is the table underneath that moved. It is
     * here to pin the value a caller would actually observe, not as a second
     * detector.
     */
    const [mixedStatus, mixed] = await call("PATCH", { idleReleaseMinutes: 5, anythingElse: 1 });
    check("a body with one bad key is refused", [mixedStatus, mixed.error.code], [400, "unknown_setting"]);
    check("and the good key beside it was not written", [...kept.entries()], [["idleReleaseMinutes", "0"]]);
    check("so the running daemon still holds what it held", own.idleParkEnabled, false);
    /*
     * ⚠ **And the second half of the same defect, which the row above cannot
     * see.** The early return also skipped `applyMachineSettings`, so the bug did
     * not merely write too much — it wrote the table and left the running daemon
     * on the old number, and the two then disagreed until the next restart.
     *
     * Read as one comparison because the *route* half of it is blind on its own:
     * `GET /settings` answers from the registry, so it reports the old number
     * quite happily while the table underneath it says something else. Asserting
     * what `GET` returns would therefore have been green over the drift. What the
     * pairing adds is the table beside it, and it is their agreement — not either
     * value — that is the property.
     */
    check(
      "and the table and the running daemon did not drift apart",
      [kept.get("idleReleaseMinutes") ?? null, String((await call("GET"))[1].settings.idleReleaseMinutes)],
      ["0", "0"],
    );

    /*
     * The other order, which is the one a `PATCH` is most likely to arrive in: the
     * bad key first. Already correct before the fix — nothing had been written yet
     * — and pinned so the two orders can never diverge, since "all-or-nothing" is
     * not a property one of them may have.
     */
    const [firstBadStatus, firstBad] = await call("PATCH", { anythingElse: 1, idleReleaseMinutes: 5 });
    // The code as well as the status: "the two orders never diverge" is a claim
    // about the refusal, and a status alone would let them answer 400 for two
    // different reasons and still pass.
    check("and the same body the other way round is refused too", [firstBadStatus, firstBad.error.code], [400, "unknown_setting"]);
    check("with the table still untouched", [...kept.entries()], [["idleReleaseMinutes", "0"]]);

    await own.shutdown();
  }

  /*
   * A daemon with no durable store can still say what is in force and must refuse
   * to change it — the asymmetry `ServerOptions.machineSettings` argues for: the
   * number is a fact about the machine either way, and a refusal says why a form
   * would not save where an empty one would say nothing.
   */
  {
    const own = new SessionRegistry(new MemoryEventStore(), storeOf([]));
    own.restore({ reapOrphans: false });
    const routed = createApp({
      registry: own,
      verifier,
      instanceId: "i_nostore",
      startedAt: now,
      credentials,
      roots: [users],
      logins: new AgentLoginRuns({ runtime: own.sessionRuntime, onWarning: () => {} }),
    }).app;
    const get = await routed.fetch(
      new Request("http://d/settings", { headers: { authorization: `Bearer ${tokenFor("u_alice")}` } }),
    );
    const got = (await get.json()) as any;
    check("a store-less daemon still says what is in force", [get.status, got.settings.idleReleaseMinutes], [200, 30]);
    const patch = await routed.fetch(
      new Request("http://d/settings", {
        method: "PATCH",
        headers: { authorization: `Bearer ${tokenFor("u_alice")}`, "content-type": "application/json" },
        body: JSON.stringify({ idleReleaseMinutes: 5 }),
      }),
    );
    const refused = (await patch.json()) as any;
    check("and refuses to change it rather than pretending", [patch.status, refused.error.code], [503, "settings_unavailable"]);
    await own.shutdown();
  }

  /*
   * A conversation the agent no longer holds is never released — and the
   * interesting half is *why* the check inside `parkable` cannot fire.
   *
   * ⚠ **This section had a fixture that was wrong in an instructive way.** It
   * resumed a `resume_gave_up` session by hand so that every other precondition
   * was met and the give-up was the only thing left to refuse on — and the row
   * was parked anyway. The fixture was not the bug: `onResumed` **clears**
   * `resumeGivenUp` on the resume that succeeded, so a session that is live at
   * all has, by construction, just proved it can be brought back. The state the
   * guard describes — live, idle, and given up on — does not exist.
   *
   * So the guard stays as a statement of intent at the site where somebody would
   * otherwise add "…and also park the settled ones", and what is asserted here is
   * the reachable shape and the reason the other one is not: a session the daemon
   * has given up on is terminal, it has no agent to release, and a successful
   * resume is what takes the verdict off it.
   */
  {
    const rig = rigWith({ resume: true, forgotten: true });
    const store = storeOf([
      interruptedRow("s_ok", "daemon_restarted", "a_ok"),
      interruptedRow("s_lost", "daemon_restarted", "a_lost"),
    ]);
    const own = new SessionRegistry(new MemoryEventStore(), store, undefined, rig.runtime);
    own.restore({ reapOrphans: false });
    // The rig answers every resume with `resourceNotFound`, so both sessions are
    // told the agent no longer holds them; `s_ok` is then brought back by hand
    // against a rig that does hold it, which is the only way to have one of each.
    await own.autoResume({ ...options, concurrency: 1 });
    check("the agent says it has forgotten them", own.get("s_lost")?.resumeAbandoned, "forgotten");

    const later = now + 31 * 60_000;
    check("a session with no agent to release is not released", await own.parkIdleSessions(later), []);
    check("and it keeps the verdict rather than gaining an exit nobody wrote", own.get("s_lost")?.status, "interrupted");

    await own.shutdown();
  }

  /*
   * And the guard's own premise, asserted rather than assumed: a resume that
   * works takes the give-up off. This is what makes "live and given up on"
   * unreachable, and it is a fact about `onResumed` that nothing else in this
   * file pins.
   */
  {
    const rig = rigWith({ resume: true });
    const store = storeOf([
      { ...interruptedRow("s_cleared", "daemon_restarted", "a_cleared"), resumeGaveUp: "forgotten" },
    ]);
    const own = new SessionRegistry(new MemoryEventStore(), store, undefined, rig.runtime);
    own.restore({ reapOrphans: false });
    check("restored still carrying the verdict", own.get("s_cleared")?.resumeAbandoned, "forgotten");
    await own.get("s_cleared")?.resume();
    check("and a resume that works clears it", own.get("s_cleared")?.resumeAbandoned, null);
    check("which is why a live session cannot be one the daemon gave up on", own.get("s_cleared")?.status, "idle");
    await own.shutdown();
  }

  {
    // An agent that cannot reattach at all. Two sessions on it, so the per-agent
    // memo has something to prove: the second must cost no spawn.
    const rig = rigWith({ resume: false });
    const store = storeOf([
      interruptedRow("s_u1", "daemon_restarted", "a_u1"),
      interruptedRow("s_u2", "daemon_restarted", "a_u2"),
    ]);
    const own = new SessionRegistry(new MemoryEventStore(), store, undefined, rig.runtime);
    own.restore({ reapOrphans: false });
    const report = await own.autoResume({ ...options, concurrency: 1 });

    const one = own.get("s_u1");
    check("an agent that cannot resume leaves the session interrupted", one?.status, "interrupted");
    // The `previousExit` restore, reached through the automatic door. Letting
    // `onStartFailed`'s `start_failed` stand would rewrite the reason out of
    // existence and with it every chance of ever bringing the session back.
    check("with its original reason intact", one?.exit?.reason, "daemon_restarted");
    check("and it says so on the snapshot", one?.snapshot().resume?.state, "failed");
    check("both are skipped", report.skipped, 2);
    // One spawn, not two: the capability can only be read *after* an agent has
    // started, so the first is unavoidable and every one after it is not.
    check("but only one agent was ever started", rig.launches(), 1);
    await own.shutdown();
  }

  {
    // An agent that starts and then refuses the resume itself.
    const rig = rigWith({ resume: true, failResume: true });
    const store = storeOf([interruptedRow("s_fail", "daemon_shutdown", "a_fail")]);
    const own = new SessionRegistry(new MemoryEventStore(), store, undefined, rig.runtime);
    own.restore({ reapOrphans: false });
    const report = await own.autoResume({ ...options, concurrency: 1, maxAttempts: 2 });

    const failed = own.get("s_fail");
    check("a refused resume leaves the reason alone", failed?.exit?.reason, "daemon_shutdown");
    check("and the status with it", failed?.status, "interrupted");
    check("the budget is spent, not looped", [rig.resumes().length, report.failed], [2, 1]);
    // Exactly one, on the last attempt. A per-attempt event would spend the
    // operator's own first prompt to say the same thing three times, in a log
    // that evicts a prefix.
    const written = failed?.log.read(0, 1000, 1024 * 1024) ?? [];
    check(
      "and says so once rather than per attempt",
      written.filter((stored) => stored.event.type === "error").length,
      1,
    );
    /*
     * And leaves no status churn at all.
     *
     * Each attempt used to append three — `starting`, a momentary `failed` that
     * is a lie about the session, and `interrupted` as the original exit went
     * back — describing a round trip that ended where it began. Nine dead
     * sessions on a real machine had their transcripts filled with the machinery
     * of their own failed revival, in a log that evicts a prefix and therefore
     * pays for it with the operator's own first prompt.
     */
    check(
      "and writes no status churn for attempts nobody asked for",
      written.filter((stored) => stored.event.type === "status").length,
      0,
    );
    await own.shutdown();
  }

  {
    /*
     * The agent starts, and says it no longer holds the conversation.
     *
     * Measured in production 2026-08-04 on ten sessions at once — transcripts
     * that did not survive the move off containers — where it cost three spawns
     * each on *every* restart. Both halves of the fix are pinned here: one
     * attempt rather than three, and a verdict that outlives the daemon.
     */
    const rig = rigWith({ resume: true, forgotten: true });
    // A store that actually writes back, unlike `storeOf` — persistence is the
    // property under test, so a stub that discards `put` would assert nothing.
    const saved = new Map<string, PersistedSession>();
    const store: SessionStore = {
      put: (row) => void saved.set(row.id, row),
      list: () => [...saved.values()],
      remove: (id) => void saved.delete(id),
    };
    saved.set("s_lost", interruptedRow("s_lost", "daemon_restarted", "a_lost"));

    const first = new SessionRegistry(new MemoryEventStore(), store, undefined, rig.runtime);
    first.restore({ reapOrphans: false });
    const report = await first.autoResume({ ...options, concurrency: 1, maxAttempts: 3 });

    const lost = first.get("s_lost");
    check("a forgotten conversation is not a failure to retry", rig.resumes().length, 1);
    check("so the budget is untouched", [report.skipped, report.failed], [1, 0]);
    check("the session keeps its original reason", lost?.exit?.reason, "daemon_restarted");
    check("and says why nobody is coming", lost?.snapshot().resume?.error?.code, "agent_forgot_session");
    await first.shutdown();

    /*
     * The restart. A second registry over the same rows is exactly what the next
     * boot does, and the assertion is that it spawns **nothing** — the one place
     * this codebase persists a retry verdict, because it is a fact about the
     * agent's disk rather than about an attempt of ours.
     */
    const spawnsBefore = rig.launches();
    const second = new SessionRegistry(new MemoryEventStore(), store, undefined, rig.runtime);
    second.restore({ reapOrphans: false });
    const after = await second.autoResume({ ...options, concurrency: 1 });
    check("a restart does not try again", rig.launches() - spawnsBefore, 0);
    check("and does not even consider it", after.considered, 0);
    check("the verdict was on disk, not in memory", saved.get("s_lost")?.resumeGaveUp, "forgotten");
    await second.shutdown();
  }

  {
    /*
     * An agent that refuses to resume while the file-IO capability is declared.
     *
     * Measured 2026-08-05 against kimi 0.29.2, deterministically: a session left
     * in plan mode answers `session/resume` with `-32603` when the client
     * declares `clientCapabilities.fs`, and resumes perfectly without it.
     * Leaving plan mode first cures it — so this is "somebody ended their day in
     * plan mode", not a corner.
     *
     * The retry uses the seam this codebase already keeps rather than a new one:
     * `fileIo` exists so the capability *can* be declined, and the cost was
     * measured long before this — with it, kimi made five reverse-RPC calls and
     * claude none; without it, neither made any.
     */
    const rig = rigWith({ resume: true, hatesFileIo: true });
    const store = storeOf([interruptedRow("s_fio", "daemon_restarted", "a_fio")]);
    const own = new SessionRegistry(new MemoryEventStore(), store, undefined, rig.runtime);
    own.restore({ reapOrphans: false });
    const report = await own.autoResume({ ...options, concurrency: 1 });

    check("a session refused with the capability still comes back", report.resumed, 1);
    check("and is idle rather than stranded", own.get("s_fio")?.status, "idle");
    // Two attempts, in this order: the capability is declared first because it is
    // what the daemon wants, and dropped only after the agent has refused it.
    check("having been asked twice, with then without", rig.fileIoAtResume(), [true, false]);
    // One retry, not a loop: the second failure would be a real one.
    check("and no retry budget was spent on it", own.get("s_fio")?.resumeAttemptCount, 0);
    await own.shutdown();
  }

  {
    /*
     * A cleared conversation the agent never wrote down is recreated, not mourned.
     *
     * `clearContext` mints an empty conversation and claude writes the transcript
     * with the **first turn**, so a restart landing between the clear and the
     * next message finds an id naming nothing. Measured the hard way in
     * production: the session came back `resourceNotFound` and could not be
     * resumed at all — a worse outcome than the bug the clear interception was
     * built to fix.
     *
     * Opening another empty conversation is identical rather than approximate:
     * there was nothing in the old one, and empty is what clearing asked for.
     */
    const rig = rigWith({ resume: true, forgotten: true });
    const store = storeOf([interruptedRow("s_clr", "daemon_restarted", "a_clr")]);
    const own = new SessionRegistry(new MemoryEventStore(), store, undefined, rig.runtime);
    own.restore({ reapOrphans: false });
    own.get("s_clr")?.log.append({
      type: "context_cleared",
      agentSessionId: "a_clr",
      previousAgentSessionId: "a_older",
    });
    const report = await own.autoResume({ ...options, concurrency: 1 });

    check("a cleared-and-unused conversation is recreated", report.resumed, 1);
    check("the session is idle rather than stranded", own.get("s_clr")?.status, "idle");
    /*
     * And the doomed resume is never attempted — one agent spawn, not two.
     *
     * The point of deciding up front rather than recovering in a catch. We
     * already know the conversation is empty, so asking the agent to restore it
     * can only fail, and the failure would cost a process and a line in the log.
     */
    check("without asking the agent to resume what is not there", rig.resumes().length, 0);
    check("and one agent started, not two", rig.launches(), 1);
    // The id moved to the one the agent just handed us, which is the whole point:
    // a resume that stored the dead id would fail again on the next boot.
    check("on a conversation the agent gave us", own.get("s_clr")?.agentSessionId, "conv_1");

    /*
     * And again on the next restart, which is the case that actually broke.
     *
     * The first version of the gate compared the marker's `agentSessionId` to
     * the current one, so it worked exactly once: the recovery opens *another*
     * empty conversation and appends no marker for it, so the restart after that
     * found no record naming the new id and gave up — measured in production, on
     * the very session this was built for. Which id is current is not the
     * question; whether anything has been said since the clear is.
     */
    /*
     * A older clear with a whole conversation after it must not decide the
     * answer — only the last marker or prompt does.
     *
     * Measured wrong twice on the live session: first the gate compared ids and
     * worked once, then it returned on the first prompt following the first
     * marker and answered about a conversation two generations dead.
     */
    const clr = own.get("s_clr");
    clr?.log.append({ type: "prompt", text: "we talked about it", attachments: [] });
    clr?.log.append({ type: "context_cleared", agentSessionId: "a_newer", previousAgentSessionId: "conv_1" });

    own.get("s_clr")?.markInterrupted(true, null);
    const again = await own.autoResume({ ...options, concurrency: 1 });
    check("and again on the restart after that", again.resumed, 1);
    check("on yet another fresh conversation", own.get("s_clr")?.agentSessionId, "conv_2");
    check("still without a doomed resume", rig.resumes().length, 0);
    await own.shutdown();
  }

  {
    /*
     * A session created and never spoken to is empty for the *other* reason.
     *
     * Measured 2026-08-05, on a session made at 13:56 and left alone: it failed
     * to resume exactly the way a cleared one did, because claude writes a
     * transcript with the first **turn** and this conversation never had one.
     * The gate knew only "cleared" and stranded it.
     *
     * `turnCounter` is what says so — persisted on the row beside the agent
     * session id, so the two always describe the same life. Deliberately not "no
     * `prompt` in the log": an empty log is evidence of an empty log, not of an
     * empty conversation, and that version broke twenty-four other cases.
     */
    const rig = rigWith({ resume: true, forgotten: true });
    const store = storeOf([
      { ...interruptedRow("s_untouched", "daemon_restarted", "a_untouched"), turnCounter: 0 },
    ]);
    const own = new SessionRegistry(new MemoryEventStore(), store, undefined, rig.runtime);
    own.restore({ reapOrphans: false });
    const report = await own.autoResume({ ...options, concurrency: 1 });

    check("a session nobody ever spoke to is opened fresh", report.resumed, 1);
    check("without asking the agent for a conversation that never existed", rig.resumes().length, 0);
    check("and it is usable rather than stranded", own.get("s_untouched")?.status, "idle");
    await own.shutdown();
  }

  {
    /*
     * And the guard, which matters more than the recovery above.
     *
     * Same lost conversation, but nothing says it was cleared — so it had
     * content, and that content is gone. Silently handing somebody a fresh agent
     * while they expect their history restored is the same class of quiet lie as
     * handing back what they asked to forget.
     */
    const rig = rigWith({ resume: true, forgotten: true });
    const store = storeOf([interruptedRow("s_lost3", "daemon_restarted", "a_lost3")]);
    const own = new SessionRegistry(new MemoryEventStore(), store, undefined, rig.runtime);
    own.restore({ reapOrphans: false });
    const report = await own.autoResume({ ...options, concurrency: 1 });

    check("a lost conversation nobody cleared is not silently replaced", report.resumed, 0);
    check("it stays interrupted", own.get("s_lost3")?.status, "interrupted");
    check("and says why", own.get("s_lost3")?.snapshot().resume?.error?.code, "agent_forgot_session");
    // The verdict a previous life wrote must not veto a recovery this one knows
    // how to make — but here there is no recovery to make, so it stands.
    check("with the verdict standing", own.get("s_lost3")?.resumeAbandoned, "forgotten");
    await own.shutdown();
  }

  {
    // A worktree that is simply gone. The assertion is the *absence* of a spawn:
    // claude's adapter rejects a nonexistent cwd, so starting one to find that
    // out is a process spawned to learn something already known.
    const rig = rigWith({ resume: true });
    const store = storeOf([interruptedRow("s_gone", "daemon_restarted", "a_gone", false)]);
    const own = new SessionRegistry(new MemoryEventStore(), store, undefined, rig.runtime);
    own.restore({ reapOrphans: false });
    const report = await own.autoResume({ ...options, concurrency: 1 });

    check("a missing workspace spawns nothing at all", rig.launches(), 0);
    check("and leaves the session interrupted", own.get("s_gone")?.status, "interrupted");
    check("marked as given up rather than pending", own.get("s_gone")?.snapshot().resume?.state, "failed");
    check("counted as skipped, not failed", [report.skipped, report.failed], [1, 0]);
    await own.shutdown();
  }

  {
    // Shutdown wins. Starting an agent the very next statement is going to kill
    // is the one outcome worse than not starting it.
    const rig = rigWith({ resume: true });
    const store = storeOf([interruptedRow("s_late", "daemon_restarted", "a_late")]);
    const own = new SessionRegistry(new MemoryEventStore(), store, undefined, rig.runtime);
    own.restore({ reapOrphans: false });
    await own.shutdown();
    const report = await own.autoResume(options);
    check("a shutting-down daemon resumes nothing", [report.resumed, rig.launches()], [0, 0]);
  }

  {
    // The concurrency bound, which is the only thing standing between a deploy
    // and forty simultaneous agent processes on somebody's laptop.
    const rig = rigWith({ resume: true, stallMs: 25 });
    const store = storeOf(
      Array.from({ length: 6 }, (_unused, index) =>
        interruptedRow(`s_c${index}`, "daemon_restarted", `a_c${index}`),
      ),
    );
    const own = new SessionRegistry(new MemoryEventStore(), store, undefined, rig.runtime);
    own.restore({ reapOrphans: false });
    const report = await own.autoResume({ ...options, concurrency: 2 });
    check("every session comes back", [report.considered, report.resumed], [6, 6]);
    check("and never more than two at once", rig.peak() <= 2, true);
    await own.shutdown();
  }

  {
    /*
     * The other door: a message to an interrupted session resumes it first.
     *
     * Through a real route, because the whole point is that the client sends the
     * request it always sent. Two assertions and they are a pair — the second is
     * what stops this from being "resume everything on any prompt".
     */
    const rig = rigWith({ resume: true });
    const store = storeOf([
      interruptedRow("s_typed", "daemon_shutdown", "a_typed"),
      interruptedRow("s_killed", "stopped", "a_killed"),
      // `create = false` points this row's workspace at a directory that was
      // never made — the fixture for "somebody deleted the folder".
      interruptedRow("s_gone", "daemon_shutdown", "a_gone", false),
    ]);
    const own = new SessionRegistry(new MemoryEventStore(), store, undefined, rig.runtime);
    own.restore({ reapOrphans: false });
    const routed = createApp({
      registry: own,
      verifier,
      instanceId: "i_resume",
      startedAt: now,
      credentials,
      roots: [users],
      logins: new AgentLoginRuns({ runtime: own.sessionRuntime, onWarning: () => {} }),
    }).app;

    const say = async (id: string): Promise<number> => {
      const response = await routed.fetch(
        new Request(`http://d/sessions/${id}/prompt`, {
          method: "POST",
          headers: { authorization: `Bearer ${tokenFor("u_alice")}`, "content-type": "application/json" },
          body: JSON.stringify({ text: "carry on" }),
        }),
      );
      return response.status;
    };

    /*
     * ⚠ **A prompt is refused when the workspace is gone, and it is checked on
     * every message rather than only before a resume.**
     *
     * The guard sat inside the resume branch, so a session whose folder vanished
     * *while it was open* kept a live agent standing in a directory that no
     * longer existed — and the first anybody heard was the agent's own
     * `Internal error: Path "…" does not exist`, in the transcript, with no
     * remedy on the screen. `409 workspace_missing` is a sentence the client
     * already draws.
     */
    check("a message to a session whose folder is gone is refused", await say("s_gone"), 409);

    check("a message to an interrupted session is accepted", await say("s_typed"), 202);
    check("because the daemon resumed it first", rig.resumes()[0]?.sessionId, "a_typed");
    /*
     * ⚠ **And a message to a stopped one is accepted too, which reverses this
     * pair.** It asserted `409` and "no agent was started for it", on the rule
     * that Stop must mean stopped — which it still does *for the daemon*: nothing
     * revives it on a boot pass, and `autoResumable` keeps answering `false` there.
     * What changed is that a prompt was never the daemon deciding anything. It is
     * the person who pressed Stop typing into that conversation again, and the
     * composer is now unconditional, so the alternative is a box whose only
     * possible answer is a refusal.
     */
    check("a message to a stopped one starts it again", await say("s_killed"), 202);
    check("because that one was resumed as well", rig.resumes().length, 2);
    await own.shutdown();
  }

  {
    /*
     * **A launch that came back late, after its session had moved on.**
     *
     * Nothing bounds `session/new` or `session/resume` end to end, so a launch
     * timing out at 45s and resolving at 48s is ordinary rather than exotic. Its
     * only guard was `startAbandoned`, and `armForStart()` clears that on the
     * very next resume — so the late agent arrived to find the flag already reset
     * by the retry, was adopted as `this.session`, and was overwritten by the
     * retry's own agent moments later. The displaced one is `detached`, holds the
     * session's worktree, is referenced by nothing (`doStop` awaits
     * `startPromise`, `shutdown` collects `session.agentHandle`) and survives this
     * daemon's exit — invisible to the next boot's reaper, because the pid
     * persisted for that session is the other agent's.
     *
     * The launch identifies itself to its own callbacks now, which is the same
     * `this.session !== session` check every other late notification in that class
     * already makes — and the decline **disposes** before assigning, because
     * adopting first is what let a superseded agent be the live one for the two
     * seconds until the real launch resolved.
     *
     * The whole case rests on ordering that this rig can produce and a real agent
     * cannot be asked for: a stall longer than the first launch's budget, so the
     * first resolves while the second is still in flight.
     */
    const rig = rigWith({ resume: true, stallMs: 150 });
    const store = storeOf([interruptedRow("s_late", "daemon_restarted", "a_late")]);
    const own = new SessionRegistry(new MemoryEventStore(), store, undefined, rig.runtime);
    own.restore({ reapOrphans: false });
    const managed = own.get("s_late");

    // A budget the handshake cannot meet. `doResume` puts the original exit back
    // on the way out, which is what leaves the session resumable for the retry.
    const timedOut = await managed
      ?.resume(20)
      .then(() => "(resumed)", (error: unknown) => (error instanceof Error ? error.name : String(error)));
    check("a launch that misses its budget is abandoned", timedOut, "StartTimeoutError");
    check("and its session is terminal again, as it was", managed?.terminal, true);
    check("with the reason it actually ended on, not the failed revival", managed?.exit?.reason, "daemon_restarted");

    // The retry, which re-arms the session and therefore clears `startAbandoned`
    // — the window the old guard could not see. It starts while the first launch
    // is still in flight and outlives it.
    await managed?.resume(5_000);
    check("the retry brings the session back", managed?.status, "idle");
    check("and two agents really were started", rig.launches(), 2);
    check("both of which reached the agent's resume", rig.resumes().length, 2);

    /*
     * **The load-bearing line.** One agent is live and the other has been shut
     * down, *before* anything has been stopped — so the count is the abandoned
     * launch's own dispose rather than a teardown. Adopt it instead and this
     * reads 0, with every assertion above still green and a live agent left
     * holding the worktree for the rest of the machine's uptime.
     */
    check("the abandoned launch's agent was disposed rather than orphaned", rig.disposed(), 1);

    await own.shutdown();
    // And the survivor is shut down exactly once by the shutdown, which is what
    // says the count above was not the adopted agent being disposed by mistake.
    check("and the live one goes with the daemon", rig.disposed(), 2);
  }
}
