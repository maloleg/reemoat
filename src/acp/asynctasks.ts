/**
 * Background work an agent started and has not finished.
 *
 * ACP has no concept of it. `SessionUpdate` has thirteen arms and none is a
 * task, `ToolCallStatus` is four values with nothing for *still running
 * elsewhere*, and the spec's only process-exit signal — `terminal/wait_for_exit`
 * — is a **pull** this client declines. So everything here rides `_meta`, which
 * is agent-shaped by construction, and this file is where that shape is allowed
 * to be known. It is `subagents.ts`'s job one namespace over.
 *
 * **Unlike `subagents.ts` this file has two directions, and they belong
 * together.** That one reads `_meta.claudeCode` inbound while `agents.ts`'s
 * `sessionMetaFor` writes it outbound, and the two halves live apart because
 * they are two different `claudeCode` conversations. Here there is one
 * conversation: we declare `jetbrains.air` and the agent answers in
 * `jetbrains.air`. Splitting it would put the capability we send and the
 * updates we get back in two files that must agree about one string.
 *
 * **The namespace is a vendor extension rather than core ACP**, which is the
 * whole reason it is `_meta` at all: `jetbrains.air` is the draft surface for
 * agent-client-protocol#1992, and until that ships the wire contract lives in
 * the adapter's own `dist/acp-subagents.d.ts`. The safety argument for building
 * on it is `subagents.ts`'s: **the failure mode is the status quo.** If the
 * namespace disappears in a later adapter, no task is ever announced, the panel
 * draws nothing and `parkable` stops deferring — which is exactly what happened
 * before any of this existed.
 *
 * Measured 2026-09-11 against claude 2.1.268 under claude-agent-acp 0.73.0. The
 * other three agents send nothing here: kimi 0.29.2 backgrounds fully and maps
 * `background.task.terminated` nowhere, codex 0.153.4's `unified_exec` PTY
 * outlives its call with no push at all, and opencode 1.18.30's `bash` tool has
 * no background flag. Q2.228.
 */

/**
 * The version of the `jetbrains.air` extension this client speaks.
 *
 * ⚠ **A literal, and it has to be.** The adapter has this same constant —
 * `AIR_EXTENSION_VERSION` in `dist/air-extension.js` — and it is **module
 * private**, absent from `air-extension.d.ts`, so importing it does not compile.
 * What keeps the two agreeing is `pincheck`, which calls the adapter's own
 * `clientSupportsAirCapability` with the object below and asserts it answers
 * true. That is a behavioural assertion against the vendor's real code rather
 * than two constants compared, and it is the only kind that would catch the
 * failure this extension has: the gate wants a **finite integer ≥ 1**, and a
 * declaration it refuses disables the whole feature with no error on any wire.
 */
export const AIR_EXTENSION_VERSION = 1;

/** The one capability this client asks for out of that extension. */
export const AIR_ASYNC_TASKS_CAPABILITY = "asyncTasks";

/**
 * What `initialize` sends, and the one place it is written down.
 *
 * **A statement, not a gate.** Declaring this asks the agent to say more; it
 * grants the agent nothing and nothing here executes on its behalf — unlike
 * `fs`, whose reverse-RPCs run in this process, and unlike `elicitation`, which
 * changes what the model is given. So it is unconditional, on
 * `session.configOptions`' argument.
 *
 * ⚠ **`nativeSubagentSessions` is deliberately absent, and the cost of adding it
 * for symmetry is two things this repository has already refused.** Declaring it
 * sets the adapter's `forwardSubagentText`, forwarding every subagent's text and
 * thinking, which Q6.4 refused on budget — and a permission raised inside a
 * subagent is then addressed to the **child** session id, which `AcpClient.route`
 * answers `invalidParams` for, i.e. a subagent's approval dying on the floor.
 *
 * ⚠ **The capability is latched at the agent's session-consumer creation** (an
 * `??=` on the first prompt), and its `enabled` field is `readonly`. So this has
 * to be in the very first `initialize`; there is no upgrading a connection that
 * is already open, and no way to turn it on for a session that is already
 * running.
 *
 * Frozen, so no call site can edit the object every session is initialized with.
 */
export const AIR_CLIENT_CAPABILITY = Object.freeze({
  jetbrains: Object.freeze({
    air: Object.freeze({
      version: AIR_EXTENSION_VERSION,
      capabilities: Object.freeze([AIR_ASYNC_TASKS_CAPABILITY]) as readonly string[],
    }),
  }),
});

/**
 * How long an `asyncTaskId` may be, and it is a **refusal** rather than a clip.
 *
 * The id round-trips verbatim to `_session/async_task/stop`, so a clipped one is
 * an id the agent cannot recognise — the stop control would draw, would be
 * tapped, and would answer about nothing. That is `optionId`'s argument (Q7.82)
 * reached one field over, and the number is `MAX_PARENT_ID_CHARS`' for
 * `MAX_PARENT_ID_CHARS`' reason: it is an agent-chosen id no spec bounds, and two
 * numbers for one quantity is how the pair drifts.
 */
export const MAX_ASYNC_TASK_ID_CHARS = 256;

/** Prose budgets, applied where the task is built. Cut is *counted*, never silent. */
export const MAX_ASYNC_TASK_NAME_CHARS = 200;
export const MAX_ASYNC_TASK_TYPE_CHARS = 64;
export const MAX_ASYNC_TASK_TEXT_CHARS = 512;

/**
 * How long an `outputFilePath` may be. A tool call's `location.path` number.
 *
 * Kept although nothing draws it: it is what a detail view would need, and a
 * field dropped at ingest because today's screen has no use for it is a field
 * that has silently stopped existing. Measured, the real shape is
 * `/private/tmp/claude-<uid>/<cwd-slug>/<sessionId>/tasks/<taskId>.output` —
 * outside the workspace, which is why `files-paths-git.md` containment refuses to
 * read it and why there is no detail view to build.
 */
export const MAX_ASYNC_TASK_PATH_CHARS = 1_024;

/**
 * How many tasks one session may be tracked as running.
 *
 * Task ids are agent-chosen and unbounded, and the set is fanned out to every
 * attached client on every snapshot. Past the cap a new id is **not tracked** —
 * failing toward parking, which is the right direction for a bound whose whole
 * purpose is bounding what a machine holds: the set is already non-empty, so the
 * session is already deferring, and what a 33rd task would have bought is only
 * the *extension* of a deferral that is already in force.
 */
export const MAX_TRACKED_ASYNC_TASKS = 32;

/**
 * What a task is doing, in the adapter's own five words.
 *
 * `completed`, `failed` and `stopped` are terminal; `running` and `paused` are
 * not. That split is the adapter's `isTerminal` and it is mirrored rather than
 * re-derived — a hand-written list of "the finished ones" is exactly what goes
 * out of step when a sixth word is added.
 */
export type AsyncTaskState = "running" | "paused" | "completed" | "failed" | "stopped";

const STATES: readonly AsyncTaskState[] = ["running", "paused", "completed", "failed", "stopped"];

const TERMINAL: readonly AsyncTaskState[] = ["completed", "failed", "stopped"];

/** Whether this state means the work is over. The pair to {@link AsyncTaskState}. */
export function isTerminalAsyncTaskState(state: AsyncTaskState): boolean {
  return TERMINAL.includes(state);
}

/** Per-task counters the agent reports. Numbers only; nothing agent-chosen. */
export interface AsyncTaskUsage {
  totalTokens: number;
  toolUses: number;
  durationMs: number;
}

/** The agent announced work it has started. */
export interface AsyncTaskSpawn {
  kind: "spawned";
  asyncTaskId: string;
  name: string;
  taskType: string;
  description: string;
  /**
   * Whether this task owns a transcript card of its own.
   *
   * The adapter states the split outright: it decides whether the task owns a
   * **card**, not whether the agent may answer a direct user action. A
   * backgrounded Bash call is already drawn as its tool call, so it says `false`
   * and the card it already has stops claiming it finished — see
   * {@link readBackgroundedMarker}.
   */
  showInTranscript: boolean;
  canStop: boolean;
  outputFilePath: string | null;
  toolCallId: string | null;
}

/** The agent said something about work already announced. Carries no membership news. */
export interface AsyncTaskProgress {
  kind: "progress";
  asyncTaskId: string;
  description: string | null;
  summary: string | null;
  lastToolName: string | null;
  usage: AsyncTaskUsage | null;
  outputFilePath: string | null;
  toolCallId: string | null;
}

/** The agent moved a task to a new state. The only arm that can end one. */
export interface AsyncTaskTransition {
  kind: "state";
  asyncTaskId: string;
  state: AsyncTaskState;
  summary: string | null;
  outputFilePath: string | null;
  toolCallId: string | null;
}

export type AsyncTaskEdge = AsyncTaskSpawn | AsyncTaskProgress | AsyncTaskTransition;

/**
 * The cheap test that decides whether a line is worth parsing at all.
 *
 * Every one of the three discriminators begins with it, and no other
 * `sessionUpdate` in ACP contains it — so `AcpClient`'s split can reject a line
 * with one `indexOf` and reach `JSON.parse` only for the handful that could
 * possibly be a task. That matters because `usage_update` arrives on essentially
 * every output token.
 *
 * A false positive costs one wasted parse and the line is then forwarded, which
 * is the correct answer rather than a near miss: agent prose containing this
 * string is an agent talking about this feature.
 */
export const ASYNC_TASK_MARKER = "async_task_";

/**
 * The three `sessionUpdate` discriminators this file answers for.
 *
 * Exported so `Session.onUpdate` can test membership before it reads anything.
 * The branch has to sit **outside** the `switch`, because these three are not in
 * the SDK's `SessionUpdate` union at all — a `case` for them does not typecheck,
 * which is the same reason `supportsSteering` reads `_meta` by hand.
 */
export const ASYNC_TASK_UPDATES: readonly string[] = [
  "async_task_spawned",
  "async_task_progress",
  "async_task_state_update",
];

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function flag(value: unknown): boolean {
  // `=== true` rather than truthiness, for `toolCallLineage`'s reason: the
  // string "false" is truthy, and a whole family of near-misses becomes
  // structurally impossible rather than defended one at a time.
  return value === true;
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function usageOf(value: unknown): AsyncTaskUsage | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  const totalTokens = count(raw["totalTokens"]);
  const toolUses = count(raw["toolUses"]);
  const durationMs = count(raw["durationMs"]);
  // All three or none. A partial triple would draw two real numbers beside a
  // zero nobody measured, which is worse than the row saying nothing.
  if (totalTokens === null || toolUses === null || durationMs === null) return null;
  return { totalTokens, toolUses, durationMs };
}

/**
 * Read one of the three task updates, or answer that this was not one.
 *
 * **Every refusal here is the whole update, never a repaired one.** An id longer
 * than {@link MAX_ASYNC_TASK_ID_CHARS}, a missing id, an unreadable `state` — in
 * each case the update is dropped and the task keeps whatever it had. That is
 * deliberate in the one direction it matters: a task the agent has only ever
 * described with a word this client cannot read stays **live**, is never parked
 * over, and is released when the agent is disposed. Coercing an unknown word to
 * a state would be inventing a fact; coercing it to a *terminal* state would be
 * inventing the one fact that gets somebody's build killed.
 *
 * Cannot throw: it runs on the emit path, inside the agent's own RPC handler.
 */
export function readAsyncTaskEdge(update: unknown): AsyncTaskEdge | null {
  if (typeof update !== "object" || update === null) return null;
  const raw = update as Record<string, unknown>;
  const kind = raw["sessionUpdate"];
  if (typeof kind !== "string" || !ASYNC_TASK_UPDATES.includes(kind)) return null;

  const id = raw["asyncTaskId"];
  if (typeof id !== "string" || id.length === 0 || id.length > MAX_ASYNC_TASK_ID_CHARS) return null;

  const outputFilePath = text(raw["outputFilePath"]);
  const toolCallId = text(raw["toolCallId"]);

  if (kind === "async_task_spawned") {
    return {
      kind: "spawned",
      asyncTaskId: id,
      // The adapter humanises `taskType` before it sends — `local_bash` becomes
      // `shell`, `local_workflow` becomes `workflow`, `local_monitor` and `mcp`
      // become `monitor` — so this is already the vocabulary a person reads and
      // there is no translation table on this side.
      name: text(raw["name"]) ?? "",
      taskType: text(raw["taskType"]) ?? "",
      description: text(raw["description"]) ?? "",
      showInTranscript: flag(raw["showInTranscript"]),
      canStop: flag(raw["canStop"]),
      outputFilePath,
      toolCallId,
    };
  }

  if (kind === "async_task_progress") {
    return {
      kind: "progress",
      asyncTaskId: id,
      description: text(raw["description"]),
      summary: text(raw["summary"]),
      lastToolName: text(raw["lastToolName"]),
      usage: usageOf(raw["usage"]),
      outputFilePath,
      toolCallId,
    };
  }

  const state = raw["state"];
  if (typeof state !== "string" || !STATES.includes(state as AsyncTaskState)) return null;
  return {
    kind: "state",
    asyncTaskId: id,
    state: state as AsyncTaskState,
    summary: text(raw["summary"]),
    outputFilePath,
    toolCallId,
  };
}

function airMeta(meta: unknown): Record<string, unknown> | null {
  if (typeof meta !== "object" || meta === null) return null;
  const jetbrains = (meta as Record<string, unknown>)["jetbrains"];
  if (typeof jetbrains !== "object" || jetbrains === null) return null;
  const air = (jetbrains as Record<string, unknown>)["air"];
  if (typeof air !== "object" || air === null || Array.isArray(air)) return null;
  return air as Record<string, unknown>;
}

/**
 * Whether the agent said it reports background work, read off its own answer.
 *
 * **A capability test rather than a name check**, which is the rule
 * `ultracodeOptionId` already follows and the reason this is worth having at
 * all: without it the panel draws an empty list for kimi, codex and opencode and
 * claims it means *nothing is running*, when what it means is *nobody asked*.
 * This is the third value `contextUsage`'s `null` carries one field over.
 *
 * The mirror of the gate the adapter applies to us, and deliberately the same
 * shape: an integer version at least ours, and the capability named in a list.
 */
export function agentAdvertisesAsyncTasks(meta: unknown): boolean {
  const air = airMeta(meta);
  if (air === null) return false;
  const version = air["version"];
  if (typeof version !== "number" || !Number.isInteger(version) || version < AIR_EXTENSION_VERSION) {
    return false;
  }
  const advertised = air["capabilities"];
  return Array.isArray(advertised) && advertised.includes(AIR_ASYNC_TASKS_CAPABILITY);
}

/**
 * Whether this tool-call update is a call that detached into the background.
 *
 * The adapter's own docblock says why the marker exists: *"ACP has no tool-call
 * status for 'still running elsewhere', so this marker is what lets a client
 * render the card as backgrounded work instead of finished work."* A backgrounded
 * Bash call returns as soon as the command is handed off, so without it the card
 * reaches `completed` while the command runs on for minutes.
 *
 * ⚠ **This is the second field ever read out of `_meta`**, and the precedent is
 * `customAnswerFor` → `alternativeTo` (Q3.592): a *declaration* by the agent
 * about its own payload, projected to one scalar, with the rest of `_meta` still
 * dropped at ingest. It rides an update the tool result already emits, so it
 * costs no extra notification and cannot arrive out of order.
 *
 * It is in the AIR namespace rather than `claudeCode` deliberately, and the
 * adapter says why: to a client that never declared `asyncTasks` — and is
 * therefore never sent the lifecycle — the marker would promise a card state it
 * has no way to resolve.
 */
export function readBackgroundedMarker(meta: unknown): boolean {
  const air = airMeta(meta);
  if (air === null) return false;
  const asyncTasks = air[AIR_ASYNC_TASKS_CAPABILITY];
  if (typeof asyncTasks !== "object" || asyncTasks === null) return false;
  return flag((asyncTasks as Record<string, unknown>)["backgrounded"]);
}

/**
 * One piece of background work, as this daemon holds it and a client draws it.
 *
 * **The adapter's three updates collapse into one record**, because what a reader
 * needs is the *current* answer rather than the sequence that produced it —
 * `agentConfig`'s rule, reached from the other direction. `spawned` creates the
 * row, `progress` and `state` merge into it newest-non-null, and nothing is ever
 * derived from how many updates arrived.
 *
 * The record lives here rather than in `events.ts` beside `ContextUsage` for one
 * reason: {@link AsyncTaskState} is the adapter's five words *mirrored*, and a
 * record that carries a state has to sit beside the definition of what a state
 * is, or the two come to disagree about which of them is terminal.
 */
export interface BackgroundTask {
  /** The agent's own id, verbatim — what `_session/async_task/stop` takes back. */
  id: string;
  name: string;
  /** Already humanised by the adapter: `shell`, `workflow`, `monitor`. */
  taskType: string;
  description: string;
  state: AsyncTaskState;
  summary: string | null;
  lastToolName: string | null;
  usage: AsyncTaskUsage | null;
  canStop: boolean;
  showInTranscript: boolean;
  outputFilePath: string | null;
  toolCallId: string | null;
  /**
   * When this daemon first heard of it, by this daemon's clock.
   *
   * Ours rather than the agent's, and there is no agent field for it anyway. It
   * is what orders the list — running first, then newest-started first — and it
   * is deliberately not an *elapsed* time: a ticking number on a snapshot fanned
   * out per client is `outstandingTasks`' own refusal one layer down.
   */
  startedAt: number;
  /**
   * When it reached a terminal state, by the same clock, or `null` while it runs.
   *
   * **The adapter sends no end time and drops the one the SDK has.** Measured in
   * `dist/async-tasks.js`: `publishState` carries `state`, `summary`,
   * `outputFilePath` and `toolCallId` and no clock at all, `task_notification`'s
   * `usage` — the one guaranteed final `durationMs` — is never forwarded, and
   * `task_updated.patch.end_time` is read by nothing. So a client drawing "ran for
   * 4m 20s" against a completed task has only `usage.durationMs` from whatever
   * progress frame happened to arrive last, which is stale by the whole final leg.
   * Stamping the edge here is the only way a finished row stops counting.
   *
   * **Stamped once and kept.** The `stopped → completed` correction is two
   * terminal edges about one end, and the second must not move the time; a
   * correction back to a live state clears it, because a row that is running
   * again did not end.
   */
  endedAt: number | null;
}
