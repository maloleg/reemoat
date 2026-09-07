import { Bot, Check, ChevronDown, Gauge, MoreHorizontal, SlidersHorizontal, Sparkles } from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentType,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { errorText, meansRestartRefused } from "../http";
import { beginChoice, choicesFor, choicesVersion, endChoice, subscribeChoices } from "../choices";
import { LAYER, useDismissible } from "./overlay";
import { keyOf, type SessionRef } from "../ids";
import { store } from "../store";
import type { AgentConfigChoice, AgentConfigOption, StoredEvent } from "../wire";
import {
  chipParts,
  choiceLabel,
  choiceOverride,
  drawnChoices,
  choiceRefusal,
  configProse,
  labelFor,
  NESTED_HOST,
  slotFor,
  splitOptions,
  unavailableHint,
  withChoice,
  type ChipParts,
  type ConfigProse,
  type DrawnControls,
  effortFollowUp,
} from "./agentConfig";
import { Icon, MENU_HEADING, MENU_PANEL, menuRow, TAP_GROW_Y } from "./bits";
import { toast } from "./Toast";

/**
 * Change one of the agent's controls, and fold in what it answers.
 *
 * Exported because there are two ways to reach these controls now — this bar and
 * the composer's `/model` menu — and the three-step shape is where the rule
 * lives: **render what comes back, never what you asked for.** Setting the model
 * rebuilds the available modes and can reset the current one, so the response is
 * the agent's own refreshed state rather than an echo, and a second copy of this
 * is a second place for that to be forgotten.
 *
 * Resolves either way. `busy` stays with the caller, because the two draw it in
 * different places.
 *
 * **The chosen value is recorded here rather than by a caller**, and that is this
 * docblock's own warning taken seriously: the optimistic override lived in the
 * bar's `useState` for one revision, so the `/effort` menu — the second door this
 * function exists to serve — drew the daemon's value for the whole round trip and
 * read "Adaptive" at somebody who had just chosen "Low". Recorded before the
 * request and released in a `finally`, after `applySnapshot` has folded the
 * answer in, so a success does not move the chip and a refusal snaps it back to
 * the truth beside the toast.
 */
export function applyConfigChange(
  sessionRef: SessionRef,
  configId: string,
  value: string | boolean,
): Promise<boolean> {
  const daemon = store.daemonFor(sessionRef.machineId);
  if (daemon === undefined) {
    toast("error", "that machine is not reachable");
    return Promise.resolve(false);
  }
  /*
   * What the session held before the change, for `effortFollowUp`: a model
   * switch that changes the effort list owes the new model its default, and
   * only the *before* list says whether it changed. Read off the store rather
   * than passed in, since the composer's `/model` menu is the second door and
   * would have to carry it too.
   */
  const before =
    store.getSnapshot().sessions.find((row) => row.key === keyOf(sessionRef))?.snapshot.agentConfig?.options ?? [];
  const held = beginChoice(keyOf(sessionRef), configId, value);
  return daemon
    .setConfig(sessionRef.sessionId, { configId, value })
    .then((result) => {
      store.applySnapshot(sessionRef, result.session);
      /*
       * The follow-up goes through this same function (recorded, sent from the
       * one `setConfig` call site, released) rather than a second request
       * written here. It cannot recurse further: the follow-up is a
       * `thought_level` change, and `effortFollowUp` answers `null` for
       * anything but a `model`.
       */
      const followUp = effortFollowUp(
        before.find((option) => option.id === configId),
        before,
        result.session.agentConfig?.options ?? [],
      );
      if (followUp !== null) return applyConfigChange(sessionRef, followUp.configId, followUp.value);
      return true;
    })
    .catch((cause: unknown) => {
      /*
       * **Said on the row before the tap, and swallowed there** — see
       * `choiceRefusal`. Both doors into this function refuse the value
       * themselves, so what still reaches here is a turn that began between the
       * frame that drew the row and the finger that hit it; the strip draws the
       * sentence one poll later, and Send is already Stop.
       *
       * ⚠ Exactly one code, and `meansRestartRefused` is where the argument for
       * it lives. Everything else on this route is a fact this client could not
       * have known — an unreachable machine, a value the agent refuses, a session
       * that ended — and still says so.
       */
      if (!meansRestartRefused(cause)) toast("error", errorText(cause));
      return false;
    })
    .finally(() => endChoice(held));
}

/**
 * The agent's own controls: mode, model, reasoning effort.
 *
 * **Everything here is drawn from `category`, never from `id`.** The ids are not
 * portable between agents — claude publishes reasoning effort as `effort` with
 * values `default|low|…|max`, kimi publishes it as `thinking` with values
 * `off|…` — so a bar keyed on ids renders one agent's controls and none of the
 * other's. ACP defines `category` for exactly this and says it is a UX hint that
 * must not be required for correctness, which is why an unknown or missing one
 * still renders, just without an icon.
 *
 * Nothing is hardcoded, including the *values*. claude drops
 * `bypassPermissions` from its mode list when it runs as root without
 * `IS_SANDBOX` — so a fixed list of modes would
 * offer a control the agent rejects.
 *
 * The state comes from the snapshot rather than from what was last requested.
 * That is not tidiness: setting the model rebuilds the available modes and can
 * reset the current one, and claude changes its own mode from a hook mid-turn.
 */

const CATEGORY_ICON: Record<string, ComponentType<{ size?: number | string; className?: string }>> = {
  mode: SlidersHorizontal,
  model: Bot,
  thought_level: Gauge,
  model_config: Sparkles,
};

/**
 * One shape for every control in this row.
 *
 * 32px tall and `rounded-md` — the same radius as the textarea six pixels above
 * it, the send button, and every attachment chip. These were `rounded-full`, so
 * the one row that is *part* of the composer was the only round thing in it.
 *
 * The tap target is grown with a pseudo-element rather than by growing the box:
 * 4px up and 8px down turns 32px of ink into 44px of target and costs no layout,
 * so the strip does not get taller on a phone, above a soft keyboard, where the
 * height is paid for out of the transcript. Vertical only, because these sit
 * `gap-1.5` apart and a symmetric inset would put each chip's target over its
 * neighbour's *face* — and the neighbour changes the model. See the growth rule
 * in `bits.tsx`'s header, which this is one half of.
 *
 * No `shrink-0`: these carry `truncate` children and a 320px screen needs them to
 * be allowed to give. Padding stays with each caller so no two conflicting `px-*`
 * utilities ever land on one element.
 */
/*
 * **A chip inside a bounded box carries no boundary of its own, and its chevron
 * is what says it is a control.**
 *
 * ⚠ **This reverses the paragraph that stood here**, which read: *"a control
 * takes its ground's colour and is bounded rather than filled, which is why the
 * border has to be `edge-strong` (≥3:1) and not `edge` (1.31:1 here) — with no
 * fill of its own, the border is the whole of the control's identification."*
 * That is still the app-wide rule and it is still right — for a control standing
 * on a plane of its own. Its premise was that this row is such a plane, and that
 * premise is withdrawn: the strip is now inside the composer's own box, which is
 * itself bounded at `edge-strong`, so seven separately-outlined pills inside one
 * outlined container is the visual noise the box was drawn to remove.
 *
 * What each chip then owes 3:1 is its own **action glyph**, not its text and not
 * a fill. That is the `ChevronDown` at `text-faint` — 6.23:1 on `surface`, and a
 * stronger claim than the 4.40:1 border it replaces, which said only "a control"
 * where this says "a list opens here". **So the chevron is drawn at every width**
 * and may never take a breakpoint; without it a borderless chip is a caption with
 * a decorative glyph. A fill could not do this job in this palette at all —
 * `raised` on `surface` is 1.22:1.
 *
 * The precedent is `menuRow` inside `MENU_PANEL`, whose note in `bits.tsx` makes
 * this exact argument one container down: what identifies a row there is the
 * panel's box and the hover fill, and adding a border to the live rows "would be
 * a new decoration rather than an identification". `ICON_BUTTON_TONE.ghost` is
 * the same shape as a primitive.
 *
 * **`active:bg-raised` is not decoration**, and it is the half `ContextPie` got
 * wrong before it was deleted: it reversed *from* borderless *to* bordered on the
 * grounds that "hover is not a state a phone has at all", which is true and is
 * answered by pressing rather than by a border. `.tap` transitions
 * `background-color`, and `.press`'s `scale(0.97)` is nearly invisible on a
 * control with no edge to scale.
 *
 * `border` stays in this string and only the *colour* moves to the call sites.
 * Two `border-color` utilities on one element is the equal-specificity race
 * `FIELD` documents; and keeping the width shared means a chip that takes a real
 * border for a state — `Toggle` when it is on — does not grow by 2px to do it.
 *
 * The fill is still spent on **state**: `bg-raised` means a toggle that is on and
 * a menu row that is chosen.
 */
/*
 * The size is on `CHIP` and never on either span inside `chipInner`, which is what
 * keeps a reservation an honest measurement: the invisible sizers and the visible
 * value inherit the *same* font, so the column is exactly as wide as the string it
 * was sized from. Set on one of the two and the other reserves for a font nothing
 * is drawn in.
 *
 * `text-2xs` (12px) rather than `text-xs` (13px): one step down a scale that
 * already exists, taken so the strip is a little more compact and so `Ultracode` —
 * the longest value any control here draws — costs less of the row. Line height
 * goes 20px → 18px, still far under `min-h-8`, so no box gets shorter.
 *
 * ⚠ **Height is deliberately not reduced.** `min-h-8` plus `TAP_GROW_Y` is the
 * 44px target above, and the one square button left here is `${CHIP} w-8` — it
 * stops being square the moment height moves without width, and the paperclip,
 * now the composer's rather than this row's, is an `IconButton size="chip"` at a
 * fixed 32px chosen to match it. The chips get smaller horizontally and in type
 * only.
 */
/**
 * How wide a chip's value may get before it truncates.
 *
 * The one bound left after the fixed reserve was withdrawn (Q3.564). 128px is
 * about eighteen characters at `text-2xs`, which clears every ordinary value the
 * four agents publish — `Accept Edits`, `GPT-5.6-Luna`, `Ultracode` — and clips
 * the rare long one rather than letting it take the row. The full text is in the
 * menu and in the chip's `title` either way.
 */
const CHIP_MAX = "max-w-32";

/**
 * How long the config picker's sheet takes to leave, in milliseconds.
 *
 * It stays mounted for exactly this long after it is dismissed so its exit
 * animation can run — a sheet that simply stops being drawn is a panel vanishing
 * between two frames, which is the complaint `sheet-close` answers for the
 * *routed* pop-ups and cannot answer here, there being no navigation to hang a
 * view transition off.
 *
 * ⚠ **The same number is `--animate-sheet-out` in `index.css`** and `webcheck`
 * asserts they agree: shorter, and the slide is cut off mid-travel; longer, and a
 * finished panel sits on the screen waiting to be unmounted.
 */
const SHEET_EXIT_MS = 260;

/**
 * The config sheet's full detent, as the length `.config-sheet` is written in.
 *
 * The **resting** detent is not here: it is `.config-sheet`'s own `--sheet-max`
 * default, because at rest nothing writes anything and a picker whose rows already
 * fit is laid out by its content. This one is written because the gesture has to
 * set it, both as a bound while a finger is down and as the height it settles on.
 *
 * `dvh` and not `vh`, for the reason every other full-height length in this app is
 * `dvh`: on a phone `vh` is the viewport with the browser chrome *retracted*, so a
 * sheet sized in it is taller than the screen for as long as the address bar is
 * showing — the bottom rows sit under it, and on this panel the bottom rows are
 * the ones somebody scrolled to reach.
 *
 * 92 matches `SHEET_PANEL` in `bits.tsx` — the routed sheets' phone height — so
 * the two kinds of sheet in this app agree about what *full* means. And resting at
 * 60 rather than at the 80 this sheet opened at first: 80 is tall enough to look
 * like the whole screen and short enough to still clip a model list, which is the
 * shape that reads as broken.
 *
 * ⚠ **Opening also writes `--sheet-min`, and that is a correction.** It was a
 * `max-height` alone, which clamps a tall list and does nothing whatever to a
 * short one — so the effort picker, four rows and never near 60dvh, could not be
 * expanded at all while the model picker could. Two controls on one row behaving
 * differently under one gesture is the defect; the space below four rows in a
 * sheet somebody deliberately pulled open is not.
 */
const SHEET_FULL = "92dvh";

/**
 * The full detent again, as a fraction, for the one place that needs a number.
 *
 * ⚠ **Written twice — here and as `SHEET_FULL` — because a drag has to compare a
 * pixel height against it and CSS will not hand one over.** The alternative is
 * measuring the panel after forcing it full, which is a layout pass per frame.
 * `webcheck` reads both and asserts they agree, which is the same treatment
 * `SHEET_EXIT_MS` gets against `index.css`.
 *
 * `window.innerHeight` is the multiplicand: it is the *dynamic* viewport on every
 * mobile browser, which is what `dvh` resolves against, so the two spellings mean
 * the same height rather than nearly the same one.
 */
const SHEET_FULL_SHARE = 0.92;

/**
 * How far a finger travels on the sheet before the drag takes over, in pixels.
 *
 * The same 24 the platform uses to tell a scroll from a tap, and it is doing that
 * job here: under it the gesture is still a tap on whatever row it landed on, over
 * it the sheet follows the finger and {@link Select}'s capture handler eats the
 * click. Too small and choosing a model becomes a lottery; too large and the drag
 * reads as dead before it fires.
 */
const SHEET_DRAG_STEP = 24;

/**
 * How far below its resting height the sheet has to be pulled to close, in pixels.
 *
 * Only ever measured *below* rest, where the panel has stopped shortening and is
 * sliding instead — so this is the same gesture and the same distance a phone's
 * own sheets close on, rather than a second rule about heights. Three fingers'
 * width, which is far enough that letting go of a sheet you were only nudging puts
 * it back.
 */
const SHEET_DISMISS_PX = 72;

/**
 * How long the sheet takes to settle onto a detent once a finger lets go.
 *
 * ⚠ **The same number is the literal in `.config-sheet`'s `transition` in
 * `index.css`** — not a custom property, and naming one here would point a reader
 * at re-adding the mechanism that file's own note records taking out: a `var()`
 * inside a shorthand makes every longhand a pending-substitution value. `webcheck`
 * reads the literal out of the stylesheet and asserts they agree, for the reason
 * it does for the exit: this timer is
 * what hands the panel's height back to `.config-sheet`'s own defaults, so a
 * shorter one cuts the settle off mid-travel and a longer one leaves a pixel height
 * pinning a sheet that has stopped moving — which the next open would inherit.
 */
const SHEET_SETTLE_MS = 300;

/*
 * Six pixels between the glyph, the value and the chevron.
 *
 * ⚠ **This was `gap-1` and the argument for it has been withdrawn on the owner's
 * word.** Four pixels was chosen so a chip read as one word rather than three
 * things, and it was also 8px a chip against a 352px row that had just taken Send.
 * Measured on a phone it is the other failure: the glyph and the value *touch*, and
 * a control whose whole identification is its glyph cannot afford to have it read
 * as part of the word beside it. The width it costs is affordable now for the
 * reason the row's own gap is — the model chip folds away below `sm`, so this pays
 * two chips 4px each rather than three.
 */
const CHIP = `tap press relative inline-flex min-h-8 items-center gap-1.5 rounded-md border text-2xs ${TAP_GROW_Y}`;

export function AgentConfigBar({
  sessionRef,
  controls,
  events,
  disabled,
  turnRunning,
}: {
  sessionRef: SessionRef;
  /**
   * What to draw, and whether there is an agent behind it — see `drawnControls`.
   *
   * A pair rather than the snapshot's `agentConfig`, because a restart empties
   * that: the daemon drops the controls with the agent, so the strip went blank
   * for the length of every deploy and every auto-resume. The memory that fills
   * the gap lives in the store, and `stale` is what stops it being tapped.
   */
  controls: DrawnControls;
  /** The loaded transcript, for the prose the snapshot strips. See `configProse`. */
  events: readonly StoredEvent[];
  /** This tab is busy elsewhere — a prompt in flight. Terminal sessions arrive as `stale`. */
  disabled: boolean;
  /**
   * A turn is running, so a change that restarts the agent would be refused —
   * `turnInFlight`, the same field the daemon gates on.
   *
   * **Deliberately not `disabled`**, which is this tab's *own* prompt in flight:
   * it is false for most of a running turn, and false outright for a turn somebody
   * started in another tab. And not `controls.stale`, which is "no live agent" and
   * blind to the turn by construction, `running` being a live status.
   */
  turnRunning: boolean;
}): ReactNode {
  const [busy, setBusy] = useState<string | null>(null);
  const [overflowOpen, setOverflowOpen] = useState(false);
  // Read from module state rather than held here, because the other door into
  // `applyConfigChange` is a sibling component — see `choices.ts`.
  useSyncExternalStore(subscribeChoices, choicesVersion);
  const pending = choicesFor(keyOf(sessionRef));

  const { options: polledOptions, stale, unavailable } = controls;

  /*
   * ⚠ **The polled snapshot carries a *head* of a long model list, and this is
   * where the rest is fetched.** `GET /sessions` bounds every option's choices —
   * sixty records on a four-second poll, over a relay, to a phone, and a keyed
   * opencode publishes 362 models in one control — and flags what it cut with
   * `truncated`. `GET /sessions/:id` is not polled and answers complete, so the
   * moment this bar is asked to draw a cut control it reads the whole thing once
   * and keeps it.
   *
   * Keyed on the session, not on the option: the read is one request for all of
   * them and re-fetching per control would spend the saving it exists to make. It
   * runs once per session per mount — a cut list is a property of which agent is
   * running, and the poll cannot change it without changing the agent.
   *
   * **The polled copy is still what draws until this lands**, which is the point:
   * the head is correct, merely short, and the selected choice is always in it. So
   * the picker is usable immediately and simply grows, rather than showing a
   * spinner over a list that is already good enough to read.
   */
  const [fullOptions, setFullOptions] = useState<readonly AgentConfigOption[] | null>(null);
  const sessionKey = keyOf(sessionRef);
  const anyTruncated = polledOptions.some((one) => one.truncated === true);
  useEffect(() => {
    setFullOptions(null);
  }, [sessionKey]);
  useEffect(() => {
    if (!anyTruncated || fullOptions !== null) return;
    const daemon = store.daemonFor(sessionRef.machineId);
    if (daemon === undefined) return;
    let live = true;
    void daemon
      .session(sessionRef.sessionId)
      .then((answer) => {
        // Nothing is drawn on failure and nothing is said: the head is already on
        // screen and correct, so the honest cost of not reaching the daemon is a
        // shorter menu rather than an error over a control that works.
        if (live) setFullOptions(answer.session.agentConfig?.options ?? null);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [anyTruncated, fullOptions, sessionKey, sessionRef.machineId, sessionRef.sessionId]);

  /*
   * Merged by id, and only for the controls that were actually cut. Everything
   * else keeps the polled object by identity — `drawnChoices` memoises on the
   * `choices` array's identity, so replacing an option that did not change would
   * throw away that cache on every poll.
   */
  const options = useMemo(
    () =>
      fullOptions === null
        ? polledOptions
        : polledOptions.map((one) => {
            if (one.truncated !== true) return one;
            const whole = fullOptions.find((candidate) => candidate.id === one.id);
            if (whole === undefined) return one;
            // `value` from the polled copy, never the fetched one: the poll is
            // newer, and a model changed since this read must not be drawn as
            // still selected.
            return { ...whole, value: one.value, truncated: false };
          }),
    [polledOptions, fullOptions],
  );
  // Above the early return because the registration below reads it, and a hook
  // cannot sit under one. Pure, and the same call it was two lines lower.
  const slots = splitOptions(options);

  /*
   * The `…` panel is a layer like every other menu, and registering it fixes two
   * things at once.
   *
   * **A keystroke aimed at this panel was answering the agent.**
   * `decisionShortcutsEnabled` blocks the ask card's digits on any layer that is
   * not the card's own — and a panel that pushes nothing leaves that stack empty,
   * so with this open over a parked permission a bare `1` approved the command
   * underneath it. `overlay.ts` names the config bar's popover in that docblock;
   * it was the one popover in the app not registered.
   *
   * **And nothing could close it.** Escape belonged to nobody here and the only
   * other dismissal was a second tap on the trigger — which is `disabled` while a
   * config change is in flight, i.e. exactly the window in which the panel was
   * left open with no way out of it.
   *
   * The condition is the panel's own, not the flag's: this state outlives the
   * agent that filled the panel, so a control set that stops overflowing while
   * the panel is open would otherwise leave a layer nothing is drawing.
   */
  useDismissible("menu", () => setOverflowOpen(false), overflowOpen && slots.overflow.length > 0);

  // Memoised on the events array identity, which the store replaces only when the
  // transcript actually changes — this walks the whole window backwards, and the
  // composer re-renders on every keystroke.
  const prose = useMemo(() => configProse(events), [events]);

  // Nothing to draw. The row that holds this cluster is the composer's, and it
  // carries the paperclip and Send whatever an agent has published — so this is
  // an ordinary empty render rather than the predicate it used to be, whose
  // third clause existed only to keep the paperclip alive. See `web-composer.md`.
  if (options.length === 0) return null;

  const apply = (option: AgentConfigOption, value: string | boolean): void => {
    setBusy(option.id);
    // The chosen value is recorded inside `applyConfigChange`, so this call site
    // has nothing to remember and the `/` menu gets the same behaviour without
    // knowing about it.
    void applyConfigChange(sessionRef, option.id, value).finally(() => setBusy(null));
  };

  /*
   * **What the mode picker also holds on a phone.**
   *
   * The model chip leaves the row below `sm` — it is `hidden sm:contents` down in
   * the render — and its choices go here instead, into the one control every agent
   * has. That is one control *drawn* in two places and it is still in exactly one
   * **slot**: `splitOptions` puts it in `right` at every width and the partition
   * is untouched. What differs is which of two renderings the browser draws.
   *
   * Keyed on the category rather than on the id, like everything else in this
   * file, and read off `slots.right` so a session that publishes no model control
   * folds nothing.
   *
   * ⚠ **It folds only where there is somewhere to fold *into*, which is
   * `splitOptions`' own rule for `nested` applied to the same host.** The mode
   * control is not guaranteed: an agent can publish none, and one this client is
   * drawing from memory arrives in `unavailable`, where `Absent` draws a chip with
   * one row and **no nested sections at all**. Either way the model chip would be
   * `hidden` below `sm` with its choices nowhere — a control unreachable on a
   * phone, silently, which is the failure the "a control never leaves the strip"
   * rule exists against. So the fold is conditional and the chip's own class is
   * conditional on the same answer; that is a question about what the agent
   * published rather than about a width, so it is JavaScript's to ask.
   */
  const foldHost = slots.left.find(
    (one) => one.category === NESTED_HOST && one.kind !== "boolean" && !unavailable.has(one.id),
  );
  const foldedBelowSm =
    foldHost === undefined ? [] : slots.right.filter((one) => one.category === "model");

  const control = (option: AgentConfigOption): ReactNode => {
    const nested = option.category === NESTED_HOST ? slots.nested : [];
    const narrow = option.category === NESTED_HOST ? foldedBelowSm : [];
    /*
     * Two flags, and the split is what stops the row flickering.
     *
     * `disabled` is semantic — there is no agent to ask, or this tab is mid-prompt
     * — and it is drawn, by dropping the chip's ink to `text-faint`; see the
     * paragraph on `Select`'s own class string for why that is a token and not an
     * `opacity`. `locked` is the transient exclusion while another control in this
     * row is in flight, and it is **not** drawn: one tap used to dim every chip
     * beside it, and since `opacity` was deliberately absent from `.tap`'s
     * transition list, the whole strip snapped and snapped back around a round
     * trip that is often under a second.
     * The lock itself is kept — setting a model rebuilds the mode list, so two
     * changes at once really do race — it just stopped announcing itself as
     * damage.
     */
    /*
     * A control the agent has stopped offering keeps its slot and says so.
     *
     * Drawn rather than dropped because a button that vanishes moves everything
     * beside it and explains nothing — and the agent dropping it is ordinary:
     * choose Haiku and claude deletes the effort control outright, since it
     * builds those levels from the model. It is a `Select` with one row instead
     * of a shape of its own, so the chip, its width reserve and the menu's
     * dismissal are the same objects as everywhere else on this strip.
     */
    if (unavailable.has(option.id)) {
      return <Absent key={option.id} option={option} />;
    }
    // The chosen value, drawn at once — on the host *and* on anything nested in
    // its menu, since one of those is what a tap on the host's rows changes.
    return option.kind === "boolean" ? (
      <Toggle
        key={option.id}
        option={withChoice(option, pending)}
        prose={prose.get(option.id)}
        disabled={disabled || stale}
        locked={busy !== null}
        onChange={(value) => apply(option, value)}
      />
    ) : (
      <Select
        key={option.id}
        option={withChoice(option, pending)}
        nested={nested.map((sub) => withChoice(sub, pending))}
        narrow={narrow.map((sub) => withChoice(sub, pending))}
        proseOf={(sub) => prose.get(sub.id)}
        disabled={disabled || stale}
        locked={busy !== null}
        // Only `Select`. `Toggle` and `Absent` are untouched: no boolean control
        // restarts the agent, and an absent one already says its own sentence.
        refuses={(sub, value) => choiceRefusal(sub, value, turnRunning)}
        onChange={apply}
      />
    );
  };

  return (
    /*
     * A cluster inside somebody else's row, not a row of its own.
     *
     * `Composer` owns the strip now — it lays out the paperclip, this, and the
     * send slot in one flex line inside the composer's box — so the padding and
     * the outer `flex` that used to be here belong to it. What is left is the two
     * clusters and the rule that separates them, which is the only part that is
     * about the agent's own controls.
     *
     * `min-w-0` is what lets `truncate` fire on a chip inside `flex-1`.
     */
    <div className="flex min-w-0 flex-1 items-center gap-1.5 sm:gap-2">
      {/* Mode on the left, where a permission decision belongs — it is the control
          you reach for when the agent is asking, not one you browse. */}
      <div className="flex min-w-0 items-center gap-1.5 sm:gap-2">{slots.left.map(control)}</div>

      <div className="ml-auto flex min-w-0 items-center gap-1.5 sm:gap-2">
        {slots.right.map((option) =>
          option.category === "model" ? (
            /*
             * **The model chip is drawn above `sm` and folded into the mode
             * picker below it** — see `foldedBelowSm`. `hidden sm:contents` and
             * not `hidden sm:flex`: at `sm` and up this wrapper has to leave the
             * layout entirely or the chip becomes a flex item inside a flex item
             * and stops taking the row's own `gap`.
             *
             * A class and never a measurement in JavaScript, which is
             * `AppShell`'s rule for this app: a window dragged across the
             * breakpoint cannot render a row that is not there, because both are
             * rendered and `display` chooses.
             */
            <div
              key={option.id}
              className={foldedBelowSm.length > 0 ? "hidden sm:contents" : "contents"}
            >
              {control(option)}
            </div>
          ) : (
            control(option)
          ),
        )}

        {slots.overflow.length > 0 && (
          <div className="relative">
            <button
              type="button"
              onClick={() => setOverflowOpen(!overflowOpen)}
              // The same pair as the chips: inert while anything is in flight,
              // dimmed only where there is no agent to reach.
              disabled={disabled || stale || busy !== null}
              aria-label="More controls"
              aria-expanded={overflowOpen}
              // A 32px square, the twin of the paperclip at the other end of the
              // row — and the twin in *tone* as well now that both are ghost, which
              // is the first time that comment has been true. Kept hand-rolled
              // rather than swapped for `IconButton` because `aria-expanded` is
              // load-bearing on a disclosure and that primitive exposes `active` →
              // `aria-pressed`, a different promise.
              //
              // `${CHIP}` stays interpolated rather than inlined: `webcheck` sweeps
              // hand-rolled `h-N w-N` buttons for a 44px signal in the same class
              // attribute, and this one is exempt only because the string is not
              // written out here.
              className={`${CHIP} w-8 justify-center border-transparent ${
                disabled || stale
                  ? "text-faint"
                  : "text-muted hover:bg-raised active:bg-raised hover:text-fg"
              }`}
            >
              <Icon as={MoreHorizontal} size={13} />
            </button>
            {overflowOpen && (
              <div
                className={`absolute right-0 bottom-full ${LAYER.menu} mb-1 flex w-max max-w-[min(20rem,calc(100vw-2rem))] flex-col gap-1.5 rounded-lg border border-edge bg-surface p-2 shadow-xl`}
              >
                {slots.overflow.map(control)}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function label(option: AgentConfigOption): ReactNode {
  const icon = CATEGORY_ICON[option.category ?? ""];
  return icon === undefined ? null : (
    <span className="text-faint">
      <Icon as={icon} size={11} />
    </span>
  );
}

/**
 * Everything inside a chip, drawn once for both of the things that are one.
 *
 * A live control and the slot of one the agent has stopped offering are the same
 * button in two states, and the rule they exist to keep is that **the strip does
 * not move**. Written twice they drifted immediately — the unavailable one drew
 * the control's name where the live one deliberately does not, so switching to a
 * model with no effort levels widened that chip by a word and pushed everything
 * beside it along. One function, so there is nothing to keep in step.
 *
 * The reserve spans are stacked in the same grid cell as the value and are
 * `aria-hidden`: the column is then as wide as the widest thing this chip can
 * ever say, in the real font, and the value changing inside it moves nothing.
 */
function chipInner(option: AgentConfigOption, parts: ChipParts): ReactNode {
  /*
   */
  return (
    <>
      {label(option)}
      {/*
       * **A caption is drawn at every width, and only a chip with no icon has
       * one.** The two questions collapsed into one when `mode` joined
       * `CAPTION_SILENT`: `showsCaption` is now false for every category
       * `CATEGORY_ICON` knows, so a caption reaching this line belongs to a chip
       * that has no glyph to hide behind — and hiding *that* below `sm` would
       * leave a bare value in the overflow popover with nothing saying what it
       * sets, at exactly the width where that matters most.
       *
       * ⚠ **There was a `hidden sm:inline` here and it is gone rather than
       * moved.** It existed because `mode` drew its caption and truncated its own
       * value on a 390px strip — the chip saying which control it was and not what
       * it was doing. Dropping the caption for `mode` outright answers that at
       * every width instead of only below one, which is the same objection Q3.401
       * made to the breakpoint it replaced, arriving a second time from the other
       * end. Q3.559.
       */}
      {parts.caption !== null && (
        <span className={`${CHIP_MAX} truncate text-faint`}>{parts.caption}</span>
      )}
      {/*
       * **The value hugs its own text, bounded above and not below.**
       *
       * ⚠ **There was a fixed reserve here and it is gone.** `chipReserve`
       * returned one list of strings per category — `Accept Edits`,
       * `GPT-5.6-Luna`, `Adaptive`/`Ultracode` — and this span rendered all of
       * them invisibly in one grid cell with the real value `sm:absolute` on top,
       * so every chip was as wide as the longest ordinary value its category could
       * ever show and *nothing moved* when a value changed. It was measured, it
       * worked, and it is withdrawn on the owner's word: a chip sized for
       * `Ultracode` while saying `Max` is mostly empty box, three times over, in
       * the row with the least width in the app.
       *
       * What it cost is written down rather than discovered — Q3.564. The
       * right-hand cluster is right-aligned, so a value that grows moves its
       * neighbours again, which is the defect Q3.402 and Q3.417 were written
       * about. `CHIP_MAX` is the only bound left: it stops a pathological name
       * from taking the row, and it truncates with the full text in the menu and
       * in the chip's `title`, which is what happened below `sm` all along.
       */}
      <span className={`${CHIP_MAX} truncate`}>{parts.value}</span>
    </>
  );
}

/**
 * One of the agent's select controls.
 *
 * Still hand-rolled rather than built on `bits.tsx`'s `Dropdown` — which was
 * extracted from this component — because this one needs the trigger to render
 * *inside* the pill (icon, then value, then chevron) and the generic version puts
 * its chevron at the end of a full-width row. The mechanics that matter are shared;
 * the shape is not.
 */
/*
 * ⭐ **There is no spinner on this strip, and that is the whole of "optimistic".**
 *
 * There was one, behind a 250ms delay, on the argument that an ordinary
 * `set_config_option` answers in tens of milliseconds while a change that restarts
 * the agent runs into seconds and should still report itself. Both halves were
 * true and the conclusion is withdrawn, because the thing it reported is now the
 * one thing this row is not: **the value somebody chose is already on the chip.**
 * `withChoice` puts it there before the request leaves, and the daemon no longer
 * publishes the fresh agent's own controls mid-restart — so from the outside a
 * restart looks like the change simply happening, which is what it is.
 *
 * What is *not* dropped is the correction: a refusal snaps the chip back to the
 * truth beside a toast, out of `applyConfigChange`'s `finally`. Optimism here is
 * bounded by a retraction, which is the same bar the transcript's own optimism
 * rules set — and it is not the optimism `Composer`'s Stop control refuses, since
 * nothing is being claimed about what the *agent* is doing.
 *
 * `locked` survives and is still not drawn: two changes at once really do race
 * (setting a model rebuilds the mode list), and the daemon refuses a config change
 * mid-restart on purpose — otherwise the restore overwrites it silently. So the
 * cost of no spinner is a second or two in which a tap on another chip does
 * nothing at all, and that is the trade being made deliberately.
 */

/**
 * A control the agent has stopped offering, still on the strip.
 *
 * The whole of the rule "a button never disappears": the slot is kept, the chip
 * says the control's name where its value would be self-describing, and the one
 * row in its menu says there is nothing to choose and why. It is deliberately
 * **not** disabled — a dimmed, inert chip answers "why is this greyed out?" with
 * silence on a phone, where there is no tooltip — so it opens, says its sentence,
 * and sends nothing.
 *
 * ⚠ **The name is *not* drawn here for `model` and `thought_level`, and this
 * docblock said the opposite for four releases.** It was written when the absent
 * chip drew the control's name where the live one deliberately does not — which
 * made the chip a word and a gap wider than the one it replaced and shoved the
 * whole right-hand cluster sideways every time a model dropped the effort levels.
 * Q3.417 took it out; `chipParts` is called with the same `showsCaption` rule the
 * live chip uses, and this comment simply never moved. What identifies the chip is
 * its icon, its position, and its `title`/`aria-label`, which do carry the name;
 * what opens is a menu headed with it.
 */
function Absent({ option }: { option: AgentConfigOption }): ReactNode {
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const hint = unavailableHint(option);

  // A layer like every other menu, for `Select`'s reason: an unregistered
  // popover leaves the ask card's digit shortcuts live underneath it.
  useDismissible("menu", () => setOpen(false), open);

  // The same pointer-down dismissal `Select` uses, for the same reason.
  useEffect(() => {
    if (!open) return;
    const close = (event: Event): void => {
      if (boxRef.current?.contains(event.target as Node) !== true) setOpen(false);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [open]);

  return (
    <div ref={boxRef} className="relative">
      <button
        // Explicit, and required rather than tidy: this row sits inside the
        // composer's box, and the day somebody makes that box the `<form>` a
        // typeless button becomes `type="submit"` and tapping a chip sends the
        // draft. `webcheck` asserts every button in this file carries one.
        type="button"
        onClick={() => setOpen(!open)}
        title={`${labelFor(option)}: ${hint}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`${labelFor(option)}: ${hint}`}
        className={`${CHIP} border-transparent px-2 text-muted hover:bg-raised active:bg-raised`}
      >
        {/* The same contents the live chip draws, from the same function — which
            is what makes "this chip does not change width when the agent stops
            offering it" a property rather than a promise. */}
        {chipInner(option, chipParts(option, false))}
        <Icon as={ChevronDown} size={12} className="text-faint" />
      </button>

      {open && (
        <div
          className={`absolute bottom-full ${
            slotFor(option) === "left" ? "left-0" : "right-0"
          } mb-1 w-60 max-w-[calc(100vw-1.5rem)] ${MENU_PANEL}`}
        >
          {/* The category glyph, which is the one the chip that opened this panel
              draws — `label` is the same lookup, so a heading and its chip cannot
              come to disagree about what a control looks like. It answers `null`
              for a category `CATEGORY_ICON` has never heard of, which is exactly
              the case where the heading is the only thing naming the control. */}
          <p className={`${MENU_HEADING} flex items-center gap-1.5`}>
            {label(option)}
            {labelFor(option)}
          </p>
          <p className="px-2.5 pt-1 pb-2 text-xs text-muted">{hint}</p>
        </div>
      )}
    </div>
  );
}

function Select({
  option,
  nested = [],
  narrow = [],
  proseOf,
  disabled,
  locked,
  refuses,
  onChange,
}: {
  option: AgentConfigOption;
  /**
   * Controls drawn as further sections of *this* control's menu.
   *
   * Only the host's value reaches the chip; the strip's shape is therefore the
   * same whether an agent publishes these or not, which is the entire point — see
   * `NESTED_HOST` in `agentConfig.ts`.
   */
  nested?: readonly AgentConfigOption[];
  /**
   * Sections this control's picker draws **only below `sm`**, where a chip of
   * their own has left the row.
   *
   * Distinct from {@link nested}, which is a control that has no chip at any
   * width — codex's `collaboration_mode`, which `splitOptions` assigns to the
   * `nested` slot outright. These still own a chip; it is `hidden sm:contents`,
   * and this is where their choices go instead. They are therefore **not** a slot
   * and do not enter the partition: the option is in `right` at every width, and
   * what changes is which of two renderings the browser is drawing.
   *
   * No breakpoint class is needed on them, because only the sheet draws them and
   * the sheet is `sm:hidden`.
   */
  narrow?: readonly AgentConfigOption[];
  /** Descriptions recovered from the transcript, since the snapshot strips them. */
  proseOf: (option: AgentConfigOption) => ConfigProse | undefined;
  /** No agent to ask. Inert **and** dimmed, because it is a state of the world. */
  disabled: boolean;
  /** Another control in this row is in flight. Inert and **not** dimmed. */
  locked: boolean;
  /** What a choice says instead of acting, per row — see `choiceRefusal`. */
  refuses: (option: AgentConfigOption, value: string | boolean) => string | null;
  onChange: (option: AgentConfigOption, value: string) => void;
}): ReactNode {
  const prose = proseOf(option);
  /*
   * Which edge the menu hangs from.
   *
   * A fixed `left-0` put a 15rem panel off the right of the screen for every
   * control in the right cluster — model, effort — which on a phone gave the whole
   * page a horizontal scrollbar and let you swipe the interface sideways. The chip
   * already knows which side it is on, so the menu follows its slot: left chips
   * open leftward, right chips open rightward, and neither can leave the viewport.
   *
   * Read from `slotFor`, so this cannot drift from the layout it is aligning to.
   */
  const align = slotFor(option) === "left" ? "left-0" : "right-0";
  const [open, setOpen] = useState(false);
  /**
   * Dismissed, and still on screen for {@link SHEET_EXIT_MS} while it leaves.
   *
   * Two states rather than one because the two presentations want opposite
   * things: the anchored panel is a popover and has to go **now**, and the sheet
   * has to stay for its own animation. So `open && !leaving` draws the panel and
   * `open` alone draws the sheet.
   */
  const [leaving, setLeaving] = useState(false);
  /**
   * Whether the sheet is on its second detent, and it exists only below `sm`.
   *
   * A phone picker opens at `.config-sheet`'s own resting cap — enough for a
   * control's own rows without covering the message you are choosing for — and a
   * model list is longer than that on every agent that publishes one. So there is
   * somewhere to go: the list does **not** scroll at rest, and the gesture that
   * would have scrolled it takes the sheet to {@link SHEET_FULL} first, where it
   * does. Two detents rather than one scroller, which is what the phone clients
   * this is modelled on do; the alternative — a taller sheet that always scrolls —
   * is the shape that put the grab bar out of reach on the second screenful.
   *
   * ⚠ **It is the only React state this gesture touches, and it is not the
   * geometry.** The panel's height is `paint`'s, off the render path entirely.
   * This exists because the *list* inside it is drawn differently at each detent —
   * clipped at rest, scrolling when full — and that is a class rather than a
   * length.
   */
  const [expanded, setExpanded] = useState(false);
  /**
   * The panel's height at rest, measured once when it opens.
   *
   * There is no way to get this out of CSS: the resting height is `min(content,
   * 60dvh)` and only the browser knows the first term. It is the pivot for the
   * whole gesture — where shortening turns into sliding, and what a release is
   * compared against — so it is read once, from the layout that has just happened,
   * rather than per frame.
   */
  const restH = useRef<number | null>(null);
  /**
   * What the last `pointermove` decided, mirrored out of React.
   *
   * `pointerup` needs the finger's final position and reading it from state is a
   * bet on React having flushed the render for the move that preceded it by a few
   * milliseconds. This is the same value, owed to nobody.
   */
  const live = useRef({ height: 0, below: 0 });
  const settle = useRef<number | null>(null);
  /** A pending `requestAnimationFrame` that puts the sheet's transition back. */
  const restore = useRef<number | null>(null);
  /**
   * The sheet's geometry, written straight onto the node.
   *
   * ⚠ **This is `AppShell`'s `--rail-w` rule one control further in, and it is a
   * performance decision rather than a stylistic one.** A pointer moves sixty
   * times a second; routing that through `useState` is sixty renders, and a render
   * here is every row of the open picker — 362 of them on opencode, each a
   * `<button>`. The panel would arrive where the finger had been. So React sets no
   * `style` on the panel at all and the gesture sets these instead, over
   * `.config-sheet`'s defaults, which **are** the resting sheet.
   *
   * `null` removes a property rather than writing a zero, so "at rest" is the
   * absence of every one of them and cannot drift from what the CSS says rest is.
   */
  const paint = (vars: Record<string, string | null>): void => {
    const panel = sheetRef.current;
    if (panel === null) return;
    for (const [name, value] of Object.entries(vars)) {
      if (value === null) panel.style.removeProperty(name);
      else panel.style.setProperty(name, value);
    }
  };
  /** Every property this sheet writes, back to `.config-sheet`'s own defaults. */
  const atRest = (): void =>
    paint({
      "--sheet-h": null,
      "--sheet-y": null,
      "--sheet-min": null,
      "--sheet-max": null,
    });
  /**
   * Whether the panel animates its own geometry, or takes it in one frame.
   *
   * ⚠ **An inline `transition` longhand, not a custom property inside
   * `.config-sheet`'s shorthand.** That was the first shape and it is out: a
   * `var()` in a shorthand makes every longhand a pending-substitution value, which
   * is a thin place in more than one engine and harder to reason about than a
   * literal. Inline, this cannot lose to anything, and React never writes `style`
   * on this element so there is nobody to lose to anyway.
   */
  const settling = (on: boolean): void => {
    /*
     * ⚠ **Any pending restore is cancelled first.** `paintNow` puts the animation
     * back a frame later, and a gesture starting inside that frame would have its
     * transition switched back on underneath it — a drag that chases the finger
     * instead of following it, intermittently and only just after a previous one.
     */
    if (restore.current !== null) {
      window.cancelAnimationFrame(restore.current);
      restore.current = null;
    }
    const panel = sheetRef.current;
    if (panel === null) return;
    panel.style.transition = on ? "" : "none";
  };
  /**
   * A write that must land in one frame, with the animation put back afterwards.
   *
   * ⚠ **This is the fix for a bounce at the *end* of every gesture**, and it was
   * the whole of what "the menu goes back to where it started and then winds round
   * again" turned out to be. When the settle timer hands the height back to
   * `.config-sheet`'s defaults it is changing `min-height` and `max-height` —
   * animated properties — from the gesture's free bounds to the detent's. Settling
   * to rest with a long list, `--sheet-max` went from 92dvh to the 60dvh default
   * *over 300ms* while `--sheet-h` was cleared to `auto` in the same frame, so the
   * panel sprang to full height and then shrank back. Opening a short picker was
   * the same defect mirrored: `--sheet-min` climbing 0 → 92dvh while the height
   * fell to its content. Neither is a movement anybody asked for — the panel is
   * already exactly where it belongs by then, and this write only says so.
   */
  const paintNow = (vars: Record<string, string | null>): void => {
    settling(false);
    paint(vars);
    // A frame later, or the very write above would be what the transition animates.
    restore.current = window.requestAnimationFrame(() => {
      restore.current = null;
      settling(true);
    });
  };
  const exit = useRef<number | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);
  /** The sheet's panel. Outside `boxRef`, being portalled — see the effect below. */
  const sheetRef = useRef<HTMLDivElement | null>(null);
  /** The sheet's scroller, which owns vertical movement once it has one. */
  const listRef = useRef<HTMLDivElement | null>(null);
  /**
   * Where a drag on the sheet started, and how tall the panel was then.
   *
   * A ref rather than state: it changes on every `pointermove` and renders
   * nothing. `height` is measured at `pointerdown` rather than tracked, so the
   * gesture is one subtraction per frame — `from.height - travelled` is where the
   * panel's top edge wants to be, and everything else follows from clamping that.
   *
   * ⚠ **Reading a height here is not the measurement `AppShell`'s rule bans.**
   * That rule is about *which layout* to draw, and this decides nothing of the
   * kind — the picker's two presentations are still chosen by `display` and a
   * resized window still cannot produce one that is not there. What is read here
   * is where a finger is against where a panel is, which no class can answer.
   */
  const drag = useRef<{ id: number; y: number; height: number } | null>(null);
  /**
   * Whether the gesture in flight has already moved a detent.
   *
   * ⚠ **Without this, dragging the sheet down to close it also chooses whatever
   * row the finger started on.** A touch that ends without the browser having
   * scrolled anything still produces a `click`, and every row under the finger is
   * a button — so the sheet would shut *and* switch the model. The panel's own
   * capture-phase handler swallows that one click, which is one guard for every
   * row rather than a check inside each.
   */
  const dragged = useRef(false);

  /*
   * Every way out of this picker, in one place.
   *
   * There were four call sites setting `open` to false — Escape, the outside
   * press, the scrim, and choosing a row — and each one would have had to
   * remember the timer. Re-entrant on purpose: a second dismissal while one is
   * already running must not restart the clock, or a panel can be held on screen
   * by tapping the scrim.
   */
  const dismiss = (): void => {
    if (exit.current !== null) return;
    setLeaving(true);
    exit.current = window.setTimeout(() => {
      exit.current = null;
      setLeaving(false);
      setOpen(false);
    }, SHEET_EXIT_MS);
  };

  /*
   * Opening cancels a exit that has not finished, which is what stops a fast
   * tap-tap leaving the picker open with `leaving` still true — a sheet drawn in
   * its final frame, off the bottom of the screen, that nothing will bring back.
   */
  const show = (): void => {
    if (exit.current !== null) {
      window.clearTimeout(exit.current);
      exit.current = null;
    }
    setLeaving(false);
    // At rest, always: a picker that reopened full-height because it was left that
    // way last time would cover the message somebody is choosing a model for. And
    // nothing inline survives an open, or the next control this component draws
    // inherits the pixel height of the last one somebody dragged.
    if (settle.current !== null) {
      window.clearTimeout(settle.current);
      settle.current = null;
    }
    drag.current = null;
    restH.current = null;
    live.current = { height: 0, below: 0 };
    settling(true);
    atRest();
    setExpanded(false);
    setOpen(true);
  };

  /*
   * The resting height, read from the layout that has just happened.
   *
   * `useLayoutEffect` and not `useEffect`: this has to be true before the first
   * frame anybody could start a gesture on. Guarded on a real height because above
   * `sm` the whole portal is `display: none` and measures zero — a window resized
   * across the breakpoint with the picker open would otherwise leave the pivot at
   * nothing, and every drag would read as a dismissal.
   */
  useLayoutEffect(() => {
    if (!open || sheetRef.current === null) return;
    const height = sheetRef.current.getBoundingClientRect().height;
    if (height > 0) restH.current = height;
  }, [open]);

  /*
   * The sheet's gesture: the panel follows the finger, and lets go onto a detent.
   *
   * `pointerdown` sits on the panel and `pointermove`/`pointerup` on the **scrim**,
   * which is the whole viewport — so a finger that leaves the panel on its way up
   * keeps moving it. The panel captures the pointer once the drag engages, which is
   * what delivers the release even when the finger is lifted outside the window;
   * see `dragMove` for why that is taken there and not at `pointerdown`.
   *
   * Pointer events rather than touch events because they are the same three
   * handlers for a mouse, which is how this is reachable at all in a desktop
   * browser's device emulation — the only place most of this is ever exercised.
   *
   * ⚠ **It followed the finger in neither direction for one round.** A drag past
   * {@link SHEET_DRAG_STEP} simply switched detent and the panel animated there on
   * its own, which is a *button* worked by swiping: the sheet ignored the hand on
   * it and then moved by itself, and the distance it moved had nothing to do with
   * the distance dragged. Reported as *"the menu does not follow the finger — it
   * just changes state"*. The threshold survives, now as the slop that separates a
   * drag from a tap on a row rather than as the whole decision.
   */
  const fullHeight = (): number => window.innerHeight * SHEET_FULL_SHARE;
  /* Half the screen if the panel has never been measured, which cannot normally
     happen: the layout effect above runs before any gesture can start. */
  const restHeight = (): number => restH.current ?? window.innerHeight / 2;

  const dragStart = (event: ReactPointerEvent<HTMLElement>): void => {
    dragged.current = false;
    /*
     * Once the list is a scroller it owns vertical movement inside itself, and
     * taking it over here is how a sheet ends up unable to scroll at all. The grab
     * bar above it never owns any, and neither does the list at rest, where it is
     * `overflow-hidden` and there is nothing to scroll.
     */
    if (expanded && listRef.current?.contains(event.target as Node) === true) return;
    const panel = sheetRef.current;
    if (panel === null) return;
    // Catching a sheet that is still settling starts the new drag from where it
    // actually is, rather than from the detent it was on its way to.
    if (settle.current !== null) {
      window.clearTimeout(settle.current);
      settle.current = null;
    }
    drag.current = { id: event.pointerId, y: event.clientY, height: panel.getBoundingClientRect().height };
  };

  const dragMove = (event: ReactPointerEvent<HTMLElement>): void => {
    const from = drag.current;
    if (from === null || from.id !== event.pointerId) return;
    const travelled = event.clientY - from.y;
    // The slop, and only once: past it the panel is following the finger and a
    // move back inside it must not hand the gesture back to the row underneath.
    if (!dragged.current && Math.abs(travelled) < SHEET_DRAG_STEP) return;
    if (!dragged.current) {
      dragged.current = true;
      /*
       * ⚠ **Capture on the *panel*, taken here rather than at `pointerdown`.** A
       * captured pointer delivers its release even when the finger is lifted
       * outside the window, which is what ends this gesture — `AppShell`'s rail
       * argues the same for its own handle. Taking it at `pointerdown` would
       * retarget the compatibility `click` for every *tap* as well, and the rows
       * under the finger need theirs to arrive where they were aimed. Taken here
       * it only ever retargets a click a drag produced, which is the one this
       * panel's capture handler already swallows.
       */
      sheetRef.current?.setPointerCapture(event.pointerId);
    }
    /*
     * Where the panel's top edge wants to be, as a height. Above the resting
     * height that *is* the height, bounded by the full detent; below it the height
     * stops and the panel slides instead, so the edge keeps tracking the finger
     * either way and the hand-off has no discontinuity in it.
     */
    const rest = restHeight();
    const wanted = from.height - travelled;
    const next =
      wanted >= rest
        ? { height: Math.min(wanted, fullHeight()), below: 0 }
        : { height: rest, below: rest - wanted };
    live.current = next;
    // No animation while a finger is down, or every frame starts a 300ms journey
    // toward where the finger already was and the panel trails it by most of a
    // second. The bounds go free in the same write: either would clamp the height
    // back to a detent mid-gesture.
    settling(false);
    paint({
      "--sheet-min": "0px",
      "--sheet-max": SHEET_FULL,
      "--sheet-h": `${next.height}px`,
      "--sheet-y": `${next.below}px`,
    });
  };

  const dragEnd = (pointerId: number): void => {
    const from = drag.current;
    if (from === null || from.id !== pointerId) return;
    drag.current = null;
    if (!dragged.current) return;
    /*
     * Pulled far enough below its resting height to be leaving, so let it leave —
     * and **keep the offset**, because the exit keyframe has no `from` of its own
     * and takes the element's current transform as one. Clearing it here would
     * snap the panel back up by however far it had been pulled and then slide it
     * down from there.
     */
    if (live.current.below > SHEET_DISMISS_PX) {
      dismiss();
      return;
    }
    // Otherwise the nearer of the two, which is the ordinary meaning of a detent.
    const rest = restHeight();
    const full = fullHeight();
    const toFull = live.current.height > (rest + full) / 2;
    // The settle itself: the transition comes back and the height is animated to
    // the detent from wherever the hand let go, rather than jumping to it.
    settling(true);
    paint({ "--sheet-y": "0px", "--sheet-h": `${toFull ? full : rest}px` });
    // The one render this gesture costs, and it is for the list rather than the
    // panel: a full sheet scrolls its rows and a resting one clips them.
    setExpanded(toFull);
    /*
     * And then the defaults take it back. The pixel height is what the settle
     * animates, so it has to outlive the animation — but not by longer, or a sheet
     * that has stopped moving is still pinned to a number that no longer matches
     * its content, and the next thing this control opens inherits it.
     */
    settle.current = window.setTimeout(() => {
      settle.current = null;
      if (toFull) paintNow({ "--sheet-h": null, "--sheet-y": null, "--sheet-min": SHEET_FULL, "--sheet-max": SHEET_FULL });
      else paintNow({ "--sheet-h": null, "--sheet-y": null, "--sheet-min": null, "--sheet-max": null });
    }, SHEET_SETTLE_MS);
  };

  /*
   * The grab bar's tap, which is the same two detents reached without a gesture.
   *
   * It writes the properties rather than toggling a class for the reason `paint`
   * gives: one mechanism owns this element's geometry, or an inline property and a
   * utility settle by emission order and the sheet's height becomes a race.
   */
  const toggleDetent = (): void => {
    if (settle.current !== null) {
      window.clearTimeout(settle.current);
      settle.current = null;
    }
    // `--sheet-h` and `--sheet-y` go with it either way: a tap during a settle
    // would otherwise leave the pixel height a drag was animating behind, dominated
    // by the new bound and waiting to be inherited.
    settling(true);
    if (expanded) atRest();
    else paint({ "--sheet-h": null, "--sheet-y": null, "--sheet-min": SHEET_FULL, "--sheet-max": SHEET_FULL });
    setExpanded(!expanded);
  };

  // A timer outliving the component would call `setState` on an unmounted one —
  // and this component unmounts on every session switch.
  useEffect(
    () => () => {
      if (exit.current !== null) window.clearTimeout(exit.current);
      if (settle.current !== null) window.clearTimeout(settle.current);
      if (restore.current !== null) window.cancelAnimationFrame(restore.current);
    },
    [],
  );

  const current = drawnChoices(option).find((choice) => choice.value === option.value);
  const currentProse =
    prose?.choices.get(String(option.value)) ?? current?.description ?? null;
  /*
   * ⚠ **What the tooltip says when the agent explains nothing**, which used to be
   * the control's own name and is now the value's.
   *
   * `CATEGORY_RESERVE`'s docblock promises that a value too long for the chip
   * "truncates, with the full text one tap away in the menu **and in the chip's
   * own `title`**". That was true while a truncated value was rare. opencode
   * publishes `description: null` on all 362 of its models, so the fallback chain
   * ran to `labelFor(option)` and the tooltip over a chip reading `Claude Opus 4…`
   * said, in full, "Model" — the promise inverted exactly where it was needed.
   *
   * The control's name is not lost: it is on `aria-label` unconditionally, one
   * line below, for the reason written there.
   */
  const currentName = current === undefined ? null : choiceLabel(option, current);

  /*
   * What the chip says its value is.
   *
   * Measured 2026-07-31 against claude 0.63.0, the three controls publish:
   *
   *   mode    value "default"   → name "Manual"
   *   model   value "default"   → name "Default (recommended)", description
   *                                "Opus 5 with 1M context · Best for everyday…"
   *   effort  value "default"   → name "Default", description null
   *
   * Two chips reading a bare "Default" answered nothing, and the two are not the
   * same problem — `chipValue` and `adaptiveLabel` in `agentConfig.ts` are where
   * each is worked out, and both are resolved rather than papered over. The model
   * is named by the head of its own description, so the chip reads `Opus 5`.
   * Effort has no description anywhere in the payload, so what `default` means was
   * read out of the CLI — it sends no effort parameter at all, and the documented
   * behaviour with none sent is adaptive thinking — so the chip reads `Adaptive`.
   *
   * Deleting either placeholder choice is not the fix and was never on the table:
   * the effort one is the only way back to the agent's own default. (The *model*
   * placeholder does get dropped, but on the daemon and for a different reason —
   * `dedupeAliasChoices` removes it because it duplicates a concrete choice's
   * description, which is the agent saying they are the same thing.)
   *
   * The option's own name is still shown beside the value, because a value is only
   * self-describing when it happens to be a proper noun — see the span below for
   * which widths that holds at.
   */
  const parts = chipParts(option, true, prose);

  /*
   * Escape belongs to `overlay.ts`, and this is a `menu` like any other.
   *
   * Not merely a missing dismissal: `decisionShortcutsEnabled` blocks the ask
   * card's numbered answers on every layer but the card's own, so a menu that
   * pushes none leaves them live — and this menu opens directly over a parked
   * question, where `2` aimed at the model list resolved the permission
   * underneath it.
   */
  useDismissible("menu", dismiss, open);

  /*
   * A pointer-down listener rather than blur: the menu contains buttons, and
   * closing on blur would fire before the click that chose one landed.
   *
   * ⚠ **Two boxes, because the sheet is portalled to `document.body` and is
   * therefore *outside* `boxRef` by construction.** With only the anchored panel's
   * box tested, every tap inside the sheet — including one on a row — was an
   * outside press: it closed the picker on `pointerdown`, the sheet unmounted, and
   * the `click` that would have chosen the value landed on nothing. So the control
   * did nothing at all on a phone, silently, which is the exact failure this
   * listener was written the way it is to avoid.
   *
   * The scrim is deliberately **not** inside `sheetRef`: a press on it has to
   * close, and `ref` on the panel rather than on the positioner is what makes that
   * fall out here instead of needing a second rule.
   */
  useEffect(() => {
    if (!open) return;
    const close = (event: Event): void => {
      const target = event.target as Node;
      const inside =
        boxRef.current?.contains(target) === true || sheetRef.current?.contains(target) === true;
      if (!inside) dismiss();
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [open]);

  /*
   * The rows, drawn once for whichever presentation the browser is showing.
   *
   * A function rather than a node, because the two lists are not the same list:
   * the sheet carries `narrow` on the end and the panel does not. Written out
   * twice they would be two markups for one menu, which is the defect
   * `ChoiceSection` was extracted to end — the chip and the menu row disagreeing
   * about what a value is called.
   *
   * `where` reaches `ChoiceSection` and namespaces the one id it generates —
   * `sharedId`, on the refusal line. Both presentations are in the document at
   * once, so without it the same refusal would carry the same id twice and the
   * option rows' `aria-describedby` would resolve to whichever copy the browser
   * found first, which on a phone is the one that is `display: none`. The option
   * rows themselves carry no `id` and there is no `aria-activedescendant` here:
   * neither presentation implements arrow-key navigation, so there is nothing
   * for an active descendant to point at.
   */
  const sections = (list: readonly AgentConfigOption[], where: string): ReactNode =>
    list.map((section, index) => (
      <ChoiceSection
        key={section.id}
        where={where}
        option={section}
        prose={proseOf(section)}
        // A rule above every section but the first, so a nested control reads as
        // its own menu rather than as more rows of the host's.
        divided={index > 0}
        refuses={refuses}
        onChoose={(value) => {
          dismiss();
          if (value !== section.value) onChange(section, value);
        }}
      />
    ));

  return (
    <div ref={boxRef} className="relative">
      <button
        // See `Absent`'s note: explicit because this row is inside the composer's
        // box, and a typeless button one refactor away from being in its `<form>`
        // sends the draft when it is tapped.
        type="button"
        onClick={() => (open ? dismiss() : show())}
        // Inert for both, dimmed for one: the fade keys on `disabled` rather than
        // on the attribute, which is what keeps a lock from reading as damage.
        disabled={disabled || locked}
        // The description in the tooltip, so "Default" answers "default what?" on
        // hover as well as in the open menu.
        title={
          currentProse === null
            ? (currentName ?? prose?.description ?? option.description ?? labelFor(option))
            : `${labelFor(option)}: ${currentProse}`
        }
        aria-haspopup="listbox"
        aria-expanded={open}
        // Unconditional, because for `model` and `effort` the name is no longer
        // anywhere in the accessible tree: the caption is not rendered and the
        // reserve spans are `aria-hidden`. A screen reader would otherwise
        // announce "Opus 5, menu" with nothing saying what Opus 5 *is* here.
        aria-label={labelFor(option)}
        /*
         * ⚠ **Dimmed by token, never by `opacity`, and that is a correction rather
         * than a consequence of losing the border.**
         *
         * `opacity-40` over `surface` composites to 2.51:1 for `fg`, 1.94:1 for
         * `muted`, 1.83:1 for `faint` — and **1.65:1 for `edge-strong`**. So the
         * bordered chip was never the safe baseline it looked like: the fade
         * already deleted the boundary it exists to hold, four fifths under the 3:1
         * that motivates the token at all. `text-faint` puts the whole chip at
         * 6.23:1, over the 4.5:1 floor for 12px and eleven points below the live
         * chip's 17.37:1, so it still flattens unmistakably.
         *
         * It also fades rather than snapping: `.tap` transitions `color` and
         * deliberately does not transition `opacity`. And it restores the
         * distinction this component's own props promise — `disabled` dims,
         * `locked` is inert and does not — which a fade that total had made
         * invisible. This is the composer's resting appearance on every restart
         * and every auto-resume, which is what makes it worth the paragraph.
         *
         * ⚠ **The live arm is `text-muted` (7.75:1) rather than `text-fg`, so the
         * step down to `text-faint` is one and a half points and not eleven.** The
         * chips are the quiet half of this box by request — the one dark thing
         * below the field should be Send — and what carries the refusal instead is
         * *flatness*: a live chip is two-tone, a `text-muted` value between
         * `text-faint` glyphs, and a refused one is uniformly faint with no hover
         * and no press fill anywhere on it. `stale` moves every chip in the row at
         * once, so it reads as the row being away rather than as one dead control.
         */
        className={`${CHIP} border-transparent px-2 ${
          disabled ? "text-faint" : "text-muted hover:bg-raised active:bg-raised hover:text-fg"
        }`}
      >
        {/*
         * Contents from `chipParts`, drawn by `chipInner` — the same two calls the
         * unavailable slot makes. What each of them decides is documented there;
         * what matters here is that neither is decided *here*, because a chip
         * written out twice is a chip that changes width the day the two copies
         * disagree.
         */}
        {chipInner(option, parts)}
        <Icon as={ChevronDown} size={12} className="text-faint" />
      </button>

      {open && !leaving && (
        <div
          role="listbox"
          // `max-w` as well as the alignment: on a narrow phone even a
          // correctly-anchored 15rem panel is wider than the screen. Width and
          // placement stay here; the chrome comes from `bits.tsx`, which is the
          // third of the three consumers its comment names.
          className={`absolute bottom-full ${align} mb-1 hidden w-60 max-w-[calc(100vw-1.5rem)] sm:block ${MENU_PANEL}`}
        >
          {sections([option, ...nested], "panel")}
        </div>
      )}
      {/*
       * **The same choices as a bottom sheet, below `sm`, and it is the same
       * `open` state deciding both.**
       *
       * Which one a reader gets is a **class** and never a measurement in
       * JavaScript, which is `AppShell`'s standing rule for this app: a resized
       * window cannot render a picker that is not there, because both are
       * rendered and `display` chooses. The cost is that the rows are in the
       * document twice while this control is open — see `sharedId` and the
       * `where` it is namespaced by, which is what keeps the two copies'
       * `aria-describedby` from resolving into each other.
       *
       * ⚠ **It is not `Sheet`, and could not be.** That component sets `inert`
       * on `#root`, takes focus and registers itself the moment it mounts — side
       * effects a `display` class cannot gate — so a `Sheet` rendered here would
       * lock the whole app behind an *invisible* panel every time somebody opened
       * a popover on a desktop. It is also route-backed, and its panel is
       * `sm:h-[min(44rem,88dvh)] sm:max-w-2xl`: a 704px card for a four-row list.
       * What is borrowed is the shape and the scrim; what is not is the machinery
       * that assumes a sheet is the only thing on screen.
       *
       * So there is no `inert` and Back does not close it. Escape does — through
       * the same `useDismissible("menu")` registration the anchored panel uses,
       * once for both — and so does the scrim, and so does choosing a row. That is
       * exactly the posture the popover it replaces already had.
       */}
      {open &&
        createPortal(
          <div
            data-config-scrim=""
            className={`${
              leaving ? "animate-scrim-out" : "animate-scrim"
            } fixed inset-0 ${LAYER.overlay} flex touch-manipulation flex-col justify-end bg-fg/25 sm:hidden`}
            onClick={(event) => {
              if (event.target === event.currentTarget) dismiss();
            }}
            // The move on the scrim rather than on the panel, so a finger that has
            // travelled off the top of the sheet keeps moving it. The release is
            // here *and* on `window`, which is the case the scrim cannot cover —
            // see the effect above.
            onPointerMove={dragMove}
            onPointerUp={(event) => dragEnd(event.pointerId)}
            onPointerCancel={(event) => dragEnd(event.pointerId)}
          >
            <div
              ref={sheetRef}
              onPointerDown={dragStart}
              /*
               * The one click a drag leaves behind, eaten before any row sees it.
               *
               * Capture phase and on the panel: a touch that ends without the
               * browser having scrolled still fires a `click` on whatever was
               * under it, and at rest that is a model row. Swallowing it here is
               * one guard for every row in both sections rather than a flag each
               * of them has to remember to read.
               */
              onClickCapture={(event) => {
                if (!dragged.current) return;
                dragged.current = false;
                event.preventDefault();
                event.stopPropagation();
              }}
              /*
               * ⚠ **No `style` prop, ever.** `.config-sheet` holds this panel's
               * whole geometry as five custom properties with defaults that *are*
               * the resting sheet, and `paint` writes over them. React setting a
               * style here would put two writers on one set of properties, which is
               * the equal-specificity race `FIELD` warns about in `bits.tsx` and
               * the same reason `AppShell` keeps an inline width off its `<aside>`.
               */
              className={`config-sheet pb-safe ${
                leaving ? "animate-sheet-out" : "animate-sheet"
              } flex w-full flex-col overflow-hidden overscroll-contain rounded-t-2xl border-t border-edge bg-surface shadow-2xl`}
            >
              {/*
               * The grab bar, which is the whole of this sheet's head, and it is a
               * **control** rather than a decoration now.
               *
               * A title row would say "Mode" directly above a `ChoiceSection`
               * heading that already says it — and on the mode control the sheet
               * carries three sections, so there is no one name for it to hold. So
               * the head has one job left, which is the detent: tap it to expand or
               * collapse, or drag it, or drag anywhere on the list at rest. It was
               * an `aria-hidden` bar inside the scroller and had neither — it slid
               * away with the first screenful, and the shape it advertised did
               * nothing.
               *
               * ⚠ **32px of head with a 44px target**, which is the chips' own
               * arrangement and `TAP_GROW_Y`'s measured one: 4px up and 8px down
               * from a 32px box. It was a flat `min-h-11`, and 44px of head put
               * twenty pixels of nothing between the sheet's top edge and a 4px
               * bar — reported as too much room above the grabber. The growth
               * reaches down over the first section's *heading*, which is text and
               * not a control, so nothing pressable is under it. `shrink-0` is what
               * pins it: it is a flex sibling of the scroller rather than its first
               * child, which is the whole of why it stays.
               *
               * `touch-none` so the browser hands the gesture over instead of
               * looking for something to pan, and `aria-expanded` because the two
               * detents are the only thing this button has to say — including, on a
               * short list that never needed a second one, that nothing happened.
               */}
              <button
                type="button"
                onClick={toggleDetent}
                aria-label={expanded ? "Collapse the menu" : "Expand the menu"}
                aria-expanded={expanded}
                className={`tap relative flex min-h-8 shrink-0 touch-none items-center justify-center ${TAP_GROW_Y}`}
              >
                <span aria-hidden className="h-1 w-9 rounded-full bg-edge-strong" />
              </button>
              {/*
               * The rows, and **at rest they do not scroll** — the gesture that
               * would have scrolled them expands the sheet instead, which is what
               * `dragStart` leaves alone once there is a scroller here.
               *
               * `overscroll-contain` on both this and the panel: the inner one
               * stops a flick at the end of the model list from scrolling the
               * conversation behind the scrim, and the outer one covers the rest
               * for as long as this element is `overflow-hidden` and has no scroll
               * chain of its own to end.
               */}
              <div
                ref={listRef}
                className={`min-h-0 overscroll-contain px-1.5 pb-1.5 ${
                  expanded ? "flex-1 overflow-y-auto" : "touch-none overflow-hidden"
                }`}
              >
                {sections([option, ...nested, ...narrow], "sheet")}
              </div>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}

/**
 * One control's heading, its prose, and its rows — the body of a menu panel.
 *
 * Extracted when `collaboration_mode` began sharing the mode control's menu, so
 * that a nested control is drawn by the same code as its host rather than by a
 * copy of it. The alternative was duplicating the row markup, which is how the
 * chip and the menu row came to disagree about what a value is called — the defect
 * `rowLabel`'s docblock records.
 */
function ChoiceSection({
  option,
  where,
  prose,
  divided,
  refuses,
  onChoose,
}: {
  option: AgentConfigOption;
  /**
   * Which of the two presentations this section is inside — `panel` or `sheet`.
   *
   * It exists for one reason: an id has to be unique in the *document*, and
   * `Select` renders both presentations at once so `display` can choose between
   * them. Without it the same control's refusal line carries the same id twice,
   * and every `aria-describedby` pointing at it resolves to whichever copy the
   * browser reaches first — which on a phone is the hidden one.
   */
  where: string;
  prose: ConfigProse | undefined;
  divided: boolean;
  /**
   * Required rather than optional: a section drawn without it is a row that
   * dispatches into a refusal whose toast is now suppressed, i.e. a control that
   * does nothing and says nothing.
   */
  refuses: (option: AgentConfigOption, value: string | boolean) => string | null;
  onChoose: (value: string) => void;
}): ReactNode {
  /*
   * ⚠ **Read once, and everything below reads it** — the refusals, the heading
   * test and the rows. `drawnChoices` takes a provider prefix every row repeats
   * out of the names, so opencode's one 362-row control does not spend its width
   * printing `OpenRouter` 356 times; taking the refusals off `option.choices` and
   * the rows off this would index one list with the other's positions.
   *
   * The heading test below is still here and reads `choice.group` alone: that is
   * the **agent's** grouping, off the ACP config, and this client no longer
   * derives one of its own.
   */
  const choices = drawnChoices(option);
  const refusals = choices.map((choice) => refuses(option, choice.value));
  /*
   * **One sentence for the control when it is true of more than one row.**
   *
   * Leaving ultracode restarts too, so with it on, every ordinary level is
   * refused at once and the row copy would be printed six times in one panel.
   * Said once above them instead — and *beside* the control's own description
   * rather than in place of it, because claude's "Available effort levels for
   * this model" is the only prose this control has and it is not ours to spend.
   *
   * `every` and not `[0]`: hoisting the first of several different sentences
   * would let the panel speak for a row it is not about.
   */
  const refused = refusals.filter((text): text is string => text !== null);
  const shared =
    refused.length > 1 && refused.every((text) => text === refused[0]) ? (refused[0] ?? null) : null;
  const sharedId = `${where}-${option.id}-refusal`;
  return (
    <div className={divided ? "mt-1 border-t border-edge pt-1" : undefined}>
      {/*
       * The category glyph beside the section's name, and it is the **chip's** —
       * `label` is the lookup the strip under the message box uses, so what opens
       * a menu and what heads it cannot come to disagree about what a control
       * looks like.
       *
       * It earns more here than on a chip. A sheet stacks a control's sections one
       * under the other — mode, then collaboration, then, on a phone, the model
       * that folded in behind it — and `MENU_HEADING` is 10px uppercase at
       * `text-faint`, which is the quietest type in the app. The glyph is what
       * makes the boundary between two sections findable at a glance instead of
       * read. `null` for a category `CATEGORY_ICON` has never heard of, where the
       * name is then the only thing naming the control and is drawn alone.
       */}
      <p className={`${MENU_HEADING} flex items-center gap-1.5`}>
        {label(option)}
        {labelFor(option)}
      </p>
      {/*
       * The control's own description, when the agent gives one.
       *
       * This is where a control that cannot explain its *values* can at least
       * explain itself: claude's effort choices carry no descriptions at all —
       * `Default`, `Low`, `High` and nothing else — while the option itself is
       * described as "Available effort levels for this model". Showing that is
       * the difference between a menu of bare words and a menu that says what
       * it is for.
       */}
      {(prose?.description ?? option.description) !== null && (
        <p className="px-2 pb-1 text-2xs text-faint">{prose?.description ?? option.description}</p>
      )}
      {/* `text-muted` rather than the description's `text-faint`: this one is
          about what will happen if you tap, and it has to outrank prose. */}
      {shared !== null && (
        <p id={sharedId} className="px-2 pb-1 text-2xs text-muted">
          {shared}
        </p>
      )}
      {/*
        ⚠ **Only reachable when the whole list did not arrive**, which is why it
        states a fact and names no remedy — this app's standing rule for a refusal,
        and here there genuinely is none anybody can act on from this panel.
        `AgentConfigBar` reads the complete control from `GET /sessions/:id` the
        moment it is handed a cut one, and merges it in with `truncated` cleared;
        so this line draws in the window before that lands and afterwards only if
        the machine could not be reached. Saying nothing there would be a menu
        quietly missing rows — the failure the whole `truncated` flag exists to
        prevent — and a spinner would be worse, because the rows that *are* here
        are correct and include the one that is selected.
      */}
      {option.truncated === true && (
        <p className="px-2 pb-1 text-2xs text-muted">
          Showing the first {choices.length}. The rest of this list has not loaded.
        </p>
      )}
      {choices.map((choice, index) => {
            const heading = choice.group !== null && choice.group !== choices[index - 1]?.group;
            // The transcript's copy first: the snapshot's is always null for a
            // choice that is not the selected one, because `snapshotConfig` strips
            // prose to keep a sixty-row poll cheap. This is where "Default" says
            // which model. Resolved once — it was the same three-term chain
            // written twice, once to test it and once to draw it.
            const description = rowDescription(
              option,
              choice.value,
              prose?.choices.get(String(choice.value)) ?? choice.description,
            );
            const refusal = refusals[index] ?? null;
            return (
              <div key={`${choice.group ?? ""}:${choice.value}`}>
                {heading && (
                  <p className="mt-1 px-2 py-0.5 text-2xs text-faint">{choice.group}</p>
                )}
                <button
                  // See `Absent`'s note; these rows are inside the composer's box
                  // too, one popover down.
                  type="button"
                  role="option"
                  aria-selected={choice.value === option.value}
                  /*
                   * **Not `disabled`, and not dimmed.** A greyed inert row answers
                   * "why can I not tap this?" with silence on a phone, where there
                   * is no tooltip — which is the bargain `Absent` already makes for
                   * a whole control, moved one level down to a row: it opens, says
                   * its sentence, and sends nothing.
                   *
                   * `onChoose` is not called, so `Select`'s own `setOpen(false)`
                   * inside it never runs either — the menu stays open with the
                   * sentence under the thumb rather than closing on a tap that did
                   * nothing.
                   */
                  aria-disabled={refusal !== null || undefined}
                  aria-describedby={refusal !== null && shared !== null ? sharedId : undefined}
                  onClick={() => {
                    if (refusal !== null) return;
                    onChoose(String(choice.value));
                  }}
                  className={`${menuRow("start")} hover:bg-raised ${
                    choice.value === option.value ? "font-medium" : ""
                  }`}
                >
                  {/*
                   * **The check is centred on the row's first line rather than
                   * nudged toward it.** `menuRow("start")` aligns to the top, so
                   * this used to be an 11px glyph in a 12px box with `mt-0.5` —
                   * two pixels of guess against a 20px line, which put the mark
                   * above the cap height of the name beside it and visibly out of
                   * line on a two-line row. `h-5` **is** that line box and
                   * `items-center` puts the glyph in the middle of it, so the
                   * alignment is the type's own rather than a number.
                   *
                   * 14px and `stroke-[2.5]`, up from 11px at the default weight:
                   * this is the only thing in the panel that says which row is the
                   * answer, and at 11px it was the lightest mark on screen.
                   * The box is drawn whether or not it holds anything, or the
                   * unselected rows would sit four pixels left of the selected one.
                   */}
                  <span className="flex h-5 w-4 shrink-0 items-center justify-center">
                    {choice.value === option.value && (
                      <Icon as={Check} size={14} className="stroke-[2.5]" />
                    )}
                  </span>
                  <span className="min-w-0">
                    {/* The same relabelling the chip does, so the menu row and the
                        chip cannot say two different things about one value. */}
                    <span className={`block truncate ${refusal !== null ? "text-muted" : ""}`}>
                      {rowLabel(option, choice)}
                    </span>
                    {/* The refusal takes the second line where there is one to
                        take: what happens if you tap outranks what the value is. */}
                    {refusal !== null && shared === null ? (
                      <span className="block text-2xs text-muted">{refusal}</span>
                    ) : (
                      description !== null && (
                        <span className="block text-2xs text-faint">{description}</span>
                      )
                    )}
                  </span>
                </button>
              </div>
            );
          })}
    </div>
  );
}

/**
 * The label a menu row gets when the agent's own is unhelpful.
 *
 * Two values qualify — claude's `default` effort and claude's and kimi's `default`
 * mode —
 * and each because what it means was established by measurement rather than
 * guessed. That is written down exactly once, in `agentConfig.ts`'s
 * {@link choiceOverride}, and this calls it. The rule used to be copied here
 * verbatim, under a comment claiming the two were kept beside each other so they
 * could not diverge — they were in different files, and only the chip's copy was
 * reachable by `webcheck`, so a correction to one would have been invisible in
 * the other.
 *
 * Calling it directly rather than going through `chipValue` is what removes the
 * old `model` special case: `chipValue` deliberately rewrites a model to the head
 * of its description, which is right for a chip showing one value and wrong for a
 * menu listing every value with that description printed underneath it. Asking
 * the narrow question narrowly means there is no wrong answer to exclude.
 *
 * **It answers a string now rather than `null` plus a fallback the caller wrote.**
 * The fallback was `?? choice.name`, and there were three of it — here, in
 * `chipValue` and in `configChoices` — which is the rule this docblock says lives
 * in one place, written out in three. `choiceLabel` is that place and it holds the
 * second rule too: opencode publishes its modes as `build` and `plan` where the
 * other three agents publish `Build`-shaped names.
 */
function rowLabel(option: AgentConfigOption, choice: AgentConfigChoice): string {
  return choiceLabel(option, choice);
}

/**
 * The sentence under that row — **ours only where the agent offered none.**
 *
 * kimi describes its `default` mode better than we could ("Manual approvals; tools
 * execute normally.") and keeps that sentence; claude sends `description: null`
 * for the same mode and for every effort choice, and gets ours. Preferring the
 * override unconditionally would have thrown away the one real description in the
 * set to print a shorter one we wrote.
 */
function rowDescription(
  option: AgentConfigOption,
  value: string | boolean,
  own: string | null,
): string | null {
  return own ?? choiceOverride(option, value)?.description ?? null;
}

function Toggle({
  option,
  prose,
  disabled,
  locked,
  onChange,
}: {
  option: AgentConfigOption;
  prose: ConfigProse | undefined;
  /** No agent to ask. Inert **and** dimmed — see `Select`'s pair. */
  disabled: boolean;
  /** Another control in this row is in flight. Inert and **not** dimmed. */
  locked: boolean;
  onChange: (value: boolean) => void;
}): ReactNode {
  const on = option.value === true;
  return (
    <button
      // See `Absent`'s note.
      type="button"
      onClick={() => onChange(!on)}
      disabled={disabled || locked}
      title={prose?.description ?? option.description ?? labelFor(option)}
      aria-pressed={on}
      /*
       * ⚠ **The one chip that keeps a border, and only while it is on.**
       *
       * `bg-raised` on `surface` is 1.22:1 — it groups a chip, it cannot carry a
       * boolean's whole state. Everything else in this row being borderless is
       * what makes a border available as a *meaning* here rather than as chrome:
       * an outline now says this toggle is on, which is more than it said when
       * every chip wore one. `border` is in `CHIP` at every state, so taking the
       * colour does not change the chip's width.
       *
       * The duplicate `font-medium` that used to sit in the base string beside
       * this one is gone: weight was in both arms, so it differentiated nothing.
       */
      className={`${CHIP} px-2 ${
        disabled
          ? "text-faint"
          : on
            ? "border-edge-strong bg-raised font-medium text-fg hover:bg-edge active:bg-edge"
            : "border-transparent text-muted hover:bg-raised active:bg-raised hover:text-fg"
      }`}
    >
      {label(option)}
      <span className={`${CHIP_MAX} truncate`}>{labelFor(option)}</span>
    </button>
  );
}
