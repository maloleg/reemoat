/**
 * A question the agent asked, as something a person can fill in.
 *
 * Sibling of `permission.ts`, which is the same job for the other half of *does
 * anything need me*. Everything here is pure so `webcheck` can assert it with no
 * DOM — which matters more than usual, because every rule below is silently wrong
 * in a direction nobody notices: a zero sent for a field somebody left blank, an
 * empty string that reads as an answer, a Submit button enabled onto a 400.
 *
 * **Much smaller than it would have been, because the daemon projects.** The raw
 * ACP schema is an open union of JSON-Schema fragments; by the time it reaches
 * here it is a fixed `ElicitationField[]` with `enum`/`oneOf` already normalized,
 * unknown property types already refused, and `pattern` already dropped. So there
 * is no schema parsing in this file, no `unknown` to narrow, and no truncation
 * marker to recognise — the daemon refuses an oversized form outright rather than
 * handing over a stand-in, because `{truncated: true, bytes}` is a fine thing to
 * show above an Approve button and useless above a form.
 *
 * **Nothing here reads a field's name.** claude's adapter keys an
 * `AskUserQuestion` as `question_0`, `question_0_custom`, `question_1`… and it
 * would be easy to match those and fuse each "Other" box into the question above
 * it. That is the `"reject_once"` mistake one surface over: those names are what
 * one adapter happens to send today. `webcheck` pins it by running the whole
 * fixture again with the keys renamed and asserting the same form comes out.
 *
 * What falls out is that the *generic* rendering is already almost exactly what
 * Claude Code draws: `message` is the prompt, a select is option rows carrying
 * each option's own description, and the adapter's own `title: "Other"` field
 * lands underneath as an optional one-line box.
 */

import { MAX_ANSWER_CHARS } from "./wire";
import type { ElicitationField, ElicitationOption, PendingElicitationSnapshot } from "./wire";

/**
 * What a control holds while it is being filled in.
 *
 * A number lives here as **the string being typed**, and that is the whole reason
 * this is not `ContentValue`. `-`, `1.` and `1e` are real intermediate states, and
 * coercing on every keystroke deletes what is in the box.
 * {@link elicitationAnswer} is the only place that crosses over.
 */
export type DraftValue = string | boolean | string[];

/** A partial record on purpose — see {@link fieldValue} on why absence is a state. */
export type ElicitationDraft = Readonly<Record<string, DraftValue>>;

/** What goes on the wire, matching ACP's `ElicitationContentValue`. */
export type ContentValue = string | number | boolean | string[];

/** How a field is drawn. Closed, so the JSX can switch exhaustively. */
export type RenderKind =
  | { k: "text"; multiline: boolean; format: ElicitationField["format"]; min: number | null; max: number | null }
  | { k: "number"; integer: boolean; min: number | null; max: number | null }
  | { k: "boolean" }
  | { k: "select"; options: ElicitationOption[] }
  | { k: "multiselect"; options: ElicitationOption[]; min: number | null; max: number | null };

export interface RenderField {
  key: string;
  /** `title`, falling back to the raw key. Never invented, never prettified. */
  label: string;
  hint: string | null;
  required: boolean;
  kind: RenderKind;
  /** The agent's own default, already the right type for the control. */
  fallback: DraftValue | undefined;
  /**
   * The key of the field this one is an alternative answer to, or `null`.
   *
   * The agent's own declaration, carried through unchanged. See {@link displacedBy}
   * for what the card does with it and `src/events.ts` for why nothing infers it.
   */
  alternativeTo: string | null;
}

/**
 * One question, with whatever belongs to it.
 *
 * The unit the card steps through. Usually a choice plus the free-text box the
 * agent offered beside it; for a plain form, one field on its own.
 */
export interface RenderStep {
  key: string;
  fields: RenderField[];
}

export interface ElicitationForm {
  message: string;
  fields: RenderField[];
  /**
   * The fields grouped into questions, in order.
   *
   * **This is a change of mind, recorded rather than quietly made.** The rule
   * below — an optional options-less text field directly after a field with
   * choices belongs to it — was refused once, on the grounds that an MCP form's
   * `{choice, notes}` pair would be fused too, where `notes` is a second question
   * in its own right.
   *
   * What made that argument wrong is that the grouping is **presentational
   * only**: both fields keep their own key and both are validated and sent
   * independently, so the worst a wrong grouping does is put two questions on one
   * card together. That is a cosmetic misread, not an answer that means something
   * else — which is what the original objection was actually about.
   *
   * And the gain is not cosmetic: without a notion of "one question", stepping
   * through three questions means six screens, half of them a bare text box with
   * no idea what it is for.
   */
  steps: RenderStep[];
  /**
   * Whether `message` says anything the fields do not.
   *
   * With one question the adapter puts the question itself in `message` and
   * leaves the field's description empty, so it is the only text there is. With
   * several it puts a preamble there — "Please answer the following questions." —
   * and gives each question its own description, so drawing it costs a line of
   * boilerplate above questions that already speak for themselves.
   *
   * Decided **structurally** and never by matching that sentence: a string one
   * adapter happens to send today is exactly what `labelFor` and the
   * field-name rule forbid keying on. The question asked instead is "do the
   * substantive fields carry their own text" — and only fields with choices
   * count, because the adapter's own free-text box always has a description and
   * would otherwise answer for the question above it.
   */
  showsPrompt: boolean;
}

export type ProblemCode =
  | "required"
  | "too_short"
  | "too_long"
  | "not_a_number"
  | "not_an_integer"
  | "below_min"
  | "above_max"
  | "too_few"
  | "too_many"
  | "not_an_option";

export interface FieldProblem {
  key: string;
  code: ProblemCode;
  /** One sentence, drawn under the field. `webcheck` asserts `code`. */
  reason: string;
}

export interface ElicitationAnswer {
  /** Exactly the `content` the route takes. Untouched optionals are absent. */
  content: Record<string, ContentValue>;
  problems: FieldProblem[];
  canSubmit: boolean;
}

/**
 * Above this many characters, a string field gets a textarea.
 *
 * ACP has no such field, so it is derived — narrowly. An agent saying
 * `maxLength: 4000` is asking for prose; one saying nothing is asking for an
 * answer, and the commonest unbounded string in practice is the adapter's own
 * one-line "Other" box. Wrong in the cheap direction: a single-line input still
 * scrolls.
 */
const MULTILINE_ABOVE = 240;

/** One frozen instance, so a default argument cannot defeat a caller's `useMemo`. */
const EMPTY_EXCLUSIONS: ReadonlySet<string> = Object.freeze(new Set<string>());

/** Turn the daemon's fields into controls. */
export function elicitationForm(
  pending: PendingElicitationSnapshot,
  fields: readonly ElicitationField[],
): ElicitationForm {
  const rendered = fields.map(toRenderField);
  const asking = rendered.filter(
    (field) => field.kind.k === "select" || field.kind.k === "multiselect",
  );
  return {
    message: pending.message,
    fields: rendered,
    steps: groupIntoSteps(rendered),
    // Shown unless every question already carries its own text. A form with no
    // choice fields at all — a free-text or confirmation form — keeps it, because
    // then it really is the only thing saying what is wanted.
    showsPrompt: asking.length === 0 || asking.some((field) => field.hint === null),
  };
}

/**
 * What the card puts at the top of one step: the question, in the agent's words.
 *
 * Three sources and the order between them is the whole rule, because the two
 * agents fill them in oppositely and getting it wrong loses the question
 * entirely on one of them.
 *
 * 1. **The step's own description.** With several questions the adapter puts
 *    each one here and leaves `message` as a preamble, so this is the question.
 * 2. **The form's message, but only when there is one step.** With one question
 *    the adapter does the reverse — the question is in `message` and the field's
 *    description is empty — so the message *is* the question. Reading the field's
 *    `title` first would put the short chip label at the top and drop the
 *    sentence somebody has to answer — measured, that label read "what are we
 *    doing", translated from the original.
 * 3. **The field's title.** Which is what is left for a multi-step form whose
 *    fields carry no description: an MCP `{key: "regions", title: "Regions"}`
 *    multi-select, whose options become the card's unlabelled rows. Without this
 *    arm every step of such a form is titled with the same generic message and
 *    the word "Regions" appears nowhere on screen.
 *
 * Pure and here rather than in the card for the reason the rest of this file is:
 * it is silently correct on whichever agent the author happened to be running.
 */
export function askTitle(form: ElicitationForm, index: number): string {
  const leader = form.steps[index]?.fields[0];
  if (leader === undefined) return form.message;
  if (leader.hint !== null) return leader.hint;
  if (form.steps.length === 1) return form.message;
  return leader.label;
}

/**
 * The question a field is an answer to, or `null` where it is a control.
 *
 * Two sources, in order, and both are needed.
 *
 * **The agent's own `alternativeTo` first**, where it is there: claude and codex
 * each declare which question their free-text box answers, so the pairing is exact
 * even on a form where a step holds more than one follow-up.
 *
 * **Then the step**, which is what a daemon older than that field leaves us — and
 * is not a fallback so much as the same fact, less precisely: `groupIntoSteps` put
 * a non-required text field under a choice leader because it *is* that question's
 * own box. Reading it here is the **presentational** use `ElicitationForm.steps`
 * is licensed for, and it is what keeps the indicator drawn on every daemon rather
 * than appearing when one is updated.
 */
function questionOf(form: ElicitationForm, key: string): RenderField | null {
  const field = form.fields.find((entry) => entry.key === key);
  if (field === undefined) return null;
  const declared =
    field.alternativeTo === null
      ? undefined
      : form.fields.find((entry) => entry.key === field.alternativeTo);
  const asks =
    declared ??
    form.steps.find((step) => step.fields.some((entry) => entry.key === key) && step.fields[0]?.key !== key)
      ?.fields[0];
  if (asks === undefined) return null;
  return asks.kind.k === "select" || asks.kind.k === "multiselect" ? asks : null;
}

/**
 * Whether this field is an *answer* rather than a control, and how many the
 * question it answers admits.
 *
 * `null` for everything on an ordinary form. `"one"` or `"many"` for a field that
 * answers a question, taking its shape from the **question** — a circle where that
 * question is a select, a box where it is a multi-select — so the free-text box and
 * the rows above it wear the same mark.
 *
 * ⚠ **It is drawn from `questionOf`, which reads the step when nothing is
 * declared, and gating it on the declaration alone was a regression.** For one
 * release it was: the box lost its indicator entirely against any daemon that did
 * not yet send `alternativeTo`, which is every daemon until its owner restarts one.
 * A mark is a fact about the *layout* — this box answers the question above it —
 * and a layout may not wait on a wire field. What waits on the wire is only how
 * precisely the pairing is known.
 */
export function answerMark(form: ElicitationForm, field: RenderField): "one" | "many" | null {
  const asks = questionOf(form, field.key);
  if (asks === null) return null;
  return asks.kind.k === "multiselect" ? "many" : "one";
}

/**
 * The other fields a value written here displaces, or `[]`.
 *
 * **Nothing you typed is ever erased, and that is the shape of this rule rather
 * than a caveat on it.** It ran both ways once — picking an option emptied the box
 * — and that is wrong for the obvious reason: a pick is one tap and costs nothing
 * to redo, while a sentence somebody wrote is gone. *"The user may tap by accident
 * and then change their mind; they simply chose another option, the field is not
 * zeroed."*
 *
 * So there is exactly one direction. **Writing your own answer clears the
 * question's selection**, because that is how you switch to it and a selection is a
 * tap. **Picking an option clears nothing**: the text stays in its box, and what
 * makes the card honest instead is {@link elicitationAnswer}, which stops *sending*
 * an alternative while the question it answers has its own value. The box keeps its
 * content, loses its mark, and gets it straight back if the selection goes.
 *
 * **Only where the question takes one answer.** A multi-select displaces nothing in
 * either direction — several is what it means, and both the ticks and the typed
 * answer are sent.
 *
 * One hop, never a walk: a field displaced here may answer a question of its own,
 * and following that would be this function deciding what a second question means.
 */
export function displacedBy(form: ElicitationForm, key: string): string[] {
  const asks = questionOf(form, key);
  if (asks === null) return [];
  return asks.kind.k === "select" ? [asks.key] : [];
}

/**
 * Whether the question on screen has been answered, out of the body that would be
 * sent rather than out of the draft.
 *
 * ⚠ **This is what stops Next and Submit leaving a question blank**, and it is a
 * separate rule from `canSubmit` on purpose: that one asks whether the *form* says
 * anything, this one asks whether *this step* does. Without it a three-question
 * form could be walked all the way through with Next and submitted on the strength
 * of one answer given at the end.
 *
 * **The whole step, not its leading field.** A step is a question plus the
 * adapter's own optional "Other" box, and typing your own answer instead of picking
 * one is an answer — so anything in the step counts.
 *
 * **A step with no fields answers itself.** That is the field-less confirmation
 * (`requestedSchema` with no properties, message *"Proceed?"*), where accepting is
 * the answer and there is nothing to fill in; the same exemption `canSubmit` makes
 * one function over, and for the same reason.
 *
 * Reads `content` with `hasOwnProperty` because that object has a **null
 * prototype** — see `elicitationAnswer`, where that is load-bearing for a field
 * named `__proto__`.
 */
export function stepAnswered(
  form: ElicitationForm,
  index: number,
  content: Record<string, ContentValue>,
): boolean {
  const step = form.steps[index];
  if (step === undefined || step.fields.length === 0) return true;
  return step.fields.some((field) => Object.prototype.hasOwnProperty.call(content, field.key));
}

/** See {@link ElicitationForm.steps} for why this rule exists and what it risks. */
function groupIntoSteps(fields: readonly RenderField[]): RenderStep[] {
  const steps: RenderStep[] = [];
  for (const field of fields) {
    const open = steps.at(-1);
    const leader = open?.fields[0];
    const followsAChoice =
      leader !== undefined && (leader.kind.k === "select" || leader.kind.k === "multiselect");
    // One follow-up per question, so a form of three loose text fields does not
    // collapse into one step.
    const isFollowUp = field.kind.k === "text" && !field.required && open?.fields.length === 1;
    if (open !== undefined && followsAChoice && isFollowUp) {
      // Its description goes with it. The adapter explains the box — "Type your
      // own answer instead of choosing an option above (optional)." — because on
      // a flat list it has to; sitting directly under the choices it belongs to,
      // that sentence says what the layout already says. Dropped only *here*, so
      // a text field standing on its own keeps whatever the agent wrote.
      open.fields.push({ ...field, hint: null });
      continue;
    }
    steps.push({ key: field.key, fields: [field] });
  }
  return steps;
}

function toRenderField(field: ElicitationField): RenderField {
  const base = {
    key: field.key,
    // The raw key rather than a prettified one. Renaming something an agent named
    // is what `labelFor` forbids one surface over, and here there is no better
    // version to offer at all.
    label: field.title ?? field.key,
    hint: field.description,
    required: field.required,
    // `?? null` is the whole migration: a daemon older than the field does not
    // send it, and an agent that declares nothing produces `null` anyway, so
    // absent and "no" are one state rather than two.
    alternativeTo: field.alternativeTo ?? null,
  };

  const options = field.options ?? [];
  switch (field.kind) {
    case "string":
      return options.length > 0
        ? {
            ...base,
            kind: { k: "select", options },
            fallback: typeof field.default === "string" ? field.default : undefined,
          }
        : {
            ...base,
            kind: {
              k: "text",
              multiline: field.max !== null && field.max > MULTILINE_ABOVE,
              format: field.format,
              min: field.min,
              max: field.max,
            },
            fallback: typeof field.default === "string" ? field.default : undefined,
          };
    case "number":
    case "integer":
      return {
        ...base,
        kind: { k: "number", integer: field.kind === "integer", min: field.min, max: field.max },
        // Stringified, because the draft holds what is being typed.
        fallback: typeof field.default === "number" ? String(field.default) : undefined,
      };
    case "boolean":
      return {
        ...base,
        kind: { k: "boolean" },
        fallback: typeof field.default === "boolean" ? field.default : undefined,
      };
    case "multi_select":
      return {
        ...base,
        kind: { k: "multiselect", options, min: field.min, max: field.max },
        fallback: Array.isArray(field.default) ? field.default : undefined,
      };
  }
}

/**
 * What a control shows: what was typed, else the agent's default, else nothing.
 *
 * Exported so the control and {@link elicitationAnswer} read one rule. Two
 * derivations of "what is in this box" is how a checkbox comes to show itself
 * checked and send nothing.
 */
export function fieldValue(field: RenderField, draft: ElicitationDraft): DraftValue | undefined {
  return Object.prototype.hasOwnProperty.call(draft, field.key) ? draft[field.key] : field.fallback;
}

/**
 * Validate a draft and build the body in one pass.
 *
 * **`canSubmit` and the request body are the same value**, which is stronger than
 * the `canSend` precedent this mirrors: `canSend` has to *agree* with its route
 * or Send is enabled onto a 400, and here the thing enabling the button is
 * literally the thing being sent, so there is nothing left to agree about.
 *
 * A key **absent** from the draft is a third state doing real work three times:
 * untouched with a default sends the default (the control is showing it, so it
 * *is* the answer), untouched without one is omitted, and a deliberately-emptied
 * multi-select is sent as `[]` rather than dropped.
 *
 * Emptiness is tested **before** any parse, and that ordering is load-bearing:
 * `Number("")` and `Number(" ")` are both `0`, so a parse-first version silently
 * sends a zero nobody typed into a blank optional number field.
 *
 * ⚠ **A form with nothing in it cannot be submitted, and that is not a rule about
 * `required`.** Measured on claude-agent-acp 0.73.0: `askUserQuestionsToCreateRequest`
 * marks **no** field required, on purpose — *"so the user can also just skip"* — so
 * an empty draft raised no problem and Submit sent `{}`. That is Skip with a
 * primary-coloured button in front of it: `decline` and an accepted empty form both
 * run the tool with no answers, and the two controls sat side by side doing the
 * same thing, one of them looking like the affirmative one. Reported after somebody
 * sent an empty answer by accident.
 *
 * So `canSubmit` is *no problems* **and** something to submit. It is not done by
 * inventing `required` — that would be this client overriding a schema the agent
 * wrote, and it would also refuse a form somebody deliberately answered in part.
 * One non-empty field is enough, which is the honest floor: below it there is
 * nothing being said that Skip does not already say.
 *
 * ⚠ **A form with no fields is exempt, and it is the reason this is not simply
 * "content is non-empty".** A confirmation — `requestedSchema` with no properties,
 * message *"Proceed?"* — has nothing to fill in, so accepting it *is* the answer
 * and an empty body is the right one. Without the exemption the one form whose
 * only control is Submit would have had Submit disabled for ever.
 *
 * An untouched optional field is *absent* from `content`, never `""` — the
 * adapter reads a non-empty custom field as overriding that question's selection,
 * so an empty string sent where somebody typed nothing answers a question they
 * skipped.
 */
export function elicitationAnswer(
  form: ElicitationForm,
  draft: ElicitationDraft,
  /**
   * Answers switched off without being deleted — `ask.ts`'s `excludedFor`.
   *
   * Defaulted, so the dozens of assertions and the one caller that has nothing to
   * exclude read as they always did. See {@link displacedBy} for why "off" is a
   * thing a field can be at all: nothing anybody typed is ever erased, so refusing
   * to *send* it is the only honest way to stop it counting.
   */
  excluded: ReadonlySet<string> = EMPTY_EXCLUSIONS,
): ElicitationAnswer {
  /*
   * **`Object.create(null)`, because the agent chooses these keys.**
   *
   * A field named `__proto__` is a legal JSON Schema property and an MCP server
   * may send one. On a plain `{}`, `content[field.key] = value` for that key sets
   * the object's *prototype* instead of an own property — so the answer vanished,
   * `JSON.stringify` emitted `{}`, and `canSubmit` still said `true`. Measured:
   * a required `__proto__` field produced `content: {}` with **no problems**, so
   * the card enabled Submit on a form it could not answer and the daemon replied
   * `400 invalid_content` for a form somebody had filled in correctly.
   *
   * With a null prototype it is an ordinary own property, serialises, and reaches
   * the daemon — whose own validator reads `Object.keys` and `hasOwnProperty` and
   * was never exposed to this. One line, and it removes a silent drop rather than
   * adding a rule about names.
   */
  const content: Record<string, ContentValue> = Object.create(null) as Record<string, ContentValue>;
  const problems: FieldProblem[] = [];
  const fail = (key: string, code: ProblemCode, reason: string): void => {
    problems.push({ key, code, reason });
  };

  for (const field of form.fields) {
    const raw = fieldValue(field, draft);

    // Emptiness first, before any parse. See the docblock.
    const empty =
      raw === undefined ||
      (typeof raw === "string" && raw.trim() === "") ||
      (Array.isArray(raw) && raw.length === 0 && !Object.prototype.hasOwnProperty.call(draft, field.key));
    if (empty) {
      if (field.required) fail(field.key, "required", "this one is needed");
      continue;
    }

    switch (field.kind.k) {
      case "text": {
        if (typeof raw !== "string") break;
        const value = raw.trim();
        const { min, max } = field.kind;
        if (min !== null && value.length < min) {
          fail(field.key, "too_short", `at least ${min} characters`);
          continue;
        }
        if (max !== null && value.length > max) {
          fail(field.key, "too_long", `at most ${max} characters`);
          continue;
        }
        // The daemon's own ceiling, which it applies to every string field before
        // it looks at that field's `maxLength` — and the adapter's free-text box
        // carries no `maxLength` at all, so this was the only thing standing
        // between a long answer and a `400`.
        if (value.length > MAX_ANSWER_CHARS) {
          fail(field.key, "too_long", `at most ${MAX_ANSWER_CHARS} characters`);
          continue;
        }
        content[field.key] = value;
        continue;
      }
      case "select": {
        if (typeof raw !== "string") break;
        // By identity against the value the daemon sent. Reachable when a default
        // names something the option list does not contain, which an agent can do.
        if (!field.kind.options.some((option) => option.value === raw)) {
          fail(field.key, "not_an_option", "that is not one of the choices");
          continue;
        }
        content[field.key] = raw;
        continue;
      }
      case "number": {
        if (typeof raw !== "string") break;
        const value = Number(raw.trim());
        if (!Number.isFinite(value)) {
          fail(field.key, "not_a_number", "expected a number");
          continue;
        }
        if (field.kind.integer && !Number.isInteger(value)) {
          fail(field.key, "not_an_integer", "expected a whole number");
          continue;
        }
        if (field.kind.min !== null && value < field.kind.min) {
          fail(field.key, "below_min", `at least ${field.kind.min}`);
          continue;
        }
        if (field.kind.max !== null && value > field.kind.max) {
          fail(field.key, "above_max", `at most ${field.kind.max}`);
          continue;
        }
        content[field.key] = value;
        continue;
      }
      case "boolean": {
        if (typeof raw !== "boolean") break;
        // `false` is an answer, which is why the emptiness test above never looks
        // at booleans.
        content[field.key] = raw;
        continue;
      }
      case "multiselect": {
        if (!Array.isArray(raw)) break;
        // Hoisted, because the narrowing is lost inside the closure below.
        const { options, min, max } = field.kind;
        // Deduped keeping first order: two identical choices reach the agent as a
        // repeated label once the adapter joins them.
        const chosen = [...new Set(raw)];
        if (chosen.some((entry) => !options.some((option) => option.value === entry))) {
          fail(field.key, "not_an_option", "that is not one of the choices");
          continue;
        }
        if (min !== null && chosen.length < min) {
          fail(field.key, "too_few", `choose at least ${min}`);
          continue;
        }
        if (max !== null && chosen.length > max) {
          fail(field.key, "too_many", `choose at most ${max}`);
          continue;
        }
        content[field.key] = chosen;
        continue;
      }
    }
  }

  // `content` is what would be sent, so "is anything being said" is a question about
  // it rather than about the draft — an untouched field carrying the agent's own
  // `default` is in here and is a real answer, and an emptied one is not.
  /*
   * What is in the draft and what is *an answer* are two different questions, and
   * this is where they part.
   *
   * **Switched off by hand.** The mark beside a typed answer is a control — tap it
   * and the text stays in its box and stops counting. There is no spelling of that
   * in a `DraftValue`, so it lives beside the draft and is applied here.
   *
   * **Or displaced by the question it answers.** A question that takes *one* answer
   * holds one: with the question itself answered, its free-text alternative is not
   * what is being said, so it is not sent and the row draws unmarked. It is not
   * emptied — pick the option again to release it, or clear the selection and the
   * text is the answer once more. A multi-select displaces nothing: several is what
   * it means.
   *
   * Deleting from `content` rather than skipping in the loop above, because the
   * displacement is a question about *another* field's value and the loop has not
   * necessarily reached it yet.
   */
  for (const field of form.fields) {
    if (!Object.prototype.hasOwnProperty.call(content, field.key)) continue;
    const asks = questionOf(form, field.key);
    const suppressed =
      asks !== null &&
      asks.kind.k === "select" &&
      Object.prototype.hasOwnProperty.call(content, asks.key);
    if (excluded.has(field.key) || suppressed) delete content[field.key];
  }

  return {
    content,
    problems,
    canSubmit: problems.length === 0 && (form.fields.length === 0 || Object.keys(content).length > 0),
  };
}
