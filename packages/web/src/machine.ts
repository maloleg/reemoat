import { mintToken, registerDevice } from "./cp";
import {
  ChannelRefused,
  bodyBytes,
  bodyText,
  openChannel,
  type Channel,
  type ChannelFactory,
  type ChannelRequest,
  type ChannelResponse,
  type StreamSocket,
} from "./e2ee";
import {
  ApiError,
  contentTypeFor,
  isTransportFailure,
  meansDeviceKeyMissing,
  meansMachineGone,
  meansWrongMachine,
  parseBody,
  withTimeout,
} from "./http";
import { localBaseFor } from "./localRoute";
import type { MachineId } from "./ids";
import type { DaemonHealth, MachineRecord, Scope } from "./wire";

/**
 * One machine, and everything the client knows about reaching it.
 *
 * Three things live here together because they are one thing: the token, the
 * route, and the request helper. Minting a token is also how the client learns
 * where the machine is — `POST /v1/tokens` answers with `relayUrl` and
 * `relayOnline` — so splitting them would create two facts that can disagree
 * about the same machine.
 *
 * Nothing in here is global. Every machine has its own token, its own route memo
 * and its own reachability, because partial availability is the normal case: one
 * laptop is shut, one is on a LAN, one is behind NAT on the far side of a relay,
 * and none of those states may affect the others.
 */

/** Renew this far ahead of expiry. Larger than the daemon's 60s clock leeway. */
export const TOKEN_RENEW_MARGIN_MS = 90_000;

/**
 * Rotate a live socket this far ahead of expiry.
 *
 * Smaller than the renew margin, so the token is already fresh when the rotation
 * fires: the sequence is "refresh at exp−90s, rotate at exp−60s", never "rotate
 * onto a token that is itself about to die".
 */
export const SOCKET_ROTATE_MARGIN_MS = 60_000;

/** Long enough for a LAN round trip, short enough not to hold up a render. */
const PROBE_TIMEOUT_MS = 1_500;

const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Calls that spawn a process before they can answer.
 *
 * Creating a session waits for the agent to start — the daemon's own budget is
 * 45s, and `git worktree add` in front of it is allowed 120s because it runs a
 * real checkout with the repository's own hooks and LFS filters. `POST
 * /sessions/:id/resume` is the same launch and needs the same room, and so is
 * `POST /sessions/:id/prompt` since the daemon began resuming an interrupted
 * session before delivering the message — see the note at that entry for why it
 * is unconditional rather than only for the sessions that need it.
 *
 * Everything under `/agent-auth` is here too, matched by prefix so a route added
 * under it cannot reintroduce the gap: `GET /agent-auth` runs the login probe
 * (which spawns `claude auth status`), and starting a login spawns a CLI under a
 * pty. Both went out at 15s once, and the failure was not a slow screen — a
 * timeout is a *transport* failure, so `forgetRoute` drops the memo and
 * `markUnreachable` follows, and Settings then renders "not reachable right now"
 * over the one screen a logged-out person came for.
 *
 * **The rule this constant exists for, and it is the one worth keeping:** the
 * daemon's own deadline for a `set_config_option` is 15s, which is *exactly* what
 * this client used to allow — so the client's abort always won the race and the
 * daemon's carefully built `502 agent_config_failed`, carrying the agent's own
 * explanation, could never be seen by anyone. A client deadline that equals the
 * server's does not merely risk a false negative; it makes the server's error
 * path dead code.
 *
 * Left at 90s rather than retuned when the container start went away, and that is
 * deliberate: `worktree add` plus an agent start is still 165s of daemon budget
 * stacked in front of one request, and those are facts about `src/` rather than
 * about Docker. Lowering it should follow a measurement, because the failure of
 * guessing low is a healthy machine reported unreachable.
 *
 * ⚠ **One member is not fully covered by this number, and saying so is better
 * than implying otherwise.** `GET /agents/capabilities` starts an agent for each
 * of the **four** harnesses — asked all at once now and metered through
 * `MAX_CONCURRENT_ASKS` by a queue rather than run one at a time; see the entry in
 * {@link slowRoute}. Each is bounded by `agentask.ts`'s `ASK_TIMEOUT_MS` at 120s
 * and the queue by `SLOT_WAIT_MS`, so the worst case is rounds of two rather than
 * a sum of four. Ninety seconds covers what it actually costs — measured
 * 2026-08-28, **3061 ms** on a cold cache against 5286 ms when it was serial —
 * and a harness hung to its full budget still lands on the failure this
 * table exists to prevent, only three minutes later instead of fifteen seconds
 * later. Raising the constant for one route would raise it for the eight that do
 * not need it, and a per-route budget means this predicate stops being a boolean
 * — which is a shape change with call sites outside this file, so the gap is
 * written down here rather than half-built.
 */
const SLOW_ROUTE_TIMEOUT_MS = 90_000;

/**
 * How long a download is given.
 *
 * A `GET` that streams a file, so it is bounded by bytes rather than by a
 * daemon-side budget the way `SLOW_ROUTE_TIMEOUT_MS` is. Two minutes covers the
 * 100 MiB ceiling below on anything better than a bad LTE cell; past that the
 * honest answer is that the link cannot carry it.
 */
const TRANSFER_TIMEOUT_MS = 120_000;

/**
 * The largest file this client will pull into memory.
 *
 * A download becomes a `Blob`, so the whole thing is resident — and the route
 * serves any regular file under the workspace, which includes the 2 GiB binary
 * the agent just built. Without a gate that is a dead tab with nothing to read.
 *
 * Checkable *before* the body is consumed because `content-length` is one of the
 * CORS-safelisted response headers, so it survives the cross-origin hop even
 * though `src/cors.ts` sends no `access-control-expose-headers`. That same
 * absence is why the filename comes from the requested path rather than from
 * `content-disposition`, which is **not** safelisted and therefore not readable.
 */
export const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;

/** No progress at all for this long means the link is dead, whatever the size. */
const UPLOAD_STALL_MS = 30_000;

/** The floor an upload is assumed to sustain, for the hard cap: ~50 KiB/s. */
const UPLOAD_FLOOR_BYTES_PER_MS = 50;

/**
 * The wall clock an upload may not exceed however slowly it is progressing.
 *
 * ⚠ **This was 300s, and it was the hidden blocker under raising
 * `MAX_UPLOAD_BYTES` to 100 MiB.** The old docblock said 300s "deliberately: that
 * is the token lifetime, so the number cannot quietly become load-bearing on
 * something else" — and then conceded, in its own next sentence, that a request
 * in flight does not die at `exp` (the daemon verifies the bearer once at the
 * start, the relay authorizes at CONNECT). So the coupling was tidiness rather
 * than a property, and what it actually did at the new size was abort a
 * *progressing* 100 MiB upload at five minutes, i.e. anything under ~350 KiB/s —
 * a failure with no message, halfway through, on the slow links this cap most
 * matters on.
 *
 * 45 minutes is above `scaled` at the largest file this daemon will take
 * (~35 min at the assumed floor), so the **formula** governs at every size and
 * this is a ceiling on arithmetic rather than a second, invisible limit. It is
 * not a claim about a token, a socket or a tunnel; the thing that actually
 * notices a dead link is `stallMs`, thirty seconds, reset by every progress
 * event.
 */
const UPLOAD_HARD_CAP_MS = 45 * 60 * 1000;

/**
 * The two deadlines an upload runs under.
 *
 * A wall clock alone is the wrong instrument here: a slow-but-progressing upload
 * is not a failure, and a large file over a phone uplink is many minutes rather
 * than the 15s an ordinary request gets. So the primary budget is a **stall** —
 * reset by every progress event — and the wall clock is only a backstop against a
 * connection that trickles for ever.
 *
 * Floored at `REQUEST_TIMEOUT_MS` so a one-byte upload is never *more* fragile
 * than an ordinary request, and capped at {@link UPLOAD_HARD_CAP_MS}.
 */
export function uploadDeadlines(bytes: number): { stallMs: number; hardMs: number } {
  const scaled = 20_000 + Math.ceil(Math.max(bytes, 0) / UPLOAD_FLOOR_BYTES_PER_MS);
  return {
    stallMs: UPLOAD_STALL_MS,
    hardMs: Math.min(UPLOAD_HARD_CAP_MS, Math.max(scaled, REQUEST_TIMEOUT_MS)),
  };
}

/**
 * Where a machine is reached, and which of the two ways answered.
 *
 * **The direct path is still deleted.** What this used to be was a *choice*
 * between a `baseUrl` the registry handed out and the relay, probed in that order;
 * that is gone with the column, and no address a server names is ever dialled. A
 * machine is reached down the tunnel its own daemon dialled out to the control
 * plane, which is what makes a grant revocable on the *next request* rather than
 * within a token lifetime.
 *
 * What came back is narrower and it is not the same feature: a daemon on **this
 * computer**, named by a file only its own uid can write, reached over loopback by
 * the desktop app and by nothing else. There is no address to trust, nothing to
 * discover on a network, and no way for a browser to take this path at all.
 * Q7.137 carries the argument; `.claude/rules/relay.md` carries the four rules.
 *
 * `kind` exists for exactly one reader — {@link MachineConnection.settleAnswer} —
 * which applies a 401 rule to the local arm that the relay candidate must never
 * get. Nothing else branches on it, and `request`, `upload`, `download` and
 * `streamUrl` all take `base` and cannot tell the two apart.
 */
export interface Route {
  base: string;
  kind: "relay" | "local";
}

export type Reach = "unknown" | "probing" | "online" | "offline";

export type OfflineReason =
  | "no_route"
  | "no_token"
  | "not_enrolled"
  | "cp_unreachable"
  | "over_limit"
  | "owner_disabled"
  /**
   * The machine has never told the Authority a key to be reached under.
   *
   * ⚠ **The one offline reason that is not about reachability at all.** The
   * daemon is running, the tunnel is up, and the relay would carry bytes to it —
   * what is missing is the X25519 static a machine announces on its dial, without
   * which there is no `Noise_IK` to run and therefore no way to talk to it that
   * this relay could not read. It is a *refusal to fall back*, and it is the
   * single place in this client where "no encryption available" is spelled out
   * rather than silently degraded.
   *
   * Cleared by updating the daemon on that machine: the announcement rides the
   * next dial, which happens within seconds of it restarting, so nobody
   * re-enrolls anything.
   */
  | "no_machine_key"
  /**
   * *This installation* holds no key the Authority will name in a capability.
   *
   * ⚠ **The device-side twin of {@link OfflineReason.no_machine_key}, and until
   * now only the machine half had a reason of its own.** That one is a daemon
   * that has never announced a static and reads "needs a newer daemon". This one
   * is the same shape pointed the other way: the machine is fine, the tunnel is
   * up, and what is missing is the X25519 static *this computer* is supposed to
   * hold — a shell whose credential store answered nothing, or a row registered
   * before device keys existed.
   *
   * ⚠ **Not a browser**, which an earlier spelling of this sentence claimed.
   * `POST /v1/tokens` guards `device_key_required` on `caller.deviceId !== null`
   * (in `packages/control-plane/src/app.ts`; cited by symbol rather than by line,
   * because that file is six thousand lines and an insertion above would move a
   * number silently) and a browser sign-in sends no
   * device, so it is minted an *unbound* capability rather than refused; and
   * `e2ee.ts`'s `dial()` throws a plain `Error` for a missing static, which
   * `probe` swallows into `no_route`. A browser's permanent state is `no_route`,
   * and this reason is unreachable there.
   *
   * `POST /v1/tokens` refuses that with `device_key_required`, and `mint` applies
   * the one remedy it has — registering the key this shell is already holding.
   * When that registration does not take, **every** machine on the account is
   * unreachable for one cause that has nothing to do with any of them, so the
   * sentence has to be about this app rather than about the row it is drawn on.
   *
   * ⚠ **And re-registering is not a remedy at all where the key itself is what
   * was refused.** `readDeviceInput` nulls a `publicKey` it cannot parse and
   * **keeps** the registration, so the row answers `hasKey: false` for ever and
   * the id coming back from `POST /v1/me/devices` is not evidence the remedy
   * took — `mint`'s retry below says so at the code. Re-sending the same bytes,
   * which is all a sign-in or a `registerDevice()` can do, arrives at the same
   * refusal every time. What leaves the state is a **new** key, and only the
   * shell can make one: `hostDeviceKeyReset()` behind the Re-key control on
   * `DevicesSection`'s row, which `OFFLINE_TEXT.no_device_key` is the sentence
   * pointing at. A browser reaches neither, which is the one arm of this reason
   * that has no exit and is not meant to have one.
   *
   * ⚠ **It was reported as `no_token`, which is a sentence about a *credential*
   * for a cause that is a missing **key**.** "no token" sends somebody to look at
   * their sign-in, which is working, and then at their machines, which are also
   * working, and there was no remedy anywhere on the screen. The machine-side
   * twin got its own reason and its own instruction when it landed; this half got
   * neither.
   */
  | "no_device_key"
  | null;

/** Why a session URL has no row behind it. See {@link missingRowReason}. */
export type MissingRow = "loading" | "no_machine" | "not_here" | "unreachable";

/**
 * What to say about a session the store holds no row for.
 *
 * **`loading` is the answer that was missing, and its absence was a lie on the
 * ordinary path.** `SessionView` read `rowsByKey`, found nothing, and drew either
 * *"That session is not on this daemon."* or *"<name> is not reachable right
 * now."* — but on a cold reload straight onto a session URL, neither is known
 * yet. `bootstrap` promotes to `phase: "ready"` on the *machine* list, so the
 * view mounts three round trips before the session list exists (mint a token,
 * `forgetRoute()` and re-probe the route — itself bounded at 1.5s — then
 * `GET /sessions`), and `resumeMachine` drops the route memo first, so `reach` is
 * `unknown` or `probing` for most of that. On a phone over the relay this is
 * seconds of a screen confidently denying that a live session exists.
 *
 * `listed` is the store's own record of having had a session list back from this
 * machine at least once, and it is what separates the last two: a machine that is
 * plainly online but has never been asked cannot yet say a session is not there.
 *
 * Pure, and here rather than in the component, so `webcheck` can walk the whole
 * `Reach` × `listed` matrix — the `online` + not-listed cell is the bug, and it is
 * one cell of six.
 */
export function missingRowReason(reach: Reach | null, listed: boolean): MissingRow {
  if (reach === null) return "no_machine";
  if (reach === "unknown" || reach === "probing") return "loading";
  if (reach === "offline") return "unreachable";
  return listed ? "not_here" : "loading";
}

/**
 * Whether a screen may draw this machine's daemon-backed content.
 *
 * **`probing` keeps the previous answer, and that is the whole of it.** A re-probe
 * is this client re-checking a route it deliberately forgot — `resumeMachine`
 * calls `forgetRoute()` on every wake, because what it believed about
 * reachability was true of a network the phone may have left. It is a
 * measurement in progress, not the host going away, and it publishes twice:
 * `probing` before any I/O, then `online` up to 1.5s later.
 *
 * Read as "not online", those two publishes **unmount and remount** whatever the
 * screen was showing. On Settings → Machines → an agent that meant: the panel
 * replaced by "not reachable right now", then `useAgentAuth` restarting from
 * `listing: null` on the way back — a spinner, a second `GET /agent-auth` (which
 * shells out to every agent's CLI, on the 90s budget), and anything typed into a
 * credential box or any sign-in wizard in progress thrown away. Once per tab
 * switch, which is exactly what somebody does on this screen: go and copy a
 * token, come back.
 *
 * `.claude/rules/web-shell.md` already states the rule this restores, about the
 * rail: reachability flickers, so a row may not change because of it. These two
 * screens are the ones that legitimately *show* reachability — and showing it is
 * still not a reason to take the content away while asking.
 *
 * Pure, and beside {@link missingRowReason} rather than inside a component, so
 * `webcheck` walks all four values instead of asserting JSX.
 *
 * **Derived from {@link daemonRead} rather than stated a second time.** The two
 * are one question asked at different resolutions, and a screen branching on this
 * one while another branches on that one must never be able to disagree about the
 * same machine.
 */
export function daemonReadable(reach: Reach): boolean {
  return daemonRead(reach) === "readable";
}

/** What a screen may draw about a machine's daemon. See {@link daemonRead}. */
export type DaemonRead = "readable" | "asking" | "unreachable";

/**
 * The same question as {@link daemonReadable}, with the "not yet" told apart from
 * the "no".
 *
 * ⚠ **`daemonReadable` answers `false` for `unknown`, and four screens read that
 * as *offline*.** `MachineSystemsSection`, `MachineAgentsSection`,
 * `MachineSection` and `AgentBuilder` each draw `` `${machine.name} is not
 * reachable right now — ${reachText(reach, reason)}` `` on the false branch — and
 * `unknown` is not a machine that failed to answer, it is a machine nobody has
 * asked yet.
 * `bootstrap` promotes to `phase: "ready"` on the *machine list*, and
 * `resumeMachine` calls `forgetRoute()` on every wake, so `unknown` is the value
 * for the two or three seconds before the first `/health` lands — over a relay
 * from a phone, longer. For that whole window those screens asserted a failure
 * that had not happened, and `reachText`'s `unknown` arm was the bare string
 * `"…"`, so the sentence rendered as **"laptop is not reachable right now — …."**
 *
 * ⚠ **That set said `MachineSystemsSection`, `MachinePluginsSection` and
 * `MachineAgentsSection`, and it had gone stale in both directions.**
 * `MachinePluginsSection` draws no reachability line any more — its one caller,
 * `MachineSection`, states it once for all three of its lists, and `webcheck` pins
 * that section as saying neither half — while `MachineSection` itself and
 * `AgentBuilder` had joined the set with nothing naming them. Four, and
 * `webcheck`'s `REACH_SCREENS` is the list this has to agree with, along with the
 * copy of this sentence at `reachText` in `ui/bits.tsx` — where the sentence is
 * now composed once, by `NotReachable`, and the four screens mount it on their
 * `unreachable` arm rather than each writing it out.
 *
 * This is {@link missingRowReason}'s fix in the shape that function already
 * proved out for `SessionView`, one screen over: the arm that was missing is
 * "still finding out", and it is a value in a partition rather than a fourth
 * boolean at each call site.
 *
 * **`probing` is `readable`, and that is the half that looks wrong.** It is not
 * a measurement in progress *from nothing* — it is this client re-checking a
 * route it deliberately forgot, on a machine it already believed in, publishing
 * twice on every tab switch. `daemonReadable`'s docblock above is entirely about
 * why taking the screen away for that is a regression, and this partition keeps
 * that answer rather than reopening it: `unknown` is the never-asked state and is
 * the only one that gets the new arm. The invariant is exact — `daemonReadable`
 * is `daemonRead(reach) === "readable"` for all four values, because it is
 * literally implemented as that.
 *
 * Pure, and beside `daemonReadable` for that function's reason: `webcheck` walks
 * all four `Reach` values here instead of asserting JSX on four screens.
 */
export function daemonRead(reach: Reach): DaemonRead {
  // Never asked. Not an answer, and above all not a failure — the sentence a
  // screen draws here is about this client, not about the host.
  if (reach === "unknown") return "asking";
  // Asked, and did not get one. The only arm that has earned the word "not
  // reachable", and the only one `reachText`'s `OFFLINE_TEXT` half describes.
  if (reach === "offline") return "unreachable";
  return "readable";
}

export interface MachineState {
  id: MachineId;
  name: string;
  relayUrl: string | null;
  relayOnline: boolean;
  enrolled: boolean;
  /**
   * When the control plane last saw a tunnel for it. See `MachineRecord`.
   *
   * `undefined` is a control plane that predates the field and `null` is one that
   * has never recorded a tunnel; collapsing them would tell somebody their
   * working fleet has never been seen.
   */
  lastSeenAt: number | null | undefined;
  /**
   * Whether this user owns it, and may therefore rename, re-enroll and retire it.
   *
   * `false` for a machine somebody else registered and shared, and for one an
   * admin created before ownership existed. Carried so the settings screen can
   * draw the controls only where they would work — the control plane answers 404
   * to the rest, deliberately, so a client that guessed would produce a button
   * that fails with "no such machine" on a machine plainly on screen.
   */
  owned: boolean;
  /**
   * Past its **owner's** machine limit, so switched off at the relay.
   *
   * **Carried beside `reach` rather than folded into it**, and the pair is not
   * redundant. `reach` is a measurement *this client made* — `probeRoute` says
   * so: "`relayOnline` is what the control plane last saw; the probe is what
   * this client can see". Over-limit is asserted by the control plane before any
   * probe and is true of a machine whose daemon is running and whose host is
   * fine. Carried only as a `reach` value it would be a state `settleRoute`
   * never measured. The shape being copied is `tokenDegraded`: a fact that is
   * not reachability, beside one that is.
   *
   * What follows from it *is* reachability — the tunnel is refused at dial — and
   * that half is `offlineReason: "over_limit"`, exactly as `enrolled` on this
   * interface pairs with `"not_enrolled"` there.
   */
  overLimit: boolean;
  /**
   * Its owner is banned, so it is switched off until an admin lifts that.
   *
   * Beside `overLimit` rather than merged with it, for the reason the wire type
   * gives: both switch a machine off and the *remedies* differ, so a row that
   * could not tell them apart would name the wrong one.
   */
  ownerDisabled: boolean;
  /**
   * Whose enrollment code brought this machine online, where that was not you.
   * See `MachineRecord.enrolledBy`, which is where the argument for it lives.
   *
   * **`undefined` is folded into `null` here, unlike `lastSeenAt` above**, and
   * the asymmetry is the point rather than an inconsistency. There the two
   * silences differ and a screen says different things about them — a control
   * plane that predates the table may not claim "never seen" about a fleet that
   * is working. Here they are one silence by construction: the field's own
   * `null` already means *unknown* rather than "you", so a control plane that
   * has never heard of the question is already inside the meaning of the value
   * it does not send. `?? null` is the whole migration, the same shape
   * `cancelRequestedAt` takes on the daemon's side of the wire.
   */
  enrolledBy: string | null;
  scopes: Scope[];
  route: Route | null;
  reach: Reach;
  offlineReason: OfflineReason;
  /** The control plane is unreachable and we are running on a token it already gave us. */
  tokenDegraded: boolean;
  tokenExpiresAt: number | null;
  health: DaemonHealth | null;
  lastError: string | null;
}

/**
 * May this request be sent a second time after a transport failure?
 *
 * `GET` and `DELETE` only, and by whitelist rather than by excluding `POST`: an
 * absent method is `GET`, and a method nobody has thought about yet should be
 * treated as unsafe rather than inherit a retry by default. `DELETE` is here
 * because the daemon's are idempotent — stopping an already-stopped session or
 * removing an already-removed workspace answers the same way twice.
 *
 * The mutating routes in this client are `POST` and `PUT`: creating a session,
 * sending a prompt, answering a permission, making a directory, and `PUT
 * /agent-auth/:agent` to store a credential. Answering a permission happens to be
 * safe on its own (the registry's compare-and-swap plus the `repeat` 409 absorb
 * it), and so does the `PUT`, which is an upsert — but both are properties of the
 * daemon rather than of the retry, and creating a session and sending a prompt
 * are not safe at all. The whitelist is what makes that distinction unnecessary
 * to get right per route.
 */
function isReplayable(method: string | undefined): boolean {
  const verb = (method ?? "GET").toUpperCase();
  return verb === "GET" || verb === "DELETE";
}

/**
 * A refused channel, said in the vocabulary the rest of this client speaks.
 *
 * ⚠ **`ChannelRefused` is an `Error` and `isTransportFailure` is a *negation* —
 * "not an `ApiError`" — so every refusal the daemon took the trouble to deliver
 * was classified as a dropped connection.** That predicate is a negation on
 * purpose (the browser withholds why a `fetch` rejected, so there is nothing
 * finer to key on) and `e2ee.ts`'s own docblock declines to state a second
 * opinion about it for the same reason. So the reconciliation belongs *here*, at
 * the one boundary where the two vocabularies meet, and it is a translation
 * rather than a second predicate: below this line nothing in this file knows a
 * channel refusal exists.
 *
 * Three things were wrong while it did not exist, and every one of them is a
 * behaviour rather than a wording:
 *
 *   - **A `502 truncated` was retried.** `src/e2ee.ts`'s `fail()` `end()`s the
 *     stream rather than `destroy()`ing it precisely so that frame survives and
 *     reaches the app as a refusal — which `settleTransport` then read as a dead
 *     link, dropped the route memo, and **replayed** for any replayable method.
 *     Q6.103 is the measurement that bought the frame; this is what it was for.
 *   - **`token_expired` at `HELLO` reached nothing that could act on it.** The
 *     unconditional re-mint lives on the `ApiError` path and a `ChannelRefused`
 *     never joined it, so a capability that aged out between two requests failed
 *     as weather instead of being renewed.
 *   - **`errorText` said "the connection failed, and whether the request arrived
 *     is not known"** for `unbound_capability`, `wrong_machine` and
 *     `wrong_device` alike — burying the verifier's own code, which is the only
 *     part of that failure anybody can act on.
 *
 * The `reason` becomes the `code` verbatim, including the ones that are prose
 * rather than a name (`truncated`, `the channel failed`). That is the honest
 * shape: `parseBody` already mints codes nobody chose — `http_404` for a bare
 * Hono 404 — and a code no predicate recognises falls through every one of them,
 * which is `wire.ts`'s standing rule about an unknown value.
 *
 * Anything that is *not* a refusal is returned untouched, so one `catch` covers
 * both and a genuine socket death still reaches the transport path.
 */
function asAnsweredRefusal(error: unknown, machine: string): unknown {
  if (!ChannelRefused.is(error)) return error;
  return new ApiError(error.status, error.reason, `${machine} refused this connection: ${error.reason}`);
}

export class MachineConnection {
  readonly id: MachineId;
  private name: string;
  private relayUrl: string | null;
  private relayOnline: boolean;
  private enrolled: boolean;
  private lastSeenAt: number | null | undefined;
  private owned: boolean;
  private overLimit: boolean;
  private ownerDisabled: boolean;
  private enrolledBy: string | null;
  private scopes: Scope[];

  private token: { value: string; expiresAt: number } | null = null;
  private minting: Promise<string> | null = null;
  /**
   * The machine's X25519 static, base64url, as the Authority last reported it.
   *
   * Arrives on the same `POST /v1/tokens` answer as `relayUrl` and `relayOnline`,
   * and for the reason those are there: minting is also how a client learns where
   * a machine is, and a key and a route are the same kind of fact. Kept in step by
   * construction rather than by a second fetch.
   *
   * `null` for a machine that has not dialled since it learned to announce one.
   * That is a sentence about updating that machine, never a session without
   * encryption — see {@link OfflineReason.no_machine_key}.
   */
  private machineKey: string | null = null;
  /** Every encrypted connection to this machine, and what it was built for. */
  private channel: Channel | null = null;
  private channelKey: string | null = null;
  private channelBase: string | null = null;
  private chosen: Route | null = null;
  private resolving: Promise<Route | null> | null = null;
  /**
   * Stop asking loopback about this machine.
   *
   * Set only where the daemon on this computer said `wrong_machine`, i.e. where the
   * announcement naming this machine is stale. Sticky for the session and cleared
   * in {@link update}, which `store.ts`'s `runResume` calls per machine per wake —
   * so a re-enrolled daemon is found again on the next wake rather than on a
   * reload, and a *shut* machine does not earn an authenticated loopback request
   * every fifteen seconds in the meantime.
   */
  private localDenied = false;

  private reach: Reach = "unknown";
  private offlineReason: OfflineReason = null;
  private tokenDegraded = false;
  private health: DaemonHealth | null = null;
  private lastError: string | null = null;

  private readonly onChange: () => void;

  constructor(
    record: MachineRecord,
    onChange: () => void,
    /**
     * How this machine's encrypted connections are made.
     *
     * Defaulted, so the one caller that matters — `store.ts` — never names it,
     * and a driver asserting a *routing* rule can stand a relay arm in without a
     * daemon behind it. See {@link Channel} for why the seam exists and why it is
     * not a switch.
     */
    private readonly channels: ChannelFactory = openChannel,
  ) {
    this.id = record.id as MachineId;
    this.name = record.name;
    this.relayUrl = record.relayUrl;
    this.relayOnline = record.relayOnline;
    this.enrolled = record.enrolled;
    this.lastSeenAt = record.lastSeenAt;
    // Absent from an older control plane, which means nothing is owned — the
    // honest degradation, since the routes that act on ownership would 404 there.
    this.owned = record.owned === true;
    // Same degradation, opposite polarity, same reason: absent means "not
    // suspended", which is true of a control plane that has no such concept.
    this.overLimit = record.overLimit === true;
    this.ownerDisabled = record.ownerDisabled === true;
    // Absent and `null` are one silence here rather than two — see
    // `MachineState.enrolledBy` for why this one may collapse and `lastSeenAt`
    // above may not.
    this.enrolledBy = record.enrolledBy ?? null;
    this.scopes = record.scopes;
    this.onChange = onChange;
  }

  /** Fold in a fresh registry row without discarding the token or the route memo. */
  update(record: MachineRecord): void {
    /*
     * The one thing here that is *not* folded in from the row.
     *
     * `runResume` calls this per machine per wake, which is the cadence a stale
     * loopback refusal should be re-tested at: the daemon on this computer may
     * have been re-enrolled, restarted onto another port, or started at all since
     * the last probe. Anything more often turns a shut machine into a token spent
     * on loopback every fifteen seconds; anything less means a reload.
     */
    this.localDenied = false;
    this.name = record.name;
    this.relayUrl = record.relayUrl;
    this.relayOnline = record.relayOnline;
    this.enrolled = record.enrolled;
    this.lastSeenAt = record.lastSeenAt;
    this.owned = record.owned === true;
    /*
     * Folded in here rather than read once at construction, so the field's own
     * stated remedy lands without a reload: re-enrolling a machine you did not
     * enroll sets this back to nothing on the server, and the row stops naming
     * somebody else the next time the listing is read.
     *
     * ⚠ **"The next time the listing is read" is not "on the poll", and this
     * said the second.** `update` has exactly two callers — `bootstrap` and
     * `runResume` in `store.ts` — and the four-second `tick()` deliberately makes
     * **no** control-plane round trip once any machine is known; it re-lists
     * sessions on machines that are already reachable and nothing else. So this
     * value moves on a wake (a tab hidden 20s or more, a bfcache restore,
     * `online`, the drift watchdog) or on a reload, and *not* while somebody sits
     * on the machine list watching it — which is the state a substitution would
     * be noticed in. Making it poll would put a control-plane request on the
     * four-second timer for a value that changes only when somebody re-enrolls,
     * which is the wrong trade; saying so here is the right one.
     */
    this.enrolledBy = record.enrolledBy ?? null;
    /*
     * **The transition, which is the part that is easy to miss.**
     *
     * Going over: a token already in hand is worthless, because it is the
     * *relay* that refuses — so keeping it would leave this machine reading
     * `online` on a memoised route until the token expired, minutes after it
     * stopped working. The route memo goes with it, since the tunnel is refused
     * at dial and the daemon is no longer there to reach.
     *
     * Coming back under: `reach` has to go back to `unknown` or the next resume
     * reports "over the machine limit" about a machine the admin has already
     * fixed, until something else happens to re-probe it.
     */
    const was = this.switchedOff();
    this.overLimit = record.overLimit === true;
    this.ownerDisabled = record.ownerDisabled === true;
    const now = this.switchedOff();
    if (now && !was) {
      this.token = null;
      this.chosen = null;
    }
    if (!now && was) {
      this.reach = "unknown";
      this.offlineReason = null;
      this.lastError = null;
    }
    this.scopes = record.scopes;
    this.onChange();
  }

  state(): MachineState {
    return {
      id: this.id,
      name: this.name,
      relayUrl: this.relayUrl,
      relayOnline: this.relayOnline,
      enrolled: this.enrolled,
      lastSeenAt: this.lastSeenAt,
      owned: this.owned,
      overLimit: this.overLimit,
      ownerDisabled: this.ownerDisabled,
      enrolledBy: this.enrolledBy,
      scopes: this.scopes,
      route: this.chosen,
      reach: this.reach,
      offlineReason: this.offlineReason,
      tokenDegraded: this.tokenDegraded,
      tokenExpiresAt: this.token?.expiresAt ?? null,
      health: this.health,
      lastError: this.lastError,
    };
  }

  /* ---------------------------------------------------------------- *
   * Tokens
   * ---------------------------------------------------------------- */

  /**
   * The current token, minting or renewing if it is close to expiry.
   *
   * Concurrent callers share one in-flight mint. Without that, waking with three
   * streams on this machine fires three `POST /v1/tokens` in the same tick and
   * two of the resulting tokens are discarded — which is wasteful on a phone and,
   * worse, makes `expiresAt` briefly disagree with the token the sockets are
   * actually holding.
   */
  async ensureToken(force = false): Promise<string> {
    /*
     * **One guard covers both the mint and the probe.**
     *
     * `POST /v1/tokens` answers 403 for a machine over its owner's limit, and
     * the relay refuses it again, so every round trip below is one that cannot
     * succeed — per machine, per wake, for as long as the state lasts.
     * `probeRoute` calls this and its catch already returns null with "the mint
     * has recorded why", and `prepare()` throws `503 unreachable` before any
     * fetch, so short-circuiting here is the whole of not spending them.
     *
     * The reason is set here rather than left to the caller because this is the
     * only place that knows the difference between "could not reach it" and "may
     * not have it".
     */
    if (this.switchedOff()) {
      this.token = null;
      this.reach = "offline";
      this.offlineReason = this.ownerDisabled ? "owner_disabled" : "over_limit";
      this.onChange();
      throw this.ownerDisabled
        ? new ApiError(403, "owner_disabled", `${this.name} belongs to a disabled user`)
        : new ApiError(403, "machine_over_limit", `${this.name} is over the machine limit`);
    }
    const held = this.token;
    if (!force && held !== null && Date.now() < held.expiresAt - TOKEN_RENEW_MARGIN_MS) {
      return held.value;
    }
    this.minting ??= this.mint().finally(() => {
      this.minting = null;
    });
    return this.minting;
  }

  tokenExpiresAt(): number | null {
    return this.token?.expiresAt ?? null;
  }

  /**
   * The control plane has switched this machine off, for either of its reasons.
   *
   * One predicate because every *mechanical* consequence is identical — no
   * token, no probe, no route memo — while the two are kept apart everywhere a
   * person reads them, because the remedies differ.
   */
  private switchedOff(): boolean {
    return this.overLimit || this.ownerDisabled;
  }

  private async mint(firstAttempt = true): Promise<string> {
    let issued;
    try {
      issued = await mintToken(this.id);
    } catch (error) {
      /*
       * The one refusal this client can fix by itself, and it fixes it here.
       *
       * Every installation that predates device keys reaches its first mint after
       * an update with a row the control plane has no key for, and so does one
       * whose credential store was reset. The refusal names the remedy —
       * register the key this shell already holds — so applying it at the point of
       * the refusal is what stops the whole fleet needing a person to sign in
       * again on every machine.
       *
       * **Once**, and the guard is the same `firstAttempt` the request path uses:
       * a registration that does not take must surface as the refusal it is
       * rather than as a loop against the control plane.
       */
      if (firstAttempt && meansDeviceKeyMissing(error)) {
        const registered = await registerDevice().catch(() => null);
        if (registered !== null) return await this.mint(false);
      }
      /*
       * The one outage that must not stop anything.
       *
       * A control plane that cannot be reached has not revoked anybody — it is
       * simply down, and the daemon, the agent and the session are all fine. If
       * a token we already hold is still valid, the correct behaviour is to keep
       * working and say so, not to fail a UI that has everything it needs.
       *
       * Only a *transport* failure qualifies. A 403 or a 404 is the control
       * plane answering, and an answer is not an outage.
       */
      const held = this.token;
      if (isTransportFailure(error) && held !== null && Date.now() < held.expiresAt) {
        this.tokenDegraded = true;
        this.onChange();
        return held.value;
      }
      this.token = null;
      this.reach = "offline";
      /*
       * ⚠ **Three answers rather than two, because a missing *key* was being
       * reported as a missing *token*.**
       *
       * `device_key_required` reaches here twice over, and both ways used to land
       * on `no_token`: on the retry above, when `registerDevice()` answered a row
       * id and the Authority still has no key for it — the route keeps a
       * registration whose `publicKey` it refused and reports `hasKey: false`, so
       * the id coming back is not evidence the remedy took — and on the first
       * attempt, when there was nothing to register at all because
       * `describeDevice()` answered `null`. A browser is the second case for
       * every machine on the account, forever.
       *
       * The remedy is on this computer either way, which is what
       * {@link OfflineReason.no_device_key} exists to be able to say. Keyed on
       * the code rather than on the attempt, so the first-attempt case — the one
       * with no registration to re-fail — is covered by the same line.
       */
      this.offlineReason = isTransportFailure(error)
        ? "cp_unreachable"
        : meansDeviceKeyMissing(error)
          ? "no_device_key"
          : "no_token";
      this.lastError = describe(error);
      this.onChange();
      throw error;
    }

    /*
     * The deadline, translated onto *this* device's clock.
     *
     * `issued.expiresAt` is an absolute instant on the control plane's clock, and
     * every comparison in this file is against `Date.now()` on a phone. A phone's
     * clock drifts, and the failure is silent in both directions: fast by more
     * than the margin and every `ensureToken` mints a fresh token because the held
     * one always looks stale; fast by more than the whole lifetime and
     * `cachedToken()` returns `null` for a token the daemon would happily accept.
     * Slow, and rotation is scheduled after the daemon has already closed the
     * socket at `exp + leeway`, so the stream flaps instead of rotating.
     *
     * `serverTime` is on the response for exactly this reason — the same reason
     * `/health` carries `time` unauthenticated and the daemon returns `skewMs` in
     * a 401. It was the one part of that machinery nothing read. Subtracting it
     * converts the server's absolute deadline into a *duration*, which is the only
     * part both clocks agree on, and adds it to local now.
     *
     * Falls back to the raw value if an older control plane omits `serverTime`;
     * that is the previous behaviour, not a new risk.
     */
    const lifetimeMs =
      typeof issued.serverTime === "number" ? issued.expiresAt - issued.serverTime : issued.expiresAt - Date.now();
    this.token = { value: issued.token, expiresAt: Date.now() + lifetimeMs };
    this.tokenDegraded = false;
    this.lastError = null;

    // The registry telling us where the machine is, on the same call that proves
    // we may reach it. Kept in step by construction rather than by a second fetch.
    this.relayUrl = issued.machine.relayUrl;
    this.relayOnline = issued.machine.relayOnline;
    /*
     * And what to encrypt to when we get there.
     *
     * `?? null` rather than left alone on absence, because an Authority that has
     * stopped reporting a key for this machine is telling us something — the row
     * was cleared, or the machine was re-enrolled onto a new one — and a
     * remembered key would then be used to start a handshake that can only fail.
     * Dropping it costs the honest sentence instead.
     */
    this.machineKey = issued.machine.key ?? null;

    this.onChange();
    return issued.token;
  }

  /* ---------------------------------------------------------------- *
   * Routing
   * ---------------------------------------------------------------- */

  /**
   * Forget what we last believed about reachability, so the next resolve re-asks.
   *
   * This used to drop a memoised *route* and re-probe two candidates. There is
   * one route, so what it drops is the belief that the machine is up — which is
   * still worth having, because the relay reports a machine with no tunnel as a
   * `503` and it comes back on its own the moment the daemon re-dials.
   *
   * **Never called on an HTTP status other than that one.** A 401, a 404 or a 403
   * means the request arrived and the daemon answered; treating those as
   * unreachable would flap the whole screen on an ordinary application error.
   */
  forgetRoute(): void {
    if (this.chosen === null) return;
    this.chosen = null;
    /*
     * The open connections go with the belief.
     *
     * Every caller of this reaches it because the path stopped working — a
     * transport failure, a `no_tunnel`, a network that changed under a phone — and
     * a pooled connection established over that path is exactly as dead as the
     * route memo is stale. Keeping them would mean the re-probe succeeds, hands
     * back a route, and the first request on it is then spent discovering that
     * the socket underneath died while the screen was off.
     */
    this.closeChannel();
    this.onChange();
  }

  /**
   * Re-ask the control plane *where* this machine is, not just whether it is up.
   *
   * `forgetRoute` drops the belief that the machine is reachable and nothing
   * else — in particular it keeps the token, and `relayUrl` only ever moves
   * inside `mint()`. With one relay that is complete, because the answer cannot
   * change. With two it is not: a daemon that redials lands on whichever relay
   * the shared name fronts, `relayUrlFor` starts answering with the *other*
   * relay's URL, and the copy held here is stale until the token happens to need
   * renewing.
   *
   * What that cost, measured against the constants: `ensureToken()` returns the
   * held token while it is more than `TOKEN_RENEW_MARGIN_MS` from expiry, so with
   * a 300s lifetime the refresh is up to 210s away. `probeRoute` reads
   * `this.relayUrl` and therefore re-probes the relay that has already said it
   * does not hold this machine, and `store.ts`'s offline retry re-runs that same
   * losing probe every 15s. So the documented recovery — "the client drops its
   * route belief on that code and re-probes" — is true of an *unmapped* fleet,
   * where every probe is a fresh coin flip through the load balancer, and false
   * of a correctly mapped one, where the client is pinned to the wrong relay.
   * A wake repairs it (`GET /v1/machines` in `runResume` assigns `relayUrl`), so
   * a phone recovers on tab focus and a desktop left alone does not.
   *
   * `POST /v1/tokens` answers with the token *and* the machine's current route,
   * which is what `mint` already relies on — "kept in step by construction rather
   * than by a second fetch". Forcing one is therefore the whole repair.
   *
   * Deliberately **not** inside `forgetRoute`, which is also called on every
   * transport failure: a phone on flaky LTE would then mint a token per dropped
   * request, against the one service whose outage this client is built to
   * survive. This fires only where the relay has *answered* `no_tunnel`, i.e.
   * where "somewhere else, or nowhere" is exactly the question.
   *
   * Fire-and-forget, and it must be: the caller is a `catch` about to rethrow the
   * error the request actually failed with, and awaiting here would either delay
   * that throw or replace it with a mint failure. The refusal paths already
   * record themselves — `mint` sets `offlineReason` and `lastError`, and
   * `ensureToken` throws outright for a machine switched off — so there is
   * nothing to report from here that is not already on the state.
   */
  private refetchRoute(): void {
    void this.ensureToken(true).catch(() => {
      // Recorded by `mint`/`ensureToken` on the way past; this is the next
      // probe's problem, not this request's.
    });
  }

  currentRoute(): Route | null {
    return this.chosen;
  }

  async resolveRoute(): Promise<Route | null> {
    if (this.chosen !== null) return this.chosen;
    this.resolving ??= this.probeRoute().finally(() => {
      this.resolving = null;
    });
    return this.resolving;
  }

  /**
   * Confirm the machine is up, and decide which of the two ways reaches it.
   *
   * The probe is authenticated, and always was on the relay path: the relay checks
   * every request including `/health`, and an unauthenticated one would be a free
   * oracle for which machines in the fleet are online.
   *
   * ⚠ **The local candidate is tried above the `relayOnline` check, and that
   * placement is the whole of whether it is useful.** `relayOnline` is what the
   * *control plane* last saw — so a laptop whose tunnel is down, or whose control
   * plane is unreachable, answers `false` there and would never reach a local
   * candidate placed below it. That machine is precisely the one this feature is
   * for: it is three feet away and running.
   */
  private async probeRoute(): Promise<Route | null> {
    if (!this.enrolled) {
      this.reach = "offline";
      this.offlineReason = "not_enrolled";
      this.onChange();
      return null;
    }

    /*
     * **A re-probe of a machine already believed reachable does not erase that
     * belief**, and this line used to.
     *
     * `probing` means "no answer yet". `resumeMachine` calls `forgetRoute()` on
     * every wake — correctly, because a route learned on one network says nothing
     * on another — so a healthy machine came through here on every tab switch and
     * published `online → probing → online`, up to 1.5s apart. Everything keyed on
     * `reach` changed twice for a question whose answer never changed: the dot on
     * every machine row went hollow and back, and the agents panel unmounted and
     * remounted, restarting `useAgentAuth` from nothing and throwing away whatever
     * was half-typed into it.
     *
     * The knowledge is still there while it is being re-checked, so it is kept.
     * `unknown` remains the value for never having asked, and a probe that fails
     * still lands on `offline` below — the only thing given up is announcing the
     * question, which nothing on screen was better for.
     */
    if (this.reach !== "online") this.reach = "probing";
    this.offlineReason = null;
    this.onChange();

    let token: string;
    try {
      token = await this.ensureToken();
    } catch {
      // `mint` has already recorded why and notified.
      return null;
    }

    const local = this.localDenied ? null : await localBaseFor(this.id);
    if (local !== null) {
      const health = await this.proveLocal(local, token);
      if (health !== null) {
        this.health = health;
        return this.settleRoute({ base: local, kind: "local" }, null);
      }
    }

    // `relayOnline` comes from the registry row and is what the control plane
    // last saw; the probe is what this client can see. Both have to hold.
    const relay = this.relayOnline ? this.relayUrl : null;
    if (relay === null) return this.settleRoute(null, "no_route");

    /*
     * ⚠ **A machine with no announced key is refused here rather than at the
     * first request, and that placement is the refusal to downgrade.** Everything
     * below this line reaches the machine through an encrypted channel; there is
     * no second path, no plaintext arm and no flag that would produce one. So the
     * honest answer is that the route does not exist yet, with a reason that says
     * what to do about it — not a route that works for `/health` and fails for
     * everything a person actually wanted.
     */
    if (this.machineKey === null) return this.settleRoute(null, "no_machine_key");

    const health = await this.probe({ base: relay, kind: "relay" }, token);
    if (health === null) return this.settleRoute(null, "no_route");
    this.health = health;
    return this.settleRoute({ base: relay, kind: "relay" }, null);
  }

  private settleRoute(route: Route | null, reason: OfflineReason): Route | null {
    this.chosen = route;
    this.reach = route === null ? "offline" : "online";
    this.offlineReason = route === null ? reason : null;
    if (route !== null) this.lastError = null;
    this.onChange();
    return route;
  }

  /**
   * Is the daemon on this computer *this* machine?
   *
   * **The `aud` check establishes it and nothing else does**, which is the
   * condition Q7.135 set and the reason this spends a request rather than trusting
   * the file. `src/auth.ts`'s middleware sits above every route, so what a
   * non-401 answer proves is that the signature verified against a key this daemon
   * captured at enrollment, the issuer matched, the audience is this daemon's own
   * machine id, and the token is inside its window. That is the identity claim in
   * full. The announcement only decided the question was worth asking.
   *
   * ⚠ **Any status but 401 is proof**, and the temptation to require 200 is a bug
   * waiting to happen. A grant with no `session:read` scope answers `403
   * insufficient_scope`, and a daemon older than a route answers Hono's bare 404 —
   * both *after* the gate, so both mean the audience matched. Requiring 200 would
   * make a legitimate local daemon unreachable for a reason that has nothing to do
   * with which machine it is.
   *
   * `GET /fs/roots` and not `GET /sessions`: the latter builds a snapshot of every
   * session before it applies a limit. Not `OPTIONS` either — `src/cors.ts`
   * short-circuits a preflight *above* the auth gate, so it would answer 204
   * whoever asked and prove nothing at all.
   *
   * A `wrong_machine` denies loopback for the session; every other 401 declines
   * this round without denying, because they are facts about the *token* — a
   * rotated signing key, a clock, a daemon still on `shared_secret` — that the next
   * wake may find changed.
   */
  private async proveLocal(base: string, token: string): Promise<DaemonHealth | null> {
    let response: Response;
    try {
      response = await fetch(new URL("/fs/roots", base), {
        signal: withTimeout(PROBE_TIMEOUT_MS),
        headers: { authorization: `Bearer ${token}` },
      });
    } catch {
      // Refused, blocked or too slow. On this path that is nearly always "the
      // daemon stopped and left its announcement behind", and the answer is the
      // same as for every other failure here: use the relay.
      return null;
    }
    if (response.status === 401) {
      const body = await response.text();
      let refusal: unknown;
      try {
        parseBody(response.status, response.statusText, body);
      } catch (error) {
        refusal = error;
      }
      if (meansWrongMachine(refusal)) this.denyLocal();
      return null;
    }
    // Proven. `/health` is unauthenticated, so it is asked *after* the identity is
    // settled rather than before — a shape nothing else could have told us apart
    // from a stranger answering 200.
    return await this.probe({ base, kind: "local" }, null);
  }

  /**
   * Stop offering the loopback path for this machine.
   *
   * ⚠ **Not `forgetRoute()`**, which drops the memo and would send the very next
   * `resolveRoute` straight back to loopback, for ever. And ⚠ **not
   * `refetchRoute()`**: that forces a control-plane mint, and this is a *daemon*
   * answering a question about itself — spending a round trip on the one service
   * this client is built to survive the outage of would be exactly backwards.
   *
   * The memo is cleared on the next wake; see the field.
   */
  private denyLocal(): void {
    this.localDenied = true;
    if (this.chosen?.kind === "local") {
      this.chosen = null;
      this.onChange();
    }
  }

  /**
   * Ask the daemon whether it is there, over the transport a request would use.
   *
   * ⚠ **The relay arm goes through the channel, and that is the point of asking
   * at all.** A probe that used a different transport from the requests it is
   * clearing the way for would answer a question nobody had: what it now proves
   * is that the tunnel is up, the daemon answered, the machine holds the private
   * half of the key the Authority named, and this installation's device key is
   * one the daemon accepts. Every one of those has to hold before a request can
   * work, and all four are settled by one `GET /health`.
   *
   * The loopback arm stays `fetch` against an *unauthenticated* route, which is
   * why {@link proveLocal} establishes the machine first and calls this second.
   */
  private async probe(route: Route, token: string | null): Promise<DaemonHealth | null> {
    try {
      if (route.kind === "relay") {
        const answer = await this.overChannel(route, {
          method: "GET",
          path: "/health",
          headers: token === null ? {} : { authorization: `Bearer ${token}` },
          timeoutMs: PROBE_TIMEOUT_MS,
        });
        if (answer.status < 200 || answer.status > 299) return null;
        return JSON.parse(bodyText(answer.body)) as DaemonHealth;
      }
      const response = await fetch(new URL("/health", route.base), {
        signal: withTimeout(PROBE_TIMEOUT_MS),
        headers: token === null ? {} : { authorization: `Bearer ${token}` },
      });
      if (!response.ok) return null;
      return (await response.json()) as DaemonHealth;
    } catch {
      // Unreachable, refused, blocked, unopenable or too slow. All the same
      // answer here, and deliberately: this is the question "can I reach it",
      // and every one of those is "no".
      //
      // ⚠ That now includes a channel the daemon *answered* by refusing —
      // `overChannel` has already turned it into an `ApiError`, and it is
      // swallowed here like the rest. The distinction the translation buys is
      // about a *request*, where an answered refusal must not be replayed and
      // carries a sentence somebody reads; a probe returns a boolean dressed as
      // a health record, and "the machine said no" is still no. What the caller
      // then draws is `probeRoute`'s `no_route`, which is honest: an installation
      // this whole account cannot reach anything from is `mint`'s refusal and
      // lands on {@link OfflineReason.no_device_key} one step earlier.
      return null;
    }
  }

  /* ---------------------------------------------------------------- *
   * The encrypted channel
   * ---------------------------------------------------------------- */

  /**
   * This machine's channels, built on the key and the route it was last told.
   *
   * ⚠ **Rebuilt rather than mutated when either moves**, and both move on the
   * same answer. A `MachineChannel` holds open connections whose Noise sessions
   * were established against one static key and dialled at one relay; keeping
   * them across a change would mean a pool where some connections reach the
   * machine and some reach whatever used to be at that address. Disposing is one
   * handshake's cost and removes the whole question.
   *
   * Throws rather than answering `null`, because every caller is mid-request and
   * has no smaller thing to do. The refusals it raises are the two that are
   * genuinely different: a machine that has announced no key (update it), and an
   * installation that holds none (this shell cannot reach anything remote).
   */
  private channelFor(route: Route): Channel {
    const key = this.machineKey;
    if (key === null) {
      throw new ApiError(
        503,
        "machine_key_missing",
        `${this.name} has not told the control plane an encryption key — update the daemon on that machine`,
        null,
      );
    }
    if (this.channel !== null && (this.channelKey !== key || this.channelBase !== route.base)) {
      this.channel.dispose();
      this.channel = null;
    }
    if (this.channel === null) {
      this.channelKey = key;
      this.channelBase = route.base;
      this.channel = this.channels({
        relayUrl: route.base,
        machineKey: key,
        /*
         * A callback rather than a value, because a channel outlives a token.
         * `ensureToken` is the one place that decides whether the held one is
         * still good, and a second copy of that rule is a second thing to be
         * wrong about `serverTime`.
         */
        credential: async () => ({ token: await this.ensureToken(), expiresAt: this.token?.expiresAt ?? 0 }),
        /*
         * The remedy for a re-keyed installation, and the mirror of the one
         * `mint` applies for an unregistered one. The order matters: register
         * first so the Authority holds the key this shell actually has, then mint
         * so the next capability names it. Minting without registering would
         * re-issue the same stale binding and the handshake would fail again.
         */
        onWrongDevice: async () => {
          await registerDevice();
          await this.ensureToken(true);
        },
      });
    }
    return this.channel;
  }

  /**
   * One request over this machine's channel, with a refusal kept as a refusal.
   *
   * ⚠ **The single door every channel request goes through, and that is the
   * whole of why it exists.** `probe`, `send` and `download` each drove
   * `channelFor(route).request(...)` themselves, so the translation in
   * {@link asAnsweredRefusal} would have had to be written three times and
   * forgotten on the fourth — and the fourth is the one that matters, because a
   * missing copy is not a compile error, it is one route where an answered
   * refusal is replayed as a dead link.
   *
   * It also catches what {@link channelFor} itself throws — the `503
   * machine_key_missing` for a machine that has announced no static — which is
   * already an `ApiError` and passes through untouched. That one used to reach
   * the transport path and drop a route memo over a refusal this client raised
   * against itself.
   */
  private async overChannel(route: Route, wanted: ChannelRequest): Promise<ChannelResponse> {
    try {
      return await this.channelFor(route).request(wanted);
    } catch (error) {
      throw asAnsweredRefusal(error, this.name);
    }
  }

  /** Give up every open connection. Called where the route belief is dropped. */
  private closeChannel(): void {
    this.channel?.dispose();
    this.channel = null;
    this.channelKey = null;
    this.channelBase = null;
  }

  /**
   * One request, on whichever of the two transports this route names.
   *
   * ⚠ **This is the only branch on `route.kind` that decides how bytes travel**,
   * and it is why `request`, `upload` and `download` each have exactly one. The
   * loopback arm is `fetch` and stays `fetch`: it is a connection to `127.0.0.1`
   * made by a process running as the same uid, so there is nothing between the
   * two ends to encrypt against, and adding a handshake there would buy nothing
   * and cost the one path that has to keep working while the Authority is down.
   */
  private async send(
    route: Route,
    token: string,
    path: string,
    init: RequestInit,
    timeoutMs: number,
    extra: { onProgress?: ((fraction: number) => void) | undefined; signal?: AbortSignal | undefined } = {},
  ): Promise<{ status: number; statusText: string; bytes: Uint8Array }> {
    const headers: Record<string, string> = { authorization: `Bearer ${token}` };
    const contentType = contentTypeFor(init.body);
    if (contentType !== null) headers["content-type"] = contentType;

    if (route.kind === "relay") {
      const answer = await this.overChannel(route, {
        method: (init.method ?? "GET").toUpperCase(),
        path,
        headers,
        body: await bodyBytes(init.body),
        onProgress: extra.onProgress,
        signal: extra.signal,
        timeoutMs,
      });
      return { status: answer.status, statusText: answer.statusText, bytes: answer.body };
    }

    const response = await fetch(new URL(path, route.base), {
      ...init,
      headers,
      signal: withTimeout(timeoutMs, extra.signal ?? init.signal ?? undefined),
    });
    return {
      status: response.status,
      statusText: response.statusText,
      bytes: new Uint8Array(await response.arrayBuffer()),
    };
  }

  /* ---------------------------------------------------------------- *
   * Requests
   * ---------------------------------------------------------------- */

  /**
   * An authenticated request to this daemon, on whichever path is live.
   *
   * Two retries are possible and they share one guard, because "have we already
   * retried" is one fact rather than two: a route that failed and a token that
   * expired are different causes with the same budget.
   */
  async request<T>(path: string, init: RequestInit = {}, firstAttempt = true): Promise<T> {
    const { route, token } = await this.prepare();
    const timeout = slowRoute(init.method, path) ? SLOW_ROUTE_TIMEOUT_MS : REQUEST_TIMEOUT_MS;
    const retry = (): Promise<T> => this.request<T>(path, init, false);

    let answer: { status: number; statusText: string; bytes: Uint8Array };
    try {
      answer = await this.send(route, token, path, init, timeout, { signal: init.signal ?? undefined });
    } catch (error) {
      return this.settleTransport(error, isReplayable(init.method), firstAttempt, retry);
    }

    return this.settleAnswer<T>(answer.status, answer.statusText, bodyText(answer.bytes), firstAttempt, retry);
  }

  /**
   * Everything a request needs before it can be sent, or a refusal.
   *
   * Extracted so `upload` and `download` cannot grow their own version of it —
   * see `settleAnswer` for why sharing these three matters more than it looks.
   */
  private async prepare(): Promise<{ route: Route; token: string }> {
    const route = await this.resolveRoute();
    if (route === null) {
      throw new ApiError(503, "unreachable", `${this.name} is not reachable`, {
        reason: this.offlineReason,
      });
    }
    return { route, token: await this.ensureToken() };
  }

  /**
   * What a *transport* failure means, and whether to try once more.
   *
   * Always either retries or throws, so a caller's `catch` arm ends here.
   *
   * ⚠ **An answered refusal can reach this `catch` as well, and reading one as a
   * dead link is a bug rather than a rounding error.** Three callers hand
   * everything their `try` threw straight to this method, and over an encrypted
   * channel not everything in there is weather: {@link asAnsweredRefusal} turns a
   * refused channel into an `ApiError`, and {@link channelFor} raises one
   * directly for a machine that has announced no key. Both used to land on the
   * route-drop-and-replay below — which is exactly what `src/e2ee.ts` `end()`s a
   * failed stream to prevent (Q6.103). So the dispatch is the first statement
   * here, and what follows it is what the name says: a link that died.
   */
  private async settleTransport<T>(
    error: unknown,
    replayable: boolean,
    firstAttempt: boolean,
    retry: () => Promise<T>,
  ): Promise<T> {
    if (ApiError.isApiError(error)) return this.settleRefusal(error, firstAttempt, retry);
    /*
     * The route stopped answering. Forget it and try once more, which turns
     * "my network changed" into one slow request rather than a dead screen:
     * the re-probe re-establishes whether the tunnel is up, so a phone that
     * comes back onto a working network recovers on the next request rather
     * than on the next poll.
     */
    /*
     * Only for a request it is safe to send twice.
     *
     * A transport failure says nothing about whether the daemon *acted*. The
     * timeout that most often lands here is our own `AbortSignal.timeout`, and
     * the ordinary way to earn it is a phone dropping to LTE — long after the
     * daemon accepted the request, appended the event and started the turn.
     * Replaying the identical body then runs the prompt a second time, or, on
     * `POST /sessions`, creates a second session with a second worktree and a
     * second agent subprocess for one tap.
     *
     * An upload lands on the same rule by the same whitelist, and it is worth
     * knowing that the arithmetic there is different: a replay is a second
     * 25 MiB copy under a second `uploadId`, referenced by no prompt, spending
     * the session's storage budget twice with the first copy orphaned until the
     * daemon's sweep finds it. Same verdict, different reason — which is why
     * this is not the place to add an idempotency key.
     *
     * So the route-change retry is gated on the methods that can be repeated
     * without consequence. A mutating request reports the failure instead and
     * lets a person decide — the route memo is still dropped either way, so the
     * *next* request lands on the path that works.
     *
     * The `token_expired` retry in {@link settleRefusal} is different and stays
     * unconditional: an `ApiError` is proof the daemon refused the request rather
     * than performed it — which is true of one parsed out of a body and equally
     * true of one translated from a refused channel, since a capability turned
     * away at `HELLO` never reached a handler either.
     */
    if (firstAttempt && replayable) {
      this.forgetRoute();
      const next = await this.resolveRoute();
      if (next !== null) return retry();
    } else if (firstAttempt) {
      this.forgetRoute();
    }
    this.markUnreachable("no_route", describe(error));
    throw error;
  }

  /**
   * What an *answered* request means.
   *
   * Takes a status and a body string rather than a `Response`, because an upload
   * runs on `XMLHttpRequest` — `fetch` reports no upload progress — and there is
   * no `Response` there to hand over. This is the single place two rules live:
   * the `409`-carrying-a-success-body parse (in `parseBody`), and the reach flip
   * back to online.
   *
   * ⚠ **The third rule that used to be listed here — `meansMachineGone` — is
   * {@link settleRefusal}'s now, and it moved rather than multiplied.** What a
   * refusal means stopped being a property of *this* door the moment a channel
   * handshake could raise one too, and the old warning still applies word for
   * word: a second copy of that rule renders a machine as up while every request
   * under it fails.
   */
  private async settleAnswer<T>(
    status: number,
    statusText: string,
    text: string,
    firstAttempt: boolean,
    retry: () => Promise<T>,
  ): Promise<T> {
    try {
      const body = parseBody<T>(status, statusText, text);
      if (this.reach !== "online") {
        this.reach = "online";
        this.offlineReason = null;
        this.onChange();
      }
      return body;
    } catch (error) {
      return this.settleRefusal(error, firstAttempt, retry);
    }
  }

  /**
   * What an answered *refusal* means, wherever it was answered.
   *
   * ⚠ **One body for two doors, because the rules in it are about the refusal
   * and not about which `catch` caught it.** It was `settleAnswer`'s `catch`
   * alone, which only ever sees what `parseBody` throws — so the moment a
   * refusal could also arrive from a channel handshake, every rule here was
   * unreachable for half the fleet's failures. A second copy in
   * {@link settleTransport} would be the defect the `meansMachineGone` comment
   * below already records, in a second place: two arms deciding whether a machine
   * is gone, drifting until one of them draws a machine as up while every request
   * under it fails.
   *
   * Always either retries or throws, which is what makes it safe to be the tail
   * of both.
   */
  private async settleRefusal<T>(error: unknown, firstAttempt: boolean, retry: () => Promise<T>): Promise<T> {
    if (firstAttempt && ApiError.isApiError(error) && error.code === "token_expired") {
      /*
       * ⚠ **The channel has to go with the token, and re-minting alone does not
       * reach it.** `src/e2ee.ts` pins the capability presented at `HELLO` onto
       * every inner request and *replaces* whatever the client sent, so on the
       * relay arm the credential that just expired is the session's rather than
       * this request's: a fresh token handed to a pooled connection is a header
       * the daemon throws away, and the retry earns the same 401. Dropping the
       * pool costs one handshake and is the only thing that makes the renewal
       * take effect. A no-op on the loopback arm, where there is no channel —
       * which is why it is unconditional rather than guarded on `route.kind`.
       */
      this.closeChannel();
      await this.ensureToken(true);
      return retry();
    }
    /*
     * **The one status rule the relay candidate must not get.**
     *
     * `forgetRoute`'s docblock says a route is never dropped on an HTTP status
     * other than `no_tunnel`, and that stays true — this does not call it. What
     * this handles is narrower and only exists on the loopback arm: the daemon on
     * this computer says the token was issued for a *different* machine, which
     * means the file naming it is stale. A daemon re-enrolled, or a second one
     * took the port. `route.kind` is the guard rather than the code alone, because
     * down the tunnel the relay has already derived the machine from the same
     * verified `aud` before a byte moved — a `wrong_machine` from *there* is two
     * services disagreeing about one fact, and not a reason for one client to
     * abandon the only path it has.
     *
     * ⚠ **Retrying a non-replayable method is safe here, and here only.** A
     * `wrong_machine` 401 comes from the middleware `src/server.ts` mounts above
     * every route, so no handler ran: nothing was created, no prompt was
     * delivered, no upload was stored. That is what `isReplayable` exists to be
     * unsure about on a *transport* failure, and what a parsed refusal settles.
     */
    if (this.chosen?.kind === "local" && meansWrongMachine(error)) {
      this.denyLocal();
      if (firstAttempt) return retry();
      throw error;
    }
    /*
     * **`no_tunnel` is the one HTTP answer that means the machine is gone, and
     * nothing was reading it.** `forgetRoute`'s own doc says it is called on
     * exactly this status and on no other; that call site did not exist. A
     * daemon that stops, or loses its tunnel, answers every request through the
     * relay with this — and since a parsed `ApiError` never reached the
     * transport `catch`, `chosen` stayed memoised and `reach` stayed
     * `"online"`. `store.ts`'s poll then re-probes only machines already marked
     * offline, so the row rendered as up, indefinitely, while every request
     * under it failed. The socket close path recovered it, but only for a
     * session actually being streamed.
     *
     * **Keyed on the code, never on the status.** The daemon answers its own
     * `503 unresponsive` when a browse path sits on a stalled mount, and that
     * is the daemon talking — reading it as "machine unreachable" would black
     * out a healthy machine because one directory did not answer.
     */
    if (meansMachineGone(error)) {
      this.forgetRoute();
      this.markUnreachable("no_route", (error as ApiError).message);
      this.refetchRoute();
    }
    throw error;
  }

  /**
   * Send a file, reporting progress.
   *
   * `XMLHttpRequest` rather than `fetch`, and not by preference: `fetch` exposes
   * no upload progress at all, and a `ReadableStream` request body — which would
   * let the bytes be counted as they go — is Chromium-only, so it does not exist
   * on the phone this client is shaped around. What it is *not* is a second
   * transport: route resolution, token minting, `meansMachineGone` and the
   * unreachable bookkeeping all run through the same four helpers above.
   *
   * Only the caller's own abort is a cancel. It must not be reported as a
   * transport failure and must not mark the machine unreachable — somebody
   * removing a chip is not a network event.
   */
  async upload<T>(
    path: string,
    file: Blob,
    onProgress: (fraction: number) => void,
    signal: AbortSignal,
    firstAttempt = true,
  ): Promise<T> {
    const { route, token } = await this.prepare();
    const { stallMs, hardMs } = uploadDeadlines(file.size);
    const retry = (): Promise<T> => this.upload<T>(path, file, onProgress, signal, false);

    let answer: { status: number; statusText: string; text: string };
    try {
      if (route.kind === "relay") {
        /*
         * ⚠ **Over a channel there is no `XMLHttpRequest` and no stall budget,
         * and neither is missed.** `sendWithProgress` exists because `fetch`
         * reports no upload progress and a `ReadableStream` request body is
         * Chromium-only — so the only way to count bytes as they went was to
         * drive the request with an API from 2006 and watch its events. Inside a
         * channel the bytes are handed to the socket one chunk at a time and the
         * socket says when it took them, so progress *is* the loop. The stall
         * budget goes with it for the same reason: {@link uploadDeadlines}'s
         * `hardMs` bounds the whole request, and the chunk loop cannot advance
         * past a socket that has stopped draining — which is the state the stall
         * timer existed to notice.
         */
        const sent = await this.send(route, token, path, { method: "POST", body: file }, hardMs, {
          onProgress,
          signal,
        });
        answer = { status: sent.status, statusText: sent.statusText, text: bodyText(sent.bytes) };
      } else {
        answer = await sendWithProgress(new URL(path, route.base), file, token, onProgress, {
          stallMs,
          hardMs,
          signal,
        });
      }
    } catch (error) {
      // The caller asked for this. Not a network fact, so nothing is recorded.
      if (signal.aborted) throw error;
      return this.settleTransport(error, isReplayable("POST"), firstAttempt, retry);
    }

    return this.settleAnswer<T>(answer.status, answer.statusText, answer.text, firstAttempt, retry);
  }

  /**
   * Fetch bytes rather than JSON.
   *
   * `request` cannot serve this as `request<Blob>`: it consumes the body as text
   * and would hand 25 MiB of PNG to `JSON.parse`, then report a perfectly good
   * file as a malformed answer. The asymmetry is the point — **the error path is
   * text and the success path is bytes** — so the failure branch goes through
   * `settleAnswer` (which always throws for a non-2xx) and the success branch
   * never touches it.
   *
   * A `GET`, so `isReplayable` says yes and the route-change retry applies for
   * free. Nothing special was needed for that and nothing should be added.
   */
  async download(path: string, firstAttempt = true): Promise<Blob> {
    const { route, token } = await this.prepare();
    const retry = (): Promise<Blob> => this.download(path, false);

    let answer: { status: number; statusText: string; headers: Record<string, string>; bytes: Uint8Array };
    try {
      if (route.kind === "relay") {
        const got = await this.overChannel(route, {
          method: "GET",
          path,
          headers: { authorization: `Bearer ${token}` },
          timeoutMs: TRANSFER_TIMEOUT_MS,
        });
        answer = { status: got.status, statusText: got.statusText, headers: got.headers, bytes: got.body };
      } else {
        const response = await fetch(new URL(path, route.base), {
          headers: { authorization: `Bearer ${token}` },
          signal: withTimeout(TRANSFER_TIMEOUT_MS),
        });
        const headers: Record<string, string> = {};
        response.headers.forEach((value, name) => {
          headers[name.toLowerCase()] = value;
        });
        answer = {
          status: response.status,
          statusText: response.statusText,
          headers,
          bytes: new Uint8Array(await response.arrayBuffer()),
        };
      }
    } catch (error) {
      return this.settleTransport(error, isReplayable("GET"), firstAttempt, retry);
    }

    if (answer.status < 200 || answer.status > 299) {
      // Always throws — `parseBody` refuses every non-2xx. Typed as `Blob` only
      // so the two branches agree; nothing downstream sees this value.
      return this.settleAnswer<Blob>(answer.status, answer.statusText, bodyText(answer.bytes), firstAttempt, retry);
    }

    /*
     * The ceiling, still read off the declared length rather than off what
     * arrived.
     *
     * ⚠ **On the channel it is now a *second* line of defence rather than the
     * only one**, and that is worth saying because the two paths differ. Over
     * `fetch` this ran before `response.blob()`, so an oversized file was refused
     * rather than made resident — the whole point. Over a channel the frames have
     * already been reassembled by the time this runs, so the memory has been
     * spent; what the check still buys is that nothing hands a caller a file
     * larger than it is prepared for. The daemon's own `MAX_BODY_BYTES` is the
     * bound that matters on that path, and it is on the far side of the
     * encryption where it belongs.
     *
     * `content-length` is safelisted cross-origin and `content-disposition` is
     * not, which is why the size and not the name is what is read here.
     */
    const declared = Number(answer.headers["content-length"] ?? "");
    if (Number.isFinite(declared) && declared > MAX_DOWNLOAD_BYTES) {
      throw new ApiError(413, "file_too_large", "that file is too large to download here", {
        bytes: declared,
        limit: MAX_DOWNLOAD_BYTES,
      });
    }

    if (this.reach !== "online") {
      this.reach = "online";
      this.offlineReason = null;
      this.onChange();
    }
    const type = answer.headers["content-type"];
    return new Blob([answer.bytes as Uint8Array<ArrayBuffer>], type === undefined ? {} : { type });
  }

  /**
   * The WebSocket URL for a session's stream.
   *
   * The token rides as a query parameter because a browser cannot set headers on
   * a WebSocket handshake. Both the daemon's `readCredential` and the relay's
   * `readToken` accept it there, and the relay forwards the query string verbatim
   * down the tunnel — so the same URL shape works on both paths, which is why
   * nothing about relaying needed a special case.
   *
   * **This is the whole of the exception and it must not grow.** A download is
   * the obvious next candidate and it is refused: `download()` above sends the
   * credential in a header, because there a browser *can*. A `?token=` URL sitting
   * in transcript DOM also goes stale inside the 300s token lifetime, and lands
   * in history and in any log that records a URL rather than a path.
   */
  streamUrl(session: string, since: number, token: string, route: Route): string {
    const url = new URL(`/sessions/${encodeURIComponent(session)}/stream`, route.base);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("since", String(since));
    url.searchParams.set("token", token);
    return url.toString();
  }

  /**
   * One session's live socket, on whichever transport this route names.
   *
   * ⚠ **The credential is a query parameter on one arm and not on the other**,
   * and the asymmetry is the improvement rather than an oversight.
   * {@link streamUrl} above is the loopback arm and keeps `?token=` because a
   * browser genuinely cannot set a header on a `WebSocket` handshake — but that
   * URL never leaves this computer. Over the relay the socket is a *frame* inside
   * a channel whose capability was presented once at the handshake, so there is
   * no URL carrying a credential anywhere on that path: not in the app, not at
   * the relay, and not on the daemon's own loopback dial, where `src/e2ee.ts`
   * sends a header because Node can.
   *
   * Returns a {@link StreamSocket} rather than a `WebSocket`, which a real
   * `WebSocket` satisfies structurally — so `stream.ts` keeps its rotation, its
   * `Math.max` cursor, its dedup and its close-code table with one line changed
   * and none of them aware there are two transports.
   */
  openStream(session: string, since: number, token: string, route: Route): StreamSocket {
    if (route.kind === "relay") {
      const path = `/sessions/${encodeURIComponent(session)}/stream?since=${String(since)}`;
      return this.channelFor(route).openSocket(path);
    }
    return new WebSocket(this.streamUrl(session, since, token, route));
  }

  markUnreachable(reason: OfflineReason, detail: string | null = null): void {
    this.reach = "offline";
    this.offlineReason = reason;
    if (detail !== null) this.lastError = detail;
    this.onChange();
  }
}

/**
 * One `XMLHttpRequest`, wrapped into a promise, with a stall budget.
 *
 * Free of `MachineConnection` on purpose: everything policy-shaped — what a
 * failure means, whether to retry, whether the machine is gone — belongs to the
 * three helpers above, and this is only the part of an upload that `fetch`
 * cannot do.
 */
function sendWithProgress(
  url: URL,
  body: Blob,
  token: string,
  onProgress: (fraction: number) => void,
  bounds: { stallMs: number; hardMs: number; signal: AbortSignal },
): Promise<{ status: number; statusText: string; text: string }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let stall: ReturnType<typeof setTimeout> | undefined;

    const fail = (reason: string): void => {
      clear();
      xhr.abort();
      reject(new TypeError(reason));
    };
    const hard = setTimeout(() => fail("upload timed out"), bounds.hardMs);
    const touch = (): void => {
      clearTimeout(stall);
      stall = setTimeout(() => fail("upload stalled"), bounds.stallMs);
    };
    const onAbort = (): void => {
      clear();
      xhr.abort();
      reject(new DOMException("upload cancelled", "AbortError"));
    };
    function clear(): void {
      clearTimeout(hard);
      clearTimeout(stall);
      bounds.signal.removeEventListener("abort", onAbort);
    }

    if (bounds.signal.aborted) {
      clearTimeout(hard);
      reject(new DOMException("upload cancelled", "AbortError"));
      return;
    }
    bounds.signal.addEventListener("abort", onAbort);

    xhr.open("POST", url.toString(), true);
    xhr.setRequestHeader("authorization", `Bearer ${token}`);
    // Deliberately explicit rather than left to the browser: a `Blob` with a
    // type would otherwise set the header itself, and the daemon reads the mime
    // from exactly here.
    xhr.setRequestHeader("content-type", body.type || "application/octet-stream");

    xhr.upload.addEventListener("progress", (event) => {
      touch();
      onProgress(event.lengthComputable && event.total > 0 ? event.loaded / event.total : 0);
    });
    // A request that has been sent and is awaiting an answer is not stalled — the
    // daemon may be writing 25 MiB to disk. The stall budget covers the upload.
    xhr.upload.addEventListener("load", () => clearTimeout(stall));
    xhr.addEventListener("load", () => {
      clear();
      resolve({ status: xhr.status, statusText: xhr.statusText, text: xhr.responseText });
    });
    // Indistinguishable from each other and from a `fetch` rejection, which is
    // exactly what `isTransportFailure` assumes: not an `ApiError`.
    xhr.addEventListener("error", () => fail("upload failed"));
    xhr.addEventListener("timeout", () => fail("upload timed out"));

    touch();
    xhr.send(body);
  });
}

/**
 * Calls whose deadline has to sit above a daemon-side budget.
 *
 * Was called `spawnsAnAgent`, and the rename stands — but not for the reason
 * this docblock used to give. It said "a download spawns nothing and still
 * belongs here", and no download path is in the predicate below: `download()`
 * never calls `request()` at all, and carries `TRANSFER_TIMEOUT_MS` itself. So
 * the sentence justifying the rename was the exact thing its last line warns
 * against, which is why it is corrected here rather than left to be discovered.
 *
 * What is true: every entry below does spawn a process on the daemon, and the
 * name is now about the *deadline* rather than the cause, because transfers are
 * bounded separately — `TRANSFER_TIMEOUT_MS` for a download, `uploadDeadlines`
 * for an upload — and this table only governs routes reached through `request`.
 *
 * A helper whose name claims a property nobody enforces is how the property gets
 * restored by somebody who believes it is still true.
 */
export function slowRoute(method: string | undefined, path: string): boolean {
  const verb = (method ?? "GET").toUpperCase();
  return (
    (verb === "POST" && path === "/sessions") ||
    /*
     * ⚠ **Installing from a commit, because the daemon downloads before it
     * answers.** `source.ts` gives itself 30s to fetch the archive and then
     * unpacks and starts the plugin, so the ordinary 15s budget guarantees the
     * client aborts first on every install that is not instant. That abort is a
     * *transport* failure, so it drops the route memo and draws a perfectly
     * healthy machine as unreachable — over an install that is very likely still
     * succeeding on the far side.
     *
     * `POST /plugins` needs no entry here: it goes through `upload`, which has its
     * own `uploadDeadlines` keyed on the byte count.
     */
    (verb === "POST" && path === "/plugins/source") ||
    /*
     * A prompt, because sending one to a session the daemon interrupted resumes
     * it first — the whole point of "you just go on talking after a deploy".
     *
     * **Unconditionally**, for every prompt, and that is not laziness. `request`
     * is handed a method and a path and nothing else, deliberately: a deadline
     * that depended on session state would be state leaking into the transport,
     * and the transport is the one layer that must not need to know which
     * sessions are alive. The asymmetry pays for it — a deadline that is too
     * long costs a spinner nobody was watching, while one that is too short is a
     * transport failure, and a transport failure here drops the route memo and
     * renders a healthy machine "not reachable" over the message somebody just
     * typed.
     *
     * Safe against the other failure this table guards: `isReplayable` is
     * GET/DELETE only, so a prompt that times out is never resent and cannot
     * start two turns.
     */
    (verb === "POST" && /^\/sessions\/[^/]+\/prompt$/.test(path)) ||
    // Resume is the same launch underneath, and `server.ts` says so — the
    // daemon gives it the full 45s start budget, and this asked for it at 15s.
    // The abort is a *transport* failure, so it dropped the route memo and
    // marked a perfectly healthy machine unreachable for the crime of resuming.
    (verb === "POST" && /^\/sessions\/[^/]+\/resume$/.test(path)) ||
    // Changing model rebuilds the agent's available modes, and the daemon
    // allows itself 15s for that — the *same* number this client used, so the
    // client's own abort always fired first and the daemon's
    // `502 agent_config_failed` was unreachable by construction. A client
    // deadline has to sit above the server's, or the server's error is dead code.
    (verb === "POST" && /^\/sessions\/[^/]+\/config$/.test(path)) ||
    /*
     * The agent-shaped namespaces, all three matched by **prefix**, and that is
     * the correction rather than the convenience.
     *
     * `/agent-auth` was already here and already a prefix, so that a route added
     * under it could not reintroduce the gap by being missed. `/agents` was a
     * literal — and it was a literal when `GET /agents/capabilities` shipped,
     * which is exactly how that route ended up on the ordinary 15s.
     *
     * ⚠ **What 15s bought there.** `/agents` merely runs the login probe;
     * `/agents/capabilities` starts a whole agent per harness. It used to loop
     * them **serially**, because a `Promise.all` was measured making the third
     * harness lose the race against `MAX_CONCURRENT_ASKS` (2) every single time —
     * codex permanently greyed out of the builder with a sentence about load.
     * Four harnesses at `ASK_TIMEOUT_MS` (120s) each, one at a time, is up to 480s
     * of daemon budget behind a client that gave up at 15, so on a cold cache the
     * abort was not a risk but the norm. And the abort is a *transport* failure:
     * `forgetRoute`, then `markUnreachable`, and a perfectly healthy machine is
     * drawn as unreachable everywhere at once — including the New session sheet
     * the builder was opened from. Then, because a `GET` is replayable, the retry
     * fires a second `/agents/capabilities`.
     *
     * ⚠ **The serial loop is gone and this number is not.** The route asks all
     * four at once and `admit` **queues** for a slot instead of refusing one, so
     * the sweep can no longer lose a race against a bound it is itself holding:
     * measured 2026-08-28, 5286 ms serial against 3061 ms queued. The worst case
     * is rounds of two rather than a sum of four, and the replayed `GET` is now
     * served from the ten-minute cache the first attempt filled. 90s still covers
     * it with room, which is the point of the entry rather than of the arithmetic.
     *
     * There is no cheap `GET` under `/agents` and there cannot be one: the only
     * thing that namespace answers is what the installed CLIs say about
     * themselves, and nothing but a CLI can say it. So the prefix is not a guess
     * about future routes, it is the shape of the namespace.
     *
     * ⚠ **`/custom-agents` is keyed on the verb instead, and the split is
     * load-bearing rather than tidy.** Every *write* under it re-validates the
     * pairing with `hostable()` against `asks.capabilities(harness)` — `POST`
     * does, `PATCH` does, and one that did not would be storing a preset whose
     * only button answers 502 days later — so a write there spawns an agent by
     * construction, on the same cached, bounded path. The reads do not:
     * `GET /custom-agents` is `systems.customAgents.list()` and the `DELETE` is
     * a lookup plus a delete, both synchronous SQLite, and both sit on a first
     * paint where 90 seconds of a screen that cannot say anything is worse than
     * 15 and a refusal.
     */
    (verb === "GET" && path.startsWith("/agents")) ||
    path.startsWith("/agent-auth") ||
    ((verb === "POST" || verb === "PATCH") && path.startsWith("/custom-agents")) ||
    // Switching a plugin on forks a child and waits for its `ready`, and the
    // daemon's budget for that is `PLUGIN_START_TIMEOUT_MS` (10s) *after* up to
    // `PLUGIN_STOP_DEADLINE_MS` (4s) waiting out a stop already in flight, plus
    // another 4s stopping it again if it fails: 18s worst case against this
    // client's 15s. Same defect `/config` records one line up, and the same
    // consequence — a `POST` is not replayable, so the abort takes the
    // `forgetRoute` arm and marks a healthy machine unreachable, for the crime of
    // toggling a plugin that was hanging, which is exactly why somebody would.
    (verb === "POST" && /^\/plugins\/[^/]+\/state$/.test(path))
  );
}

export function describe(error: unknown): string {
  if (ApiError.isApiError(error)) return `${error.code}: ${error.message}`;
  if (error instanceof Error) return error.message;
  return String(error);
}
