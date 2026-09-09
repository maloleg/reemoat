import { useEffect, useId, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import {
  askTitle,
  elicitationAnswer,
  answerMark,
  displacedBy,
  elicitationForm,
  fieldValue,
  stepAnswered,
  type ElicitationForm,
  type RenderField,
} from "../elicitation";
import {
  asksVersion,
  draftFor,
  dropAsk,
  excludedFor,
  isCollapsed,
  setCollapsed,
  setDraftField,
  setExcluded,
  setStep,
  stepFor,
  subscribeAsks,
} from "../ask";
import { answerAlreadyLanded, errorText } from "../http";
import { keyOf, type SessionRef } from "../ids";
import { store } from "../store";
import { toast } from "./Toast";
import type { ElicitationField, PendingElicitationSnapshot } from "../wire";
import { AskAction, AskCard, askRowTone, ChoiceMark, type AskOption } from "./AskCard";
import { Icon, Skeleton } from "./bits";
import { ChevronLeft } from "lucide-react";

/**
 * A question the agent asked, in the shared ask card.
 *
 * Everything about the *frame* — where it sits, that it does not move the
 * transcript, the collapse, the ✕, the numbered rows, the digit shortcuts —
 * belongs to `AskCard` and is identical to what a permission gets. What is left
 * here is the only part that is really about elicitation: fetching the form,
 * stepping through it, and turning a draft into an answer.
 *
 * **One question at a time.** The fields arrive flat — three questions are six
 * fields — and drawn all at once that is a wall to scroll before anything can be
 * answered. `form.steps` groups each choice with the free-text box that belongs
 * to it, and this walks them, forwards *and* backwards: `Back` exists because a
 * form you cannot revise is a form you have to cancel to correct.
 *
 * The four actions map onto the four things ACP can say, and each is a real
 * outcome rather than a UI state:
 *
 *   Submit  → `accept`, with the content built by `elicitationAnswer`
 *   Skip    → `decline`; the tool runs with no answers and **the turn carries on**
 *   ✕       → `cancel`; the tool call is abandoned
 *
 * Collapsing is none of them, and neither is Escape, which does it. Folding the
 * card away answers nothing and the agent stays parked; it is there so the
 * conversation the question is *about* can be read underneath.
 */
export function ElicitationCard({
  sessionRef,
  pending,
  more,
  onHeight,
}: {
  sessionRef: SessionRef;
  pending: PendingElicitationSnapshot;
  /** Other requests waiting behind this one. Drawn by the card, not counted here. */
  more: number;
  /**
   * Passed straight to {@link AskCard.onHeight} — how tall this card is, so the
   * transcript can reserve the room and be scrolled clear of it. Nothing here
   * reads it; the card is out of flow and `SessionView` is what draws behind it.
   */
  onHeight?: (px: number) => void;
}): ReactNode {
  const [fields, setFields] = useState<ElicitationField[] | null>(null);
  const [busy, setBusy] = useState<"accept" | "decline" | "cancel" | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const sessionKey = keyOf(sessionRef);
  useSyncExternalStore(subscribeAsks, asksVersion);
  const draft = draftFor(sessionKey, pending.elicitationId);

  /*
   * The form is fetched rather than read off the snapshot: `GET /sessions`
   * returns sixty snapshots every four seconds, and a question — unlike an
   * approval — cannot be answered from a list anyway. Same arrangement the
   * command list has.
   */
  useEffect(() => {
    let cancelled = false;
    const daemon = store.daemonFor(sessionRef.machineId);
    if (daemon === undefined) {
      setLoadError("that machine is gone");
      return;
    }
    setFields(null);
    setLoadError(null);
    void daemon
      .elicitationForm(sessionRef.sessionId, pending.elicitationId)
      .then((result) => {
        if (!cancelled) setFields(result.fields);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setLoadError(errorText(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [sessionRef.machineId, sessionRef.sessionId, pending.elicitationId]);

  const form: ElicitationForm = useMemo(
    () => elicitationForm(pending, fields ?? []),
    [pending, fields],
  );
  const excluded = excludedFor(sessionKey, pending.elicitationId);
  const answer = useMemo(() => elicitationAnswer(form, draft, excluded), [form, draft, excluded]);

  const respond = (action: "accept" | "decline" | "cancel"): void => {
    if (busy !== null) return;
    setBusy(action);
    const daemon = store.daemonFor(sessionRef.machineId);
    if (daemon === undefined) {
      setBusy(null);
      toast("error", "that machine is gone");
      return;
    }
    void daemon
      .answerElicitation(
        sessionRef.sessionId,
        pending.elicitationId,
        action === "accept"
          ? { content: answer.content }
          : action === "decline"
            ? { decline: true }
            : { cancel: true },
      )
      .then((result) => {
        dropAsk(sessionKey, pending.elicitationId);
        store.applySnapshot(sessionRef, result.session);
      })
      .catch((cause: unknown) => {
        if (answerAlreadyLanded(cause, "elicitation_expired")) {
          dropAsk(sessionKey, pending.elicitationId);
          void store.resume("elicitation-settled");
          return;
        }
        toast("error", errorText(cause));
      })
      .finally(() => setBusy(null));
  };

  const set = (field: string, value: Parameters<typeof setDraftField>[3]): void => {
    setDraftField(sessionKey, pending.elicitationId, field, value);
  };

  /*
   * A write, and whatever it displaces.
   *
   * ⚠ **Nothing anybody typed is erased here, and the asymmetry is the rule rather
   * than an accident of it.** Writing your own answer clears the question's
   * *selection*, which is one tap to redo and is how you switch to it. Picking an
   * option clears **nothing** — the text stays in its box and stops being sent,
   * which `elicitationAnswer` does without touching it. See `displacedBy`.
   *
   * `""` and not a delete, for the reason the option rows already give: deleting
   * puts a field back to *untouched*, and an untouched field answers with the
   * agent's `default`. Only a value displaces, so emptying the box releases the
   * selection rather than clearing it a second time.
   *
   * Writing also switches the field back **on**: typing into a box you had turned
   * off is unambiguous about wanting it, and leaving it off would be the card
   * ignoring what somebody is in the middle of writing.
   */
  const write = (field: string, value: Parameters<typeof setDraftField>[3]): void => {
    set(field, value);
    const empty = value === "" || (Array.isArray(value) && value.length === 0);
    if (empty) return;
    setExcluded(sessionKey, pending.elicitationId, field, false);
    for (const other of displacedBy(form, field)) set(other, "");
  };

  /*
   * The mark beside a typed answer is a control, which the rows above it are too.
   *
   * ⚠ **Asked for directly: on a multi-select you must be able to switch your own
   * answer off from that square, having already written it.** Off is `ask.ts`'s
   * `excluded`, never an empty box.
   *
   * Turning one **on** also releases the question it answers, and only there does
   * that matter: a single-select suppresses its alternative while it holds a value,
   * so without this the tap would be undone in the same frame by the rule that
   * drew the mark empty in the first place.
   */
  const toggleAnswer = (field: RenderField, on: boolean): void => {
    setExcluded(sessionKey, pending.elicitationId, field.key, !on);
    if (!on) return;
    for (const other of displacedBy(form, field.key)) set(other, "");
  };

  const stepCount = Math.max(1, form.steps.length);
  const index = Math.min(stepFor(sessionKey, pending.elicitationId), stepCount - 1);
  const step = form.steps[index];
  const last = index >= stepCount - 1;
  /*
   * What has to be true before you may leave this question.
   *
   * Two halves. **Its own problems** — a value this step carries that the form
   * rejects; the rest of the form's problems are not this button's business, and
   * Submit validates the lot at the end anyway.
   *
   * ⚠ **And that it has been answered at all**, which is new and is the fix for a
   * report. `askUserQuestionsToCreateRequest` marks nothing `required`, so an
   * untouched question raised no problem and Next was live on a blank card — you
   * could walk a three-question form to the end with four taps and submit it having
   * said one thing. `stepAnswered` is the rule, pure and in `elicitation.ts` so
   * `webcheck` can reach it, and it reads the whole step: typing into the adapter's
   * own "Other" box instead of picking a row is an answer.
   *
   * **Skip is still there and is the honest way out.** Nothing here forces an
   * answer; it forces the *button that claims one* to have one.
   */
  const stepKeys = new Set((step?.fields ?? []).map((field) => field.key));
  const stepBlocked =
    answer.problems.some((problem) => stepKeys.has(problem.key)) ||
    !stepAnswered(form, index, answer.content);

  /*
   * Which of this step's fields is the *choices*, and which are everything else.
   *
   * The leading field is the question; if it has options those become the card's
   * numbered rows, and whatever follows — the adapter's own one-line "Other" box —
   * is drawn underneath them. That is the reference layout, and it falls out of
   * the projection rather than out of a field name: `groupIntoSteps` already
   * decided what belongs together, and this only asks whether the leader has
   * choices.
   */
  const leader = step?.fields[0];
  // Carried as a pair rather than re-narrowed at each use: `choice.kind` is a
  // property path, and TypeScript drops that narrowing inside the closures below.
  const choice =
    leader !== undefined && (leader.kind.k === "select" || leader.kind.k === "multiselect")
      ? { field: leader, kind: leader.kind }
      : null;
  const rest = choice !== null ? (step?.fields ?? []).slice(1) : (step?.fields ?? []);

  /*
   * The question, from the step rather than from the form — three sources in an
   * order that is silently wrong on one agent if reversed. See `askTitle`.
   */
  const title = askTitle(form, index);

  const chosenValue = choice === null ? undefined : fieldValue(choice.field, draft);
  const multi = choice?.kind.k === "multiselect";
  const options: AskOption[] =
    choice === null
      ? []
      : choice.kind.options.map((option) => {
          const current = Array.isArray(chosenValue) ? chosenValue : [];
          const chosen = multi ? current.includes(option.value) : chosenValue === option.value;
          return {
            id: option.value,
            label: option.label,
            description: option.description,
            chosen,
            /*
             * How many of these may be picked, which is the one fact these rows
             * did not carry. Ticking three and choosing one drew identically until
             * a tap had already made the difference — see `AskOption.mark`.
             */
            mark: multi ? "many" : "one",
            /*
             * Tapping the chosen row again clears it, which is how an optional
             * select goes back to unanswered.
             *
             * **`""` and not "delete the key", which is what this was.** Deleting
             * it puts the field back to *untouched*, and `fieldValue` answers an
             * untouched field with the agent's own `default` — so on a select
             * carrying one, "clear" either did visibly nothing or silently moved
             * the selection onto the default. An empty string is a value the
             * draft is holding, so no row is chosen; `elicitationAnswer` tests
             * emptiness before it tests anything else, so it is omitted from the
             * body exactly as absence was — and if the field is required, it
             * blocks Submit, which deleting the key would not have done.
             */
            onPick: () =>
              multi
                ? write(
                    choice.field.key,
                    chosen
                      ? current.filter((entry) => entry !== option.value)
                      : [...current, option.value],
                  )
                : write(choice.field.key, chosen ? "" : option.value),
          } satisfies AskOption;
        });

  const problemOf = (key: string): string | null =>
    answer.problems.find((entry) => entry.key === key)?.reason ?? null;
  const choiceProblem = choice === null ? null : problemOf(choice.field.key);

  return (
    <AskCard
      onHeight={onHeight}
      title={title}
      detail={
        stepCount > 1 ? (
          <span className="tabular-nums">
            Question {index + 1} of {stepCount}
          </span>
        ) : null
      }
      collapsed={isCollapsed(sessionKey, pending.elicitationId)}
      onToggle={(next) => setCollapsed(sessionKey, pending.elicitationId, next)}
      onDismiss={() => respond("cancel")}
      dismissLabel="Abandon this tool call"
      dismissDisabled={busy !== null}
      more={more}
      busy={busy !== null}
      options={options}
      // Only when there is something to say above the answers. An empty scrolling
      // region would still draw its own rule, which on a two-option question is a
      // line under the title and nothing else.
      context={
        loadError !== null ? (
          <p className="text-xs text-danger">{loadError}</p>
        ) : fields === null ? (
          <Skeleton rows={Math.max(1, Math.min(pending.fieldCount, 3))} />
        ) : null
      }
      extra={
        rest.length > 0 || choiceProblem !== null ? (
          <div className="space-y-2.5">
            {choiceProblem !== null && <p className="text-2xs text-danger">{choiceProblem}</p>}
            {rest.map((field) => (
              <Field
                key={field.key}
                field={field}
                // The card's title already asked the question, so nothing below
                // repeats it — **either half of it**. A step with no choices puts
                // its own `description` in the title, and comparing only the
                // label left the description drawn a second time directly under
                // it. A follow-up box keeps its short label — "Other" — which is
                // the row the reference draws under the choices.
                heading={field.label === title ? null : field.label}
                hint={field.hint === title ? null : field.hint}
                /*
                 * ⚠ **The box under a question is one of its answers, so it wears
                 * the same mark as the rows above it.** The adapter puts an
                 * optional free-text field after every `AskUserQuestion` — its own
                 * "Other" — and it was drawn as a labelled input under the list,
                 * which reads as a different *kind* of thing from the answers it
                 * sits with. Reported as exactly that: on a multi-select, typing
                 * your own answer is picking one.
                 *
                 * The gate is `answerMark`, i.e. the agent's own `alternativeTo` —
                 * **not** the step this field landed in. The two agreed on claude
                 * and the difference is the point: a mark promises what picking
                 * means, and this card can only keep that promise where it also
                 * knows to displace the other answer. See {@link displacedBy}.
                 */
                mark={answerMark(form, field)}
                /*
                 * Whether this field is *an answer*, which is not the same as
                 * whether its box has anything in it — see `elicitationAnswer`. A
                 * question that takes one answer suppresses its alternative while
                 * it holds a value, and the mark can be switched off by hand; both
                 * come out here, so the row draws what will be sent.
                 */
                counted={Object.prototype.hasOwnProperty.call(answer.content, field.key)}
                onToggle={(on) => toggleAnswer(field, on)}
                value={fieldValue(field, draft)}
                problem={problemOf(field.key)}
                onChange={(value) => write(field.key, value)}
              />
            ))}
          </div>
        ) : null
      }
      actions={
        <>
          {index > 0 && (
            <AskAction tone="quiet" onClick={() => setStep(sessionKey, pending.elicitationId, index - 1)}>
              <Icon as={ChevronLeft} size={12} />
              Back
            </AskAction>
          )}
          <div className="flex-1" />
          <AskAction
            onClick={() => respond("decline")}
            disabled={busy !== null}
            busy={busy === "decline"}
            title="Skip — the agent carries on without an answer"
          >
            Skip
          </AskAction>
          <AskAction
            tone="primary"
            onClick={() =>
              last ? respond("accept") : setStep(sessionKey, pending.elicitationId, index + 1)
            }
            /* Every step owes an answer; the last one additionally owes a body the
               route will take. `canSubmit` is the second half and is asked only
               there, because it is a statement about the whole form. */
            disabled={busy !== null || fields === null || stepBlocked || (last && !answer.canSubmit)}
            busy={busy === "accept"}
          >
            {last ? "Submit" : "Next"}
          </AskAction>
        </>
      }
    />
  );
}

/**
 * A control that is not a list of choices.
 *
 * The choices are the card's own numbered rows now, so what is left here is the
 * agent's free-text box and the shapes an MCP form can send: a number, a
 * yes/no, and a text field standing on its own.
 */
function Field({
  field,
  heading,
  hint,
  value,
  problem,
  mark,
  counted,
  onToggle,
  onChange,
}: {
  field: RenderField;
  heading: string | null;
  /** The agent's sentence about this field, already de-duplicated by the caller. */
  hint: string | null;
  value: ReturnType<typeof fieldValue>;
  problem: string | null;
  /**
   * `"one"` or `"many"` where this field is an answer to the question above it,
   * `null` where it is a field on a form.
   *
   * See the call site for the gate. It draws this box as a row in the list of
   * answers rather than as a control under it — same shell, same 44px, same
   * indicator — because that is what it is.
   *
   * ⚠ **It says "there is an answer in here", and deliberately not "this one wins".**
   * Measured on claude-agent-acp 0.73.0: `applyAskElicitationResponse` takes a
   * non-empty custom answer *instead of* the selection, for a multi-select as well
   * as a single one — so a card showing three ticked boxes and a filled Other is
   * showing four answers where one is sent. Modelling that would mean knowing this
   * box is a custom-answer field, and the only two ways to know are the key suffix
   * and `_meta`: `acp-agents.md` forbids the first by name (codex spells it
   * `__other` where claude spells it `_custom`, and a client keyed on either
   * renders one agent's question and refuses the other's) and the daemon drops the
   * second at ingest. So the mark states what is true here — this field has a value
   * — and what the agent does with two of them is the agent's.
   */
  mark: AskOption["mark"];
  /** Whether this field is in the body — see the call site. Meaningless without a `mark`. */
  counted: boolean;
  /** Switch this answer on or off without touching what it holds. */
  onToggle: (on: boolean) => void;
  onChange: (value: string | boolean | string[]) => void;
}): ReactNode {
  /*
   * **Every control below is named, and the name is the field's own.**
   *
   * The heading, the hint and the problem were three unassociated siblings: a
   * box with no `id`/`htmlFor`, no `aria-label` and no `aria-labelledby`
   * announces as "edit text" and nothing else — on the one card whose answers go
   * into the model's context, where the question is precisely what cannot be
   * guessed from the surroundings.
   *
   * `aria-labelledby` rather than a `<label htmlFor>`: the heading is shared by
   * a *group* of controls for a select, and a label element would also forward a
   * tap on the question to the control it names — which for the yes/no below is
   * a tap on the question flipping the answer.
   *
   * The heading is withheld by the caller when the card's title already asks the
   * question; the name is not, so it falls back to an `sr-only` copy of the
   * label. A duplicated sentence is what a *second heading* would cost, and this
   * is not one.
   */
  const id = useId();
  const nameId = `${id}-name`;
  const hintId = `${id}-hint`;
  const problemId = `${id}-problem`;
  const boolId = `${id}-bool`;
  const showsHint = hint !== null && hint !== heading;
  const describedBy =
    [showsHint ? hintId : null, problem !== null ? problemId : null].filter((entry) => entry !== null).join(" ") ||
    undefined;
  return (
    <div>
      {/*
       * ⚠ **A field drawn as an answer takes no heading**, however the caller
       * labelled it. The rows above carry their names inside them, so a word over
       * this one would make it a section rather than a member of the list — which
       * is the same argument `groupIntoSteps` already makes when it drops the
       * adapter's sentence about this box. The name is not lost: it becomes the
       * `sr-only` copy below, which is what `aria-labelledby` resolves to.
       */}
      {heading !== null && (mark === null || mark === undefined) ? (
        <p id={nameId} className="mb-1 text-xs font-medium wrap-anywhere">
          {heading}
        </p>
      ) : (
        <span id={nameId} className="sr-only">
          {field.label}
        </span>
      )}
      {/* Whatever the agent said about this field, when the heading is not
          already it. Dropped for a follow-up box by `groupIntoSteps`, because
          sitting under the choices it belongs to, its sentence says what the
          layout already says. */}
      {showsHint && (
        <p id={hintId} className="mb-1 text-2xs text-muted wrap-anywhere">
          {hint}
        </p>
      )}

      {field.kind.k === "text" &&
        (mark !== null && mark !== undefined ? (
          /*
           * An answer somebody types, drawn as one of the answers.
           *
           * The shell is `askRowTone` — the option rows' own function rather than a
           * class list that resembles theirs — so "picked" is the same three signals
           * here as one row up. Picked here means *counted*, never "the box has
           * something in it": a suppressed or switched-off answer keeps its text and
           * loses its mark.
           *
           * ⚠ **The mark is a `<button>`, so this row is not a `<label>` any more.**
           * It was, which put a tap anywhere in the row into the box — and that is
           * exactly what a nested control cannot survive: a label forwards its
           * activation to the field it names, so the square would have focused the
           * input instead of switching the answer off. The input is `flex-1` and is
           * most of the row, so what is lost is the padding either side of it.
           *
           * The input carries no border, no radius and no fill of its own — the row
           * is its boundary, which is `Composer`'s rule for the same shape. It is
           * still `text-xs` and still 44px, because the row is.
           */
          <div className={`flex min-h-11 w-full items-center rounded-md border ${askRowTone(counted)}`}>
            <input
              type="text"
              value={typeof value === "string" ? value : ""}
              onChange={(event) => onChange(event.target.value)}
              placeholder="Type your own answer here"
              aria-labelledby={nameId}
              aria-describedby={describedBy}
              className="min-w-0 flex-1 border-none bg-transparent px-3 py-0 text-xs outline-none"
            />
            {/*
             * 44px of target for a 16px mark, and the growth is the box rather than
             * a `::after`: this sits at the row's own edge, so a target reaching
             * past it would hang outside the thing anybody can see. `pr-3` keeps the
             * mark where a row's trailing slot is while the button owns the width.
             */}
            <button
              type="button"
              onClick={() => onToggle(!counted)}
              role={mark === "many" ? "checkbox" : undefined}
              aria-checked={mark === "many" ? counted : undefined}
              aria-pressed={mark === "one" ? counted : undefined}
              aria-labelledby={nameId}
              className="tap flex h-11 shrink-0 items-center pr-3 pl-2"
            >
              <ChoiceMark mark={mark} chosen={counted} />
            </button>
          </div>
        ) : field.kind.multiline ? (
          <textarea
            value={typeof value === "string" ? value : ""}
            onChange={(event) => onChange(event.target.value)}
            rows={3}
            placeholder="Type your own answer here"
            aria-labelledby={nameId}
            aria-describedby={describedBy}
            className="w-full resize-none rounded-md border border-edge bg-raised px-2.5 py-2 text-xs"
          />
        ) : (
          <input
            type="text"
            value={typeof value === "string" ? value : ""}
            onChange={(event) => onChange(event.target.value)}
            placeholder="Type your own answer here"
            aria-labelledby={nameId}
            aria-describedby={describedBy}
            className="min-h-11 w-full rounded-md border border-edge bg-raised px-2.5 text-xs"
          />
        ))}

      {field.kind.k === "number" && (
        <input
          // `inputMode` rather than `type="number"`, so the draft keeps the raw
          // string being typed: `-` and `1.` are real intermediate states and a
          // number input discards them.
          type="text"
          inputMode={field.kind.integer ? "numeric" : "decimal"}
          value={typeof value === "string" ? value : ""}
          onChange={(event) => onChange(event.target.value)}
          aria-labelledby={nameId}
          aria-describedby={describedBy}
          className="min-h-11 w-full rounded-md border border-edge bg-raised px-2.5 text-xs"
        />
      )}

      {field.kind.k === "boolean" && (
        <button
          id={boolId}
          onClick={() => onChange(value !== true)}
          aria-pressed={value === true}
          // The question **and** the answer: the two ids are the field's name and
          // this button's own text, so it announces "<the question>, Yes" rather
          // than a bare "Yes" that says nothing about what was agreed to. Naming
          // it with the question alone would take the visible word out of the
          // accessible name, which is the other half of the same failure.
          aria-labelledby={`${nameId} ${boolId}`}
          aria-describedby={describedBy}
          /* 44px, like every other answer control in this app. It was `min-h-10`,
             i.e. 40px, on the Yes/No a person taps to answer the agent. */
          className={`tap press flex min-h-11 w-full items-center rounded-md border px-2.5 text-left text-xs ${
            value === true
              ? "border-edge-strong bg-raised font-medium text-fg hover:bg-edge"
              : "border-edge bg-raised hover:border-edge-strong hover:bg-edge/50"
          }`}
        >
          {value === true ? "Yes" : "No"}
        </button>
      )}

      {/* A select reaching here means a step whose *leader* was not the choice
          field — an MCP form with two selects in a row. Rare, and it still has to
          draw: the card's numbered rows only ever hold the leader's. */}
      {(field.kind.k === "select" || field.kind.k === "multiselect") && (
        <div className="space-y-1">
          {field.kind.options.map((option) => {
            const multi = field.kind.k === "multiselect";
            const current = Array.isArray(value) ? value : [];
            const chosen = multi ? current.includes(option.value) : value === option.value;
            return (
              <button
                key={option.value}
                onClick={() =>
                  multi
                    ? onChange(
                        chosen
                          ? current.filter((entry) => entry !== option.value)
                          : [...current, option.value],
                      )
                    : onChange(option.value)
                }
                /* The same shape the card's own rows draw, from the same
                   component: a box for a multi-select and a circle for a select,
                   with the role claimed only where a `<button>` keeps it. See
                   `ChoiceMark`. */
                role={multi ? "checkbox" : undefined}
                aria-checked={multi ? chosen : undefined}
                aria-pressed={multi ? undefined : chosen}
                /* Picked is a thicker edge and not a heavier face, for the reason
                   `AskCard`'s `CHOSEN` gives at length: the label below is
                   `wrap-anywhere` with no truncate, so `font-medium` here grew the
                   row by a line at some widths and pushed every option under it
                   down. A `ring` is a box-shadow and costs no layout. Q3.421. */
                className={`tap press flex min-h-11 w-full items-start rounded-md border px-2.5 py-2 text-left text-xs ${
                  chosen
                    ? "border-edge-strong bg-raised text-fg ring-1 ring-edge-strong ring-inset hover:bg-edge"
                    : "border-edge bg-raised hover:border-edge-strong hover:bg-edge/50"
                }`}
              >
                <span className="min-w-0 flex-1 wrap-anywhere">{option.label}</span>
                <ChoiceMark mark={multi ? "many" : "one"} chosen={chosen} />
              </button>
            );
          })}
        </div>
      )}

      {problem !== null && (
        <p id={problemId} className="mt-1 text-2xs text-danger">
          {problem}
        </p>
      )}
    </div>
  );
}
