import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import type { AgentId, AgentLaunchConfig } from "../src/acp/agents.js";
import { MemoryEventStore, type SessionEvent, type StoredEvent } from "../src/events.js";
import { MAX_QUEUED_PROMPTS, SessionRegistry, stoppedBeforeDelivery } from "../src/registry.js";
import { LocalRuntime } from "../src/runtime/local.js";
import type { AgentAvailability, AgentProcess } from "../src/runtime/types.js";
import { createApp } from "../src/server.js";
import { tmp } from "./tmp.js";
import { check } from "./daemoncheck.env.js";
import { users, now, tokenFor, verifier, credentials, stubAgentConfig } from "./daemoncheck.fixtures.js";

/* ------------------------------------------------------------------ *
 * A message sent while the agent is working
 * ------------------------------------------------------------------ */

/**
 * `POST /sessions/:id/prompt` with a turn already in flight, on both kinds of agent.
 *
 * **This used to be one line and one refusal.** `ManagedSession.prompt` answered
 * `busy` on `this.turn !== null`, the route turned that into `409
 * turn_in_flight`, and there was nothing else to drive. The message is taken now,
 * and *how* it reaches the agent is the agent's own answer — which is why this
 * block stands two stubs up rather than one:
 *
 *   **steering**  advertises `_meta.steering.supported` on `initialize` and
 *                 answers `_session/steering` with `{outcome: "injected"}`. The
 *                 measured shape: claude-agent-acp 0.73.0 and codex-acp 1.8.0
 *                 both do this, and — the property everything here rests on —
 *                 the original `session/prompt` stays open and resolves exactly
 *                 **once**. An injection is not a second turn.
 *   **plain**     advertises nothing and answers `_session/steering` with
 *                 `-32601`. kimi 0.29.2 sends no `_meta` at all, so this is the
 *                 real fleet's other half rather than a hypothetical.
 *
 * ⚠ **The plain stub answers `-32601` rather than ignoring the method, and that
 * is deliberate**: it makes the *lying agent* reachable too — one that advertises
 * steering and then refuses the call — which is the only path into
 * `SteerOutcome`'s `unsupported` arm from a live RPC.
 */
process.stdout.write("\na message sent while the agent is working\n");
{
  const acp = await import("@agentclientprotocol/sdk");

  /** Every `_session/steering` this daemon sent, in order, as its text. */
  const steersSeen: string[] = [];
  /** Every `session/prompt` this daemon sent, in order, as its text. */
  const promptsSeen: string[] = [];
  /** The `_meta` on every steer, so the opt-in is checked rather than assumed. */
  const steerMeta: string[] = [];
  /**
   * The agent session id each `session/prompt` was addressed to.
   *
   * Beside `promptsSeen` rather than folded into it, so the blocks that assert
   * text keep reading as text. It exists for one question the text cannot answer:
   * after a `/clear` the daemon holds a **new** conversation, and "the message was
   * sent" and "the message was sent to the conversation the clear just abandoned"
   * look identical from `promptsSeen`.
   */
  const promptSessions: string[] = [];

  interface StubOptions {
    /**
     * Advertise the extension on `initialize`.
     *
     * Three shapes rather than two, and the third is the only one that reaches
     * `supportsSteering`'s actual decision: `true` sends `{supported: true}`,
     * `false` sends no `_meta` at all — kimi 0.29.2's real shape — and
     * `"declined"` sends `{supported: false}`, an agent that names the extension
     * to say no. Without it `=== true` and `!== undefined` are the same function:
     * the first guard already answers for a missing `_meta`, so the mutation that
     * turns a decline into a yes passed every check in this file.
     */
    readonly advertises: boolean | "declined";
    /**
     * What the steer answers: an outcome, or `null` to refuse with `-32601`.
     *
     * All three real outcomes rather than a boolean, because two of them are
     * failure modes the daemon has arms for and neither was reachable while this
     * was `honours: boolean` — `started_new_turn` is the one it reports through
     * `onWarning`, and `prompt_required` is the one it opts into precisely so the
     * other cannot happen.
     */
    readonly answers: "injected" | "startedNewTurn" | "promptRequired" | null;
    /**
     * End the turn as the steer arrives, before refusing it.
     *
     * The race the queue can be stranded by: `deliverQueued` runs from `pump`'s
     * `finally`, so a turn that ends *during* the steer drains an empty queue and
     * goes quiet — and an entry pushed after that waits for a turn nobody will
     * start. Not narrow: the steer is bounded at ten seconds and this arm is
     * reached exactly when an agent is slow to answer.
     */
    readonly endsTurnOnSteer?: boolean;
    /**
     * Hold the steer open until a test releases it.
     *
     * `sendMidTurn` has two real awaits and its guards were all taken before
     * them, so what can land inside this window is the whole question: a stop,
     * a restart, or another send. Nothing else in this file can open that window.
     */
    readonly holdsSteer?: boolean;

  }

  /**
   * An event store that refuses exactly one `prompt` append.
   *
   * ⚠ **The only way to reach `safeAppend`'s `null`, which is a real state and not
   * a hypothetical**: it catches whatever the store throws and answers `null`, and
   * `recordPrompt` turns that into `seq === 0`. Every *successful* append is above
   * zero, so a seq-0 entry is a message the log could not record — and ordering the
   * queue by seq put it ahead of every message accepted before it. Nothing else in
   * this repository can produce one, which is why the defect was invisible.
   */
  class RefusingStore extends MemoryEventStore {
    refuseNextPrompt = false;
    override append(sessionId: string, event: SessionEvent): StoredEvent {
      if (this.refuseNextPrompt && event.type === "prompt") {
        this.refuseNextPrompt = false;
        throw new Error("the store refused this append");
      }
      return super.append(sessionId, event);
    }
  }

  const standUp = async (options: StubOptions, warnings?: string[]) => {
    const resumeRefused = { on: false };
    let lastAgent: {
      toClient: PassThrough;
      held: () => unknown;
      clear: () => void;
      steers: () => (() => void)[];
    } | null = null;

    const spawn = (): AgentProcess => {
      // Renamed on each `session/new`, so a `/clear` produces a conversation the
      // assertions can tell from the one it replaced. See `promptSessions`.
      let sessionId = "s_midturn_1";
      let conversations = 0;
      const toAgent = new PassThrough();
      const toClient = new PassThrough();
      const send = (m: unknown) => toClient.write(`${JSON.stringify(m)}\n`);
      let heldPromptId: unknown = null;
      const heldSteers: (() => void)[] = [];

      let buffer = "";
      toAgent.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          if (line.trim().length === 0) continue;
          const message = JSON.parse(line) as Record<string, any>;
          const id = message["id"];
          const textOf = (params: any): string =>
            (params?.["prompt"] ?? [])
              .filter((block: any) => block?.type === "text")
              .map((block: any) => block.text)
              .join("");

          switch (message["method"]) {
            case acp.methods.agent.initialize:
              send({
                jsonrpc: "2.0",
                id,
                result: {
                  protocolVersion: acp.PROTOCOL_VERSION,
                  // `resume`, because one block below drives a real restart and
                  // `Session.resume` refuses without the capability — a stub that
                  // could not come back would make that block assert nothing.
                  agentCapabilities: { sessionCapabilities: { resume: {} } },
                  authMethods: [],
                  ...(options.advertises === false
                    ? {}
                    : { _meta: { steering: { supported: options.advertises === true } } }),
                },
              });
              break;
            case acp.methods.agent.session.cancel: {
              // A *notification*, so without an arm it lands in `default:` and is
              // discarded in silence — and then the held turn never ends, which
              // would make the cancel block below assert nothing at all.
              const ending = heldPromptId;
              if (ending !== null) {
                heldPromptId = null;
                send({ jsonrpc: "2.0", id: ending, result: { stopReason: "cancelled" } });
              }
              break;
            }
            case acp.methods.agent.session.new:
              conversations += 1;
              if (conversations > 1) sessionId = `s_midturn_${conversations}`;
              send({ jsonrpc: "2.0", id, result: { sessionId } });
              break;
            case acp.methods.agent.session.resume:
              // A resume the test can make fail, so the one path that strands a
              // queue for ever — an agent that died mid-turn and could not be
              // brought back — is reachable. See `refuseResume`.
              if (resumeRefused.on) {
                send({ jsonrpc: "2.0", id, error: { code: -32000, message: "cannot resume" } });
                break;
              }
              send({ jsonrpc: "2.0", id, result: { sessionId } });
              break;
            case acp.methods.agent.session.prompt:
              promptsSeen.push(textOf(message["params"]));
              promptSessions.push(String(message["params"]?.["sessionId"] ?? ""));
              heldPromptId = id;
              break;
            case "_session/steering": {
              steersSeen.push(textOf(message["params"]));
              /*
               * ⚠ **The opt-in is asserted here, at the only place that can see
               * it.** `Session.steer` calls `idleBehavior: "promptRequired"` "not
               * optional", and it is the whole defence against `startedNewTurn` —
               * a turn with no `session/prompt` to resolve, which this daemon
               * could never see end. Nothing held it: deleting the `_meta` key
               * left every check in this file green.
               */
              steerMeta.push(JSON.stringify(message["params"]?.["_meta"] ?? null));
              const answerSteer = () => {
                if (options.answers === null) {
                  send({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
                } else {
                  send({ jsonrpc: "2.0", id, result: { outcome: options.answers } });
                }
              };
              if (options.holdsSteer === true) {
                heldSteers.push(answerSteer);
                break;
              }
              if (options.endsTurnOnSteer === true && heldPromptId !== null) {
                const ending = heldPromptId;
                heldPromptId = null;
                send({ jsonrpc: "2.0", id: ending, result: { stopReason: "end_turn" } });
                /*
                 * ⚠ **Deferred, and without the delay this stub proves nothing.**
                 * Answering in the same tick lets the steer's promise settle
                 * before the turn's own end has walked the event queue and the
                 * generator, so `this.turn` is still set when `sendMidTurn`
                 * resumes and the entry is queued in front of a `finally` that
                 * has not run yet — the safe ordering, i.e. the case this block
                 * is not about. The delay puts `pump`'s `finally` strictly first,
                 * which is the ordering a real slow agent produces.
                 */
                setTimeout(answerSteer, 20);
              } else {
                answerSteer();
              }
              break;
            }
            default:
              if (id !== undefined) send({ jsonrpc: "2.0", id, result: {} });
          }
        }
      });

      lastAgent = {
        toClient,
        held: () => heldPromptId,
        clear: () => {
          heldPromptId = null;
        },
        steers: () => heldSteers,
      };

      return {
        stdin: toAgent,
        stdout: toClient,
        stderr: new PassThrough(),
        handle: null,
        onceStartError: () => () => {},
        onceExit: () => () => {},
        hasExited: false,
        waitForExit: async () => true,
        endStdin: () => toAgent.end(),
        kill: async () => {},
      };
    };

    class MidTurnRuntime extends LocalRuntime {
      override async availability(): Promise<AgentAvailability[]> {
        return [
          { id: "kimi", displayName: "fake", available: true, loggedIn: true, hint: null, lastStartRefusal: null },
        ];
      }
      override describe(agent: AgentId): AgentLaunchConfig {
        return stubAgentConfig(agent);
      }
      override async launch(): Promise<AgentProcess> {
        return spawn();
      }
    }

    const events = new RefusingStore();
    const registry = new SessionRegistry(
      events,
      null,
      undefined,
      new MidTurnRuntime(),
      null,
      // The one degradation in this feature with no other surface: an adapter
      // that ignores the steering opt-in and starts a turn of its own.
      (detail: string) => warnings?.push(detail),
    );
    const { app } = createApp({
      registry,
      verifier,
      instanceId: "i_midturn",
      startedAt: now,
      credentials,
      roots: [users],
    });
    const managed = await registry.create({ agent: "kimi", cwd: tmp("midturn-") });
    return {
      registry,
      app,
      managed,
      /** Make the next `prompt` append fail, so the next message carries `seq === 0`. */
      events,
      /** Make every later `session/resume` fail, as a broken agent's would. */
      refuseResume: () => {
        resumeRefused.on = true;
      },
      /** Answer every steer this stub is sitting on. */
      releaseSteers: () => {
        const pending = lastAgent?.steers() ?? [];
        while (pending.length > 0) pending.shift()?.();
      },
      /**
       * Reject the held turn as an expired credential.
       *
       * `isAuthFailure` on the pump reads `data.data.errorKind`, and what it
       * drives is `onAgentUnusable` → `restartAgent` → `stop("config_changed")` →
       * `resume`. Driven from here rather than from a flag on the stub so the
       * queue can be filled *first*: an agent dying mid-turn is precisely the turn
       * somebody has typed a correction into, and that ordering is the whole case.
       */
      failTurnAuth: () => {
        const agent = lastAgent;
        if (agent === null) return;
        const id = agent.held();
        if (id === null) return;
        agent.clear();
        agent.toClient.write(
          `${JSON.stringify({
            jsonrpc: "2.0",
            id,
            error: {
              code: -32603,
              message: "Failed to authenticate: OAuth session expired",
              data: { errorKind: "authentication_failed" },
            },
          })}\n`,
        );
      },
      /** End the turn the stub is holding, as a real agent's `turn_end` would. */
      finishTurn: () => {
        const agent = lastAgent;
        if (agent === null) return;
        const id = agent.held();
        if (id === null) return;
        agent.clear();
        agent.toClient.write(`${JSON.stringify({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } })}\n`);
      },
    };
  };

  const quiesce = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 40));

  const post = async (
    app: { fetch: (r: Request) => Promise<Response> | Response },
    id: string,
    text: string,
  ) => {
    const response = await app.fetch(
      new Request(`http://d/sessions/${id}/prompt`, {
        method: "POST",
        headers: { authorization: `Bearer ${tokenFor("u_alice")}`, "content-type": "application/json" },
        body: JSON.stringify({ text }),
      }),
    );
    const raw = await response.text();
    return { status: response.status, body: raw.length === 0 ? null : (JSON.parse(raw) as any) };
  };

  const cancelTurn = async (
    app: { fetch: (r: Request) => Promise<Response> | Response },
    id: string,
  ) => {
    const response = await app.fetch(
      new Request(`http://d/sessions/${id}/cancel`, {
        method: "POST",
        headers: { authorization: `Bearer ${tokenFor("u_alice")}` },
      }),
    );
    const raw = await response.text();
    return { status: response.status, body: raw.length === 0 ? null : (JSON.parse(raw) as any) };
  };

  /* ---- an agent that takes the message into the turn ---- */

  {
    steersSeen.length = 0;
    promptsSeen.length = 0;
    const { app, managed, finishTurn } = await standUp({ advertises: true, answers: "injected" });
    const eventsOf = (type: string) =>
      managed.log
        .read(0, 1000, 1 << 20)
        .map((stored) => stored.event)
        .filter((event) => event.type === type);

    check("the daemon reads the capability off `initialize`", managed.snapshot().midTurnDelivery, "steer");

    const first = await post(app, managed.id, "start the long thing");
    await quiesce();
    check("an ordinary first message is accepted", [first.status, first.body?.accepted], [202, true]);
    check("and a turn is running", managed.status, "running");

    /*
     * The heart of it, and the line that used to be a 409. Both halves are
     * asserted because either alone would pass over a bug: a 202 saying `steered`
     * with nothing on the wire is a daemon that swallowed the message, and a
     * steer on the wire under a 409 is one that sent it and then said no.
     */
    const second = await post(app, managed.id, "actually, do it the other way");
    check("a message sent mid-turn is taken rather than refused", second.status, 202);
    check("and says which way it got there", [second.body?.accepted, second.body?.steered], [true, true]);
    check("naming the turn it went into", second.body?.turn, 1);
    check("the agent really was sent it", steersSeen, ["actually, do it the other way"]);
    /*
     * ⚠ **And sent with the opt-in, which nothing held before this line.**
     * Without `idleBehavior: "promptRequired"` a steer that finds no turn starts
     * one — with no `session/prompt` to resolve, so no `turn_end` this daemon
     * could ever see. Deleting the `_meta` key left every other check here green.
     */
    check("carrying the opt-in that stops a steer starting a turn of its own", steerMeta, [
      JSON.stringify({ steering: { idleBehavior: "promptRequired" } }),
    ]);
    check("and it was not sent as a second prompt", promptsSeen, ["start the long thing"]);

    /*
     * One turn, not two. `armTurn` is never reached on this path, which is the
     * whole reason an injection needs no new turn accounting — and the measured
     * fact it mirrors: the original `session/prompt` resolves exactly once.
     */
    check("no second turn was started for it", managed.snapshot().turn, 1);
    check("and nothing is waiting, because nothing had to", managed.snapshot().queuedPrompts, []);

    /*
     * The log rule, and it is the same for all three landings: a `prompt` event
     * is written when the daemon **accepts** a message, which is what that event
     * has always meant. Two prompts in, two bubbles in the transcript, in the
     * order they were written.
     */
    check(
      "both messages are in the conversation, in the order they were sent",
      eventsOf("prompt").map((event) => (event.type === "prompt" ? event.text : null)),
      ["start the long thing", "actually, do it the other way"],
    );
    /*
     * The seq the route hands back is the one the client settles its echo
     * against, so it has to be the *message's* seq and not a turn number or a
     * position. Read off the log rather than written as a literal: the log holds
     * status and workspace rows too, and a literal here would be asserting where
     * those happen to fall.
     */
    check(
      "and the answer names the seq of the message, which is what settles the echo",
      second.body?.seq,
      managed.log
        .read(0, 1000, 1 << 20)
        .filter((stored) => stored.event.type === "prompt")
        .at(-1)?.seq,
    );

    finishTurn();
    await quiesce();
    check("the turn ends once, for the one prompt that started it", eventsOf("turn_end").length, 1);
    check("and the session is idle rather than owing anybody anything", managed.status, "idle");
  }

  /* ---- an agent that cannot, so the daemon holds it ---- */

  {
    steersSeen.length = 0;
    promptsSeen.length = 0;
    const { app, managed, finishTurn } = await standUp({ advertises: false, answers: null });
    const eventsOf = (type: string) =>
      managed.log
        .read(0, 1000, 1 << 20)
        .map((stored) => stored.event)
        .filter((event) => event.type === type);

    check("this one says it cannot be steered", managed.snapshot().midTurnDelivery, "queue");

    await post(app, managed.id, "start the long thing");
    await quiesce();
    check("a turn is running", managed.status, "running");

    const queued = await post(app, managed.id, "and then tidy up");
    check("the message is still taken", queued.status, 202);
    check("and says it is waiting", [queued.body?.accepted, queued.body?.queued], [true, true]);
    check("with nothing ahead of it", queued.body?.position, 0);
    /*
     * Nothing was tried on the wire. An agent that never advertised the extension
     * is not asked — the probe is the whole test, and sending a `-32601` on every
     * mid-turn message would be this daemon guessing at a capability it was told
     * about.
     */
    check("the agent was not asked to steer it", steersSeen, []);
    check("nor sent it as a second prompt", promptsSeen, ["start the long thing"]);

    check("it is on the snapshot, where a client can see it", managed.snapshot().queuedPrompts.length, 1);
    check(
      "naming the seq of the message it is about",
      managed.snapshot().queuedPrompts[0]?.seq,
      queued.body?.seq,
    );
    /*
     * ⚠ **And nothing else — asserted on the keys, because a type cannot say
     * this.** The internal entry extends the published one with the message body
     * and its uploads, and a `{...entry}` copy put both on every frame until
     * delivery: the same sentence re-sent on every snapshot, one seq away from
     * the `prompt` event that already holds it. Found by driving a real agent,
     * which is where a driver checking `length` and `seq` was never going to look.
     */
    check(
      "and carrying nothing else — not the text, not the uploads",
      Object.keys(managed.snapshot().queuedPrompts[0] ?? {}).sort(),
      ["at", "id", "seq"],
    );
    /*
     * The message is in the conversation *now*, before the agent has it. That is
     * the log rule again, and it is what makes the queue a fact about delivery
     * rather than about the transcript.
     */
    check(
      "and it is already a row in the conversation",
      eventsOf("prompt").map((event) => (event.type === "prompt" ? event.text : null)),
      ["start the long thing", "and then tidy up"],
    );

    /*
     * ⚠ **This shows that a session with something waiting is not parkable; it
     * does *not* reach the queue clause, and saying so is the point.**
     *
     * `parkable` refuses at its first line here, on `status !== "idle"`, because
     * the turn is still running. The queue clause below it is unreachable as the
     * code stands — `deliverQueued` declines only in states `status` does not
     * report as `idle` — and it is kept as a refusal for the reason its own
     * docblock gives, beside `resumeGivenUp`, which is in exactly the same
     * position. An assertion claiming to drive it would be the worse kind of
     * green: mutating that clause to `if (false)` leaves this file passing, and a
     * reader should learn that here rather than from a mutation run.
     */
    check("a session with something waiting is not one a ceiling may take", managed.parkable(Date.now(), 0), false);

    finishTurn();
    await quiesce();

    check("the queued message reaches the agent when the turn ends", promptsSeen, [
      "start the long thing",
      "and then tidy up",
    ]);
    check("and stops waiting", managed.snapshot().queuedPrompts, []);
    /*
     * **Not appended twice**, which is the one way this feature could quietly
     * ruin a transcript: the event was written at accept, and delivery must add
     * nothing. Two prompts in, two prompt events, however they travelled.
     */
    check("with no second copy of it in the conversation", eventsOf("prompt").length, 2);
    check("and a turn of its own", managed.snapshot().turn, 2);
    /*
     * Still not parkable, and now for the *ordinary* reason — the session is
     * running the message it was holding. Asserted as the pair so the two causes
     * cannot be confused: what refuses here is `status`, and the queue clause has
     * stood down.
     */
    check(
      "which is what refuses the ceiling now, the queue having stood down",
      [managed.status, managed.snapshot().queuedPrompts.length, managed.parkable(Date.now(), 0)],
      ["running", 0, false],
    );

    finishTurn();
    await quiesce();
    check("and once that turn ends too, nothing is owed and it may be parked", managed.parkable(Date.now(), 0), true);
    // Delivered once. A drain that re-read a shifted entry would show up here as
    // a third prompt on the wire and nowhere else.
    check("the queue delivered it exactly once", promptsSeen.length, 2);
  }

  /* ---- an agent that advertises the extension and then refuses the call ---- */

  {
    steersSeen.length = 0;
    promptsSeen.length = 0;
    const { app, managed, finishTurn } = await standUp({ advertises: true, answers: null });

    await post(app, managed.id, "start the long thing");
    await quiesce();
    const answered = await post(app, managed.id, "a correction");
    /*
     * The message is not lost, and that is the whole assertion. An agent may
     * advertise `_meta.steering.supported` and answer `-32601`; the honest reading
     * is that this daemon cannot steer it, and the queue is what covers that
     * without the person ever finding out.
     */
    check("a steer the agent refuses falls back to the queue", [answered.status, answered.body?.queued], [202, true]);
    check("having genuinely tried first", steersSeen, ["a correction"]);
    finishTurn();
    await quiesce();
    check("and it is delivered like any other queued message", promptsSeen, [
      "start the long thing",
      "a correction",
    ]);
  }

  /* ---- the agent dies under the turn and is replaced ---- */

  {
    steersSeen.length = 0;
    promptsSeen.length = 0;
    const { app, managed, failTurnAuth } = await standUp({ advertises: false, answers: null });

    await post(app, managed.id, "start the long thing");
    await quiesce();
    const queued = await post(app, managed.id, "and then tidy up");
    check("the message is taken while the agent is working", queued.body?.queued, true);

    failTurnAuth();
    await quiesce();

    /*
     * ⚠ **A restart is a process boundary, not the end of the session, and the
     * queue has to know the difference.**
     *
     * `restartAgent` reaches its boundary through `stop("config_changed")`, so
     * `doStop`'s drop ran on a session that was coming straight back: the message
     * was thrown away *and* the transcript was told "the session stopped before
     * this message reached the agent" about a session that had not stopped. It
     * also made `restartAgent`'s own `deliverQueued` dead code. Reached here the
     * way it is reached in the fleet — an expired credential reported mid-turn,
     * which is the likeliest turn for somebody to have typed a correction into.
     */
    await managed.whenRestarted();
    await quiesce();

    check("the session came back rather than ending", managed.terminal, false);
    check(
      "and it never claimed to have stopped",
      managed.log
        .read(0, 1000, 1 << 20)
        .map((stored) => stored.event)
        .filter((event) => event.type === "error" && /session stopped/.test(event.message)).length,
      0,
    );
    check("the queued message survived the new agent", promptsSeen.includes("and then tidy up"), true);
    check("and nothing is left waiting", managed.snapshot().queuedPrompts, []);
  }

  /* ---- the turn ends while the steer is in flight ---- */

  {
    steersSeen.length = 0;
    promptsSeen.length = 0;
    const { app, managed } = await standUp({ advertises: true, answers: null, endsTurnOnSteer: true });

    await post(app, managed.id, "start the long thing");
    await quiesce();
    const raced = await post(app, managed.id, "a correction");
    await quiesce();

    /*
     * ⚠ **The message must not strand, and nothing else in this file would
     * notice if it did.** The turn ends inside the steer, so `pump`'s `finally`
     * drains an empty queue and goes quiet; the entry is pushed after that, and
     * without the drain at the foot of `sendMidTurn` it waits for a turn nobody
     * is going to start — indefinitely, on an idle session, with the transcript
     * showing the message as if it had been sent.
     */
    check("the message is still taken", [raced.status, raced.body?.accepted], [202, true]);
    check("and it actually reaches the agent rather than stranding", promptsSeen, [
      "start the long thing",
      "a correction",
    ]);
    check("with nothing left waiting", managed.snapshot().queuedPrompts, []);
    check("and it was tried as a steer first", steersSeen, ["a correction"]);
  }

  /* ---- a stop lands while the steer is in flight ---- */

  {
    steersSeen.length = 0;
    promptsSeen.length = 0;
    const { app, managed, releaseSteers } = await standUp({
      advertises: true,
      answers: null,
      holdsSteer: true,
    });

    await post(app, managed.id, "start the long thing");
    await quiesce();
    const pending = post(app, managed.id, "a correction");
    await quiesce();

    /*
     * ⚠ **Every guard in `sendMidTurn` was taken before its two awaits, and a
     * stop landing inside them used to walk straight past all of them.**
     *
     * What that produced: a `202 {queued: true}` for a session that was already
     * terminal; `doStop`'s own drop having run while the queue was still empty,
     * so nothing was said; a `prompt` event with no turn end and no error after
     * it — Q2.218's shape exactly; an entry riding `queuedPrompts` on every
     * snapshot of a dead session for ever; and uploads marked consumed for a
     * message nobody would ever read.
     */
    await managed.stop();
    releaseSteers();
    const answer = await pending;

    check("a stop that lands inside the steer is reported as one", answer.status, 409);
    check("naming the session rather than the queue", answer.body?.error?.code, "session_terminal");
    check("nothing is left riding the snapshot of a dead session", managed.snapshot().queuedPrompts, []);
    /*
     * And the message is not left silent. It was accepted and written into the
     * log before the steer, so the one thing this daemon owes is saying that it
     * will not be delivered — the same debt `doStop` pays for a queue it drops.
     */
    check(
      "and the message it had already accepted says it never arrived",
      managed.log
        .read(0, 1000, 1 << 20)
        .map((stored) => stored.event)
        .filter((event) => event.type === "error" && /never reached|reached the agent/.test(event.message))
        .length,
      1,
    );
  }

  /* ---- stopping the turn, with something already waiting ---- */

  {
    steersSeen.length = 0;
    promptsSeen.length = 0;
    const { app, managed, finishTurn } = await standUp({ advertises: false, answers: null });
    void finishTurn;

    await post(app, managed.id, "start the long thing");
    await quiesce();
    await post(app, managed.id, "actually do this instead");
    await quiesce();

    /*
     * **A cancel ends the turn, and the queue then delivers — which is the
     * decision rather than a side effect, so it is driven rather than left to be
     * discovered.**
     *
     * It makes "type the correction, press Stop" one gesture that steers a
     * queueing agent, which is the same act `revising` already performs for a
     * plan card (cancel, then prompt) reached from the other direction. The cost
     * is stated: there is **no way to take a queued message back** — no ✕, by
     * decision, matching Claude Code — so Stop cannot also mean "and forget what
     * I said". Dropping it instead would make "typed it, then pressed Stop"
     * silently lose the text, which this codebase does not do.
     */
    const cancelled = await cancelTurn(app, managed.id);
    check("the cancel is a 200 that names the turn it stopped", [cancelled.status, cancelled.body?.cancelled], [200, true]);
    await quiesce();
    check("and what was waiting is what the agent gets next", promptsSeen, [
      "start the long thing",
      "actually do this instead",
    ]);
    check("with nothing left waiting", managed.snapshot().queuedPrompts, []);
  }

  /* ---- the two steer outcomes that are not `injected` ---- */

  {
    steersSeen.length = 0;
    promptsSeen.length = 0;
    const { app, managed } = await standUp({
      advertises: true,
      answers: "promptRequired",
      // The turn really has to be gone, or this asserts the *other* arm — see
      // the second half below.
      endsTurnOnSteer: true,
    });
    await post(app, managed.id, "start the long thing");
    await quiesce();
    const answered = await post(app, managed.id, "a correction");
    await quiesce();
    /*
     * `promptRequired` is the answer the opt-in exists to produce: the turn ended
     * under the steer and **nothing was delivered**, so the daemon owes the
     * message an ordinary turn of its own. That arm is also the one place an
     * append happens before a turn is armed, which is why it is worth reaching.
     */
    check("a steer that finds no turn is not treated as delivered", answered.status, 202);
    check("the message is sent as an ordinary prompt instead", promptsSeen, [
      "start the long thing",
      "a correction",
    ]);
    /*
     * ⚠ **The body, because the status cannot tell these two apart.** Deleting the
     * arm this block is about left every other assertion here green: the message
     * falls through to the queue, `deliverQueued` one line on drains it because
     * the turn is already null, so the agent still gets it and the queue still
     * ends empty — and a queued answer is a 202 too. What separates an armed turn
     * from a queued delivery is `turn` against `queued`, and nothing was reading
     * either.
     */
    check(
      "and it is armed as a turn of its own rather than queued behind one",
      [answered.body?.queued, answered.body?.turn],
      [undefined, 2],
    );
    check("and nothing is left waiting", managed.snapshot().queuedPrompts, []);
  }

  {
    steersSeen.length = 0;
    promptsSeen.length = 0;
    const { app, managed, finishTurn } = await standUp({ advertises: true, answers: "promptRequired" });
    await post(app, managed.id, "start the long thing");
    await quiesce();
    const answered = await post(app, managed.id, "a correction");
    /*
     * ⚠ **And the same answer means the opposite thing while this daemon still
     * holds a turn.** The adapter says it found none; our own bookkeeping says
     * there is one. Arming a second turn on the strength of the adapter's view
     * would be exactly the double-turn `Session.prompt`'s own guard exists to
     * refuse, so the message queues and waits for the turn we can see.
     */
    check("a promptRequired against a turn we still hold is queued, not armed", answered.body?.queued, true);
    check("nothing was sent as a second prompt", promptsSeen, ["start the long thing"]);
    finishTurn();
    await quiesce();
    check("and it goes when that turn really ends", promptsSeen, ["start the long thing", "a correction"]);
  }

  {
    steersSeen.length = 0;
    promptsSeen.length = 0;
    const warnings: string[] = [];
    const { app, managed } = await standUp({ advertises: true, answers: "startedNewTurn" }, warnings);
    await post(app, managed.id, "start the long thing");
    await quiesce();
    const answered = await post(app, managed.id, "a correction");
    /*
     * ⚠ **The arm the opt-in is supposed to make unreachable, kept because an
     * adapter may ignore it.** The agent has the message — so re-sending it would
     * double it — and what is lost is the turn boundary: there is no
     * `session/prompt` to resolve, so no `turn_end` will ever arrive for it. That
     * is invisible from every other surface, which is why it is reported.
     */
    check("the message is treated as delivered rather than sent twice", answered.body?.steered, true);
    check("and it was not sent as a second prompt", promptsSeen, ["start the long thing"]);
    check(
      "the daemon says out loud that it cannot see that turn end",
      warnings.filter((line) => /cannot see end/.test(line)).length,
      1,
    );
    check("with nothing queued behind it", managed.snapshot().queuedPrompts, []);
  }

  /* ---- the bound, on the path where it is not one statement away ---- */

  {
    steersSeen.length = 0;
    promptsSeen.length = 0;
    const { app, managed, releaseSteers } = await standUp({
      advertises: true,
      answers: null,
      holdsSteer: true,
    });
    await post(app, managed.id, "start the long thing");
    await quiesce();

    /*
     * ⚠ **On a steerable agent the push is two awaits after the check, so the
     * bound has to be read twice.**
     *
     * The block further down drives the bound on the *queueing* path, where the
     * whole body is await-free and one check is exact. Here it is not: every one
     * of these sends passes the entry check while the queue is empty, sits in its
     * own steer, and pushes only when that steer fails. Fired concurrently and
     * released together, they are the shape that walks past a single check.
     */
    const overshoot = MAX_QUEUED_PROMPTS + 3;
    const inFlight = Array.from({ length: overshoot }, (_unused, i) => post(app, managed.id, `concurrent ${i}`));
    await quiesce();
    releaseSteers();
    const answers = await Promise.all(inFlight);

    check("the queue is at its bound and not past it", managed.snapshot().queuedPrompts.length, MAX_QUEUED_PROMPTS);
    check(
      "and the ones that did not fit were refused rather than dropped in silence",
      answers.filter((a) => a.body?.error?.code === "prompt_queue_full").length,
      overshoot - MAX_QUEUED_PROMPTS,
    );
    /*
     * ⚠ **And each of those leaving the conversation untouched, which is a
     * correction to what this block used to assert.**
     *
     * It asserted one `error` per refusal, *"since it was already written there"*
     * — true while the concurrent overshoot slipped past the entry check and was
     * caught only after `recordPrompt` had run, which is the defect the slot
     * reservation closed. The reservation is weighed at the entry check, before
     * anything is written, so these three are now refused with nothing to
     * explain: no `prompt` event, and therefore no `error` owed for one. That is
     * the ordering `sendMidTurn`'s own docblock demands — *"the bound is checked
     * before anything is written ... a recorded prompt nobody will ever deliver
     * is precisely the shape Q2.218 calls a message that reached no model"* — so
     * the stronger property is asserted here rather than the weaker one being
     * repaired.
     *
     * Both halves, because either alone is silent: no `error` could also mean the
     * refusals stopped saying anything about a prompt they *did* write, and the
     * prompt count is what rules that out.
     */
    const written = managed.log.read(0, 1000, 1 << 20).map((stored) => stored.event);
    check(
      "the refused ones wrote nothing into the conversation to have to explain",
      written.filter((event) => event.type === "error" && /already waiting/.test(event.message)).length,
      0,
    );
    check(
      "and left no prompt behind either, which is what makes that silence right",
      written.filter((event) => event.type === "prompt").length,
      1 + MAX_QUEUED_PROMPTS,
    );
  }

  /* ---- the surface that did NOT change, and had nothing holding it ---- */

  /*
   * ⚠ **A plugin's `sessions.prompt` still refuses mid-turn, under the word it
   * always used**, and this is asserted because nothing held it: `api.ts` builds
   * its error code out of `result.kind`, so splitting `busy` into two arms would
   * silently have renamed a plugin-visible code from `session_busy` to
   * `session_turn_in_flight` — a wire change nobody asked for, on a surface with
   * no version negotiation at all.
   *
   * It is also the right behaviour rather than only the compatible one. A
   * plugin's prompt takes an origin claim, and that claim is spent on the next
   * `turn_end` — which a steered message never produces, an injection not being a
   * second turn. A steered plugin message would therefore spend the *current*
   * turn's end and suppress the hook for a turn it had nothing to do with.
   *
   * Source text, in this repository's idiom for a decision with no pure function
   * behind it, because the failure mode is silence: both halves are pinned, so
   * deleting the mapping fails here rather than in somebody's plugin.
   */
  {
    const api = readFileSync(new URL("../src/plugins/api.ts", import.meta.url), "utf8");
    check(
      "a plugin's mid-turn prompt is still reported as `busy`",
      /result\.kind === "turn_in_flight" \? "busy" : result\.kind/.test(api),
      true,
    );
    check(
      "and the code is built from that, not from the raw kind",
      /`session_\$\{kind\}`/.test(api),
      true,
    );
  }

  /*
   * A message the log could not record goes to the back of the queue, not the front.
   *
   * ⚠ **The queue is ordered by acceptance and never by the log seq, and this is
   * the case that forces the distinction.** Ordering by `seq` reads as the same
   * thing — the two agree on every healthy append — until `safeAppend` catches a
   * store fault and answers `null`, which `recordPrompt` turns into `seq === 0`.
   * Every real entry is above zero, so `findIndex(q => q.seq > seq)` answered `0`
   * for it and the message was spliced to the **head**: handed to the agent before
   * every message accepted earlier, which is verbatim the reversal the ordering
   * exists to prevent, reached through a narrower door and under a comment
   * asserting it was closed.
   *
   * Driven on the plain agent because that path has no awaits at all, so what is
   * being asserted is the ordering key and nothing about steer timing.
   */
  {
    steersSeen.length = 0;
    promptsSeen.length = 0;
    const { app, managed, events, finishTurn } = await standUp({ advertises: false, answers: null });
    await post(app, managed.id, "start the long thing");
    await quiesce();

    await post(app, managed.id, "first, and recorded");
    events.refuseNextPrompt = true;
    await post(app, managed.id, "second, and the store refuses it");
    await quiesce();

    const waiting = managed.snapshot().queuedPrompts;
    check("both messages are waiting", waiting.length, 2);
    check(
      "the one the log could not record carries the seq that says so",
      waiting.map((entry) => entry.seq > 0),
      [true, false],
    );
    check(
      "and it is behind the message taken before it, not in front of it",
      waiting.map((entry) => entry.id),
      ["q_1", "q_2"],
    );
    // The delivery order is the queue order, so this is the half that actually
    // reaches the agent — the assertion above is only where they sit.
    finishTurn();
    await quiesce();
    check(
      "so the agent is handed them in the order they were taken",
      promptsSeen.slice(1),
      ["first, and recorded"],
    );
  }

  /* ---- the bound, and what a stop does to what is left ---- */

  {
    steersSeen.length = 0;
    promptsSeen.length = 0;
    const { app, managed } = await standUp({ advertises: false, answers: null });
    await post(app, managed.id, "start the long thing");
    await quiesce();

    for (let i = 0; i < MAX_QUEUED_PROMPTS; i += 1) await post(app, managed.id, `queued ${i}`);
    check("the queue fills to its bound", managed.snapshot().queuedPrompts.length, MAX_QUEUED_PROMPTS);

    const over = await post(app, managed.id, "one too many");
    /*
     * A 429 rather than a 409: nothing about this session is wrong and nothing
     * needs answering first, there is simply a ceiling. And **nothing was
     * written** — the bound is checked before the append precisely so a refused
     * message does not leave a prompt event nobody will ever deliver, which is the
     * shape Q2.218 calls a message that reached no model.
     */
    check("and refuses past it", [over.status, over.body?.error?.code], [429, "prompt_queue_full"]);
    check("naming the limit rather than making the caller guess", over.body?.error?.detail?.limit, MAX_QUEUED_PROMPTS);
    check(
      "with nothing written for the message it refused",
      managed.log
        .read(0, 1000, 1 << 20)
        .map((stored) => stored.event)
        .filter((event) => event.type === "prompt").length,
      MAX_QUEUED_PROMPTS + 1,
    );

    await managed.stop();
    /*
     * A stop drops the queue, and **says so**. Each queued message is already a
     * `prompt` event with nothing after it, so silence here would manufacture
     * exactly the "four prompts, three turn ends" shape Q2.218 was written about.
     * One row for one act, not one per message.
     */
    check("stopping drops what was waiting", managed.snapshot().queuedPrompts, []);
    const errors = managed.log
      .read(0, 1000, 1 << 20)
      .map((stored) => stored.event)
      .filter((event) => event.type === "error");
    check("and writes one line saying they never arrived", errors.length, 1);
    check(
      "counting them rather than naming one",
      errors[0]?.type === "error" ? errors[0].message : null,
      `the session stopped before ${MAX_QUEUED_PROMPTS} messages reached the agent`,
    );
  }

  /* ---- an agent that names the extension to say no ---- */

  {
    steersSeen.length = 0;
    promptsSeen.length = 0;
    const { app, managed, finishTurn } = await standUp({ advertises: "declined", answers: "injected" });

    /*
     * ⚠ **`{supported: false}`, which is the only shape that reaches
     * `supportsSteering`'s decision.** The function ends `=== true` rather than a
     * marker test, and its docblock argues that at length — a declared boolean
     * read as a marker turns a decline into a yes. Nothing held it: with only the
     * advertises/silent pair, mutating that line to `!== undefined` left this file
     * green, because a silent agent is already answered by the guard above it.
     * The stub *answers* `injected`, so if the capability were misread the steer
     * would visibly succeed.
     */
    check("an agent that declines by name is not one this daemon steers", managed.snapshot().midTurnDelivery, "queue");
    await post(app, managed.id, "start the long thing");
    await quiesce();
    const answered = await post(app, managed.id, "a correction");
    await quiesce();
    check("so the message waits instead", answered.body?.queued, true);
    check("and no steer was even attempted", steersSeen, []);
    finishTurn();
    await quiesce();
    check("it is delivered when the turn ends", promptsSeen, ["start the long thing", "a correction"]);
  }

  /* ---- a `/clear` landing inside the steer ---- */

  {
    steersSeen.length = 0;
    promptsSeen.length = 0;
    promptSessions.length = 0;
    const { app, managed, finishTurn, releaseSteers } = await standUp({
      advertises: true,
      answers: "promptRequired",
      holdsSteer: true,
    });

    await post(app, managed.id, "start the long thing");
    await quiesce();
    const pending = post(app, managed.id, "a correction");
    await quiesce();

    /*
     * ⚠ **The window the entry guards do not cover, and the one they were taken
     * to close.**
     *
     * `sendMidTurn` takes `terminal`, `stopRequested`, `session` and
     * `clearing || restarting` before `blocksFor` and `steer`, and the
     * `prompt_required` arm used to answer from inside the steer block having
     * re-taken only the first two. So: the turn ends under the steer, a `/clear`
     * begins — which it may, because a clear is refused only while a turn is in
     * flight — and the arm armed a turn anyway. Reproduced before the fix: `202
     * {accepted: true}` with the `session/prompt` addressed to `s_midturn_1`, the
     * conversation `clearContext` had just replaced, while the daemon held
     * `s_midturn_2`. The message went to a model nobody would ever read, reported
     * as a success. That is verbatim what the `clearing` field's own docblock
     * says it exists to prevent.
     *
     * A stop in the same window is covered one block up and needs no arm here:
     * `doStop` disposes the session, which rejects the held steer outright.
     */
    finishTurn();
    await quiesce();
    const clearing = managed.clearContext("/clear");
    releaseSteers();
    const answer = await pending;
    await clearing;
    await quiesce();

    check("a clear starting inside the steer does not have a turn armed under it", answer.body?.accepted, true);
    check("the message waits for the fresh conversation rather than being pumped", answer.body?.queued, true);
    check(
      "and when it is delivered it goes to the conversation that exists, never the one the clear replaced",
      promptSessions,
      ["s_midturn_1", "s_midturn_2"],
    );
    check("with the message itself intact", promptsSeen, ["start the long thing", "a correction"]);
    check("and nothing left waiting", managed.snapshot().queuedPrompts, []);
  }

  /* ---- a restart that could not bring an agent back ---- */

  {
    steersSeen.length = 0;
    promptsSeen.length = 0;
    const { app, managed, failTurnAuth, refuseResume } = await standUp({ advertises: false, answers: null });

    await post(app, managed.id, "start the long thing");
    await quiesce();
    await post(app, managed.id, "and then tidy up");
    await quiesce();
    check("the message is waiting", managed.snapshot().queuedPrompts.length, 1);

    /*
     * ⚠ **`doStop` keeps the queue for `config_changed`, so the restart owes it a
     * home — and a restart that fails has none.**
     *
     * `restartAgent` reaches its boundary through `stop("config_changed")`, one of
     * the three reasons the drop deliberately skips, and pays that back with a
     * `deliverQueued` in its `finally`. When `resume()` throws, that call lands on
     * a null session and returns; `pump`'s `finally` and `clearContext` are the
     * only other callers and neither runs on a session that never came back. So
     * before the fix the entry rode `queuedPrompts` on every snapshot of a
     * terminal session for ever, drawing "Waiting for the agent to finish" under a
     * message in a conversation that had ended, with no error saying otherwise —
     * and `wakeForPrompt` could revive that session, delivering the stale message
     * *after* whatever was typed next. `onAgentUnusable` swallows the restart's
     * failure, and it is the caller most likely to meet it.
     */
    refuseResume();
    failTurnAuth();
    await quiesce();
    await quiesce();
    await quiesce();

    check("a restart that could not come back leaves nothing waiting", managed.snapshot().queuedPrompts, []);
    const stranded = managed.log
      .read(0, 1000, 1 << 20)
      .map((stored) => stored.event)
      .filter((event) => event.type === "error" && event.message === stoppedBeforeDelivery(1));
    check("and says the message never arrived, rather than going quiet", stranded.length, 1);
    check("the agent was never given it", promptsSeen, ["start the long thing"]);
  }
}
