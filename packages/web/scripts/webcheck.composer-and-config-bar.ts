import { readFileSync } from "node:fs";
import { check, report } from "./webcheck.env.js";
import { snapshot } from "./webcheck.ws.js";
import { stripComments } from "./webcheck.source.js";
import {
  changeCounts,
  chipParts,
  chipValue,
  choiceLabel,
  diffLines,
  drawnChoices,
  effortFollowUp,
  formatLocation,
  hasInput,
  isTerminal,
  labelFor,
  readInput,
  sessionLists,
  showsCaption,
  slotFor,
  splitOptions,
  withChoice,
} from "./webcheck.modules.js";

/* ------------------------------------------------------------------ *
 * The diff a person is about to approve
 * ------------------------------------------------------------------ */

process.stdout.write("\nthe diff, before and after the fact\n");
{
  /*
   * `diffLines` is drawn twice over: above the Allow button when a permission
   * carries an edit, and inside a transcript row once the edit has happened. It
   * replaced `lineDiff`, which served only the first — and the reason it had to is
   * in the third case below.
   *
   * Getting it wrong does not throw and does not look broken: it draws a plausible
   * diff of the wrong lines, under a button that then executes the real edit.
   *
   * What the input *is* differs per agent, which is why these cases look unrelated.
   * claude's `Edit` sends the model's `old_string`/`new_string`, a fragment with no
   * context. codex sends whole files on both sides, for add, update and delete
   * alike. kimi sends a fragment and then the whole file again through a second
   * channel.
   */
  const shape = (diff: { hunks: readonly { lines: readonly { kind: string; text: string }[] }[] }): string[][] =>
    diff.hunks.map((hunk) =>
      hunk.lines.map((l) => `${l.kind === "add" ? "+" : l.kind === "del" ? "-" : " "}${l.text}`),
    );

  const created = diffLines(null, "first\nsecond");
  check("a created file is all additions", [created.added, created.removed], [2, 0]);
  check("drawn as one hunk", shape(created), [["+first", "+second"]]);
  check("numbered on the new side alone", created.hunks[0]?.lines.map((l) => [l.oldNo, l.newNo]), [
    [null, 1],
    [null, 2],
  ]);
  // `wholeFile` is a claim about a *replacement*, and there was no old file here —
  // drawing "the whole file changed" over a file that did not exist would be a
  // warning about something that cannot happen.
  check("and is not a whole-file replacement", created.wholeFile, false);

  const edited = diffLines("a\nb\nc\nd\ne", "a\nb\nX\nd\ne");
  check("a one-line edit is one line either side", [edited.added, edited.removed], [1, 1]);
  check("with the lines either side of it for context", shape(edited), [
    [" a", " b", "-c", "+X", " d", " e"],
  ]);
  check("numbered in both files", edited.hunks[0]?.lines.map((l) => [l.oldNo, l.newNo]), [
    [1, 1],
    [2, 2],
    [3, null],
    [null, 3],
    [4, 4],
    [5, 5],
  ]);
  check("and it is not a whole-file replacement either", edited.wholeFile, false);

  /*
   * **The case the trim-only version could not answer, and the reason it was
   * replaced.** codex reports an edit as the whole file on both sides, so two
   * changed regions share the file's beginning, its end *and* everything between
   * them — a common prefix and suffix alone therefore report the entire middle as
   * rewritten, which for a two-character change in a 200-line file is a diff nobody
   * can read. The LCS behind the trim is what splits it into two hunks with the
   * untouched lines dropped.
   */
  const twice = diffLines(
    "1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\n12\n13\n14",
    "1\n2\nX\n4\n5\n6\n7\n8\n9\n10\n11\nY\n13\n14",
  );
  check("two changed regions are two hunks", shape(twice), [
    [" 1", " 2", "-3", "+X", " 4", " 5"],
    [" 10", " 11", "-12", "+Y", " 13", " 14"],
  ]);
  check("counted across both", [twice.added, twice.removed], [2, 2]);
  check("and the eight untouched lines between them are not drawn", twice.wholeFile, false);

  // Reachable: `file_change` arrives twice for one kimi edit, and a re-write of
  // identical content is a real thing an agent does. No hunk at all is the honest
  // rendering; inventing one line of each would be a lie about what was approved.
  const same = diffLines("a\nb", "a\nb");
  check("identical text has nothing to draw", [same.hunks.length, same.added, same.removed], [0, 0, 0]);

  const replaced = diffLines("a\nb", "x\ny");
  check("nothing lining up is a whole-file replacement", replaced.wholeFile, true);
  check("and every line is shown on both sides", shape(replaced), [["-a", "-b", "+x", "+y"]]);

  /*
   * A deleted file is `newText: ""` — measured, that is what codex sends — and `""`
   * has to be **no lines** rather than one empty one, or a delete reads as "N lines
   * replaced by one blank line": `+1` for an act that added nothing.
   */
  const deleted = diffLines("a\nb\nc", "");
  check("a deleted file adds nothing", [deleted.added, deleted.removed], [0, 3]);

  // A trailing newline terminates the last line rather than starting an empty one,
  // so appending a line is `+1 −0` and not `+2 −1`.
  const appended = diffLines("a\n", "a\nb\n");
  check("a trailing newline is not a line", [appended.added, appended.removed], [1, 0]);

  /*
   * The clip, which is the one thing here that must not silently shorten.
   *
   * A card on a phone cannot draw an 800-line hunk, and a body that just *stops* at
   * 60 lines reads as the whole change — which is the number a person is approving.
   * So the count above it stays true and `omitted` is what says the body is short.
   */
  const long = diffLines(null, Array.from({ length: 70 }, (_, i) => `line ${i}`).join("\n"));
  check("an over-long diff is clipped", long.hunks[0]?.lines.length, 60);
  check("and says how much it is not showing", long.omitted, 10);
  check("while the count stays the true one", [long.added, long.removed], [70, 0]);

  /*
   * The line numbers a fragment gets, which are the only ones available at all:
   * measured in the log, a claude `Edit`'s own `locations[0].line` is the hunk's
   * `newStart`, and the fragment carries nothing else.
   */
  const placed = diffLines("c", "X", 24);
  check("a fragment is numbered from where it sits", placed.hunks[0]?.lines.map((l) => l.newNo ?? l.oldNo), [24, 24]);

  /*
   * **The refusal, and it is the one that matters most.** A `file_change` over the
   * 128 KiB per-event cap has each side clipped to half of it, so both are cut at
   * the same offset and the common suffix is destroyed — a diff over them reports the
   * untouched tail of the file as rewritten. `unavailable` is how "cannot say" stops
   * being drawn as "nothing changed", and `changeCounts` answers `null` rather than
   * zero for the reason the worktree counts do: a caller writing `?? 0` would report
   * the largest edit in the log as an empty one.
   */
  const cut = diffLines("old…[truncated 40 bytes]", "new…[truncated 12 bytes]");
  check("a truncated event has no diff", [cut.unavailable, cut.hunks.length, cut.added], ["truncated", 0, 0]);
  check(
    "and no counts either",
    changeCounts({
      type: "file_change",
      path: "/w/a.ts",
      oldText: "old…[truncated 40 bytes]",
      newText: "new…[truncated 12 bytes]",
      source: "diff",
      toolCallId: null,
    } as never),
    null,
  );

  /*
   * The word-level marks, drawn only where a removal is **paired** with an addition.
   * An inserted line is not a modified one, so it carries no marks at all — marking
   * the whole of it would say the opposite of what happened.
   */
  const word = diffLines("const timeout = 30;", "const timeout = 90;");
  check(
    "a rewritten line marks only what changed inside it",
    word.hunks[0]?.lines.map((l) => l.marks),
    [
      [[16, 17]],
      [[16, 17]],
    ],
  );
  check("an inserted line is marked nowhere", created.hunks[0]?.lines.map((l) => l.marks), [null, null]);

  /*
   * The bound, and that crossing it **degrades rather than hangs** — which is the
   * failure mode that matters, since this runs inside a `useMemo` on a transcript
   * that rebuilds on every streamed token. 700 lines a side is 490 000 cells against
   * a budget of 250 000.
   */
  const wall = (salt: string): string => Array.from({ length: 700 }, (_, i) => `${salt} ${i}`).join("\n");
  const huge = diffLines(wall("a"), wall("b"));
  check("past the cell budget it is one replacement", [huge.wholeFile, huge.added, huge.removed], [true, 700, 700]);
  // And the ordinary large case stays cheap, because the trim runs first: two 2000
  // line files differing by one line never reach the table at all.
  const nearly = diffLines(wall("a"), wall("a").replace("a 400", "CHANGED"));
  check("while one changed line in a large file is still one hunk", [nearly.hunks.length, nearly.added], [1, 1]);

  /*
   * Memoised on the event, which is what makes it safe for `buildTail` to ask on
   * every token. The same object back is the observable form of that.
   */
  const event = {
    type: "file_change",
    path: "/w/a.ts",
    oldText: "a\nb",
    newText: "a\nB",
    source: "diff",
    toolCallId: null,
  } as never;
  check("counts are computed once per event", changeCounts(event) === changeCounts(event), true);
  check("and they are the right ones", changeCounts(event), { added: 1, removed: 1 });
}

process.stdout.write("\nwhere a tool call happened\n");
{
  // Two branches, one format, and neither was reached even indirectly: this driver
  // contained no occurrence of `locations` at all. A line number of `null` is the
  // common case (a tool naming a file, not a position in it), and rendering it as
  // `a.ts:null` is exactly the sort of thing that ships.
  check("a location with no line is just the path", formatLocation({ path: "a.ts", line: null }), "a.ts");
  check("and one with a line carries it", formatLocation({ path: "a.ts", line: 12 }), "a.ts:12");
}

/* ------------------------------------------------------------------ *
 * What a tool row says without being opened
 * ------------------------------------------------------------------ */

process.stdout.write("\ntool arguments\n");
{
  /*
   * `readInput` is the single guess at an undocumented shape, shared by the
   * permission card and the transcript. The reported symptom — "clicking a tool
   * shows just {}" — was this function's emptiness hole seen through the second
   * of those two.
   */
  for (const [name, value] of [
    ["an empty object", {}],
    ["an empty array", []],
    ["an empty string", ""],
    ["whitespace", "   "],
    ["null", null],
    ["undefined", undefined],
  ] as const) {
    const got = readInput(value);
    check(`${name} yields no detail at all`, [got.command, got.target, got.pretty, got.truncated], [null, null, null, false]);
  }

  // A command reads as a command. Rendering `{"command": "ls -la"}` and calling it
  // an explanation is most of what made the old row useless.
  check("a command is lifted out of the JSON", readInput({ command: "ls -la" }).command, "ls -la");
  check("and the JSON is not shown beside it", readInput({ command: "ls -la" }).pretty, null);
  check("a bare string is a command", readInput("git status").command, "git status");
  check("trimmed", readInput("  git status  ").command, "git status");

  // The daemon's stand-in. Reporting this as "no arguments" would be a lie about a
  // command that exists and was cut for size.
  const cut = readInput({ truncated: true, bytes: 9000 });
  check("the truncation stand-in is reported as truncated", [cut.truncated, cut.command], [true, null]);

  // A non-empty object with nothing recognisable still shows its arguments.
  check("an unrecognised shape falls back to JSON", readInput({ depth: 3 }).pretty, '{\n  "depth": 3\n}');

  // Rendering a transcript must not be able to throw. A cycle is the easy way to
  // make `JSON.stringify` fail; a throwing `toJSON` is the other.
  const cyclic: Record<string, unknown> = { name: "x" };
  cyclic["self"] = cyclic;
  check("a cyclic value is no detail rather than an exception", readInput(cyclic).pretty, null);
  check("and a throwing toJSON is too", readInput({ toJSON() { throw new Error("no"); } }).pretty, null);

  /*
   * `hasInput` is what decides whether a *later* update's arguments replace the
   * call's own, and it is the reason the tool cards went blank.
   *
   * Measured 2026-07-31 against claude 0.63.0: a `tool_call` arrives with
   * `rawInput: {}` and the command turns up on a `tool_call_update` afterwards. An
   * empty object is not null, so `event.rawInput ?? update.rawInput` keeps the
   * empty one and the command is never shown at all. The rule has to be "is there
   * anything here", and it has to be the same rule the rendering uses — hence one
   * function rather than a second emptiness test.
   */
  check("an empty object has no input", hasInput({}), false);
  check("nor does null", hasInput(null), false);
  check("nor whitespace", hasInput("  "), false);
  check("a command does", hasInput({ command: "ls" }), true);
  check("a path does", hasInput({ file_path: "/a" }), true);
  check("and so does the truncation stand-in", hasInput({ truncated: true, bytes: 9000 }), true);
  // The whole point, stated as the comparison the render makes.
  report(
    "so a later update's arguments win over an empty call",
    !hasInput({}) && hasInput({ command: "echo hi" }),
    "tool_call {} → tool_call_update {command}",
  );
}

/* ------------------------------------------------------------------ *
 * The home screen's ordering
 * ------------------------------------------------------------------ */

process.stdout.write("\nthe session lists\n");
{
  const row = (id: string, over: Record<string, unknown>) => ({
    key: `m/${id}`,
    ref: { machineId: "m", sessionId: id },
    machineName: "m",
    snapshot: { ...snapshot, id, ...over },
    daemonNow: 0,
    fetchedAt: 0,
  });

  const sessions = [
    row("a", { status: "running", lastEventAt: 10 }),
    row("b", { status: "exited", exit: { reason: "stopped" }, lastEventAt: 20 }),
    row("c", { status: "blocked", pendingPermissions: [{ raisedAt: 500 }, { raisedAt: 100 }] }),
    row("d", { status: "blocked", pendingPermissions: [{ raisedAt: 50 }] }),
    row("e", { status: "running", lastEventAt: 30 }),
    /*
     * Placed here, immediately beside `b`, so the two are read together: same
     * `status: "exited"`, opposite outcome, and the *reason* is the only thing
     * separating them. This is the row a `status`-keyed implementation gets
     * wrong, and it is the one an ordinary deploy actually produces — a graceful
     * restart writes `daemon_shutdown`, not `daemon_restarted`.
     */
    row("f", {
      status: "exited",
      exit: { reason: "daemon_shutdown" },
      agentSessionId: "a_f",
      lastEventAt: 25,
    }),
    // The daemon tried and gave up. Active, because somebody has to act — but
    // not counted, because nothing is running.
    row("g", {
      status: "interrupted",
      exit: { reason: "daemon_restarted" },
      agentSessionId: "a_g",
      resume: { state: "failed", attempts: 3, error: { code: "agent_auth_required", message: "no" }, at: 0 },
      lastEventAt: 5,
    }),
    /*
     * The daemon let this one's agent go for being quiet. Beside `b` and `f` for
     * the same reason they are beside each other: it is a third answer to the
     * same question, and the two mistakes available are both silent. Filed as
     * ended it would disappear into a tab nobody opens, taking a conversation
     * somebody is mid-way through with it; counted as live it would put a number
     * beside a green dot for a machine running nothing at all.
     */
    row("h", {
      status: "parked",
      exit: { reason: "parked" },
      agentSessionId: "a_h",
      lastEventAt: 15,
    }),
  ];
  const state = { sessions, machines: [] } as never;
  const lists = sessionLists(state);

  /*
   * **Oldest wait first, and this is the one order in here that is still an
   * order.** `Sheet`'s `WaitingHere` takes `waiting[0]` and means *the one that
   * has been waiting longest*, which is a queue question and nothing to do with
   * where a row is drawn in the rail.
   */
  check("blocked sessions sort by their oldest pending permission", lists.blocked.map((r) => r.snapshot.id), ["d", "c"]);
  /*
   * ⚠ **This read "active sessions sort most-recent first", and that sort is
   * deleted rather than moved.** It was the rail's display order, and a list that
   * rearranged itself on the four-second poll is what the reader's own order
   * replaced (`sessionOrder.ts`). What survives here is which bucket a row lands
   * in, which is as load-bearing as it ever was — so the assertion is set
   * equality, and asserting a sequence again would be pinning arithmetic nothing
   * reads.
   */
  check("the live buckets are memberships rather than orders", lists.active.map((r) => r.snapshot.id).sort(), ["a", "e", "f", "g", "h"]);
  // `b` alone. `f` ended in exactly the same *status* and is not here, which is
  // the whole point: nobody ended it, so calling it ended would be answering a
  // question the reader did not ask.
  check("only a session somebody ended is filed as ended", lists.ended.map((r) => r.snapshot.id), ["b"]);
  // The third row that shares `b`'s "no agent on the other end" and none of its
  // meaning: nobody ended `h` either, so it stays where the reader left it.
  check("a released agent leaves its conversation in Active", lists.active.some((r) => r.snapshot.id === "h"), true);
  check("and a blocked session is never also counted active", lists.active.length + lists.blocked.length, 7);
  /*
   * Five: the four that were live plus `f`, which is a live conversation a few
   * seconds from having an agent again. Not `b` (somebody ended it) and not `g`
   * (the daemon gave up, so nothing is running) — that second exclusion is why
   * `countsAsLive` is a separate question from which list a row lands in.
   */
  check("the machine count is live sessions, not every session", lists.countByMachine.get("m" as never), 5);
  // Still five with `h` added, which is the assertion: a parked conversation is
  // in the list and not in the count, the same split `g` demonstrates from the
  // other side.
  check("and a released agent is in the list without being counted", lists.active.length, 5);
  check("and ended rows are still in the list, just not counted", lists.ended.length, 1);

  // Memoised on the array's identity, which is what makes a streamed event free.
  report("the derivation is memoised by identity", sessionLists(state) === lists, "same object returned");

  check("isTerminal agrees with the split", [isTerminal("running"), isTerminal("exited")], [false, true]);
}

/* ------------------------------------------------------------------ *
 * Enter-to-send
 * ------------------------------------------------------------------ */

process.stdout.write("\nthe composer's send key\n");
{
  const { shouldSend, isTypingInto, isBareKey } = await import("../src/keys.js");

  check("a bare Enter sends", shouldSend({ key: "Enter" }), true);
  check("Shift+Enter is a new line", shouldSend({ key: "Enter", shiftKey: true }), false);
  check("and so is any other modifier", [
    shouldSend({ key: "Enter", metaKey: true }),
    shouldSend({ key: "Enter", ctrlKey: true }),
    shouldSend({ key: "Enter", altKey: true }),
  ], [false, false, false]);
  check("an ordinary letter does nothing", shouldSend({ key: "a" }), false);

  /*
   * The one that is not obvious, and the reason this is a pure function at all.
   *
   * With a Russian, Chinese, Japanese or Korean input method, Enter *commits the
   * candidate being typed* — the text is not in the box yet. A naive
   * `key === "Enter"` sends a half-finished word and swallows the keystroke that
   * was meant to finish it, on every message, for everyone using one of those
   * layouts. There is no way to notice this from a Latin keyboard, which is
   * exactly why it needs an assertion rather than a look.
   */
  check("Enter while an IME is composing does not send", shouldSend({ key: "Enter", isComposing: true }), false);

  // The guard that makes bare-letter shortcuts possible: without it, `j` typed
  // into the composer navigates to another session mid-sentence.
  check("a textarea counts as typing", isTypingInto({ tagName: "TEXTAREA" }), true);
  check("as does an input", isTypingInto({ tagName: "INPUT" }), true);
  check("and a contenteditable", isTypingInto({ tagName: "DIV", isContentEditable: true }), true);
  check("a plain div does not", isTypingInto({ tagName: "DIV" }), false);
  check("and neither does nothing at all", isTypingInto(null), false);
  check("a modifier disqualifies a bare shortcut", isBareKey({ key: "j", metaKey: true }), false);

  /*
   * The digits on the ask card.
   *
   * The number beside each answer used to be decoration under a comment calling
   * it "the number a keyboard would reach for". Wiring it makes the guards
   * load-bearing rather than tidy: the composer sits directly under that card and
   * takes the caret on its own, so a digit that ignored `isTypingInto` would
   * approve whatever the agent was asking with the first character of a message.
   */
  const { optionShortcut } = await import("../src/keys.js");

  check("a digit picks the answer with that number", optionShortcut({ key: "3" }, null, 4), 2);
  check("counting from one, so 1 is the first", optionShortcut({ key: "1" }, null, 4), 0);
  check("past the end it picks nothing", optionShortcut({ key: "5" }, null, 4), null);
  check("and there is no option zero", optionShortcut({ key: "0" }, null, 4), null);
  check("a digit typed into the composer is a digit", optionShortcut({ key: "3" }, { tagName: "TEXTAREA" }, 4), null);
  check("as is one typed into a form field on the card itself", optionShortcut({ key: "3" }, { tagName: "INPUT" }, 4), null);
  check(
    "and every chord is left alone — Shift+1 is a character somebody typed",
    [
      optionShortcut({ key: "3", metaKey: true }, null, 4),
      optionShortcut({ key: "3", ctrlKey: true }, null, 4),
      optionShortcut({ key: "3", altKey: true }, null, 4),
      optionShortcut({ key: "1", shiftKey: true }, null, 4),
      optionShortcut({ key: "3", isComposing: true }, null, 4),
    ],
    [null, null, null, null, null],
  );
  check("a card with no answers has no shortcuts", optionShortcut({ key: "1" }, null, 0), null);
  check("a letter is not a shortcut here", optionShortcut({ key: "j" }, null, 4), null);

  const { completionKey } = await import("../src/keys.js");

  check("the menu walks on the arrows", [completionKey({ key: "ArrowDown" }), completionKey({ key: "ArrowUp" })], ["next", "prev"]);
  check("Enter and Tab both choose", [completionKey({ key: "Enter" }), completionKey({ key: "Tab" })], ["choose", "choose"]);
  check("Escape dismisses", completionKey({ key: "Escape" }), "dismiss");
  check("an ordinary letter is left to the textarea", completionKey({ key: "a" }), null);

  /*
   * The same IME defect, arriving through a new door.
   *
   * Enter commits an input-method candidate, so a menu that read it as a
   * selection would insert a command instead of finishing a word — identical in
   * shape and invisibility to the send bug above, and not prevented by that one:
   * this function runs *first*, so it has to carry its own guard.
   */
  check("Enter while an IME is composing chooses nothing", completionKey({ key: "Enter", isComposing: true }), null);
  // Shift+Enter stays a newline and Shift+Tab stays focus-backwards, whether or
  // not a suggestion list happens to be on screen.
  check("and a shifted Enter or Tab is left alone", [
    completionKey({ key: "Enter", shiftKey: true }),
    completionKey({ key: "Tab", shiftKey: true }),
  ], [null, null]);

  /*
   * The collision, asserted *as* a collision.
   *
   * Enter is the one key both functions claim, which is why the order inside
   * `Composer`'s handler is load-bearing rather than incidental — and it is
   * load-bearing for exactly one key, which is the half that keeps it safe.
   */
  check("Enter is the one key both claim", [shouldSend({ key: "Enter" }), completionKey({ key: "Enter" })], [true, "choose"]);
  check("and the menu's other keys never send", [
    shouldSend({ key: "ArrowDown" }),
    shouldSend({ key: "ArrowUp" }),
    shouldSend({ key: "Tab" }),
    shouldSend({ key: "Escape" }),
  ], [false, false, false, false]);

  /*
   * And the *resolution*, which is the half that was claimed and not asserted.
   *
   * The two checks above establish that a collision exists; they stay green with
   * the composer's two blocks in either order, and reversing them sends a
   * half-typed message instead of completing a command. `composerKey` is that
   * ordering moved somewhere it can be pinned.
   */
  const { composerKey } = await import("../src/keys.js");

  check("with the menu open, Enter completes", composerKey({ key: "Enter" }, true, true), "choose");
  check("with it closed, Enter sends", composerKey({ key: "Enter" }, false, true), "send");
  check("the arrows only mean anything to the menu", [
    composerKey({ key: "ArrowDown" }, true, true),
    composerKey({ key: "ArrowDown" }, false, true),
  ], ["next", null]);
  check("and Escape likewise", [
    composerKey({ key: "Escape" }, true, true),
    composerKey({ key: "Escape" }, false, true),
  ], ["dismiss", null]);
  // The IME guard survives the merge in both directions, which is the thing that
  // would otherwise quietly move house rather than be fixed.
  check("an IME candidate neither completes nor sends", [
    composerKey({ key: "Enter", isComposing: true }, true, true),
    composerKey({ key: "Enter", isComposing: true }, false, true),
  ], [null, null]);
  // Shift+Enter is a newline whether or not a suggestion list happens to be up.
  check("a shifted Enter is left to the textarea, menu or no menu", [
    composerKey({ key: "Enter", shiftKey: true }, true, true),
    composerKey({ key: "Enter", shiftKey: true }, false, true),
  ], [null, null]);

  /*
   * ⭐ **The soft keyboard, which is the whole of the mobile rule.**
   *
   * A phone has no Shift+Enter, so with Enter sending there was no way to type a
   * newline at all and the composer grew a `↵` button beside the box to do it —
   * one that appended to the *end* of the draft whatever the caret was doing.
   * `enterSends` replaces the button: false hands the keystroke back to the
   * textarea, which breaks the line at the caret like any other character.
   *
   * The menu is asserted **against** the pointer rather than beside it, because
   * that is the pair that can be got wrong in a way nothing else notices: typing
   * `/model` on a phone and pressing Return has to choose the command, and a
   * naive `if (!enterSends) return null` at the top of the function would insert a
   * line break into the draft instead and leave the menu open over it.
   */
  check("on a soft keyboard Enter is a newline rather than a send", composerKey({ key: "Enter" }, false, false), null);
  check("but the menu still takes it there", composerKey({ key: "Enter" }, true, false), "choose");
  check("and so do the keys the menu owns", [
    composerKey({ key: "ArrowDown" }, true, false),
    composerKey({ key: "Escape" }, true, false),
  ], ["next", "dismiss"]);

  /*
   * Both halves of that rule live in `Composer.tsx` and neither is reachable from
   * a pure function: the pointer read is a `matchMedia` at the keystroke, and the
   * hint is an attribute. Read off disk, in the `gateOffer`/`showsGateLink` style
   * — the button being deleted is the *point*, so its absence is the assertion.
   */
  {
    const composer = readFileSync(new URL("../src/ui/Composer.tsx", import.meta.url), "utf8");
    check("the newline button is gone", /CornerDownLeft/.test(composer), false);
    // Unconditional, because a virtual keyboard is the only thing that reads it —
    // so there is no pointer question here and nothing that can go stale.
    check("and the soft Return key is drawn as one", /enterKeyHint="enter"/.test(composer), true);
    // The leading `!` is what distinguishes this from `shouldFocusComposer`'s own
    // read one screenful up, which passes the same query the other way round.
    check(
      "the pointer is read at the keystroke and negated into `enterSends`",
      /!window\.matchMedia\("\(pointer: coarse\)"\)\.matches/.test(composer),
      true,
    );
  }

  /*
   * **One box, and the four facts that make it one.**
   *
   * There is no DOM here and no component renderer anywhere in this repository,
   * so a container is a class string like every other layout rule — and Tailwind
   * v4 emits *nothing at all* for a token it does not recognise, with no error and
   * no failing build. Read off disk in the `CornerDownLeft` style, where an
   * absence is the assertion.
   */
  {
    const composer = readFileSync(new URL("../src/ui/Composer.tsx", import.meta.url), "utf8");
    const bar = readFileSync(new URL("../src/ui/AgentConfigBar.tsx", import.meta.url), "utf8");
    // Comment-stripped for both reads below. The strip's own docblocks name
    // `ContextPie` and `<form>` and `type="submit"` while explaining why each is
    // gone or guarded against, and an assertion that cannot tell prose from code
    // would be answered by the sentence describing the thing it is looking for.
    const barCode = stripComments(bar);

    // The box carries the boundary, and the field inside it carries none. Both
    // halves, because either one alone is satisfied by a composer with no border
    // anywhere — which is a field nothing says is a field.
    check(
      "the composer's box is the bounded control",
      /className=\{`relative rounded-xl border border-edge-strong/.test(composer),
      true,
    );
    /*
     * **And the box is the `<form>`, which is what puts every control under a
     * default `type="submit"`.** Asserted so the sweep two blocks down is read as
     * load-bearing rather than as belt-and-braces: it was the second guard while
     * a smaller `<form>` sat inside a `<div>` box, and Send moving into the
     * control row spent that, a submit button having to be inside what it submits.
     */
    check(
      "and it is the form, so nothing under it may default to submit",
      /<form\n\s+onSubmit=\{submit\}\n\s+className=\{`relative rounded-xl/.test(composer),
      true,
    );
    check(
      "and the textarea inside it draws neither a border nor a fill",
      /className="no-focus-ring block min-h-11 w-full resize-none overflow-hidden bg-transparent/.test(composer),
      true,
    );
    // The caret is a text control's own focus indicator; `no-focus-ring` is the
    // opt-out `index.css` grants for exactly that, and the box must not grow a
    // second one now that it is the visible chrome.
    check("the box looks the same focused and not", /focus-within:/.test(composer), false);

    /*
     * **The paperclip is the composer's, and the strip has no `leading` slot to
     * put it back in.** That is what retires `configBarShows`: its third clause
     * existed to keep a bar alive for the paperclip's sake, and a control that is
     * not in the bar cannot be lost with it.
     */
    check("the composer draws its own paperclip", /icon={Paperclip}\n\s+label="Attach a file"/.test(composer), true);
    check("beside the strip rather than inside it", /<AgentConfigBar/.test(composer), true);
    check("and hands it no `leading` node", /leading=/.test(composer), false);

    // The readout is gone from the client. The daemon still sends the field —
    // `webcheck.plugin-protocol.ts` pins `contextUsage` on the client's mirror of
    // the snapshot, and that assertion is now the only thing holding it there.
    check("no context readout is drawn", /ContextPie/.test(barCode), false);

    /*
     * ⚠ **Every button in the strip names its type, and the cost of one that does
     * not is a sent message.** A bare `<button>` defaults to `type="submit"`;
     * these sit inside the composer's box, one refactor away from being inside its
     * `<form>`, at which point tapping the model chip sends the draft. The box is
     * a `<div>` precisely so that is not the only thing standing between the two,
     * and this is the other half.
     *
     * Comments are stripped first: they name `<form>` and `type="submit"` while
     * explaining exactly this, and a scan that stops at the first `>` finds the
     * one inside the prose.
     */
    {
      const typeless = [...barCode.matchAll(/<button\b/g)]
        .map((match) => barCode.slice(match.index, barCode.indexOf(">", match.index)))
        .filter((tag) => !/\btype=/.test(tag));
      check("no button in the strip can submit a form by default", typeless, []);
      // Not trivially true: the property is worth nothing if the scan found none.
      check("and the scan found the buttons", [...barCode.matchAll(/<button\b/g)].length >= 4, true);
      /*
       * The same sweep over `Composer.tsx`, where the answer today is that there
       * are no hand-rolled buttons at all — everything goes through `IconButton`,
       * which defaults `type` to `"button"` itself. Asserted as an emptiness so
       * the first one written by hand has to answer this rather than inherit a
       * submit from the box it is inside.
       */
      const composerCode = stripComments(composer);
      const composerTypeless = [...composerCode.matchAll(/<button\b/g)]
        .map((match) => composerCode.slice(match.index, composerCode.indexOf(">", match.index)))
        .filter((tag) => !/\btype=/.test(tag));
      check("nor anything hand-rolled in the composer itself", composerTypeless, []);
    }

    /*
     * **The picker draws twice and a class chooses, which is `AppShell`'s rule
     * for this app reaching one control further in.**
     *
     * Below `sm` the model chip leaves the row and its choices fold into the mode
     * picker; above it the chip is back and the picker holds only what it always
     * did. Both renderings are in the document at once and `display` decides —
     * never a measurement in JavaScript, so a window dragged across the breakpoint
     * cannot draw a row that is not there.
     *
     * Read off disk because every one of these is a word in a class string, and
     * Tailwind emits **nothing at all** for a token it does not recognise: a typo
     * here fails silently, with no error and a passing build.
     */
    check(
      "the model chip is folded by a class rather than by a measurement",
      /foldedBelowSm\.length > 0 \? "hidden sm:contents" : "contents"/.test(barCode),
      true,
    );
    /*
     * ⚠ **And it folds only where there is somewhere to fold into.** The mode
     * control is not guaranteed — an agent may publish none, and one drawn from
     * memory arrives in `unavailable`, where `Absent` draws no nested sections at
     * all. Either way a chip hidden below `sm` would put its choices nowhere: a
     * control unreachable on a phone, silently, which is what "a control never
     * leaves the strip" is written against. `splitOptions` makes the same test for
     * `nested`, and this is that rule applied to the same host.
     */
    check(
      "and only where a live mode control exists to fold into",
      /category === NESTED_HOST && one\.kind !== "boolean" && !unavailable\.has\(one\.id\)/.test(barCode),
      true,
    );
    check(
      "and nothing in the strip asks the window how wide it is",
      /matchMedia|innerWidth|ResizeObserver/.test(barCode),
      false,
    );
    // The pair, because either one alone is satisfied by a picker that draws both
    // presentations at every width — which is two menus open at once.
    check("the anchored panel is the wide one", /hidden w-60 max-w-\[calc\(100vw-1\.5rem\)\] sm:block/.test(barCode), true);
    check("and the sheet is the narrow one", /flex touch-manipulation flex-col justify-end bg-fg\/25 sm:hidden/.test(barCode), true);
    /*
     * ⚠ **And the sheet is not `Sheet`.** That component sets `inert` on `#root`
     * the moment it mounts, which a `display` class cannot gate — so a `Sheet`
     * here would lock the whole app behind an invisible panel every time somebody
     * opened a popover on a desktop. The picker registers as a `menu`, which
     * `overlay.ts` deliberately does not count when it decides whether to inert.
     */
    check("the picker registers as a menu and never as a sheet", /useDismissible\("sheet"/.test(barCode), false);
    check("so nothing here can make the app inert", /inert/.test(barCode), false);
    /*
     * Two copies of one list in one document, so every id either presentation
     * generates has to name which one it is in. Without this the refusal line
     * carries the same id twice and `aria-describedby` resolves to whichever the
     * browser reaches first, which on a phone is the hidden one.
     */
    check("an id says which presentation it is in", /\$\{where\}-\$\{option\.id\}-refusal/.test(barCode), true);
    /*
     * ⚠ **And the outside-press listener knows about both boxes**, which is the
     * one thing a portal breaks silently. The sheet is rendered into
     * `document.body`, so it is outside the anchored panel's `boxRef` by
     * construction: tested against that alone, every tap *inside* the sheet — a
     * row included — was an outside press, closing the picker on `pointerdown`
     * before the `click` that would have chosen the value landed. The control did
     * nothing at all on a phone, silently, which is the failure this listener is
     * a `pointerdown` rather than a `blur` in order to avoid.
     */
    check(
      "the outside-press test covers the portalled sheet as well as the panel",
      /boxRef\.current\?\.contains\(target\) === true \|\| sheetRef\.current\?\.contains\(target\) === true/.test(barCode),
      true,
    );
    // The scrim is outside that ref on purpose: a press on it has to close.
    check("and the ref is on the panel rather than on the scrim", /ref=\{sheetRef\}\n\s+onPointerDown=/.test(barCode), true);

    /*
     * ⚠ **The sheet leaves the way it arrived, and the two clocks that make that
     * true are in two files.** There is no route here, so nothing wraps the
     * unmount in a view transition the way `sheet-close` does for the routed
     * pop-ups: the picker keeps itself mounted for `SHEET_EXIT_MS` and plays the
     * arrival keyframe in reverse. A timer shorter than the animation cuts the
     * slide off mid-travel; a longer one leaves a finished panel on the screen
     * waiting to be unmounted. Neither is visible to a compiler, and the CSS half
     * is a custom property Tailwind emits no error for.
     */
    {
      const css = readFileSync(new URL("../src/index.css", import.meta.url), "utf8");
      const declared = /--animate-sheet-out: sheet-out (\d+)ms/.exec(css)?.[1];
      const timed = /const SHEET_EXIT_MS = (\d+);/.exec(barCode)?.[1];
      check("both halves of the exit were found", [declared !== undefined, timed !== undefined], [true, true]);
      check("and the unmount waits exactly as long as the animation", timed, declared);
      /*
       * ⚠ **And the exit may never name the arrival's keyframes**, which is the
       * assertion this section was missing and the defect it cost.
       *
       * `--animate-sheet-out` was `sheet … reverse` — one description of one
       * movement, which is what the routed sheet's own close rule does — and it
       * never played. An element keeps its running animation for as long as the
       * `animation-name` list is unchanged, so swapping the class on the same node
       * edited the direction and fill of an animation that had finished 260ms
       * earlier instead of starting one, leaving it in its after phase holding what
       * reversal had made the last frame: the 0% keyframe, off the bottom of the
       * screen. The sheet vanished in one frame with the utility emitted, the
       * durations agreeing and every check green — the eye was the only thing that
       * could see it, and only on a phone.
       *
       * Both halves are asserted: that each exit names keyframes of its own and
       * that those keyframes exist. Either alone passes for a token Tailwind emits
       * nothing for.
       */
      check(
        "the sheet's exit has keyframes of its own",
        [/--animate-sheet-out: sheet-out /.test(css), /@keyframes sheet-out \{/.test(css)],
        [true, true],
      );
      check(
        "and so does the scrim's",
        [/--animate-scrim-out: scrim-out /.test(css), /@keyframes scrim-out \{/.test(css)],
        [true, true],
      );
      check(
        "neither exit is the arrival's own name replayed",
        /--animate-(?:sheet|scrim)-out: (?:sheet|scrim) /.test(css),
        false,
      );
      /*
       * The panel goes at once and the sheet stays: they are two presentations of
       * one control and only one of them is animated out. Gated on `leaving` in
       * the markup, which is the only place that distinction exists.
       */
      check("the anchored panel does not linger", /\{open && !leaving && \(/.test(barCode), true);
    }

    /*
     * **The sheet's head is pinned and the sheet has two detents**, and every part
     * of that is a class this driver is the only reader of.
     *
     * It was one `overflow-y-auto` panel with the grab bar as its first child, so
     * the bar scrolled away with the first screenful of a model list — the one
     * screen where somebody is scrolling — and advertised a gesture that did
     * nothing. The bar is now a flex sibling of the scroller rather than a child of
     * it, which is the whole of why it stays, and a real button: tap to change
     * detent, drag to do the same.
     */
    check(
      "the grab bar is a button rather than a decoration",
      /aria-expanded=\{expanded\}\n\s+className=\{`tap relative flex min-h-8 shrink-0 touch-none/.test(barCode),
      true,
    );
    /*
     * ⚠ **And it is 32px of head reaching 44px of target**, the chips' own
     * arrangement through the same measured constant. A flat `min-h-11` put twenty
     * pixels of nothing between the sheet's top edge and a 4px bar, which was
     * reported as too much room above the grabber; growing instead of padding buys
     * the room back without dropping under the target this app holds everything to.
     */
    check("and it reaches 44px by growing rather than by padding", /justify-center \$\{TAP_GROW_Y\}`\}/.test(barCode), true);
    /*
     * ⚠ **The panel may never be the scroller**, which is the single class that
     * puts the bar back inside a scroll and is one careless edit away at all times.
     * Asserted as an absence on the panel and a presence on the list, because
     * either alone is satisfied by a sheet that scrolls in two places at once.
     */
    check(
      "and the panel clips rather than scrolls",
      /flex w-full flex-col overflow-hidden overscroll-contain rounded-t-2xl/.test(barCode),
      true,
    );
    check(
      "the rows scroll only once the sheet is full",
      /expanded \? "flex-1 overflow-y-auto" : "touch-none overflow-hidden"/.test(barCode),
      true,
    );
    /*
     * The two detents, in `dvh`. `vh` on a phone is the viewport with the browser
     * chrome retracted, so a sheet sized in it hides its own last rows under the
     * address bar — and the last rows here are the ones somebody opened the sheet
     * to reach. `SHEET_FULL` is `SHEET_PANEL`'s phone height, so the two kinds of
     * sheet in this app agree about what full means.
     */
    {
      const css = readFileSync(new URL("../src/index.css", import.meta.url), "utf8");
      /*
       * The resting detent lives in the CSS as a *default*, not in the component:
       * at rest the gesture has written nothing at all, so "rest" is the absence of
       * every property it can write and cannot drift from what this file says.
       */
      check(
        "rest is a default in the stylesheet rather than a class on the panel",
        [/--sheet-max, 60dvh/.test(css), /--sheet-min, 0/.test(css), /--sheet-h, auto/.test(css)],
        [true, true, true],
      );
      check("and the full detent is the routed sheets' phone height", /const SHEET_FULL = "92dvh";/.test(barCode), true);
      /*
       * ⚠ **Opening writes `--sheet-min` and not only `--sheet-max`**, which is the
       * whole difference between a picker that can be pulled open and one that
       * cannot: a cap does nothing to a panel already shorter than it, so the effort
       * control — four rows, never near the resting cap — ignored the gesture while
       * the model control obeyed it. Two chips on one row answering one drag
       * differently is the defect; the space under four rows in a sheet somebody
       * deliberately opened is not.
       */
      check(
        "a short picker can be pulled open too",
        /"--sheet-min": SHEET_FULL, "--sheet-max": SHEET_FULL/.test(barCode),
        true,
      );
      /*
       * And the panel carries no `style` prop, which is what keeps one writer on
       * these properties. Two would settle by emission order, which is the same
       * trap `AppShell` keeps an inline width off its `<aside>` to avoid.
       */
      check("the geometry has exactly one writer", /ref=\{sheetRef\}[\s\S]{0,2000}?style=/.test(barCode), false);
      check("and the panel wears the class that declares it", /className=\{`config-sheet pb-safe/.test(barCode), true);
    }
    /*
     * ⚠ **And the fraction the gesture compares against is the class's own number.**
     * A drag has to know where "full" is in pixels and CSS will not say, so 92 is
     * written twice — once as `92dvh` and once as `0.92` — and this is what keeps
     * them one number. Drift here is invisible: the sheet simply settles a little
     * short of, or past, the height it then snaps to when the inline height clears.
     */
    {
      const share = /const SHEET_FULL_SHARE = ([\d.]+);/.exec(barCode)?.[1];
      const dvh = /const SHEET_FULL = "(\d+)dvh";/.exec(barCode)?.[1];
      check("both spellings of the full detent were found", [share !== undefined, dvh !== undefined], [true, true]);
      check("and they are the same height", share, dvh === undefined ? undefined : String(Number(dvh) / 100));
    }
    /*
     * **The panel follows the finger**, which is three things: a height measured at
     * `pointerdown` rather than tracked, a per-move subtraction against it, and the
     * transition switched off for the length of the gesture. It changed detent on
     * its own for one round — a button worked by swiping, moving a distance that had
     * nothing to do with the distance dragged.
     */
    check(
      "the drag reads where the panel is when it starts",
      /height: panel\.getBoundingClientRect\(\)\.height/.test(barCode),
      true,
    );
    check(
      "and every move is that height less the travel",
      /const wanted = from\.height - travelled;/.test(barCode),
      true,
    );
    check("with the settle off while the finger is down", /settling\(false\);\n\s+paint\(\{\n\s+"--sheet-min": "0px"/.test(barCode), true);
    /*
     * ⚠ **And the *end* of the settle is a write that may not animate**, which is
     * the bounce this section did not have an assertion for. Handing the height
     * back to `.config-sheet`'s defaults changes `min-height` and `max-height`,
     * both animated: settling a long list back to rest sent `--sheet-max` from
     * 92dvh to the 60dvh default over 300ms while the pixel height was cleared in
     * the same frame, so the panel sprang to full and shrank back — and a short
     * picker opening did the mirror of it. Reported as *"it goes back to where it
     * started and then winds round again"*. `paintNow` is that write, and both arms
     * of the settle have to take it.
     */
    check(
      "and the hand-off back to the defaults lands in one frame",
      barCode.match(/paintNow\(\{/g)?.length,
      2,
    );
    check(
      "with the animation put back a frame later rather than immediately",
      /restore\.current = window\.requestAnimationFrame\(\(\) => \{\n\s+restore\.current = null;\n\s+settling\(true\);/.test(barCode),
      true,
    );
    /*
     * ⚠ **And that frame is cancellable.** A gesture starting inside it would have
     * its transition switched back on underneath it — a drag that chases the finger
     * rather than following it, intermittently, and only ever just after a previous
     * one. `settling` cancels any pending restore before it writes.
     */
    check(
      "a gesture inside that frame cancels it rather than inheriting it",
      /window\.cancelAnimationFrame\(restore\.current\);\n\s+restore\.current = null;/.test(barCode),
      true,
    );
    /*
     * The transition itself is a literal in the stylesheet and is switched off
     * inline, never through a custom property inside the shorthand: a `var()` there
     * makes every longhand a pending-substitution value, which is a thin place in
     * more than one engine and harder to reason about than a number.
     */
    check(
      "the transition is switched off inline rather than substituted",
      [/panel\.style\.transition = on \? "" : "none";/.test(barCode), /--sheet-settle/.test(barCode)],
      [true, false],
    );
    /*
     * ⚠ **And the gesture never goes through React.** A pointer moves sixty times a
     * second and a render here is every row of the open picker — 362 of them on
     * opencode, each a `<button>` — so state would have the panel arriving where
     * the finger had been. `AppShell`'s rail settled this for the same gesture one
     * control out; this is that rule applied again, and the assertion is the one
     * that would catch a well-meaning rewrite into `useState`.
     */
    check("the drag writes those properties directly", /panel\.style\.setProperty\(name, value\)/.test(barCode), true);
    check(
      "and the only render it costs is the list's detent",
      barCode.match(/setExpanded\(/g)?.length,
      3,
    );
    /*
     * Below the resting height the panel stops shortening and slides, or the rows
     * would be eaten from the bottom while the box stayed where it was. Both arms
     * come off one `wanted`, so the hand-off has no step in it.
     */
    check(
      "and below rest it slides rather than shortening",
      /\{ height: rest, below: rest - wanted \}/.test(barCode),
      true,
    );
    /*
     * ⚠ **The settle's two clocks, in two files**, the same pairing `SHEET_EXIT_MS`
     * has: the timer is what hands the panel's height back to its detent classes,
     * so a short one cuts the settle off and a long one leaves an inline pixel
     * height pinning a sheet that has stopped moving.
     */
    {
      const css = readFileSync(new URL("../src/index.css", import.meta.url), "utf8");
      const declared = /\.config-sheet \{[\s\S]*?transition:\n\s+height (\d+)ms/.exec(css)?.[1];
      const timed = /const SHEET_SETTLE_MS = (\d+);/.exec(barCode)?.[1];
      check("both halves of the settle were found", [declared !== undefined, timed !== undefined], [true, true]);
      check("and the height goes back to its classes exactly when it lands", timed, declared);
    }
    /*
     * ⚠ **A release the panel never hears is a gesture that never ends**, and a
     * sheet left pinned to a pixel height with its transition switched off. An
     * uncaptured pointer lifted outside the window delivers `pointerup` to nothing
     * this component renders, so the panel captures — but **only once the drag has
     * engaged**, because capture retargets the compatibility `click` too and a tap
     * on a row needs its own to arrive where it was aimed.
     */
    check(
      "a release outside the viewport still ends the drag",
      /dragged\.current = true;[\s\S]{0,900}?sheetRef\.current\?\.setPointerCapture\(event\.pointerId\)/.test(barCode),
      true,
    );
    check("and nothing is captured before it engages", /onPointerDown[\s\S]{0,200}setPointerCapture/.test(barCode), false);
    /*
     * Opening is always at rest, and **nothing inline survives it**: a picker that
     * reopened full-height because it was left that way would cover the message it
     * is being opened for, and a pixel height left over from a drag would be
     * inherited by whichever control this component draws next.
     */
    check(
      "a reopened picker is back at rest, with nothing carried over",
      /atRest\(\);\n\s+setExpanded\(false\);\n\s+setOpen\(true\);/.test(barCode),
      true,
    );
    // And `atRest` is the absence of every property, not a second spelling of the
    // defaults: a value written here is one the stylesheet can no longer correct.
    check(
      "and rest is written as nothing rather than as numbers",
      /const atRest = \(\): void =>\n\s+paint\(\{\n\s+"--sheet-h": null,\n\s+"--sheet-y": null,\n\s+"--sheet-min": null,\n\s+"--sheet-max": null,\n\s+\}\);/.test(barCode),
      true,
    );
    /*
     * ⚠ **And the click a drag leaves behind is swallowed.** A touch that ends
     * without the browser having scrolled anything still fires a `click` on
     * whatever was under it, and at rest that is a model row — so dragging the
     * sheet shut would also switch the model. One capture-phase guard on the panel
     * rather than a flag each row has to remember to read.
     */
    check(
      "a drag never also chooses the row it started on",
      /onClickCapture=\{\(event\) => \{\n\s+if \(!dragged\.current\) return;/.test(barCode),
      true,
    );
    // The move is on the scrim, which is the whole viewport: a finger that leaves
    // the panel on the way up keeps moving it.
    check(
      "the move is heard across the whole screen",
      /onPointerMove=\{dragMove\}\n\s+onPointerUp=\{\(event\) => dragEnd\(event\.pointerId\)\}/.test(barCode),
      true,
    );
    /*
     * Every section heading carries the chip's own glyph. One lookup — `label` —
     * for the strip and for both presentations of the menu, so what opens a menu
     * and what heads it cannot come to disagree about what a control looks like.
     */
    check(
      "a section heading is drawn with the same glyph its chip is",
      barCode.match(/<p className=\{`\$\{MENU_HEADING\} flex items-center gap-1\.5`\}>\n\s+\{label\(option\)\}/g)?.length,
      2,
    );
  }
}

/* ------------------------------------------------------------------ *
 * The agent's controls
 * ------------------------------------------------------------------ */

process.stdout.write("\nthe agent config bar reads categories, not ids\n");
{
  /*
   * Not a render test — there is no DOM here — but the thing that would actually
   * break is not the markup, it is the assumption that a control can be found by
   * its id. Claude publishes reasoning effort as `effort` with values
   * `default|low|…|max`; kimi publishes the same concept as `thinking` with
   * values `off|…`. The two share nothing but `category`, so this asserts that a
   * lookup by category finds both and a lookup by id finds one.
   */
  const claude = [
    { id: "mode", name: "Mode", description: null, category: "mode", kind: "select", value: "default", choices: [] },
    { id: "model", name: "Model", description: null, category: "model", kind: "select", value: "opus", choices: [] },
    { id: "effort", name: "Effort", description: null, category: "thought_level", kind: "select", value: "high", choices: [] },
  ];
  const kimi = [
    { id: "model", name: "Model", description: null, category: "model", kind: "select", value: "k2", choices: [] },
    { id: "thinking", name: "Thinking", description: null, category: "thought_level", kind: "select", value: "off", choices: [] },
    { id: "mode", name: "Mode", description: null, category: "mode", kind: "select", value: "yolo", choices: [] },
  ];

  const byCategory = (options: typeof claude, category: string) =>
    options.find((option) => option.category === category)?.value ?? null;

  check("effort is found on claude by category", byCategory(claude, "thought_level"), "high");
  check("and on kimi, whose id is different", byCategory(kimi, "thought_level"), "off");
  check(
    "a lookup by claude's id finds nothing on kimi",
    kimi.find((option) => option.id === "effort") ?? null,
    null,
  );
  check("mode is found on both", [byCategory(claude, "mode"), byCategory(kimi, "mode")], ["default", "yolo"]);

  /*
   * And the *label*, which is the same disagreement one layer further out.
   *
   * Finding the control by category was never enough on its own: measured
   * 2026-08-04 against the live agents, claude calls it `Effort` and kimi calls
   * the identical control `Thinking` (`category: "thought_level"`, choices
   * Low/High/Max). So the strip said one word and the `/` menu — which already
   * synthesizes this control as `/effort` on both agents, off the same category —
   * said another, one tap apart.
   *
   * Narrow on purpose, and the table has exactly the entries a measurement put
   * there. `model` is `Model` on all four agents, so there is nothing to reconcile
   * and the agent's own name stands; an unknown category has no second opinion at
   * all. Overriding a name we have no better version of is how a client starts
   * inventing vocabulary.
   *
   * `mode` is the second entry and it arrived with the fourth agent. Measured
   * 2026-08-27: claude and kimi publish `Mode` and opencode publishes
   * `Session Mode` for the identical control — a second word on the one chip that
   * spends width on its name *and* its value, on a phone, for a control reached
   * for several times an hour.
   */
  const effortOf = (options: typeof claude) =>
    labelFor(options.find((o) => o.category === "thought_level") as never);
  check("the effort control is called the same thing on both agents", [effortOf(claude), effortOf(kimi)], [
    "Effort",
    "Effort",
  ]);
  check(
    "a control every agent already agrees about keeps its own name",
    labelFor(claude[1] as never),
    "Model",
  );
  check("and the mode control is one word on all four", [
    labelFor(claude[0] as never),
    labelFor(kimi[2] as never),
    labelFor({ category: "mode", name: "Session Mode" }),
  ], ["Mode", "Mode", "Mode"]);
  check(
    "and so does one nobody has a second word for",
    labelFor({ category: "unheard_of", name: "Whatever" }),
    "Whatever",
  );
  /*
   * The negative control that makes the one above mean something: this table is
   * keyed on the *category* and never on the string, so the same words under a
   * category nobody has reconciled are left exactly as the agent said them.
   */
  check(
    "and the reconciliation is by category, not by recognising the words",
    labelFor({ category: "unheard_of", name: "Session Mode" }),
    "Session Mode",
  );

  /* ---------------------------------------------------------------- *
   * What one choice is called
   *
   * ⭐ Three surfaces name a choice — the chip, the control's menu row and the
   * `/` menu's second stage — and each held its own copy of
   * `override?.label ?? choice.name`. `choiceLabel` is the one place now, and it
   * carries the second half too: measured 2026-08-27, claude publishes `Auto`,
   * `Manual`, `Accept Edits`; kimi publishes `Default`, `Plan`, `Auto`, `YOLO`;
   * opencode publishes `build` and `plan`. One list, Title Case on three agents
   * and lower case on the fourth.
   * ---------------------------------------------------------------- */
  const modeChoice = (value: string, name: string) => ({ value, name, description: null, group: null });
  check(
    "a mode an agent published in lower case is drawn with a capital",
    [
      choiceLabel({ category: "mode" }, modeChoice("build", "build")),
      choiceLabel({ category: "mode" }, modeChoice("plan", "plan")),
    ],
    ["Build", "Plan"],
  );
  check(
    "and one that already has one is untouched, letter for letter",
    [
      choiceLabel({ category: "mode" }, modeChoice("yolo", "YOLO")),
      choiceLabel({ category: "mode" }, modeChoice("acceptEdits", "Accept Edits")),
      choiceLabel({ category: "mode" }, modeChoice("plan", "Plan Mode")),
    ],
    ["YOLO", "Accept Edits", "Plan Mode"],
  );
  /*
   * The cases where there is no upper case to reach for. All one branch, because
   * the test is against the character itself rather than a category of character:
   * "there is no upper case of this" and "this is already upper case" are the same
   * answer, so a digit, a bracket and an emoji need no arm of their own.
   */
  check(
    "and a name with no capital to give is returned as it came",
    [
      choiceLabel({ category: "mode" }, modeChoice("a", "")),
      choiceLabel({ category: "mode" }, modeChoice("b", "3.5-turbo")),
      choiceLabel({ category: "mode" }, modeChoice("c", "(default)")),
      choiceLabel({ category: "mode" }, modeChoice("d", "\u{1f680} launch")),
    ],
    ["", "3.5-turbo", "(default)", "\u{1f680} launch"],
  );
  /*
   * ⚠ **Only `mode`.** A model's name is a proper noun somebody else owns —
   * `gpt-5.6-sol` is not improved by a capital — and every agent that publishes an
   * effort control, opencode included, already capitalises its levels. Narrowing
   * this the way `chipValue` narrows its own rule to `model` is what keeps one
   * measured disagreement from becoming a client that cases everything it is told.
   */
  check(
    "and no other category is cased at all",
    [
      choiceLabel({ category: "model" }, modeChoice("gpt-5.6-sol", "gpt-5.6-sol")),
      choiceLabel({ category: "thought_level" }, modeChoice("low", "low")),
      choiceLabel({ category: "unheard_of" }, modeChoice("x", "whatever")),
      choiceLabel({ category: null }, modeChoice("y", "whatever")),
    ],
    ["gpt-5.6-sol", "low", "whatever", "whatever"],
  );
  /*
   * And the one rename outranks the casing, so `default` keeps the answer
   * `choiceOverride` measured for it rather than being capitalised into a word
   * that still says nothing.
   */
  check(
    "a value this client does rename is renamed, not merely capitalised",
    [
      choiceLabel({ category: "thought_level" }, modeChoice("default", "Default")),
      choiceLabel({ category: "mode" }, modeChoice("default", "default")),
    ],
    ["Adaptive", "Default"],
  );

  /* ---------------------------------------------------------------- *
   * A prefix every row repeats is no prefix at all
   *
   * ⭐ Reported from the app: "opencode models are added to the openrouter models
   * at the bottom". Measured 2026-08-27 off the live log — opencode publishes ONE
   * model control with 362 choices, `group: null` on every one: 356 named
   * `OpenRouter/<model>` and then six named `OpenCode Zen/<model>`. Two accounts,
   * two keys, one undivided list, and the word `OpenRouter` printed 356 times in
   * front of the only part of each row that differs.
   *
   * ⭐ Reported next, of the menu that produced: "take out the *OpenCode Zen* line
   * and the others". The heading is gone and the shortening stayed — and the
   * condition had to tighten with it, which is what most of this section is about.
   * With a heading, a prefix agreed across one namespace could be cut because the
   * heading put it back; with nowhere to put it back, only a prefix **every row of
   * the control** carries may be removed, since that is the only text whose removal
   * cannot make two rows read alike.
   *
   * ⚠ This is NOT the per-vendor split that was built and removed by name
   * (Q3.507). That divided one provider's catalogue into 38 groups by parsing
   * vendors out of ids; this removes a word the agent itself repeated on every row.
   * ---------------------------------------------------------------- */
  const choice = (value: string, name: string, group: string | null = null) => ({
    value,
    name,
    description: null,
    group,
  });
  /*
   * One provider's catalogue, which is what a session's model control actually
   * holds: `narrowToSystem` on the daemon cuts the list down to the system that
   * session routes through before it is ever published.
   */
  const openrouterModels = [
    choice("openrouter/aion-labs/aion-2.0", "OpenRouter/Aion-2.0"),
    choice("openrouter/anthropic/claude-opus-4.7-fast", "OpenRouter/Claude Opus 4.7 Fast"),
    choice("openrouter/qwen/qwen3-coder", "OpenRouter/Qwen3 Coder"),
  ];
  check(
    "a provider every row repeats comes out of every row",
    drawnChoices({ choices: openrouterModels } as never).map((one: { name: string }) => one.name),
    ["Aion-2.0", "Claude Opus 4.7 Fast", "Qwen3 Coder"],
  );
  check(
    "and the value — what is stored, sent and pinned — is untouched",
    drawnChoices({ choices: openrouterModels } as never).map((one: { value: string }) => one.value),
    openrouterModels.map((one) => one.value),
  );
  /*
   * ⚠ **Nothing here derives a heading, and this is the assertion that says so.**
   * The provider was lifted into `group` for one release. It is not any more: what
   * this function may do to a control is make its names shorter, and a `group` that
   * did not arrive from the agent is a heading this client invented.
   */
  check(
    "and no heading is derived from it",
    drawnChoices({ choices: openrouterModels } as never).map((one: { group: string | null }) => one.group),
    [null, null, null],
  );
  /*
   * ⭐ The tightening, and the reason the heading could not simply be dropped from
   * the old rule. opencode's raw 362 hold two providers; cutting each of them
   * against its own namespace and drawing no heading would run `Big Pickle` in with
   * 356 OpenRouter models under nothing at all — which is the report this whole
   * section started from, arriving back by the other door.
   */
  const bothProviders = [...openrouterModels, choice("opencode/big-pickle", "OpenCode Zen/Big Pickle")];
  check(
    "two providers in one control leave every name exactly as the agent wrote it",
    drawnChoices({ choices: bothProviders } as never).map((one: { group: string | null; name: string }) => [
      one.group,
      one.name,
    ]),
    [
      [null, "OpenRouter/Aion-2.0"],
      [null, "OpenRouter/Claude Opus 4.7 Fast"],
      [null, "OpenRouter/Qwen3 Coder"],
      [null, "OpenCode Zen/Big Pickle"],
    ],
  );
  /*
   * The `every` guard, which is the whole of the safety: one row that does not
   * split turns the rule off for the control, so a list can never divide into
   * "the prefixed ones and the rest".
   */
  check(
    "one row without a provider turns the rule off for the whole control",
    drawnChoices({ choices: [...openrouterModels, choice("other/bare", "Bare")] } as never).map(
      (one: { name: string }) => one.name,
    ),
    ["OpenRouter/Aion-2.0", "OpenRouter/Claude Opus 4.7 Fast", "OpenRouter/Qwen3 Coder", "Bare"],
  );
  check(
    "and an agent that grouped its own list keeps its grouping, and its names",
    drawnChoices({
      choices: [choice("a", "OpenRouter/A", "Theirs"), choice("b", "OpenRouter/B", "Theirs")],
    } as never).map((one: { group: string | null; name: string }) => [one.group, one.name]),
    [
      ["Theirs", "OpenRouter/A"],
      ["Theirs", "OpenRouter/B"],
    ],
  );
  /*
   * Measured against the live agents: no model, mode or effort name on claude,
   * kimi or codex carries a separator, so none of their lists is touched. Asserted
   * by **identity**, which is also what makes the memo on the array sound — a rule
   * that is off must hand back the array it was given.
   */
  {
    const ordinary = [
      choice("opus[1m]", "Opus (1M context)"),
      choice("sonnet", "Sonnet"),
      choice("gpt-5.6-sol", "GPT-5.6-Sol"),
    ];
    check("no other agent's list is touched, by identity", drawnChoices({ choices: ordinary } as never) === ordinary, true);
    check(
      "and neither is a list with nothing in it",
      drawnChoices({ choices: [] } as never).length,
      0,
    );
  }
  /*
   * The separator's edges. A head or a tail that is empty after trimming is not a
   * provider and a name, it is a name with a slash in it.
   */
  check(
    "a name that only looks split is left whole",
    [
      drawnChoices({ choices: [choice("p/a", "/leading")] } as never)[0]?.name,
      drawnChoices({ choices: [choice("p/b", "trailing/")] } as never)[0]?.name,
      drawnChoices({ choices: [choice("p/c", "/")] } as never)[0]?.name,
      drawnChoices({ choices: [choice("p/d", " / ")] } as never)[0]?.name,
    ],
    ["/leading", "trailing/", "/", " / "],
  );
  check(
    "spaces around the separator are the writer's, not the reader's",
    drawnChoices({ choices: [choice("opencode/big-pickle", "OpenCode Zen / Big Pickle")] } as never).map(
      (one: { group: string | null; name: string }) => [one.group, one.name],
    ),
    [[null, "Big Pickle"]],
  );
  /*
   * The **first** separator, so a provider that writes one into its own model
   * names keeps it. Nothing in opencode's 362 does — checked — but splitting on
   * the last would make that a silent difference rather than a decision.
   */
  check(
    "the first separator is the provider and everything after it is the model",
    drawnChoices({
      choices: [choice("openrouter/qwen/qwen3-coder", "OpenRouter/qwen/Qwen3 Coder")],
    } as never).map((one: { group: string | null; name: string }) => [one.group, one.name]),
    [[null, "qwen/Qwen3 Coder"]],
  );

  /* ---------------------------------------------------------------- *
   * ⭐ The two things this must not become
   *
   * Q3.503 built a per-vendor split of one provider's catalogue and took it back
   * out; Q3.507 rejected cutting at the first `/` by name, because such a cut
   * "would survive the rename and go on cutting, including a slash that belonged
   * to the model". Both are prevented by the same pair of tests rather than by a
   * threshold: only a list the agent *routes* on is touched at all, and then only
   * where every row of it agrees on the prefix.
   * ---------------------------------------------------------------- */
  check(
    "a vendor-shaped list inside ONE provider is one provider, not thirty-eight groups",
    drawnChoices({
      choices: [
        choice("openrouter/qwen/qwen3-coder", "qwen/Qwen3 Coder"),
        choice("openrouter/openai/gpt-5", "openai/GPT-5"),
        choice("openrouter/anthropic/claude-opus-5", "anthropic/Claude Opus 5"),
      ],
    } as never).map((one: { group: string | null; name: string }) => [one.group, one.name]),
    [
      [null, "qwen/Qwen3 Coder"],
      [null, "openai/GPT-5"],
      [null, "anthropic/Claude Opus 5"],
    ],
  );
  check(
    "and one row of a provider spelling its label differently leaves the whole control alone",
    drawnChoices({
      choices: [
        choice("openrouter/a/one", "OpenRouter/One"),
        choice("openrouter/b/two", "Open Router/Two"),
      ],
    } as never).map((one: { group: string | null; name: string }) => [one.group, one.name]),
    [
      [null, "OpenRouter/One"],
      [null, "Open Router/Two"],
    ],
  );
  check(
    "a value with no namespace to route on is left alone however its name reads",
    drawnChoices({ choices: [choice("big-pickle", "OpenCode Zen/Big Pickle")] } as never).map(
      (one: { group: string | null; name: string }) => [one.group, one.name],
    ),
    [[null, "OpenCode Zen/Big Pickle"]],
  );
  /*
   * ⚠ **A value that is a namespace and nothing else is not one.** `openrouter/`
   * and `/model` are the two ends of `namespaced`, and both are the shape a value
   * takes when something upstream has half-written it.
   */
  check(
    "a value that is all namespace and no model does not count as routed",
    [
      drawnChoices({ choices: [choice("openrouter/", "OpenRouter/One")] } as never)[0]?.name,
      drawnChoices({ choices: [choice("/gpt-5", "OpenRouter/Two")] } as never)[0]?.name,
    ],
    ["OpenRouter/One", "OpenRouter/Two"],
  );


  /*
   * Which chips say their own name, and which are identified without it.
   *
   * **The rule is the icon and nothing else now**: a caption is drawn exactly
   * where `CATEGORY_ICON` has no entry. `mode` was the last category on the other
   * side of it, kept there because "Manual" alone leaves nothing saying what is on
   * manual — and dropped on the owner's word, because the glyph and the
   * `aria-label` already say it and the word was the third copy, spending width on
   * the narrowest strip in the app. Q3.559.
   *
   * Asserted over every category this client knows rather than over the three that
   * are drawn, because the property is "an icon makes the name redundant" and the
   * next category to get an icon has to answer it too.
   */
  check(
    "a chip with a glyph says only its value",
    ["mode", "model", "thought_level", "model_config"].map((category) => showsCaption({ category })),
    [false, false, false, false],
  );
  check(
    "and only a category we draw no icon for keeps its name",
    [showsCaption({ category: "unheard_of" }), showsCaption({ category: null })],
    [true, true],
  );
  /*
   * The pair, stated as the property rather than as two lists: every category with
   * an icon is silent and every category without one is not. Two lists drift the
   * day a glyph is added and only one of them is edited.
   */
  {
    const bar = stripComments(readFileSync(new URL("../src/ui/AgentConfigBar.tsx", import.meta.url), "utf8"));
    const iconed = [...bar.slice(bar.indexOf("const CATEGORY_ICON"), bar.indexOf("};", bar.indexOf("const CATEGORY_ICON")))
      .matchAll(/^\s{2}(\w+):/gm)].map((match) => match[1] ?? "");
    check("the icon table was found", iconed.length >= 4, true);
    check(
      "and nothing with a glyph draws its name",
      iconed.filter((category) => showsCaption({ category })),
      [],
    );
  }

  /*
   * And the width that stops moving.
   *
   * The right-hand cluster is right-aligned, so a chip that grows drags
   * everything left of it: picking `Max` after `Adaptive` moved the model chip by
   * five characters, every time. The reserve is every label the chip could show,
   * rendered invisibly in one grid cell — so the column is sized by the real font
   * rather than by a `length` guess, and `Adaptive` is in the list because that is
   * what `choiceOverride` renames `default` to.
   */
  const effortOption = {
    id: "effort",
    name: "Effort",
    description: null,
    category: "thought_level",
    kind: "select",
    value: "default",
    choices: [
      { value: "default", name: "Default", description: null, group: null },
      { value: "low", name: "Low", description: null, group: null },
      { value: "max", name: "Max", description: null, group: null },
    ],
  };
  /*
   * ⭐ **The daemon's own name for the row it appends, drawn as those exact bytes.**
   *
   * ⚠ **This block used to be about a reserved width and is now about a string.**
   * `CATEGORY_RESERVE` held one list per category so every chip was as wide as the
   * longest ordinary value it could show, and `Ultracode` was in that list because
   * a reserve that is *nearly* the drawn string buys nothing — it had been cut to
   * `Ultrac…` while `Adaptive` sat in the list. The table is gone (Q3.564) and the
   * chips hug their content, so there is no column to fit into; what survives is
   * the half that was never about width, which is that this client draws the name
   * the *daemon* invented rather than one of its own.
   *
   * The name lives at `src/registry.ts`'s `withUltracode` and `packages/web` cannot
   * import from `src/`, so `webcheck.stream-and-http.ts` reads that file as text and
   * pins the literal there; `daemoncheck` pins `ULTRACODE_CHOICE`, which is the
   * *value*. This is the near half: what this client actually puts on the chip.
   */
  {
    const ultracode = {
      ...effortOption,
      value: "ultracode",
      choices: [
        ...effortOption.choices,
        { value: "ultracode", name: "Ultracode", description: null, group: null },
      ],
    } as never;
    // `true` is `available`: the second argument is what decides between the real
    // value and `UNAVAILABLE_VALUE`, and omitting it silently asserts the placeholder.
    check("the effort chip draws the daemon's own name for the row it adds", chipParts(ultracode, true).value, "Ultracode");
  }

  /*
   * The value somebody just chose is the value they see.
   *
   * A chip drew the value it was *leaving* for the whole round trip — pick Low and
   * it read "Adaptive" with a spinner, then Low — which is a loading state about a
   * decision already made. Drawn at once and put back if the daemon refuses, the
   * same trade the composer makes with a message it is still sending.
   */
  const asked = (entries: [string, string | boolean][]) => new Map(entries);
  check(
    "the chosen value replaces the one being left",
    withChoice(effortOption as never, asked([["effort", "low"]])).value,
    "low",
  );
  check(
    "and the chip reads it immediately",
    chipValue(withChoice(effortOption as never, asked([["effort", "low"]]))),
    "Low",
  );
  check(
    "a change to another control leaves this one alone, object for object",
    withChoice(effortOption as never, asked([["model", "opus"]])) === effortOption,
    true,
  );
  check("and so does nothing in flight", withChoice(effortOption as never, null) === effortOption, true);
  check(
    "choosing the value it already has changes nothing either",
    withChoice(effortOption as never, asked([["effort", "default"]])) === effortOption,
    true,
  );
  check(
    "a toggle takes its boolean the same way",
    withChoice({ ...effortOption, kind: "boolean", value: false, choices: [] } as never, asked([["effort", true]]))
      .value,
    true,
  );
  check(
    "two controls can be in flight at once, because the two doors do not fence each other",
    [
      withChoice(effortOption as never, asked([["effort", "max"], ["mode", "plan"]])).value,
      withChoice({ ...effortOption, id: "mode", value: "default" } as never, asked([["effort", "max"], ["mode", "plan"]]))
        .value,
    ],
    ["max", "plan"],
  );

  /*
   * The mechanism under it, and the ordering rule that keeps two taps honest.
   */
  {
    const { beginChoice, endChoice, choicesFor, forgetChoices } = await import("../src/choices.js");
    const key = "m_1/s_1" as never;
    const first = beginChoice(key, "effort", "low");
    check("a recorded choice is what the session is holding", [...(choicesFor(key) ?? new Map())], [["effort", "low"]]);
    const second = beginChoice(key, "effort", "max");
    endChoice(first);
    check(
      "an earlier answer does not release a later choice",
      [...(choicesFor(key) ?? new Map())],
      [["effort", "max"]],
    );
    endChoice(second);
    check("and the last one releases it", choicesFor(key), null);

    beginChoice(key, "effort", "low");
    beginChoice("m_1/s_2" as never, "effort", "high");
    forgetChoices(key);
    check("a session going away takes only its own", [
      choicesFor(key),
      [...(choicesFor("m_1/s_2" as never) ?? new Map())],
    ], [null, [["effort", "high"]]]);
    forgetChoices("m_1/s_2" as never);
  }

  /*
   * **The assertion that would have caught the defect**, and it has to be a
   * call-site one: every pure check above passed while the bug was live on
   * screen. There are two doors into `applyConfigChange` — the chip and the
   * composer's `/effort` menu — and the optimistic override lived in the bar's
   * own `useState`, so the second door drew the daemon's value for the whole
   * round trip. The rule is that recording belongs to the *dispatcher*: the map
   * is written in exactly one place, and no component may write it.
   */
  {
    const strip = readFileSync(new URL("../src/ui/AgentConfigBar.tsx", import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    const composerSrc = readFileSync(new URL("../src/ui/Composer.tsx", import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    const count = (text: string, needle: string) => text.split(needle).length - 1;

    // Once each, and both before the component: `applyConfigChange` is declared
    // above `export function AgentConfigBar`, so this pins them inside the
    // dispatcher rather than merely inside the file.
    const dispatcher = strip.slice(0, strip.indexOf("export function AgentConfigBar"));
    check(
      "the choice is recorded and released in the dispatcher, once each",
      [count(strip, "beginChoice("), count(strip, "endChoice("), count(dispatcher, "beginChoice("), count(dispatcher, "endChoice(")],
      [1, 1, 1, 1],
    );
    check(
      "and the other door records nothing of its own",
      [count(composerSrc, "beginChoice"), count(composerSrc, "endChoice")],
      [0, 0],
    );
    // Not trivially true: the property is only worth anything while a second
    // caller exists to be covered by it.
    check("while still being a second caller", count(composerSrc, "applyConfigChange(") >= 1, true);
    // The effort follow-up rides the same dispatcher: decided by the pure
    // function, sent by recursion, never by a second request written inline.
    check("and a model change asks the effort rule before returning", /effortFollowUp\(/.test(dispatcher), true);
    check("sending the follow-up through the dispatcher itself", /return applyConfigChange\(sessionRef, followUp\.configId, followUp\.value\)/.test(dispatcher), true);
    check(
      "and the daemon is still asked in exactly one place",
      count(strip, "setConfig(") + count(composerSrc, "setConfig("),
      1,
    );
  }

  /*
   * A model switch that changes the effort list drops the old level and sets
   * the new model's default (the owner's rule, from a kimi screenshot with a
   * checkmark on a level the new list had grown past). Pure, so it is driven
   * with two option lists: the same list means nothing to do, a different list
   * means the `default` choice where there is one and the first choice
   * otherwise, and only a `model` change asks at all.
   */
  {
    const model = { id: "model", name: "Model", description: null, category: "model", kind: "select", value: "k3", choices: [] };
    const kimiOld = { ...effortOption, id: "thinking", value: "max", choices: [
      { value: "low", name: "Thinking Low", description: null, group: null },
      { value: "high", name: "Thinking High", description: null, group: null },
      { value: "max", name: "Thinking Max", description: null, group: null },
    ] };
    const kimiNew = { ...kimiOld, choices: [
      { value: "on", name: "Thinking on", description: null, group: null },
      ...kimiOld.choices,
    ] };
    const before = [model, kimiOld] as never;
    check("a model change onto a different effort list sets the first choice", effortFollowUp(model, before, [model, kimiNew] as never), { configId: "thinking", value: "on" });
    check("and the `default` choice where the list has one", effortFollowUp(model, before, [model, { ...effortOption, value: "max" }] as never), { configId: "effort", value: "default" });
    check("the same list means nothing to do", effortFollowUp(model, before, [model, kimiOld] as never), null);
    check("nor a model with no effort control", effortFollowUp(model, before, [model] as never), null);
    check("nor one whose old model had none, since the agent's own default applies", effortFollowUp(model, [model] as never, [model, kimiNew] as never), null);
    check("nor when the default is already the value", effortFollowUp(model, before, [model, { ...kimiNew, value: "on" }] as never), null);
    check("and only a model change asks", effortFollowUp(kimiOld, before, [model, kimiNew] as never), null);
    check("an unknown option asks nothing", effortFollowUp(undefined, before, [model, kimiNew] as never), null);
  }

  /*
   * A control whose choices have gone still draws the same *shape*, which is what
   * is left of "still holds its width" now that the reserve is gone (Q3.564): a
   * caption where the category has one, and the placeholder where the value was.
   * An agent that has stopped offering a control is when a chip is most likely to
   * be redrawn from the wrong branch, which is why this is asserted at the empty
   * list rather than only at the missing control.
   */
  check(
    "a control with nothing left to choose still draws a chip rather than a hole",
    [
      chipParts({ ...effortOption, choices: [] } as never, false),
      chipParts({ ...effortOption, kind: "boolean", value: true, choices: [] } as never, false),
    ],
    [
      { caption: null, value: "—" },
      { caption: null, value: "—" },
    ],
  );

  /*
   * Slot assignment, which is the same rule one layer up.
   *
   * `Fast mode` leaves the visible strip because it is `category: "model_config"`
   * and that category is not in the table — not because anybody matched the string
   * "fast". The distinction is the whole invariant: an id-keyed rule would hide
   * one agent's controls and show the other's.
   */
  const fast = { id: "fast", name: "Fast mode", description: null, category: "model_config", kind: "boolean", value: true, choices: [] };
  const odd = { id: "x", name: "Odd", description: null, category: "something_new", kind: "select", value: "a", choices: [] };
  const uncategorised = { id: "y", name: "Uncategorised", description: null, category: null, kind: "select", value: "b", choices: [] };

  const slots = splitOptions([...claude, fast, odd, uncategorised] as never);
  check("mode goes left", slots.left.map((o: { id: string }) => o.id), ["mode"]);
  check("model and effort go right, in reading order", slots.right.map((o: { id: string }) => o.id), ["model", "effort"]);
  // `Fast mode` is not demoted, it is *hidden* — a product decision about a known
  // category, asked for by name. With it gone the `…` button it was the sole
  // content of disappears too, which was the actual complaint.
  check("model_config is hidden outright", slots.hidden.map((o: { id: string }) => o.id), ["fast"]);
  // Unknown categories are still demoted rather than dropped: ACP says a category
  // must not be required for correctness, so a control nobody has heard of keeps a
  // way to be reached, and the `…` button reappears the moment one exists.
  check("but an unknown category is still reachable", slots.overflow.map((o: { id: string }) => o.id).sort(), ["x", "y"]);

  // `slotFor` directly, because `splitOptions` can only show where a control
  // *landed* and the rule is about `category` alone. Keyed on the category and
  // never on the id: claude calls reasoning effort `effort` and kimi calls it
  // `thinking`, so an id-keyed table draws one agent's controls and none of the
  // other's.
  check("the slot comes from the category", slotFor({ category: "mode" }), "left");
  check("model and effort share the right-hand slot", [slotFor({ category: "model" }), slotFor({ category: "thought_level" })], ["right", "right"]);
  // Hidden is a decision about a control we know; overflow is what we do with one
  // we do not. They must not collapse into each other.
  check("a known category we hide is hidden", slotFor({ category: "model_config" }), "hidden");
  check("an unknown one is demoted, not dropped", slotFor({ category: "something_new" }), "overflow");
  check("and so is a control with no category at all", slotFor({ category: null }), "overflow");

  // Demoted, never dropped: ACP says a category must not be required for
  // correctness, so an agent using one nobody has heard of stays fully operable.
  //
  // **`nested` is in this sum, and leaving it out is the failure the sum exists to
  // catch.** A slot missing from the count makes every option in it invisible to
  // the one assertion that says nothing is lost — which is how a control silently
  // stops existing while the check stays green.
  const total =
    slots.left.length + slots.right.length + slots.overflow.length + slots.hidden.length + slots.nested.length;
  check("every option lands in exactly one slot, and none is lost", total, 6);
  check("kimi's controls split the same way", splitOptions(kimi as never).right.map((o: { id: string }) => o.id), ["model", "thinking"]);

  /*
   * Codex, and the rule that the strip must not change shape between agents.
   *
   * Measured 2026-08-07, codex publishes five controls, and one of them —
   * `collaboration_mode`, its Default/Plan switch — is a category no other agent
   * has. Demoted as an unknown it would put a `…` button on the strip for codex
   * sessions and no other, so every other button moves along the row the moment
   * you switch session. It is `nested` instead: drawn as a second menu inside the
   * mode control, which already exists on every agent.
   */
  const codex = [
    { id: "mode", name: "Mode", description: null, category: "mode", kind: "select", value: "agent", choices: [] },
    { id: "collaboration_mode", name: "Collaboration mode", description: null, category: "collaboration_mode", kind: "select", value: "default", choices: [] },
    { id: "model", name: "Model", description: null, category: "model", kind: "select", value: "gpt-5.6-sol", choices: [] },
    { id: "reasoning_effort", name: "Reasoning effort", description: null, category: "thought_level", kind: "select", value: "low", choices: [] },
    { id: "fast-mode", name: "Fast mode", description: null, category: "model_config", kind: "boolean", value: false, choices: [] },
  ];
  const codexSlots = splitOptions(codex as never);
  check("codex's plan switch nests rather than demoting", slotFor({ category: "collaboration_mode" }), "nested");
  check("so it is drawn inside the mode menu", codexSlots.nested.map((o: { id: string }) => o.id), ["collaboration_mode"]);
  /*
   * **The assertion the whole change is for.** Codex must leave the strip the
   * same shape claude leaves it: mode on the left, model and effort on the right,
   * and *nothing* behind a `…` — because the `…` is the button that appears for
   * one agent and not another.
   */
  check("and the strip carries no overflow button for codex", codexSlots.overflow, []);
  check("while the visible chips are the ones every agent has", [
    codexSlots.left.map((o: { id: string }) => o.id),
    codexSlots.right.map((o: { id: string }) => o.id),
  ], [["mode"], ["model", "reasoning_effort"]]);

  /*
   * A nested control with no host is demoted, never dropped.
   *
   * `nested` names a place *inside* another control's menu, so it only exists if
   * that control is on the strip. Both ways of not having one are the same
   * outcome: no mode control at all, and a mode control that is a toggle and
   * therefore has no menu to nest into.
   */
  check(
    "with no mode control, the nested one falls back to overflow",
    splitOptions([codex[1]] as never).overflow.map((o: { id: string }) => o.id),
    ["collaboration_mode"],
  );
  const toggleHost = { id: "mode", name: "Mode", description: null, category: "mode", kind: "boolean", value: true, choices: [] };
  check(
    "and a toggle is not a host, because a toggle has no menu",
    splitOptions([toggleHost, codex[1]] as never).overflow.map((o: { id: string }) => o.id),
    ["collaboration_mode"],
  );
  /*
   * **And the mirror, which the host test does not cover.**
   *
   * A boolean *host* is refused because a toggle has no menu to nest into. A
   * boolean in the *nested* slot is the same fact read from the other end: it
   * carries no `choices`, so `ChoiceSection` would draw a divider and a heading
   * with no rows under them, and `toEntries` skips booleans as well — so the
   * control would have no second way to be reached and would silently cease to
   * exist. Overflow is where it went before `nested` existed, drawn as a working
   * Toggle, and it is where it goes again.
   *
   * Asserted with a real host present, so nothing else could be doing the
   * demotion: `mode` is a select here and `collaboration_mode` still leaves the
   * nested slot.
   */
  const booleanNested = [
    codex[0],
    { id: "collaboration_mode", name: "Plan", description: null, category: "collaboration_mode", kind: "boolean", value: false, choices: [] },
  ];
  const booleanSlots = splitOptions(booleanNested as never);
  check(
    "a boolean cannot be nested either, because it has no choices to draw",
    [
      booleanSlots.nested.map((o: { id: string }) => o.id),
      booleanSlots.overflow.map((o: { id: string }) => o.id),
    ],
    [[], ["collaboration_mode"]],
  );
  check(
    "and its host is still on the strip, so nothing else demoted it",
    booleanSlots.left.map((o: { id: string }) => o.id),
    ["mode"],
  );
  // The partition still holds with a member moved between slots.
  check(
    "and nothing is lost moving it",
    booleanSlots.left.length +
      booleanSlots.right.length +
      booleanSlots.overflow.length +
      booleanSlots.hidden.length +
      booleanSlots.nested.length,
    2,
  );
}

/* ------------------------------------------------------------------ *
 * Widget roles, kept rather than merely drawn
 * ------------------------------------------------------------------ */

process.stdout.write("\narrow keys inside a menu that claims to be one\n");
{
  /*
   * ⚠ **The roles were drawn and never implemented, and nothing here noticed.**
   *
   * `bits.tsx` renders `role="menu"`, and `role="listbox"` with `role="option"`
   * plus `aria-selected` on every row. A grep for `ArrowDown` across the whole of
   * `packages/web` returned exactly one hit, in the composer's own slash menu — so
   * a screen reader announced "listbox, 8 options" and then not one arrow key
   * moved anything. That is the same class of defect as an unmeasured contrast
   * ratio, and this file was already asserting those.
   *
   * Split in two on purpose: reading the key is one question and where focus lands
   * is another, and only the second has a wrap in it.
   */
  const { listNavKey, nextOptionIndex } = await import("../src/keys.js");

  check("the list walks on the arrows", [listNavKey({ key: "ArrowDown" }), listNavKey({ key: "ArrowUp" })], [
    "next",
    "prev",
  ]);
  check("and jumps on Home and End", [listNavKey({ key: "Home" }), listNavKey({ key: "End" })], ["first", "last"]);

  /*
   * **Escape is the omission that matters.** `overlay.ts` is the single arbiter —
   * it holds the LIFO layer stack and the one capture-phase listener, and
   * `decisionShortcutsEnabled` reads that stack to decide whether a bare digit may
   * resolve a permission. A second component answering Escape is the exact shape
   * that arbiter replaced, so this must keep returning `null` and let the key
   * travel to where it is owned.
   */
  check("Escape belongs to the overlay arbiter and is not claimed here", listNavKey({ key: "Escape" }), null);
  // Every row in both widgets is a real `<button>`, which activates on both
  // without help. Claiming them would re-implement the platform, slightly wrong.
  check("Enter and Space are left to the button", [listNavKey({ key: "Enter" }), listNavKey({ key: " " })], [null, null]);
  check("an ordinary letter means nothing to a list", listNavKey({ key: "j" }), null);
  // An arrow mid-composition is how an IME walks its own candidate list.
  check("and an arrow while an IME is composing is the IME's", listNavKey({ key: "ArrowDown", isComposing: true }), null);
  check("as is any chord", [
    listNavKey({ key: "ArrowDown", metaKey: true }),
    listNavKey({ key: "ArrowUp", ctrlKey: true }),
    listNavKey({ key: "Home", altKey: true }),
  ], [null, null, null]);

  /*
   * **-1 is "nothing has focus yet"**, which is the state every panel opens in
   * before its effect runs. From nowhere, Down takes the first row and Up the last,
   * so a keyboard arriving at a fresh menu gets the near end either way rather than
   * landing on row two.
   */
  check("from nowhere, Down takes the first row", nextOptionIndex("next", -1, 4), 0);
  check("and Up takes the last", nextOptionIndex("prev", -1, 4), 3);
  check("otherwise it steps", [nextOptionIndex("next", 1, 4), nextOptionIndex("prev", 2, 4)], [2, 1]);

  /*
   * The wrap, which is the whole reason this is a function rather than `+1`. It is
   * the convention for a popup of bounded length, and it removes the dead key: on a
   * four-row menu with focus on the last row, an unwrapped Down does nothing and
   * tells the reader nothing about why.
   */
  check("the end wraps to the start", nextOptionIndex("next", 3, 4), 0);
  check("and the start wraps to the end", nextOptionIndex("prev", 0, 4), 3);
  check("Home and End ignore where focus was", [nextOptionIndex("first", 2, 4), nextOptionIndex("last", 2, 4)], [0, 3]);

  // So a caller cannot focus index 0 of nothing.
  check("an empty list has nowhere to go", [
    nextOptionIndex("next", -1, 0),
    nextOptionIndex("first", -1, 0),
  ], [null, null]);
  check("and no key at all goes nowhere", nextOptionIndex(null, 1, 4), null);

  /*
   * The wiring, as source text, because `webcheck` has no DOM and a handler that
   * is never attached is indistinguishable from one that is.
   *
   * **On the panel and never on `window`** is the property worth pinning. This app
   * has exactly two global keydown listeners on purpose — `overlay.ts`'s Escape
   * arbiter and `AskCard`'s digit shortcuts — and each had to reason about the
   * other. A third would have had to reason about both.
   */
  const bitsRaw = readFileSync(new URL("../src/ui/bits.tsx", import.meta.url), "utf8");
  /*
   * Comments out first, and that is not tidiness — it is the failure this block
   * hit on its first run. Both counts below were written against the raw file and
   * both came back one too high, because the docblocks explaining these very rules
   * quote the strings being counted: the prose says `tabIndex={-1}` and it says
   * `.focus()`. Every source-text assertion in this file that reads code rather
   * than copy has to do this, and the ones further down already do.
   */
  const strip = (text: string): string =>
    text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const bitsSrc = strip(bitsRaw);
  check("both panels take the keys", (bitsSrc.match(/onKeyDown=\{onKeyDown\}/g) ?? []).length, 2);
  check("and neither reaches for a global listener", /window\.addEventListener\("keydown"/.test(bitsSrc), false);

  /*
   * **The panel holds focus itself, and that is what keeps the widget alive.**
   *
   * The handler is element-scoped, so focus leaving the rows is the same thing as
   * the widget going dead: a focused row can unmount under the 4s poll
   * (`NewSession`'s machine list, a conditional row in `UsersSection`), the browser
   * drops focus to `<body>`, and from there no arrow key can reach the handler to
   * get back in.
   *
   * ⚠ **This named a second reason and that reason is gone**: it was also the only
   * way a panel whose rows are a caller's *prose* took focus at all, rather than
   * announcing `role="menu"` and answering nothing — and the panel it named was
   * `ProfileMenu`'s `HelpButton`, which went out of the tree with the rail footer
   * when the menu became a drawer. No panel in this app has prose rows today. The
   * clause is recorded rather than deleted because it is the case `tabIndex={-1}`
   * would otherwise look over-specified for, and the next such panel inherits it.
   *
   * Pinned as source text because it is a JSX attribute and this driver has no DOM.
   */
  check("and both can hold focus themselves", (bitsSrc.match(/tabIndex=\{-1\}/g) ?? []).length, 2);

  /*
   * **Neither `focus()` may scroll an ancestor.** Both popups are `absolute`
   * children of a box routinely inside `SHEET_BODY`, and the outside-`pointerdown`
   * that closes a panel is also what the start of a touch scroll looks like — so an
   * unguarded restore scrolls the sheet back to the trigger, fighting the scroll the
   * reader just began. Every `focus()` in this file's list code carries
   * `preventScroll`, and revealing a row is `revealWithin`, which moves the panel
   * and nothing above it.
   */
  const listCode = strip(bitsRaw.slice(bitsRaw.indexOf("function focusableRows"), bitsRaw.indexOf("A panel anchored to")));
  check("the list's focus calls never scroll the page", [
    // Three that move focus for the reader: opening, restoring, and each arrow.
    (listCode.match(/\.focus\(\{ preventScroll: true \}\)/g) ?? []).length,
    // …and exactly one that does not, which is the body fallback `Sheet` also
    // makes: there is nothing to reveal and nowhere to scroll to.
    (listCode.match(/\.focus\(\)/g) ?? []).length,
    (listCode.match(/document\.body\.focus\(\)/g) ?? []).length,
  ], [3, 1, 1]);
  // `Sheet` solved the disappearing trigger first; this mirrors it rather than
  // inventing a second answer.
  check("and a trigger that did not survive falls back like Sheet's", /back\.isConnected/.test(listCode), true);
}
