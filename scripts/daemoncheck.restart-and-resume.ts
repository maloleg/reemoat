import { join } from "node:path";
import { PassThrough } from "node:stream";
import { AgentUnavailableError, type AgentId, type AgentLaunchConfig } from "../src/acp/agents.js";
import { AgentLoginRuns } from "../src/agentauth.js";
import {
  EXIT_REASON_MEMBERS,
  MemoryEventStore,
  type ExitReason,
  type PersistedSession,
  type SessionExit,
  type SessionStore,
} from "../src/events.js";
import { SessionRegistry, autoResumable, revivableByPrompt, reduceAgentState, resumeBackoffMs, MAX_IDLE_RELEASE_MINUTES, SessionLimitError, TURN_SILENCE_MS, stoppedWithBackgroundWork, clearedWithBackgroundWork } from "../src/registry.js";
import {
  MAX_ASYNC_TASK_ID_CHARS,
  MAX_ASYNC_TASK_NAME_CHARS,
  MAX_ASYNC_TASK_TEXT_CHARS,
  MAX_TRACKED_ASYNC_TASKS,
} from "../src/acp/asynctasks.js";
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

  /*
   * ⚠ **The second reader of this table, and it is asserted as the *same* answer
   * rather than as a list of its own.**
   *
   * `revivableByPrompt` is what `doStop` clears the agent's controls on, what
   * `configIsDeferred` accepts a tap on, and what `persistedRow` writes
   * `agent_state_json` for. Written as its own reason set it would be a fourth
   * copy of this switch, free to drift by exactly one member — and the member it
   * would drift by is the one nobody would notice, since a session whose controls
   * are wrongly kept looks fine until a tap on it is refused.
   *
   * So the property is equality over the whole union, and the union is read off
   * `EXIT_REASON_MEMBERS` rather than typed out: a new reason lands in this sweep without
   * anybody adding a line.
   */
  check(
    "and every reason a prompt revives is exactly the set that keeps its controls",
    (Object.keys(EXIT_REASON_MEMBERS) as ExitReason[]).filter((reason) => revivableByPrompt(reason, "a_1")).sort(),
    (Object.keys(EXIT_REASON_MEMBERS) as ExitReason[]).filter((reason) => typed(reason)).sort(),
  );
  check(
    "which is four of them and not the three that never had a conversation",
    (Object.keys(EXIT_REASON_MEMBERS) as ExitReason[]).filter((reason) => !revivableByPrompt(reason, "a_1")).sort(),
    ["agent_kill_failed", "start_failed", "start_timeout"],
  );
  check(
    "and none of them without an agent session id to return to",
    (Object.keys(EXIT_REASON_MEMBERS) as ExitReason[]).some((reason) => revivableByPrompt(reason, null)),
    false,
  );

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
    /**
     * Answer the oldest prompt `stallPrompt` made this rig sit on, and say
     * whether there was one to answer.
     *
     * The turn-silence sweep ends a turn *locally* — nothing is sent to the agent
     * and the request stays outstanding — so "the agent replies to a turn this
     * daemon already gave up on" is a real state rather than a hypothetical, and
     * it is the one that decides whether the ending is written twice. There is no
     * other way to reach it: every other rig here answers immediately.
     */
    answerStalled: () => boolean;
    /** How many prompts this rig is still sitting on. */
    stalledCount: () => number;
    /**
     * Every method this rig has been sent, in order, notifications included.
     *
     * The only observable that can say what was **not** sent. `resumes`,
     * `configSets` and `stops` each record one method, and `default:` answers a
     * request and drops a notification without a word — so a rig that is asked to
     * cancel a turn looks exactly like one that was not.
     */
    inbound: () => readonly string[];
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
    /**
     * The `clientCapabilities` this daemon declared, whole.
     *
     * `declaredFileIo` above is one projected boolean and this is the bag it came
     * out of, kept separately rather than replacing it: the existing cases assert
     * a *change* in the fs half across a retry, and a deep object would make every
     * one of them read worse for no gain. This is here for the capability that has
     * no second signal at all — see the AIR block below.
     */
    caps: () => Record<string, unknown>;
    /**
     * Push a `session/update` from the agent, out of turn.
     *
     * The only way to drive background work: the three task updates arrive
     * between turns by definition, so nothing this rig answers can produce one.
     * `null` before any agent has launched.
     */
    notify: (sessionId: string, update: Record<string, unknown>) => void;
    /** What `_session/async_task/stop` was asked to stop, in order. */
    stops: () => { sessionId: string; asyncTaskId: string }[];
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
    /**
     * What `_session/async_task/stop` answers.
     *
     * `true` and `false` are both ordinary answers on that method — `false` means
     * the task had already finished — and `"error"` is the third thing an agent
     * can do, which is the one the row has a sentence for. Default `true`.
     */
    stopAnswer?: boolean | "error";
    /**
     * What the agent answers about the AIR extension on `initialize`.
     *
     * Four shapes, because `agentAdvertisesAsyncTasks` is a gate with four ways
     * through and `reportsBackgroundTasks` — the field that tells *nothing is
     * running* from *nobody asked* — was `false` in every driver in this
     * repository, so neither direction of it was ever exercised. `true` answers
     * the shape claude-agent-acp 0.73.0 really sends; `undefined`/`false` answer
     * no `_meta` at all, which is kimi's; `"old"` answers a version below ours;
     * `"unnamed"` answers the right version with `asyncTasks` missing from the
     * list. The last two are the arms a version bump or a rename would break, and
     * nothing could reach them.
     */
    advertisesTasks?: boolean | "old" | "unnamed";
    /**
     * Fired while the agent is handling `session/set_config_option`, before it
     * answers.
     *
     * The one window nothing else here can reach: strictly **after** `onStarted`
     * has published and assigned `session`, and strictly **inside**
     * `restoreConfig`'s replay. A tap landing there passes every guard that reads
     * the exit or the session and is then overwritten by a snapshot captured
     * before it, which is a silent `ok`.
     */
    onConfigSet?: () => void;
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
    const stops: { sessionId: string; asyncTaskId: string }[] = [];
    // Prompts this rig was told to sit on, each as the reply that would end it.
    // See `answerStalled` on the returned handle.
    const stalled: (() => void)[] = [];
    // Every method this rig has been sent, in order. See the push site.
    const inbound: string[] = [];
    let caps: Record<string, unknown> = {};
    /*
     * How to push into each agent, keyed by the conversation it holds.
     *
     * ⚠ **Per session and not per launch**, which is a correction rather than
     * thoroughness: this rig makes a fresh pair of pipes per agent, so a single
     * captured `send` is whichever agent started *last*, and a case that resumes
     * two sessions then pushes into the first one addresses the second one's
     * connection — where the id is not registered and the update is dropped on
     * the floor with no error anywhere. Recorded where the agent learns which
     * conversation it is holding, which is `session/resume` and `session/new`.
     */
    const pushes = new Map<string, (message: unknown) => void>();
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
            /*
             * Every method, before the dispatch and including the ones that fall
             * to `default:`.
             *
             * ⚠ **A notification leaves no other trace here.** `default:` answers
             * only when there is an `id`, so a `session/cancel` — the exact thing
             * the turn-silence sweep must never send — arrived, was dropped, and
             * was invisible to every observable this rig had. The check that
             * claimed "nothing was sent to the agent" was counting *unanswered
             * prompts*, which is true however much traffic goes the other way.
             */
            inbound.push(String(message["method"] ?? ""));
            switch (message["method"]) {
              case acp.methods.agent.initialize:
                caps = ((message["params"] as any)?.clientCapabilities ?? {}) as Record<string, unknown>;
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
                    // The mirror of the object this daemon sends, read back by
                    // `agentAdvertisesAsyncTasks`. Absent by default, which is
                    // what three of the four real agents send.
                    ...(options.advertisesTasks === undefined || options.advertisesTasks === false
                      ? {}
                      : {
                          _meta: {
                            jetbrains: {
                              air: {
                                version: options.advertisesTasks === "old" ? 0 : 1,
                                capabilities:
                                  options.advertisesTasks === "unnamed" ? ["somethingElse"] : ["asyncTasks"],
                              },
                            },
                          },
                        }),
                  },
                });
                break;
              // Needed by the recovery path — a cleared conversation the agent
              // never wrote down is replaced with a fresh one, and that goes
              // through `session/new` rather than `session/resume`.
              case acp.methods.agent.session.new:
                opened += 1;
                pushes.set(`conv_${opened}`, send);
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
                options.onConfigSet?.();
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
                pushes.set(String(params["sessionId"]), send);
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
                if (options.stallPrompt === true) {
                  /*
                   * Kept rather than dropped, so a driver can answer it *later*.
                   * The turn-silence sweep closes a turn locally and leaves the
                   * request outstanding on purpose, so "what happens when the
                   * agent finally replies" is a real state of this daemon and not
                   * a hypothetical — and it is unreachable without a rig that can
                   * be made to reply on command.
                   */
                  stalled.push(() => send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } }));
                  break;
                }
                send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
                break;
              // Written out rather than left to `default`, which answers `{}` —
              // and `{}` is `stopped: false`, i.e. the one answer that looks like
              // a successful race rather than like a rig that was never asked.
              case "_session/async_task/stop": {
                const params = message["params"] as Record<string, any>;
                stops.push({
                  sessionId: String(params["sessionId"]),
                  asyncTaskId: String(params["asyncTaskId"]),
                });
                if (options.stopAnswer === "error") {
                  send({ jsonrpc: "2.0", id, error: { code: -32603, message: "task is not stoppable" } });
                } else {
                  send({ jsonrpc: "2.0", id, result: { stopped: options.stopAnswer ?? true } });
                }
                break;
              }
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
      /**
       * Answer the oldest prompt this rig was told to sit on, and say whether
       * there was one.
       */
      answerStalled: (): boolean => {
        const reply = stalled.shift();
        reply?.();
        return reply !== undefined;
      },
      stalledCount: () => stalled.length,
      inbound: () => inbound,
      launches: () => launched,
      resumes: () => resumes,
      fileIoAtResume: () => fileIoAtResume,
      peak: () => peak,
      disposed: () => ended,
      configSets: () => configSets,
      caps: () => caps,
      stops: () => stops,
      notify: (sessionId, update) => {
        pushes.get(sessionId)?.({
          jsonrpc: "2.0",
          method: "session/update",
          params: { sessionId, update },
        });
      },
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
    /*
     * ⚠ **`ceilingFloorMs: 0` is what makes the cases below reach the eviction at
     * all, and saying so is the point rather than a nuisance.**
     *
     * `releaseOneSlot` will not take a session that has only *just* gone idle —
     * `CEILING_PARK_FLOOR_MS`, two minutes — because an agent whose turn ended
     * seconds ago may be running something it did not say it was running. Every
     * fixture here resumes and reaches the ceiling in the same millisecond, which
     * is exactly that shape, so the floor is faked to zero for the eviction cases
     * and asserted for real in the block below.
     *
     * ⚠ The margin is no longer the *only* defence — `parkable` refuses outright
     * over work claude reports (Q2.228), driven in its own block further down —
     * but it is still the whole of what stands for kimi, codex, opencode and for
     * claude's backgrounded subagents, which the adapter marks `ignored`. Q7.113.
     */
    own.setSessionLimits({ live: 1, ceilingFloorMs: 0 });

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
     * ⚠ **And the floor, against the real default rather than the faked one.**
     *
     * `releaseOneSlot` ignores the sweep's threshold on purpose — the sweep
     * releases by age because nobody asked, a ceiling releases by need because
     * somebody is asking — but it used to ignore the clock *entirely*, asking for
     * candidates at `idleMs: 0`. That made the age clause vacuously true, so a
     * create or a wake could take an agent whose turn had ended seconds earlier,
     * which is the case `parkable` can only partly rule out: a session running a
     * backgrounded build reports `idle`, and only claude says so (Q2.228, Q7.113).
     * So the ceiling keeps a two-minute margin for the rest.
     *
     * Driven by putting the floor back and asserting the *refusal*: `s_live` was
     * resumed moments ago, so it is inside the margin and must not be taken, and
     * the request must reach the ceiling's refusal rather than the filesystem.
     */
    await own.get("s_live")?.resume();
    check("a quiet agent is back for the floor case", own.get("s_live")?.status, "idle");
    own.setSessionLimits({ live: 1, ceilingFloorMs: 2 * 60_000 });
    check("a just-idle agent is not taken for a slot", await refusal(gone), "too_many_sessions");
    check("and it still has its agent", own.get("s_live")?.status, "idle");
    // Faked back down, and the same session is then taken — which is what says the
    // refusal above was the floor rather than anything else about this fixture.
    own.setSessionLimits({ live: 1, ceilingFloorMs: 0 });
    check("while with the floor faked away it is", await refusal(gone), "PathError");
    check("and that is where the slot came from", own.get("s_live")?.exit?.reason, "parked");
    own.setSessionLimits({ live: 8, ceilingFloorMs: 0 });

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
    busy.setSessionLimits({ live: 1, ceilingFloorMs: 0 });
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
    own.setSessionLimits({ live: 8, ceilingFloorMs: 0 });
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
    own.setSessionLimits({ live: 8, idleParkMs: 0, ceilingFloorMs: 0 });
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
    own.setSessionLimits({ live: 1, idleParkMs: 0, ceilingFloorMs: 0 });
    check("but at the ceiling it declines to take one anyway", await refusal(gone), "too_many_sessions");
    check("and the quiet session it would have taken is untouched", own.get("s_live")?.status, "idle");
    own.setSessionLimits({ live: 8, idleParkMs: 45 * 60_000, ceilingFloorMs: 0 });

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
    // `ceilingFloorMs: 0` because these three resume in the same millisecond the
    // create below asks for a slot, which is inside `CEILING_PARK_FLOOR_MS` — the
    // margin that stops the ceiling taking an agent whose turn has only just
    // ended. The floor's own behaviour is asserted against the real default in the
    // ceiling block above; here it is faked so the *trigger* is what is under test.
    own.setSessionLimits({ live: 2, idleParkMs: 45 * 60_000, ceilingFloorMs: 0 });
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
   * ⭐ **A turn the agent never answers, and the only thing in this process that
   * can end one.**
   *
   * The failure this closes was reported as a panel reading *working* hours after
   * the agent had finished, and the mechanism is three facts that only bite
   * together. `status` is derived, and `running` is `this.turn !== null` and
   * nothing else. `this.turn` is cleared in exactly one place — `pump`'s `finally`
   * — reached only when the turn's generator returns, which happens only on a
   * `turn_end` or an `error`, both of which are produced only by the
   * `session/prompt` request settling. And that request is the one RPC in
   * `session.ts` fired with **no deadline**, deliberately, because a real turn may
   * run for hours.
   *
   * So an adapter that stops answering pins a session at `running` for the life of
   * the daemon. Everything a person could reach for is powerless: `POST /cancel`
   * waits on `waitForTurnToSettle`, which polls the flag that same request clears;
   * the idle sweep asks `parkable`, whose first line refuses anything that is not
   * `idle`; the ceiling's eviction asks the same predicate. The session also holds
   * one of `MAX_LIVE_SESSIONS` and its agent's ~397 MB for ever.
   *
   * Driven through the real registry with a rig that takes prompts and sits on
   * them, for the reason the parking section above gives: the precondition is a
   * *derived* status, and a fixture that sets one is a fixture asserting against
   * the thing under test.
   */
  {
    const rig = rigWith({ resume: true, stallPrompt: true });
    const store = storeOf([
      interruptedRow("s_wedged", "daemon_restarted", "a_wedged"),
      interruptedRow("s_awake", "daemon_restarted", "a_awake"),
    ]);
    const own = new SessionRegistry(new MemoryEventStore(), store, undefined, rig.runtime);
    own.restore({ reapOrphans: false });
    await own.autoResume({ ...options, concurrency: 1 });
    const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 25));

    const wedged = own.get("s_wedged");
    const awake = own.get("s_awake");
    const endsOf = (id: string) =>
      (own.get(id)?.log.read(0, 1000, 1 << 20) ?? [])
        .map((stored) => stored.event)
        .filter((event) => event.type === "turn_end")
        .map((event) => (event.type === "turn_end" ? event.stopReason : null));

    const sent = await wedged?.prompt("say something");
    await settle();
    /*
     * ⚠ **The clock is taken here rather than from `now`, and that is a real
     * defect this section shipped with for an afternoon.** `now` is stamped when
     * `daemoncheck.fixtures.ts` is first imported — module 1 of 23 — while
     * `wedged` measures against the *real* `turnStartedAt`. So
     * `abandonWedgedTurns(now + TURN_SILENCE_MS)` only fires while the eight modules
     * ahead of this one have taken under 60 seconds, which is an undeclared
     * wall-clock budget on a driver that has no other one. A slower runner, a cold
     * `tmp`, or one more section inserted above would have turned it red — and the
     * failure would have read as `abandonWedgedTurns` being broken, since the two
     * floor rows above it stay green. Taken after the prompt, so the margin is the
     * margin and nothing else can spend it.
     */
    const started = Date.now();
    check("a prompt nobody answers leaves the session running", [sent?.kind, wedged?.status], ["accepted", "running"]);
    check("and the rig really is sitting on it", rig.stalledCount(), 1);

    /*
     * The floor, and it is asserted before every "was given up on" below for the
     * reason the park sweep's own floor is: a reaper that took everything would
     * satisfy all of them. Two rows rather than one, because the interesting
     * boundary is not *zero* — it is a turn that has been going a long time and
     * is still inside the hour.
     */
    check("a turn that has just started is left alone", own.abandonWedgedTurns(started), []);
    check("and so is one still inside the window", own.abandonWedgedTurns(started + 179 * 60_000), []);

    /*
     * ⚠ **Both sessions have now been quiet for the same hour, and only one of
     * them is taken** — which is the whole of "nothing that is not running is a
     * candidate", asserted as the sweep's *answer* rather than by asking the
     * predicate. `s_awake` is idle at exactly the same age; a reaper keyed on
     * silence alone rather than on a turn would return both.
     */
    const later = started + 181 * 60_000;
    check("past it the daemon stops waiting, and only on the turn", own.abandonWedgedTurns(later), ["s_wedged"]);
    check("the idle conversation beside it is untouched at the same age", [awake?.status, awake?.exit], ["idle", null]);

    /*
     * The ending goes through the queue the turn's generator is parked on, so
     * `pump`'s `finally` — and everything downstream of it — lands a tick later.
     * Asserting before this is asserting against the mechanism rather than the
     * outcome, which is what the first run of this section did.
     */
    await settle();

    /*
     * What "gave up" means, stated as the facts a person would check — and the
     * first two are the whole point of doing this locally rather than by stopping
     * anything. The conversation is **usable**, not ended: no exit record, no
     * `parked`, no `stopping`. That is the difference between this and the two
     * verbs that already existed.
     */
    check("and the session is idle rather than ended", [wedged?.status, wedged?.exit], ["idle", null]);
    check("the conversation is still there, with its agent", [own.get("s_wedged") !== undefined, wedged?.agentSessionId], [true, "a_wedged"]);
    check("the turn is closed in the transcript, once, and says why", endsOf("s_wedged"), ["abandoned"]);
    /*
     * ⚠ **What the agent was sent, not what it failed to answer.** This read
     * `stalledCount() === 1`, which says only that the outstanding prompt is still
     * outstanding — true however much traffic goes the other way. Adding a
     * `session/cancel` to `abandonTurn`, which is the third stopping verb Q2.42
     * forbids and the whole reason this ends the turn locally, would have left
     * every row in this section green: the rig dispatches on `method`, a
     * notification has no `id`, and `default:` drops it without a word. So the
     * property is asserted against the methods themselves, as a list rather than a
     * count — `session/prompt` twice for the two turns, and nothing else after the
     * handshake.
     */
    check(
      "and nothing was sent to the agent to make it happen",
      rig.inbound().filter((method) => method.startsWith("session/") && method !== "session/prompt"),
      ["session/resume", "session/resume"],
    );
    check("a turn already given up on is not given up on twice", own.abandonWedgedTurns(later), []);

    /*
     * ⚠ **The half that would have made this a worse bug than the one it fixes.**
     *
     * `turnActive` is `Session`'s own guard against two prompts in flight, and it
     * is cleared **only** inside the outstanding request's callbacks. A turn
     * closed without those running would read as idle, open the composer, accept
     * the next message — and then throw *"a prompt is already in flight for this
     * session"* into the transcript, for every message, for the rest of the
     * session. `abandonTurn` clears it itself; this is the row that says so.
     */
    const again = await wedged?.prompt("are you there");
    await settle();
    check("and the next message really does start a turn", [again?.kind, wedged?.status], ["accepted", "running"]);
    check("rather than being refused as one already in flight", rig.stalledCount(), 2);
    const errors = (wedged?.log.read(0, 1000, 1 << 20) ?? [])
      .map((stored) => stored.event)
      .filter((event) => event.type === "error");
    check("with nothing recorded about a prompt in flight", errors.length, 0);

    /*
     * ⚠ **And the half that would have cut a live turn short.** The abandoned
     * request is still outstanding and may settle at any time — here, an hour
     * later, with a second turn already running. Its `.then` is fenced on the
     * epoch it was fired under, so it ends nothing: not the turn it belonged to,
     * which is already closed and may be written only once, and above all not the
     * turn that is running now.
     */
    check("the agent's late answer is accepted by the rig", rig.answerStalled(), true);
    await settle();
    check("but it does not end the turn it no longer belongs to", endsOf("s_wedged"), ["abandoned"]);
    check("and the live turn is still live", wedged?.status, "running");

    // And the ordinary ending still works afterwards, which is what says the
    // epoch fence closed one door rather than the corridor.
    check("the second turn's own answer is the rig's", rig.answerStalled(), true);
    await settle();
    check("and it ends the turn it belongs to", endsOf("s_wedged"), ["abandoned", "end_turn"]);
    check("leaving the session idle and ordinary", wedged?.status, "idle");

    await own.shutdown();
  }

  /*
   * ⭐ **A message typed into a stuck session does not hide the wedge — and the
   * clock this is about was the wrong one for an afternoon.**
   *
   * `wedged` measured `lastActivityAt`, which every write moves, the person's own
   * messages included: `recordPrompt` appends through `safeAppend`, which stamps
   * it. So somebody typing into a session that says *working* reset the silence
   * clock on every message, and the one state this daemon cannot otherwise escape
   * was kept alive by the person trying to escape it. It is not hypothetical —
   * the session that produced the bug report took three prompts inside its open
   * turn (04:28:35, 04:32:16, 04:38:44), each one a reset.
   *
   * Driven with a real mid-turn send rather than by calling the predicate,
   * because the whole point is *which field the append moves*, and a fixture that
   * sets a field is a fixture asserting against the thing under test.
   *
   * The second half is what the wedge predicate deliberately does **not** refuse
   * on, stated as an outcome: `parkable` bails on a non-empty queue and this one
   * does not, because ending the turn is what runs `deliverQueued` from `pump`'s
   * `finally`. Refusing would strand the very message the queue is holding.
   */
  {
    const rig = rigWith({ resume: true, stallPrompt: true });
    const store = storeOf([interruptedRow("s_poked", "daemon_restarted", "a_poked")]);
    const own = new SessionRegistry(new MemoryEventStore(), store, undefined, rig.runtime);
    own.restore({ reapOrphans: false });
    await own.autoResume({ ...options, concurrency: 1 });
    const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 25));

    const poked = own.get("s_poked");
    await poked?.prompt("go and think about it");
    /*
     * ⚠ **The one declared wall-clock budget in this section: 200ms either side of
     * `started`, and both halves are load-bearing.** The outcome row below fires
     * only if `turnStartedAt` sits measurably *before* `started`, and fails to
     * fire under the wrong clock only if the person's append sits measurably
     * *after* it. Written as two explicit waits because the first attempt used
     * `settle()` on one side and nothing on the other: `Date.now()` has
     * millisecond resolution and the statements between `started` and the send
     * take less than one, so the two clocks landed on the same number and the row
     * passed with either of them. Nothing else in this block depends on how long
     * anything took — this is a 400ms budget with a 200ms margin, not the
     * invisible sixty seconds the section above this one used to carry.
     */
    await new Promise((resolve) => setTimeout(resolve, 200));
    const started = Date.now();
    check("a turn is open and nothing has answered it", [poked?.status, rig.stalledCount()], ["running", 1]);
    await new Promise((resolve) => setTimeout(resolve, 200));

    /*
     * The message, and it is asserted as *recorded* rather than merely accepted:
     * a send that never reached the log could not have moved any clock, which
     * would make the row below pass for the wrong reason.
     */
    const agentClockBefore = poked?.lastAgentActivityAt ?? 0;
    const poke = await poked?.sendMidTurn("are you working?");
    await settle();
    check(
      "a message sent mid-turn is queued and written down",
      [poke?.kind, poke?.kind === "queued" && poke.seq > 0],
      ["queued", true],
    );
    check("and the agent was not sent it", rig.stalledCount(), 1);

    /*
     * ⚠ **The mechanism first, and it needs no clock at all.** One field moved and
     * the other did not — that is the whole property, and it is the half a sweep
     * cannot show: the two clocks are milliseconds apart in a driver, so a row
     * that only watched `abandonWedgedTurns`'s answer passed identically with the
     * wrong field restored. Found exactly that way.
     */
    check(
      "the person's message moves the session's clock but not the agent's",
      [(poked?.lastActivityAt ?? 0) > (poked?.lastAgentActivityAt ?? 0), poked?.lastAgentActivityAt ?? 0],
      [true, agentClockBefore],
    );
    /*
     * Then the outcome, at exactly the threshold rather than a minute past it —
     * which is what makes it discriminate. Measuring the agent's clock the gap is
     * `silence + 200ms` and the sweep fires; measuring the session's it is
     * `silence - 200ms` and it does not. A minute of slack, which is what this
     * row carried at first, swallows the difference and the check means nothing.
     */
    check(
      "so the sweep still sees the silence it is measuring",
      own.abandonWedgedTurns(started + TURN_SILENCE_MS),
      ["s_poked"],
    );
    await settle();

    /*
     * And the queue drains into a turn of its own rather than being stranded,
     * which is `pump`'s `finally` reached the ordinary way. The rig is sitting on
     * two prompts now: the abandoned one, still outstanding at the agent, and this.
     */
    check("and the message it was holding is delivered rather than stranded", rig.stalledCount(), 2);
    check("as a turn of its own", poked?.status, "running");

    await own.shutdown();
  }

  /*
   * Zero switches it off, which is the documented way and therefore the one that
   * has to be pinned. It is a separate registry because `setSessionLimits` is
   * per-registry, and a separate section because what it asserts is the *absence*
   * of the sweep rather than another of its refusals.
   */
  {
    const rig = rigWith({ resume: true, stallPrompt: true });
    const store = storeOf([interruptedRow("s_forever", "daemon_restarted", "a_forever")]);
    const own = new SessionRegistry(new MemoryEventStore(), store, undefined, rig.runtime);
    own.setSessionLimits({ turnSilenceMs: 0 });
    own.restore({ reapOrphans: false });
    await own.autoResume({ ...options, concurrency: 1 });
    const forever = own.get("s_forever");
    await forever?.prompt("say something");
    await new Promise((resolve) => setTimeout(resolve, 25));
    check("with the sweep off the switch says so", own.turnSilenceEnabled, false);
    check("and a wedged turn stays wedged, however long", own.abandonWedgedTurns(now + 365 * 24 * 60 * 60_000), []);
    check("which is the old behaviour, kept reachable on purpose", forever?.status, "running");
    await own.shutdown();
  }

  /*
   * Work the agent left running, and the one thing parking must not take.
   *
   * **The whole feature is that `status` cannot see this.** A session running a
   * backgrounded build reports `idle` honestly — the turn ended — so before the
   * clause below, the sweep released it and the agent's own shutdown group-killed
   * every shell it had backgrounded. Measured on the development machine's live
   * log: `s_5d26f98e` was parked 60m14s after its last event, with nothing having
   * moved the idle clock in between. Q2.228.
   *
   * Driven through the real registry and a real `session/update`, never by
   * calling `parkable` on a hand-built object: the precondition is a *derived*
   * status plus a set fed from the wire, and a fixture that assigns either is
   * asserting against the thing under test.
   */
  {
    const rig = rigWith({ resume: true });
    const store = storeOf([
      interruptedRow("s_bg", "daemon_restarted", "a_bg"),
      interruptedRow("s_plain", "daemon_restarted", "a_plain"),
    ]);
    const own = new SessionRegistry(new MemoryEventStore(), store, undefined, rig.runtime);
    own.restore({ reapOrphans: false });
    await own.autoResume({ ...options, concurrency: 1 });
    const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 25));

    /*
     * ⚠ **First, the thing the daemon *sends* — and it is the only assertion here
     * with no second signal behind it.**
     *
     * The adapter's gate wants a finite integer version of at least 1 *and* the
     * capability named in a list. A declaration it refuses switches the whole
     * lifecycle off with **no error on any wire**: no rejection, no log line, just
     * a client that is never told about background work and a clause that never
     * fires. Every other row below would go on passing, because they drive the
     * updates by hand. This is the one that would not.
     */
    check("the daemon asks to hear about background work", rig.caps()["_meta"], {
      jetbrains: { air: { version: 1, capabilities: ["asyncTasks"] } },
    });

    /*
     * **The negative, first, so every "was not released" below means something.**
     * A clause implemented as "claude never parks" satisfies all of them.
     */
    rig.notify("a_bg", {
      sessionUpdate: "async_task_spawned",
      asyncTaskId: "task_1",
      name: "sleep 600",
      taskType: "shell",
      description: "running the build",
      showInTranscript: false,
      canStop: true,
    });
    await settle();
    const bg = own.get("s_bg");
    check("the agent announced work and the session says so", bg?.snapshot().backgroundTasks.map((task) => [task.id, task.state]), [["task_1", "running"]]);
    check("and still reads as an ordinary quiet session", bg?.status, "idle");

    /*
     * **The negative, so every "was not released" below means something.** A
     * clause implemented as "claude never parks" satisfies all of them, and so
     * does one that switched the sweep off. The two sessions are identical bar
     * the announcement.
     */
    check("the one with nothing running is still released", await own.parkIdleSessions(now + 31 * 60_000), ["s_plain"]);

    /*
     * ⚠ **However long it has been quiet.** The threshold is about *age* and a
     * build gets older while it runs, which is exactly why this is a clause rather
     * than a larger number.
     */
    check("a session with work still running is not released", await own.parkIdleSessions(now + 24 * 60 * 60_000), []);
    check("and it still holds its agent", own.liveSessionCount, 1);

    /*
     * ⚠ **And the refusal is the task rather than the fixture**, which is the row
     * that fails loudly if somebody implements this as "an agent that reports
     * background work never parks".
     */
    rig.notify("a_bg", {
      sessionUpdate: "async_task_state_update",
      asyncTaskId: "task_1",
      state: "completed",
      summary: "build finished",
    });
    await settle();
    check("the work ending is on the wire", bg?.snapshot().backgroundTasks.map((task) => task.state), ["completed"]);
    check("and the same sweep now releases it", await own.parkIdleSessions(now + 24 * 60 * 60_000), ["s_bg"]);
    /*
     * A terminal task is **kept**, not dropped — except that this one was parked,
     * and parking clears the set outright. Both halves in one line: the session is
     * released, and a released session claims nothing about processes that are
     * gone.
     */
    check("and a released session claims no running work", own.get("s_bg")?.snapshot().backgroundTasks, []);

    await own.shutdown();
  }

  /*
   * ⚠ **The daemon numbers the messages an agent forgot to number, and that is
   * what keeps twenty of them from becoming one paragraph.**
   *
   * ACP's `messageId` is the only boundary a client gets — *"a change in
   * `messageId` indicates a new message has started"* — and a transcript joins a
   * run's parts with no separator, which is right for the streamed fragments of
   * one message and wrong for two messages in a row.
   *
   * Measured in `claude-agent-acp` 0.73.0, and this is the case the rule exists
   * for: every path through `toAcpNotifications` calls `applyMessageId`, but
   * `AsyncTaskRuntime` publishes its `**Task stopped by user:** <name>.` line as
   * a **bare** update. Stopping twenty tasks is therefore twenty whole messages,
   * none numbered and none ending in a newline, which drew as one run-on line.
   *
   * So: the first id proves the connection numbers, and from then on an
   * unnumbered message gets a `~`-prefixed id of its own. Driven as the whole
   * partition, because the arm that must **not** change is an agent that never
   * numbers anything — kimi, codex and opencode send nothing here, and every
   * chunk of theirs has to go on joining.
   */
  {
    const rig = rigWith({ resume: true });
    const store = storeOf([
      interruptedRow("s_num", "daemon_restarted", "a_num"),
      interruptedRow("s_bare", "daemon_restarted", "a_bare"),
    ]);
    const own = new SessionRegistry(new MemoryEventStore(), store, undefined, rig.runtime);
    own.restore({ reapOrphans: false });
    await own.autoResume({ ...options, concurrency: 2 });
    const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 25));
    const say = (agent: string, text: string, messageId?: string): void =>
      rig.notify(agent, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text },
        ...(messageId === undefined ? {} : { messageId }),
      });
    const idsOf = (id: string): unknown[] =>
      (own.get(id)?.log.read(0, 1000, 1024 * 1024) ?? [])
        .filter((stored) => stored.event.type === "text")
        .map((stored) => (stored.event as { messageId: string | null }).messageId);

    say("a_num", "he", "m1");
    say("a_num", "llo", "m1");
    say("a_num", "**Task stopped by user:** one.");
    say("a_num", "**Task stopped by user:** two.");
    say("a_num", "back to prose", "m2");
    await settle();
    check(
      "the agent's own ids are carried, and what it left unnumbered gets a number here",
      idsOf("s_num"),
      ["m1", "m1", "~1", "~2", "m2"],
    );

    say("a_bare", "he");
    say("a_bare", "llo");
    await settle();
    check("while an agent that numbers nothing keeps joining as it always did", idsOf("s_bare"), [
      null,
      null,
    ]);
    await own.shutdown();
  }

  /*
   * ⚠ **A terminal state is not final, and this is measured rather than defensive.**
   *
   * Driven against a real claude 2.1.268 under claude-agent-acp 0.73.0, 2026-09-11
   * — background `sleep 5` inside a turn held open by a foreground `sleep 30` —
   * the end of one task arrives as **two** updates in this order: `stopped`, then
   * `completed`. The first is the adapter closing a task it stopped seeing in the
   * CLI's own background-task level; the second is the real edge landing behind
   * it. A fold that refused a second terminal word, or that kept the first
   * because it was terminal already, would leave every finished shell in this
   * app's `Completed` section labelled `(stopped)` — which reads as *somebody
   * stopped it* about a build that succeeded.
   */
  {
    const rig = rigWith({ resume: true });
    const store = storeOf([interruptedRow("s_fix", "daemon_restarted", "a_fix")]);
    const own = new SessionRegistry(new MemoryEventStore(), store, undefined, rig.runtime);
    own.restore({ reapOrphans: false });
    await own.autoResume({ ...options, concurrency: 1 });
    const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 25));
    rig.notify("a_fix", {
      sessionUpdate: "async_task_spawned",
      asyncTaskId: "t",
      name: "t",
      taskType: "shell",
      description: "",
      showInTranscript: false,
      canStop: true,
    });
    rig.notify("a_fix", { sessionUpdate: "async_task_state_update", asyncTaskId: "t", state: "stopped" });
    await settle();
    check("a level-derived close lands first", own.get("s_fix")?.snapshot().backgroundTasks.map((task) => task.state), ["stopped"]);
    rig.notify("a_fix", { sessionUpdate: "async_task_state_update", asyncTaskId: "t", state: "completed" });
    await settle();
    check("and the real edge behind it corrects the row", own.get("s_fix")?.snapshot().backgroundTasks.map((task) => task.state), ["completed"]);
    /*
     * ⚠ **And the correction must not move the clock.** `endedAt` is this
     * daemon's own stamp, and it exists because nothing on the wire carries one:
     * the adapter's `publishState` sends no time at all, drops the SDK's final
     * `usage` — the one guaranteed `duration_ms` — and reads `end_time` from
     * nothing. So the panel measures a finished card against this field, and a
     * second terminal word *relabelling* one end must not push it out: the two
     * updates above are half a settle apart here and can be minutes apart on a
     * real agent, which is a completed build whose elapsed time grew after it
     * finished. Asserted as identity across the pair rather than as a range.
     */
    const stampedAt = own.get("s_fix")?.snapshot().backgroundTasks[0]?.endedAt ?? null;
    check("the end was stamped when it ended", typeof stampedAt === "number" && stampedAt > 0, true);
    rig.notify("a_fix", { sessionUpdate: "async_task_state_update", asyncTaskId: "t", state: "failed" });
    await settle();
    check(
      "and a second terminal word relabels the row without moving its end",
      own.get("s_fix")?.snapshot().backgroundTasks.map((task) => [task.state, task.endedAt === stampedAt]),
      [["failed", true]],
    );
    /*
     * The other direction, which is the reason this is not simply "stamp once":
     * a row that goes live again did not end, and a kept stamp would freeze its
     * elapsed time at a moment it has since passed.
     */
    rig.notify("a_fix", { sessionUpdate: "async_task_state_update", asyncTaskId: "t", state: "running" });
    await settle();
    check(
      "while a row that is running again has no end at all",
      own.get("s_fix")?.snapshot().backgroundTasks.map((task) => [task.state, task.endedAt]),
      [["running", null]],
    );
    rig.notify("a_fix", { sessionUpdate: "async_task_state_update", asyncTaskId: "t", state: "completed" });
    await settle();
    /*
     * And the fields that arrive *late*, which is the other half of the same
     * measurement: the spawn carries neither `outputFilePath` nor `toolCallId`,
     * and both turn up on a later update. A fold that only merged on a spawn
     * would carry neither, ever.
     */
    rig.notify("a_fix", {
      sessionUpdate: "async_task_progress",
      asyncTaskId: "t",
      toolCallId: "toolu_late",
      outputFilePath: "/tmp/x/tasks/t.output",
    });
    await settle();
    check(
      "and correlation that arrives late is merged rather than dropped",
      own.get("s_fix")?.snapshot().backgroundTasks.map((task) => [task.toolCallId, task.outputFilePath]),
      [["toolu_late", "/tmp/x/tasks/t.output"]],
    );
    await own.shutdown();
  }

  /*
   * Each terminal word releases, and `paused` does not.
   *
   * Four rows rather than one, because our live test is the complement of the
   * adapter's `isTerminal` and a hand-written list of "the finished ones" is
   * precisely what goes out of step when a sixth word is added. `paused` is the
   * one that looks finished and is not — the work is still there, holding its
   * files, waiting to be resumed.
   */
  {
    const words = ["completed", "failed", "stopped", "paused"] as const;
    const released: string[] = [];
    for (const word of words) {
      const rig = rigWith({ resume: true });
      const store = storeOf([interruptedRow(`s_${word}`, "daemon_restarted", `a_${word}`)]);
      const own = new SessionRegistry(new MemoryEventStore(), store, undefined, rig.runtime);
      own.restore({ reapOrphans: false });
      await own.autoResume({ ...options, concurrency: 1 });
      const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 25));
      rig.notify(`a_${word}`, {
        sessionUpdate: "async_task_spawned",
        asyncTaskId: "t",
        name: "t",
        taskType: "shell",
        description: "",
        showInTranscript: false,
        canStop: true,
      });
      rig.notify(`a_${word}`, { sessionUpdate: "async_task_state_update", asyncTaskId: "t", state: word });
      await settle();
      const parked = await own.parkIdleSessions(now + 31 * 60_000);
      if (parked.length > 0) released.push(word);
      await own.shutdown();
    }
    check("the three terminal words release and paused does not", released, ["completed", "failed", "stopped"]);
  }

  /*
   * The ceiling asks the same question, and gets the same answer for free.
   *
   * `releaseOneSlot` goes through `parkCandidates` → `parkable`, so the clause
   * arrives there with nothing threaded — and the consequence is worth driving
   * rather than assuming: **at the ceiling with nothing takeable, `create`
   * refuses**, which is a session somebody does not get so that a build somebody
   * is running survives. `ceilingFloorMs: 0` is faked away so the refusal is the
   * task rather than the two-minute margin, which is the same trick the block
   * above this one uses for the opposite purpose.
   *
   * The `PathError`-versus-refusal ordering is what says which gate answered:
   * the cwd does not exist, so a request that gets *past* the ceiling dies on the
   * path instead.
   */
  {
    const rig = rigWith({ resume: true });
    const store = storeOf([interruptedRow("s_only", "daemon_restarted", "a_only")]);
    const own = new SessionRegistry(new MemoryEventStore(), store, undefined, rig.runtime);
    own.restore({ reapOrphans: false });
    await own.autoResume({ ...options, concurrency: 1 });
    const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 25));
    own.setSessionLimits({ live: 1, ceilingFloorMs: 0 });
    const gone = join(users, "u_alice", "no_such_dir_at_all");
    const refusal = async (cwd: string): Promise<string> =>
      own.create({ agent: "kimi", cwd }).then(
        () => "created",
        (error: unknown) => (error instanceof SessionLimitError ? error.reason : (error as Error).name),
      );

    check("with nothing running, the one idle agent is still taken for a slot", await refusal(gone), "PathError");
    check("and that is where the slot came from", own.get("s_only")?.exit?.reason, "parked");

    await own.get("s_only")?.resume();
    rig.notify("a_only", {
      sessionUpdate: "async_task_spawned",
      asyncTaskId: "build",
      name: "build",
      taskType: "shell",
      description: "",
      showInTranscript: false,
      canStop: true,
    });
    await settle();
    check("but an agent running something is not, and the create is refused", await refusal(gone), "too_many_sessions");
    check("and it still has its agent", own.get("s_only")?.status, "idle");

    /*
     * ⚠ **And what a stop does to a set it cannot honour.**
     *
     * A person ending this session takes the agent away, and the agent's own
     * shutdown group-kills what it backgrounded — so the set describes processes
     * that are gone and every snapshot after this would claim otherwise for ever.
     * Cleared, and said **once**: one row for one act, on
     * `dropQueuedUndelivered`'s precedent, rather than one per task.
     */
    await own.get("s_only")?.stop("stopped");
    const said = (own.get("s_only")?.log.read(0, 1000, 1024 * 1024) ?? [])
      .filter((stored) => stored.event.type === "error")
      .map((stored) => (stored.event as { message: string }).message);
    check("a stop says what it was still running, once", said, [stoppedWithBackgroundWork(1)]);
    check("and the session then claims nothing", own.get("s_only")?.snapshot().backgroundTasks, []);
    /*
     * ⚠ **And the sentence names the agent rather than the session**, because
     * `doStop` is also reached by `daemon_shutdown` and by `restartAgent`'s
     * `config_changed` — the daemon taking the agent away and bringing it straight
     * back. It read "when this session ended", so a deploy wrote that into a
     * conversation that had not ended. Asserted as the words, since the failure is
     * a true sentence about the wrong noun and nothing else would catch it.
     */
    check(
      "and it is the agent that was shut down, never the session that ended",
      [stoppedWithBackgroundWork(1).includes("session"), stoppedWithBackgroundWork(2)],
      [false, "the agent was still running 2 background tasks when it was shut down"],
    );

    await own.shutdown();
  }

  /*
   * ⚠ **A released session is one nobody may be able to tell was released**, and
   * two things gave it away.
   *
   * Q2.224 decided parking shows *nothing*: no mark, no notice, an ordinary quiet
   * session. Its point 7 then kept `agentConfigState` for that reason — the
   * process is coming back to the same conversation, so the controls still
   * describe it. The command list is the same kind of fact and was withdrawn
   * anyway, so a parked session offered a working model picker and an **empty**
   * `/` menu. The withdrawn list is literally `{ commands: [], dropped: 0 }`, so
   * the menu is empty by construction rather than by a count anybody observed —
   * commands are never persisted, so there is no figure here to re-take.
   *
   * ⚠ **And the placeholder moved with it, which is how parking became visible.**
   * `composing.ts` is `state.hasCommands ? "Type / for commands" : "Message…"` and
   * `Composer` feeds it `entries.length > 0`, so withdrawing the list does not
   * leave a stale invitation standing over an empty menu — it rewrites the
   * placeholder under the cursor of somebody who had touched nothing.
   *
   * The second is a row this feature added: a stop that ends live background work
   * writes one `error` into the transcript, and a park must not — the person did
   * not ask for it and cannot act on it.
   */
  {
    const rig = rigWith({ resume: true, config: true });
    const store = storeOf([interruptedRow("s_hush", "daemon_restarted", "a_hush")]);
    const own = new SessionRegistry(new MemoryEventStore(), store, undefined, rig.runtime);
    own.restore({ reapOrphans: false });
    await own.autoResume({ ...options, concurrency: 1 });
    const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 25));
    const hush = own.get("s_hush");

    rig.notify("a_hush", {
      sessionUpdate: "available_commands_update",
      availableCommands: [{ name: "clear", description: "start over" }],
    });
    await settle();
    const liveCommands = hush?.snapshot().agentConfig;
    check("a live session publishes its commands", hush?.agentCommands.commands.map((c) => c.name), ["clear"]);
    const revisionBefore = hush?.snapshot().commandsRevision;

    check("it is released after a quiet spell", await own.parkIdleSessions(now + 31 * 60_000), ["s_hush"]);
    /*
     * The three facts that make parking invisible, together — because each of them
     * alone is satisfied by a session that gives itself away through the other two.
     */
    check("and the menu it offers is the one it had", hush?.agentCommands.commands.map((c) => c.name), ["clear"]);
    check("with no revision bump, since nothing about the list changed", hush?.snapshot().commandsRevision, revisionBefore);
    check("its controls are still there, which is the rule this follows", hush?.snapshot().agentConfig, liveCommands);
    check(
      "and nothing at all was written into the conversation but the status",
      (own.get("s_hush")?.log.read(0, 1000, 1024 * 1024) ?? [])
        .filter((stored) => stored.event.type === "error")
        .map((stored) => (stored.event as { message: string }).message),
      [],
    );

    await own.shutdown();
  }

  /*
   * The bound on tracked work, and what it is a bound *on*.
   *
   * ⚠ **It counts live tasks, not rows, and the difference is a released
   * build.** `MAX_TRACKED_ASYNC_TASKS` justifies refusing a new id with *"the set
   * is already non-empty, so the session is already deferring"* — and the map
   * keeps terminal rows on purpose, so that sentence was false for the case that
   * matters. Reached by the ordinary use of a coding agent rather than by abuse:
   * run that many shells, let them all finish, and the next real build was
   * untracked, `hasLiveBackgroundWork` answered false, and the sweep took the
   * agent out from under it. Nothing in this repository referenced the constant,
   * so every driver was green over it.
   *
   * Driven through the constant rather than a literal `32`, so raising the cap
   * cannot quietly stop testing the boundary.
   */
  {
    const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 25));
    const spawn = (id: string, extra: Record<string, unknown> = {}) => ({
      sessionUpdate: "async_task_spawned",
      asyncTaskId: id,
      name: id,
      taskType: "shell",
      description: "",
      showInTranscript: false,
      canStop: true,
      ...extra,
    });
    const ended = (id: string, state: string) => ({
      sessionUpdate: "async_task_state_update",
      asyncTaskId: id,
      state,
    });

    const rig = rigWith({ resume: true });
    const own = new SessionRegistry(
      new MemoryEventStore(),
      storeOf([interruptedRow("s_cap", "daemon_restarted", "a_cap")]),
      undefined,
      rig.runtime,
    );
    own.restore({ reapOrphans: false });
    await own.autoResume({ ...options, concurrency: 1 });

    for (let i = 0; i < MAX_TRACKED_ASYNC_TASKS; i += 1) {
      rig.notify("a_cap", spawn(`done_${i}`));
      rig.notify("a_cap", ended(`done_${i}`, "completed"));
    }
    await settle();
    const capped = own.get("s_cap");
    check(
      "a session fills to the cap with finished work",
      capped?.snapshot().backgroundTasks.length,
      MAX_TRACKED_ASYNC_TASKS,
    );
    check(
      "and none of it is still running",
      capped?.snapshot().backgroundTasks.every((task) => task.state === "completed"),
      true,
    );
    /*
     * ⚠ **The sweep is not run here, and that is not squeamishness.** At this
     * point it *would* take the session — which is the hazard — and taking it
     * disposes the agent, so every notify below would address a session with no
     * agent and this block would assert nothing. That the sweep releases a session
     * holding only finished work is already pinned above; what is owned here is
     * that a live task arriving at the cap still registers.
     */
    rig.notify("a_cap", spawn("the_build"));
    await settle();
    const after = capped?.snapshot().backgroundTasks ?? [];
    check(
      "the next real build is tracked rather than dropped on the floor",
      after.find((task) => task.id === "the_build")?.state,
      "running",
    );
    check("the oldest finished row was spent to make room, not a live one", after.length, MAX_TRACKED_ASYNC_TASKS);
    check("and the row given up is the one that ended first", after.some((task) => task.id === "done_0"), false);
    check(
      "so the sweep defers over it, which is the whole point of the clause",
      await own.parkIdleSessions(now + 24 * 60 * 60_000),
      [],
    );

    /*
     * And the refusal still exists — reached only where the cap's own argument is
     * finally true, which is every tracked row being live. Without this the fix
     * above would read as "the cap was removed".
     */
    for (let i = 0; i < MAX_TRACKED_ASYNC_TASKS; i += 1) rig.notify("a_cap", spawn(`live_${i}`));
    await settle();
    const all = capped?.snapshot().backgroundTasks ?? [];
    check("a set that is entirely live still refuses a further id", all.length, MAX_TRACKED_ASYNC_TASKS);
    check("and none of what it holds was given up to take it", all.every((task) => task.state === "running"), true);

    await own.shutdown();
  }

  /*
   * A second `async_task_spawned` for an id that has already finished.
   *
   * The spawn arm is the one update that can arrive about a row that is over —
   * the adapter creates a row from a spawn and from nothing else — so writing it
   * unconditionally took a `completed` row back to `running` and restarted its
   * clock. One such frame re-arms the deferral over work that has ended, which is
   * the mirror of the failure above: there the sweep ran when it should not have,
   * here it never runs at all. The state arm reasons carefully that *a terminal
   * state is not final*; this is the same care pointed the other way.
   */
  {
    const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 25));
    const rig = rigWith({ resume: true });
    const own = new SessionRegistry(
      new MemoryEventStore(),
      storeOf([interruptedRow("s_again", "daemon_restarted", "a_again")]),
      undefined,
      rig.runtime,
    );
    own.restore({ reapOrphans: false });
    await own.autoResume({ ...options, concurrency: 1 });
    const base = {
      sessionUpdate: "async_task_spawned",
      asyncTaskId: "t",
      taskType: "shell",
      description: "",
      showInTranscript: false,
      canStop: true,
    };
    rig.notify("a_again", { ...base, name: "first" });
    rig.notify("a_again", { sessionUpdate: "async_task_state_update", asyncTaskId: "t", state: "completed" });
    await settle();
    const endedAt = own.get("s_again")?.snapshot().backgroundTasks[0]?.endedAt ?? null;
    rig.notify("a_again", { ...base, name: "second" });
    await settle();
    const row = own.get("s_again")?.snapshot().backgroundTasks[0];
    check("a repeat spawn does not resurrect a task that ended", row?.state, "completed");
    check("and does not move the end it was stamped with", row?.endedAt, endedAt);
    check("what it describes is still taken, since that is news", row?.name, "second");
    check(
      "so the sweep is not re-armed over work that is over",
      await own.parkIdleSessions(now + 24 * 60 * 60_000),
      ["s_again"],
    );
    await own.shutdown();
  }

  /*
   * What the reader refuses, and the direction every refusal fails in.
   *
   * `readAsyncTaskEdge` drops the **whole** update rather than repairing one, and
   * its stated safety property is the direction: a task described with a word this
   * client cannot read stays **live**, is never parked over, and is released when
   * the agent is disposed. Coercing an unknown word to a terminal state would be
   * inventing the one fact that gets somebody's build killed — so this drives a
   * sixth state from an adapter that does not exist yet, and asserts the session
   * is still deferred over.
   */
  {
    const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 25));
    const rig = rigWith({ resume: true });
    const own = new SessionRegistry(
      new MemoryEventStore(),
      storeOf([interruptedRow("s_read", "daemon_restarted", "a_read")]),
      undefined,
      rig.runtime,
    );
    own.restore({ reapOrphans: false });
    await own.autoResume({ ...options, concurrency: 1 });
    rig.notify("a_read", {
      sessionUpdate: "async_task_spawned",
      asyncTaskId: "t",
      name: "t",
      taskType: "shell",
      description: "",
      showInTranscript: false,
      canStop: true,
    });
    await settle();

    rig.notify("a_read", { sessionUpdate: "async_task_state_update", asyncTaskId: "t", state: "hibernating" });
    await settle();
    check(
      "a state word from a later adapter is refused rather than coerced",
      own.get("s_read")?.snapshot().backgroundTasks.map((task) => task.state),
      ["running"],
    );
    check(
      "and the session is still deferred over, which is the direction that matters",
      await own.parkIdleSessions(now + 24 * 60 * 60_000),
      [],
    );

    const before = own.get("s_read")?.snapshot().backgroundTasks.length;
    rig.notify("a_read", {
      sessionUpdate: "async_task_spawned",
      asyncTaskId: "x".repeat(MAX_ASYNC_TASK_ID_CHARS + 1),
      name: "too long",
      taskType: "shell",
      description: "",
      showInTranscript: false,
      canStop: true,
    });
    rig.notify("a_read", { sessionUpdate: "async_task_spawned", name: "no id", taskType: "shell" });
    await settle();
    check(
      "an id past the bound and an update with none create nothing",
      own.get("s_read")?.snapshot().backgroundTasks.length,
      before,
    );

    /*
     * The clips, on **both** paths. The spawn arm and the merge arm clip
     * independently, so a clip dropped from one is invisible from the other — and
     * these rows ride every snapshot, to every attached client, on every edge.
     */
    rig.notify("a_read", {
      sessionUpdate: "async_task_spawned",
      asyncTaskId: "big",
      name: "n".repeat(MAX_ASYNC_TASK_NAME_CHARS * 2),
      taskType: "shell",
      description: "d".repeat(MAX_ASYNC_TASK_TEXT_CHARS * 2),
      showInTranscript: false,
      canStop: true,
    });
    await settle();
    const big = own.get("s_read")?.snapshot().backgroundTasks.find((task) => task.id === "big");
    check(
      "prose is clipped where the record is built",
      [
        (big?.name.length ?? 0) <= MAX_ASYNC_TASK_NAME_CHARS,
        (big?.description.length ?? 0) <= MAX_ASYNC_TASK_TEXT_CHARS,
      ],
      [true, true],
    );
    // `clip` leaves the loss visible rather than cutting silently, which is what
    // keeps the bound honest — and is why the lengths above are at or under the
    // budget rather than exactly it: the note is inside the budget, not added to it.
    check("and the cut is counted rather than silent", big?.description.endsWith("bytes]"), true);
    rig.notify("a_read", {
      sessionUpdate: "async_task_progress",
      asyncTaskId: "big",
      summary: "s".repeat(MAX_ASYNC_TASK_TEXT_CHARS * 2),
    });
    await settle();
    const summary = own.get("s_read")?.snapshot().backgroundTasks.find((task) => task.id === "big")?.summary;
    check(
      "and again on the merge path, which clips on its own account",
      [(summary?.length ?? 0) <= MAX_ASYNC_TASK_TEXT_CHARS, summary?.endsWith("bytes]")],
      [true, true],
    );
    await own.shutdown();
  }

  /*
   * Whether the agent said it reports background work at all.
   *
   * ⚠ **The field that tells *nothing is running* from *nobody asked*, and it was
   * `false` in every driver here.** Three agents out of four send no `_meta`, so
   * an empty list from kimi means nobody asked and an empty list from claude means
   * nothing is running — and the panel draws a different sentence for each.
   * `pincheck` asserts the object this daemon *sends* against the adapter's own
   * gate; nothing asserted this daemon's read of what the agent *answers*, in
   * either direction, so a regression to always-false would silently have claude
   * claiming it reports nothing.
   */
  {
    for (const [advertises, want] of [
      [true, true],
      [false, false],
      ["old", false],
      ["unnamed", false],
    ] as const) {
      const id = String(advertises);
      const rig = rigWith({ resume: true, advertisesTasks: advertises });
      const own = new SessionRegistry(
        new MemoryEventStore(),
        storeOf([interruptedRow(`s_adv_${id}`, "daemon_restarted", `a_adv_${id}`)]),
        undefined,
        rig.runtime,
      );
      own.restore({ reapOrphans: false });
      await own.autoResume({ ...options, concurrency: 1 });
      check(
        `the agent's own answer decides whether it reports (${id})`,
        own.get(`s_adv_${id}`)?.snapshot().reportsBackgroundTasks,
        want,
      );
      await own.shutdown();
    }
  }

  /*
   * A `/clear` with work still running, which is the one combination that made a
   * session immortal.
   *
   * `clearContext` re-keys the ACP session and unregisters the old id, so every
   * later edge about a pre-clear task — including the terminal one — is routed to
   * an id nobody is listening on and dropped. A row left behind therefore stays
   * `running` for the life of the process: the sweep can never take the session,
   * `releaseOneSlot` can never take it either, and a machine that has cleared a
   * few conversations mid-build answers `429 too_many_sessions` at the ceiling
   * with no way out but a manual stop. Stop could not repair it either — it
   * addresses the *new* id, so it could only ever answer `stopped: false`.
   *
   * Both halves are asserted, because either alone is silent: the set is empty,
   * *and* the transcript says what was walked away from.
   */
  {
    const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 25));
    const rig = rigWith({ resume: true });
    const events = new MemoryEventStore();
    const own = new SessionRegistry(
      events,
      storeOf([interruptedRow("s_clr", "daemon_restarted", "a_clr")]),
      undefined,
      rig.runtime,
    );
    own.restore({ reapOrphans: false });
    await own.autoResume({ ...options, concurrency: 1 });
    rig.notify("a_clr", {
      sessionUpdate: "async_task_spawned",
      asyncTaskId: "build",
      name: "build",
      taskType: "shell",
      description: "",
      showInTranscript: false,
      canStop: true,
    });
    await settle();
    check(
      "a live task defers the sweep before the clear",
      await own.parkIdleSessions(now + 24 * 60 * 60_000),
      [],
    );

    const cleared = await own.get("s_clr")?.clearContext("/clear");
    await settle();
    check("the clear went through", cleared?.kind, "cleared");
    check(
      "the tasks went with the conversation they belonged to",
      own.get("s_clr")?.snapshot().backgroundTasks,
      [],
    );
    check(
      "so the session can be released again rather than being held for ever",
      await own.parkIdleSessions(now + 24 * 60 * 60_000),
      ["s_clr"],
    );
    check(
      "and the transcript says what was still running, once",
      (own.get("s_clr")?.log.read(0, 1000, 1024 * 1024) ?? [])
        .filter((stored) => stored.event.type === "error")
        .map((stored) => (stored.event as { message: string }).message),
      [clearedWithBackgroundWork(1)],
    );
    await own.shutdown();
  }

  /*
   * Stopping one task, over the route, with the three answers it can give.
   *
   * ⚠ **`stopped: false` is a 200 and the row that says so is the point.** It
   * means the work finished on its own between the tap and the request, which is
   * losing an ordinary race — the same judgement `/cancel`'s `no_turn` makes, and
   * a red error there makes the control look broken at the moment it got what it
   * asked for. A `404` is the different sentence: not *you lost a race* but
   * *there is no such task here*, which is also what a caller reaches by making
   * the id up.
   */
  {
    for (const [answer, want] of [
      [true, { status: 200, body: { stopped: true } }],
      [false, { status: 200, body: { stopped: false } }],
      ["error", { status: 502, body: null }],
    ] as const) {
      const rig = rigWith({ resume: true, stopAnswer: answer });
      const store = storeOf([interruptedRow(`s_stop_${String(answer)}`, "daemon_restarted", `a_stop_${String(answer)}`)]);
      const own = new SessionRegistry(new MemoryEventStore(), store, undefined, rig.runtime);
      own.restore({ reapOrphans: false });
      await own.autoResume({ ...options, concurrency: 1 });
      const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 25));
      rig.notify(`a_stop_${String(answer)}`, {
        sessionUpdate: "async_task_spawned",
        asyncTaskId: "t1",
        name: "t1",
        taskType: "shell",
        description: "",
        showInTranscript: false,
        canStop: true,
      });
      await settle();

      /*
       * ⚠ **Over the route, and that is the whole reason this block was rewritten.**
       *
       * It used to call `managed.stopBackgroundTask` directly while the table
       * beside it declared a `status` for each answer — and nothing ever read that
       * field. So the method was driven and the *route* was not: its status map
       * (200 / 404 / 502, and the two 409s), its envelope, and the deliberate
       * `stopped: false → 200` this block's own prose argues for were asserted
       * nowhere, and deleting the handler in `server.ts` left `daemoncheck` green.
       * `want.status` is live now, which is what keeps the table honest.
       */
      const routed = createApp({
        registry: own,
        verifier,
        instanceId: `i_stop_${String(answer)}`,
        startedAt: now,
        credentials,
        roots: [users],
        logins: new AgentLoginRuns({ runtime: own.sessionRuntime, onWarning: () => {} }),
      }).app;
      const stopOver = async (taskId: string): Promise<[number, any]> => {
        const response = await routed.fetch(
          new Request(
            `http://d/sessions/s_stop_${String(answer)}/async-tasks/${encodeURIComponent(taskId)}/stop`,
            { method: "POST", headers: { authorization: `Bearer ${tokenFor("u_alice")}` } },
          ),
        );
        return [response.status, await response.json()];
      };

      const [status, body] = await stopOver("t1");
      if (want.body === null) {
        check(
          `an agent that refuses is a 502 rather than a lost race (${String(answer)})`,
          [status, body.error?.code],
          [want.status, "agent_error"],
        );
      } else {
        check(
          `the agent's answer is carried through, under a 200 (${String(answer)})`,
          [status, body.stopped],
          [want.status, want.body.stopped],
        );
        check(
          `and the answer carries the session back with it (${String(answer)})`,
          typeof body.session?.id,
          "string",
        );
      }
      check(`and the id reached the agent verbatim (${String(answer)})`, rig.stops(), [
        { sessionId: `a_stop_${String(answer)}`, asyncTaskId: "t1" },
      ]);

      // The 404 is the other sentence, and it is taken before the agent is asked:
      // `rig.stops()` must not have grown.
      const [madeStatus, madeBody] = await stopOver("never-announced");
      check(
        `an id this session never announced is a 404, before the agent is asked (${String(answer)})`,
        [madeStatus, madeBody.error?.code, rig.stops().length],
        [404, "task_not_found", 1],
      );
      await own.shutdown();
    }
  }


  /*
   * The backgrounded marker, read off `_meta` on the daemon side.
   *
   * ⚠ **`readBackgroundedMarker` had no daemon-side assertion at all.** The only
   * thing pinning `backgrounded` was `webcheck.tail-subagents-and-runs.ts`, which
   * hand-builds an event with the field already set — so it was green over a
   * daemon that never set it, which is the "driver over unreachable code" shape
   * this tree has been bitten by before.
   *
   * What a regression costs is the whole feature: a detached `Bash` call's card
   * reaches `completed` while the command runs on for minutes, which is exactly
   * the thing the marker exists to prevent.
   *
   * Swept as pairs, because the near-misses are the point — the namespace is a
   * vendor extension, so reading it from `claudeCode`, or accepting the *string*
   * `"false"`, are both one edit away.
   */
  {
    const rig = rigWith({ resume: true });
    const store = storeOf([interruptedRow("s_bgm", "daemon_restarted", "a_bgm")]);
    const own = new SessionRegistry(new MemoryEventStore(), store, undefined, rig.runtime);
    own.restore({ reapOrphans: false });
    await own.autoResume({ ...options, concurrency: 1 });
    const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 25));

    const air = (backgrounded: unknown): Record<string, unknown> => ({
      jetbrains: { air: { asyncTasks: { backgrounded } } },
    });
    const cases: readonly (readonly [string, Record<string, unknown> | undefined, boolean])[] = [
      ["the marker is read where the agent sets it", air(true), true],
      ["`false` is not backgrounded", air(false), false],
      ["and the string \"false\" is not `true`, which truthiness would have taken", air("false"), false],
      ["nor is the string \"true\"", air("true"), false],
      ["an update with no `_meta` at all", undefined, false],
      ["the marker in the wrong namespace is not this one", { claudeCode: { asyncTasks: { backgrounded: true } } }, false],
      ["nor is an `air` that is an array", { jetbrains: { air: [{ asyncTasks: { backgrounded: true } }] } }, false],
      ["nor an `air` holding no `asyncTasks`", { jetbrains: { air: { version: 1 } } }, false],
    ];

    let at = 0;
    for (const [what, meta, want] of cases) {
      at += 1;
      const toolCallId = `call_${at}`;
      // The card first, then the update that carries the marker: `backgrounded`
      // rides `tool_call_update`, because it is a fact the agent states about
      // *that* update rather than about the call.
      rig.notify("a_bgm", { sessionUpdate: "tool_call", toolCallId, title: "Bash", kind: "execute", status: "in_progress" });
      rig.notify("a_bgm", {
        sessionUpdate: "tool_call_update",
        toolCallId,
        status: "completed",
        ...(meta === undefined ? {} : { _meta: meta }),
      });
      // A tool draft is held until the next update, so one more arrival is what
      // flushes the pair above out of the draft and into the log.
      rig.notify("a_bgm", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "." } });
      await settle();
      const drawn = (own.get("s_bgm")?.log.read(0, 1000, 1024 * 1024) ?? [])
        .map((stored) => stored.event)
        .filter(
          (event) =>
            event.type === "tool_call_update" && (event as { toolCallId?: string }).toolCallId === toolCallId,
        )
        .map((event) => (event as { backgrounded?: boolean }).backgrounded);
      check(what, drawn, [want]);
    }
    await own.shutdown();
  }

  /*
   * What the polled listing carries, and what it must not drop anywhere else.
   *
   * ⚠ **The `listing` cut was asserted in neither direction.** Dropping
   * `{ listing: true }` at the `GET /sessions` handler silently restores the
   * multi-megabyte poll the flag exists to prevent; making the cut unconditional
   * silently blanks the field on the socket and the single-session read. Both are
   * invisible to `tsc`, and both were invisible here.
   *
   * Three surfaces and one rule: the listing cuts, `GET /sessions/:id` keeps, and
   * the WS `snapshot` control frame keeps — that last one is `managed.snapshot()`
   * with no options, which is the call asserted directly below rather than through
   * a socket, because it is the same call the frame is built from.
   *
   * `null` rather than absent is deliberate on the listing and is asserted as
   * such: the key stays so the record's shape does not change by route.
   */
  {
    const rig = rigWith({ resume: true });
    const store = storeOf([interruptedRow("s_list", "daemon_restarted", "a_list")]);
    const own = new SessionRegistry(new MemoryEventStore(), store, undefined, rig.runtime);
    own.restore({ reapOrphans: false });
    await own.autoResume({ ...options, concurrency: 1 });
    const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 25));
    const path = "/private/tmp/claude-501/slug/s_list/tasks/t1.output";
    rig.notify("a_list", {
      sessionUpdate: "async_task_spawned",
      asyncTaskId: "t1",
      name: "build",
      taskType: "shell",
      description: "",
      showInTranscript: true,
      canStop: true,
      outputFilePath: path,
    });
    await settle();

    const routed = createApp({
      registry: own,
      verifier,
      instanceId: "i_list",
      startedAt: now,
      credentials,
      roots: [users],
      logins: new AgentLoginRuns({ runtime: own.sessionRuntime, onWarning: () => {} }),
    }).app;
    const getJson = async (url: string): Promise<any> => {
      const response = await routed.fetch(
        new Request(`http://d${url}`, { headers: { authorization: `Bearer ${tokenFor("u_alice")}` } }),
      );
      return await response.json();
    };

    const listed = await getJson("/sessions");
    const listedTask = listed.sessions?.[0]?.backgroundTasks?.[0];
    check(
      "the polled listing carries the row but not its output path",
      [listedTask?.id, listedTask?.outputFilePath, "outputFilePath" in (listedTask ?? {})],
      ["t1", null, true],
    );

    const one = await getJson("/sessions/s_list");
    check(
      "the single-session read carries the path whole",
      [one.session?.backgroundTasks?.[0]?.id, one.session?.backgroundTasks?.[0]?.outputFilePath],
      ["t1", path],
    );

    check(
      "and so does the snapshot the socket's control frame is built from",
      own.get("s_list")?.snapshot().backgroundTasks.map((task) => task.outputFilePath),
      [path],
    );
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
    /*
     * ⚠ **And before the message: the one route that could have destroyed this
     * conversation while it slept.**
     *
     * `DELETE /sessions/:id/workspace` gated on `!managed.terminal`, and a parked
     * session is terminal — so the worktree of a conversation the daemon has
     * promised to bring back was removable, by anybody holding `machine:admin`,
     * through a documented route. That is unrecoverable rather than merely rude:
     * `workspaceReady` runs **before** the resume block in the prompt handler, so
     * every later message answers `409 workspace_missing` and the wake below would
     * never be attempted; the boot probe's `false` is settled and never retried;
     * and no route re-creates a worktree for a session that already exists. The row
     * is `keepsItsConversation`, so the prune will not take it either.
     *
     * Driven immediately before the wake it would have prevented, which is what
     * makes the pair worth having in one place: the refusal, and then the message
     * still working. The remedy in the sentence is the real one — Stop it first
     * writes a reason that keeps no conversation and makes the worktree removable.
     */
    const held = await routed.fetch(
      new Request("http://d/sessions/s_wake/workspace", {
        method: "DELETE",
        headers: { authorization: `Bearer ${tokenFor("u_alice")}` },
      }),
    );
    const heldBody = (await held.json()) as { error?: { code?: string; message?: string } };
    check(
      "a parked conversation keeps its worktree",
      [held.status, heldBody.error?.code, heldBody.error?.message],
      [409, "session_live", "stop this session before removing its worktree"],
    );
    check("and it is still parked, not changed by having been asked", second.get("s_wake")?.exit?.reason, "parked");

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
     *
     * ⚠ **`ceilingFloorMs` is the second faked clock and it is a different one.**
     * `idleParkMs` above is the *sweep's* threshold; this is the floor under the
     * **ceiling's** eviction, which deliberately does not use that threshold —
     * `CEILING_PARK_FLOOR_MS`, two minutes, so an agent whose turn ended seconds
     * ago is never taken for a slot. `parkable` cannot see a backgrounded build
     * (Q7.113), which is what that floor is protecting. Both have to be lowered
     * here for the same fixture reason, and the floor's own behaviour is asserted
     * against the real default in the ceiling block above.
     */
    own.setSessionLimits({ live: 2, idleParkMs: 1, ceilingFloorMs: 0 });
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
    let armConfigSet: (() => void) | null = null;
    const rig = rigWith({ resume: true, config: true, onConfigSet: () => armConfigSet?.() });
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
    /*
     * ⚠ **A tap landing *inside* the wake, which is the one window the guards
     * above do not describe and which this widening opened.**
     *
     * `doResume` captures `wantedConfig`, lets `onStarted` publish the fresh
     * agent's own controls, and only then replays the capture through
     * `restoreConfig`. A tap arriving in that last step finds `exitRecord` cleared
     * by `armForStart` (so `configIsDeferred` is false), not terminal, and a live
     * `session` — so it reached the agent, answered `ok`, and was then overwritten
     * by a snapshot captured before it: 200, chip moves, nothing happens. That is
     * verbatim the failure the `clearing`/`restarting` guard was written for,
     * reached through the door `revivableByPrompt` opened — `doStop` emptied the
     * config for every non-parked reason before, so the replay had nothing to
     * replay and the window did not exist.
     *
     * `resuming` is the third member of {@link replacingConfig} and this is what
     * asserts it. Collected into an array rather than a variable so "the hook
     * never fired" is a distinguishable answer: without the guard the answer is
     * `ok`, and with the hook unarmed it is the sentinel — an assertion that
     * passes because nothing ran is the shape this block exists to refuse.
     */
    const midWake: string[] = [];
    armConfigSet = () => {
      void cfg?.setMode("plan").then((r) => void midWake.push(r.kind));
      void cfg?.setConfigOption("model", "opus").then((r) => void midWake.push(r.kind));
    };
    await cfg?.resume();
    armConfigSet = null;
    check("the wake sends the choice to the fresh agent", rig.configSets(), [{ id: "model", value: "sonnet" }]);
    check("which is live again on the chosen model", [cfg?.status, cfg?.snapshot().agentConfig?.options[0]?.value], ["idle", "sonnet"]);
    /*
     * ⚠ **Both methods, because the guard was hand-written in each and only one of
     * them was ever raced.** `setMode` had an assertion in
     * `daemoncheck.after-the-turn-and-config.ts`; `setConfigOption` had none, so
     * reverting its half left every driver in this repository green.
     */
    check(
      "a tap arriving inside the wake is refused rather than silently overwritten",
      midWake.length === 0 ? ["<the hook never fired>"] : [...midWake].sort(),
      ["busy", "busy"],
    );
    // And the replay landed on what it was replaying, not on what the tap asked for.
    check("and the wake put back what it captured", cfg?.snapshot().agentConfig?.options[0]?.value, "sonnet");

    await own.shutdown();
  }

  /*
   * ⚠ **And the arm is no longer narrow to parking, which reverses what this block
   * asserted.** It read: a session somebody *stopped* is not a session whose
   * settings are pending, its controls went with its agent, and a tap is the
   * ordinary refusal.
   *
   * Every clause of that was about the word rather than the fact. `stopped` is a
   * reason a **message** revives — the composer is unconditional and typing into a
   * stopped conversation starts it again — so its controls describe exactly what
   * parking's do: the conversation that is coming back. {@link revivableByPrompt}
   * is the one gate now, and what it leaves refusing is the three that never had a
   * conversation at all, driven immediately below.
   */
  {
    const rig = rigWith({ resume: true, config: true });
    const store = storeOf([interruptedRow("s_off", "daemon_restarted", "a_off")]);
    const own = new SessionRegistry(new MemoryEventStore(), store, undefined, rig.runtime);
    own.restore({ reapOrphans: false });
    await own.autoResume({ ...options, concurrency: 1 });
    const off = own.get("s_off");
    await off?.stop("stopped");
    check("a stopped session keeps its controls, like a parked one", (off?.snapshot().agentConfig?.options ?? []).length > 0, true);
    const set = await off?.setConfigOption("model", "sonnet");
    check("and a choice on one is deferred, not refused", set?.kind, "ok");
    check("the chip moves at once, because the setting will be in force next run", off?.snapshot().agentConfig?.options[0]?.value, "sonnet");

    await own.shutdown();
  }

  /*
   * ⚠ **What survives the process that learned it, and the measurement that
   * forced it.**
   *
   * `doStop` keeping the controls was only ever true for as long as the daemon
   * ran. Measured 2026-09-19 against the live daemon on this machine: all five
   * parked rows answered `GET /sessions/:id/commands` with `revision 0, count 0`
   * and carried no options at all — so every one of them drew three `—` chips
   * under *"The agent is not offering this control at the moment"* and an empty
   * `/` menu, **permanently**, because nothing publishes again until somebody
   * types. With the prod hosts updating at 04:00 and 05:00 UTC that is the state
   * of every overnight conversation, fleet-wide, every morning.
   *
   * So the keeping is written to `agent_state_json` and adopted back. Driven end
   * to end rather than asserted at either end: one registry writes the row, a
   * second one restores from the same store, which is the boundary the bug lives
   * at and the only shape that could have caught it.
   */
  {
    const seed = interruptedRow("s_keep", "daemon_restarted", "a_keep");
    const rows = new Map<string, PersistedSession>([[seed.id, seed]]);
    const recording: SessionStore = {
      put: (row) => void rows.set(row.id, row),
      list: () => [...rows.values()],
      remove: (id) => void rows.delete(id),
    };

    const rig = rigWith({ resume: true, config: true });
    const first = new SessionRegistry(new MemoryEventStore(), recording, undefined, rig.runtime);
    first.restore({ reapOrphans: false });
    await first.autoResume({ ...options, concurrency: 1 });
    const live = first.get("s_keep");
    check("the agent is live and publishing controls", (live?.snapshot().agentConfig?.options ?? []).length > 0, true);
    await live?.stop("parked");
    await first.shutdown();

    const written = rows.get("s_keep");
    check("a parked row writes what its agent was offering", written?.agentState?.config.options[0]?.id, "model");
    check("and the row still reads as parked", written?.exit?.reason, "parked");

    /*
     * The second process. `restore` spawns nothing — a parked row is `false` at
     * boot, which is the whole reason parking pays for itself — so what is
     * asserted here is a session with no agent and its controls back anyway.
     */
    const second = new SessionRegistry(new MemoryEventStore(), recording, undefined, rigWith({ resume: true, config: true }).runtime);
    second.restore({ reapOrphans: false });
    const back = second.get("s_keep");
    check("a restarted daemon brings a parked session's controls back", back?.snapshot().agentConfig?.options[0]?.id, "model");
    check("without starting anything", back?.status, "parked");
    /*
     * ⚠ **The revision, which is the half that would have been silent.**
     * `commandsPlan` in `packages/web/src/store.ts` reads `0` as *"this daemon has
     * nothing"* and drops the fetch — so a restored list left at revision 0 would
     * sit on the daemon with the `/` menu still empty, which is the exact symptom
     * this whole entry exists to end.
     */
    check("at a revision a client will actually fetch", (back?.commandsRevision ?? 0) > 0, true);
    const tapped = await back?.setConfigOption("model", "sonnet");
    check("and a tap on them is recorded rather than refused", tapped?.kind, "ok");
    await second.shutdown();
  }

  /*
   * And the row that must not be adopted, checked on the way *in* rather than only
   * on the way out. The column outlives the build that wrote it: a row stored
   * under one reason and relabelled under another by an older daemon would come
   * back describing a conversation nobody can reach, so `ManagedSession.restore`
   * asks {@link revivableByPrompt} a second time over the exit it actually has.
   */
  {
    const seed = interruptedRow("s_refused", "daemon_restarted", "a_refused");
    const store = storeOf([
      {
        ...seed,
        exit: { reason: "start_failed", at: now, detail: null, agentHandle: null, agentConfirmedDead: true },
        agentState: {
          config: { modes: null, options: [{ id: "model", name: "Model", description: null, category: "model", kind: "select", value: "opus", choices: [{ value: "opus", name: "Opus", description: null, group: null }] }] },
          commands: { commands: [{ name: "compact", description: "Compact", hint: null }], dropped: 0 },
        },
      },
    ]);
    const own = new SessionRegistry(new MemoryEventStore(), store, undefined, rigWith({ resume: true }).runtime);
    own.restore({ reapOrphans: false });
    const refused = own.get("s_refused");
    check("a row nothing can revive is not adopted, whatever it stored", refused?.snapshot().agentConfig?.options ?? [], []);
    check("nor is its command list", refused?.agentCommands, { commands: [], dropped: 0 });
    await own.shutdown();
  }

  /*
   * The bound, as a pure rule.
   *
   * ⚠ **Refused whole rather than clipped, and that is the decision.** Clipping a
   * choice list would leave `setConfigOption` validating against a shorter list
   * than the agent published, so a value somebody really can choose would answer
   * `invalid_value` — a control that lies rather than one that is absent. What is
   * asserted is therefore both halves: that a real list survives, and that an
   * oversized one answers `null` rather than a shorter list.
   */
  {
    const choice = (n: number) => ({ value: `m${n}`, name: `Model ${n}`, description: `a sentence about model ${n}`, group: null });
    const optionOf = (count: number) => ({
      id: "model",
      name: "Model",
      description: null,
      category: "model" as const,
      kind: "select" as const,
      value: "m0",
      choices: Array.from({ length: count }, (_, n) => choice(n)),
    });
    const none = { commands: [], dropped: 0 };
    const ordinary = reduceAgentState({ modes: null, options: [optionOf(362)] }, none);
    check("the largest list any agent here publishes is kept", ordinary?.config.options[0]?.choices.length, 362);
    check(
      "with the prose dropped from every choice but the selected one",
      ordinary?.config.options[0]?.choices.map((c) => c.description === null),
      [false, ...Array.from({ length: 361 }, () => true)],
    );
    check("and one past the bound is not kept at all, rather than kept short", reduceAgentState({ modes: null, options: [optionOf(4000)] }, none), null);
    /*
     * ⚠ **And nothing to remember is `null` rather than a small object saying so.**
     * Found by running it: every session already terminal when this shipped has an
     * empty pair, and storing that meant `ManagedSession.restore` adopted an empty
     * memory and seeded `commandsRevisionValue` to 1 — telling the client to fetch
     * a list with nothing in it, which is strictly worse than the `0` that meant
     * "this daemon has nothing". Eight rows on the first boot after the change.
     */
    check("a pair with nothing in it is not remembered at all", reduceAgentState({ modes: null, options: [] }, none), null);
    check("nor is one with only a mode and no options", reduceAgentState({ modes: { current: "plan", available: [] }, options: [] }, none), null);
    check("but a command list with no options is", reduceAgentState({ modes: null, options: [] }, { commands: [{ name: "context", description: "", hint: null }], dropped: 0 })?.commands.commands.length, 1);
  }

  /*
   * The negative that keeps it a gate rather than a blanket.
   *
   * `start_failed` is one of the three `autoResumable` refuses on **both**
   * triggers: there was never a conversation, so there is nothing a remembered
   * control could be about and `—` is the honest reading. A tap is the ordinary
   * refusal, and the command list is withdrawn at a *bumped* revision — a change
   * marker, not a count, so a client holding revision 1 is told to drop its menu
   * rather than left comparing 1 to 1.
   */
  {
    const rig = rigWith({ resume: true, config: true });
    const store = storeOf([interruptedRow("s_dead", "daemon_restarted", "a_dead")]);
    const own = new SessionRegistry(new MemoryEventStore(), store, undefined, rig.runtime);
    own.restore({ reapOrphans: false });
    await own.autoResume({ ...options, concurrency: 1 });
    const dead = own.get("s_dead");
    await dead?.stop("start_failed");
    check("a stop nothing can revive keeps no controls", dead?.snapshot().agentConfig?.options ?? [], []);
    const set = await dead?.setConfigOption("model", "sonnet");
    check("and a choice on one is refused, not deferred", set?.kind, "terminal");
    /*
     * The command list travels through the same one `if` and is asserted where a
     * rig actually publishes one — `daemoncheck.agent-output-and-uploads`, which
     * drives three commands and then a `stopped`. Asserting it here as well would
     * read as a second property and be worth nothing: this rig publishes none, so
     * `sameCommands` sees no change, the revision correctly does not move, and the
     * check would pass over a gate it never reached.
     */

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
