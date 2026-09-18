import { readFileSync, readdirSync } from "node:fs";
import { check, report, storage } from "./webcheck.env.js";
import { stripComments } from "./webcheck.source.js";

/* ------------------------------------------------------------------ *
 * What the tab says to somebody who is not looking at it
 *
 * ⚠ **Two rules that had no assertion of any kind here**, and both of them are
 * about a surface this driver cannot render: the document's own `<title>`, and the
 * `<meta name="viewport">` that decides where the layout viewport goes when a
 * software keyboard opens. Neither is reachable by calling anything — one is an
 * effect writing to `document`, the other is a string in `index.html` that no
 * TypeScript in this package ever reads — so both are read off disk, which is the
 * form every placement assertion in this file already takes.
 * ------------------------------------------------------------------ */

process.stdout.write("\nwhat this app says while nobody is looking at it\n");
{
  const appSrc = stripComments(readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8"));
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");

  /*
   * **The tab says how many sessions are waiting, and it is the only thing this app
   * can say to somebody who is not looking at it.** Every other cross-screen signal
   * — the bell, `WaitingElsewhere`, the count on a machine tab, the count on a
   * folder header — is drawn in the rail, i.e. inside a tab that already has the
   * reader's attention, and the question this product is shaped around is *does
   * anything anywhere need me*.
   *
   * ⚠ **The count is `sessionLists(...).blocked`, the predicate every other consumer
   * already reads**, so there is one answer to "how many need me" and this cannot
   * become a second opinion disagreeing with the bell three inches away. That is
   * the half worth pinning: a hand-rolled `state.sessions.filter(…)` here would look
   * right, typecheck, and drift the first time the predicate moves.
   */
  check(
    "the badge counts what the bell counts",
    /const blocked = sessionLists\(state\)\.blocked\.length;/.test(appSrc),
    true,
  );
  check(
    "and it is a prefix on the plain name rather than a second title",
    /document\.title = blocked === 0 \? PAGE_TITLE : `\(\$\{blocked\}\) \$\{PAGE_TITLE\}`;/.test(appSrc),
    true,
  );
  /*
   * ⚠ **Restored on unmount as well as at zero**, which is what makes "the badge
   * never outlives the state that put it there" true by construction rather than by
   * remembering to clear it in the zero arm. The cleanup fires on every change too,
   * writing `PAGE_TITLE` and then immediately the new badge: one extra assignment,
   * and no window in which a stale count survives.
   */
  check("and it never outlives the state that put it there", /return \(\) => \{\s*document\.title = PAGE_TITLE;\s*\};/.test(appSrc), true);
  /*
   * ⚠ **The name is restated rather than read back out of `document.title`**, and
   * the pair is the assertion: the first thing this app does to that property is
   * overwrite it, so a value recovered from it at any later moment is whatever the
   * last render put there, badge and all. That leaves two copies of one string —
   * this one and the document's — which is exactly the drift this file exists to
   * catch, so they are compared.
   */
  const shipped = /<title>([^<]*)<\/title>/.exec(html)?.[1] ?? "";
  const named = /const PAGE_TITLE = "([^"]*)";/.exec(appSrc)?.[1] ?? "";
  check("both copies of the name were found", [shipped.length > 0, named.length > 0], [true, true]);
  check("and the tab is called the same thing before and after this app loads", named, shipped);

  /*
   * ⚠ **`interactive-widget=resizes-content`, which nothing in this package reads
   * and nothing asserted.** The default is `resizes-visual`, which does *not* move
   * the layout viewport when the software keyboard opens: `AppShell`'s `h-dvh` and
   * the composer's sticky `bottom-0` stay where they were, so on Chrome/Android the
   * box you are typing in is behind the keyboard — and on a plan card, whose whole
   * point is typing an answer, so are Send and the approvals. Nothing repositions
   * them; `Composer` compensates for its own height cap alone.
   *
   * Asserted as the **pair**, because the key alone is a fact about a file nobody
   * opens: the layout it is compensating for has to still be the one described, and
   * `h-dvh` moving out of `AppShell` is what would make this meta line a cargo cult
   * a reader could not evaluate. Browsers that do not know the key ignore it.
   */
  const viewport = /<meta name="viewport" content="([^"]*)"/.exec(html)?.[1] ?? "";
  const shell = stripComments(readFileSync(new URL("../src/ui/AppShell.tsx", import.meta.url), "utf8"));
  check("the viewport tag was found", viewport.length > 0, true);
  check(
    "the keyboard moves the layout viewport, and the layout it moves is still there",
    [/\binteractive-widget=resizes-content\b/.test(viewport), /\bh-dvh\b/.test(shell)],
    [true, true],
  );
  /*
   * The other half of the same tag, which predates it and is load-bearing for a
   * different reason: without `viewport-fit=cover` *and* the safe-area padding in
   * `index.css`, the bottom action bar sits under the iPhone home indicator, which
   * is exactly where the approve buttons are.
   */
  check("and the safe area is still opted into", /\bviewport-fit=cover\b/.test(viewport), true);
}

/* ------------------------------------------------------------------ *
 * Who owns Escape, and what paints above what
 *
 * `overlay.ts` is importable here — and has to stay that way — because its
 * `window.addEventListener` lives inside `push()` rather than in the module body.
 * That is the same constraint `settings.ts` states about itself: a decision this
 * file cannot reach is a decision nothing asserts, and the first maintenance edit
 * that hoists that listener would silently un-assert everything below.
 * ------------------------------------------------------------------ */

process.stdout.write("\nwho owns Escape, and what paints above what\n");
{
  const { LAYER, decisionShortcutsEnabled, escapeAction, isOverlayPath, layerRank, shortcutsEnabled } = await import(
    "../src/ui/overlay.js"
  );
  const { SECTION_SPECS, settingsPath } = await import("../src/settings.js");

  const ask = { id: 1, kind: "ask" } as const;
  const menu = { id: 2, kind: "menu" } as const;
  const sheet = { id: 3, kind: "sheet" } as const;

  check("nothing open, nothing claimed", escapeAction([], false), { dismiss: null, stop: false });
  /*
   * Typing beats every layer, and this one rule is what four components used to
   * each defend with their own comment: Escape in the composer belongs to the
   * command menu, in `AskCard`'s "Other" box to the box, in `RenameField` to the
   * rename, in `DirectoryPicker`'s new-folder field to that form.
   */
  check("typing beats an open card", escapeAction([ask], true), { dismiss: null, stop: false });
  check("and beats an open sheet", escapeAction([sheet, menu], true), { dismiss: null, stop: false });

  check("one layer owns it", escapeAction([ask], false).dismiss, ask.id);
  check("a menu over a card takes it first", escapeAction([ask, menu], false).dismiss, menu.id);
  check("a menu inside a sheet, likewise", escapeAction([sheet, menu], false).dismiss, menu.id);
  /*
   * The case the old arrangement got wrong: a sheet opens over a session that has
   * an expanded question parked on it. Escape must close the sheet and leave the
   * card alone — before this, it folded a card nobody could see.
   */
  check("a sheet over a card takes it", escapeAction([ask, sheet], false).dismiss, sheet.id);

  /*
   * The contract, over every stack rather than the six above, because the failure
   * being replaced was exactly a component that stopped propagation *before*
   * deciding whether it would act — which ended the dispatch for everybody and
   * cancelled an agent's tool call while leaving the menu wide open.
   */
  const stacks = [[], [ask], [menu], [sheet], [ask, menu], [sheet, menu], [ask, sheet], [ask, menu, sheet]];
  check(
    "it stops the keystroke exactly when it acts on it",
    stacks.every((stack) =>
      [true, false].every((typing) => {
        const action = escapeAction(stack, typing);
        return action.stop === (action.dismiss !== null);
      }),
    ),
    true,
  );

  /*
   * `inert` does not block a `window` keydown, so without this guard `j`/`k`
   * navigate the list *behind* an open sheet — changing what is underneath while
   * it cannot be seen.
   *
   * Only a sheet blocks. A menu deliberately does not, which is a documented
   * non-change: a bare `j` with a `Dropdown` open navigates today and this layer
   * is not the place to decide otherwise.
   */
  check(
    "bare letters survive a menu and a card, and not a sheet",
    [[], [ask], [menu], [ask, menu], [sheet], [ask, sheet], [sheet, menu]].map(shortcutsEnabled),
    [true, true, true, true, false, false, false],
  );

  /*
   * **Deciding is not navigating, which is why there are two predicates.**
   *
   * `j` under an open `Dropdown` moves a caret and the worst case is looking at
   * the wrong row — a documented non-change. `2` under an open `Dropdown`
   * *approves a command*. `AskCard` gated its numbered answers on the rule above,
   * so with a session menu or the config bar's `…` popover open over a parked
   * question, a keystroke aimed at the menu resolved the permission underneath
   * it.
   *
   * `[ask]` answering `true` is the case that matters and the one an obvious
   * implementation gets backwards: the card registers itself with
   * `useDismissible("ask", …)` whenever it is open, so `layers.length === 0` —
   * which reads as the stricter, safer rule — is exactly the state in which there
   * is no card to answer, and would have disabled the shortcuts permanently while
   * passing every reading of the code.
   */
  check(
    "a numbered answer survives only the card's own layer",
    [[], [ask], [menu], [ask, menu], [sheet], [ask, sheet], [ask, menu, sheet]].map(decisionShortcutsEnabled),
    [true, true, false, false, false, false, false],
  );

  /*
   * **And every listener that could act on one actually asks.**
   *
   * The case above is the rule; this is obedience to it, and the two were apart
   * long enough for the gap to be a live defect. `shortcutsEnabled([ask, sheet])`
   * has always answered `false` — the exact stack this names — while `AskCard`
   * registered its own capture-phase `window` keydown for the digit shortcuts and
   * never asked. `keyboard.ts` asked, so the harmless listener was covered and the
   * one that *resolves a permission* was not: with a session parked on an approval
   * behind an open settings sheet, a bare `1` reached `option.onPick()`. `inert` on
   * `#root` does not stop a `window` keydown — the predicate's own docblock says
   * so — and `Sheet` focuses a `tabIndex={-1}` div, which `isTypingInto` answers
   * false for, so nothing else in the chain refused it either.
   *
   * Source text rather than a call, in the style of the `SessionBrowser.tsx` and
   * `Composer.tsx` pins above: there is no DOM here to dispatch a key into, and
   * what has to hold is a property of *every* such listener rather than of the two
   * that exist today. `overlay.ts` is the one exemption, because it is the arbiter
   * being consulted rather than a caller of it.
   */
  const uiRoot = new URL("../src/", import.meta.url);
  const keyListeners: string[] = [];
  const sweep = (dir: URL): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const child = new URL(entry.name + (entry.isDirectory() ? "/" : ""), dir);
      if (entry.isDirectory()) sweep(child);
      else if (/\.tsx?$/.test(entry.name) && entry.name !== "overlay.ts") {
        const text = readFileSync(child, "utf8");
        if (text.includes('window.addEventListener("keydown"')) {
          /*
           * **Either predicate counts, and there are two on purpose.**
           * `shortcutsEnabled` is about *navigating* and blocks only a sheet;
           * `decisionShortcutsEnabled` is about *deciding* and blocks a menu as
           * well. What this sweep is for is that a `window` keydown asks the
           * arbiter at all — which one it asks is the caller's judgement, and
           * `AskCard` is the reason the second exists.
           */
          const guarded =
            text.includes("shortcutsEnabled(currentLayers())") ||
            text.includes("decisionShortcutsEnabled(currentLayers())");
          keyListeners.push(`${entry.name}${guarded ? "" : " (UNGUARDED)"}`);
        }
      }
    }
  };
  sweep(uiRoot);
  check(
    "every window keydown listener outside the arbiter consults it",
    keyListeners.filter((name) => name.includes("UNGUARDED")),
    [],
  );
  check("and there are listeners to have checked", keyListeners.length > 0, true);

  /*
   * The ordering, in the one place that holds it. This is why `LAYER` is full
   * class strings rather than numbers in five files — Tailwind cannot see a
   * computed `z-${n}`, and an order spread across the things it orders is one
   * nothing can assert.
   */
  const names = ["header", "menu", "overlay", "toast"] as const;
  const ranks = names.map(layerRank);
  check("the layers are named in ascending order", ranks, [30, 40, 50, 60]);
  check(
    "and each is strictly above the last",
    ranks.every((rank, index) => index === 0 || rank > (ranks[index - 1] ?? 0)),
    true,
  );
  check("a toast outranks the sheet it reports a failure from", layerRank("toast") > layerRank("overlay"), true);
  check("every layer is a class Tailwind can see", names.map((name) => /^z-\d+$/.test(LAYER[name])), [
    true,
    true,
    true,
    true,
  ]);

  /*
   * **The sheet's box, as two class strings, because both defects it had were
   * invisible to every driver here.**
   *
   * A pop-up that scrolls and a pop-up that holds still are the two things every
   * sheet in this app must do, and neither is expressible in a type. They were
   * both broken at once and nothing failed: `typecheck` sees strings, `web:build`
   * emits whatever Tailwind recognises, and there is no DOM in this process to
   * measure a panel in. So they are pinned the same way the retired colour tokens
   * are — by reading the source of truth, which for these is the constant itself.
   *
   * `SHEET_BODY` must be a **flex column**. Both callers write `min-h-0 flex-1`
   * on their top child, and in a block container those two properties do nothing:
   * every inner scroller sized to its own content, got no scroll range, and then
   * its `overscroll-contain` stopped the wheel from chaining to the one box that
   * could move. The measured symptom was that no pop-up in the app scrolled at
   * all. `min-h-0` on the body itself is the other half — without it the body
   * refuses to shrink below its content and the panel's own height stops bounding
   * anything.
   *
   * `SHEET_PANEL` must carry a **definite** height and no `max-h-`. With a
   * ceiling alone the panel was content-sized: measured at 155px, 475px and 492px
   * for two, twelve and eighty lines of body, so walking the settings list
   * resized the dialog under a pointer already aimed at the next row.
   */
  const { SHEET_BODY, SHEET_PANEL, SHEET_SCREEN } = await import("../src/ui/bits.js");
  const bodyClasses = SHEET_BODY.split(/\s+/);
  check(
    "a sheet's body is a flex column, so its children's flex-1 means something",
    ["flex", "flex-col", "min-h-0", "flex-1"].map((name) => bodyClasses.includes(name)),
    [true, true, true, true],
  );
  /*
   * ⚠ **And it never scrolls and pads nothing — the inverse of what this pinned
   * for four releases, when it asserted `overflow-y-auto` as "the fallback
   * scroller".** Reported 2026-09-06 from a desktop: a horizontal bar along the
   * foot of the settings pop-up and a vertical one down its right edge, on an
   * Account screen that fit. The body was `overflow-y-auto` with `px-4 py-5`, and
   * every screen inside it reached the padding edge with `-mx-4 -my-5` so a rail's
   * border and an action bar could touch the panel's edge. A scroll container's
   * scrollable overflow includes its own end padding *beyond* the content's far
   * edge (CSS Overflow 3), so a child ending exactly at the padding edge overflows
   * by exactly one padding: 16–20px of scroll range in each axis that nothing
   * could show, drawn as a bar wherever `pointer: fine` holds. A box that is not a
   * scroll container has no scrollable overflow and can draw no bar, and every
   * pop-up already scrolled in a child of its own — so the body clips, carries no
   * padding for a child to overflow by, and a screen inside it has nothing to
   * cancel. Variant prefixes are stripped before the test, because the old
   * strings carried the offending classes as `sm:px-5` and `sm:-mx-5` as well as
   * bare. Q3.553.
   */
  const unprefixed = (name: string): string => name.replace(/^[a-z0-9-]+:/, "");
  check(
    "and it clips rather than scrolls",
    [bodyClasses.includes("overflow-hidden"), bodyClasses.includes("overflow-y-auto")],
    [true, false],
  );
  check(
    "and pads nothing, so there is no end padding for a child to overflow by",
    bodyClasses.filter((name) => /^p[xytblr]?-/.test(unprefixed(name))),
    [],
  );
  check(
    "and a screen inside it cancels nothing",
    SHEET_SCREEN.split(/\s+/).filter((name) => unprefixed(name).startsWith("-m")),
    [],
  );
  /*
   * **And it paints its own ground, because it is the thing that slides.**
   *
   * This box carries the `view-transition-name` a section change moves, and being
   * named lifts it out of the panel's snapshot — so with the fill left to the
   * panel, both of its snapshots were transparent images of nothing but glyphs.
   * Measured mid-slide at 390px: the leaving list's rows and the arriving
   * section's fields were both fully legible, one drawn over the other. The
   * animation was correct throughout; a pane that arrives has to *cover* the one
   * it replaces, and that is a property of the element rather than of a keyframe.
   * Same colour as the panel behind it, so nothing at rest changes.
   */
  check("and it paints its own ground, so a slide covers what it replaces", bodyClasses.includes("bg-surface"), true);
  check("a sheet's height is definite at both widths", /(^|\s)h-\[/.test(SHEET_PANEL) && /\ssm:h-\[/.test(SHEET_PANEL), true);

  /*
   * **The ask card's two ceilings are whole strings, and that has to be asserted
   * as *text*.** Tailwind v4 scans source files rather than evaluating them, so a
   * class assembled from fragments — `max-h-[min(${n}dvh,100%)]` — emits no CSS at
   * all, and the failure is a card with no height rule rather than an error
   * anybody sees. Same class of hazard as a utility naming a token that does not
   * exist, and the same remedy.
   *
   * `tall` is spent on a plan and nothing else, which is a decision about
   * `PermissionCard` rather than about this table — so the pin below reads that
   * file for the *reason* the size is chosen: `context.plan`, never the title
   * "Ready to code?", which is what a later tidy-up would quietly reach for.
   */
  const askCardSrc = readFileSync(new URL("../src/ui/AskCard.tsx", import.meta.url), "utf8");
  check(
    "the ask card's height ceilings are literal classes",
    ["max-h-[min(70dvh,100%)]", "max-h-[min(88dvh,100%)]"].map((cls) => askCardSrc.includes(`"${cls}"`)),
    [true, true],
  );
  check("and neither is built out of an interpolation", /max-h-\[min\(\$\{/.test(askCardSrc), false);
  /*
   * The digit beside an answer is a **keyboard** shortcut, so it is hidden on a
   * touch device — on the pointer and never on a breakpoint, since a half-width
   * desktop window still has a keyboard. The handler is deliberately untouched.
   */
  check("the answer numbers are hidden on a coarse pointer", askCardSrc.includes('"pointer-coarse:hidden"'), true);
  check("and that is asked of the pointer, not of the width", /sm:hidden[^"]*\{index \+ 1\}/.test(askCardSrc), false);
  /*
   * ⚠ **Nothing an agent asked reaches a person shortened, and the collapsed bar was
   * the last place in this app that did it.** The daemon stopped clipping a
   * question's prose and a permission's title in this release; a CSS ellipsis over
   * the result would have moved the same loss one layer out, where it is worse
   * because nothing can even say it happened. The bar is one line by intent and has
   * a control that opens it, which is exactly why it looked defensible.
   *
   * Read off disk because `webcheck` has no DOM and this is a class string, and
   * pinned as an *absence* — `truncate` anywhere on this file is the regression,
   * since every other string on the card already wraps.
   */
  // Class attributes only, both spellings — the word survives in this file's own
  // prose, twice, and it is *meant* to: both places argue why the thing it names is
  // not there.
  const askCardClasses = [...askCardSrc.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`)/g)].map(
    (m) => m[1] ?? m[2] ?? "",
  );
  check("the scan found the card's class strings", askCardClasses.length >= 10, true);
  check("and none of them clips text", askCardClasses.filter((cls) => /\btruncate\b/.test(cls)), []);
  check("the collapsed bar wraps instead", askCardSrc.includes('text-xs font-medium wrap-anywhere">{title}'), true);
  /*
   * ⭐ **Cancelling is a ✕ in the header again, and the 4px is what had to change.**
   *
   * It lived there once — two 44px squares at `gap-1`, one of which folds the card
   * away and one of which ends the agent's request — and was moved to the footer
   * for exactly that reason. It is back on the owner's word, so what is asserted is
   * the *mitigation* rather than the position: its own group, behind a hairline,
   * with padding of its own. A tidy-up that drops the border and merges it into the
   * `gap-1` beside the chevron is the regression, and it is the one that would look
   * like simplification.
   */
  check(
    "the header's cancel keeps its own group behind a rule",
    /border-l border-edge\/60 pl-1/.test(askCardSrc),
    true,
  );
  /*
   * And it is drawn on the open card only. A one-line bar is where ending a tool
   * call must not be reachable — the same act Escape gave up, *"a tool call
   * abandoned with nothing on screen explaining what had happened"*. The collapsed
   * branch passes `false`, the open one `true`, and both spellings are pinned
   * because a single `{controls}` reintroduced would put the ✕ on the bar.
   */
  check(
    "and the collapsed bar draws no cancel while the open card does",
    [askCardSrc.includes("{controls(false)}"), askCardSrc.includes("{controls(true)}")],
    [true, true],
  );
  /*
   * The footer is answers only now. It was unconditional *because* it held the
   * cancel; with that gone, a permission drawn as rows would otherwise carry an
   * empty bordered strip under its answers.
   */
  check("the footer no longer draws a cancel of its own", /\{cancel\}/.test(askCardSrc), false);
  check(
    "and is drawn only where there is something to put in it",
    /\{\(layout === "buttons" \|\| \(actions !== undefined && actions !== null\)\) && \(/.test(askCardSrc),
    true,
  );
  /*
   * ⚠ **The card is out of flow, so the transcript reserves its height.** Without
   * this the last rows of a conversation sit under the card with no way out, folded
   * or open — which is the state the fold exists to make readable. Pinned on both
   * sides, because either half alone is silent: the card reporting a height nobody
   * reads, or a scroller padded by a number nothing writes.
   */
  const sessionViewSrc = readFileSync(new URL("../src/ui/SessionView.tsx", import.meta.url), "utf8");
  const eventListSrcForFoot = readFileSync(new URL("../src/ui/EventList.tsx", import.meta.url), "utf8");
  check("the card measures itself for whoever is drawing behind it", /heightOut\.current\?\.\(panel\.offsetHeight\)/.test(askCardSrc), true);
  check("and gives the room back as it goes", /heightOut\.current\?\.\(0\)/.test(askCardSrc), true);
  /*
   * ⚠ **One number, not two that add up.** The reserve was a second `paddingBottom`
   * on the scroll box, above a column that already ends in 48px of its own — so a
   * parked card sat 56px below the last row, reported as a hole. `max` of the two is
   * what makes the gap a decision rather than a sum, and it is asserted where it is
   * spent: in the column, and nowhere else.
   */
  check(
    "the transcript's own foot is what the card raises",
    /paddingBottom: Math\.max\(TRANSCRIPT_FOOT_PX, askHeight \+ ASK_CLEARANCE\)/.test(eventListSrcForFoot),
    true,
  );
  check("and the scroll box outside it pads nothing", /paddingBottom/.test(stripComments(sessionViewSrc)), false);
  check("and chases the tail when it changes, which no resize reports", /\}, \[askHeight\]\);/.test(sessionViewSrc), true);
  /*
   * ⚠ **One gutter for the conversation column, across three files.**
   *
   * The transcript's rows, the ask card floating over them and the box you type in
   * all carry `COLUMN`, and `Composer.tsx`'s own comment said that made the three
   * line up at every width. It did not: `px-3` there against `px-4` on the
   * transcript put the message box 8px wider than every row above it and than the
   * card between them, visible as a step where the card's edge met the box's and
   * reported as one. Three literals in three files agreeing is exactly the claim a
   * comment cannot keep, so it is read off disk.
   *
   * The floor is the three matches themselves: a regex that finds nothing would
   * otherwise agree with itself.
   */
  const composerSrc = stripComments(readFileSync(new URL("../src/ui/Composer.tsx", import.meta.url), "utf8"));
  const gutterOf = (src: string, after: string): string | null => {
    const at = src.indexOf(after);
    if (at < 0) return null;
    return /\bpx-(\d+)\b/.exec(src.slice(at, at + 200))?.[1] ?? null;
  };
  const gutters = {
    transcript: gutterOf(stripComments(eventListSrcForFoot), "${COLUMN} px-"),
    card: gutterOf(stripComments(askCardSrc), "pointer-events-none absolute inset-0 ${COLUMN}"),
    composer: gutterOf(composerSrc, "${COLUMN} px-"),
  };
  check("the three gutters were all found", Object.values(gutters).every((g) => g !== null), true);
  check("and the conversation column has one gutter", gutters, {
    transcript: "4",
    card: "4",
    composer: "4",
  });
  /*
   * **The transcript's record of a settled question draws the question**, which it
   * did not until 0.3.0 — see `answeredQuestions`. Source text, because the join is
   * a prop and a component that simply stopped reading it would leave every pure
   * assertion above green while the screen went back to "Please answer the following
   * questions." over four bare values.
   */
  const eventListSrc = readFileSync(new URL("../src/ui/EventList.tsx", import.meta.url), "utf8");
  check(
    "a settled question's row is handed the questions rather than fetching them",
    /<ElicitationResolvedRow event=\{event\} asked=\{node\.asked\} \/>/.test(eventListSrc),
    true,
  );
  check("and draws each one over its answer", /answer\.question \?\? answer\.label/.test(eventListSrc), true);
  const permissionCardSrc = readFileSync(new URL("../src/ui/PermissionCard.tsx", import.meta.url), "utf8");
  check(
    "a plan gets the room because it is a plan, not because of what it is titled",
    /size=\{context\.plan !== null \? "tall" : "normal"\}/.test(permissionCardSrc),
    true,
  );
  check("and nothing on that card matches a plan by its title", permissionCardSrc.includes("Ready to code?"), false);
  check("and never a ceiling it can shrink under", /(^|\s)(sm:)?max-h-/.test(SHEET_PANEL), false);

  check(
    "the overlay paths",
    [
      "/settings",
      "/settings/account",
      "/settings/machines/m_1/systems/anthropic",
      "/new",
      "/new/m_1",
      "/agent/m_1",
      "/agent/m_1/%2Fhome%2Fme",
    ].map(isOverlayPath),
    [true, true, true, true, true, true, true],
  );
  check(
    "and the screens that are not overlays",
    ["/", "/m/m_1/s/s_1"].map(isOverlayPath),
    [false, false],
  );
  // Whole segments, not a prefix: a future `/settingsomething` is not settings.
  check("a longer first segment is not one of them", isOverlayPath("/settingsomething"), false);

  /*
   * The cross-file pin. Adding a settings section must not be able to create a
   * route the shell does not know to draw as an overlay — which would render it as
   * a bare screen with no ✕ and nothing behind it.
   *
   * `newPath` cannot be reached the same way (it lives in `router.ts`, which this
   * file cannot import), so the `/new` forms above are literals. Said out loud
   * rather than left looking symmetric.
   */
  check(
    "every settings section is an overlay path",
    SECTION_SPECS.every((spec) => isOverlayPath(settingsPath(spec.id))),
    true,
  );
}

/* ------------------------------------------------------------------ *
 * Nothing names a colour that no longer exists
 *
 * **Tailwind v4 does not error on an unknown token.** `bg-warn` with no
 * `--color-warn` in `@theme` emits no rule whatsoever — no background, no build
 * warning, no type error — which was measured on the commit that introduced this
 * palette by building a deliberate `bg-nonexistent` and watching it pass.
 *
 * So the seven names retired when the palette went monochrome cannot be caught by
 * `typecheck` or by `web:build`; a missed call site just loses its fill and looks
 * like a rendering bug months later. This is the gate, in the same source-text
 * style as the two assertions that read `SessionBrowser.tsx` and `Composer.tsx`.
 * ------------------------------------------------------------------ */

process.stdout.write("\nnothing names a colour that no longer exists\n");
{
  /*
   * `add` and `del` were on this list and have come off it.
   *
   * They were retired with the other four when the palette went monochrome, and
   * they are back with real values because a diff is the one thing here that is
   * *content* rather than a control: `danger`'s "never a fill, never more than one
   * in a view" is a rule about identifying a control, and a changed line is neither.
   * What keeps that from being a licence is measured at the tokens themselves — the
   * fill is tinted and the text is not — and enforced below, where their presence is
   * now asserted exactly as the others' absence is.
   */
  const RETIRED = ["accent", "accent-ink", "warn", "ok"];
  const LIVE = ["add", "add-ink", "del", "del-ink", "offer", "offer-ink"];
  const root = new URL("../src/", import.meta.url);
  const files: string[] = [];
  const walk = (dir: URL): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const child = new URL(entry.name + (entry.isDirectory() ? "/" : ""), dir);
      if (entry.isDirectory()) walk(child);
      else if (/\.(tsx?|css)$/.test(entry.name)) files.push(child.pathname);
    }
  };
  walk(root);

  /*
   * The property side, not the whole word: `bg-added` and `text-okay` are not
   * these tokens, and `--color-danger` survives and must not be caught.
   */
  const pattern = new RegExp(
    `\\b(?:text|bg|border|ring|from|to|fill|stroke|decoration|outline|shadow|divide|accent)-(?:${RETIRED.join("|")})\\b`,
  );
  /*
   * Comments are stripped, and that is the opposite decision from the
   * `groups.orphans` assertion two sections up — deliberately, because the two
   * are asking different questions.
   *
   * That one bans a *name* outright: reaching past the helper is wrong however it
   * is spelled, and a comment naming the field is a reader one step from writing
   * it. This one is about a class the browser will try to apply, and this
   * codebase keeps its history in its docblocks — `bits.tsx` explains why
   * `focus:border-accent` was deleted, `Markdown.tsx` says what a link used to
   * be, and `index.css` names `bg-warn` in the very paragraph explaining the
   * hazard this check exists for. Failing on those would mean deleting the record
   * of why the check is here.
   */
  const stripped = (text: string): string =>
    text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const offenders = files
    .filter((file) => pattern.test(stripped(readFileSync(file, "utf8"))))
    .map((file) => file.slice(file.indexOf("/packages/web/") + "/packages/web/".length));

  report(
    "no utility class names a retired colour",
    offenders.length === 0,
    offenders.length === 0 ? `${files.length} files` : offenders.join(", "),
  );
  // And the tokens really are gone, so the gate above is asserting something.
  const css = readFileSync(new URL("../src/index.css", import.meta.url), "utf8");
  check(
    "and the tokens themselves are gone from @theme",
    RETIRED.filter((name) => new RegExp(`^\\s*--color-${name}:`, "m").test(css)),
    [],
  );
  /*
   * The same property from the other side, and it is the half this gate was missing.
   *
   * The hazard is a utility whose token does not exist — the background silently
   * never paints — so banning dead names only covers the case where the *name*
   * arrives last. Deleting `--color-add` while `bg-add` stayed in `DiffView` is the
   * same failure with the two halves swapped, and nothing would have caught it:
   * `typecheck` sees a string, `web:build` emits no rule, and a diff quietly loses
   * the only thing that says which lines were removed.
   */
  check(
    "and the live ones are really declared",
    LIVE.filter((name) => !new RegExp(`^\\s*--color-${name}:`, "m").test(css)),
    [],
  );
  // The one non-neutral value that stayed, and the reason it is the only one.
  check("the one exception survives", /--color-danger:\s*#7e362b/.test(css), true);

  /*
   * ⚠ **`offer` is the only hue on a *control*, and one is the whole of what
   * bounds it.** The palette's argument is that hue tints content — a diff is
   * many tinted lines by construction, so "one per view" cannot be said there —
   * while a colour that identifies a control is held to `danger`'s rule instead:
   * never more than one in a view. A second `bg-offer` would be the edit that
   * turns a named exception into a decoration scheme, and nothing typed can see
   * it, so it is counted here.
   *
   * The label sweep is the other half, and it is the one the token's docblock
   * rests on: the fill is tinted and the text is not. `text-offer-ink` on the
   * *label* would put legibility on the hue and make the greyscale claim false,
   * so the ink is allowed on the glyph and the border and nowhere else.
   */
  const tinted = files.filter((file) => /\bbg-offer\b/.test(stripped(readFileSync(file, "utf8"))));
  check(
    "exactly one control carries the offer tint",
    tinted.map((file) => file.slice(file.lastIndexOf("/") + 1)),
    ["MachineOffer.tsx"],
  );
  check(
    "and the tinted label is `text-fg`, so nothing reads by hue",
    /text-sm font-medium text-fg/.test(stripped(readFileSync(new URL("../src/ui/MachineOffer.tsx", import.meta.url), "utf8"))),
    true,
  );

  /*
   * **A pointer over anything pressable, and the rule is layered.**
   *
   * Tailwind v3's preflight set it and v4 dropped it, so every button in this
   * app drew the ordinary arrow — invisible on a phone, and on a desktop the
   * only cue an unfilled button has left, since with the accent gone a control
   * is drawn in the colour of what it sits on.
   *
   * Both halves are asserted because each fails silently on its own: without
   * `:disabled` the arrow stops distinguishing a control that will not act, and
   * **unlayered it would beat every utility regardless of specificity** — the
   * trap the focus-ring docblock in this same file was written for — making
   * `cursor-default` a dead class wherever somebody needs one.
   */
  const cursorRule = /@layer base \{[\s\S]*?cursor: pointer;[\s\S]*?\}/.exec(css)?.[0] ?? "";
  check("a pressable thing shows a pointer", cursorRule.length > 0, true);
  check("and a disabled one does not", /button:not\(:disabled\)/.test(cursorRule), true);

  /*
   * ⭐ **One way to copy, because the browser API is missing on the deployment
   * this is read from.**
   *
   * `navigator.clipboard` is defined **only in a secure context**, and the control
   * plane is routinely served over plain http on a LAN address — measured on the
   * running stack: `isSecureContext` false, `navigator.clipboard` undefined,
   * `document.execCommand("copy")` true. So a direct call is not a call that
   * sometimes fails; it is a control that never works there, and the three that
   * existed each carried their own `catch` explaining the silence away.
   *
   * The remedy is one module with a fallback, and the thing that keeps it one is
   * this: the API may be named in `ui/clipboard.ts` and nowhere else under
   * `packages/web/src`. Comments are stripped for the reason the palette gate one
   * paragraph up gives — the docblocks here explain what was wrong, and failing on
   * the record of it would delete the record.
   *
   * The reverse half matters as much and is asserted with it: the fallback must
   * still be in that file. A `copyText` that quietly became a bare
   * `navigator.clipboard` call again passes the first check and fails this one.
   */
  const clipboardFile = "src/ui/clipboard.ts";
  const usesClipboardApi = files
    .filter((file) => /navigator\.clipboard/.test(stripped(readFileSync(file, "utf8"))))
    .map((file) => file.slice(file.indexOf("/packages/web/") + "/packages/web/".length));
  check("the clipboard API is named in one file", usesClipboardApi, [clipboardFile]);
  const clipboardSrc = readFileSync(new URL("../src/ui/clipboard.ts", import.meta.url), "utf8");
  check(
    "and that file still carries the insecure-origin fallback",
    /execCommand\("copy"\)/.test(clipboardSrc),
    true,
  );
}

/* ------------------------------------------------------------------ *
 * A URL that will not decode
 *
 * `parse` runs in `router.ts`'s **module body** — `let current =
 * parse(window.location.pathname)` — so a segment `decodeURIComponent` refuses
 * threw during module evaluation and took the whole ES module graph with it. The
 * control plane's SPA fallback served `index.html` correctly, the bundle loaded,
 * and `#root` stayed empty: a blank white page, no error, no console, on a phone,
 * that a reload cannot fix. One truncated link pasted out of a chat app, or a
 * stray `%` typed into the bar, is the whole input.
 *
 * **The import *is* the assertion**, which is why this section is shaped unlike
 * every other one here. There is nothing to hand a fixture to: `parse` is module
 * -private and `useRoute` is a hook, so the parsed *value* cannot be read from a
 * driver with no React — and it does not need to be, because the failure was
 * never a wrong route, it was no application at all. So `window.location.pathname`
 * is set to the malformed path **before** the dynamic import, and the module
 * either evaluates or it does not. Reverting `decodeSegment` to a bare
 * `decodeURIComponent` fails the first check here with the `URIError` itself.
 *
 * The second half is the same claim on the path a tap takes rather than a load:
 * `navigate` re-parses synchronously through `announce`, so a link carrying a
 * malformed id throws out of the click handler with the app already mounted.
 * ------------------------------------------------------------------ */

process.stdout.write("\na URL that will not decode\n");
{
  /*
   * Three more members on the stub, added here rather than at the top: this is
   * the only module that reads any of them, and `pathname` in particular has to
   * carry a *specific* value at import time, which is a property of this section
   * rather than of the fixture every other one shares.
   *
   * `pushState` writes the path back onto the stub, because that is the part of
   * the browser `navigate` relies on: it pushes and then re-parses whatever
   * `window.location.pathname` now says.
   */
  const stub = (globalThis as Record<string, unknown>)["window"] as Record<string, unknown>;
  const loc = stub["location"] as Record<string, unknown>;
  const go = (path: string): void => void (loc["pathname"] = path);
  stub["addEventListener"] = (): void => {};
  stub["history"] = {
    pushState: (_state: unknown, _title: string, path: string): void => go(path),
    replaceState: (_state: unknown, _title: string, path: string): void => go(path),
  };

  // A lone trailing `%` — `decodeURIComponent("s_1%")` is "URI malformed" — in the
  // session half of a real session URL, which is the shape a truncated paste has.
  go("/m/m_1/s/s_1%");

  let router: typeof import("../src/router.js") | null = null;
  let loadError: string | null = null;
  try {
    router = await import("../src/router.js");
  } catch (cause) {
    loadError = String(cause);
  }
  // Reported rather than checked so the rest of the section is reachable when it
  // fails — a throw here would take the enrollment section below with it, which is
  // the crash-truncation failure this file avoids elsewhere by the same means.
  report(
    "the app still evaluates under a path that will not decode",
    loadError === null,
    loadError ?? "imported with window.location.pathname = /m/m_1/s/s_1%",
  );

  if (router !== null) {
    const { navigate, newPath, parsePath, sessionPath } = router;
    const threw = (path: string): string | null => {
      try {
        navigate(path);
        return null;
      } catch (cause) {
        return String(cause);
      }
    };

    check("and a tap on one does not throw out of the handler", threw("/m/m_1/s/s_1%"), null);
    // The machine half, the `/new` route and a bare segment, because each is a
    // separate `decodeSegment` call site and one left bare is one blank page.
    check("nor does a machine id that will not decode", threw("/m/m_1%/s/s_1"), null);
    check("nor does /new with one", threw("/new/m_1%"), null);
    /*
     * The shape a truncated paste really has, as opposed to a lone `%`: an escape
     * that begins and does not finish. `decodeURIComponent("%E0%A4%A")` throws for
     * the same reason and looks nothing like a typo, which is why it is here — a
     * fixture chosen only from the "obvious" `%` would let a half-fixed decode
     * through. (A lone `%` in a segment nothing decodes — `/%`, which is home —
     * never reached the failure at all, so it is not a fixture.)
     */
    check("nor does an escape that begins and does not finish", threw("/m/%E0%A4%A/s/x"), null);

    /*
     * And nothing a link in this app produces goes near any of that: both path
     * builders encode, so the decode is always the inverse of an encode. Asserted
     * with a `%` in the id itself — the value that would round-trip *wrongly* if
     * either side were dropped, rather than merely throw.
     */
    check("what this app builds is encoded", sessionPath({ machineId: "m_1%", sessionId: "s_1%" } as never), "/m/m_1%25/s/s_1%25");
    check("and so is a new-session link", newPath("m_1%" as never), "/new/m_1%25");
  /*
   * The folder rides the path as **one** segment, so a POSIX path cannot split
   * into several however deep it is — which is the whole reason it is not a query
   * string: `parse` reads `pathname` and nothing else.
   */
  check(
    "a folder rides the new-session link as one segment",
    newPath("m_1" as never, "/home/u/api"),
    "/new/m_1/%2Fhome%2Fu%2Fapi",
  );
  check("and comes back whole", (parsePath("/new/m_1/%2Fhome%2Fu%2Fapi") as { cwd: string | null }).cwd, "/home/u/api");
  check("with no folder it is null rather than empty", (parsePath("/new/m_1") as { cwd: string | null }).cwd, null);
  check("and a folder needs a machine to belong to", newPath(undefined, "/home/u/api"), "/new");
    check("which parses without incident", threw(sessionPath({ machineId: "m_1%", sessionId: "s_1%" } as never)), null);
  }
}

/* ------------------------------------------------------------------ *
 * The three lines a daemon is started with
 *
 * Pinned as a literal, because this is text somebody pastes into a shell on
 * another machine and the code inside it is single-use: a wrong variable name
 * fails at daemon startup talking about enrollment rather than about a typo here,
 * and the code is spent either way.
 *
 * **Both values are single-quoted, and that is a hazard rather than a tidy-up.**
 * `controlPlaneUrl` is `publicUrl(c)` on the control plane —
 * `new URL(c.req.url).origin` — so it comes from the request's own `Host` header,
 * which anybody who can reach the service writes. Measured 2026-08-08 through a
 * real `node:http` server: a `Host` of ``a`id`b``, `a$(id)b`, `a'b` and `a;id`
 * all reach `URL.origin` intact, and sourcing the unquoted line then *executes*
 * it — measured, ``export REEMOAT_CONTROL_PLANE=http://a`touch PWNED`b`` created
 * the file and left the variable reading `http://ab`, so the person pasting sees
 * a plausible URL and nothing else. `deploy/lib.sh`'s `sq` has applied this rule
 * to the env file since the `REEMOAT_ENROLL_CODE=xy$(touch PWNED)` incident; the
 * paste is the same text arriving by hand into the same shell.
 *
 * `packages/control-plane/scripts/cpctl.ts` prints the same three lines from its
 * own copy. Two ways to start a machine that print different things is how one of
 * them quietly stops working — and both docblocks used to claim they were kept
 * byte-identical while **nothing anywhere compared them**. That is what the second
 * half of this section is: cpctl's own body, run.
 * ------------------------------------------------------------------ */

process.stdout.write("\nthe three lines a daemon is started with\n");
{
  const { enrollmentLines, enrollmentExpiryText } = await import("../src/enrollment.js");

  check(
    "exactly what cpctl prints",
    enrollmentLines("https://cp.example", "ec_abc"),
    "export REEMOAT_AUTH=signed\nexport REEMOAT_CONTROL_PLANE='https://cp.example'\nexport REEMOAT_ENROLL_CODE='ec_abc'",
  );
  // `REEMOAT_AUTH=signed` is ours and constant, so it is the one line with
  // nothing to quote. Quoting it too would be harmless and is not done, which is
  // worth pinning so nobody "fixes" the asymmetry into a rule about all three.
  check("the constant line carries no quotes", enrollmentLines("https://cp", "ec").split("\n")[0], "export REEMOAT_AUTH=signed");

  /*
   * The four `Host` shapes measured through `URL.origin`, each of which is shell
   * *source* when unquoted. Nothing here asserts the shell's behaviour — that was
   * measured outside this driver — only that every one of them comes out as data.
   */
  const urlLine = (url: string): string | undefined => enrollmentLines(url, "ec_x").split("\n")[1];
  check("a backtick is data", urlLine("http://a`id`b"), "export REEMOAT_CONTROL_PLANE='http://a`id`b'");
  check("so is a command substitution", urlLine("http://a$(id)b"), "export REEMOAT_CONTROL_PLANE='http://a$(id)b'");
  check("so is a semicolon", urlLine("http://a;id"), "export REEMOAT_CONTROL_PLANE='http://a;id'");
  check("and so is an ampersand", urlLine("http://a&id"), "export REEMOAT_CONTROL_PLANE='http://a&id'");
  /*
   * The arm that could be mistaken for defensive, and is not: an apostrophe
   * survives `URL.origin` as measured, so without `'\''` the quoting could be
   * closed and stepped straight out of — which is the whole attack rather than a
   * corner of it.
   */
  check(
    "an apostrophe cannot close the quoting",
    urlLine("http://a'b"),
    "export REEMOAT_CONTROL_PLANE='http://a'\\''b'",
  );
  // The code is minted by the control plane and is not caller-influenced, so this
  // half is belt rather than braces — and it is applied anyway, because a rule
  // that holds for one of two adjacent values is a rule somebody deletes.
  check(
    "the code is quoted by the same rule",
    enrollmentLines("https://cp", "ec_a'b").split("\n")[2],
    "export REEMOAT_ENROLL_CODE='ec_a'\\''b'",
  );

  /**
   * `cpctl`'s own `enrollmentLines`, made callable.
   *
   * It cannot be imported: that file is a CLI whose module body reads
   * `process.argv` and dispatches, it lives in another package, and the function
   * is not exported. So its **source** is read and its **body** is run, which is
   * the only form of this check that compares behaviour rather than a
   * transcription of it.
   *
   * One transformation, and it is narrow on purpose: `: string` is the entire
   * TypeScript content of that body (a local arrow's parameter and return type).
   * If the function grows an annotation this does not know about, the result
   * fails to parse and this driver throws — loudly, which is the failure mode to
   * want, rather than silently comparing something else.
   *
   * `BASE_URL` is a free variable there (`controlPlaneUrl || BASE_URL`), so it is
   * passed in as a third parameter. That fallback is the only permitted
   * difference between the two copies and is asserted below rather than assumed.
   */
  /*
   * ⚠ **Named, because there are two functions extracted this way now.** The
   * second is `shellQuote`, which `packages/control-plane/src/app.ts` has a third
   * copy of for `GET /install.sh` — where the value substituted in comes from the
   * caller's `Host` header, so a copy that drifts is remote code execution in a
   * script people pipe into `sh`. Generalising the name rather than writing a
   * second extractor is what keeps the four refusals below covering both.
   */
  const extract = (
    source: string,
    name: string,
    params: readonly string[],
  ): ((...args: string[]) => string) => {
    const lines = source.split("\n");
    const start = lines.findIndex((line) => line.startsWith(`function ${name}(`));
    if (start < 0) throw new Error(`no top-level ${name} to extract`);
    // A top-level declaration in these files ends at a bare `}` in column 0,
    // which is why this does not have to count braces through template literals.
    const end = lines.indexOf("}", start);
    if (end < 0) throw new Error(`${name} has no closing brace in column 0`);
    const body = lines.slice(start + 1, end).join("\n").replaceAll(": string", "");
    return new Function(...params, body) as (...args: string[]) => string;
  };

  const callable = (source: string): ((url: string, code: string, baseUrl: string) => string) =>
    extract(source, "enrollmentLines", ["controlPlaneUrl", "code", "BASE_URL"]) as (
      url: string,
      code: string,
      baseUrl: string,
    ) => string;

  const cpctl = callable(
    readFileSync(new URL("../../control-plane/scripts/cpctl.ts", import.meta.url), "utf8"),
  );
  for (const [url, code] of [
    ["https://cp.example", "ec_abc"],
    ["http://a`id`b", "ec_x"],
    ["http://a$(id)b", "ec_x"],
    ["http://a'b", "ec_a'b"],
    ["http://a;id", "ec_$(id)"],
  ] as const) {
    check(`cpctl agrees on ${JSON.stringify(url)}`, cpctl(url, code, "https://unused"), enrollmentLines(url, code));
  }
  /*
   * The one divergence, asserted so that it stays the only one. `cpctl` falls back
   * to its own `REEMOAT_CP_URL` when the response carried no URL; the browser
   * copy has no equivalent and needs none, because the page is served by the
   * control plane it is talking to.
   */
  check(
    "cpctl's only divergence is its BASE_URL fallback",
    cpctl("", "ec_x", "https://fallback"),
    enrollmentLines("https://fallback", "ec_x"),
  );

  /*
   * The extraction's **failure mode**, which is the one thing about this check
   * that a reader of `enrollment.ts` is now told to rely on.
   *
   * That docblock used to claim nothing anywhere compared the two copies, which
   * was false in the direction that costs the guard: a contributor tightening the
   * shell quoting would have concluded there was no cross-file check and either
   * edited one copy or deleted this whole block as dead scaffolding. It now says
   * what is actually enforced *and* what the coupling rests on — a top-level
   * `function enrollmentLines(` read to the next bare `}` in column 0 — and
   * promises that renaming or nesting it makes this driver **throw** rather than
   * quietly skip the comparison.
   *
   * A comment cannot be asserted, and this is not an attempt to assert one: it is
   * the property the corrected comment now promises, driven against `callable`
   * itself. A rewrite of the extractor that silently skipped instead — the
   * plausible "improvement", since a throw in a driver looks like a bug — would
   * leave the two copies free to diverge with this section still printing `ok`,
   * and fails here instead.
   */
  const extractionFails = (source: string): boolean => {
    try {
      callable(source);
      return false;
    } catch {
      // The throw is the answer; its message is `callable`'s own and is not pinned
      // here, because what matters is loud rather than which words.
      return true;
    }
  };
  check("a renamed function is not silently skipped", extractionFails("function enrollLines(a, b) {\n  return a;\n}\n"), true);
  check("nor is a nested one", extractionFails("const x = {\n  function enrollmentLines(a, b) {\n    return a;\n  }\n}\n"), true);
  check(
    "nor is one whose closing brace never reaches column 0",
    extractionFails("function enrollmentLines(a, b) {\n  return a;\n  }\n"),
    true,
  );
  /*
   * An annotation *inside* the body that the strip does not know about is a
   * `SyntaxError` out of `new Function` — the same loudness by another route, and
   * the reason the docblock names the one transformation (`: string`, the local
   * arrow's parameter and return type) rather than leaving it to be discovered.
   * The signature line itself is discarded with the braces, which is why this
   * fixture puts the annotation on a local.
   */
  check(
    "and neither is an annotation this cannot strip",
    extractionFails("function enrollmentLines(a, b) {\n  const q = (v: URL) => String(v);\n  return q(a);\n}\n"),
    true,
  );
  // And the shape it does accept, so the three above are refusals rather than a
  // helper that refuses everything.
  check(
    "while the shape cpctl actually has is extracted",
    extractionFails("function enrollmentLines(controlPlaneUrl: string, code: string): string {\n  return controlPlaneUrl;\n}\n"),
    false,
  );

  /*
   * **The third `shellQuote`, compared rather than trusted.**
   *
   * `packages/control-plane/src/app.ts` has its own copy because `GET
   * /install.sh` substitutes an origin into a shell script and cannot import
   * either of the other two — `packages/web` is a Vite bundle that service only
   * serves, and the image's runtime stage carries no web `src` at all. So the
   * agreement is asserted the only way it can be: both bodies read off disk, made
   * callable, and run over the same hostile table.
   *
   * The table is the measured one. A `Host` of ``a`id`b``, `a$(id)b`, `a'b` and
   * `a;id` all reach `URL.origin` intact, and the apostrophe arm is the one that
   * matters most: without `'\''` the quoting can be closed and stepped out of,
   * which is the whole attack rather than a corner of it.
   */
  {
    const quoteOf = (source: string): ((value: string) => string) =>
      extract(source, "shellQuote", ["value"]) as (value: string) => string;
    const webQuote = quoteOf(readFileSync(new URL("../src/enrollment.ts", import.meta.url), "utf8"));
    const appQuote = quoteOf(
      readFileSync(new URL("../../control-plane/src/app.ts", import.meta.url), "utf8"),
    );
    for (const hostile of [
      "https://cp.example",
      "http://a`id`b",
      "http://a$(id)b",
      "http://a'b",
      "http://a;id",
      "http://a$&b",
      "http://a''b",
    ]) {
      check(`app.ts quotes ${JSON.stringify(hostile)} as web does`, appQuote(hostile), webQuote(hostile));
    }
    // And that the shared body is the one that actually defends: a bare
    // `'${value}'` would pass every line above except this one.
    check("an apostrophe is closed, escaped and reopened", appQuote("a'b"), "'a'\\''b'");
  }

  /*
   * `installCommand` — the third place shell text is rendered in this repository,
   * and the first that is *printed on a screen for somebody to paste*.
   */
  {
    const { installCommand } = await import("../src/enrollment.js");
    check(
      "the installer command is the literal both READMEs carry",
      installCommand("https://app.reemoat.com"),
      "curl -fsSL 'https://app.reemoat.com/install.sh' | sh",
    );
    // One trailing slash, removed once — `https://cp//install.sh` is a 404 with
    // nothing in it that says why.
    check("a trailing slash does not double", installCommand("https://cp/"), installCommand("https://cp"));
    // The URL is data here too. It cannot be attacker-chosen on a same-origin
    // page, which is exactly why an unquoted version would have looked fine.
    check(
      "and the origin is data, not source",
      installCommand("http://a`id`b"),
      "curl -fsSL 'http://a`id`b/install.sh' | sh",
    );
  }

  /*
   * **Which screens print it, and which deliberately do not.**
   *
   * The composer strip's `MachineLine` has the same three-arm empty state and is
   * the obvious place to copy this to; it is a field label on a 390px phone
   * beside a door that already leads to the screen that has the command, and
   * `.claude/rules/web-composer.md`'s rule is that a control never leaves the
   * strip. Asserted rather than left to a comment, because "put it in all three"
   * is what a reader of the other two would reasonably do.
   */
  {
    const reads = (path: string): string =>
      stripComments(readFileSync(new URL(`../src/ui/${path}`, import.meta.url), "utf8"));
    const browser = reads("SessionBrowser.tsx");
    const machines = reads("settings/MachinesSection.tsx");
    const newSession = reads("NewSession.tsx");
    check(
      "the two screens with room for it call the one renderer",
      [/installCommand\(/.test(browser), /installCommand\(/.test(machines)],
      [true, true],
    );
    // Never a hand-typed second copy: `docscheck` pins the READMEs against the
    // same function, and a literal here would be a third thing to keep in step.
    check(
      "and neither writes the command out by hand",
      [/curl -fsSL/.test(browser), /curl -fsSL/.test(machines)],
      [false, false],
    );
    check("the new-session strip does not draw it", /installCommand/.test(newSession), false);
    /*
     * And the door-or-the-sentence property is untouched: the command sits inside
     * the `mayAddMachine` arm on both, so the state that says there is no way to
     * add a machine still shows no way to add one.
     */
    check(
      "the command is inside the door arm, not beside the notice",
      [
        /mayAddMachine\(state\.me\) \? \([\s\S]{0,1200}installCommand\(/.test(browser),
        // The door is one arm of a ternary now — the other arm is the notice
        // under the same heading (decision 3B) — so the window is a few tags of
        // wrapper, never long enough to reach across into the notice arm.
        /canAdd \? \([\s\S]{0,200}<CommandLine command=\{installCommand\(/.test(machines),
      ],
      [true, true],
    );

    /* ---------------------------------------------------------------- *
     * And the offer beside it
     *
     * **The paid way to get a machine, drawn only where the free way is.** Same
     * partition as the command and the same reason, one degree stronger for the
     * strip: a link off the origin, sitting between somebody and starting work,
     * is the worst instance of a control leaving it.
     * ---------------------------------------------------------------- */
    const { machineOfferHref } = await import("../src/offer.js");
    const shell = reads("AppShell.tsx");
    const who = (email: string | null): { email: string | null } => ({ email });

    /*
     * The base is operator-supplied and the address is a person's, so both are
     * hostile here. Every row was run before it was written down.
     *
     * The `#top` row is the one the obvious implementation gets wrong:
     * `` `${base}?email=…` `` puts the whole query *inside the fragment*, so the
     * far side receives none of it and the link still opens and still looks
     * right. And `%2B` is not cosmetic — Hono, on the other side, turns a bare
     * `+` into a space before percent-decoding, into a field it renders readonly.
     */
    const rows: [string | null, string | null, string | null][] = [
      ["https://get.reemoat.com", "a@b.com", "https://get.reemoat.com/?email=a%40b.com"],
      ["https://get.reemoat.com/", "a@b.com", "https://get.reemoat.com/?email=a%40b.com"],
      ["https://get.reemoat.com/buy?ref=x", "a@b.com", "https://get.reemoat.com/buy?ref=x&email=a%40b.com"],
      ["https://get.reemoat.com/?email=old@x.com", "a@b.com", "https://get.reemoat.com/?email=a%40b.com"],
      ["https://get.reemoat.com#top", "a@b.com", "https://get.reemoat.com/?email=a%40b.com#top"],
      ["https://get.reemoat.com", "a+b@c.com", "https://get.reemoat.com/?email=a%2Bb%40c.com"],
      ["https://get.reemoat.com", "a@b.com&plan=free", "https://get.reemoat.com/?email=a%40b.com%26plan%3Dfree"],
      ["https://get.reemoat.com", "a@b.com#frag", "https://get.reemoat.com/?email=a%40b.com%23frag"],
      // No address is still an offer: an instance with no SMTP has accounts that
      // never had one, and they are exactly who this is for.
      ["https://get.reemoat.com", null, "https://get.reemoat.com/"],
      // A scheme this must never put in an `href`, on the one origin that holds
      // the browser's credential. `new URL` parses both without throwing.
      ["javascript:alert(1)", "a@b.com", null],
      ["data:text/html,x", "a@b.com", null],
      // Not a URL at all — a scheme-less value would be a relative href, which
      // the SPA fallback answers with this app's own index.html.
      ["get.reemoat.com", "a@b.com", null],
      ["//evil.example", "a@b.com", null],
      // Nothing offered is nothing drawn, whatever the account.
      [null, "a@b.com", null],
      [null, null, null],
    ];
    for (const [base, email, want] of rows) {
      check(
        `an offer at ${JSON.stringify(base)} for ${JSON.stringify(email)}`,
        machineOfferHref(base, who(email) as never),
        want,
      );
    }
    check(
      "an account with no email field at all is the same as one with none",
      machineOfferHref("https://get.reemoat.com", {} as never),
      "https://get.reemoat.com/",
    );

    /*
     * ⚠ **The offer is environment-only, and nothing in `SETTING_KEYS` may name
     * it.** It points at one particular shop run by whoever runs the deployment,
     * and that array is drawn on the Server settings screen of *every* instance —
     * a row there would put a commercial switch in front of every admin of every
     * fork. `main.ts` reads the variable and hands it to the app, the way the
     * plugin catalogue is handled. Asserted from both sides, because "add it to
     * SETTING_KEYS so an admin can change it" is the natural next edit and the
     * one this refuses.
     */
    const cpSettings = readFileSync(new URL("../../control-plane/src/settings.ts", import.meta.url), "utf8");
    const cpMain = readFileSync(new URL("../../control-plane/src/main.ts", import.meta.url), "utf8");
    check("the offer is not a runtime setting", /offer/i.test(cpSettings), false);
    check("and the environment is where it is read", /REEMOAT_CP_MACHINES_OFFER_URL/.test(cpMain), true);

    const drawnOnce = (text: string): boolean => (text.match(/<MachineOffer/g) ?? []).length === 1;
    check(
      "exactly the three screens with room for it draw the offer",
      [drawnOnce(machines), drawnOnce(browser), drawnOnce(shell)],
      [true, true, true],
    );
    check("the composer strip does not draw the offer either", /MachineOffer/.test(newSession), false);
    /*
     * ⚠ **The assertion that matters, and it is pinned from both sides.** A
     * purchase drawn beside "this account cannot add machines" sells a host this
     * control plane will refuse at the dial — the machine comes back here to
     * enroll and that needs a free slot. So: after the command (which keeps the
     * two windows above meaning what they say), and before the notice's own call
     * (which is the other arm).
     */
    const afterTheCommand = (text: string): boolean => text.indexOf("installCommand(") < text.indexOf("<MachineOffer");
    const beforeTheNotice = (text: string): boolean => {
      const offer = text.indexOf("<MachineOffer");
      // The *call*, never the import: `machineQuotaNotice` is named at the top of
      // each of these files as well.
      const notice = text.indexOf("machineQuotaNotice(");
      return offer >= 0 && notice > offer;
    };
    check(
      "the offer is inside the door arm, under the command and never beside the notice",
      [machines, browser, shell].map((text) => afterTheCommand(text) && beforeTheNotice(text)),
      [true, true, true],
    );
    // Off by default is a property of the one renderer, not of three call sites.
    check(
      "and the renderer draws nothing when the instance offers nothing",
      /if \(href === null\) return null;/.test(reads("MachineOffer.tsx")),
      true,
    );
  }

  const now = 1_700_000_000_000;
  check("time left is said in minutes", enrollmentExpiryText(now + 58 * 60_000, now), "expires in 58m");
  check("and in hours when there are some", enrollmentExpiryText(now + 61 * 60_000, now), "expires in 1h 1m");
  check("a spent code says so", enrollmentExpiryText(now - 1, now), "expired");
}

/* ------------------------------------------------------------------ *
 * How wide the rail is
 *
 * `clampRailWidth` is the only place a width is bounded and there are four ways
 * in — the drag, the two keyboard steps, the stored value and the reset — so the
 * interesting cases are the ones no pointer produces: a hand-edited
 * `localStorage` entry, and the `NaN` that `Number.parseInt` answers for it.
 *
 * The shell is asserted the way the retired colours and the `orphansFor` coupling
 * are, by reading source text: what has to hold is that the width reaches the DOM
 * as a **custom property** rather than as a React `style` prop. That is not a
 * preference — `store` publishes on a four-second poll and on every streamed
 * event, so a width React owns is a width that snaps back to the start of the drag
 * every time one lands, and the bug would only ever appear on a session that was
 * talking.
 * ------------------------------------------------------------------ */

process.stdout.write("\nhow wide the rail is\n");
{
  const { MACHINE_COLUMN_PX, RAIL_DEFAULT, RAIL_MAX, RAIL_MIN, clampRailWidth } = await import("../src/ui/rail.js");

  check("the bounds leave a usable range and the default is inside it", [RAIL_MIN < RAIL_DEFAULT, RAIL_DEFAULT < RAIL_MAX], [
    true,
    true,
  ]);
  /*
   * ⚠ **The three bounds asserted by subtraction, where one literal used to be.**
   *
   * `check("the default is the width this shipped at", RAIL_DEFAULT, 312)` was the
   * whole of it, and it was right for a rail that was one column. The rail is two
   * now — the machine folders and the session list — so every bound is the column
   * plus the number it used to be, and a literal would have had to be re-typed
   * three times with the reason living nowhere.
   *
   * Subtracting is what keeps the *old* claims assertable: `rail.ts` argues its
   * floor from the content of a session row, and that argument is about the list,
   * which is `RAIL_MIN - MACHINE_COLUMN_PX`. It also pins something the literals
   * could not — that the column was added **exactly once** to each bound, so a
   * fourth column, or a second addition to one of the three, fails here rather
   * than shipping as a rail that is 72px too wide at one end of its range.
   */
  check(
    "the bounds are the machine column plus the list's own three numbers",
    [RAIL_MIN - MACHINE_COLUMN_PX, RAIL_DEFAULT - MACHINE_COLUMN_PX, RAIL_MAX - MACHINE_COLUMN_PX],
    [240, 312, 480],
  );
  /*
   * And the column is drawn at the width the arithmetic above assumes. Tailwind v4
   * generates nothing from an interpolated utility, so this number is a literal in
   * a class string by necessity; the pair is what stops the two drifting, and the
   * `rem` ban beside it is `index.css`'s own `19.5rem`/`312` defect read one file
   * over — a column in `rem` inside a rail in device pixels reopens it exactly.
   */
  const columnSrc = stripComments(readFileSync(new URL("../src/ui/MachineColumn.tsx", import.meta.url), "utf8"));
  check(
    "and the machine column is drawn at that width, in that unit",
    [
      new RegExp(`w-\\[${MACHINE_COLUMN_PX}px\\]`).test(columnSrc),
      /w-\[[\d.]+r?em\]/.test(columnSrc),
    ],
    [true, false],
  );

  check("a width inside the bounds is kept", clampRailWidth(360), 360);
  check("too narrow is refused rather than allowed", clampRailWidth(10), RAIL_MIN);
  check("and so is too wide", clampRailWidth(4000), RAIL_MAX);
  check("the bounds are inclusive", [clampRailWidth(RAIL_MIN), clampRailWidth(RAIL_MAX)], [RAIL_MIN, RAIL_MAX]);
  check("a fractional pointer position is rounded", clampRailWidth(360.6), 361);

  /*
   * The three a pointer cannot produce. `Number.parseInt("wide", 10)` is `NaN`,
   * and `NaN` compared against a bound is `false` in *both* directions — so a bare
   * `Math.min`/`Math.max` pair passes it through untouched and the rail mounts at
   * `NaN` pixels, which computes to zero width and no visible rail at all.
   */
  check("a hand-edited storage value cannot produce a rail of NaN", clampRailWidth(Number.NaN), RAIL_DEFAULT);
  check("nor can an infinity", [clampRailWidth(Infinity), clampRailWidth(-Infinity)], [RAIL_DEFAULT, RAIL_DEFAULT]);

  /*
   * **The two halves a source-text pin cannot see, and both are load-bearing.**
   *
   * Everything above asserts the clamp and the wiring, and every one of them stays
   * green with the body of `setRailWidth` reduced to `width = next`. That is not a
   * hypothetical: it leaves a rail that still *drags* — the handle writes the
   * custom property itself — while the width silently stops surviving a reload and
   * the keyboard and the double-click reset stop doing anything at all, because
   * both of those reach the DOM only through the subscriber that re-runs
   * `AppShell`'s effect. A feature broken in three places with seven drivers green
   * is the shape this repo calls a property the code appears to have and nothing
   * enforces, so it is asserted behaviourally rather than by reading the file.
   */
  const { railWidth, setRailWidth, subscribeRail } = await import("../src/ui/rail.js");

  let notified = 0;
  const unsubscribe = subscribeRail(() => void (notified += 1));

  setRailWidth(RAIL_DEFAULT + 40);
  check("a committed width is readable back", railWidth(), RAIL_DEFAULT + 40);
  check("and every subscriber is told", notified, 1);
  check(
    "and it is written where a reload will find it",
    storage.get("reemoat.railWidth"),
    String(RAIL_DEFAULT + 40),
  );

  // Idempotent: the drag commits on every `pointerup`, including the ones that
  // moved nothing, and a fan-out per no-op would re-render the shell for nothing.
  setRailWidth(RAIL_DEFAULT + 40);
  check("committing the same width again tells nobody", notified, 1);

  // Out of range still commits — clamped — rather than being dropped, which is
  // what makes a drag that runs off the edge settle at the bound instead of
  // snapping back to where it started.
  setRailWidth(9999);
  check("a width past the bound commits the bound", railWidth(), RAIL_MAX);
  check("and that is a change, so it is announced", notified, 2);

  unsubscribe();
  setRailWidth(RAIL_DEFAULT);
  check("and an unsubscribed listener stops hearing", notified, 2);
  check("while the value still moved", railWidth(), RAIL_DEFAULT);

  const shell = readFileSync(new URL("../src/ui/AppShell.tsx", import.meta.url), "utf8");
  check(
    "the width reaches the rail as a custom property, not a React style prop",
    /lg:w-\[var\(--rail-w\)\]/.test(shell),
    true,
  );
  check("and nothing sets an inline width on the aside", /<aside[^>]*style=/.test(shell), false);
  check("the drag writes that property directly", /setProperty\("--rail-w"/.test(shell), true);
  check(
    "the handle is bounded by the same helper the store is",
    /clampRailWidth\(origin\.width \+ event\.clientX - origin\.x\)/.test(shell),
    true,
  );
  /*
   * Capture rather than `window` listeners, and this is the half that is invisible
   * to every other check here: released outside the browser window, an uncaptured
   * pointer delivers no `pointerup` to the document at all, so the strip stays
   * armed and the next click anywhere resizes the rail.
   */
  check("the drag captures its pointer", /setPointerCapture\(event\.pointerId\)/.test(shell), true);
  check("and adds no window listener to leak", /window\.addEventListener\("pointer/.test(shell), false);

  /*
   * **The handle paints above the two sticky bars, and both halves of that are
   * reversible by an edit that looks like tidying.**
   *
   * `Header` is `sticky` at `LAYER.header` and `Composer` is `sticky` in the same
   * pane. A positioned element with `z-auto` loses to one with `z-30`, so the grab
   * strip has to carry `LAYER.header` *and* come after `<main>` — equal z-index,
   * later sibling. Move `<RailHandle />` back between the panes, or drop the layer
   * class, and the top and bottom of a full-height divider go dead while every
   * driver here stays green and the app looks entirely normal.
   */
  check("the handle is on the z-order table rather than a literal", /\$\{LAYER\.header\}/.test(shell), true);
  /*
   * Both operands are checked against `>= 0` first: rename either and `indexOf`
   * answers -1, and `n > -1` is *true* for every real position, so an unguarded
   * comparison passes with the ordering it pins no longer expressible.
   */
  const railHandle = shell.indexOf("<RailHandle />");
  const contentPane = shell.indexOf("<main ");
  check("the handle is still rendered by the shell", railHandle >= 0, true);
  check("and there is still a content pane for it to follow", contentPane >= 0, true);
  check(
    "and comes after the content pane, which is what breaks the tie",
    railHandle >= 0 && contentPane >= 0 && railHandle > contentPane,
    true,
  );
  check("it is anchored on the rail's own width", /left: "var\(--rail-w\)"/.test(shell), true);

  /*
   * `index.css` has to carry the default too. The effect that syncs the stored
   * width runs *after* first paint, so without a declared value the rail mounts at
   * whatever `w-[var(--rail-w)]` falls back to — which is nothing — and jumps a
   * frame later on every reload.
   */
  const css = readFileSync(new URL("../src/index.css", import.meta.url), "utf8");
  /*
   * **Derived from `RAIL_DEFAULT`, not a second literal**, which is the whole point
   * of the check rather than a nicety. It was written `/--rail-w:\s*19\.5rem/` and
   * passed beside `check(RAIL_DEFAULT, 312)` — two numbers pinned independently,
   * with nothing asserting they are the same number, and they were not: `19.5rem`
   * is 312px only at a 16px root, nothing in this app sets one, and `AppShell`
   * writes px unconditionally. So a reader on Chrome's "Large" got a 78px snap on
   * every load, of exactly the kind the CSS declaration exists to prevent, with
   * both assertions green. Same move `pincheck` makes for an agent version written
   * down in two files.
   */
  check(
    "and CSS declares the same number in the same unit, so the first paint is not a jump",
    new RegExp(`--rail-w:\\s*${RAIL_DEFAULT}px`).test(css),
    true,
  );
  check("and nothing declares it in a unit that depends on the reader's font size", /--rail-w:\s*[\d.]+r?em/.test(css), false);
  check(
    "the handle is in the one focus rule rather than styling its own",
    /\[role="separator"\]\[tabindex\]/.test(css),
    true,
  );
}

/* ------------------------------------------------------------------
 * **The menu drawer, the machine column, and the version in the footer.**
 *
 * Three surfaces that arrived together and are held apart here for one reason:
 * each of them reproduces, on a new axis, a rule this app has already got wrong
 * once. The drawer is a modal layer that is **not** a route, which is the first
 * one in this app — so what holds it is the `LayerKind` it registers, and `"menu"`
 * is the plausible wrong answer (`TaskPanel` picks it, correctly, for the opposite
 * geometry). The column is a strip whose axis changed, and three pieces of the
 * horizontal one are *wrong* rather than merely unnecessary on it. And the version
 * is a build-time constant read through an identifier this driver's own runtime
 * does not define, which is a `ReferenceError` at module evaluation if the guard
 * is ever "simplified".
 *
 * Every sweep below carries a floor, because a regex matching nothing passes.
 * ------------------------------------------------------------------ */

process.stdout.write("\nthe menu, the machines and the build\n");
{
  const drawer = stripComments(readFileSync(new URL("../src/ui/MenuDrawer.tsx", import.meta.url), "utf8"));
  const column = stripComments(readFileSync(new URL("../src/ui/MachineColumn.tsx", import.meta.url), "utf8"));
  const browser = stripComments(readFileSync(new URL("../src/ui/SessionBrowser.tsx", import.meta.url), "utf8"));
  const css = readFileSync(new URL("../src/index.css", import.meta.url), "utf8");
  const { shortcutsEnabled } = await import("../src/ui/overlay.js");
  report("all three surfaces were found to read", [drawer.length, column.length, browser.length].every((n) => n > 500), "three files, none of them empty");

  /* ---- the drawer covers the app, and is not a docked panel ---- */

  /*
   * ⚠ **`"sheet"`, and `TaskPanel` is the precedent that must not be copied.**
   * That panel registers `"menu"` on purpose — at `xl` it docks *beside* the
   * conversation with no scrim, and `inert` on `#root` would kill the transcript it
   * was opened to read alongside. This one is scrim-backed at every width. With
   * `"menu"`, `shortcutsEnabled` stays true, and `keyboard.ts` records exactly what
   * that costs: `inert` stops taps and focus but **not** a `window` keydown, so `j`
   * and `k` would walk the session list behind an opaque panel, navigating to
   * sessions nobody can see. Both halves are pinned, because the true one alone
   * passes on a file carrying both.
   */
  check(
    "the drawer covers the app rather than docking beside it",
    [/useDismissible\("sheet"/.test(drawer), /useDismissible\("menu"/.test(drawer)],
    [true, false],
  );
  /*
   * And the pure half, which is what actually holds the behaviour the kind buys.
   * The source text says which string was typed; this says what that string does.
   */
  check("so a drawer on the stack silences the bare-letter shortcuts", shortcutsEnabled([{ id: 91, kind: "sheet" }]), false);
  /*
   * ⚠ **And the layer lasts as long as the panel does, which is the half the kind
   * cannot say.**
   *
   * `useDismissible` pushes on its third argument and pops in the effect's
   * cleanup; `pop` runs `syncInert`, so `#root` loses `inert` and
   * `shortcutsEnabled` goes true again the instant the last `sheet` leaves the
   * stack. Passed `open`, that happened `DRAWER_EXIT_MS` **before** the element
   * stopped existing — the drawer covered the app for the whole slide-out while
   * the app behind it was live again, so `j`/`k` walked the session list and Tab
   * reached controls nobody could see. Every check above was green over it: the
   * kind was `"sheet"`, the durations agreed, the scrim still caught taps. It is
   * keyboard-only, which is why looking at it did not find it.
   *
   * Asserted as an **identity between two derivations** rather than as the literal
   * `shown`: the argument the hook is handed and the binding the mount guard
   * returns on are read separately and compared, so renaming the flag keeps this
   * green and passing the wrong one cannot.
   */
  const layerActive = /useDismissible\("sheet",\s*onClose,\s*([A-Za-z_$][\w$]*)\)/.exec(drawer)?.[1] ?? "";
  const mountGuard = /if \(!([A-Za-z_$][\w$]*)\) return null;/.exec(drawer)?.[1] ?? "";
  report(
    "the layer's lifetime and the panel's were both found",
    layerActive.length > 0 && mountGuard.length > 0,
    `layer on ${layerActive}, mounted on ${mountGuard}`,
  );
  check("the sheet layer lives exactly as long as the panel it covers the app with", layerActive, mountGuard);

  /* ---- and there is a way out that is not the scrim ---- */

  /*
   * ⚠ **`inert` is what makes the scrim's own argument false here.** `Sheet` may
   * say "the rows behind it are the accessible way out" because it draws a real
   * ✕; this panel registers `"sheet"`, so the rows behind it are precisely what
   * cannot be reached, and the scrim is an `aria-hidden` `<div>` by the same
   * reasoning that keeps it from being a phantom tab stop. Escape works, so the
   * population this was broken for is narrow and real: a screen-reader user on a
   * touch device, with no dismiss control at all.
   *
   * Matched on the *label*, and the `onClose` half asserted inside the matched
   * element rather than anywhere in the file — a ✕ wired to something else, or a
   * label on one control and the handler on another, is the shape that would read
   * as fixed and not be.
   */
  const CLOSER = /<IconButton[^>]*?label="Close[^"]*"[\s\S]{0,240}?\/>/;
  report(
    "the close-control sweep can see one",
    CLOSER.test('<IconButton icon={X} label="Close menu" onClick={onClose} size="nav" />'),
    "positive control",
  );
  const closer = CLOSER.exec(drawer)?.[0] ?? "";
  report("the drawer draws a labelled close control", closer.length > 0, closer.replace(/\s+/g, " ").trim());
  check("and it is the one that closes the drawer, at the sheet's own size", [/onClick=\{onClose\}/.test(closer), /size="nav"/.test(closer)], [true, true]);
  /*
   * `aria-modal` beside `role="dialog"`, which is `Sheet`'s idiom. It is a
   * description rather than a claim here: the `"sheet"` layer really does inert
   * the rest of the document, so without the attribute the announcement and the
   * reality disagree.
   */
  check("it announces itself as modal, which the inert it installs makes true", [/role="dialog"/.test(drawer), /aria-modal="true"/.test(drawer)], [true, true]);
  /*
   * ⚠ **The exiting scrim stops taking taps the instant it starts leaving.**
   * `--animate-scrim-out` ends at `opacity: 0` while the element lives the full
   * `DRAWER_EXIT_MS`, so it was an invisible viewport-sized click-eater for the
   * tail of every close — and under `prefers-reduced-motion`, where `index.css`
   * forces `animation-duration: 0.01ms !important`, for essentially all of it.
   *
   * Read out of the scrim element alone, with **both** ends of the slice anchored:
   * an `indexOf` that misses gives -1 and `slice` reads a negative end as counting
   * from the end of the string, so an unguarded slice widens to most of the file
   * instead of emptying — which is four of this repository's measured
   * false-greens.
   */
  const scrimAt = drawer.indexOf("aria-hidden={true}");
  const scrimEnd = scrimAt < 0 ? -1 : drawer.indexOf("/>", scrimAt);
  const scrim = scrimAt >= 0 && scrimEnd > scrimAt ? drawer.slice(scrimAt, scrimEnd) : "";
  report("the scrim element was found, both ends anchored", scrim.length > 0 && scrim.length < 600, `${scrim.length} chars`);
  check(
    "the scrim swallows no taps once it is only a fade",
    [/pointer-events-none/.test(scrim), /onClick=\{leaving \?/.test(scrim)],
    [true, true],
  );

  /* ---- and a heading over these rows shares their left edge ---- */

  /*
   * ⚠ **`MENU_HEADING` is the *popover* heading and carries its own `px-2.5`.**
   * `bits.tsx` states the rule absolutely — "a heading that did not share that
   * left edge is the one arrangement worth preventing" — and importing it over
   * `DRAWER_ROW`, which is `px-3`, reached exactly that arrangement: the word
   * `screens` sat 2px inboard of the rows it heads, inside the same `px-1.5`
   * scroller. `.claude/rules/web-typography.md` is the rule; the fix is a spelled-
   * out constant at this panel's inset, because appending `px-3` to the imported
   * one is resolved by Tailwind's emission order rather than by the string.
   *
   * Both insets are **derived from the source strings** rather than pinned at
   * `px-3`, so this holds through a change to the row's own padding and can only
   * go green when the two agree.
   */
  const insetOf = (name: string): string =>
    /(?:^|\s)(px-[\w.[\]/-]+)/.exec(new RegExp(`const ${name} = "([^"]*)"`).exec(drawer)?.[1] ?? "")?.[1] ?? "";
  const rowInset = insetOf("DRAWER_ROW");
  const headingInset = insetOf("DRAWER_HEADING");
  report("both insets were read off the drawer's own constants", rowInset.length > 0 && headingInset.length > 0, `rows ${rowInset}, heading ${headingInset}`);
  check("the heading over these rows shares their left edge", headingInset, rowInset);
  check("and the popover's heading is not borrowed for them", /MENU_HEADING/.test(drawer), false);
  /*
   * It is still the one caps idiom, at `MENU_HEADING`'s own tone — the choice
   * between the three constants is a colour decision, and only the padding is this
   * panel's. Asserted so that "spelled out" cannot quietly become "a different
   * treatment".
   */
  const headingClasses = /const DRAWER_HEADING = "([^"]*)"/.exec(drawer)?.[1] ?? "";
  check(
    "and it is the same caps idiom at the menu's tone",
    ["text-2xs", "font-semibold", "tracking-wider", "uppercase", "text-faint"].every((part) => headingClasses.includes(part)),
    true,
  );
  /*
   * ⚠ **Portaled, and not for tidiness.** `inert` lands on `#root`; a drawer
   * rendered inside it inerts *itself* — visible, scrimmed and completely
   * untouchable, with nothing in the console. `Sheet` is portaled for this and for
   * a second reason it states: `position: fixed` resolves against the nearest
   * `backdrop-filter` ancestor, and this app's header, composer and rail footer are
   * each one hop from one.
   */
  check(
    "it is portaled beside #root, which is the element inert lands on",
    /createPortal\(/.test(drawer) && /document\.body/.test(drawer),
    true,
  );
  check("it paints from the z-order table rather than a literal", /\$\{LAYER\.overlay\}/.test(drawer), true);
  check("and reads no breakpoint in JavaScript", /matchMedia|innerWidth|clientWidth/.test(drawer), false);
  /*
   * **No hand-rolled focus trap, which is `overlay.ts`'s standing rule** — `inert`
   * is the mechanism. The second cost is the one that would be invisible: a
   * `[role="dialog"][tabindex]` is a focusable element type outside `index.css`'s
   * one `:focus-visible` selector list, so it would take focus and draw no ring.
   */
  check("there is no hand-rolled focus trap", /tabIndex/.test(drawer), false);

  /* ---- and it moves like the sheet it is a sibling of ---- */

  check(
    "the drawer arrives from its edge, over the one scrim this app has",
    [/animate-drawer/.test(drawer), /animate-scrim/.test(drawer), /bg-fg\/25/.test(drawer)],
    [true, true, true],
  );
  /*
   * ⚠ **The two durations asserted *equal* rather than `260` pinned twice.** A
   * drawer arriving from the left and a sheet arriving from the bottom are one
   * gesture in this app — "a layer covers the app" — and a second easing or a
   * second clock would be a second decision about it, made by whoever typed the
   * second rule rather than argued anywhere.
   */
  const sheetMs = /--animate-sheet:\s*sheet\s+(\d+)ms/.exec(css)?.[1] ?? "";
  const drawerMs = /--animate-drawer:\s*drawer\s+(\d+)ms/.exec(css)?.[1] ?? "";
  report("both movements were found in the stylesheet", sheetMs.length > 0 && drawerMs.length > 0, `sheet ${sheetMs}ms, drawer ${drawerMs}ms`);
  check("and the drawer travels on the sheet's clock", drawerMs, sheetMs);
  /*
   * Its own keyframe, on the inline axis — and never the arrival's name with
   * `reverse` composed onto it, which `sheet-out`'s docblock records as playing
   * once and never playing back.
   */
  check("its keyframe moves on the inline axis", /@keyframes drawer \{\s*from \{\s*transform: translateX\(-100%\);/.test(css), true);
  check("and it does not try to leave by reversing its arrival", /animate-drawer[^"`]*\breverse\b/.test(drawer), false);
  /*
   * ⚠ **It leaves under its own keyframe, and the wait is the same number.**
   *
   * Opening is a CSS animation on mount and needs no state; leaving cannot be,
   * because an unmounted element does not animate — so the panel is kept on screen
   * for the duration with the outgoing animation on it and then dropped. The two
   * numbers live in two files that cannot see each other, which is exactly the
   * shape `--rail-w`/`RAIL_DEFAULT` is pinned for, so this reads the stylesheet's
   * and asserts the component's against it.
   *
   * `both` is the half that is invisible when it is missing: without a fill the
   * panel snaps back to rest for the frames between the animation ending and React
   * dropping it — a flash of the full drawer after it has already left.
   */
  const outMs = /--animate-drawer-out:\s*drawer-out\s+(\d+)ms[^;]*\bboth\b/.exec(css)?.[1] ?? "";
  report("the departure was found, and it fills forwards", outMs.length > 0, `${outMs}ms both`);
  const waitMs = /DRAWER_EXIT_MS = (\d+);/.exec(drawer)?.[1] ?? "";
  check("the panel waits exactly as long as the movement it is playing", waitMs, outMs);
  check(
    "and the scrim leaves with it rather than blinking out",
    /animate-scrim-out/.test(drawer) && /@keyframes drawer-out/.test(css),
    true,
  );
  /*
   * ⚠ **And the exit is decided during render, never in an effect.**
   *
   * This shipped as an effect keyed on `open` and the defect was visible on every
   * close: an effect runs *after* the commit, so the render where `open` first
   * turns false still saw `leaving === false`, took the early return and
   * **unmounted the panel** — a painted frame with no drawer in it — and only then
   * did the effect set the flag and remount it to play the exit. What that looks
   * like is the menu vanishing and then calmly closing a moment later, which is
   * how it was reported.
   *
   * Asserted as source text because it is invisible to everything else here: the
   * class strings were right, the durations agreed, and every check was green over
   * it. The negative half is the one that matters — an effect whose dependency
   * list is `[open]` is the shape that regressed, and a reader restoring it would
   * otherwise only be caught by eye.
   */
  check(
    "the exit is derived during render rather than scheduled after the commit",
    [/if \(open !== wasOpen\.current\)/.test(drawer), /\}, \[open\]\);/.test(drawer)],
    [true, false],
  );

  /* ---- what is in it, and what may not be ---- */

  /*
   * ⚠ **Asserted as an ordered list rather than as three `includes`**, so a fourth
   * destination fails here instead of passing as "still a menu". `MenuDrawer`'s
   * docblock sets the test a row must pass and records that `Account` fails one
   * clause of it deliberately; this is what stops the next row failing it by
   * accident.
   */
  /*
   * ⚠ **Two destinations, and `Account` is deliberately not one.** It is
   * `DEFAULT_SECTION`, so `settingsPath()` already opens on it — a row here would
   * be the same door drawn twice, which is the middle clause of the test
   * `MenuDrawer`'s docblock carries over from `ProfileMenu`. Asserted as an
   * ordered list rather than as `includes`, so a fourth destination fails here
   * instead of passing as "still a menu".
   *
   * ⚠ **Any call, never an allowlist of the ones expected.** This matched
   * `settingsPath(...)|marketPath()` alone and so was structurally incapable of the
   * failure the paragraph above promises: `go(pluginPath(machine, plugin.id))` was
   * already in the file and the sweep reported `["settingsPath()", "marketPath()"]`
   * as "no others". A capture that names what it is looking for cannot see what it
   * is not. The `navigate` count beside it closes the other door — a row written
   * without `go` at all.
   */
  const destinations = [...drawer.matchAll(/go\(([A-Za-z_$][\w$]*\([^)]*\))\)/g)].map((m) => m[1]);
  check("the drawer's destinations, in order and no others", destinations, [
    "settingsPath()",
    "marketPath()",
    "pluginPath(machine, plugin.id)",
  ]);
  check("and nothing navigates except the helper itself", (drawer.match(/navigate\(/g) ?? []).length, 1);
  /*
   * ⚠ **And every one of them goes through the one helper that closes first.**
   * `AppShell` is handed `route={background}`, and every destination above is an
   * overlay path — so `background` does not change when a row navigates and a
   * listener on it would fire never. `App`'s effect on `usePathname()` is the belt;
   * this is the brace, and a row calling `navigate` directly would leave the drawer
   * standing open over the sheet it had just opened.
   */
  check(
    "and each goes through the helper that closes the drawer first",
    /const go = [\s\S]{0,80}?onClose\(\);\s*navigate\(path\);/.test(drawer),
    true,
  );
  /*
   * The head is who you are and it is **not** a control — that is what the Account
   * row below it is for, and a pressable identity plus a row naming the account is
   * the same door drawn twice.
   */
  check(
    "it opens with who you are, and that is not itself a control",
    [/<Monogram /.test(drawer), /<button[^>]*>\s*<Monogram/.test(drawer)],
    [true, false],
  );
  /*
   * The head is an avatar rather than an initial, and the face is derived from the
   * name. The pure half — that it is derived at all, rather than rolled — is
   * asserted below; this is only that the drawer asks for one.
   */
  check("and it draws a face rather than a letter", /personEmoji\(name\)/.test(drawer) && /size="md"/.test(drawer), true);
  /*
   * ⚠ **Derived, never rolled.** A face that changed between renders would be the
   * one thing on this screen that moves for no reason — and this rail re-renders
   * on the four-second poll and on every stream event, so "no reason" would mean
   * several times a minute. The property is stability first and spread second: it
   * does not need to be a good hash, it needs to be the *same* hash next time.
   *
   * `Math.random` is asserted absent from the module rather than inferred from two
   * equal calls, because two calls agreeing is exactly what a cached random value
   * would also do.
   */
  const { personEmoji } = await import("../src/ui/bits.js");
  const faces = ["admin", "rends", "someone else", "Ада", "🙂 leading emoji"].map((n) => personEmoji(n));
  check("a face is the same one every time it is asked", faces, ["admin", "rends", "someone else", "Ада", "🙂 leading emoji"].map((n) => personEmoji(n)));
  check("an empty name still gets one rather than a blank circle", personEmoji(null).length > 0 && personEmoji("").length > 0, true);
  report("and the names tried here do not all land on one face", new Set(faces).size > 1, `${new Set(faces).size} of ${faces.length}`);
  const bitsSrc = stripComments(readFileSync(new URL("../src/ui/bits.tsx", import.meta.url), "utf8"));
  check("and nothing rolls it", /Math\.random/.test(bitsSrc), false);
  /*
   * No zero-width joiners and no variation selectors in the list: those render as
   * two glyphs, or as a black-and-white silhouette, on whichever platform has not
   * shipped the pair — and a broken face is worse than the letter it replaced.
   */
  const faceList = /const FACES = \[([^\]]*)\]/.exec(bitsSrc)?.[1] ?? "";
  report("the face list was found", faceList.length > 0, `${(faceList.match(/"/g) ?? []).length / 2} faces`);
  check("every face is one code point", [/\u200d/.test(faceList), /\ufe0f/.test(faceList)], [false, false]);
  /*
   * ⚠ **No product mark at the foot.** A wordmark there is a thing to look at
   * rather than to read, and the fact this line carries is which build you are
   * running. Asserted as an absence because an absence is what a later reader
   * would otherwise "fix".
   */
  check("and the foot carries the build and no wordmark", [/Version \{APP_VERSION\}/.test(drawer), /<Mark\b/.test(drawer)], [true, false]);
  check("the one extra fact is still drawn only when it is true", /me\?\.via === "api_key"/.test(drawer), true);
  /*
   * The way out is last, separated, and the only row here that is not a
   * navigation. It is drawn outside any `me !== null` guard on purpose:
   * `bootstrap`'s catch keeps `phase: "ready"` with no `me` when the control plane
   * is unreachable, and an outage is the worst moment for it to disappear.
   */
  /*
   * ⚠ **Ordering, not adjacency.** This matched a `border-t` within 120 characters
   * of `text-danger` and went red the moment the row grew a wrapper — a check that
   * fails for a reason it does not name, which this file's own header calls crying
   * wolf. What actually has to hold is the *arrangement*: the way out is separated
   * from the destinations above it, and it sits above the build line rather than
   * below it, because a version is the last thing on a panel and an action is not.
   */
  const signOutAt = drawer.indexOf("store.signOut()");
  const versionAt = drawer.indexOf("Version {APP_VERSION}");
  report("the way out and the build line were both found", signOutAt > 0 && versionAt > 0, `${signOutAt} then ${versionAt}`);
  check(
    "the way out is separated, drawn as a refusal, and sits above the build line",
    [/border-t border-edge/.test(drawer), /text-danger/.test(drawer), signOutAt < versionAt],
    [true, true, true],
  );
  check(
    "the machine's plugin screens survived the move, still gated on there being some",
    /screenPlugins\(/.test(drawer) && /launchable\.length > 0/.test(drawer),
    true,
  );
  check("and the help popover left with the footer it sat in", /HelpButton/.test(drawer) || /HelpButton/.test(browser), false);

  /* ---- one menu button at each width, chosen in CSS ---- */

  /*
   * ⚠ **Two mounts and a class string, which is `AppShell`'s rule.** The phone's
   * copy sits in the header row and is withdrawn at `lg`; the desktop's is at the
   * top of the machine column, which is itself only ever rendered inside an
   * `<aside>` that is `hidden … lg:flex` — so it carries no breakpoint of its own,
   * and a `lg:` on it would be a second, disagreeing answer to the same question.
   */
  /*
   * ⚠ **Matched on the label rather than on the element.** The column's copy is a
   * plain `<button>` running the full 72px — `ICON_BUTTON_SIZE.chip` is `h-8 w-8`
   * and a `w-full` composed onto it is two width utilities of equal specificity
   * resolved by emission order — while the phone's is still an `IconButton`. What
   * has to hold is that there is one at each width and that the breakpoint is a
   * class string, not which primitive draws it.
   */
  const TRIGGER = /(?:<IconButton[^>]*label="Menu"|aria-label="Menu")[\s\S]{0,320}?(?:\/>|<\/button>)/;
  report(
    "the trigger sweep can see both spellings",
    TRIGGER.test('<IconButton icon={MenuIcon} label="Menu" size="chip" />') &&
      TRIGGER.test('<button aria-label="Menu" className="x"><Icon /></button>'),
    "positive control",
  );
  const phoneTrigger = TRIGGER.exec(browser)?.[0] ?? "";
  const deskTrigger = TRIGGER.exec(column)?.[0] ?? "";
  check("the list header opens the menu, and so does the machine column", [phoneTrigger.length > 0, deskTrigger.length > 0], [true, true]);
  check("the list header's copy is withdrawn where the column draws one", /lg:hidden/.test(phoneTrigger), true);
  check("and the column's needs no breakpoint, being inside the lg aside", /\blg:/.test(deskTrigger), false);

  /* ---- one data source, two axes ---- */

  /*
   * ⚠ **The same four calls in both files.** There is one answer to "which machine
   * am I looking at" — `groups.ts` module state — and two presentations of it, so
   * picking a machine on a phone and picking one on a desktop write the same
   * `localStorage` key and cannot disagree. `allTab` is asserted beside
   * `machineTabs` because it is returned separately and is the one a second
   * presentation is most likely to forget.
   */
  report("the call sweep can see one", /machineTabs\(/.test("machineTabs(groups, view)"), "positive control");
  for (const [what, code] of [
    ["the phone's tab strip", browser],
    ["the desktop column", column],
  ] as const) {
    check(`${what} is drawn from the tab list and the All tab beside it`, [/machineTabs\(/.test(code), /allTab\(/.test(code)], [true, true]);
    check(`${what} selects through the store`, /selectMachine\(/.test(code), true);
    /*
     * And reveals the selection when it *changes*, not on every render. This rail
     * re-renders on the four-second poll and on every stream event; an effect
     * without that dependency yanks a strip you had scrolled back to the selected
     * entry, repeatedly, which is the "a list that moves under a travelling thumb"
     * failure both components spend their comments avoiding.
     */
    check(`${what} reveals the selection on a change rather than every render`, /\}, \[selected/.test(code), true);
  }
  /*
   * ⚠ **Three things the horizontal strip carries that the column must not, and
   * each is *wrong* on a vertical axis rather than merely unnecessary.**
   *
   * `.no-scrollbar`'s licence in `index.css` is granted to "a strip dragged
   * sideways whose contents announce there is more of them by being cut off at the
   * edge", and that docblock says outright: never on a vertical list, where a bar
   * is the only thing saying how much more there is.
   *
   * `.edge-fade`'s `is-cut` arithmetic is `scrollWidth - clientWidth`, which on a
   * vertical box is zero for ever — so the gradient would never light, and nothing
   * would fail. That is the silent half, and it is why this is a check rather than
   * a comment.
   *
   * `overscroll-contain` on a box that may have nothing to scroll ends the scroll
   * chain anyway — 400px of wheel travel against 0px on the same gesture, measured
   * — and a fleet of one puts a single entry in here.
   */
  check(
    "and the column carries none of the horizontal strip's three cues",
    [/no-scrollbar/.test(column), /edge-fade/.test(column), /overscroll-contain/.test(column), /scrollWidth/.test(column)],
    [false, false, false, false],
  );
  check("while the strip it was borrowed from still has them", /no-scrollbar/.test(browser) && /edge-fade/.test(browser), true);
  /*
   * ⚠ **The phone's strip is a tab bar, not a row of pills.** The selected tab is
   * marked by a rule under the word — the one shape that survives translating an
   * accent-coloured underline into a monochrome palette — rather than by a
   * `bg-raised` fill, which is 1.22:1 on `ink` and is the tone this app keeps
   * failing to divide anything with. Asserted in both directions, because a
   * revert to pills leaves the underline component in the file unused and every
   * other check green.
   */
  check(
    "the machine tabs mark the selected one with a rule rather than a fill",
    [/function TabUnderline\(\)/.test(browser), /\{tab\.selected && <TabUnderline \/>\}/.test(browser), /rounded-full px-2\.5 text-xs/.test(browser)],
    [true, true, false],
  );
  /*
   * The column is divided by a line and paints no ground of its own: `ink` against
   * `surface` is 1.06:1, too small a step to divide two panes, and this element
   * sits inside an `<aside>` that already paints `bg-ink`. A third plane in a
   * palette that has three in total is not available.
   */
  const nav = /<nav[^>]*className="([^"]*)"/.exec(column)?.[1] ?? "";
  report("the column's own element was found", nav.length > 0, nav);
  check("it is divided by a line and paints no ground of its own", [/border-r border-edge/.test(nav), /\bbg-/.test(nav)], [true, false]);

  /* ---- the list header, and what it no longer refuses ---- */

  /*
   * ⚠ **Nothing in this row answers a tap with nothing.** The fleet-wide magnifier
   * was drawn `disabled` beside a live search box one row down; in a single row
   * forty pixels apart that is the conflation Q3.211 drew them apart to prevent
   * rather than the distinction. The live box is asserted present in the same
   * breath, so "deleted the wrong one" fails here too.
   */
  report("the refusal sweep can see one", /label="Search everything/.test('label="Search everything — not built yet"'), "positive control");
  check(
    "the header's search is the one that works, and there is no second, dead one",
    [/label="Search everything/.test(browser), /aria-label="Search sessions"/.test(browser)],
    [false, true],
  );
  /*
   * ⚠ **And the list screen still has a heading, exactly once.** Below `lg` there
   * is no `Header` on this route at all, so this `<h1>` is the only heading on the
   * app's primary screen — `Header.tsx`'s docblock rests on it. The wordmark moved
   * to the drawer's footer; the element did not move anywhere.
   */
  check("the list column still names the app for a screen reader, exactly once", (browser.match(/<h1\b/g) ?? []).length, 1);
  /*
   * The footer is one button. Full width with a leading glyph, never a floating
   * action button — the rail's every other row is full-bleed, and a circle over the
   * end of the list covers the row it is sitting on.
   */
  const footAt = browser.indexOf("function SidebarFoot");
  const footEnd = browser.indexOf("\n}\n", footAt);
  // Both ends, never one. `indexOf` answers -1 for a terminator that moved, and
  // `slice(from, -1)` reads a negative end as counting from the end of the string —
  // so an unguarded end widens this slice to the rest of the file instead of
  // emptying it, and every positive assertion below becomes satisfiable from some
  // other component. The floor under it cannot detect that: a widened slice is
  // longer, not shorter. Same guard as `between()` in `scripts/nativecheck.ts`.
  const foot = footAt < 0 || footEnd <= footAt ? "" : browser.slice(footAt, footEnd);
  report("the footer was found", foot.length > 0, `${foot.length} chars`);
  check(
    "New session is still a full-width button at the foot of the list, and never a FAB",
    [/size="sm"[\s\S]{0,120}className="w-full"/.test(foot), /\bfixed\b|\babsolute\b|\brounded-full\b/.test(foot)],
    [true, false],
  );
  check("the account row left, and the footer still draws no rule the composer's cannot meet", /ProfileMenu|border-t/.test(foot), false);

  /* ---- the build, drawn once, read from one place ---- */

  const version = stripComments(readFileSync(new URL("../src/version.ts", import.meta.url), "utf8"));
  check("the drawer says what build this is", /APP_VERSION/.test(drawer), true);
  /*
   * ⚠ **`typeof`, and the two halves of this check are the whole rule.** This
   * driver imports the app's modules under plain `tsx` with no Vite, so
   * `__APP_VERSION__` is not defined here at all: a bare reference — or
   * `__APP_VERSION__ === undefined`, which reads as the careful spelling — throws
   * `ReferenceError` during *module evaluation*, taking down every check that
   * transitively imports it with an error naming neither the file nor the
   * identifier. `typeof` on an undeclared name is the one read JavaScript defines.
   */
  check(
    "the constant guards the identifier a Vite-less import does not define",
    [/typeof __APP_VERSION__ === "string"/.test(version), /__APP_VERSION__\s*===\s*undefined/.test(version)],
    [true, false],
  );
  const { APP_VERSION } = await import("../src/version.js");
  check("so this driver, which has no Vite, gets the fallback rather than a ReferenceError", APP_VERSION, "dev");
  /*
   * And the build reads the manifest rather than writing the number down a second
   * time. `pincheck` already holds that manifest against the root, the other two
   * workspace manifests, `DAEMON_VERSION`, the control plane's `VERSION` and the
   * CHANGELOG — seven copies of which six are asserted against each other. A
   * literal in `src/` would be the eighth, asserted by nothing.
   */
  const viteConfig = stripComments(readFileSync(new URL("../vite.config.ts", import.meta.url), "utf8"));
  check(
    "and the build reads it from this package's manifest rather than a second literal",
    /__APP_VERSION__: JSON\.stringify\(/.test(viteConfig) &&
      /JSON\.parse\(readFileSync\(new URL\("\.\/package\.json"/.test(viteConfig),
    true,
  );
}
