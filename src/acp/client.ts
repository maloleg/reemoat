import type { Readable as NodeReadable } from "node:stream";
import { PassThrough, Readable, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import * as acp from "@agentclientprotocol/sdk";
import type { AgentHandle, AgentProcess } from "../runtime/types.js";
import type { AgentLaunchConfig } from "./agents.js";
import type { AgentRouting } from "./systems.js";
import { AIR_CLIENT_CAPABILITY, ASYNC_TASK_MARKER, ASYNC_TASK_UPDATES, agentAdvertisesAsyncTasks } from "./asynctasks.js";

/** Callbacks a session registers to receive everything addressed to it. */
export interface SessionHandlers {
  onUpdate(notification: acp.SessionNotification): void;
  onPermission(
    request: acp.RequestPermissionRequest,
    signal: AbortSignal,
  ): Promise<acp.RequestPermissionResponse>;
  onReadTextFile(request: acp.ReadTextFileRequest): Promise<acp.ReadTextFileResponse>;
  onWriteTextFile(request: acp.WriteTextFileRequest): Promise<acp.WriteTextFileResponse>;
  /**
   * The agent wants to ask the person on the other end of this daemon something.
   *
   * Form mode only, and already narrowed to the session-scoped arm — the router
   * below refuses everything else before a handler sees it, so this never has to
   * ask which shape it was handed.
   *
   * Parked exactly like {@link onPermission}: the returned promise is the agent's
   * turn held open, and it may be held for as long as somebody takes to answer.
   */
  onElicitation(
    request: ElicitationRequest,
    signal: AbortSignal,
  ): Promise<acp.CreateElicitationResponse>;
}

/**
 * A form elicitation, scoped to a session.
 *
 * The SDK's `CreateElicitationRequest` is a three-way union over `mode` crossed
 * with a two-way union over scope, and exactly one of those six shapes is one
 * this daemon can do anything with. Narrowing it here rather than at every reader
 * is what lets `session.ts` treat `sessionId` and `requestedSchema` as present.
 */
export type ElicitationRequest = acp.ElicitationFormMode &
  acp.ElicitationSessionScope & { message: string };

export type LogListener = (line: string) => void;

/**
 * A tap on every `session/update` notification, before anything normalizes it.
 *
 * This exists because the daemon's own vocabulary is lossy by design — `_meta`
 * is an agent-shaped blob and `session.ts` deliberately projects a few fields
 * out of it rather than carrying it — and "what does the agent actually send"
 * has now been a question three times over (`usage_update._meta`, the
 * `terminal_info` blocks, subagent lineage). Inspecting an adapter's `dist/` is
 * not an answer: the relay note already records that inspection was not enough.
 *
 * Nothing in the daemon subscribes. `scripts/harness.ts` does, behind `--raw`,
 * which is what makes a measurement re-runnable instead of a patch somebody
 * applied once and threw away.
 */
export type NotificationListener = (notification: acp.SessionNotification) => void;

export interface LaunchOptions {
  /**
   * Whether this daemon will perform file IO on the agent's behalf.
   *
   * **Required, with no default, on purpose.** It used to be optional and
   * default to `true`, so deleting the argument at either call site silently
   * handed every tenant a read/write primitive executing in the daemon's
   * process, outside their container — and both offline drivers stayed green,
   * because they assert `SessionRuntime.clientFileIo` is `false` rather than
   * asserting anything reads it. Making it required turns that deletion into a
   * type error. See `SessionRuntime.clientFileIo`.
   */
  fileIo: boolean;
  /**
   * Whether a human on the other side of this daemon can be shown a form.
   *
   * **Required, with no default, for the same reason `fileIo` is** — and with a
   * consequence `fileIo` does not have. Declaring this changes what the *model*
   * does rather than what the client renders: measured against claude-agent-acp
   * 0.63.0, `disallowedTools = elicitationSupport.form ? [] : ["AskUserQuestion"]`,
   * so an undeclared capability strips claude's own ask-the-user tool out of the
   * toolset before the CLI starts. Turning it on hands the model a tool back.
   *
   * Derived from whether anybody is there to answer — see `SessionOptions.
   * elicitations`. Unlike `fs`, where this daemon can always perform the write
   * and so "able" and "advertised" are separable values, a question has no
   * defensible default answer: `onPermission` can fall back to allow-once, and
   * nothing can fall back to a person's opinion.
   */
  elicitation: boolean;
}

const HANDSHAKE_TIMEOUT_MS = 30_000;

/**
 * How long `providers/list` may take before this agent counts as un-routable.
 *
 * ⚠ **It was unbounded, and it was the only unbounded await on the launch
 * path.** `applySystem` calls it between the handshake and `session/new`, both of
 * which are bounded, and `providers/set` three lines below the call site is
 * bounded too — this was the one request in the sequence with no timer. An
 * adapter that accepts the call and never answers parks `Session.start` for ever:
 * `ManagedSession.launch` races its own `START_TIMEOUT_MS` and throws, but
 * `starting.then(onStarted, onStartFailed)` never fires, so nothing reaches
 * `client.close()` and a `detached` agent child outlives the daemon holding a
 * worktree. The second caller is worse: `AgentAskRuns.capabilities` awaits this
 * inside a `try` whose `finally` releases the slot, so a hang burns one of only
 * two ask slots for the life of the process.
 *
 * The same 15s `session.ts` gives `providers/set`, and the number is written here
 * rather than shared because `withDeadline` is private to `session.ts` and the
 * dependency runs `session` → `acp/*`, never back.
 */
const LIST_PROVIDERS_TIMEOUT_MS = 15_000;
const EXIT_GRACE_MS = 3_000;
const STDERR_RING_SIZE = 20;

/**
 * Shared mutable state between the JSON-RPC handlers and the client instance.
 *
 * The handlers have to be registered before `connect()`, which is before the
 * `AcpClient` exists, so both sides point at this instead.
 */
interface Router {
  sessions: Map<string, SessionHandlers>;
  logListeners: Set<LogListener>;
  notificationListeners: Set<NotificationListener>;
  recentStderr: string[];
}

/**
 * One ACP agent subprocess plus the JSON-RPC connection running over its stdio.
 *
 * The connection outlives any single prompt — that is the shape the daemon
 * needs — so sessions register themselves here and get routed the notifications
 * and reverse-RPC requests that carry their `sessionId`.
 */
export class AcpClient {
  private closing: Promise<void> | null = null;

  private constructor(
    readonly config: AgentLaunchConfig,
    private readonly child: AgentProcess,
    private readonly connection: acp.ClientConnection,
    private readonly router: Router,
    readonly initializeResult: acp.InitializeResponse,
  ) {}

  /** Agent-side method caller (`session/new`, `session/prompt`, `session/cancel`, …). */
  get agent(): acp.ClientContext {
    return this.connection.agent;
  }

  /** Resolves when the ACP connection closes, for any reason. */
  get closed(): Promise<void> {
    return this.connection.closed;
  }

  /**
   * Completes the ACP handshake over an agent the runtime has already started.
   *
   * Fails loudly: a missing binary, a process that dies during the handshake, or
   * an agent that never answers `initialize` all produce an error carrying the
   * agent's last stderr lines. There is no stub fallback.
   *
   * The process arrives rather than being spawned here, which is the whole of
   * the container change as far as this file is concerned: everything below is
   * written against three pipes and a way to signal what is on the other end,
   * and `docker exec -i` supplies exactly that. Measured before it was relied on
   * — an unprompted first frame, a client frame echoed back, UTF-8 intact, a
   * 200 KB frame intact, and stdin EOF terminating the agent with its exit code
   * propagating.
   */
  static async launch(
    config: AgentLaunchConfig,
    child: AgentProcess,
    options: LaunchOptions,
  ): Promise<AcpClient> {
    const fileIo = options.fileIo;
    const elicitation = options.elicitation;
    const router: Router = {
      sessions: new Map(),
      logListeners: new Set(),
      notificationListeners: new Set(),
      recentStderr: [],
    };

    pumpStderr(child.stderr, (line) => {
      router.recentStderr.push(line);
      if (router.recentStderr.length > STDERR_RING_SIZE) router.recentStderr.shift();
      for (const listener of router.logListeners) listener(line);
    });

    /*
     * Everything addressed to a session, delivered once.
     *
     * Hoisted out of the notification handler because there are two roads to it
     * now — the SDK's typed dispatch, and the split below — and a second copy is
     * how the tap comes to see one of them and not the other.
     *
     * Taps first, and deliberately: the line below drops an update for an
     * unregistered session on the floor (optional chaining, no throw), and a
     * measurement that cannot see those is measuring the wrong thing. It also
     * means a session handler that throws does not cost the tap its copy.
     *
     * The tap loop is guarded and evicting, exactly as `SessionLog.append` fans
     * out and for the identical reason: whichever road got here, one broken
     * listener must not abort routing for the notification that was about to be
     * delivered, and a listener that throws has stopped being a tap.
     *
     * ⚠ **The last line is unguarded on purpose, and which failure that buys
     * depends on the road — so neither road may be read off the other.** On the
     * SDK's road this runs inside the agent's own RPC handler, and the SDK
     * **swallows** a throw rather than closing anything: `processIncomingMessage`
     * wraps its own handler loop in a `try`, and for a *notification* — which
     * `session/update` is — the `catch` takes the `else` branch and does
     * `console.error("Error handling notification", …)` (installed 1.3.0,
     * `dist/jsonrpc.js:782-792`). The
     * `processIncomingMessage(message).catch((error) => this.close(error))` at
     * `dist/jsonrpc.js:434` therefore never fires for one: that promise resolves.
     * So a broken session handler on that road costs the *update*, is reported
     * only on the SDK's own stderr, and the connection carries on.
     * On the split road there is no dispatch above it at all
     * — it is a `'data'` listener on a Node stream, where a throw is an
     * `uncaughtException` that the daemon's backstop logs and survives, leaving the
     * agent's stdout permanently deaf instead — the measurement is at `handOff`.
     * That road does not rely on this line: it calls `deliver` through `handOff` in
     * {@link splitAsyncTaskUpdates}, which catches.
     *
     * ⚠ **What `handOff` then does is deliberately *harsher* than the SDK road, and
     * the asymmetry is the decision rather than an oversight.** It calls `giveUp`,
     * which destroys `onward` — so `AcpClient.closed` fires, the session reads
     * `interrupted` and the daemon puts an agent back on it. The SDK road instead
     * loses the one update and carries on. Neither is free, and the choice is
     * between two silences: a lost update on a connection that keeps working is
     * invisible until somebody notices the transcript is missing something, while a
     * closed connection is a state this daemon already has a whole recovery path
     * for. On *this* road the third option is the one that decides it — an
     * unguarded throw in a `'data'` listener is an `uncaughtException`, after which
     * the agent's stdout is permanently deaf with nothing to say so, which is worse
     * than either.
     */
    const deliver = (notification: acp.SessionNotification): void => {
      for (const listener of router.notificationListeners) {
        try {
          listener(notification);
        } catch {
          router.notificationListeners.delete(listener);
        }
      }
      router.sessions.get(notification.sessionId)?.onUpdate(notification);
    };

    const stream = acp.ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(splitAsyncTaskUpdates(child.stdout, deliver)) as ReadableStream<Uint8Array>,
    );

    const route = <T>(sessionId: string, pick: (handlers: SessionHandlers) => T): T => {
      const handlers = router.sessions.get(sessionId);
      if (!handlers) {
        throw acp.RequestError.invalidParams(
          { sessionId },
          `no session registered for ${sessionId}`,
        );
      }
      return pick(handlers);
    };

    const connection = acp
      .client({ name: "reemoat" })
      .onNotification(acp.methods.client.session.update, (ctx) => deliver(ctx.params))
      .onRequest(acp.methods.client.session.requestPermission, (ctx) =>
        route(ctx.params.sessionId, (h) => h.onPermission(ctx.params, ctx.signal)),
      )
      // Gated, not merely undeclared.
      //
      // `clientCapabilities.fs` below tells the agent whether we do file IO for
      // it. That is a *statement to a party we do not trust*: an agent — or
      // anything else inside the tenant's container that can write to the
      // agent's stdout — is free to send the request regardless, and until this
      // gate existed the handler ran it, because the capability flag only ever
      // changed what was advertised. `session.ts` implements these two by
      // calling `readFile`/`writeFile` in the *daemon's* process, so a container
      // around the agent does not contain them.
      //
      // `methodNotFound` is exactly what an unregistered method answers, so a
      // declining runtime is indistinguishable on the wire from one that never
      // implemented these at all.
      .onRequest(acp.methods.client.fs.readTextFile, (ctx) => {
        if (!fileIo) throw acp.RequestError.methodNotFound(acp.methods.client.fs.readTextFile);
        return route(ctx.params.sessionId, (h) => h.onReadTextFile(ctx.params));
      })
      .onRequest(acp.methods.client.fs.writeTextFile, (ctx) => {
        if (!fileIo) throw acp.RequestError.methodNotFound(acp.methods.client.fs.writeTextFile);
        return route(ctx.params.sessionId, (h) => h.onWriteTextFile(ctx.params));
      })
      /*
       * Gated for the same reason `fs` is, and refusing the shapes we cannot
       * render rather than answering them.
       *
       * Three things arrive here and only one is answerable.
       *
       * **`url` mode and any unknown mode** are `invalidParams`. We declare no
       * `url` capability, and claude's adapter declines url-mode itself when the
       * client did not — so one arriving means something ignored the declaration,
       * which is the whole of "a statement is not a gate". A URL is also a URL on
       * *this* host, most often an OAuth callback on loopback, and this daemon is
       * driven from a phone somewhere else; opening it would mean launching a
       * program named by an agent-chosen string, one door along from what the
       * "login command is a table lookup, never a request field" rule forbids.
       *
       * **Request scope** (`requestId`, no `sessionId`) is `invalidParams` too.
       * It exists for auth phases before any session, and this daemon has none —
       * it never calls `session/authenticate`, and every surface it has is
       * per-session. There is nowhere to put such a question: no session to
       * block, no transcript to write it into, no row for a client to find it on.
       * Refusing is the truthful answer rather than a gap. Verified: all three of
       * claude's producers set `sessionId`.
       *
       * All of them are a JSON-RPC **error** and never `{action: "decline"}`,
       * which would be a lie — nobody declined. Measured, the error is also the
       * kindest of the three: `handleAskUserQuestion` turns it into
       * `{behavior: "deny", message: "Could not present the question to the
       * user."}`, so the model is told why and carries on, where a decline tells
       * it a person chose to skip.
       *
       * `isForm` rather than `params.mode === "form"` because the SDK's guards
       * validate the payload as well as the tag, so a form with no
       * `requestedSchema` is refused here instead of reaching the projection with
       * a hole in it.
       */
      .onRequest(acp.methods.client.elicitation.create, (ctx) => {
        if (!elicitation) {
          throw acp.RequestError.methodNotFound(acp.methods.client.elicitation.create);
        }
        const params = ctx.params;
        if (!acp.CreateElicitationRequest.isForm(params)) {
          throw acp.RequestError.invalidParams(
            { mode: params.mode },
            `this client only renders form elicitations, not ${JSON.stringify(params.mode)}`,
          );
        }
        if (!("sessionId" in params)) {
          throw acp.RequestError.invalidParams(
            { scope: "request" },
            "this client only renders elicitations scoped to a session",
          );
        }
        const scoped: ElicitationRequest = params;
        return route(scoped.sessionId, (h) => h.onElicitation(scoped, ctx.signal));
      })
      .connect(stream);

    // Rejects if the process dies or fails to spawn. Pre-handled so a late
    // rejection (after the handshake won the race) is never "unhandled".
    const failed = deferred<never>();
    const onSpawnError = (error: Error) => {
      failed.reject(new Error(`failed to spawn ${config.command}: ${error.message}`));
    };
    const onEarlyExit = (code: number | null, signal: NodeJS.Signals | null) => {
      failed.reject(
        new Error(
          `${config.displayName} exited during the ACP handshake ` +
            `(code=${code ?? "null"}, signal=${signal ?? "null"})`,
        ),
      );
    };
    const offStartError = child.onceStartError(onSpawnError);
    const offExit = child.onceExit(onEarlyExit);

    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error(
              `${config.displayName} did not answer initialize within ${HANDSHAKE_TIMEOUT_MS / 1000}s`,
            ),
          ),
        HANDSHAKE_TIMEOUT_MS,
      );
    });

    try {
      const initializeResult = await Promise.race([
        connection.agent.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          // Whether we take responsibility for file IO is the *runtime's* call,
          // not a constant. Locally we do, and Kimi then routes its writes back
          // through the client, which is where the `source: "fs_write"` half of
          // the file-change pair comes from. When the agent is sandboxed we must
          // not: those reverse-RPCs execute in this process, outside whatever
          // confines the agent. Measured on claude and kimi — both edit files
          // perfectly well without the capability, doing the IO themselves.
          clientCapabilities: {
            fs: { readTextFile: fileIo, writeTextFile: fileIo },
            terminal: false,
            // Unrelated to the trust argument above: this one is safe to grant
            // unconditionally because it grants the *agent* nothing. It says we
            // can render an on/off control, and without it an agent that has one
            // degrades it into a two-entry dropdown — measured on claude, whose
            // Fast-mode toggle arrives as `type: "select"` with options
            // `on`/`off` when this is absent. `{}` is how ACP spells "yes".
            session: { configOptions: { boolean: {} } },
            /*
             * Whether the agent may ask the person a question.
             *
             * **Absence is the only way to say no**, and this is a third
             * capability shape read a third way. `promptCapabilities.image` is a
             * declared boolean, so `acceptsImages` compares `=== true`;
             * `sessionCapabilities.resume` is an empty-object marker, so
             * `supportsSessionResume` compares `!= null`. `ElicitationCapabilities.
             * form` is a marker too and there is no `form: false` in the type —
             * so `fs`'s honest `{readTextFile: false}` decline has no analogue
             * here and the key has to be omitted entirely. Reaching for
             * `{form: false}` is the obvious mistake and it would typecheck
             * against the open `_meta`.
             *
             * `url` is deliberately never declared. See the handler above.
             */
            ...(elicitation ? { elicitation: { form: {} } } : {}),
            /*
             * Whether the agent tells us about work it left running.
             *
             * **The first thing this client declares in `_meta` rather than reads
             * out of one**, and therefore a fifth capability shape — a vendor
             * extension namespace carrying a version and a list of names, where
             * the four above are a boolean, two markers and a boolean under a
             * top-level key. `acp/asynctasks.ts` owns the object and the argument
             * for every part of it, including why `nativeSubagentSessions` is not
             * in that list.
             *
             * ⚠ **Declaring it changes exactly one other thing on the wire, and
             * this client now projects that change.** The backgrounded Bash
             * `tool_call_update` gains an AIR marker, and `Session.onUpdate` reads
             * it through `readBackgroundedMarker` into `ToolCallUpdateEvent.backgrounded`
             * — which is what stops a detached command's card reaching `completed`
             * while the command runs on. `toolCallLineage` still reads only
             * `_meta.claudeCode`; this is the second field ever read out of `_meta`
             * and it is read somewhere else. Worth saying rather than assuming —
             * *"declaring a capability changed nothing else"* is the kind of claim
             * that is true until somebody checks, and here it stopped being true.
             */
            _meta: AIR_CLIENT_CAPABILITY,
          },
          clientInfo: { name: "reemoat", version: "0.0.0" },
        }),
        failed.promise,
        timedOut,
      ]);

      if (initializeResult.protocolVersion > acp.PROTOCOL_VERSION) {
        throw new Error(
          `${config.displayName} negotiated ACP protocol v${initializeResult.protocolVersion}, ` +
            `but this client only speaks v${acp.PROTOCOL_VERSION}`,
        );
      }

      return new AcpClient(config, child, connection, router, initializeResult);
    } catch (error) {
      // A handshake can time out 30s in, by which point the adapter has long
      // since spawned its own child. Going straight to SIGKILL here is exactly
      // how that grandchild gets orphaned, so give the group a chance to unwind.
      await child.kill("SIGTERM");
      if (!(await child.waitForExit(EXIT_GRACE_MS))) await child.kill("SIGKILL");
      try {
        connection.close();
      } catch {
        // already closed
      }
      throw withStderr(error, config, router.recentStderr);
    } finally {
      clearTimeout(timer);
      offStartError();
      offExit();
    }
  }

  /**
   * What this agent will let us do about which LLM its traffic reaches, or
   * `null` where it will not let us do anything.
   *
   * ⚠ **Two facts, read two ways, and both are needed.** The capability marker
   * on `initialize` is an empty object — `sessionCapabilities.resume`'s shape,
   * so it is compared `!= null` and never `=== true` — and it says only that the
   * methods exist. Which *protocols* an agent accepts, and under which provider
   * id, is on `providers/list` and nowhere else. Measured 2026-08-25:
   * `claude-agent-acp` 0.63.0 answers `{providerId: "main", supported:
   * ["anthropic","bedrock","vertex"]}`, `codex-acp` 1.1.9 answers
   * `{providerId: "custom-gateway", supported: ["openai"]}`, and `kimi acp`
   * declares no capability and answers `-32601` to the call. Re-measured
   * 2026-09-04 with the pins at 0.73.0 / 1.8.0: claude unchanged, `codex-acp`
   * 1.8.0 answers `{providerId: "openai", supported: ["openai"]}` — the id has
   * moved once already, which is why it is read here and written down nowhere.
   *
   * ⚠ **Answers `null` rather than throwing, on every failure.** An agent that
   * cannot be routed is not a broken agent — it is two of the three — and the
   * only caller that matters turns `null` into a disabled row with a sentence on
   * it. Throwing here would take a picker down over an agent working perfectly.
   */
  async routing(): Promise<AgentRouting | null> {
    if (this.initializeResult.agentCapabilities?.providers == null) return null;
    let answer: acp.ListProvidersResponse;
    let timer: NodeJS.Timeout | undefined;
    try {
      answer = await Promise.race([
        this.agent.request(acp.methods.agent.providers.list, {}),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  `${this.config.displayName} did not answer providers/list ` +
                    `within ${LIST_PROVIDERS_TIMEOUT_MS / 1000}s`,
                ),
              ),
            LIST_PROVIDERS_TIMEOUT_MS,
          );
        }),
      ]);
    } catch {
      // The capability said yes and the call said no — or said nothing at all
      // until the deadline. Believe the call: a declaration is not a gate, which
      // is the rule this daemon already applies in the other direction to its own
      // `fs` capability.
      //
      // A timeout lands here rather than propagating, which is deliberate and is
      // the whole reason the bound can be added without changing a contract: both
      // callers already treat `null` as "cannot be routed", so a wedged adapter
      // now refuses the pairing by name instead of parking the launch for ever.
      return null;
    } finally {
      clearTimeout(timer);
    }
    /*
     * ⚠ **Read defensively, because nothing above validated this.** The SDK
     * registers `unstable_listProviders` with a *request* validator and no
     * response one — `emptyObjectResponse` sits in that slot for its siblings and
     * is simply absent here — so the raw JSON-RPC `result` arrives as-is, and
     * since this release a `plugin.json` names the binary that answers. Two
     * shapes cost differently and both are reachable: `{}` or `null` throw out of
     * this method, which is outside the `try` above and so escapes `routing()`
     * altogether; `{"providers":[{}]}` throws nothing and yields
     * `supported: undefined`, which is *cached for `MODELS_TTL_MS`* and then
     * indexed by `applySystem` — whose own docblock promises "a
     * `SystemRoutingError` and never a `TypeError`" — and by the browser's mirror
     * at `packages/web/src/agents.ts`, which reads this route through a bare cast.
     *
     * `null` is the arm every caller already has for "cannot be routed", so a
     * malformed answer costs a disabled row with a sentence on it, which is what
     * an agent that answered `-32601` costs too.
     */
    const providers: unknown = (answer as { providers?: unknown } | null | undefined)?.providers;
    if (!Array.isArray(providers)) return null;
    const first: unknown = providers[0];
    if (typeof first !== "object" || first === null) return null;
    const { providerId, supported } = first as { providerId?: unknown; supported?: unknown };
    if (typeof providerId !== "string" || providerId.length === 0) return null;
    // ⚠ **The predicate, not a bare `every`.** `Array.isArray` narrows `unknown` to
    // `any[]`, and `any[]` assigns to `readonly string[]` with no complaint — so a
    // plain `every` would check at runtime while the compiler proved nothing, which
    // is the shape of the defect this whole block exists for.
    if (!Array.isArray(supported)) return null;
    if (!supported.every((one): one is string => typeof one === "string")) return null;
    return { providerId, supported };
  }

  /**
   * Point this agent's traffic at a system before any session exists on it.
   *
   * Process-scoped by the adapters' own contract — claude's says the config
   * "applies to sessions created or loaded after this call" — which is exactly
   * the lifetime this daemon has, since it spawns one adapter per session. The
   * scope and the process line up, so nothing has to be undone.
   */
  async setProvider(params: acp.SetProviderRequest): Promise<void> {
    await this.agent.request(acp.methods.agent.providers.set, params);
  }

  registerSession(sessionId: string, handlers: SessionHandlers): () => void {
    this.router.sessions.set(sessionId, handlers);
    return () => this.router.sessions.delete(sessionId);
  }

  onLog(listener: LogListener): () => void {
    this.router.logListeners.add(listener);
    return () => this.router.logListeners.delete(listener);
  }

  /** Every `session/update`, unnormalized. See `NotificationListener`. */
  onNotification(listener: NotificationListener): () => void {
    this.router.notificationListeners.add(listener);
    return () => this.router.notificationListeners.delete(listener);
  }

  /** The agent's last stderr lines — the useful half of most failures. */
  recentLogs(): string[] {
    return [...this.router.recentStderr];
  }

  /**
   * How to signal this agent, and how to recognise it after a restart.
   *
   * A handle rather than a pid: a container's process group lives in a different
   * number space from this host's, and the two must not be stored in one column
   * as if they meant the same thing.
   */
  get handle(): AgentHandle | null {
    return this.child.handle;
  }

  supportsSessionClose(): boolean {
    return this.initializeResult.agentCapabilities?.sessionCapabilities?.close != null;
  }

  /**
   * Whether the agent can pick up one of its own earlier sessions.
   *
   * Deliberately `session/resume` and not `session/load`: load replays the whole
   * message history back as `session/update` notifications, and we already hold
   * that transcript on disk — taking it again would duplicate every event we have.
   * Resume restores the context and says nothing.
   *
   * All three agents advertise this today (kimi 0.29.2, claude-agent-acp 0.63.0
   * and codex-acp 1.1.9), but the capability is checked rather than assumed,
   * because answering a resume request by silently doubling the transcript would
   * be worse than refusing it.
   *
   * **Advertising it and doing it are different claims, and codex was measured on
   * the second one** — a grep for `session/resume` in a bundle proves nothing, as
   * kimi's `usage_update` demonstrates by appearing exactly once, in a schema it
   * parses and never sends. Measured 2026-08-07 through the daemon: a codex
   * session was auto-resumed across a restart and then answered a question about a
   * command it had run in the previous process.
   */
  supportsSessionResume(): boolean {
    return this.initializeResult.agentCapabilities?.sessionCapabilities?.resume != null;
  }

  /**
   * Whether this agent will take an `image` content block in a prompt.
   *
   * **`=== true`, not `!= null`, and getting that backwards is silent.** The two
   * capability shapes sit in the same payload and are read two different ways on
   * purpose: `sessionCapabilities.resume` above is an empty-object *marker* whose
   * presence is the whole answer, while `promptCapabilities.image` is a declared
   * `boolean` — so `!= null` here would read `{image: false}` as yes and send an
   * agent bytes it said it cannot take.
   *
   * Only `image` is exposed. `embeddedContext` would allow `resource` blocks and
   * nothing here has measured what either agent does with one; an accessor
   * handing back the raw object is how that gets tried on a hunch. Everything
   * else about attachments needs no capability at all — ACP requires every agent
   * to support `resource_link`, which is what lets the composer offer a paperclip
   * unconditionally.
   */
  acceptsImages(): boolean {
    return this.initializeResult.agentCapabilities?.promptCapabilities?.image === true;
  }

  /**
   * Whether this agent will take a message *into* the turn already running.
   *
   * `_session/steering` is an ACP **extension** — the underscore is the protocol's
   * own mark for one — so it is read from `_meta` rather than from
   * `agentCapabilities`, and it is a **fourth** capability shape read a fourth way.
   * `sessionCapabilities.resume` is an empty-object marker, `promptCapabilities.
   * image` a declared boolean, `elicitation.form` a marker whose absence is the
   * only decline — and this one is a declared boolean nested under a top-level
   * `_meta` key, i.e. a sibling of `agentCapabilities` and not a member of it.
   * Reading it off `agentCapabilities._meta` is the obvious mistake and it
   * typechecks, because both `_meta` bags are open.
   *
   * Measured 2026-09-11 on the pinned builds, by sending one `initialize` and
   * printing the answer:
   *
   *   claude-agent-acp 0.73.0  `_meta.steering.supported: true`
   *   codex-acp 1.8.0          `_meta.steering.supported: true`
   *   kimi 0.29.2              no `_meta` on the response at all
   *   opencode                 not measured; no adapter package to read
   *
   * So this is genuinely a per-agent answer rather than a formality, which is why
   * `ManagedSession` carries a queue for the agents that say no. `=== true`, not
   * `!= null`, for `acceptsImages`' reason: a declared boolean read as a marker
   * turns `{supported: false}` into yes.
   */
  supportsSteering(): boolean {
    const meta = this.initializeResult._meta;
    if (meta === null || typeof meta !== "object") return false;
    const steering = (meta as Record<string, unknown>)["steering"];
    if (steering === null || typeof steering !== "object") return false;
    return (steering as Record<string, unknown>)["supported"] === true;
  }

  /**
   * Whether this agent reports the background work it starts.
   *
   * Read off the agent's own `initialize` answer rather than off its id, which is
   * the rule `ultracodeOptionId` already follows — and here it buys a value
   * nothing else can supply. A count of zero from kimi, which backgrounds fully
   * and says nothing, is indistinguishable from a count of zero from claude with
   * nothing running; without this the panel draws an empty list for three agents
   * out of four and claims it means *nothing is running*. It is `contextUsage`'s
   * `null`-means-cannot-tell one field over.
   *
   * The same top-level `_meta` bag `supportsSteering` reads, which is also where
   * the adapter publishes the AIR capability list — so the read side already had
   * a home. `agentAdvertisesAsyncTasks` is the mirror of the gate the adapter
   * applies to the object we send.
   */
  supportsAsyncTasks(): boolean {
    return agentAdvertisesAsyncTasks(this.initializeResult._meta);
  }

  /**
   * Shuts the agent down without leaving an orphan.
   *
   * Closing stdin is the graceful path — both adapters treat EOF as "connection
   * over, exit". SIGTERM then SIGKILL are the fallbacks.
   */
  async close(): Promise<void> {
    this.closing ??= this.doClose();
    return this.closing;
  }

  private async doClose(): Promise<void> {
    this.child.endStdin();
    if (!(await this.child.waitForExit(EXIT_GRACE_MS))) {
      await this.child.kill("SIGTERM");
      if (!(await this.child.waitForExit(EXIT_GRACE_MS))) {
        await this.child.kill("SIGKILL");
        await this.child.waitForExit(EXIT_GRACE_MS);
      }
    }
    try {
      this.connection.close();
    } catch {
      // already closed by the transport ending
    }
  }
}

function deferred<T>(): { promise: Promise<T>; reject: (error: Error) => void } {
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((_, rej) => {
    reject = rej;
  });
  // Mark as handled so a rejection that loses the race is not "unhandled".
  promise.catch(() => {});
  return { promise, reject };
}

function withStderr(error: unknown, config: AgentLaunchConfig, lines: string[]): Error {
  const base = error instanceof Error ? error : new Error(String(error));
  if (lines.length === 0) return base;
  base.message =
    `${base.message}\n\n--- ${config.displayName} stderr ` +
    `(last ${lines.length} lines) ---\n${lines.join("\n")}`;
  return base;
}

/**
 * The longest run of bytes an agent may write to stderr without a newline.
 *
 * ⚠ **The accumulator below had no ceiling.** `buffer += chunk` grew until a
 * `\n` arrived, and an agent that writes megabytes on one line — a stack trace
 * with no breaks, a progress bar redrawing with `\r`, a JSON blob — grew a
 * string inside this daemon with nothing to stop it. Every bound downstream is
 * on the *event*: `agent_log` is charged and truncated properly, and none of
 * that runs until a line exists to make an event out of.
 *
 * 64 KiB is generous for a real log line by three orders of magnitude, and the
 * flush keeps what arrived rather than discarding it — a line this long is
 * usually the interesting one.
 */
const MAX_STDERR_LINE_CHARS = 64 * 1024;

/**
 * The longest single JSON-RPC frame an agent may write to stdout.
 *
 * ⚠ **`carry` below had no ceiling, and it sits under every byte all four agents
 * write.** The shape that grows without stopping is a *live* agent whose single
 * frame never terminates — a stuck encoder, a frame being streamed faster than any
 * newline arrives, a hostile child writing `"y"` for ever — and agent stdout is
 * untrusted input. (A process *dying* mid-write is not that shape and never was:
 * it writes what it wrote, the pipe hits EOF, and the `end` handler below flushes
 * the fragment. An earlier draft of this paragraph named it as the motivating case
 * and it cannot produce the failure.) The SDK underneath is no backstop:
 * `ndJsonStream`'s `LineBuffer` carries an incomplete line as an unbounded array of
 * chunks — `#pending = []` in the installed 1.3.0's `dist/line-buffer.js` — so
 * deleting this split would move the growth rather than bound it. This constant is
 * the only bound anywhere between the child's pipe and a parsed message.
 *
 * **16 MiB, rather than the 64 KiB `MAX_STDERR_LINE_CHARS` gets, because a stderr
 * line is prose and an ACP frame legitimately carries a whole file.**
 * `fs/write_text_file` travels agent → client with the new content in
 * `params.content`, a tool result can quote a file it has just read, and an image
 * block is base64, which inflates by 4/3. Every cap this daemon owns is on the
 * *event* made out of a frame — orders of magnitude smaller, and none of it has run
 * at this point in the pipe — so none of them can stand in for this one.
 *
 * ⚠ **No frame from a real claude, kimi, codex or opencode has been measured here,
 * so this number is argued rather than sampled, and the first draft said 8 MiB on
 * the strength of "far above the largest frame anybody here has seen".** Nobody had
 * seen one. 8 MiB is *inside* the range this docblock itself calls legitimate: a
 * ~6 MB screenshot base64s to ~8 MiB, and over the ceiling the connection dies (see
 * the block at the check), so that number spent a live session on traffic the
 * protocol is entitled to carry. 16 MiB is one doubling clear of the largest such
 * case anyone can name, chosen for the reason the command-hint cap gives: a budget
 * set to the largest thing you have measured clips the next one. What would replace
 * the argument with a measurement is a frame histogram off a real fleet — until
 * then this is a refusal nothing in the tree drives, which is recorded as a gap in
 * the ceiling block below.
 *
 * The cost of the number, stated rather than implied, and measured today (node
 * v26.3.0, `node --expose-gc`, `v8.getHeapStatistics().used_heap_size` either side
 * of building an at-ceiling `carry` and then flattening it):
 *
 * - A JS string is UTF-16 **unless every code unit is Latin-1**, in which case V8
 *   keeps it one byte per unit. An at-ceiling ASCII `carry` — which is what JSON,
 *   base64 and escaped content all are — measured 16.0 MiB; the same length with
 *   one non-Latin-1 character in it measured 32.0 MiB.
 * - The chunk that finally *terminates* such a frame doubles that for as long as it
 *   takes to hand the line on: `carry + piece.slice(from, nl)` is a cons string, and
 *   `line.includes(ASYNC_TASK_MARKER)` in `diverted` forces V8 to flatten it into a
 *   fresh flat string while `carry` is still reachable. Measured at the same sizes:
 *   32.1 MiB peak ASCII, 64.1 MiB non-Latin-1.
 * - `carry` also overshoots, because the check below runs after the append rather
 *   than before it: the most it can hold is the ceiling plus whatever one chunk
 *   carried. That overshoot is the pipe's read size and not anything an agent
 *   chooses, which is why it is left where it is rather than tested twice.
 *
 * So the honest trade is tens of megabytes per agent transiently, on a machine that
 * runs several agents at once by design, against today's worst case, which is
 * however much the agent feels like.
 */
const MAX_STDOUT_FRAME_CHARS = 16 * 1024 * 1024;

/**
 * Takes the background-task updates off the stream before the SDK reads it.
 *
 * ⚠ **This exists because the published SDK refuses them, and there is no hook
 * that reaches the refusal.** The three task variants are a *draft* ACP extension
 * (agent-client-protocol#1992) and `zSessionUpdate` is a closed `z.union` in both
 * 1.3.0 and 1.4.0 with no arm for any of them. Two separate places parse it:
 * `registerAppNotification`, which a custom parser *can* replace, and
 * `ClientApp`'s constructor, which installs a `SessionUpdateRouter` that parses
 * every `session/update` unconditionally before passing the message on. The
 * second one is not reachable from any option, so a client using `acp.client()`
 * cannot receive one of these however it registers its handler — the notification
 * is rejected `-32602` and logged, and nothing above the transport sees it.
 * **Measured by declaring the capability and driving a real notification**, which
 * is what `daemoncheck`'s rig does; reading the schema first would have been the
 * cheaper order.
 *
 * So the split happens below the SDK, and the *only* thing it removes is a
 * notification the SDK would have thrown on. Everything else is forwarded byte
 * for byte and keeps every check it has today, which is the whole reason this is
 * a filter rather than a parser of our own: the alternative was owning the
 * validation of all thirteen known variants to get three unknown ones.
 *
 * **The hot path is one `indexOf` per line.** `usage_update` arrives on
 * essentially every output token, so a `JSON.parse` per line would be a real
 * cost; the substring test fails on every line that is not about a task, and the
 * parse runs only for the handful that could be. A line of agent prose that
 * happens to contain the marker costs one wasted parse and is then forwarded,
 * which is the correct answer rather than a near miss.
 *
 * ⚠ **Everything this function does happens in a stream `'data'` listener on the
 * path of every byte of every agent's output, so its failure modes are the
 * daemon's and not a session's** — an unbounded accumulation, a scan that re-read
 * it, and a throw, which in a `'data'` listener silences the stream rather than
 * rejecting a promise somebody is awaiting. All three are answered below, at
 * `MAX_STDOUT_FRAME_CHARS`, at the loop, and at `handOff`.
 *
 * A `StringDecoder` rather than `chunk.toString()`, because a chunk boundary
 * falling inside a multi-byte character would otherwise corrupt it — and the
 * corruption would land in somebody's transcript rather than in an error.
 */
/*
 * Exported for `daemoncheck` and for nothing else — `sameCommands`' precedent.
 *
 * This sits in front of **every byte of every agent's stdout**, so a regression in
 * it is not one feature failing but one agent going silent with a live process
 * around it. It had no driver at all while every guard in it (a request-shaped
 * frame that must be forwarded rather than swallowed, a marker-bearing line that
 * will not parse, an `async_task_`-prefixed kind outside the three, the multi-byte
 * chunk boundary, the ceiling) was reachable only from a real agent.
 */
export function splitAsyncTaskUpdates(
  stdout: NodeReadable,
  deliver: (notification: acp.SessionNotification) => void,
): NodeReadable {
  const decoder = new StringDecoder("utf8");
  let carry = "";
  /**
   * Set once this split has given up on the stream; `onward` is destroyed and
   * nothing more is read. Two things set it: the ceiling below, and a session
   * handler that threw out of {@link handOff}.
   */
  let over = false;
  const onward = new PassThrough();
  /**
   * Tear the stream down the way every other failure here does.
   *
   * One function rather than four lines twice, because the ordering matters and
   * is not obvious: `over` first so anything already queued on the source is
   * dropped rather than re-entering the handler, `carry` released because it is
   * the thing that may be holding a ceiling's worth of string, then the source
   * paused and only then `onward` destroyed.
   */
  const giveUp = (error: Error): void => {
    over = true;
    carry = "";
    stdout.pause();
    onward.destroy(error);
  };
  /**
   * `deliver`, with a throwing session handler contained.
   *
   * ⚠ **There are two roads to `deliver` and neither closes the connection — but
   * they fail differently, and only one of them fails *quietly*.** On the SDK's
   * road a throw is caught by `processIncomingMessage`'s own `try`, and because
   * `session/update` is a notification rather than a request the `catch` logs it
   * with `console.error("Error handling notification", …)` and returns
   * (installed 1.3.0, `dist/jsonrpc.js:782-792`) — the `.catch(… => this.close())`
   * at `:434` is unreachable for one, since that promise resolves. So there the
   * update is lost, a line lands on the SDK's stderr, and everything else
   * continues. This road is a `'data'` listener on a
   * `node:stream` Readable, and there is no dispatch above it at all. `deliver`'s
   * own guard does not cover the gap either — that guard is around the *tap*
   * fan-out, and the line under it, `router.sessions.get(...)?.onUpdate(...)`, is
   * deliberately unguarded there.
   *
   * ⚠ **What an unguarded throw costs here is not a crash, which is worse.**
   * Measured 2026-09-14 on this machine (node v26.3.0), a `'data'` listener over a
   * `PassThrough` fed `"a\nBOOM\nc\nd\n"` and throwing on `BOOM`: `"a"` is
   * forwarded, `"c"` and `"d"` are not — the throw leaves the rest of the chunk
   * unprocessed — and the stream then delivers **nothing ever again**, a later
   * `write("e\nf\n")` never reaching the listener. `scripts/daemon.ts`'s
   * `process.on("uncaughtException")` logs `uncaught exception (continuing):` and
   * the daemon stays up, so the observable result is one agent gone permanently
   * silent with a live process around it: every later `session/update` lost, and a
   * `session/prompt` whose response never arrives and whose turn never ends.
   *
   * So the catch is here, and it answers with the *same outcome the SDK's road
   * produces* rather than with a swallow: this agent's connection is destroyed
   * carrying the handler's error, `AcpClient.closed` resolves, and the registry
   * leaves the session `interrupted` and puts an agent back on it. A handler that
   * throws is a bug in this daemon rather than in the agent, and the two roads now
   * cost it the same visible thing instead of one of them costing a silence.
   */
  const handOff = (notification: acp.SessionNotification): void => {
    try {
      deliver(notification);
    } catch (error) {
      giveUp(error instanceof Error ? error : new Error(String(error)));
    }
  };
  stdout.on("data", (chunk: Buffer) => {
    if (over) return;
    /*
     * ⚠ **The scan is over the piece that just arrived, never over the
     * accumulation, and the first draft of this function scanned the
     * accumulation.** It was replaced before it landed — this whole function is
     * new in the change these numbers were taken during, so nothing here ever
     * reached a release; the figures below are that draft measured against this
     * one, on the machine it was written on.
     * `carry += decoder.write(chunk)` followed by `carry.indexOf("\n")` from
     * index 0 re-reads every byte already carried on every chunk, and V8 has to
     * flatten the cons string to do it, so a frame that has not ended yet costs
     * O(n²) in the length of the frame rather than O(n).
     *
     * Measured 2026-09-14 on this machine (`node --version` → v26.3.0), both
     * variants standing in one process, fed 64 KiB chunks with no newline anywhere
     * in them, best of three per size and the whole thing run twice, so the figures
     * below are a range across two runs rather than one number each. Accumulating:
     * 4 MiB cost **10.7–11.6 ms**, 8 MiB **46.8–51.5 ms**, 16 MiB **260–277 ms**
     * and 32 MiB **1148–1212 ms** — roughly four times the cost for twice the
     * frame, which is the signature. That last one is over a second of event-loop
     * time: every session, every HTTP request and every heartbeat on the machine
     * stalled behind one agent's output, this daemon's whole liveness surface spent
     * on a line. Scanning the piece instead is flat — **1.4–1.6 ms**, **2.5–3.4 ms**
     * and **4.0–4.2 ms** for the same three feeds, and the 32 MiB one never
     * accumulates at all because the ceiling refuses it first (**1.5–1.6 ms** to
     * reach the refusal). Real ndjson was never the slow case and does not move:
     * 32 MiB of 512-byte lines measured 14.7–20.0 ms one way and 14.7–15.6 ms the
     * other, which is the same number inside this rig's noise rather than a win.
     *
     * The rewrite was also driven against the old one for equivalence, with a
     * faithful copy of `diverted` below rather than a stand-in — same corpus (the
     * three real discriminators, a request-shaped frame carrying an `id`, an
     * `async_task_`-prefixed kind that is *not* one of the three, prose containing
     * the marker, an empty line, multi-byte text, a CRLF line and an unterminated
     * tail), every chunk size from 1 to 64 bytes, so every boundary including
     * mid-multi-byte. Byte-for-byte identical forwarded output and the identical
     * three diverted frames at every size.
     *
     * It is also the shape the SDK's own `LineBuffer` uses one layer down — read
     * off the installed 1.3.0's `dist/line-buffer.js`, which scans the chunk it was
     * handed and pushes only the unterminated tail — so the two halves of the pipe
     * now split lines the same way rather than one of them quadratically.
     *
     * `carry` is emptied on the first line and joined only there, so the common
     * case — a chunk holding whole frames — concatenates nothing at all.
     */
    const piece = decoder.write(chunk);
    let room = true;
    let from = 0;
    for (let nl = piece.indexOf("\n"); nl >= 0; nl = piece.indexOf("\n", from)) {
      const line = carry + piece.slice(from, nl);
      carry = "";
      from = nl + 1;
      if (!diverted(line, handOff)) room = onward.write(`${line}\n`);
      // `handOff` sets `over` rather than throwing, so the give-up has to be read
      // back here: there is nothing left to deliver this chunk's remaining lines
      // to, and `onward` is already destroyed.
      if (over) return;
    }
    carry += piece.slice(from);
    if (carry.length > MAX_STDOUT_FRAME_CHARS) {
      /*
       * ⚠ **Over the ceiling this agent's connection dies, and that costs the
       * turn in flight. It is chosen over two quieter answers, and the reasoning
       * is the whole of why, because nothing in the tree drives this branch.**
       *
       * The message is lost in all three answers — a frame that never ended is a
       * frame that was never sent, whatever is done with its prefix — so the only
       * real question is what the loss looks like afterwards.
       *
       * *Forward the accumulated prefix on as a line of its own*, which is exactly
       * what `diverted` does with a line it cannot `JSON.parse`. The two cases look
       * alike and are not: there the line is **complete**, so forwarding is
       * lossless and the SDK is the right party to answer for bytes the agent
       * really sent; here the cut is **ours**. A truncated frame is corrupt JSON
       * however it is read, the remainder becomes a second corrupt line behind it,
       * and — read off the installed SDK 1.3.0, `dist/stream.js`, where
       * `enqueueLine`'s `catch` is `console.error("Failed to parse JSON message:",
       * trimmedLine, err)` and then carries on — forwarding a clipped prefix prints
       * the whole prefix to this daemon's stderr, a ceiling's worth per occurrence,
       * repeatable at will by the child. So forwarding is *dropping, plus a log
       * flood*; it is strictly worse than dropping and is not the live alternative.
       *
       * *Drop the frame quietly and resync at the next newline.* This is the real
       * alternative, and it is the one that loses more. The lost frame may be a
       * request: the agent is then waiting for a response the SDK will never write,
       * because the SDK never saw the request, and the turn hangs for ever with
       * nothing anywhere saying why. A wedged turn that looks like a working one is
       * the failure this daemon is least able to explain afterwards.
       *
       * *Destroy*, which is what happens. It is loud, bounded, and already a road
       * this file travels: the `stdout.on("error")` line below does the same thing,
       * the SDK turns it into `controller.error`, `AcpClient.closed` resolves, and
       * the registry's `agent_exited` leaves the session `interrupted` and puts an
       * agent back on it. The blast radius is one session — this daemon spawns one
       * adapter per session, which is the fact {@link AcpClient.setProvider} leans
       * on for a different reason — so the machine's other agents are untouched.
       *
       * ⚠ **What it costs, stated rather than implied: the turn in flight is
       * gone.** Whatever the agent had done and not yet reported goes with the
       * connection, the person sees an interrupted session and a fresh agent on it,
       * and there is no sentence saying a frame was refused: this error reaches the
       * SDK's reader and no further, and the only reporting channel this file holds
       * is `router.logListeners`, which carries the agent's *own* stderr lines and
       * would be lying if this daemon wrote into it. So the operator-visible fact
       * is the restart rather than the reason — the same as every other `stdout`
       * error here.
       *
       * ⚠ **Nothing drives this.** `daemoncheck` has no case that feeds a
       * ceiling-breaching frame, so neither the threshold nor the destroy-over-drop
       * choice is pinned by anything but this comment. The rig that already drives
       * the async-task notifications in `scripts/daemoncheck.restart-and-resume.ts`
       * is where it belongs.
       *
       * The `pause()` is flood control and is **never resumed**: it stops the
       * child's next write re-entering this handler while the teardown runs, and
       * `over` makes that certain for anything already queued. It is not the
       * backpressure below — see the note there for why a frame still arriving
       * cannot be backpressured at all, which is the whole reason it needs a
       * ceiling instead.
       */
      giveUp(
        new Error(
          // Code units rather than "characters" or bytes: `carry.length` is what
          // was tested, and the docblock on the constant reasons in both.
          `agent wrote over ${MAX_STDOUT_FRAME_CHARS} UTF-16 code units with no newline; ` +
            "the ACP frame cannot be completed",
        ),
      );
      return;
    }
    /*
     * ⚠ **Backpressure is propagated for a frame that has *ended*, and it is the
     * one property this split could silently have taken away.**
     * `Readable.toWeb(child.stdout)` used to give the SDK's reader a direct line
     * to the child, so a slow consumer stopped the agent writing; a `PassThrough`
     * in between buffers instead, and an agent streaming faster than the daemon
     * drains would grow it without bound on the hot path. Pausing the *source* is
     * what puts the pipe back where it was.
     *
     * ⚠ **It does not reach a frame that is still arriving, and the first draft
     * of this comment claimed it did.** `room` is only ever assigned inside
     * the loop above, so while one enormous line accumulates the loop body never
     * runs, `room` stays `true` and this `pause()` is unreachable. That is not a
     * bug to fix here: pausing the source mid-frame would deadlock it, because
     * nothing drains `carry` except more bytes from the very stream that was
     * paused. The accumulating half is bounded by `MAX_STDOUT_FRAME_CHARS`
     * instead, and that division is the arrangement — backpressure for what a
     * consumer is behind on, a ceiling for what no consumer can be behind on yet.
     */
    if (!room) {
      stdout.pause();
      onward.once("drain", () => stdout.resume());
    }
  });
  // Forwarded rather than swallowed: the SDK's own reader treats the end of this
  // stream as the connection closing, and `AcpClient.closed` is what `Session`
  // watches to notice an agent that went away.
  stdout.on("end", () => {
    // Nothing to flush: after `over` the remaining `carry` is the fragment this
    // split deliberately refused, and forwarding it is precisely what the block at
    // the ceiling argues must never happen. (An earlier draft gave the reason as
    // writing to a destroyed stream being "an error event nobody is listening for".
    // That is false and measured false: `Readable.toWeb(onward)` in
    // `AcpClient.launch` does listen — destroying this `PassThrough` after it has
    // been handed to `toWeb` rejects the pending read cleanly with no
    // `uncaughtException`, and a `write()` afterwards returns without throwing at
    // all. The refusal is the reason; the stream would have tolerated it.)
    if (over) return;
    const rest = carry + decoder.end();
    if (rest.length > 0 && !diverted(rest, handOff)) onward.write(rest);
    // `handOff` may have given up on this very line; `onward` is then destroyed and
    // ending it is neither needed nor meaningful.
    if (!over) onward.end();
  });
  stdout.on("error", (error) => onward.destroy(error));
  return onward;
}

/** Whether this line was a task update, and has therefore been handled here. */
function diverted(line: string, deliver: (notification: acp.SessionNotification) => void): boolean {
  if (!line.includes(ASYNC_TASK_MARKER)) return false;
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    // Not our business. A line the SDK cannot parse either is the SDK's to
    // answer for, and answering it here would make this filter the thing that
    // decides what a malformed message means.
    return false;
  }
  if (typeof message !== "object" || message === null) return false;
  const envelope = message as { id?: unknown; method?: unknown; params?: unknown };
  if (envelope.method !== acp.methods.client.session.update) return false;
  /*
   * ⚠ **A notification carries no `id` and a request does, and a request is not
   * ours to swallow.** JSON-RPC 2.0 separates the two on the presence of that
   * member alone, and `session/update` is *defined* as a notification — but an
   * agent is untrusted input and is free to send it as a request anyway. Taken
   * here, the agent then waits for a response nobody will ever write: the SDK is
   * the thing that produces one, and it only produces it for a frame that reached
   * it. So a frame carrying an `id` falls through and is forwarded, exactly like
   * one whose method we do not recognise. `id: null` falls through too — that is
   * a malformed request rather than a notification, and deciding what a malformed
   * message means is the same thing this filter declines to do at the
   * `JSON.parse` above.
   */
  if (envelope.id !== undefined) return false;
  const params = envelope.params as { sessionId?: unknown; update?: { sessionUpdate?: unknown } };
  if (typeof params?.sessionId !== "string") return false;
  const kind = params.update?.sessionUpdate;
  if (typeof kind !== "string" || !ASYNC_TASK_UPDATES.includes(kind)) return false;
  deliver(params as unknown as acp.SessionNotification);
  return true;
}

function pumpStderr(stderr: NodeReadable, onLine: (line: string) => void): void {
  stderr.setEncoding("utf8");
  let buffer = "";
  stderr.on("data", (chunk: string) => {
    buffer += chunk;
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line.trim().length > 0) onLine(line);
      index = buffer.indexOf("\n");
    }
    // No newline in sight and the buffer is past the ceiling: emit what there is
    // as a line of its own and start again. Bounded here rather than left to the
    // event layer, which never sees a byte until a line is complete.
    if (buffer.length > MAX_STDERR_LINE_CHARS) {
      const line = buffer.slice(0, MAX_STDERR_LINE_CHARS);
      buffer = buffer.slice(MAX_STDERR_LINE_CHARS);
      if (line.trim().length > 0) onLine(line);
    }
  });
  stderr.on("end", () => {
    if (buffer.trim().length > 0) onLine(buffer);
    buffer = "";
  });
}
