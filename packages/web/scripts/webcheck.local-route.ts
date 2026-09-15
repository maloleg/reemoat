import { readFileSync } from "node:fs";
import { check, report, storage } from "./webcheck.env.js";
import { stripComments } from "./webcheck.source.js";

/* ------------------------------------------------------------------ *
 * The path that does not go through the relay
 *
 * **Everything this drives is one field and one candidate**, and that is the
 * point of driving it: `Route` grew a `kind`, `probeRoute` grew a first candidate
 * and `settleAnswer` grew a rule that may only fire on one of the two arms.
 * Nothing above `MachineConnection` changed, so nothing above it can notice a
 * regression here — a local route that silently stops being offered looks exactly
 * like a fleet that is working, only slower, and one that keeps being offered
 * after the daemon on this computer became a different machine looks like an app
 * that cannot reach a machine it can plainly see.
 *
 * The harness is `webcheck.stream-and-http.ts`'s: stub `globalThis.fetch`, drive a
 * real connection. The shell is installed and removed around the sections that
 * need it — `inNativeShell()` reads the injected global on *every* call, which is
 * `telegram.ts`'s `proxy()` idiom and is what makes both arms reachable in one
 * process without re-importing anything.
 * ------------------------------------------------------------------ */

process.stdout.write("\nthe local route, and the browser that may never take it\n");

const LOCAL = "http://127.0.0.1:7887";
const RELAY = "https://r1.example";

/** What `host_local_daemon` will answer. `null` is "no daemon on this computer". */
let announced: { machineId: string; base: string; instanceId: string } | null = null;

type Shell = { core: { invoke: (command: string, args?: unknown) => Promise<unknown> } };

/**
 * The bridge, to the extent this section needs one.
 *
 * ⚠ **`host_cp` has to be here even though nothing in this file is about the
 * control plane.** In the shell `cp.ts` sends every `/v1` request through the host
 * rather than through `fetch`, so a stub that answered only `host_local_daemon`
 * would fail the token mint — and a connection with no token never reaches a route
 * candidate at all, which reads as "the local arm is broken" for a reason that has
 * nothing to do with it. It is routed back through the same `globalThis.fetch`
 * stub, so each section still describes its fleet in one place.
 */
function installShell(): void {
  (globalThis as unknown as { window: { __TAURI__?: Shell } }).window.__TAURI__ = {
    core: {
      invoke: async (command: string, args?: unknown): Promise<unknown> => {
        if (command === "host_local_daemon") return announced;
        if (command === "host_credential_set" || command === "host_credential_clear") return null;
        if (command === "host_cp") {
          const request = (args as { req: { path: string; method: string; body: string | null } }).req;
          const answer = await globalThis.fetch(request.path, {
            method: request.method,
            body: request.body,
          });
          return { status: answer.status, statusText: answer.statusText, body: await answer.text() };
        }
        throw new TypeError(`unexpected command ${command}`);
      },
    },
  };
}

function removeShell(): void {
  delete (globalThis as unknown as { window: { __TAURI__?: Shell } }).window.__TAURI__;
}

/** Every URL the client asked for, in order, so a probe nobody wanted is visible. */
let asked: string[] = [];

interface Answers {
  /** What `/fs/roots` on loopback answers. A number is a bare status. */
  roots: number | { status: number; code: string };
  /** Whether the relay holds a tunnel. */
  relayUp?: boolean;
}

function stubFetch(answers: Answers): () => void {
  const real = globalThis.fetch;
  asked = [];
  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    if (url === "/v1/tokens") {
      const now = Date.now();
      return json({
        token: "jws-1",
        expiresAt: now + 300_000,
        serverTime: now,
        machine: { relayUrl: RELAY, relayOnline: answers.relayUp !== false },
      });
    }
    asked.push(url);
    if (url.startsWith(LOCAL)) {
      if (url.endsWith("/health")) return json({ ok: true, instanceId: "i_x", authMode: "signed" });
      const answer = answers.roots;
      if (typeof answer === "number") return json({ roots: [] }, answer);
      return json({ error: { code: answer.code, message: answer.code } }, answer.status);
    }
    if (url.endsWith("/health")) return json({ ok: true, instanceId: "i_relay" });
    return json({ sessions: [] });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = real;
  };
}

async function connect(id: string) {
  const cp = await import("../src/cp.js");
  const { MachineConnection } = await import("../src/machine.js");
  cp.setSession("rs_local");
  return new MachineConnection(
    { id, name: "laptop", relayUrl: RELAY, relayOnline: true, enrolled: true, owned: true, scopes: [] } as never,
    () => {},
  );
}

/* ------------------------------------------------------------------ *
 * A browser never touches loopback, and that is structural
 * ------------------------------------------------------------------ */
{
  /*
   * ⚠ **The arm is dead in a browser rather than merely unused**, and the check is
   * that nothing tries. A page served over `https:` cannot reach `http://127.0.0.1`
   * at all — mixed content, refused before a byte leaves — so a browser build that
   * probed would spend a request per route resolution to learn nothing, on the
   * phone this client is shaped around. `inNativeShell()` is the whole gate and it
   * lives in `localRoute.ts`, one module away from the router.
   */
  removeShell();
  announced = { machineId: "m_1", base: LOCAL, instanceId: "i_x" };
  const restore = stubFetch({ roots: 200 });
  const connection = await connect("m_1");
  const route = await connection.resolveRoute();
  check("a browser settles on the relay", [route?.base, route?.kind], [RELAY, "relay"]);
  check(
    "and asked loopback nothing at all",
    asked.filter((url) => url.startsWith(LOCAL)),
    [],
  );
  restore();
}

/* ------------------------------------------------------------------ *
 * In the shell, an announced daemon that proves itself is the route
 * ------------------------------------------------------------------ */
{
  installShell();
  announced = { machineId: "m_2", base: LOCAL, instanceId: "i_x" };
  const restore = stubFetch({ roots: 200 });
  const connection = await connect("m_2");
  const route = await connection.resolveRoute();
  check("the app takes the local path", [route?.base, route?.kind], [LOCAL, "local"]);
  /*
   * The order is the assertion. `/fs/roots` carries the credential and settles
   * *which machine this is*; `/health` is unauthenticated and therefore proves
   * nothing, so it is asked afterwards or it would be a stranger's 200.
   */
  check(
    "having proved it with a credential before believing anything unauthenticated",
    asked.map((url) => url.slice(LOCAL.length)),
    ["/fs/roots", "/health"],
  );
  restore();
}

/* ------------------------------------------------------------------ *
 * Which refusals are proof, and which are not
 * ------------------------------------------------------------------ */
{
  /*
   * ⚠ **Any status but 401 is proof, and requiring 200 is the bug this prevents.**
   * `src/server.ts` mounts authentication above every route and authorization per
   * route below it, so a `403 insufficient_scope` from a read-only grant and a bare
   * 404 from a daemon older than a route are both answers from *after* the gate —
   * which means the signature, the issuer, the audience and the window all passed.
   * That is the whole identity claim. A client that insisted on 200 would refuse to
   * use a local daemon over a scope it never needed for the probe.
   */
  installShell();
  for (const [what, roots] of [
    ["a 403 about a scope", { status: 403, code: "insufficient_scope" }],
    ["a 404 from an older daemon", { status: 404, code: "http_404" }],
  ] as const) {
    announced = { machineId: "m_3", base: LOCAL, instanceId: "i_x" };
    const restore = stubFetch({ roots });
    const connection = await connect("m_3");
    const route = await connection.resolveRoute();
    check(`${what} still establishes the machine`, route?.kind, "local");
    restore();
  }

  /*
   * And the one that is not. `wrong_machine` is the only code `src/auth.ts` answers
   * when the audience names another machine, so from loopback it means the
   * announcement is stale — a daemon re-enrolled, or a second one took the port.
   */
  announced = { machineId: "m_4", base: LOCAL, instanceId: "i_x" };
  const restore = stubFetch({ roots: { status: 401, code: "wrong_machine" } });
  const connection = await connect("m_4");
  const route = await connection.resolveRoute();
  check("but a wrong_machine refusal is not", [route?.base, route?.kind], [RELAY, "relay"]);

  /*
   * **Sticky, and that is about cost rather than about correctness.** Route
   * resolution runs on a wake and on the fifteen-second offline retry, so without
   * the memo a machine that is simply shut earns an authenticated loopback request
   * every fifteen seconds for as long as the app is open.
   */
  connection.forgetRoute();
  const before = asked.filter((url) => url.startsWith(LOCAL)).length;
  await connection.resolveRoute();
  check(
    "and it is not asked again in the same session",
    asked.filter((url) => url.startsWith(LOCAL)).length,
    before,
  );

  /*
   * Until the next wake. `store.ts`'s `runResume` calls `update` per machine, which
   * is the cadence at which a re-enrolled or restarted daemon should be re-tested —
   * so this recovers without a reload.
   */
  connection.update({
    id: "m_4",
    name: "laptop",
    relayUrl: RELAY,
    relayOnline: true,
    enrolled: true,
    owned: true,
    scopes: [],
  } as never);
  connection.forgetRoute();
  await connection.resolveRoute();
  report(
    "a wake asks loopback again",
    asked.filter((url) => url.startsWith(LOCAL)).length > before,
    `loopback calls: ${asked.filter((url) => url.startsWith(LOCAL)).length}`,
  );
  restore();
}

/* ------------------------------------------------------------------ *
 * A route that goes stale under a live request gives itself up
 * ------------------------------------------------------------------ */
{
  installShell();
  announced = { machineId: "m_5", base: LOCAL, instanceId: "i_x" };
  let roots: number | { status: number; code: string } = 200;
  const real = globalThis.fetch;
  const calls: string[] = [];
  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    if (url === "/v1/tokens") {
      const now = Date.now();
      return json({
        token: "jws-1",
        expiresAt: now + 300_000,
        serverTime: now,
        machine: { relayUrl: RELAY, relayOnline: true },
      });
    }
    calls.push(url);
    if (url.startsWith(LOCAL)) {
      if (url.endsWith("/health")) return json({ ok: true, instanceId: "i_x", authMode: "signed" });
      if (typeof roots === "number") return json({ roots: [] }, roots);
      return json({ error: { code: roots.code, message: roots.code } }, roots.status);
    }
    return json({ sessions: ["from the relay"] });
  }) as typeof fetch;

  const connection = await connect("m_5");
  check("it starts local", (await connection.resolveRoute())?.kind, "local");

  /*
   * The daemon is replaced under the app — the case the memo above cannot reach,
   * because the route is already settled and no probe runs before a request. The
   * refusal has to be read *in flight*, the local arm dropped, and the request
   * retried on the relay so the person never sees it.
   *
   * ⚠ Retrying a `POST` is safe here and nowhere else: `wrong_machine` comes from
   * the middleware above every route, so no handler ran.
   */
  roots = { status: 401, code: "wrong_machine" };
  const answer = await connection.request<{ sessions: string[] }>("/fs/roots", { method: "POST" });
  check("a stale route repairs itself mid-request", answer.sessions, ["from the relay"]);
  check("landing on the relay", connection.currentRoute()?.kind, "relay");

  globalThis.fetch = real;
  removeShell();
}

/* ------------------------------------------------------------------ *
 * The switch, and what it is stored as
 * ------------------------------------------------------------------ */
{
  installShell();
  const { localOff, setLocalOff, localAnnouncedFor, localBaseFor } = await import("../src/localRoute.js");
  announced = { machineId: "m_6", base: LOCAL, instanceId: "i_x" };

  check("a machine nobody has touched is on", localOff("m_6"), false);
  check("and has a local base", await localBaseFor("m_6"), LOCAL);

  setLocalOff("m_6", true);
  check("switching it off is remembered", localOff("m_6"), true);
  check("and takes the base away", await localBaseFor("m_6"), null);
  /*
   * ⚠ **The two nulls Settings has to tell apart.** "No daemon announced itself"
   * and "you switched it off" are the same absence to the router and must never be
   * the same sentence on the screen, which is the whole reason there are two
   * functions rather than one with a flag.
   */
  check("while the announcement itself is still there to say so", await localAnnouncedFor("m_6"), LOCAL);

  check(
    "it is stored as the off list rather than as every machine",
    storage.get("reemoat.localDaemons"),
    '{"off":["m_6"]}',
  );
  setLocalOff("m_6", false);
  check("and switching it back leaves nothing behind", storage.get("reemoat.localDaemons"), '{"off":[]}');

  // A daemon that announced a *different* machine is not this one, however healthy.
  announced = { machineId: "m_other", base: LOCAL, instanceId: "i_x" };
  check("an announcement for another machine is not an answer", await localBaseFor("m_6"), null);

  announced = null;
  check("and no announcement at all is the ordinary case", await localBaseFor("m_6"), null);
  removeShell();
}

/* ------------------------------------------------------------------ *
 * The rules that are easier to read off disk than to drive
 * ------------------------------------------------------------------ */
{
  const machine = stripComments(readFileSync(new URL("../src/machine.ts", import.meta.url), "utf8"));

  /*
   * ⚠ **The guard is the tag, not the predicate.** `meansWrongMachine` alone would
   * apply the drop to the relay arm too — where the relay has already derived the
   * machine from the same verified `aud` before a byte moved, so the code would
   * mean two services disagreeing about one fact rather than "reach it the other
   * way". Asserted off the source because a driver cannot make a relay send it.
   */
  check(
    "the mid-request drop is guarded on the local tag",
    /this\.chosen\?\.kind === "local" && meansWrongMachine\(error\)/.test(machine),
    true,
  );

  /*
   * ⚠ **`forgetRoute` is not what gives the local arm up**, and calling it would be
   * a loop: it drops the memo, and the very next `resolveRoute` probes loopback
   * again, for ever. `denyLocal` is the one that also stops asking.
   */
  check("and it is denyLocal rather than forgetRoute that runs", /denyLocal\(\);\s*\n\s*if \(firstAttempt\)/.test(machine), true);

  /*
   * The loopback candidate has to sit **above** the `relayOnline` check. Below it,
   * a laptop whose tunnel is down — the machine this whole feature is for, three
   * feet away and running — never reaches the candidate at all.
   */
  /*
   * ⚠ **The switch is drawn where an unreachable machine can still reach it**, and
   * it shipped once inside the gate that hides everything read *from* the daemon.
   * That gate is `listable = machine.enrolled && read === "readable"`, and the state
   * it excludes — tunnel down, relay down, control plane unreachable — is the exact
   * state where a daemon three feet away is still answering on loopback. Hidden
   * there, the one control that repairs the screen disappears when it would have
   * worked. Asserted by position because nothing typed can hold a placement, the
   * same reason the plugin settings screen is pinned that way.
   */
  const section = readFileSync(
    new URL("../src/ui/settings/MachineSection.tsx", import.meta.url),
    "utf8",
  );
  const gateOpens = section.indexOf("{listable ? (");
  /*
   * The ternary's own close, found by indentation: everything inside it is nested
   * deeper, so the first `)}` back at this JSX level is where it ends. Cheaper and
   * less brittle than matching brackets, and it fails loudly rather than quietly if
   * the file is ever reformatted.
   */
  const gateCloses = section.indexOf("\n      )}", gateOpens);
  const drawn = section.indexOf("<LocalPath ");
  report(
    "the local-path switch survives a machine reading unreachable",
    gateOpens > 0 && gateCloses > gateOpens && drawn > gateCloses,
    `gate ${gateOpens}..${gateCloses}, drawn at ${drawn}`,
  );

  const localAt = machine.indexOf("localBaseFor(this.id)");
  const relayAt = machine.indexOf("this.relayOnline ? this.relayUrl : null");
  report(
    "and the candidate is tried above the control plane's own opinion",
    localAt > 0 && relayAt > 0 && localAt < relayAt,
    `local at ${localAt}, relayOnline at ${relayAt}`,
  );
}

/* ------------------------------------------------------------------ *
 * Which machine is *this* one, and why that is not the route
 *
 * ⚠ **The 2026-09-15 reversal's other half.** The machine this app sets up is
 * labelled after the computer now, like every other machine, because that label
 * is read by a phone and by every other client of the account. What is left
 * saying "you are sitting at this one" is a badge, and the badge needs a fact
 * that is true per client: the announce file, which is what `localDaemon` reads.
 *
 * Driven above for the value (`localAnnouncedFor` against a stubbed
 * `host_local_daemon`); asserted off disk here for the two wirings a value test
 * cannot see — where the store gets it from, and when it asks again.
 * ------------------------------------------------------------------ */
{
  const store = stripComments(readFileSync(new URL("../src/store.ts", import.meta.url), "utf8"));

  check("the store keeps which machine this computer is", /localMachineId: MachineId \| null;/.test(store), true);
  check("and fills it from the daemon's announce file", /const found = await localDaemon\(\);/.test(store), true);

  /*
   * ⚠ **Not `route.kind === "local"`, and this is a negative on purpose.** The
   * route is a *preference*: `setLocalOff` turns the loopback path off per machine
   * (driven two sections up), and a badge keyed on it would vanish from the
   * machine somebody is sitting at the moment they chose the relay. Identity and
   * reachability are the same file read and two different questions.
   */
  const refresher = /private async refreshLocalMachine\(\)[\s\S]*?\n  \}/.exec(store)?.[0] ?? "";
  check("refreshLocalMachine was found to read", refresher.length > 0, true);
  check("and it never consults the routing preference", /localOff|localBaseFor|kind === "local"/.test(refresher), false);

  /*
   * ⚠ **A memo, where `localBaseFor` refuses one — so *when* it is refreshed is
   * the whole of its correctness.** `runResume` is the funnel every wake, every
   * machine mutation (`machinesChanged`) and the bootstrap promotion already pass
   * through. Asked anywhere narrower and a daemon that starts *after* the app — on
   * a laptop where both come up at login, the ordinary case — is never badged.
   */
  const resume = /private async runResume\([\s\S]*?\n    this\.patch\(\{ resuming: true \}\);[\s\S]{0,400}/.exec(store)?.[0] ?? "";
  check("and the resume funnel is what asks again", /await this\.refreshLocalMachine\(\);/.test(resume), true);
}
