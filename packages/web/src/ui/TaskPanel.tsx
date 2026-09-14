import { Bot, Square, X } from "lucide-react";
import { memo, useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { errorText } from "../http";
import {
  dotCells,
  TASK_CHIPS,
  taskDuration,
  taskElapsedMs,
  taskKindLabel,
  taskSections,
  taskTitle,
  taskTokens,
} from "../tasks";
import { taskFinished, type BackgroundTask } from "../wire";
import type { OutstandingTask } from "./tail";
import { Icon, IconButton, SETTINGS_HEADING, SHEET_HEAD } from "./bits";
import { LAYER, useDismissible } from "./overlay";

/**
 * How wide the docked panel is at `xl`, and the gutter the conversation opens for
 * it — **one length, and the two class strings that spend it.**
 *
 * ⚠ **They have to be equal and nothing can derive one from the other**, because a
 * Tailwind class only exists if it survives a scan of the source *as a literal*:
 * `` `xl:w-[${W}]` `` emits no CSS at all, so neither half can be built from a
 * number and there is no single string both can be cut from. What is available is
 * putting both copies on two adjacent lines under one docblock, so that changing
 * one is done with the other on screen. They were written out instead — the width
 * here, the padding four hundred lines into `SessionView` — and the *conversation's*
 * half was the one a driver grepped for, as a literal, in `SessionView`'s source.
 * So the watched half was the gutter and **nothing at all watched this width**: a
 * 28rem panel over a 26rem gutter was the direction that could go out of step in
 * silence. Moving both here does not by itself fix that — what does is the driver
 * now reading the two rem values out of these two lines and asserting they are
 * equal, which is a pin neither half ever had.
 *
 * `SessionView` imports {@link TASK_PANEL_GUTTER} and puts it on the column
 * holding the header, the transcript and the composer, because the panel is
 * `position: fixed` and displaces nothing by itself. Below `xl` neither applies:
 * the panel is a sheet *over* the conversation and there is nothing to make room
 * for.
 */
export const TASK_PANEL_WIDTH = "xl:w-[26rem]";
/** The other half of {@link TASK_PANEL_WIDTH}: the same length, as padding. */
export const TASK_PANEL_GUTTER = "xl:pr-[26rem]";

/**
 * Everything this session left running, on a surface of its own.
 *
 * ⚠ **Two placements, one element, and the breakpoint is answered only in CSS.**
 * Below `xl` this is a bottom sheet over the conversation — the geometry the
 * settings pop-up uses on a phone, because that is the shape somebody asked for
 * and the shape this app already teaches. At `xl` it docks against the right edge
 * and `SessionView` pads itself out of the way, so the conversation is beside it
 * rather than under it. `AppShell`'s rule holds here: nothing in JavaScript knows
 * what `xl` is, so a resized window cannot end up drawing a docked panel over a
 * conversation that did not make room for it.
 *
 * ⚠ **Portaled, and not because it is modal — because `fixed` has to mean the
 * viewport.** `Sheet.tsx` states the mechanism and this panel inherits it:
 * `position: fixed` resolves against the nearest ancestor carrying `filter` /
 * `backdrop-filter` / `transform` / `perspective` / `contain`, and this app's
 * header and composer are one hop from a `backdrop-blur`. A panel rendered in
 * place inside `SessionView` would be positioned against whichever of those it
 * happened to sit under. The *measured* half of that — the stacking-context
 * regression from rendering in place rather than portaling — is `AskCard`'s
 * docblock, which is where `Sheet.tsx` points too; nothing about it was re-run
 * for this surface.
 *
 * ⚠ **It is `menu` in the overlay stack rather than `sheet`, and that is the
 * whole of what "not modal" means here.** A `sheet` puts `inert` on `#root`,
 * which would switch off the conversation this panel is docked *beside* at `xl` —
 * and there is no way to make that conditional without asking JavaScript what the
 * breakpoint is. So: Escape closes the topmost layer as everywhere else, the ask
 * card's digit shortcuts stand down while it is open exactly as they do under any
 * open menu, and nothing behind it is switched off.
 *
 * ⚠ **What this panel cannot draw, and why the gaps are silences rather than
 * zeroes.** Claude Code's own dialog shows, for a workflow, an agent count, a
 * per-agent table of model / tokens / time, and an `N/M` phase fraction. **None of
 * those is on this wire.** The adapter marks every `local_agent` task `ignored`
 * before publishing anything, so a workflow's ten agents never leave the CLI; the
 * three `async_task_*` payloads carry no phase, no fraction, no model and no agent
 * count at all. Drawing `0 agents` or `0/10` would be a claim, so the fraction is
 * omitted — which is Claude Code's own rule for a phase whose total is zero — and
 * the meter draws the one moving cell that says *something is going and nobody is
 * saying how far*.
 */
export function TaskPanel({
  open,
  onClose,
  tasks,
  background,
  reports,
  onStopTask,
}: {
  open: boolean;
  onClose: () => void;
  /** The transcript's delegations — the `Agents` section, and a different source. */
  tasks: readonly OutstandingTask[];
  /** What the agent said it left running, from the snapshot. */
  background: readonly BackgroundTask[];
  /**
   * Whether this agent reports background work at all.
   *
   * ⚠ **The only thing that can tell an empty list from an unasked question.**
   * claude is the one agent of the four with a lifecycle on the wire; kimi
   * backgrounds shells, agents and cron jobs and says nothing, codex leaves a PTY
   * running behind an ordinary tool call, and opencode cannot background at all.
   * `No tasks currently running` is Claude Code's sentence and it is a *claim* —
   * true for claude, false for the other three, and this is the field that keeps
   * it from being said about them.
   */
  reports: boolean;
  /** `null` where nothing can stop one — an older daemon, or a session with no agent. */
  onStopTask: ((task: BackgroundTask) => Promise<void>) | null;
}): ReactNode {
  useDismissible("menu", onClose, open);
  if (!open) return null;
  return createPortal(
    <>
      {/* The scrim exists only where the panel covers the conversation. At `xl`
          the panel is beside it and there is nothing to dim — and a scrim that
          followed it there would grey out the transcript somebody opened this to
          read alongside. */}
      <div
        aria-hidden={true}
        className={`fixed inset-0 bg-fg/25 xl:hidden ${LAYER.overlay}`}
        onClick={onClose}
      />
      {/*
       * ⚠ **The material tokens are `SHEET_PANEL`'s, in `SHEET_PANEL`'s order, and
       * they are spelled out here rather than composed — which is the one place in
       * this panel where `web-typography.md`'s "extracting a constant does not
       * retire an idiom" is knowingly not obeyed.** The shared twelve are
       * `pb-safe animate-sheet flex h-[92dvh] min-h-0 flex-col overflow-hidden
       * rounded-t-2xl border-t border-edge bg-surface shadow-2xl`, and the `aside`
       * below writes them in that order, so a diff against `bits.tsx` lines up.
       *
       * **The positioning is deliberately not shared, and that is the half that
       * cannot be composed even in principle.** `SHEET_PANEL` carries `relative
       * w-full` because `Sheet.tsx` hands it to a `fixed inset-0 flex flex-col
       * justify-end` scrim that does the positioning for it; here the scrim is a
       * sibling that exists only below `xl`, so this element is the positioned one
       * and takes `fixed inset-x-0 bottom-0` instead. Those three are not
       * `SHEET_PANEL` tokens and its two are absent — which is why the question to
       * ask of this string later is *"are the twelve still the constant's, in its
       * order?"* and never *"does this match `SHEET_PANEL`?"*, a thing it was never
       * true of. `SHEET_PANEL` is a bottom
       * sheet *and* a centred card: `sm:h-[min(44rem,88dvh)] sm:max-w-2xl
       * sm:rounded-2xl sm:border sm:pb-0 sm:animate-rise`. This surface is a bottom
       * sheet at every width below `xl` — it has a rail beside it, not a backdrop
       * around it — so composing that string means cancelling six utilities in the
       * `sm:` variant, and a cancellation of the *same property in the same
       * variant* is exactly the trap `SETTINGS_HEADING` carries its own warning
       * about: `sm:h-[92dvh]` against `sm:h-[min(44rem,88dvh)]` is resolved by
       * Tailwind's emission order and not by the order of the string, so the height
       * of this panel would be decided by which file the scanner reached first.
       * `SHEET_HEAD` below has no such half and *is* composed.
       *
       * What is shared is therefore shared by writing the same tokens: `h-[92dvh]`
       * rather than the `top-[8dvh] bottom-0` it replaces, which is the same
       * geometry and the same grep. `xl:h-auto` is what that costs — with `top`,
       * `bottom` and a definite `height` all set, the height wins and `bottom` is
       * ignored, so the docked panel would stop 8dvh short of the floor.
       */}
      <aside
        aria-label="Background"
        className={`pb-safe animate-sheet fixed inset-x-0 bottom-0 flex h-[92dvh] min-h-0 flex-col overflow-hidden rounded-t-2xl border-t border-edge bg-surface shadow-2xl ${TASK_PANEL_WIDTH} xl:inset-y-0 xl:right-0 xl:left-auto xl:h-auto xl:animate-none xl:rounded-none xl:border-t-0 xl:border-l xl:pb-0 xl:shadow-none ${LAYER.overlay}`}
        role="dialog"
      >
        <PanelHead onClose={onClose} />
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4 sm:px-5">
          <PanelBody
            background={background}
            onStopTask={onStopTask}
            reports={reports}
            tasks={tasks}
          />
        </div>
        {/* Claude Code's own footer, one word changed, and it is true here for the
            same reason theirs is: `outputFilePath` points at
            `/private/tmp/claude-<uid>/…/tasks/<id>.output`, outside the workspace,
            which `files-paths-git.md` containment refuses to read. There is no
            detail view to build and this sentence is what says so, rather than an
            absence nobody can explain. Gated on there being something to say it
            about: under `No tasks currently running` it explains the absence of a
            detail view for tasks that do not exist. */}
        {background.length > 0 && (
          <p className="shrink-0 border-t border-edge px-4 py-3 text-2xs text-faint sm:px-5">
            Each task&apos;s output reaches the transcript when it finishes; a per-task view
            isn&apos;t sent to this app.
          </p>
        )}
      </aside>
    </>,
    document.body,
  );
}

/**
 * `Background`, Claude Code's title, and the one control this panel has.
 *
 * ⚠ **No total beside the title, on the owner's call, and the argument holds up:
 * every section already carries its own count and they are the counts somebody
 * came here for.** A second number over them answers a question nobody has —
 * `Agents` and `Completed` are in it, so it is not "how much is running", and it
 * is not any section's figure either. Claude Code's own dialog has no total here;
 * what it puts in this slot is a *subtitle* naming the live kinds.
 */
function PanelHead({ onClose }: { onClose: () => void }): ReactNode {
  return (
    /*
     * `SHEET_HEAD` itself, and the title at the step every other sheet head draws.
     *
     * This row was written out — the same utilities minus `sm:px-5` — and then the
     * title diverged to `text-sm`, two steps under the `text-lg` of the `<h1>` in
     * `Sheet.tsx`, on a surface that below `xl` is visually the same bottom sheet
     * above the same `SHEET_HEAD` row. A quieter title is a claim that this pop-up is a
     * lesser one, which is not true of it and was not argued anywhere; what it
     * actually was is a second copy of an idiom drifting, which is what
     * `web-typography.md` says extracting the constant does not by itself stop.
     * The `sm:px-5` that arrives with the constant is why the scroller and the foot
     * above carry it too — a head inset further than its own contents is the one
     * visible thing composing this could have broken.
     */
    <div className={SHEET_HEAD}>
      <h2 className="min-w-0 flex-1 truncate text-lg font-semibold">Background</h2>
      <IconButton icon={X} label="Close background tasks" onClick={onClose} size="sm" />
    </div>
  );
}

function PanelBody({
  tasks,
  background,
  reports,
  onStopTask,
}: {
  tasks: readonly OutstandingTask[];
  background: readonly BackgroundTask[];
  reports: boolean;
  onStopTask: ((task: BackgroundTask) => Promise<void>) | null;
}): ReactNode {
  /*
   * ⚠ **Memoised because this component hangs off `EventList`, which re-renders on
   * every streamed token — and the panel is open precisely while tokens stream.**
   * `taskSections` allocates five fresh arrays per call, and each `TaskCard` below
   * re-runs `taskTitle`, `taskElapsedMs`, `taskDuration`, `taskTokens` and
   * `dotCells` (which allocates again). At the daemon's own ceiling that is 32
   * cards rebuilt per arriving chunk, on a phone. The daemon already hands back a
   * fresh array only when the set really changed — `sameBackgroundTasks` gates the
   * announce — so the reference is a sound key.
   */
  const sections = useMemo(() => taskSections(background), [background]);
  /*
   * ⚠ **One interval for the whole panel, and it used to be one per card.**
   * `useTick` was called inside `TaskCard`, so a panel at the daemon's own
   * ceiling (`MAX_TRACKED_ASYNC_TASKS`) installed that many independent
   * `setInterval`s — each started whenever its card mounted, so each firing its
   * own `setNow` at its own phase, and React batches nothing across separate
   * timer callbacks. That is up to one render of a card per 1/32 of a second on a
   * phone, to move a clock that ticks once a second. {@link TICK_MS}'s docblock
   * claimed *"the one place in this app that schedules a render for a clock"*,
   * which was true of the app and not of this panel.
   *
   * Gated on something actually running rather than on the panel being open: a
   * list of finished work needs no clock, and `taskElapsedMs` prefers `endedAt`,
   * so a finished card reads the same number whatever `now` says.
   */
  const now = useTick(background.some((task) => !taskFinished(task.state)));
  /*
   * The stem the section headings hang their ids off. `useId` because there can
   * be two of this panel mounted at once for one blink — `OverlaySheet`'s
   * cross-dissolve moment, and a two-pane desktop switching sessions — and an id
   * repeated in the document points every `aria-labelledby` at whichever came
   * first.
   */
  const headings = useId();
  if (tasks.length === 0 && sections.length === 0) {
    /*
     * Two empty states, because there are two reasons to be empty and only one of
     * them is a fact about this machine. See `reports` above: the first sentence
     * is Claude Code's, verbatim, and it is only sayable about an agent that
     * would have told us.
     */
    return (
      <p className="text-2xs text-faint">
        {reports
          ? "No tasks currently running"
          : "This agent doesn't report background work, so nothing here can say whether any is running."}
      </p>
    );
  }
  return (
    <div className="space-y-5">
      {tasks.length > 0 && (
        /* ⚠ **`aria-labelledby` is conditional on the heading being drawn**, and
           it has to be: a section pointing at an id nothing renders has no name
           at all, which is worse than the unnamed region it was meant to fix. The
           two conditions are therefore literally the same expression. */
        <section
          aria-labelledby={sections.length > 0 ? `${headings}-agents` : undefined}
          className="space-y-1.5"
        >
          {/* `Agents` heads its list only when something else is populated —
              Claude Code suppresses its own first heading for the same reason: a
              single labelled group is a label with nothing to distinguish it
              from, and this list was unlabelled for its whole life before the
              second source arrived. */}
          {sections.length > 0 && (
            <PanelHeading count={tasks.length} id={`${headings}-agents`} label="Agents" />
          )}
          {tasks.map((task) => (
            <p className="flex items-center gap-2 text-2xs" key={task.key}>
              <span className="shrink-0 text-muted">
                <Icon as={Bot} size={11} />
              </span>
              <span className="min-w-0 flex-1 truncate text-fg/85">
                {task.title}
                {task.latest !== null && <span className="ml-1.5 text-faint">{task.latest}</span>}
              </span>
              {task.steps > 0 && (
                <span className="shrink-0 text-faint">
                  {task.steps} step{task.steps === 1 ? "" : "s"}
                </span>
              )}
            </p>
          ))}
          {/* The whole semantics of that count, in four words, and it covers the
              delegations only: a background task reports its own end, so "not
              reported finished" is exactly what is *not* true of one. */}
          <p className="text-2xs text-faint">started, and not reported finished</p>
        </section>
      )}
      {sections.map((section, index) => {
        /* From the other side: a machine running only shells draws the cards it
           always would have, unlabelled — and then names no region either, for
           the reason the `Agents` section above states. */
        const named = tasks.length > 0 || sections.length > 1;
        const headingId = `${headings}-${index}`;
        return (
          <section
            aria-labelledby={named ? headingId : undefined}
            className="space-y-1.5"
            key={section.label}
          >
            {named && (
              <PanelHeading count={section.tasks.length} id={headingId} label={section.label} />
            )}
            {section.tasks.map((task) => (
              <TaskCard key={task.id} now={now} onStop={onStopTask} task={task} />
            ))}
          </section>
        );
      })}
    </div>
  );
}

/**
 * `Label (n)` — Claude Code's `Jg`, in this app's one heading idiom.
 *
 * ⚠ **A real `<h3>` carrying an id, and both halves are the fix for the same
 * defect.** This drew a `<p>`. Swept while writing this — `grep -rn
 * SETTINGS_HEADING packages/web/src`, minus the constant's own declaration, the
 * imports and the prose mentions — every call site of the idiom is on a heading
 * element **except eight**, and the eight are the same kind of thing as each
 * other: four `<label>`s (`ForcedPasswordChange`, `SignIn` twice, and `gate/Gate`'s
 * shared `label` constant), two `<span>`s (`OneTimeSecret`'s copyable-value
 * caption, `MarketEntry`'s disclosure label), one `<tr>` (`KeyRow`'s table head)
 * and one `<p>` (`PluginsPanel`'s `What it printed`, which argues its own case in
 * place: a failed plugin per machine would otherwise put that many identical
 * entries into the document outline). Every one of those eight names a *control
 * or a cell* rather than a band of content. Here the bands
 * *are* the content — this is the one surface in the app whose entire job is
 * partitioning work by kind — and with a `<p>` above each of them the panel was a
 * flat run of rows to a screen reader, inside a `role="dialog"` whose own name is
 * the single word `Background`. `<h3>` because the dialog's title is an `<h2>`;
 * nothing in `index.css` styles a heading element, so nothing visual moves.
 *
 * The exceptions are enumerated rather than left as a bare total on purpose:
 * `web-typography.md` makes the point that a count restated in prose is the claim
 * this repository has learned not to keep, and a named set is a thing the grep
 * above can be re-run against one file at a time. The sentence this replaces said
 * *"all but two … a table head and a field label"*, which was wrong in both the
 * total and the shape of the exception set.
 *
 * The id is the other half: a `<section>` with no accessible name is not exposed
 * as a region at all, so the heading would have been announceable while the group
 * under it stayed anonymous. Its caller points `aria-labelledby` here.
 */
function PanelHeading({ label, count, id }: { label: string; count: number; id: string }): ReactNode {
  return (
    <h3 className={SETTINGS_HEADING} id={id}>
      {label} ({count})
    </h3>
  );
}

/**
 * How often a running card's elapsed time is redrawn.
 *
 * ⚠ **The only clock-driven render in the transcript surface** — `MachineInstalls`
 * ticks one the same way for install progress, so this is not the app's only one —
 * and it is affordable only because it is scoped to a surface somebody opened:
 * `tail.ts`
 * refuses an elapsed time on a tool card on the grounds that "a ticking number
 * re-renders the whole transcript once a second", and that objection is about the
 * transcript rather than about seconds. Nothing outside this panel re-renders,
 * the interval is not installed while the panel is closed (the component is not
 * mounted), and it stops as soon as nothing here is running.
 *
 * ⚠ **"The one place" is a claim about a count, so it is called from exactly one
 * place**: `PanelBody`, once, with `now` handed down as a prop. Called from
 * `TaskCard` — which is where it was — the sentence above stayed true of the app
 * and became false of this panel, one timer per card and every one of them on its
 * own phase. See `PanelBody`.
 */
const TICK_MS = 1_000;

function useTick(running: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, [running]);
  return now;
}

/**
 * One task, as a card, and the card is a **typographic hierarchy** rather than a
 * run of facts at one size.
 *
 * ⚠ **That is the whole of what changed here, and it is the third of the owner
 * calls `docs/DECISIONS.md` Q3.603 records against the first version of this
 * panel** — cited rather than quoted, because the wording of the call itself is
 * not written down anywhere and this docblock is not the place to invent one. That
 * first version drew title, kind, duration, tokens and chip as one `text-2xs` line
 * joined by `·`, which is the shape of a transcript *row* — and a row is what this
 * deliberately is not. Four bands, top to bottom, each a step quieter than the one
 * above:
 *
 * 1. **the title**, the only thing here at `text-xs` and the only thing at full
 *    `fg`. Mono for a shell, because a backgrounded shell's title *is* its
 *    command line and this app draws a command in mono — and mono takes the step
 *    below, which `web-typography.md` states as a rule rather than a preference.
 *    ⚠ The ternary below tests the **kind**, not the string, and mono is its
 *    *fallback*: `workflow` and `monitor` are the two named sans arms and
 *    everything else — a shell, and any kind a later adapter sends — lands in
 *    mono. That is the same default `taskSections` files an unknown `taskType`
 *    under `Shells` by, for the same reason: the unnamed kind is a thing the
 *    agent ran.
 * 2. **what it is and how long**, `muted` for the kind and `faint` for the clock.
 * 3. **what the run cost**, the same split one more time: the *numbers* are
 *    `muted` and their nouns are `faint`, which is what makes a glance land on
 *    `429.7k` rather than on `tokens`. Absent entirely where the agent sent no
 *    `usage` — a quiet task has no numbers rather than zeroes.
 * 4. **what it said it was doing**, `faint`, and only where it is not a second
 *    copy of the title.
 *
 * No `·` between bands: the separator was doing the work a line break should.
 * The one `·` left is *inside* band 3, between two facts of one kind.
 *
 * What is absent is absent because it is not on the wire — see the ⚠ on
 * {@link TaskPanel} — and the two numbers that are there arrive only on a
 * progress frame, so a quiet task (a `sleep`, a build that calls nothing) carries
 * neither and band 3 simply does not exist.
 */
const TaskCard = memo(function TaskCard({
  task,
  now,
  onStop,
}: {
  task: BackgroundTask;
  /** The panel's clock — see {@link TICK_MS}. Unread once this card is finished. */
  now: number;
  onStop: ((task: BackgroundTask) => Promise<void>) | null;
}): ReactNode {
  const [stopping, setStopping] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  /*
   * A press is over when the daemon reports a new state for this task, not when the
   * request it sent comes back. See the ⚠ on the control below: the stop response
   * carries no transition, so resolving on it re-arms the button over work that is
   * still stopping. `task.state` is the one signal that means the daemon has
   * something new to say about it, and it covers both directions — terminal, where
   * `offerable` takes the control away, and the `stopped → running` correction,
   * where it has to come back.
   */
  useEffect(() => {
    setStopping(false);
  }, [task.state]);
  const finished = taskFinished(task.state);
  // `noUncheckedIndexedAccess` makes this `| undefined` even over a `Record` on a
  // closed union, and the fallback is the one that fails toward *live*: a state
  // this table has no row for is a state nobody has decided is over.
  const chip = TASK_CHIPS[task.state] ?? TASK_CHIPS.running;
  const offerable = onStop !== null && task.canStop && !finished;
  const title = taskTitle(task);
  const description = task.description === title ? null : task.description;
  const command = task.taskType !== "workflow" && task.taskType !== "monitor";
  return (
    /* `bg-raised/50`: **`web-shell.md` writes down two strengths** — `bg-raised`
       for the message you wrote, `bg-raised/50` for a plan, a wizard's panel and a
       well inside an expanded row — and a card on a panel is the second of those.
       It was `bg-raised/40`, which is a spelling that rule does not carry and which
       `grep -rn bg-raised packages/web/src` finds at no other call site. The reason
       that is worth a line is that nothing can see it: a strength that exists once
       is a palette that has quietly grown a step, and the next surface copies
       whichever one it happened to open.

       ⚠ **What this is not is a claim that the tree now spends exactly two.** The
       same grep still answers `bg-raised/60` at two call sites — `NewSession`'s row
       hover and the dimmed-in-place fill on a removed harness in
       `MachineAgentsSection`, which argues for it at the code. So the rule
       documents two, the tree spends three, and this change is one spelling brought
       back inside the rule rather than the last one outside it. Q3.205, Q3.206. */
    <div className="rounded-lg bg-raised/50 px-3 py-2.5">
      <div className="flex items-start gap-2">
        {/* `break-words` rather than `truncate`: a card is not a row, and a
            backgrounded shell's title *is* its command line — the one string on
            this surface where the part that would be cut is the part somebody is
            looking for. Two lines of command beat one line of `python3 -c "impo…`. */}
        <p
          className={`min-w-0 flex-1 break-words text-fg ${
            command ? "font-mono text-2xs" : "text-xs font-medium"
          }`}
        >
          {title}
          {stopping && !finished && <span className="text-faint"> · stopping…</span>}
        </p>
        {offerable && (
          <span className="-mt-1 -mr-1 shrink-0">
            <IconButton
              disabled={stopping}
              icon={Square}
              label={`Stop ${title}`}
              /*
               * ⚠ **`stopping` means "this press is in flight", and what ends it is
               * the task *moving* — never the response arriving.** Both halves of
               * that were wrong once, in opposite directions.
               *
               * It was first cleared only in the `.catch`, on the assumption that
               * a resolved promise means the task is over and the control is about
               * to disappear anyway. It does not:
               * `POST /sessions/:id/async-tasks/:taskId/stop` answers
               * `{stopped: false}` with a **200** for a task that finished on its
               * own between the tap and the request — the route says so in as many
               * words, and calls it the judgement `/cancel` makes for `no_turn` —
               * and neither that nor a `stopped: true` is a rejection. So the card
               * stayed `disabled` under `· stopping…` for the life of the
               * component.
               *
               * ⚠ **Clearing it on resolution instead is the other error, and it
               * is the worse one.** `ManagedSession.stopBackgroundTask` asks the
               * agent and mutates no task; `applyBackgroundTasks` is fed only from
               * the agent's own edges, and `acp/asynctasks.ts` says outright that
               * the transition arm is *"the only arm that can end one"*. So the
               * snapshot that comes back on the stop response still carries
               * `state: "running"` in the ordinary case — `· stopping…` vanishes
               * and the control comes back **enabled over work that is still being
               * stopped**. Somebody then taps again, and that is the accumulation
               * `withAbandonableDeadline` in `src/session.ts` exists to bound —
               * read its docblock rather than this one for the argument, which is
               * not restated here: a deadline settles *this* daemon's promise and
               * says nothing to the peer, so a tap against a wedged agent leaves a
               * request outstanding in the SDK, and nothing on this side gated a
               * second tap on the first one's silence. `disabled={stopping}` is
               * that gate, and a resolved promise is not permission to open it.
               *
               * What is permission is the daemon reporting a new `state` for this
               * task, which is the effect above: it covers the terminal case (the
               * control disappears with `offerable` anyway) and the
               * `stopped → running` correction the daemon explicitly supports,
               * where the control has to come back. An agent that acknowledges a
               * stop and then never transitions leaves the row saying
               * `· stopping…`, which is the honest description of what is known.
               */
              onClick={() => {
                setStopping(true);
                setFailure(null);
                void onStop(task)
                  .catch((cause: unknown) => {
                    // In the card rather than a toast: the card is what somebody
                    // pressed, and a toast would have to name the task again to be
                    // readable at all. `stopping` is cleared with it, so the control
                    // comes back rather than staying disabled under a failure.
                    setStopping(false);
                    setFailure(errorText(cause));
                  });
              }}
              size="sm"
            />
          </span>
        )}
      </div>
      <p className="mt-1 flex flex-wrap items-baseline gap-x-2 text-2xs">
        <span className="text-muted">{taskKindLabel(task.taskType)}</span>
        <span className="text-faint">{taskDuration(taskElapsedMs(task, now))}</span>
        <span className={chip[1]}>{chip[0]}</span>
      </p>
      {task.usage !== null && (
        <p className="mt-0.5 flex flex-wrap items-baseline gap-x-1 text-2xs text-faint">
          <span className="text-muted">{taskTokens(task.usage.totalTokens)}</span>
          <span>tokens</span>
          <span aria-hidden={true} className="px-1">
            ·
          </span>
          <span className="text-muted">{task.usage.toolUses}</span>
          {/* Claude Code's own noun for this figure, from its agent card:
              `N tool calls`. Not `tool uses`, which is the wire's word for it. */}
          <span>tool {task.usage.toolUses === 1 ? "call" : "calls"}</span>
        </p>
      )}
      {description !== null && description.length > 0 && (
        <p className="mt-2 text-2xs break-words text-faint">{description}</p>
      )}
      {task.taskType === "workflow" && <Phases running={!finished} />}
      {failure !== null && <p className="mt-2 text-2xs text-danger">Couldn&apos;t stop it: {failure}</p>}
    </div>
  );
});

/**
 * A workflow's phases — one of them, always, and never a fraction.
 *
 * Claude Code builds this list from `workflow_phase` progress events and falls
 * back to **one** synthetic phase titled `Agents` when a run reports none. That
 * fallback is the only case this app can ever be in: no phase, no agent and no
 * fraction crosses the AIR wire, so the list is one phase by construction rather
 * than by choice, and the title is theirs.
 *
 * The fraction is omitted rather than drawn as `0/0` — their own rule, at
 * `totalCount > 0 ? … : ""` — and nothing is written where their agent table
 * would be. An empty table under a heading would be a sentence about ten agents
 * that are running; a silence is the only honest thing this wire can say.
 */
function Phases({ running }: { running: boolean }): ReactNode {
  return (
    <div className="mt-3">
      {/* `Phases` is a heading over the box rather than a row inside it, which is
          the shape Claude Code draws and the reason the box below can be a box:
          a title inside its own frame would be a second card.

          ⚠ **And it is deliberately none of `web-typography.md`'s three caps
          constants, nor the caps idiom at all.** `SETTINGS_HEADING` and its two
          siblings are letter-spaced uppercase bands that head *a list of rows*;
          this heads a single framed box two levels down inside a card, where a
          caps band would read as a second card's header. What it takes instead is
          `text-2xs font-medium text-fg` — the same step as the `Agents` line
          inside the box, one weight and one tone louder, which is the whole of
          what makes it read as a label over the frame rather than a row in it.
          That is the same argument `SessionBrowser`'s waiting-elsewhere band makes
          about tone, reached from the other direction: there the type stays the
          caps idiom and only the colour moves. */}
      <p className="text-2xs font-medium text-fg">Phases</p>
      {/* The full-strength `raised`, which is the *other* documented step and the
          one that reads as a box inside the `bg-raised/50` card around it. It was
          `bg-raised/70`, a second undocumented strength in this one file. */}
      <div className="mt-1.5 rounded-md bg-raised px-2.5 py-2">
        <p className="text-2xs text-muted">Agents</p>
        <div className="mt-1.5">
          <Meter running={running} />
        </div>
      </div>
    </div>
  );
}

/**
 * Claude Code's four-cell meter, as four boxes rather than four braille glyphs.
 *
 * `⠿` is what a terminal has; a browser has a box it can paint, and a braille
 * codepoint's width and weight are whichever font the reader's phone fell back to.
 * The arithmetic is theirs exactly ({@link dotCells}), including the cap that
 * keeps one cell moving while anything runs, and `motion-reduce` stops it for the
 * reason their own `t_()` does.
 */
function Meter({ running }: { running: boolean }): ReactNode {
  return (
    <span aria-hidden={true} className="flex shrink-0 items-center gap-1">
      {dotCells(0, 0, running).map((cell, index) => (
        <span
          className={`size-1.5 rounded-full ${
            cell === "empty"
              ? "bg-edge-strong/40"
              : cell === "live"
                ? "animate-pulse bg-add-ink motion-reduce:animate-none"
                : "bg-add-ink"
          }`}
          key={index}
        />
      ))}
    </span>
  );
}
