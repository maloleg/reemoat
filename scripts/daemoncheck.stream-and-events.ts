import type { Server } from "node:http";
import { PassThrough } from "node:stream";
import { connect as netConnect, type AddressInfo } from "node:net";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { WebSocket } from "ws";
import { MemoryEventStore, estimateBytes, truncateEvent, type ToolCallEvent } from "../src/events.js";
import { toolCallLineage } from "../src/acp/subagents.js";
import { splitAsyncTaskUpdates } from "../src/acp/client.js";
import { SessionRegistry } from "../src/registry.js";
import { EVENTS_PAGE_LIMIT, createApp } from "../src/server.js";
import { openStores } from "../src/store/sqlite.js";
import { check, report } from "./daemoncheck.env.js";
import {
  sandbox,
  users,
  now,
  tokenFor,
  verifier,
  storeOf,
  rowFor,
  registry,
  credentials,
  app,
  injectWebSocket,
  get,
} from "./daemoncheck.fixtures.js";

/* ------------------------------------------------------------------ *
 * The stream, over a real socket
 * ------------------------------------------------------------------ */

/**
 * The one route that cannot be checked with `app.fetch`.
 *
 * `upgradeWebSocket`'s handler only runs for an actual upgrade; a plain request
 * falls through and Hono answers 404 — for a real session id exactly as much as
 * for a made-up one. So any assertion built on `app.fetch` here was true no
 * matter what the handler did, and this route is the one that hands out a live
 * transcript feed. A real listener and a real `ws://` client is the only way to
 * tell the two 404s apart, and `relaycheck` already proves the technique works in
 * this repo.
 */
process.stdout.write("\nthe stream, over a real socket\n");

const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
// The same cast `scripts/daemon.ts` makes: `serve` is typed as possibly
// returning an Http2Server, and `injectWebSocket` wants the http one.
injectWebSocket(server as unknown as Server);
await new Promise<void>((resolve) => server.once("listening", resolve));
const { port } = server.address() as AddressInfo;

/** Resolves how the socket ended: open with a frame, or refused. */
function attach(sessionId: string, sub: string): Promise<string> {
  return new Promise((resolve) => {
    const socket = new WebSocket(
      `ws://127.0.0.1:${port}/sessions/${sessionId}/stream?token=${tokenFor(sub)}`,
    );
    const done = (answer: string): void => {
      try {
        socket.close();
      } catch {
        // Already closing; the answer is what matters.
      }
      resolve(answer);
    };
    socket.on("message", () => done("frame"));
    socket.on("error", () => done("refused"));
    socket.on("unexpected-response", () => done("refused"));
    socket.on("close", () => resolve("closed"));
    setTimeout(() => done("silent"), 2_000);
  });
}

/**
 * Every frame one attach delivers, in order, up to and including `caught_up`.
 *
 * One function with two call sites rather than the same promise written twice,
 * because the two attach cases below differ only in which log they are pointed
 * at and what they are both measuring is the frame *sequence* — a collector that
 * drifted between them would have the two cases describing different protocols
 * while both stayed green. `port` is a parameter because the second case needs a
 * registry whose store evicts, which means its own app and its own listener.
 */
function streamFrames(
  atPort: number,
  sessionId: string,
  sub: string,
  since: number,
  /**
   * Filled with each message's raw byte length, index-aligned with the frames.
   *
   * ⚠ **Optional, because the byte count is a different subject from the frame
   * sequence.** Only the batch-ceiling section below asks for it, and the number
   * has to be taken HERE — `JSON.stringify(frame)` re-serialised at the call site
   * is not the bytes that crossed, and the whole defect this measures was an
   * estimate standing in for the bytes that crossed.
   */
  sizes?: number[],
): Promise<Record<string, any>[]> {
  return new Promise((resolve) => {
    const out: Record<string, any>[] = [];
    const socket = new WebSocket(
      `ws://127.0.0.1:${atPort}/sessions/${sessionId}/stream?since=${since}&token=${tokenFor(sub)}`,
    );
    const done = (): void => {
      try {
        socket.close();
      } catch {
        // Already closing; what arrived is the answer.
      }
      resolve(out);
    };
    socket.on("message", (data: Buffer) => {
      let frame: Record<string, any>;
      try {
        frame = JSON.parse(String(data));
      } catch {
        return;
      }
      out.push(frame);
      sizes?.push(data.length);
      if (frame["type"] === "caught_up") done();
    });
    socket.on("error", done);
    setTimeout(done, 5_000);
  });
}

check("attaching to a real session opens and delivers", await attach("s_one", "u_alice"), "frame");
check("an id that exists nowhere is refused, over a real upgrade", await attach("s_nope", "u_alice"), "refused");

/* -- a request target the URL parser rejects ---------------------------- */

{
  /*
   * ⚠ **llhttp and the WHATWG URL parser disagree about what a request target
   * is**, and `@hono/node-ws`'s upgrade handler opens with an unguarded `new
   * URL(request.url ?? "/", "http://localhost")`. `GET //% HTTP/1.1` is accepted
   * by Node's HTTP parser and handed over verbatim; `new URL("//%", …)` throws.
   * Nothing then writes to the socket or destroys it — `requestTimeout` is
   * already cleared and `keepAliveTimeout` only arms once a response is sent —
   * so it is one leaked fd per line.
   *
   * Reachable through the relay with any token for this machine, because
   * `relay/proxy.ts`'s `readToken` reads the `Authorization` header *without*
   * touching the URL and then forwards `path: req.url` unchanged. That file
   * carries this exact guard, with a comment describing this exact failure; the
   * end it forwards to did not have one.
   *
   * Driven on a raw socket, because `fetch` and `ws` both normalize the target
   * through the very parser this is about — the same reason `relaycheck` drives
   * its copy this way.
   */
  const spoke = (target: string): Promise<string> =>
    new Promise((resolve) => {
      const socket = netConnect({ host: "127.0.0.1", port }, () => {
        socket.write(
          `GET ${target} HTTP/1.1\r\nHost: d\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
            `Sec-WebSocket-Key: ${Buffer.from("0123456789abcdef").toString("base64")}\r\n` +
            "Sec-WebSocket-Version: 13\r\n\r\n",
        );
      });
      let seen = "";
      socket.on("data", (chunk: Buffer) => {
        seen += chunk.toString("utf8");
        if (seen.includes("\r\n")) {
          socket.destroy();
          resolve(seen.split("\r\n")[0] ?? "");
        }
      });
      socket.on("error", () => resolve("(socket error)"));
      socket.on("close", () => resolve(seen.split("\r\n")[0] ?? "(closed with nothing)"));
      setTimeout(() => {
        socket.destroy();
        resolve("(held open)");
      }, 2_000);
    });

  for (const target of ["//%", "/\\", "//["]) {
    check(`an unparseable target is answered rather than held: ${target}`, await spoke(target), "HTTP/1.1 400 Bad Request");
  }
  /*
   * And the ordinary handshake still works, which is the half that says the
   * guard wrapped the injected listener rather than replacing it — a sweep that
   * dropped the real handler would pass every line above and serve nothing.
   */
  check("while an ordinary handshake is untouched", await attach("s_one", "u_alice"), "frame");
}

/* ------------------------------------------------------------------ *
 * `?token=` is the handshake's exception, and only the handshake's
 *
 * The parameter has always been justified by one sentence — a browser cannot set
 * a header on a WebSocket handshake — and `readCredential` is called from the
 * single `app.use("*")` gate, so it authenticated *every* route. This section
 * exists because that gap could only be seen by asking two routes the same
 * question: the socket, which must still open on a query credential, and an
 * ordinary GET, which must not.
 *
 * The one it mattered on is `files`. `GET /sessions/:id/files?path=chart.png&
 * token=<jws>` answered with the bytes, which put a live bearer in
 * `location.search`, in browser history, in the `Referer` of whatever the page
 * loaded next and in every intermediary's log — on the same origin whose
 * `localStorage` holds `reemoat.credential`.
 * ------------------------------------------------------------------ */
{
  const query = `token=${encodeURIComponent(tokenFor("u_alice"))}`;
  // `async` rather than a bare arrow: Hono's own `fetch` is typed
  // `Response | Promise<Response>`, and awaiting copes with either.
  const bare = async (path: string): Promise<Response> => app.fetch(new Request(`http://d${path}`));

  check("an ordinary GET is not authenticated by a token in the URL", (await bare(`/sessions?${query}`)).status, 401);
  // The route the leak was actually reachable on, and the one whose whole answer
  // is bytes: a 200 here is a credential parked in the address bar of a tab
  // showing somebody's file.
  check("nor is the route that serves a file's bytes", (await bare(`/sessions/s_one/files?path=notes.txt&${query}`)).status, 401);
  // The positive control, and the half that carries the weight: the narrowing
  // must not have been done by simply deleting the parameter. `attach` above
  // already passes it as the only credential a `ws://` client can send, and this
  // says the same thing where the refusals are, so the two are read together.
  check("while the header is still all any route ever needed", (await get("/sessions", "u_alice")).status, 200);
  /*
   * And the rule is the `Upgrade` header rather than the stream route's path,
   * which is deliberate and therefore pinned. A route reader would have to be
   * kept in step with the routes and would fail *open* the day it fell behind.
   * Somebody who sets the header by hand gains nothing — they are holding the
   * token either way — because what this closes is the URL a browser follows,
   * and a browser following one never sends it.
   */
  const handshaking = await app.fetch(
    new Request(`http://d/sessions?${query}`, { headers: { upgrade: "websocket" } }),
  );
  check("a request that says it is a handshake may still carry it in the query", handshaking.status, 200);
}

{
  /*
   * **The attach is bounded where the history used to be.**
   *
   * A session's log is no longer truncated, so "attach at 0" can mean an
   * arbitrary number of events — and `attach` drains its whole backlog into the
   * outbound queue in one synchronous block, which past `MAX_QUEUE_EVENTS`
   * collapses and reports `lagged{slow_consumer}` about a client that was never
   * given the chance to be slow. That lie is what the old 5000-event retention
   * window was really buying, and paying for it with somebody's conversation was
   * the wrong trade.
   *
   * So the socket replays the newest `ATTACH_REPLAY_MAX` and says what it skipped,
   * with the one `lagged` reason that is **not** a loss: `backlog` means the
   * events are on disk and `GET /sessions/:id/events` serves them. Three separate
   * things have to hold, and only the first is obvious.
   */
  const many = registry.get("s_three");
  for (let n = 1; n <= 3_000; n += 1) {
    many?.log.append({ type: "text", role: "agent", thought: false, text: `w${n}`, messageId: null });
  }
  const lastSeq = many?.log.stats().lastSeq ?? 0;

  const frames = await streamFrames(port, "s_three", "u_alice", 0);

  const lagged = frames.filter((f) => f["type"] === "lagged");
  const delivered = frames
    .filter((f) => f["type"] === "events")
    .reduce((n, f) => n + (Array.isArray(f["events"]) ? f["events"].length : 0), 0);
  const caughtUp = frames.find((f) => f["type"] === "caught_up");

  check("a since=0 attach past the cap is told, with `backlog`", lagged.map((f) => f["reason"]), ["backlog"]);
  // Bounded, and by a real margin rather than "some events were skipped" — the
  // number that matters is that it stays under `MAX_QUEUE_EVENTS`, since going
  // over is what turns this into a `slow_consumer` close.
  check("and replays no more than the cap", delivered <= 2_000, true);
  check("but genuinely replays that much rather than nothing", delivered > 1_900, true);
  /*
   * The two that a "fewer events arrived" assertion would pass without.
   *
   * The skipped range has to be *named* — a client that is not told which seqs it
   * did not get cannot page them, and a silent skip is the contiguous-looking
   * transcript with a hole in the middle that this whole area exists to prevent.
   * And the cursor has to end at the head: `caught_up` is what says the socket is
   * live, and reporting it below `lastSeq` would leave the client believing it is
   * following a session it is 3000 events behind on.
   */
  check("the skipped range starts at the first event", lagged[0]?.["from"], 1);
  check("and ends where the replay begins", lagged[0]?.["to"], lastSeq - 2_000);
  check("the socket still goes live at the head of the log", caughtUp?.["seq"], lastSeq);
}

await new Promise<void>((resolve) => server.close(() => resolve()));

/* ------------------------------------------------------------------ *
 * An attach that is both evicted and behind
 * ------------------------------------------------------------------ */

/*
 * The hole in the case above, and the one place the arithmetic actually bites.
 *
 * `s_three`'s log has `dropped: 0`, so its attach emits exactly one `lagged`
 * frame and `Math.max(asked, oldest - 1)` is never exercised — replacing it with
 * the pre-diff `asked + 1` leaves every assertion up there green. Both frames
 * only appear together on a session that is *both* missing a prefix an older
 * daemon destroyed *and* further behind than `ATTACH_REPLAY_MAX`, which is
 * exactly the session that has been open longest.
 *
 * The two mean opposite things and the client draws them differently: `evicted`
 * is a loss, and the transcript ends there with a marker saying so; `backlog` is
 * not a loss at all — those events are on disk and `GET /sessions/:id/events`
 * serves them, so the client pages them in. Overlapping the ranges therefore
 * costs twice: the same seqs are reported destroyed *and* offered for paging,
 * and the two `dropped` counts a client adds up come to more than the log ever
 * held. Adjacency is the whole property, and it is one `Math.max` wide.
 */
process.stdout.write("\nan attach that is both evicted and behind\n");
{
  /*
   * The one registry in this driver whose store evicts. `dropped > 0` is the
   * entire precondition, and it cannot be reached on the main registry: a
   * session's log is unbounded by default, deliberately, which is why an
   * explicit window has to be built here rather than found.
   */
  const evicting = new MemoryEventStore({ maxEventsPerSession: 5_000 });
  const lagRegistry = new SessionRegistry(evicting, storeOf([rowFor("s_lag", join(users, "u_alice", "lag"))]));
  lagRegistry.restore({ reapOrphans: false });
  const { app: lagApp, injectWebSocket: injectLag } = createApp({
    registry: lagRegistry,
    verifier,
    instanceId: "i_lag",
    startedAt: now,
    credentials,
    roots: [users],
  });
  const lagServer = serve({ fetch: lagApp.fetch, hostname: "127.0.0.1", port: 0 });
  injectLag(lagServer as unknown as Server);
  await new Promise<void>((resolve) => lagServer.once("listening", resolve));
  const lagPort = (lagServer.address() as AddressInfo).port;

  // Past the store's window *and* past the replay cap, which is what produces
  // both frames from one attach: a thousand evicted, three thousand skipped,
  // two thousand replayed.
  const managed = lagRegistry.get("s_lag");
  for (let n = 1; n <= 6_000; n += 1) {
    managed?.log.append({ type: "text", role: "agent", thought: false, text: `w${n}`, messageId: null });
  }
  const stats = managed?.log.stats() ?? { firstSeq: 0, lastSeq: 0, count: 0, dropped: 0, approxBytes: 0 };
  // The positive control. Without it every assertion below is about a session
  // that lost nothing, which is the case already covered — and a future default
  // that stopped this store evicting would make this whole section green and
  // meaningless rather than red.
  check("the store really did evict, or none of this is being driven", stats.dropped > 0, true);

  const frames = await streamFrames(lagPort, "s_lag", "u_alice", 0);
  const lagged = frames.filter((f) => f["type"] === "lagged");
  const delivered = frames
    .filter((f) => f["type"] === "events")
    .reduce((n, f) => n + (Array.isArray(f["events"]) ? f["events"].length : 0), 0);
  const caughtUp = frames.find((f) => f["type"] === "caught_up");

  // Order rather than membership: the loss is what ends the readable transcript,
  // so it has to be the frame a client sees first — it arrives before the range
  // that merely has to be fetched.
  check("both are reported, the loss before the backlog", lagged.map((f) => f["reason"]), ["evicted", "backlog"]);
  /*
   * **The load-bearing one.** With `asked + 1` the backlog range starts back at
   * 1 and swallows the evicted range whole, so a client is told to page seqs
   * that no longer exist — and every other assertion in this section except the
   * one below it still passes.
   */
  check(
    "and the second range begins exactly where the first ended",
    (lagged[0]?.["to"] ?? -1) + 1,
    lagged[1]?.["from"],
  );
  /*
   * Nothing is counted twice, stated against the socket's own behaviour rather
   * than against a copy of `attach`'s arithmetic: the client asked from 0, so
   * every seq up to `lastSeq` either arrived or was named in one of the two
   * frames, and in exactly one of them.
   */
  check(
    "so the two counts add up to exactly what was not delivered",
    lagged.reduce((n, f) => n + Number(f["dropped"] ?? 0), 0),
    stats.lastSeq - delivered,
  );
  // And the replay itself is unchanged by any of it. Exactly the cap, not
  // "about" it: the cursor is `lastSeq - ATTACH_REPLAY_MAX` and nothing in
  // between is dropped, so a delivery short of 2000 is a hole rather than a bound.
  check("the replay is still exactly the cap", delivered, 2_000);
  check("and the socket still goes live at the head of the log", caughtUp?.["seq"], stats.lastSeq);

  await new Promise<void>((resolve) => lagServer.close(() => resolve()));
}

/* ------------------------------------------------------------------ *
 * An attach that is small enough to replay and too large to send
 * ------------------------------------------------------------------ */

/*
 * **`ATTACH_REPLAY_MAX` bounds the count and `MAX_QUEUE_BYTES` bounds the bytes,
 * and only one of them was told the truth about which is which.**
 *
 * The constant is justified as sitting under `MAX_QUEUE_EVENTS` so that a big
 * attach can never be mistaken for a client that fell behind — but `enqueue`
 * collapses on *either* ceiling, and two thousand events of transcript is
 * comfortably past 16 MiB. The whole drain is one synchronous block and the first
 * `send` callback has not run, so at the moment of the collapse nothing has
 * drained and the client has not been given a single frame to be slow about. It
 * was told `slow_consumer` anyway, which the browser records as a permanent
 * "events lost" marker over a conversation the daemon still holds intact.
 *
 * The fixture is therefore deliberately *under* the count cap and over the byte
 * one: four hundred events at 48 KiB is a fifth of `ATTACH_REPLAY_MAX` and about
 * 19 MiB, so the frame this produces can only have come from the byte ceiling.
 *
 * What is **not** driven here is the other half of the same fix — that a backlog
 * collapse is not recorded in the window that closes the socket `4003`. One
 * attach can collapse only once (the cursor jumps to the head, so the drain loop
 * reads an empty slice and stops), and a second collapse on the same connection
 * needs a live client that genuinely stops reading, which is real TCP
 * backpressure and the one thing this driver cannot manufacture.
 */
process.stdout.write("\nan attach too large to replay down a socket\n");
{
  const fatRegistry = new SessionRegistry(
    new MemoryEventStore(),
    storeOf([rowFor("s_fatreplay", join(users, "u_alice", "fatreplay"))]),
  );
  fatRegistry.restore({ reapOrphans: false });
  const { app: fatApp, injectWebSocket: injectFat } = createApp({
    registry: fatRegistry,
    verifier,
    instanceId: "i_fat",
    startedAt: now,
    credentials,
    roots: [users],
  });
  const fatServer = serve({ fetch: fatApp.fetch, hostname: "127.0.0.1", port: 0 });
  injectFat(fatServer as unknown as Server);
  await new Promise<void>((resolve) => fatServer.once("listening", resolve));
  const fatPort = (fatServer.address() as AddressInfo).port;

  const managed = fatRegistry.get("s_fatreplay");
  const fat = "b".repeat(48 * 1024);
  for (let n = 1; n <= 400; n += 1) {
    managed?.log.append({ type: "text", role: "agent", thought: false, text: fat , messageId: null });
  }
  const stats = managed?.log.stats() ?? { firstSeq: 0, lastSeq: 0, count: 0, dropped: 0, approxBytes: 0 };
  // The precondition, said as a measurement rather than as a restatement of the
  // constants: the replay is well inside the count cap and well past the byte
  // one, so a collapse here cannot be the count cap firing.
  check("the fixture is far under the replay cap", stats.lastSeq < 2_000, true);
  check("and far over the outbound byte ceiling", stats.approxBytes > 16 * 1024 * 1024, true);

  const frames = await streamFrames(fatPort, "s_fatreplay", "u_alice", 0);
  const lagged = frames.filter((f) => f["type"] === "lagged");
  const caughtUp = frames.find((f) => f["type"] === "caught_up");

  // Asked from 0 with nothing evicted and nothing skipped, so `attach` itself
  // emits no `lagged` at all — which is what makes the single frame below
  // unambiguously the collapse's own.
  check("exactly one lagged frame, and it is the collapse's", lagged.length, 1);
  /*
   * **The one that catches the revert.** With the reason hardcoded, this reads
   * `slow_consumer` — a client that has not yet received a frame being blamed for
   * not reading it, and a hole drawn over events that are all still on disk.
   */
  check("a replay too large in bytes is a backlog, not a slow consumer", lagged[0]?.["reason"], "backlog");
  // And it names the range, ending at the head, because `backlog` is an
  // instruction to page `GET /sessions/:id/events` rather than a report of loss.
  check("naming a range that ends at the head of the log", lagged[0]?.["to"], stats.lastSeq);
  check("and the socket still goes live there rather than being closed", caughtUp?.["seq"], stats.lastSeq);

  await new Promise<void>((resolve) => fatServer.close(() => resolve()));
}

/* ------------------------------------------------------------------ *
 * the outbound batch is cut on the bytes it writes, not on an estimate
 * ------------------------------------------------------------------ */

/*
 * ⚠ **A transcript that stalled for good, on the encrypted path only.**
 * `StreamConnection.flush` used to accumulate `estimateBytes`, which charges
 * `String.length` — UTF-16 units of the UNESCAPED string — while what goes on the
 * wire is `JSON.stringify` in UTF-8. `MAX_SOCKET_MESSAGE_BYTES` (1 MiB) is
 * enforced by the *receiver*, in `MessageAssembler.push`, and no sender enforced
 * anything: so a batch charged under `BATCH_MAX_BYTES` (512 KiB) could be several
 * times that on the wire, the far end refused the message, the channel failed,
 * and `stream.ts` reconnected with the cursor unchanged onto the same batch —
 * which produced the same oversized message, for ever, with nothing logged.
 *
 * ESC is the sharp input because a coding CLI's stderr is made of it: one charged
 * UTF-16 unit escapes to `\u001b`, six bytes of JSON. So this fixture is
 * escape-heavy on purpose and not a curiosity.
 *
 * ⚠ **Measured here rather than on the encrypted path, and that is the whole
 * reason this section is in *this* file.** Over a channel the overflow is
 * answered by `fail()`, which ends the stream — so exactly one frame crosses
 * whether or not the bug is present, and no count taken at the peer can tell
 * "refused" from "fine". That is the shape this repository has shipped green six
 * times. On the direct path the daemon's own `raw.send(payload)` **is** the
 * message, so `data.length` at the driver's `ws` client is precisely the number
 * `MessageAssembler` would have accumulated. The WebSocket client is the third
 * party that can see the truth.
 */
process.stdout.write("\nthe outbound batch, cut on bytes rather than on an estimate\n");
{
  const cutRegistry = new SessionRegistry(
    new MemoryEventStore(),
    storeOf([rowFor("s_cut", join(users, "u_alice", "cut"))]),
  );
  cutRegistry.restore({ reapOrphans: false });
  const { app: cutApp, injectWebSocket: injectCut } = createApp({
    registry: cutRegistry,
    verifier,
    instanceId: "i_cut",
    startedAt: now,
    credentials,
    roots: [users],
  });
  const cutServer = serve({ fetch: cutApp.fetch, hostname: "127.0.0.1", port: 0 });
  injectCut(cutServer as unknown as Server);
  await new Promise<void>((resolve) => cutServer.once("listening", resolve));
  const cutPort = (cutServer.address() as AddressInfo).port;

  const managed = cutRegistry.get("s_cut");
  // 24 000 escapes: charged ~24 KiB by `estimateBytes`, ~144 KiB on the wire.
  // Well under DEFAULT_MAX_EVENT_BYTES, so nothing is clipped at ingest and the
  // disagreement below is the batch ceiling's alone.
  const escapes = "\u001b".repeat(24_000);
  const appended: { type: "text"; role: "agent"; thought: false; text: string; messageId: null }[] = [];
  for (let n = 0; n < 40; n += 1) {
    const event = { type: "text", role: "agent", thought: false as const, text: escapes, messageId: null } as const;
    managed?.log.append(event);
    appended.push(event as (typeof appended)[number]);
  }
  const lastSeq = managed?.log.stats().lastSeq ?? 0;

  const sizes: number[] = [];
  const frames = await streamFrames(cutPort, "s_cut", "u_alice", 0, sizes);
  const eventFrames = frames
    .map((frame, at) => ({ frame, bytes: sizes[at] ?? 0 }))
    .filter((f) => f.frame["type"] === "events");

  /*
   * ⚠ **Before any `Math.max`.** `Math.max(...[])` is `-Infinity`, which makes
   * the ceiling assertion below vacuously true — verbatim the sixth green-because-
   * it-could-not-fail shape this repository has filed.
   */
  report("the socket delivered event frames at all", eventFrames.length > 0, `${eventFrames.length} events frame(s)`);
  const widest = eventFrames.reduce((most, f) => (f.bytes > most ? f.bytes : most), 0);

  /*
   * ⚠ **The non-vacuity control, and it is the one that matters.** Replay the
   * *estimate* rule over the events actually delivered and serialise what it
   * would have sent. If somebody later makes `estimateBytes` count UTF-8 bytes,
   * or this fixture stops being escape-heavy, this goes red and says the section
   * has stopped testing anything — instead of the two assertions below passing
   * for a reason that has nothing to do with the fix.
   */
  let charged = 0;
  let wouldTake = 0;
  for (const event of appended) {
    const one = estimateBytes(event) + 64;
    if (wouldTake > 0 && charged + one > 512 * 1024) break;
    charged += one;
    wouldTake += 1;
  }
  const wouldHaveSent = Buffer.byteLength(
    JSON.stringify({ type: "events", events: appended.slice(0, wouldTake).map((event, at) => ({ seq: at + 1, event })) }),
    "utf8",
  );
  report(
    "and the fixture really is one where the two numbers disagree",
    wouldHaveSent > 1024 * 1024,
    `the estimate rule would have written ${wouldHaveSent} bytes for ${wouldTake} events, charging ${charged}`,
  );

  /*
   * The defect itself. With the estimate cut restored this reads about 3 MiB
   * against a 1 MiB bound, and the failure prints the real number.
   */
  report(
    "no stream frame is larger than the far end will reassemble",
    widest <= 1024 * 1024,
    `widest ${widest} bytes against MAX_SOCKET_MESSAGE_BYTES 1048576`,
  );
  /*
   * The *invariant* rather than a count, because the only licensed way past the
   * ceiling is the unconditional first event — and pinning "exactly three frames"
   * would move with the envelope rather than with the rule.
   */
  check(
    "and a frame over the batch ceiling carries exactly one event",
    eventFrames.filter((f) => f.bytes > 512 * 1024).every((f) => (f.frame["events"] as unknown[]).length === 1),
    true,
  );
  // Progress, so a fix that bounded the frame by dropping events is not mistaken
  // for one that bounded it by cutting the batch.
  const delivered = eventFrames.reduce((n, f) => n + (f.frame["events"] as unknown[]).length, 0);
  check("every event still arrives", delivered, 40);
  check("with the socket caught up at the head", frames.find((f) => f["type"] === "caught_up")?.["seq"], lastSeq);

  await new Promise<void>((resolve) => cutServer.close(() => resolve()));
}

/*
 * ⚠ **The wedge the fix must not trade into.** The cut keeps an unconditional
 * first event precisely so an event larger than the ceiling is still sent alone;
 * without that clause `flush` emits `{"type":"events","events":[]}` for ever, the
 * queue never drains and the socket never reaches the head. So this is the
 * negative control for the *repair's own* risk rather than for the original
 * defect, and the two are different failures.
 *
 * 200 000 escapes is clipped by `truncateEvent` at ingest to ~131 KiB charged,
 * which is ~768 KiB escaped: over `BATCH_MAX_BYTES` and under
 * `MAX_SOCKET_MESSAGE_BYTES`, which is the only window where "alone" is both
 * necessary and sufficient.
 */
process.stdout.write("\nand one event too large for the batch is still sent\n");
{
  const soloRegistry = new SessionRegistry(
    new MemoryEventStore(),
    storeOf([rowFor("s_solo", join(users, "u_alice", "solo"))]),
  );
  soloRegistry.restore({ reapOrphans: false });
  const { app: soloApp, injectWebSocket: injectSolo } = createApp({
    registry: soloRegistry,
    verifier,
    instanceId: "i_solo",
    startedAt: now,
    credentials,
    roots: [users],
  });
  const soloServer = serve({ fetch: soloApp.fetch, hostname: "127.0.0.1", port: 0 });
  injectSolo(soloServer as unknown as Server);
  await new Promise<void>((resolve) => soloServer.once("listening", resolve));
  const soloPort = (soloServer.address() as AddressInfo).port;

  const managed = soloRegistry.get("s_solo");
  managed?.log.append({
    type: "text",
    role: "agent",
    thought: false,
    text: "\u001b".repeat(200_000),
    messageId: null,
  });
  const lastSeq = managed?.log.stats().lastSeq ?? 0;

  const sizes: number[] = [];
  const frames = await streamFrames(soloPort, "s_solo", "u_alice", 0, sizes);
  const eventFrames = frames
    .map((frame, at) => ({ frame, bytes: sizes[at] ?? 0 }))
    .filter((f) => f.frame["type"] === "events");

  check(
    "one event past the batch ceiling is sent alone rather than wedging the socket",
    [eventFrames.length, (eventFrames[0]?.frame["events"] as unknown[] | undefined)?.length],
    [1, 1],
  );
  check("and the socket still reaches the head", frames.find((f) => f["type"] === "caught_up")?.["seq"], lastSeq);
  report(
    "while that frame is still one the far end will reassemble",
    (eventFrames[0]?.bytes ?? 0) > 512 * 1024 && (eventFrames[0]?.bytes ?? 0) <= 1024 * 1024,
    `${eventFrames[0]?.bytes ?? 0} bytes: over BATCH_MAX_BYTES, under MAX_SOCKET_MESSAGE_BYTES`,
  );

  await new Promise<void>((resolve) => soloServer.close(() => resolve()));
}

/* ------------------------------------------------------------------ *
 * the control frame, reduced until it fits
 * ------------------------------------------------------------------ */

/*
 * ⚠ **The same byte ceiling as the batch above, on the frame that cannot be
 * split.** `hello` is the FIRST frame of every attach and it carries
 * `managed.snapshot()`. A batch over `MAX_SOCKET_MESSAGE_BYTES` stalls a
 * transcript partway; a `hello` over it means the transcript never starts, and
 * `stream.ts` reconnects onto the same attach and produces the same frame. There
 * is no cursor to advance past it.
 *
 * ⚠ **Driven against the exported ladder rather than through a socket, and that
 * is the honest shape rather than a shortcut.** Every rung is reached only by a
 * snapshot no offline fixture can assemble: pending permissions are minted by an
 * ACP agent, a driver that can raise one raises exactly one, and one is far under
 * 512 KiB. Attaching a real socket would therefore assert the rung that does
 * nothing — the frame already fits — and report green over a ladder that never
 * ran. Measured: deleting `fitSnapshotFrame` entirely and calling `safeStringify`
 * alone left every driver in this repository green, which is why the function is
 * exported at all.
 */
process.stdout.write("\na control frame too large to send whole\n");
{
  const { fitSnapshotFrame, CONTROL_MAX_BYTES } = await import("../src/server.js");
  const bytes = (text: string): number => Buffer.byteLength(text, "utf8");

  const permission = (n: number, blob: number): Record<string, unknown> => ({
    id: `p_${n}`,
    toolCallId: `tc_${n}`,
    title: `Permission ${n}`,
    rawInput: { command: "x".repeat(blob) },
    content: "y".repeat(blob),
    options: [{ optionId: "o_yes", name: "Yes", kind: "allow_once" }],
  });
  const frameWith = (session: Record<string, unknown>): Record<string, unknown> => ({
    type: "hello",
    instanceId: "i_fit",
    firstSeq: 1,
    lastSeq: 1,
    since: 0,
    session,
  });

  /*
   * The control, and the section is worth nothing without it: a frame that
   * already fits must come back **byte-identical**, so no session that worked
   * before can tell this function exists.
   */
  const small = frameWith({ backgroundTasks: [], pendingPermissions: [], pendingElicitations: [], id: "s_small" });
  const smallBuilt = JSON.stringify(small);
  check("a frame that already fits is returned unchanged", fitSnapshotFrame(small, smallBuilt), smallBuilt);

  /*
   * Rung one: `rawInput` and `content` are emptied and `outputFilePath` nulled.
   * Sized so the first rung alone is enough, which is what says the ladder stops
   * as soon as it can rather than cutting everything it is allowed to.
   */
  const fatBlobs = frameWith({
    id: "s_blobs",
    backgroundTasks: [{ id: "b_1", outputFilePath: "/tmp/" + "p".repeat(4_000) }],
    pendingPermissions: [permission(1, 400_000)],
    pendingElicitations: [],
  });
  const fatBlobsBuilt = JSON.stringify(fatBlobs);
  report("the blob fixture really is over the ceiling", bytes(fatBlobsBuilt) > CONTROL_MAX_BYTES, `${bytes(fatBlobsBuilt)} bytes against ${CONTROL_MAX_BYTES}`);
  const fittedBlobs = fitSnapshotFrame(fatBlobs, fatBlobsBuilt);
  report("and the fitted frame is under it", bytes(fittedBlobs) <= CONTROL_MAX_BYTES, `${bytes(fittedBlobs)} bytes`);
  const blobsBack = JSON.parse(fittedBlobs) as { session: { pendingPermissions: { id: string }[]; backgroundTasks: { outputFilePath: string | null }[] } };
  // Reduced, not dropped: the rung empties the blobs and keeps the row, because a
  // permission the app cannot see is a turn nobody can answer.
  check("with the permission still there to be answered", blobsBack.session.pendingPermissions.map((p) => p.id), ["p_1"]);
  check("and the background task's path nulled rather than the task removed", blobsBack.session.backgroundTasks.map((t) => t.outputFilePath), [null]);

  /*
   * Rung two: halving the two lists. Reached only when emptying every blob was
   * not enough, so the fixture's weight has to be in the row COUNT rather than in
   * the blobs — otherwise this exercises rung one a second time and reports green
   * over a rung that never ran.
   */
  const many = frameWith({
    id: "s_many",
    backgroundTasks: [],
    // ⚠ The weight is in `title` and `options`, which rung one does NOT touch.
    // Written first with the weight in `rawInput`/`content` instead, and measured:
    // rung one took 1,666,637 bytes to 85,037 on its own and the halving never
    // ran, while every assertion below it still reported green. That is this
    // section's own trap — a fixture that exercises the earlier rung twice.
    pendingPermissions: Array.from({ length: 400 }, (_, i) => ({
      id: `p_${i}`,
      toolCallId: `tc_${i}`,
      title: `Permission ${i} ${"t".repeat(2_000)}`,
      rawInput: { command: "x" },
      content: "y",
      options: [
        { optionId: "o_yes", name: "Yes ".repeat(200), kind: "allow_once" },
        { optionId: "o_no", name: "No ".repeat(200), kind: "reject_once" },
      ],
    })),
    pendingElicitations: [],
  });
  const manyBuilt = JSON.stringify(many);
  report("the count fixture really is over the ceiling", bytes(manyBuilt) > CONTROL_MAX_BYTES, `${bytes(manyBuilt)} bytes`);
  const fittedMany = fitSnapshotFrame(many, manyBuilt);
  const manyBack = JSON.parse(fittedMany) as { session: { pendingPermissions: unknown[] } };
  report("the halving rung ran, not just the blob one", manyBack.session.pendingPermissions.length < 400, `${manyBack.session.pendingPermissions.length} of 400 kept`);
  report("and the fitted frame is under the ceiling", bytes(fittedMany) <= CONTROL_MAX_BYTES, `${bytes(fittedMany)} bytes`);
  // The floor the loop is written around: halving stops at one rather than at none,
  // because a hello carrying no permission at all is a turn that looks answerable
  // and is not.
  report("with at least one permission left", manyBack.session.pendingPermissions.length >= 1, `${manyBack.session.pendingPermissions.length} kept`);

  /*
   * And the refusal to wedge. A frame that cannot be brought under the ceiling by
   * either rung is SENT anyway — `BATCH_MAX_BYTES`'s argument one arm over: a
   * `hello` that never arrives is the stall, not the cure for it.
   */
  const stubborn = frameWith({
    id: "s_stubborn",
    backgroundTasks: [],
    pendingPermissions: [permission(1, 10)],
    pendingElicitations: [],
    note: "z".repeat(CONTROL_MAX_BYTES + 1_000),
  });
  const stubbornBuilt = JSON.stringify(stubborn);
  const fittedStubborn = fitSnapshotFrame(stubborn, stubbornBuilt);
  report(
    "a frame neither rung can shrink is still sent rather than dropped",
    fittedStubborn.length > 0 && JSON.parse(fittedStubborn)["type"] === "hello",
    `${bytes(fittedStubborn)} bytes, still a hello`,
  );

  /*
   * And a frame carrying no session at all — a `lagged`, a `caught_up` — is not
   * this function's business and must come back untouched, since `snapshotOnFrame`
   * answering `null` is the only thing standing between the ladder and every other
   * control frame the daemon sends.
   */
  const noSession = { type: "caught_up", seq: 7 };
  const noSessionBuilt = JSON.stringify(noSession);
  check("a control frame with no snapshot is left alone", fitSnapshotFrame(noSession, noSessionBuilt), noSessionBuilt);
}

/* ------------------------------------------------------------------ *
 * GET /sessions/:id/events — the page a lagged client is pointed at
 * ------------------------------------------------------------------ */

/*
 * The route the `backlog` frame above names, driven as more than a 404.
 *
 * It was in the unknown-id table and nowhere else, which was defensible while a
 * client only ever read history over the socket. It is not any more: the attach
 * is bounded and everything past the bound is *this* route's problem, so the
 * browser's whole paging loop rests on three properties of a page that nothing
 * asserted — where it starts, that it may be shorter than asked for, and which
 * end it is short at.
 *
 * The third is the one that shipped a defect. A page is filled by scanning
 * ascending from `since` and breaking on the byte budget, in **both** stores, so
 * a byte-capped page keeps its oldest events and drops its newest — a client
 * that anchors its window on the page's first event and assumes it received the
 * whole range it asked for splices the page's *last* event onto a window that
 * begins hundreds of seqs later, and loses everything in between with nothing
 * anywhere to say so. That direction is decided here, so it is pinned here.
 */
process.stdout.write("\nthe events page\n");
{
  /** The route's response shape, so the assertions below are not written against `any`. */
  interface EventPage {
    events: { seq: number; ts: number; event: unknown }[];
    firstSeq: number;
    lastSeq: number;
    dropped: number;
    gap: boolean;
  }

  const pagePath = join(sandbox, "paging", "reemoat.db");
  /*
   * Two opens, because `seedFloors` runs at open from `sessions.list()` — the
   * floors on a session whose events are *entirely* gone can only be picked up
   * by a daemon that finds the row already there, which is the same two-phase
   * shape the store's own floors case uses.
   */
  {
    const seed = openStores({ path: pagePath, instanceId: "i_page_seed" });
    seed.sessions.put(rowFor("s_page", join(users, "u_alice", "paging")));
    seed.sessions.put(rowFor("s_fat", join(users, "u_alice", "paging-fat")));
    // The case the route's own comment calls the one a paging client must not be
    // told history begins at 1: the table knows nothing about this session and
    // the row says the log reached 500.
    seed.sessions.put({
      ...rowFor("s_gone", join(users, "u_alice", "paging-gone")),
      lastSeq: 500,
      dropped: 500,
    });
    seed.close();
  }

  /*
   * **Both bounds have to be exercisable in one store, and that is what sets these
   * two numbers.** Eviction needs a log longer than `maxEventsPerSession`; the
   * route's count clamp needs more than `EVENTS_PAGE_LIMIT` events *above the
   * cursor the clamp is asked from*. When the page was 500 this was a cap of 5000
   * and 6000 events, and raising the page to 5000 left the second property
   * unprovable — the whole live log was smaller than one page, so the route
   * returning all of it proved nothing about honouring `limit`. Scaled off the
   * constant rather than re-typed, so the next move does not need this comment.
   */
  const pageCap = EVENTS_PAGE_LIMIT * 4;
  const store = openStores({ path: pagePath, instanceId: "i_page", maxEventsPerSession: pageCap });
  // Small enough that a page of them is nowhere near the byte budget, so the count
  // clamp is what bounds a page here and the byte cap is measured separately, on
  // `s_fat`.
  for (let n = 1; n <= pageCap + 1_000; n += 1) {
    store.events.append("s_page", { type: "text", role: "agent", thought: false, text: `p${n}`, messageId: null });
  }
  /*
   * And large enough that five hundred cannot fit: a `text` event is accounted
   * at `64 + text.length`, so 8 KiB apiece puts 500 of them at ~4 MiB against
   * the route's 2 MiB budget. Six hundred exist so the page is short of both the
   * count clamp and the end of the log — a page that stopped because it ran out
   * of events would prove nothing about the budget.
   */
  const fat = "f".repeat(8 * 1024);
  for (let n = 1; n <= 600; n += 1) {
    store.events.append("s_fat", { type: "text", role: "agent", thought: false, text: fat , messageId: null });
  }

  const pageRegistry = new SessionRegistry(store.events, store.sessions);
  pageRegistry.restore({ reapOrphans: false });
  const { app: pageApp } = createApp({
    registry: pageRegistry,
    verifier,
    instanceId: "i_page",
    startedAt: now,
    credentials,
    roots: [users],
  });
  const pageOf = async (id: string, query: string): Promise<EventPage> => {
    const response = await pageApp.fetch(
      new Request(`http://d/sessions/${id}/events${query}`, {
        headers: { authorization: `Bearer ${tokenFor("u_alice")}` },
      }),
    );
    return (await response.json()) as EventPage;
  };

  /*
   * `since` is a cursor and cursors here are exclusive — the same rule
   * `StreamConnection.attach` gets from `WHERE seq > ?`. A client pages by
   * handing back the seq it already holds, so an inclusive read would repeat one
   * event at every page boundary, forever, in a transcript nobody can tell it
   * from a repeated agent message.
   */
  const window = await pageOf("s_page", "?since=2000&limit=5");
  check("`since` is exclusive, so a client's own cursor is never repeated", window.events.map((stored) => stored.seq), [
    2001, 2002, 2003, 2004, 2005,
  ]);

  const clamped = await pageOf("s_page", "?since=2000&limit=1000000");
  // Asking for more than a page holds is answered with a page, not with the
  // whole log. This is the bound the socket's `backlog` reason hands the client
  // over to, so a route that honoured `limit` would move the unbounded read one
  // layer down rather than removing it. Against the constant, because a literal
  // here is a literal that goes stale the next time the page moves — which is
  // exactly what happened.
  check("a page is clamped to what one request may carry", clamped.events.length, EVENTS_PAGE_LIMIT);
  check(
    "and runs from the cursor to the clamp, ascending with no hole",
    clamped.events.every((stored, i) => stored.seq === 2001 + i),
    true,
  );

  /*
   * The byte cap, and then the direction of it.
   *
   * Short is the easy half — `limit` was 500 by default and fewer came back.
   * Which end it is short at is the half a "fewer events arrived" assertion
   * passes without, and it is the whole reason a client may not treat a page as
   * the range it asked for: the page begins at `since + 1` and stops early, so
   * what is missing is at the *new* end and the next request carries on from the
   * last seq received rather than from `since + limit`.
   */
  const capped = await pageOf("s_fat", "?since=0");
  check("a page of large events is cut short by bytes rather than by count", capped.events.length < 500, true);
  /*
   * **This one proves nothing on its own, and that is recorded rather than
   * hidden.** Both stores guard the byte break with `out.length > 0 &&` so a
   * single oversized record cannot wedge a reader that can never get past it.
   * Deleting that guard from either store — or from both at once — leaves this
   * whole suite green, because the branch is unreachable with this fixture and,
   * more to the point, unreachable in production: `truncateEvent` caps one event
   * at 128 KiB, sixteen times below `EVENTS_PAGE_BYTES`, so no event can be
   * larger than the page budget while both defaults stand.
   *
   * Kept because it is the assertion that would start meaning something the day
   * somebody raises the per-event cap or lowers the page budget, and because
   * `capped.events.length >= 1` is a precondition of the sibling below actually
   * reading `events[0]`. Not kept as evidence that the wedge guard works.
   */
  check("but never to nothing, since one oversized event must not wedge a reader", capped.events.length >= 1, true);
  check("what it keeps is the OLDEST requested seq", capped.events[0]?.seq, 1);
  check(
    "so it is short at the new end, and the next page carries on from the last seq received",
    capped.events.at(-1)?.seq,
    capped.events.length,
  );
  check(
    "the newest seq asked for is precisely the one that did not fit",
    capped.events.some((stored) => stored.seq === 500),
    false,
  );

  /*
   * `firstSeq` is `oldestAvailable(stats)` and not the raw column, in both of
   * the states where the two differ.
   *
   * A client reads this to decide whether there is anything left to page — the
   * browser draws "the start of this conversation is gone" from it — so a route
   * that reported the raw value would send it asking for history that cannot be
   * served, once per page, forever.
   */
  const evicted = await pageOf("s_page", "?since=0&limit=1");
  check("a log whose prefix is gone does not claim to begin at 1", evicted.firstSeq, evicted.dropped + 1);
  check("and a cursor below that floor is named as a gap", evicted.gap, true);
  // The boundary either side of it, because `since < oldestAvailable - 1` is the
  // one predicate that decides whether a client believes it lost anything.
  check(
    "a cursor exactly at the floor is not a gap",
    (await pageOf("s_page", `?since=${evicted.dropped}&limit=1`)).gap,
    false,
  );
  check(
    "and one seq below it is",
    (await pageOf("s_page", `?since=${evicted.dropped - 1}&limit=1`)).gap,
    true,
  );

  /*
   * And the case the raw column answers with **zero**: the log is empty and the
   * sequence is not. `firstSeq` is 0 there, so `firstSeq - 1` is -1 and every
   * gap predicate written against it silently answers "no gap" — on the one path
   * where absolutely everything was lost.
   */
  const gone = await pageOf("s_gone", "?since=0");
  check("a session whose events are all gone serves none", gone.events, []);
  check("while its sequence is intact", gone.lastSeq, 500);
  check("and history begins one past the end rather than at 1 or at 0", gone.firstSeq, gone.lastSeq + 1);
  check("with a cursor of 0 named as the gap it is", gone.gap, true);

  process.stdout.write("\nwhat crosses the wire, and what must not be touched\n");
  {
    /*
     * ⭐ **Nothing in this system compressed anything, and the scarce resource on
     * this path is the uplink of the machine an agent runs on.**
     *
     * Measured against the fleet's largest conversation: a page of 5000 events is
     * **1.23 MB** raw and **98 KB** gzipped, and every byte of it crosses that
     * uplink once to the relay and again to the browser. The relay cannot help —
     * it carries h2 frames, which are already framed — so the daemon is where it
     * has to happen.
     *
     * The second assertion is the load-bearing one and the reason `compressible`
     * keys on the **content type** rather than the path: `GET /sessions/:id/files`
     * streams arbitrary bytes and the client refuses an oversized file by reading
     * `content-length` *before* the body is resident. Compressed, that number
     * describes the packed size, so a 100 MiB guard measures the wrong thing.
     */
    const raw = async (path: string, headers: Record<string, string> = {}): Promise<Response> =>
      pageApp.fetch(
        new Request(`http://d${path}`, {
          headers: { authorization: `Bearer ${tokenFor("u_alice")}`, ...headers },
        }),
      );

    const query = "/sessions/s_page/events?since=0&limit=5000";
    const packed = await raw(query, { "accept-encoding": "gzip" });
    const packedBody = Buffer.from(await packed.arrayBuffer());
    check("a page a client will take gzipped is gzipped", packed.headers.get("content-encoding"), "gzip");
    check("and says so in its length", packed.headers.get("content-length"), String(packedBody.byteLength));
    check("and tells a cache what it varied on", (packed.headers.get("vary") ?? "").includes("accept-encoding"), true);

    const plain = await raw(query);
    const plainPage = (await plain.json()) as EventPage;
    check("a client that did not ask for it gets none", plain.headers.get("content-encoding"), null);

    /*
     * ⭐ **A compressible response *under* the threshold must still be readable,
     * and this is the assertion whose absence let a 500 reach production.**
     *
     * Deciding the size means reading the body, and reading it consumes it — so an
     * early `return` past that point leaves `c.res` holding a body already read, and
     * `@hono/node-server` answers `ERR_INVALID_STATE: ReadableStream is locked`. It
     * is a 500 with no body on **every** small JSON answer, `GET /sessions`
     * included. The compressed path was asserted and this one was not, which is
     * exactly the half that broke.
     */
    const small = await raw("/sessions/s_page/events?since=0&limit=2", { "accept-encoding": "gzip" });
    check("a small answer is not compressed", small.headers.get("content-encoding"), null);
    // Read through a catch, so a body left consumed is a *sentence* rather than a
    // throw that ends the driver before everything after it has run.
    const smallText = await small.text().then(
      (text) => text,
      (error: unknown) => `unreadable: ${error instanceof Error ? error.message : String(error)}`,
    );
    check("and it still has its body", smallText.slice(0, 11), '{"events":[');
    // Guarded, so an unreadable body is one FAIL rather than a throw that ends the
    // driver with everything after it unrun.
    const smallEvents = smallText.startsWith('{"events":[') ? (JSON.parse(smallText) as EventPage).events.length : -1;
    check("carrying what was asked for", smallEvents, 2);
    check("with the status it had", small.status, 200);
    const unpacked = JSON.parse(gunzipSync(packedBody).toString("utf8")) as EventPage;
    check(
      "and the two carry the same events, which is the only thing that matters",
      [unpacked.events.length, unpacked.events.at(-1)?.seq, unpacked.firstSeq],
      [plainPage.events.length, plainPage.events.at(-1)?.seq, plainPage.firstSeq],
    );
    // The uncompressed size is measured off the body rather than off a header:
    // `c.json` does not set `content-length`, which is itself why the middleware
    // has to *write* one when it packs a body.
    const plainBytes = Buffer.byteLength(JSON.stringify(plainPage));
    report(
      "measured on this fixture",
      packedBody.byteLength * 4 < plainBytes,
      `${(packedBody.byteLength / 1024).toFixed(0)} KiB gzipped from ${(plainBytes / 1024).toFixed(0)} KiB`,
    );

    store.close();
  }
}

/* ------------------------------------------------------------------ *
 * Subagent lineage — the one projection out of an agent-shaped blob
 * ------------------------------------------------------------------ */

process.stdout.write("\nsubagent lineage\n");
{
  const call = (meta: unknown, id = "toolu_child"): unknown =>
    toolCallLineage({ toolCallId: id, _meta: meta });

  check(
    "claude's spawn is a subagent with no parent of its own",
    call({ claudeCode: { toolName: "Agent", subagent: true } }),
    { parentToolCallId: null, subagent: true },
  );
  check(
    "and a call inside it carries the parent's id, byte for byte",
    call({ claudeCode: { toolName: "Read", parentToolUseId: "toolu_parent" } }),
    { parentToolCallId: "toolu_parent", subagent: false },
  );

  // Kimi sends no `_meta` on anything, ever, and filters its subagents' events
  // at the source. It gets `false` by absence rather than by us pattern-matching
  // its `Agent` tool, which would be a container that can never have contents.
  check("kimi sends no metadata, and that is the answer", call(undefined), {
    parentToolCallId: null,
    subagent: false,
  });
  check("a `_meta` without claude's key says nothing", call({ somethingElse: {} }), {
    parentToolCallId: null,
    subagent: false,
  });

  // Never coerced. `String(42)` as a tree edge names a call that will never
  // exist, and a reader cannot tell that from a parent that was merely evicted.
  for (const [label, value] of [
    ["a number", 42],
    ["an object", {}],
    ["the empty string", ""],
    ["null", null],
  ] as const) {
    check(
      `a parent id that is ${label} is no parent`,
      call({ claudeCode: { parentToolUseId: value } }),
      { parentToolCallId: null, subagent: false },
    );
  }

  // The `alg === "EdDSA"` discipline: an exact comparison makes a family of
  // near-misses impossible rather than defended one at a time.
  check(
    'the string "true" is not the boolean true',
    call({ claudeCode: { subagent: "true" } }),
    { parentToolCallId: null, subagent: false },
  );

  check(
    "a call cannot run inside itself",
    call({ claudeCode: { parentToolUseId: "toolu_self" } }, "toolu_self"),
    { parentToolCallId: null, subagent: false },
  );

  // Bounded at ingest, because there is nowhere later to bound it: `truncateEvent`
  // deliberately spreads `parentToolCallId` through untouched on both arms, so an
  // unshrinkable field with no ceiling walks an event straight past the per-event
  // cap that the bounds table calls enforced. A real ACP id is under 40
  // characters; anything over 256 was never an edge.
  check(
    "an id too long to be one is no parent",
    call({ claudeCode: { parentToolUseId: "t".repeat(257) } }),
    { parentToolCallId: null, subagent: false },
  );
  check(
    "and one exactly at the ceiling still is",
    (call({ claudeCode: { parentToolUseId: "t".repeat(256) } }) as { parentToolCallId: string | null })
      .parentToolCallId?.length,
    256,
  );

  // The assertion that fails if somebody later "simplifies" this into a
  // passthrough. `_meta` is an unbounded agent-shaped blob; two scalars is the
  // whole of what may cross.
  const huge = { claudeCode: { parentToolUseId: "toolu_parent", junk: "x".repeat(200_000) } };
  check(
    "a 200 KB blob beside the id contributes nothing but the id",
    JSON.stringify(call(huge)).length,
    JSON.stringify({ parentToolCallId: "toolu_parent", subagent: false }).length,
  );

  // So the per-event cap stays honest rather than becoming decorative.
  const base: ToolCallEvent = {
    type: "tool_call",
    toolCallId: "toolu_child",
    title: "Read",
    kind: "read",
    status: "pending",
    locations: [],
    rawInput: null,
    parentToolCallId: null,
    subagent: false,
  };
  check(
    "an accounted parent id costs exactly its own length",
    estimateBytes({ ...base, parentToolCallId: "toolu_parent" }) - estimateBytes(base),
    "toolu_parent".length,
  );

  /*
   * ⚠ **`locations` was charged nothing and cut by nothing**, on both tool-call
   * arms, while being an array of agent-chosen paths bounded by neither length
   * nor element size. That defeats three bounds at once and all three read this
   * number rather than the payload: the 128 KiB per-event cap, the per-session
   * byte budget (`schema.sql` stores what `estimateBytes` returns), and the WS
   * outbound queue's `MAX_QUEUE_BYTES`.
   *
   * Asserted as a *proportionality*, not as a constant: what made the defect
   * possible was a term being absent, so what has to be true is that the number
   * moves with the payload at all.
   */
  const sited: ToolCallEvent = {
    ...base,
    locations: Array.from({ length: 40 }, (_, i) => ({ path: `${"/deep/path".repeat(80)}/${i}`, line: null })),
  };
  report(
    "and a file list is charged rather than carried for free",
    estimateBytes(sited) - estimateBytes(base) > 20_000,
    `${estimateBytes(sited) - estimateBytes(base)} bytes for 40 long locations`,
  );
  // And shrinks, which the spread used to carry through untouched — so an event
  // over the cap stayed over it however often this ran.
  const cutSited = truncateEvent(sited, 4_096) as ToolCallEvent;
  report(
    "and truncating really shortens it",
    estimateBytes(cutSited) < estimateBytes(sited),
    `${estimateBytes(sited)} -> ${estimateBytes(cutSited)} bytes`,
  );
}


/* ------------------------------------------------------------------ *
 * The split in front of every agent's stdout
 * ------------------------------------------------------------------ */

/*
 * `splitAsyncTaskUpdates`, driven directly.
 *
 * ⚠ **This filter sees every byte of every agent's stdout and had no driver at
 * all.** Its happy path was reachable only through a real agent, so every guard
 * in it was live code nothing asserted — and the failure mode is not a feature
 * going missing but one agent going permanently silent behind a live process.
 *
 * The two properties worth holding are *what is taken* and *what is passed
 * through byte-for-byte*, and the second is the one with teeth: a frame this
 * filter swallows by mistake is a frame the SDK never sees. A `session/update`
 * carrying an `id` is the sharpest of those — JSON-RPC separates a request from a
 * notification on that member alone, and taking a request leaves the agent waiting
 * for a response nobody will write.
 *
 * Driven at every chunk size from 1 to 64 bytes, which is what puts a split inside
 * a multi-byte character and inside a CRLF rather than only between frames.
 */
{
  const marker = (kind: string, id?: unknown): string =>
    JSON.stringify({
      jsonrpc: "2.0",
      ...(id === undefined ? {} : { id }),
      method: "session/update",
      params: { sessionId: "a1", update: { sessionUpdate: kind, asyncTaskId: "t1", state: "running" } },
    });

  const corpus: readonly (readonly [string, string, boolean])[] = [
    ["a spawn is taken", marker("async_task_spawned"), true],
    ["a progress frame is taken", marker("async_task_progress"), true],
    ["a state update is taken", marker("async_task_state_update"), true],
    // Every one of these has to reach the SDK untouched.
    ["a task update sent as a *request* is forwarded, never swallowed", marker("async_task_spawned", 7), false],
    ["and `id: null` is forwarded too, being malformed rather than a notification", marker("async_task_spawned", null), false],
    ["an `async_task_`-prefixed kind outside the three is forwarded", marker("async_task_invented"), false],
    ["a marker-bearing line that will not parse is the SDK's to answer for", "{async_task_ nope", false],
    [
      "so is one whose method is not session/update",
      JSON.stringify({ jsonrpc: "2.0", method: "session/other", params: { sessionId: "a1", update: { sessionUpdate: "async_task_spawned" } } }),
      false,
    ],
    [
      "and one whose sessionId is not a string",
      JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: 5, update: { sessionUpdate: "async_task_spawned" } } }),
      false,
    ],
    ["agent prose containing the marker is an agent talking about this feature", "I ran async_task_spawned for you — 日本語 ✅", false],
    ["an ordinary frame with no marker at all", JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "a1", update: { sessionUpdate: "agent_message_chunk" } } }), false],
  ];

  const feed = `${corpus.map(([, line]) => line).join("\n")}\n`;
  const wantForwarded = corpus.filter(([, , taken]) => !taken).map(([, line]) => line).join("\n") + "\n";
  const wantTaken = corpus.filter(([, , taken]) => taken).length;

  const run = async (chunkSize: number): Promise<[string, number]> => {
    const stdout = new PassThrough();
    const taken: unknown[] = [];
    const onward = splitAsyncTaskUpdates(stdout, (notification) => taken.push(notification));
    const out: Buffer[] = [];
    onward.on("data", (chunk: Buffer) => out.push(Buffer.from(chunk)));
    const done = new Promise<void>((resolve) => onward.on("end", () => resolve()));
    const bytes = Buffer.from(feed, "utf8");
    for (let at = 0; at < bytes.length; at += chunkSize) stdout.write(bytes.subarray(at, at + chunkSize));
    stdout.end();
    await done;
    return [Buffer.concat(out).toString("utf8"), taken.length];
  };

  // One pass at a whole-frame chunk size, naming each row, so a failure says
  // which shape broke rather than only that some size disagreed.
  {
    for (const [what, line, shouldTake] of corpus) {
      const stdout = new PassThrough();
      const taken: unknown[] = [];
      const onward = splitAsyncTaskUpdates(stdout, (notification) => taken.push(notification));
      const out: Buffer[] = [];
      onward.on("data", (chunk: Buffer) => out.push(Buffer.from(chunk)));
      const done = new Promise<void>((resolve) => onward.on("end", () => resolve()));
      stdout.end(Buffer.from(`${line}\n`, "utf8"));
      await done;
      check(what, [taken.length === 1, Buffer.concat(out).toString("utf8")], [shouldTake, shouldTake ? "" : `${line}\n`]);
    }
  }

  // And then every boundary. Byte-for-byte on the forwarded half, because a
  // filter that rewrites what it passes through is the same defect as one that
  // swallows it.
  {
    let forwardedEverywhere = true;
    let takenEverywhere = true;
    for (let size = 1; size <= 64; size += 1) {
      const [forwarded, takenCount] = await run(size);
      if (forwarded !== wantForwarded) forwardedEverywhere = false;
      if (takenCount !== wantTaken) takenEverywhere = false;
    }
    report(
      "every forwarded byte survives every chunk boundary, 1..64",
      forwardedEverywhere,
      `${wantForwarded.length} chars of passthrough, including a split multi-byte character`,
    );
    report("and the same three frames are taken at every size", takenEverywhere, `${wantTaken} diverted`);
  }

  // A CRLF stream: the `\r` belongs to the line and must be forwarded with it,
  // rather than quietly trimmed by a filter that does not own the framing.
  {
    const stdout = new PassThrough();
    const onward = splitAsyncTaskUpdates(stdout, () => {});
    const out: Buffer[] = [];
    onward.on("data", (chunk: Buffer) => out.push(Buffer.from(chunk)));
    const done = new Promise<void>((resolve) => onward.on("end", () => resolve()));
    stdout.end("hello\r\nworld\r\n");
    await done;
    check("a CRLF stream keeps its carriage returns", Buffer.concat(out).toString("utf8"), "hello\r\nworld\r\n");
  }

  // An unterminated tail is flushed on end rather than dropped, and is still
  // eligible to be taken.
  {
    const stdout = new PassThrough();
    const onward = splitAsyncTaskUpdates(stdout, () => {});
    const out: Buffer[] = [];
    onward.on("data", (chunk: Buffer) => out.push(Buffer.from(chunk)));
    const done = new Promise<void>((resolve) => onward.on("end", () => resolve()));
    stdout.end("no newline here");
    await done;
    check("an unterminated tail is still forwarded on end", Buffer.concat(out).toString("utf8"), "no newline here");
  }

  /*
   * A session handler that throws does not take the daemon's event loop with it.
   *
   * The measurement in `handOff`'s docblock is that an unguarded throw out of a
   * `'data'` listener leaves the stream delivering **nothing ever again** — one
   * agent silent behind a live process. So the contract is that `onward` is
   * destroyed carrying the handler's error, which is what makes the registry put a
   * fresh agent on the session.
   */
  {
    const stdout = new PassThrough();
    const onward = splitAsyncTaskUpdates(stdout, () => {
      throw new Error("handler blew up");
    });
    onward.on("data", () => {});
    const failed = await new Promise<string | null>((resolve) => {
      onward.on("error", (error: Error) => resolve(error.message));
      onward.on("end", () => resolve(null));
      stdout.write(`${marker("async_task_spawned")}\n`);
      stdout.end("after\n");
    });
    check("a throwing session handler destroys the connection rather than going silent", failed, "handler blew up");
  }
}
