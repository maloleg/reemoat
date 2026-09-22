import { AgentInstallRuns, INSTALL_RETAIN_MS, readStep, type InstallSink } from "../src/agentinstall.js";
import { AgentScriptGate } from "../src/agentscript.js";
import { MemoryEventStore } from "../src/events.js";
import { SessionRegistry } from "../src/registry.js";
import { check, report } from "./daemoncheck.env.js";
import { now, tokenFor, tokenWith, users, verifier } from "./daemoncheck.fixtures.js";

process.stdout.write("\ninstalling a harness, because somebody asked for it\n");
{
  /* ------------------------------------------------------------------ *
   * The step grammar, from the parser's side
   *
   * ⚠ **`deploycheck` drives the *emitter* against this same function**, which is
   * what keeps the two ends of a private grammar together. Here the subject is
   * what the parser refuses: a stream is being read, and one malformed line must
   * not end a run that is working.
   * ------------------------------------------------------------------ */
  check(
    "a checkpoint parses into an agent and a phase",
    [readStep("step: kimi download"), readStep("  step: grok link  ")],
    [{ agent: "kimi", phase: "download" }, { agent: "grok", phase: "link" }],
  );
  check(
    "and anything that is not one answers null rather than throwing",
    [
      readStep("  kimi          refresh 0.29.2"),
      readStep(""),
      readStep("step: kimi"),
      readStep("step: kimi download extra"),
      // ⚠ An unknown *phase* is refused, or a script that grew a sixth checkpoint
      // would put a string nothing renders onto a client's progress line.
      readStep("step: kimi frobnicate"),
    ],
    [null, null, null, null, null],
  );

  /* ------------------------------------------------------------------ *
   * The gate, from the install side
   * ------------------------------------------------------------------ */
  const gate = new AgentScriptGate();
  check("the gate is free to start with", gate.holder, null);
  check("an update may take it", gate.tryHold("update"), true);
  check("and an install may not, while it is held", gate.tryHold("install", "kimi"), false);
  /*
   * ⚠ **Identity-checked, which is what stops a refused caller releasing the
   * holder's claim.** A `finally` that released unconditionally would hand the
   * gate away on the very path where `tryHold` had just answered `false`.
   */
  gate.release("install");
  check("a release by the caller that did not take it changes nothing", gate.holder?.kind, "update");
  gate.release("update");
  check("while the holder's own release frees it", gate.holder, null);

  /* ------------------------------------------------------------------ *
   * A run: the transcript, the phase, and the verdict
   *
   * The script is stubbed, because what is under test is this daemon's reading of
   * it. `deploycheck` drives the real one.
   * ------------------------------------------------------------------ */
  type Spawned = { sink: InstallSink; killed: boolean; args: readonly string[] };
  const spawns: Spawned[] = [];
  const order: string[] = [];
  let present = true;

  const runsFor = (over: Partial<ConstructorParameters<typeof AgentInstallRuns>[0]> = {}) =>
    new AgentInstallRuns({
      gate: new AgentScriptGate(),
      verify: async (agent) => {
        order.push(`verify:${agent}`);
        return present;
      },
      onFinished: (agent) => {
        order.push(`forget:${agent}`);
      },
      onWarning: () => {},
      spawnScript: (_agent, args, sink) => {
        const entry: Spawned = { sink, killed: false, args };
        spawns.push(entry);
        return {
          kill: () => {
            entry.killed = true;
          },
        };
      },
      ...over,
    });

  {
    const runs = runsFor();
    const started = runs.start("kimi");
    check("a start answers a run view", [started.kind, started.kind === "ok" ? started.view.agent : null], ["ok", "kimi"]);
    /*
     * ⚠ **`--only` *and* `--fail-if-locked`, and the second is not decoration.**
     * The script answers a contended run with `exit 0` and a warning — correct for
     * the three callers that contract it never fails, and indistinguishable here
     * from a run that succeeded with nothing to do. Without the flag this screen
     * would draw somebody else's lock as "installed".
     */
    check(
      "the script is asked for that harness alone, and told to fail on a held lock",
      [spawns[0]?.args.slice(0, 3), spawns[0]?.args.includes("--refresh-only")],
      [["--only", "kimi", "--fail-if-locked"], false],
    );

    const second = runs.start("codex");
    check("a second start while one is running is refused, never superseded", second.kind, "busy");
    check("and nothing was killed to make room for it", spawns[0]?.killed, false);
    check("and no second process was spawned", spawns.length, 1);

    spawns[0]?.sink.append("agents (kimi only; from the npm registry)\nstep: kimi start\n");
    check("the transcript is readable through a cursor", runs.read(started.kind === "ok" ? started.view.installId : "", 0)?.chunk.includes("kimi only"), true);
    check("and the newest checkpoint is the phase", runs.read(started.kind === "ok" ? started.view.installId : "", 0)?.phase, "start");
    /*
     * ⚠ **A partial line is held back**, or `readStep` sees half a checkpoint,
     * answers `null` for a line that was about to parse, and the phase sticks on
     * whatever came before it.
     */
    spawns[0]?.sink.append("step: kimi down");
    check("a half-written checkpoint does not move the phase", runs.read(started.kind === "ok" ? started.view.installId : "", 0)?.phase, "start");
    spawns[0]?.sink.append("load\nstep: kimi install\n");
    check("and the rest of it does", runs.read(started.kind === "ok" ? started.view.installId : "", 0)?.phase, "install");

    /*
     * ⚠ **The verdict, and the whole of why it is not `exit.code`.**
     * `deploy/agents.sh` exits 0 having printed `install failed; this machine has
     * no copy of it until the next run` — it must, since three of its four callers
     * contract it never fails. So the pair below is the assertion: a clean exit
     * and a failed outcome, together. Reading the status would report this as
     * installed.
     */
    present = false;
    order.length = 0;
    spawns[0]?.sink.close({ code: 0, signal: null }, "running");
    await new Promise((r) => setTimeout(r, 0));
    const failedView = runs.live();
    check(
      "a clean exit with the harness still absent is a failure, and says so beside the exit code",
      [failedView?.outcome, failedView?.exit?.code, failedView?.done],
      ["failed", 0, true],
    );
    /*
     * ⚠ **A sequence, not a set.** `findOnPath` caches misses for 30 seconds, so
     * asking the machine *before* the caches are dropped reads the miss recorded
     * when the tile was drawn and calls a successful install a failure. A
     * set-shaped assertion passes on the one ordering that is wrong.
     */
    check("and the caches were dropped before the machine was asked", order, ["forget:kimi", "verify:kimi"]);
  }

  {
    const runs = runsFor();
    spawns.length = 0;
    const started = runs.start("codex");
    const id = started.kind === "ok" ? started.view.installId : "";
    present = true;
    spawns[0]?.sink.close({ code: 0, signal: null }, "running");
    await new Promise((r) => setTimeout(r, 0));
    check("a clean exit with the harness now present is an install", runs.live()?.outcome, "installed");
    /*
     * A finished record is replaced rather than refusing, or somebody stares at a
     * ten-minute-old failure with no way to try again.
     */
    const again = runs.start("codex");
    check("and a start over a finished record is allowed", again.kind, "ok");
    check("while its id is a new one", again.kind === "ok" && again.view.installId !== id, true);
  }

  {
    /*
     * ⚠ **`exit 3` is the one status the script carries a meaning in**, and it is
     * reachable only behind `--fail-if-locked`. It arrives on the *poll* rather
     * than as a start refusal, because by then the `201` has been sent.
     */
    const runs = runsFor();
    spawns.length = 0;
    runs.start("grok");
    spawns[0]?.sink.close({ code: 3, signal: null }, "locked");
    await new Promise((r) => setTimeout(r, 0));
    check("a lock the gate could not see reaches the client as its own outcome", runs.live()?.outcome, "locked");
    // And it did not go and ask the machine: the run installed nothing, so there
    // is nothing to have become true.
    check("and no verdict was taken over it", runs.live()?.exit?.code, 3);
  }

  {
    const runs = runsFor();
    spawns.length = 0;
    const started = runs.start("opencode");
    const id = started.kind === "ok" ? started.view.installId : "";
    check("a run can be cancelled", runs.cancel(id), true);
    check("and the kill reached the script", spawns[0]?.killed, true);
    check("while an id nothing is holding is not found", runs.cancel("in_nope"), false);
    check("and neither is a poll for one", runs.read("in_nope", 0), null);
  }

  {
    /*
     * ⚠ **The TTL runs from the *end*, and copying `LoginRun.expired` here would
     * be a defect with a clock in it.** That one measures from `startedAt` and
     * kills a live pty at ten minutes, which is right for a flow waiting on a
     * person; here it would kill a legitimate download on a slow link at minute
     * ten. A running run is bounded by the script's own deadline and nothing else.
     */
    /*
     * ⚠ **The clock is handed in, because without one this section asserted
     * nothing.** `read()` does not sweep — only `start()` and `live()` do — and
     * both cells below used to read a run created microseconds earlier, so every
     * one of them was true for any implementation. Measured: replacing
     * `expired()` with `now - this.startedAt > INSTALL_RETAIN_MS`, the exact
     * defect the paragraph above names, left `pnpm daemoncheck` reporting all
     * green. The cast is the same one `installs: routeRuns as never` already
     * uses on this class.
     */
    const runs = runsFor();
    spawns.length = 0;
    const started = runs.start("kimi");
    const id = started.kind === "ok" ? started.view.installId : "";
    const clocked = runs as unknown as { sweep: (now: number) => void };
    // Far past the retention, with the run still going: a running install has no
    // `endedAt`, so nothing may sweep it however long it runs.
    clocked.sweep(Date.now() + INSTALL_RETAIN_MS * 3);
    check("a running run survives a sweep, however long it runs", runs.read(id, 0) !== null, true);
    present = true;
    spawns[0]?.sink.close({ code: 0, signal: null }, "running");
    await new Promise((r) => setTimeout(r, 0));
    clocked.sweep(Date.now());
    check("and a finished one is still readable while it is fresh", runs.read(id, 0) !== null, true);
    /*
     * The negative control. Without it both cells above pass over an `expired()`
     * measured from `startedAt` — which is what they did.
     */
    clocked.sweep(Date.now() + INSTALL_RETAIN_MS + 1);
    check("while a finished record ages out past the retention", runs.read(id, 0), null);
  }

  {
    /* ------------------------------------------------------------------ *
     * A Stop, and the two phases it may not land in
     *
     * ⚠ **This is the highest-consequence refusal in the file and it had no
     * assertion at all.** `cancel` SIGKILLs the whole process group, and three of
     * the five harnesses arrive by a vendor installer that writes straight into
     * `~/.local/bin` with no staging — at a path `MANAGED_CLI_DIRS` then hands to
     * the spawn. So a Stop pressed during `install` or `link` left a truncated
     * binary for this daemon to launch as a harness. Both halves are asserted: the
     * bit the client reads *and* that the kill was not sent.
     * ------------------------------------------------------------------ */
    const runs = runsFor();
    spawns.length = 0;
    const started = runs.start("claude");
    const id = started.kind === "ok" ? started.view.installId : "";
    const at = (): { cancellable: boolean | undefined; phase: string | null | undefined } => ({
      cancellable: runs.read(id, 0)?.cancellable,
      phase: runs.read(id, 0)?.phase,
    });
    check("a run with no checkpoint yet may be stopped", at(), { cancellable: true, phase: null });
    spawns[0]?.sink.append("step: claude download\n");
    check("and so may one still fetching into its temporary directory", at(), {
      cancellable: true,
      phase: "download",
    });
    spawns[0]?.sink.append("step: claude install\n");
    check("but not one whose installer is writing outside it", at(), {
      cancellable: false,
      phase: "install",
    });
    check("and the Stop is refused rather than signalled", runs.cancel(id), false);
    check("so nothing was killed", spawns[0]?.killed, false);
    spawns[0]?.sink.append("step: claude link\n");
    check("the repoint is the second refused phase", [at().cancellable, runs.cancel(id), spawns[0]?.killed], [
      false,
      false,
      false,
    ]);
    // `done` and `failed` are printed after the per-agent work returns, so nothing
    // is in flight by then and the refusal lifts rather than sticking.
    spawns[0]?.sink.append("step: claude done\n");
    check("while the phases after the writes are stoppable again", at().cancellable, true);
    check("where the Stop does reach the script", [runs.cancel(id), spawns[0]?.killed], [true, true]);

    order.length = 0;
    present = false;
    spawns[0]?.sink.close({ code: null, signal: "SIGKILL" }, "cancelled");
    await new Promise((r) => setTimeout(r, 0));
    check(
      "a stopped run reports itself cancelled rather than failed",
      [runs.live()?.outcome, runs.live()?.done],
      ["cancelled", true],
    );
    /*
     * ⚠ **And no verdict was taken over it.** `settle` asks the machine only for
     * `running`, the script's ordinary silent end. A cancel that fell through to
     * the probe would answer `failed` for a harness somebody stopped on purpose —
     * and, on a machine that already had it, `installed` for a run that did
     * nothing.
     */
    check("with the caches dropped and the machine not asked", order, ["forget:claude"]);
    check("while a finished record may not be stopped again", [runs.live()?.cancellable, runs.cancel(id)], [
      false,
      false,
    ]);
  }

  {
    /* ------------------------------------------------------------------ *
     * A sink closed twice, which is what a spawn failure actually looks like
     *
     * ⚠ **Node emits both `error` and `close` for a spawn that failed**, so
     * `sink.close` is called twice and `settle` is offered the same run twice. The
     * guard was `if (run.done) return`, and `done` is set by `run.end()` *after*
     * `await onFinished(...)` — so both entries got past it, both ran the caller's
     * invalidation (three cache drops and a resume pass, in `scripts/daemon.ts`),
     * and both released the script gate, the second against a `kind` a new holder
     * may have taken inside that window.
     * ------------------------------------------------------------------ */
    const gate = new AgentScriptGate();
    const runs = runsFor({ gate });
    spawns.length = 0;
    runs.start("kimi");
    check("the install holds the script gate while it runs", [gate.holder?.kind, gate.holder?.agent], [
      "install",
      "kimi",
    ]);
    present = true;
    order.length = 0;
    spawns[0]?.sink.close({ code: null, signal: null }, "spawn_failed");
    spawns[0]?.sink.close({ code: null, signal: null }, "running");
    await new Promise((r) => setTimeout(r, 0));
    check("a run closed twice settles exactly once", order, ["forget:kimi"]);
    check("with the first close's outcome, not the second's", runs.live()?.outcome, "spawn_failed");
    check("and the gate given back", gate.holder, null);
    const next = runs.start("codex");
    check("so the next install can take it", [next.kind, gate.holder?.agent], ["ok", "codex"]);
    /*
     * The consequence, from the end that hurts: a late close on the run that has
     * already ended may not release the hold the *next* install is standing on.
     */
    spawns[0]?.sink.close({ code: 0, signal: null }, "running");
    await new Promise((r) => setTimeout(r, 0));
    check("while a late close on the old run leaves the new hold alone", gate.holder?.agent, "codex");
  }

  {
    /* ------------------------------------------------------------------ *
     * A spawn that throws — the `spawn_failed` start arm
     *
     * ⚠ **The release in that `catch` is the highest-consequence line in
     * `agentinstall.ts` and nothing drove it.** Dropped, `AgentScriptGate` stays
     * held for the life of the process: every later install *and* every daily
     * `--refresh-only` tick yields for ever, and this driver stayed green because
     * the happy-path release is only covered indirectly. So the refusal and the
     * free gate are asserted as a pair.
     * ------------------------------------------------------------------ */
    const gate = new AgentScriptGate();
    spawns.length = 0;
    const runs = runsFor({
      gate,
      spawnScript: () => {
        throw new Error("spawn deploy/agents.sh ENOENT");
      },
    });
    const refused = runs.start("kimi");
    check(
      "a spawn that throws is a refusal carrying what threw",
      [refused.kind, refused.kind === "spawn_failed" ? refused.detail : null],
      ["spawn_failed", "spawn deploy/agents.sh ENOENT"],
    );
    check("and the gate it had already taken is handed back", gate.holder, null);
    check("so the next run is not locked out for the life of the process", gate.tryHold("update"), true);
    gate.release("update");
    check("while this daemon is holding no run it could report", runs.live(), null);
    check("and nothing was spawned to poll", spawns.length, 0);
  }

  {
    /* ------------------------------------------------------------------ *
     * Shutdown, and the start that arrives after it
     *
     * `shutdown()` deliberately leaves a run in flight alone — it writes into the
     * vendors' own directories, and the daemon going away is not licence to
     * abandon that halfway. What it does refuse is a *new* one, and the refusal
     * must not take the gate on its way out.
     * ------------------------------------------------------------------ */
    const gate = new AgentScriptGate();
    spawns.length = 0;
    const runs = runsFor({ gate });
    runs.shutdown();
    const after = runs.start("kimi");
    check(
      "a start after shutdown is refused with a sentence rather than a spawn",
      [after.kind, after.kind === "spawn_failed" ? after.detail : null],
      ["spawn_failed", "this daemon is shutting down"],
    );
    check("and it took no gate on its way out", gate.holder, null);
    check("nor spawned anything", spawns.length, 0);
  }

  {
    /* ------------------------------------------------------------------ *
     * One carry per stream
     *
     * ⚠ **`deploy/agents.sh` writes `step:`, `say` and `note` on stdout and `warn`
     * on stderr, so any run that warns interleaves the two.** With one shared
     * held-back partial line, a stderr write delivered between two stdout chunks
     * spliced the halves of a checkpoint together: `readStep` then answered `null`
     * for a line that was about to parse, the progress indicator stuck on the
     * previous phase, and the transcript showed one line that was two.
     * ------------------------------------------------------------------ */
    const runs = runsFor();
    spawns.length = 0;
    const started = runs.start("grok");
    const id = started.kind === "ok" ? started.view.installId : "";
    const sink = spawns[0]?.sink;
    sink?.append("step: grok dow", "stdout");
    sink?.append("  grok         install failed; this machine has no copy of it\n", "stderr");
    sink?.append("nload\n", "stdout");
    check("a warning between the halves of a checkpoint does not splice them", runs.read(id, 0)?.phase, "download");
    const text = runs.read(id, 0)?.chunk ?? "";
    check(
      "and each stream's line is whole in the transcript",
      [text.includes("step: grok download\n"), text.includes("no copy of it\n")],
      [true, true],
    );
  }

  {
    /* ------------------------------------------------------------------ *
     * The 64 KiB ceiling, including the half that is easy to lose
     *
     * ⚠ **The cap runs after *every* mutation, the carry flush included.** It was
     * written out twice, identically, in `append` and in `flushCarry` — the shape
     * that lets one copy drift — and is one private method now. The second cell is
     * the one with no other symptom: a chunk with no newline in it at all sits in
     * the carry until the close, and a cap applied only to the appended text lets
     * the buffer end up over the ceiling by the whole of it.
     * ------------------------------------------------------------------ */
    const runs = runsFor();
    spawns.length = 0;
    const started = runs.start("kimi");
    const id = started.kind === "ok" ? started.view.installId : "";
    const held = (): number => {
      const view = runs.read(id, 0);
      return (view?.cursor ?? 0) - (view?.dropped ?? 0);
    };
    spawns[0]?.sink.append(`${"x".repeat(70 * 1024)}\n`);
    report("the transcript is held under its ceiling", held() <= 64 * 1024, `${String(held())} bytes`);
    check("with the front dropped rather than the tail", runs.read(id, 0)?.dropped !== 0, true);
    spawns[0]?.sink.append("y".repeat(70 * 1024));
    report("and a held partial line is not counted in yet", held() <= 64 * 1024, `${String(held())} bytes`);
    present = true;
    spawns[0]?.sink.close({ code: 0, signal: null }, "running");
    await new Promise((r) => setTimeout(r, 0));
    report("nor over it once the flush has run", held() <= 64 * 1024, `${String(held())} bytes`);
  }

  /* ------------------------------------------------------------------ *
   * The routes
   * ------------------------------------------------------------------ */
  const { createApp: build } = await import("../src/server.js");
  spawns.length = 0;
  const routeRuns = runsFor();
  const withInstalls = build({
    registry: new SessionRegistry(new MemoryEventStore()),
    verifier,
    instanceId: "i_install",
    startedAt: now,
    installs: routeRuns as never,
    roots: [users],
  }).app;
  const without = build({
    registry: new SessionRegistry(new MemoryEventStore()),
    verifier,
    instanceId: "i_noinstall",
    startedAt: now,
    roots: [users],
  }).app;

  const call = async (
    which: typeof withInstalls,
    method: string,
    path: string,
    token: string = tokenFor("u_alice"),
  ): Promise<{ status: number; body: any }> => {
    const response = await which.fetch(
      new Request(`http://d${path}`, { method, headers: { authorization: `Bearer ${token}` } }),
    );
    const text = await response.text();
    return { status: response.status, body: text.length > 0 ? JSON.parse(text) : null };
  };
  const answered = (one: { status: number; body: any }): [number, string | null] => [
    one.status,
    one.body?.error?.code ?? null,
  ];

  /*
   * ⚠ **`installable: false` and `503 install_unsupported` are asserted as a
   * pair**, because separately either one looks fine. A daemon that refuses the
   * route while its rows say the harness is installable is a button that answers
   * 503 — the defect `loginSupported` already exists to prevent, arriving a second
   * time by a different door.
   */
  const rows = await call(without, "GET", "/agents");
  /*
   * ⚠ **The corpus is reported, because `?? []` and `.every()` agree on an empty
   * list.** As written this answered `true` for a renamed field, a non-200 body,
   * or a route that returned no rows at all — the sibling driver states the rule
   * verbatim: "an unreadable `case` gives an empty list, and an empty list passes
   * a subset comparison in either direction while asserting nothing."
   */
  const listed = (rows.body?.agents ?? []) as { installable?: boolean }[];
  report("the listing route answered with rows at all", listed.length > 0, `${String(listed.length)} rows`);
  check(
    "with no install store, no row is installable",
    [rows.status, listed.filter((one) => one.installable !== false).length],
    [200, 0],
  );
  check("and the route refuses rather than pretending", answered(await call(without, "POST", "/agent-install/kimi")), [503, "install_unsupported"]);
  check("and says so on the listing route too", (await call(without, "GET", "/agent-install")).body?.supported, false);

  /*
   * ⚠ **`installable` is a strict subset of `!available`, and this is where that
   * is pinned.** `AgentUnavailableError` is thrown for four absences and
   * `deploy/agents.sh` repairs exactly one — a built-in's CLI missing from PATH
   * and `MANAGED_CLI_DIRS`. Read as a synonym for `!available` it would put an
   * Install button in front of a missing ACP adapter (a `pnpm install` problem on
   * this checkout), an unknown id, and a harness a plugin added but ships no
   * binary for — whose own refusal sentence says *"which does not install it"*.
   *
   * Driven against the error rather than the row, because that is where the bit
   * lives and `availability()` is only the thing that forwards it.
   */
  {
    const { AgentUnavailableError, resolveAgent } = await import("../src/acp/agents.js");
    const refusalFor = (id: string, machine?: unknown): { message: string; installable: boolean } => {
      try {
        resolveAgent(id, machine as never);
        return { message: "", installable: false };
      } catch (error) {
        return {
          message: error instanceof Error ? error.message : String(error),
          installable: error instanceof AgentUnavailableError && error.installable,
        };
      }
    };
    const contributed = {
      harness: (id: string) =>
        id === "acme:gemini"
          ? {
              id,
              name: "Gemini",
              pluginId: "acme",
              pluginName: "Acme",
              command: "a-binary-that-is-not-here",
              args: [],
            }
          : null,
      harnessIds: () => ["acme:gemini"],
    };
    check(
      "a harness a plugin added is never offered an install, however absent it is",
      refusalFor("acme:gemini", contributed).installable,
      false,
    );
    check("and neither is an id nothing has heard of", refusalFor("not-an-agent").installable, false);
  }

  check("an unknown harness is refused by name", answered(await call(withInstalls, "POST", "/agent-install/gemini")), [400, "invalid_agent"]);
  /*
   * ⚠ **`machine:admin` on the writes, and the precedent is `POST /plugins`.**
   * Putting new programs on somebody's machine is an act on the machine, not on a
   * session — a grant that can drive every session on a host all day may not
   * download and execute a vendor's installer as that uid.
   */
  const driver = tokenWith("u_bob", ["session:read", "session:write"]);
  check("a session grant may not start one", answered(await call(withInstalls, "POST", "/agent-install/kimi", driver)), [403, "insufficient_scope"]);
  check("nor cancel one", answered(await call(withInstalls, "DELETE", "/agent-install/runs/in_x", driver)), [403, "insufficient_scope"]);
  // The poll carries a vendor installer's output and a version, and no secret —
  // unlike a login transcript, which carries a one-time code.
  const polled = await call(withInstalls, "GET", "/agent-install/runs/in_nope", driver);
  check("while reading one needs only a session grant", answered(polled), [404, "install_not_found"]);

  const created = await call(withInstalls, "POST", "/agent-install/kimi");
  check("a start answers 201 with the run", [created.status, created.body?.agent, created.body?.done], [201, "kimi", false]);
  const liveId = created.body?.installId ?? "";
  check("and the listing route hands it back to a client that lost the id", (await call(withInstalls, "GET", "/agent-install")).body?.run?.installId, liveId);
  check("a second start is a conflict that will pass, naming who has it", answered(await call(withInstalls, "POST", "/agent-install/codex")), [409, "install_busy"]);
  check("and the refusal says which run", (await call(withInstalls, "POST", "/agent-install/codex")).body?.error?.detail?.kind, "install");

  spawns.at(-1)?.sink.append("step: kimi start\nagents (kimi only)\n");
  const chunk = await call(withInstalls, "GET", `/agent-install/runs/${liveId}?since=0`);
  check("a poll returns the transcript from the cursor", [chunk.status, chunk.body?.gap, chunk.body?.chunk.includes("kimi only")], [200, false, true]);
  const tail = await call(withInstalls, "GET", `/agent-install/runs/${liveId}?since=${chunk.body?.cursor}`);
  check("and a poll from the end returns nothing new", [tail.body?.chunk, tail.body?.gap], ["", false]);
  check("a cancel is admin's, and frees the slot", (await call(withInstalls, "DELETE", `/agent-install/runs/${liveId}`)).body?.cancelled, true);

  report("the install routes were driven with no agent on the machine", spawns.length > 0, `${spawns.length} stubbed run(s)`);
}
