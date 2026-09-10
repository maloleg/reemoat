import { readFileSync } from "node:fs";
import { check } from "./webcheck.env.js";
import { snapshot } from "./webcheck.ws.js";
import { openableHref } from "./webcheck.modules.js";
import { stripComments } from "./webcheck.source.js";

/* ------------------------------------------------------------------ *
 * The question an agent asked
 * ------------------------------------------------------------------ */

/**
 * The form, the answer, and the predicate that carries both into the fleet view.
 *
 * Every rule here fails *silently* in a direction nobody notices from the outside:
 * a zero sent for a field somebody left blank, an empty string that reads as an
 * answer, a Submit button enabled onto a 400, a session that is both waiting and
 * working. That is what earns them a place in this file rather than in the JSX.
 */
process.stdout.write("\nthe question an agent asked\n");
{
  const { MAX_ANSWER_CHARS } = await import("../src/wire.js");
  const { askTitle, elicitationForm, elicitationAnswer, fieldValue, stepAnswered } = await import(
    "../src/elicitation.js"
  );
  const { humanRequests, needsHuman, waitingCount, oldestWait, showsWorking } = await import(
    "../src/wire.js"
  );
  const { elicitationOutcome } = await import("../src/ui/tail.js");
  const { answerAlreadyLanded } = await import("../src/http.js");
  const { ApiError } = await import("../src/http.js");

  const pendingOf = (message: string, fieldCount: number): any => ({
    elicitationId: "elic-1-abc",
    toolCallId: "tc_1",
    message,
    fieldCount,
    raisedAt: 1_000,
  });

  /* ---- A: the measured AskUserQuestion shape, N=1 ---- */

  const askFields: any[] = [
    {
      key: "question_0",
      kind: "string",
      title: "Framework",
      description: null,
      required: false,
      options: [
        { value: "React", label: "React", description: "Already in package.json" },
        { value: "Svelte", label: "Svelte", description: null },
      ],
      min: null,
      max: null,
      format: null,
      default: null,
    },
    {
      key: "question_0_custom",
      kind: "string",
      title: "Other",
      description: "Type your own answer instead of choosing an option above (optional).",
      required: false,
      options: null,
      min: null,
      max: null,
      format: null,
      default: null,
    },
  ];
  const ask = elicitationForm(pendingOf("Which framework should I use?", 2), askFields);

  check("the prompt is the agent's own message", ask.message, "Which framework should I use?");
  check(
    "a titled select becomes option rows and the Other box a text field",
    ask.fields.map((field) => [field.key, field.kind.k, field.label]),
    [
      ["question_0", "select", "Framework"],
      ["question_0_custom", "text", "Other"],
    ],
  );
  // The adapter's explanation of its own box is dropped once the box sits under
  // the choices it belongs to — the layout says it. A loose text field keeps it.
  check("a follow-up box loses the sentence the grouping makes redundant", ask.steps[0]?.fields[1]?.hint, null);
  check("but the flat field list is untouched", ask.fields[1]?.hint !== null, true);
  // An unbounded string is one line: the commonest one in practice is the
  // adapter's own "Other" box, and a textarea there would be three rows of
  // nothing on a phone.
  check(
    "an unbounded string field is a single line",
    ask.fields[1]?.kind.k === "text" && ask.fields[1].kind.multiline,
    false,
  );

  /*
   * **The assertion that pins the culture rule.** Rename the adapter's own field
   * keys and assert an identical form comes out. Anything that ever greps for
   * `question_` or `_custom` fails here.
   */
  const renamed = elicitationForm(
    pendingOf("Which framework should I use?", 2),
    askFields.map((field, index) => ({ ...field, key: index === 0 ? "a" : "b" })),
  );
  check(
    "nothing is keyed on the adapter's field names",
    JSON.stringify(renamed.fields.map(({ key, ...rest }) => rest)),
    JSON.stringify(ask.fields.map(({ key, ...rest }) => rest)),
  );

  /*
   * With one question the agent's `message` *is* the question, so it is drawn.
   * With several it is a preamble — "Please answer the following questions." —
   * and each question carries its own text, so drawing it costs a line of
   * boilerplate above questions that already speak for themselves.
   *
   * Decided structurally and never by matching that sentence. The two fixtures
   * below are the measured shapes for N=1 and N=2.
   */
  check("one question keeps the agent's message, because it is the question", ask.showsPrompt, true);
  /*
   * The other half of that, and the half that is silently wrong on one agent if
   * the three sources are read in the wrong order. With one question the title is
   * the *message* — reading the field's `title` first would put the short chip
   * label "Framework" at the top of the card and drop the sentence somebody has
   * to answer.
   */
  check("and the card is titled with it, not with the field's chip label", askTitle(ask, 0), "Which framework should I use?");
  {
    const twoQuestions: any[] = [
      { ...askFields[0], key: "q0", description: "Which framework?" },
      { ...askFields[1], key: "q0c" },
      { ...askFields[0], key: "q1", title: "TTL", description: "Which TTL?" },
      { ...askFields[1], key: "q1c" },
    ];
    const many = elicitationForm(pendingOf("Please answer the following questions.", 4), twoQuestions);
    check("several drop it, because each question carries its own text", many.showsPrompt, false);
    // The free-text box always has a description of its own, so it must not be
    // what answers "do the questions speak for themselves".
    check("and the Other boxes do not count as questions", many.fields.length, 4);
    check(
      "so each step is titled with its own question, not with the preamble",
      [askTitle(many, 0), askTitle(many, 1)],
      ["Which framework?", "Which TTL?"],
    );
  }
  check(
    "a form with no choices at all keeps it, since nothing else says what is wanted",
    elicitationForm(pendingOf("What should I name it?", 1), [
      { key: "name", kind: "string", title: "Name", description: null, required: true, options: null, min: null, max: null, format: null, default: null },
    ] as any).showsPrompt,
    true,
  );

  /*
   * Grouping, which is what makes stepping possible at all.
   *
   * Three questions arrive as six fields; without a notion of "one question"
   * that is six screens, half of them a bare text box with no idea what it is
   * for. The rule is presentational only — both fields keep their own key and
   * both are sent independently — which is why it was worth taking after being
   * refused once.
   */
  check("a choice and its free-text box are one question", ask.steps.length, 1);
  check("and both fields are still there, each with its own key", ask.steps[0]?.fields.map((f) => f.key), [
    "question_0",
    "question_0_custom",
  ]);
  {
    const three: any[] = [];
    for (let i = 0; i < 3; i += 1) {
      three.push({ ...askFields[0], key: `q${i}`, description: `Question ${i}?` });
      three.push({ ...askFields[1], key: `q${i}c` });
    }
    const stepped = elicitationForm(pendingOf("Please answer the following questions.", 6), three);
    check("three questions are three steps, not six", stepped.steps.length, 3);
  }
  // A required text field is a question of its own, and so is a second loose one:
  // only an *optional* box directly after a choice is a follow-up.
  check(
    "loose text fields are not swallowed by the question above them",
    elicitationForm(pendingOf("x", 3), [
      { key: "a", kind: "string", title: "A", description: null, required: false, options: [{ value: "1", label: "1", description: null }], min: null, max: null, format: null, default: null },
      { key: "b", kind: "string", title: "B", description: null, required: true, options: null, min: null, max: null, format: null, default: null },
      { key: "c", kind: "string", title: "C", description: null, required: false, options: null, min: null, max: null, format: null, default: null },
    ] as any).steps.map((step) => step.fields.map((f) => f.key)),
    [["a"], ["b"], ["c"]],
  );

  /* ---- B: a generic MCP-shaped form ---- */

  const mcpFields: any[] = [
    { key: "name", kind: "string", title: "Name", description: null, required: true, options: null, min: 3, max: 20, format: null, default: null },
    { key: "port", kind: "integer", title: "Port", description: null, required: true, options: null, min: 1024, max: 65535, format: null, default: 8080 },
    { key: "ratio", kind: "number", title: "Ratio", description: null, required: false, options: null, min: 0, max: 1, format: null, default: null },
    { key: "tls", kind: "boolean", title: "TLS", description: null, required: false, options: null, min: null, max: null, format: null, default: true },
    {
      key: "regions",
      kind: "multi_select",
      title: "Regions",
      description: null,
      required: false,
      options: [
        { value: "us", label: "us", description: null },
        { value: "eu", label: "eu", description: null },
      ],
      min: 1,
      max: 2,
      format: null,
      default: null,
    },
    { key: "notes", kind: "string", title: "Notes", description: null, required: false, options: null, min: null, max: 4000, format: null, default: null },
  ];
  const mcp = elicitationForm(pendingOf("Configure the service.", 6), mcpFields);
  check(
    "a long maxLength is what makes a field multiline",
    mcp.fields.find((f) => f.key === "notes")?.kind.k === "text" &&
      (mcp.fields.find((f) => f.key === "notes")!.kind as any).multiline,
    true,
  );

  /*
   * The third arm of `askTitle`, and it exists because a whole MCP form was
   * titled with one generic sentence five times over.
   *
   * These fields carry a `title` and no `description`, so there is no question to
   * read off the step and the message is a preamble rather than the question —
   * and `regions` is a multi-select, so its own options become the card's
   * unlabelled rows and the word "Regions" appeared nowhere on screen.
   */
  check(
    "a multi-step form with no descriptions is titled per field",
    mcp.steps.map((_, index) => askTitle(mcp, index)),
    ["Name", "Port", "Ratio", "TLS", "Regions"],
  );
  check("and its last step is the choice with its Notes box folded in", mcp.steps.at(-1)?.fields.map((f) => f.key), [
    "regions",
    "notes",
  ]);

  /*
   * The anchor case, and it pins three separate rules at once: an agent's default
   * is *sent* (the control is showing it, so it is the answer), an untouched
   * optional field is *omitted*, and a missing required one blocks Submit.
   */
  const empty = elicitationAnswer(mcp, {});
  check("an untouched form sends the defaults and omits the rest", empty.content, {
    port: 8080,
    tls: true,
  });
  check("and names the required field nobody filled in", empty.problems.map((p) => [p.key, p.code]), [
    ["name", "required"],
  ]);
  check("so it cannot be submitted", empty.canSubmit, false);

  /*
   * `Number("")` and `Number(" ")` are both `0`. A parse-first implementation
   * silently sends a zero nobody typed into a blank optional number field, which
   * is exactly the shape of bug this file exists for.
   */
  for (const blank of ["", "   "]) {
    check(
      `a blank number is not zero (${JSON.stringify(blank)})`,
      "ratio" in elicitationAnswer(mcp, { name: "ok", ratio: blank }).content,
      false,
    );
  }
  check(
    "false is an answer, not an absence",
    elicitationAnswer(mcp, { name: "ok", tls: false }).content.tls,
    false,
  );
  check(
    "a deliberately emptied multi-select is sent, not dropped",
    elicitationAnswer(mcp, { name: "okay", regions: [] }).problems.map((p) => p.code),
    ["too_few"],
  );
  check(
    "text is trimmed on the way out",
    elicitationAnswer(mcp, { name: "  okay  " }).content.name,
    "okay",
  );

  const codeFor = (draft: Record<string, any>): string[] =>
    elicitationAnswer(mcp, { name: "okay", ...draft }).problems.map((p) => p.code);
  check("a short string", elicitationAnswer(mcp, { name: "ab" }).problems.map((p) => p.code), ["too_short"]);
  /*
   * **The daemon's own ceiling, which the client did not have.** `registry.ts`
   * refuses any string answer over `MAX_ELICITATION_ANSWER_CHARS` (2048) *before*
   * it looks at the field's own `maxLength` — and the field the adapter is most
   * likely to leave unbounded is its free-text "Other" box. So `canSubmit` said
   * yes and the POST came back `400`, which is the one thing this file's docblock
   * says cannot happen because the value enabling the button is the value sent.
   */
  check(
    "an answer past the daemon's ceiling is refused here, not by the route",
    elicitationAnswer(mcp, { name: "okay", notes: "x".repeat(MAX_ANSWER_CHARS + 1) }).problems.map((p) => p.code),
    ["too_long"],
  );
  check(
    "and one exactly at it goes",
    elicitationAnswer(mcp, { name: "okay", notes: "x".repeat(MAX_ANSWER_CHARS) }).canSubmit,
    true,
  );
  check("a fractional integer", codeFor({ port: "1.5" }), ["not_an_integer"]);
  check("a number below its minimum", codeFor({ port: "80" }), ["below_min"]);
  check("a number above its maximum", codeFor({ ratio: "2" }), ["above_max"]);
  check("something that is not a number at all", codeFor({ ratio: "abc" }), ["not_a_number"]);
  // Deduping happens *before* the count is checked, so three taps on two distinct
  // options is two choices rather than one over the cap.
  check("the cap counts distinct choices, not taps", codeFor({ regions: ["us", "eu", "us"] }), []);
  check(
    "a choice the form never offered",
    codeFor({ regions: ["mars"] }),
    ["not_an_option"],
  );
  // Deduped keeping first order, so two identical taps are one choice rather than
  // a repeated label reaching the agent.
  check(
    "duplicates collapse rather than failing",
    elicitationAnswer(mcp, { name: "ok", regions: ["us", "us"] }).content.regions,
    ["us"],
  );

  check(
    "what a control shows is the draft, else the agent's default",
    [fieldValue(mcp.fields[1]!, {}), fieldValue(mcp.fields[1]!, { port: "9999" })],
    ["8080", "9999"],
  );

  /* ---- C: an empty form is answerable ---- */

  const confirm = elicitationForm(pendingOf("Proceed?", 0), []);
  const confirmed = elicitationAnswer(confirm, {});
  check("a form with no fields can still be accepted", [confirmed.canSubmit, confirmed.content], [true, {}]);
  /*
   * ⭐ **And it is the only form that can be submitted empty.**
   *
   * claude-agent-acp marks nothing `required` on an `AskUserQuestion` — deliberately,
   * *"so the user can also just skip"* — so `problems` was empty on an untouched
   * form and Submit sent `{}`. That is Skip with a primary-coloured button in front
   * of it: both run the tool with no answers. Reported after an empty answer went
   * out by accident.
   *
   * Asserted as a pair, because either half alone is the bug: the confirmation must
   * stay answerable, and the question must not be.
   */
  // The shape claude-agent-acp actually sends for one `AskUserQuestion`: a
  // single-select with `required: false`, and its own optional "Other" box beside it.
  const askedFields: any[] = [
    {
      key: "question_0",
      kind: "string",
      title: "Store",
      description: null,
      required: false,
      options: [
        { value: "Postgres", label: "Postgres", description: null },
        { value: "MongoDB", label: "MongoDB", description: null },
      ],
      min: null,
      max: null,
      format: null,
      default: null,
    },
    { key: "question_0_custom", kind: "string", title: "Other", description: null, required: false, options: null, min: null, max: null, format: null, default: null },
  ];
  const asked = elicitationForm(pendingOf("Which store?", 2), askedFields);
  check(
    "a question nobody answered is not a submission, whatever it says about required",
    [asked.fields.some((f) => f.required), elicitationAnswer(asked, {}).canSubmit],
    [false, false],
  );
  check(
    "and one answer is enough — nothing here invents a required field",
    elicitationAnswer(asked, { question_0: "Postgres" }).canSubmit,
    true,
  );
  check(
    "an emptied answer takes it back",
    elicitationAnswer(asked, { question_0: "" }).canSubmit,
    false,
  );

  /*
   * ⭐ **And `canSubmit` alone does not stop Next, which is the second half of the
   * same report.**
   *
   * `canSubmit` is a statement about the *form*: it says the body is not empty. On a
   * three-question form that lets you walk to the end with Next on blank cards and
   * submit having answered one thing — Next was live because nothing is `required`
   * and therefore nothing was a problem. `stepAnswered` is the per-step rule, and
   * the two are asserted apart because they answer different questions.
   */
  const threeFields: any[] = [0, 1, 2].flatMap((n) => [
    {
      key: `question_${n}`,
      kind: "string",
      title: `Q${n}`,
      description: null,
      required: false,
      options: [
        { value: "yes", label: "yes", description: null },
        { value: "no", label: "no", description: null },
      ],
      min: null,
      max: null,
      format: null,
      default: null,
    },
    { key: `question_${n}_custom`, kind: "string", title: "Other", description: null, required: false, options: null, min: null, max: null, format: null, default: null },
  ]);
  const three = elicitationForm(pendingOf("Please answer the following questions.", 6), threeFields);
  check("a question and its own Other box are one step", three.steps.length, 3);
  const answeredAt = (draft: Record<string, unknown>): boolean[] =>
    [0, 1, 2].map((i) => stepAnswered(three, i, elicitationAnswer(three, draft as never).content));
  check("nothing answered is no step answered", answeredAt({}), [false, false, false]);
  check("one answer answers one step", answeredAt({ question_1: "yes" }), [false, true, false]);
  /*
   * **The whole step, not its leading field.** Typing your own answer instead of
   * picking a row is an answer, and it lands in the follow-up field — so a rule
   * reading only the leader would have kept Next dead for somebody who had written
   * a sentence into the box the adapter put there for exactly that.
   */
  check("and the Other box counts as one", answeredAt({ question_0_custom: "neither" }), [true, false, false]);
  check(
    "the whole form answered is every step answered",
    answeredAt({ question_0: "yes", question_1: "no", question_2: "yes" }),
    [true, true, true],
  );
  /*
   * ⚠ **A step with no fields answers itself**, which is the field-less
   * confirmation again — the same exemption `canSubmit` makes, one function over,
   * and asserted here too because either could be tightened alone.
   */
  check("a form with nothing to fill in blocks nothing", stepAnswered(confirm, 0, {}), true);
  /*
   * And the card asks both, in that shape: every step owes an answer, the last one
   * additionally owes a body. Read off disk — the gate is a JSX prop and `webcheck`
   * has no DOM.
   */
  const cardSrc = stripComments(
    readFileSync(new URL("../src/ui/ElicitationCard.tsx", import.meta.url), "utf8"),
  );
  check("Next and Submit are both gated on this step", /!stepAnswered\(form, index, answer\.content\)/.test(cardSrc), true);
  check(
    "and only the last one is gated on the whole form",
    /stepBlocked \|\| \(last && !answer\.canSubmit\)/.test(cardSrc),
    true,
  );

  /*
   * **The agent chooses the field names, and one of them is a landmine.**
   * `__proto__` is a legal JSON Schema property; on a plain `{}`,
   * `content[key] = value` sets the *prototype* rather than an own property, so
   * the answer vanished while `canSubmit` still said `true` — a form the card
   * called valid, an empty body on the wire, and a `400` from the daemon for a
   * form somebody filled in correctly.
   */
  {
    const proto = elicitationForm(pendingOf("Pick one", 1), [
      { key: "__proto__", kind: "string", title: "T", description: null, required: true,
        options: [{ value: "a", label: "a", description: null }],
        min: null, max: null, format: null, default: null },
    ] as any);
    // A *computed* key, because `{__proto__: "a"}` in a literal is the
    // prototype-setter syntax and creates no own property — the draft that
    // reaches this in the app is built by `setDraftField`, which assigns.
    const answered = elicitationAnswer(proto, { ["__proto__"]: "a" } as any);
    check("an answer to a __proto__ field survives to the body", JSON.stringify(answered.content), '{"__proto__":"a"}');
    check("and it is not reported answerable while being dropped", answered.canSubmit, true);
  }

  /* ---- D: the predicate set, as a partition ---- */

  const sessionOf = (over: Record<string, unknown>): any => ({
    ...snapshot,
    turn: null,
    status: "idle",
    pendingPermissions: [],
    ...over,
  });

  const permission = { permissionId: "p1", toolCallId: null, title: "Terminal", options: [], raisedAt: 10, rawInput: null, content: null };
  const question = { elicitationId: "e1", toolCallId: null, message: "Which?", fieldCount: 1, raisedAt: 5 };

  const matrix = [
    sessionOf({}),
    sessionOf({ turn: 1, status: "running" }),
    sessionOf({ status: "blocked", turn: 1, pendingPermissions: [permission] }),
    sessionOf({ status: "blocked", turn: 1, pendingElicitations: [question] }),
    sessionOf({ status: "blocked", turn: 1, pendingPermissions: [permission], pendingElicitations: [question] }),
    sessionOf({ pendingElicitations: [] }),
    sessionOf({ status: "exited", exit: { reason: "stopped", at: 0, detail: null } }),
  ];

  const broken = matrix.filter(
    (session) =>
      needsHuman(session) !== waitingCount(session) > 0 ||
      waitingCount(session) !== humanRequests(session).length ||
      // The clause that matters: a form is parked mid-turn, so `turn` stays set.
      // Without it the transcript blinks "working…" over a question nobody has
      // answered.
      (needsHuman(session) && showsWorking(session)),
  );
  check("the predicates are a partition", broken.length, 0);

  check(
    "an older daemon's missing array behaves exactly as an empty one",
    [needsHuman(sessionOf({})), needsHuman(sessionOf({ pendingElicitations: [] }))],
    [false, false],
  );
  check("nothing waiting is an infinite wait, so Math.min needs no null check", oldestWait(sessionOf({})), Infinity);
  /*
   * Oldest first, and a permission does not lead by being the older feature. The
   * question here was raised at 5 and the approval at 10.
   */
  check(
    "the longest wait leads, whatever kind it is",
    humanRequests(matrix[4]!).map((request) => request.kind),
    ["elicitation", "permission"],
  );
  check("and a row draws one string without branching on the kind", humanRequests(matrix[4]!)[0]?.title, "Which?");

  /* ---- E: the transcript ---- */

  const resolvedOf = (over: Record<string, unknown>): any => ({
    type: "elicitation_resolved",
    elicitationId: "e1",
    toolCallId: null,
    message: "Which?",
    action: "accept",
    answers: null,
    by: "client",
    ...over,
  });

  check(
    "the three verbs",
    [
      elicitationOutcome(resolvedOf({ action: "accept" })).verb,
      elicitationOutcome(resolvedOf({ action: "decline" })).verb,
      elicitationOutcome(resolvedOf({ action: "cancel" })).verb,
    ],
    // `skipped` is the adapter's own word, so the row and the model say the same
    // thing about what happened.
    ["answered", "skipped", "cancelled"],
  );
  /*
   * ⚠ **Two assertions stood here on a `summary` field nothing rendered.** It
   * joined the answers and cut them at 160 characters; `ElicitationResolvedRow`
   * draws `event.answers` itself and always did, so the only readers of that clip
   * were these two checks — which pinned it in place rather than revealing it. The
   * field is gone, and what replaces the coverage is `answeredQuestions` below,
   * which is about a string somebody actually sees.
   */
  check(
    "an outcome says what happened and nothing about the answers",
    Object.keys(elicitationOutcome(resolvedOf({ answers: [{ key: "q", label: "Framework", value: "React" }] }))).sort(),
    ["tone", "verb"],
  );

  /* ---- the questions behind a settled form's answers ---- */

  /*
   * ⚠ **The defect: a settled `AskUserQuestion` kept the answers and lost the
   * questions.** `ElicitationResolvedEvent` carries `message` plus `{key, label,
   * value}` per answer, and for a multi-question form the adapter puts a preamble
   * in `message` and each real question in its field's *description*, which the
   * resolution does not carry. Measured on this machine's own log, session
   * `s_5d26f98e`: the transcript read *"Please answer the following questions."*
   * over four bare values, and the four questions appeared nowhere at all.
   *
   * `answeredQuestions` recovers them from the one place a client can reach — the
   * arguments of the tool call the question was asked through, which `askedThrough`
   * merges away — and matches **by identity on the chosen label**, never by parsing
   * `question_0` / `<question>__other`, which are two adapters' spellings of the
   * same idea.
   */
  {
    const { answeredQuestions } = await import("../src/ui/tail.js");
    const input = {
      questions: [
        {
          question: "Which database should this use?",
          options: [
            { label: "Use SQLite", description: "One file, no server." },
            { label: "Use Postgres with a connection pool", description: null },
          ],
        },
        {
          question: "How long should a session live?",
          options: [{ label: "5m" }, { label: "An hour, so a laptop lid does not end it" }],
        },
      ],
    };
    const answers = [
      { key: "question_0", label: "Database", value: "Use Postgres with a connection pool" },
      { key: "question_1", label: "TTL", value: "5m" },
    ];
    check(
      "each answer is drawn under the question it answered",
      answeredQuestions(answers as never, input)?.map((a: { question: string | null }) => a.question),
      ["Which database should this use?", "How long should a session live?"],
    );
    /*
     * The answer nothing matched: claude gives every question its own free-text
     * box, and what somebody types into one is by definition not an option. The
     * row falls back to the field's own title, which is the only honest label a
     * typed answer has — and the questions beside it are still real, so a partial
     * match is kept rather than abandoning the whole join.
     */
    check(
      "an answer somebody typed keeps its place with no question over it",
      answeredQuestions(
        [...answers, { key: "question_1_custom", label: "Other", value: "Until I say otherwise" }] as never,
        input,
      )?.map((a: { question: string | null }) => a.question),
      ["Which database should this use?", "How long should a session live?", null],
    );
    /*
     * ⚠ **A label two questions share matches neither**, and this is the case that
     * makes the join safe rather than merely convenient. Attributing an answer to
     * the wrong question would draw a confident record of an exchange that did not
     * happen — worse than drawing no question at all, which is what a `null` here
     * falls back to.
     */
    const collides = {
      questions: [
        { question: "Ship it?", options: [{ label: "Yes" }, { label: "No" }] },
        { question: "Tag it?", options: [{ label: "Yes" }, { label: "Later" }] },
      ],
    };
    check(
      "an answer both questions offer is attributed to neither",
      answeredQuestions([{ key: "a", label: "Ship", value: "Yes" }] as never, collides),
      null,
    );
    check(
      "while an answer only one of them offers is still attributed",
      answeredQuestions([{ key: "a", label: "Tag", value: "Later" }] as never, collides)?.map(
        (a: { question: string | null }) => a.question,
      ),
      ["Tag it?"],
    );
    /*
     * The three ways this falls back to what the transcript drew before, all of
     * them reachable: a call outside the loaded window (`undefined`), the 8 KiB
     * truncation stand-in, and a question from an MCP server, which has no
     * `{questions: […]}` shape and never will. `null` means "draw what you drew
     * before", which is the direction `compatibility.md` requires an unknown value
     * to fail in.
     */
    check(
      "and nothing at all is drawn as it was before",
      [
        answeredQuestions(answers as never, undefined),
        answeredQuestions(answers as never, { truncated: true, bytes: 9000 }),
        answeredQuestions(answers as never, { schema: { type: "object" } }),
        answeredQuestions(answers as never, { questions: [{ question: "Unrelated", options: [{ label: "x" }] }] }),
      ],
      [null, null, null, null],
    );
  }

  /* ---- the tool call a question came through ---- */

  {
    const { buildTail } = await import("../src/ui/tail.js");
    const ev = (seq: number, event: unknown): any => ({ seq, ts: seq, event });
    const tail = buildTail(
      [
        ev(1, { type: "tool_call", toolCallId: "tc1", title: "Asking for your input", kind: "other", status: "completed", locations: [], rawInput: null }),
        ev(2, { type: "elicitation_request", elicitationId: "e1", toolCallId: "tc1", message: "Which?" }),
        ev(3, { type: "elicitation_resolved", elicitationId: "e1", toolCallId: "tc1", message: "Which?", action: "accept", answers: [{ key: "q", label: "Q", value: "A" }], by: "client" }),
      ],
      [],
      0,
    );
    // The card that carried the question is drawn by the question, never beside
    // it — joined on the id the agent supplied, never on the tool's name.
    check(
      "the tool call a question came through is not drawn twice",
      tail.rows.map((row: any) => row.kind),
      ["event"],
    );
    // An ordinary tool call is untouched, which is what makes the rule a join
    // rather than a filter on anything that looks like a question.
    const plain = buildTail(
      [ev(1, { type: "tool_call", toolCallId: "tc9", title: "Terminal", kind: "execute", status: "completed", locations: [], rawInput: null })],
      [],
      0,
    );
    check("and an ordinary tool call still is", plain.rows.map((row: any) => row.kind), ["tool"]);
  }

  /* ---- F: the 409 that is really a success ---- */

  const errorOf = (status: number, body: unknown, code = "http_409"): unknown =>
    new ApiError(status, code, "nope", null, body);
  check(
    "a 409 is success when it says the answer already landed",
    [
      answerAlreadyLanded(errorOf(409, { repeat: true }), "elicitation_expired"),
      answerAlreadyLanded(errorOf(409, { error: {} }, "elicitation_expired"), "elicitation_expired"),
      answerAlreadyLanded(errorOf(409, { error: {} }), "elicitation_expired"),
      answerAlreadyLanded(errorOf(500, { repeat: true }), "elicitation_expired"),
    ],
    [true, true, false, false],
  );
}

/* ------------------------------------------------------------------ *
 * Where a link in agent output is allowed to go
 * ------------------------------------------------------------------ */
{
  process.stdout.write("\nwhere a link in agent output is allowed to go\n");

  /*
   * The case this exists for, measured on a live session.
   *
   * codex finished with "Done: created the file about_me.txt with this text.", and
   * the filename came through as a markdown link. react-markdown passes a
   * relative href through **on purpose** — its `defaultUrlTransform` returns early
   * when there is no protocol — which is right for a document sitting beside the
   * files it links, and wrong here: this page is served by the control plane, so
   * the anchor pointed at `https://<control-plane>/about_me.txt`, the SPA fallback
   * answered it with `index.html`, and tapping a filename opened a second copy of
   * the app.
   */
  check("a bare filename is not a link", openableHref("about_me.txt"), null);
  check("nor a relative path", openableHref("./src/index.ts"), null);
  /*
   * **An absolute path is the one most likely to look safe**, because it is
   * absolute — and it is a path on the *agent's* machine, so against this origin
   * it is just another SPA route.
   */
  check("nor an absolute path, which is a path and not a URL", openableHref("/Users/u/reemoat_agents/about_me.txt"), null);
  check("nor a file:// URI, which no browser here will open", openableHref("file:///etc/passwd"), null);
  // A fragment has nothing to jump to in this transcript, and empty means "the
  // page you are on" — `href=""` navigates, which is why `null` is the answer
  // rather than a stripped attribute.
  check("nor a bare fragment", openableHref("#section"), null);
  check("nor an empty or absent one", [openableHref(""), openableHref("   "), openableHref(undefined)], [null, null, null]);

  // What is kept: the links an agent cites that a phone can actually open.
  check("but https survives", openableHref("https://example.com/a/b?c=1#d"), "https://example.com/a/b?c=1#d");
  check("and http", openableHref("http://example.com"), "http://example.com");
  check("and mailto, the one non-web scheme every device has", openableHref("mailto:x@example.com"), "mailto:x@example.com");
  // Parsed rather than prefix-matched, so case and padding cannot smuggle one
  // past — `new URL` is what decides what the browser would do.
  check("a scheme is read the way a browser reads it", openableHref("HtTpS://example.com/"), "HtTpS://example.com/");
  check("and surrounding whitespace does not hide one", openableHref("  https://example.com/  "), "https://example.com/");
  /*
   * Not an XSS fix, and saying so keeps somebody from deleting the real guard.
   * `javascript:` never reaches this function — react-markdown's own transform
   * empties it first — but this refuses it too, so the two do not have to be
   * reasoned about together.
   */
  check("a script scheme is refused here as well as upstream", [openableHref("javascript:alert(1)"), openableHref("data:text/html,<script>")], [null, null]);

  /*
   * ⚠ **`openableHref` guards the anchor and nothing guarded the image**, which
   * is the worse of the two: a link needs a tap and an `<img>` does not.
   *
   * `COMPONENTS` overrides `a` precisely because agent output is untrusted text
   * quoting an untrusted repository. It overrode no `img`, so `![](https://…)`
   * fell through to react-markdown's default `<img src>` — whose transform allows
   * `https:` — and the browser fetched a host the agent chose, on render, with no
   * interaction, from the origin holding `reemoat.credential`. Everything the
   * agent wanted to say went out in the query string. Prompt injection in a
   * README, an issue body or a fetched page is the whole delivery mechanism, and
   * there is no CSP anywhere in this app to catch it.
   *
   * Read off disk in the style of the `SessionBrowser.tsx` and `SignIn.tsx`
   * assertions, because what has to be true is a fact about the *component map*
   * — a pure function cannot be asked whether a key exists in an object literal
   * two files away, and the defect was precisely an absent key.
   */
  const markdown = readFileSync(new URL("../src/ui/Markdown.tsx", import.meta.url), "utf8");
  const componentMap = markdown.slice(markdown.indexOf("const COMPONENTS"), markdown.indexOf("\n};", markdown.indexOf("const COMPONENTS")));
  check("the markdown component map overrides img at all", /^\s{2,}img:/m.test(componentMap), true);
  /*
   * And does not hand the agent's URL back to the browser. Asserted as the
   * absence of an `src=` binding rather than the presence of a particular
   * rendering, so a future click-to-load affordance is free to arrive — what may
   * not arrive is anything the browser fetches without being asked.
   */
  const imgArm = componentMap.slice(componentMap.indexOf("img:"), componentMap.indexOf("blockquote:"));
  check("and never binds it to an src the browser would follow", /\bsrc=\{/.test(imgArm), false);
  // The anchor is still an anchor, so this cannot pass by the map having been
  // emptied — which is the failure mode a "does not contain" assertion invites.
  check("while the anchor is still drawn as one", /<a\s+href=\{target\}/.test(componentMap), true);
}

process.stdout.write("\na question says how many of its answers you may pick\n");
{
  /*
   * ⭐ **`chosen` said what had been picked and nothing said what picking meant.**
   *
   * A four-answer question where you tick three and one where the first tap
   * submits drew identically until you had tapped — by which point the difference
   * has already been made for you. `AskOption.mark` is that fact, drawn by
   * `ChoiceMark` as a box for a multi-select and a circle for a select.
   *
   * Read off disk, because the whole subject is a shape on a row and `webcheck`
   * has no DOM. Each sweep carries its own floor: a regex that matches nothing
   * passes silently, which is the failure mode of every source assertion here.
   */
  // Comment-stripped for the absence checks: both files argue in prose about the
  // role they deliberately do not claim, and a sweep that reads the argument as
  // the code would fail on the file that gets it right.
  const askCard = readFileSync(new URL("../src/ui/AskCard.tsx", import.meta.url), "utf8");
  const askCode = stripComments(askCard);
  const elicitation = readFileSync(new URL("../src/ui/ElicitationCard.tsx", import.meta.url), "utf8");
  const elicitationCode = stripComments(elicitation);

  check("the card knows how many an answer may be", /mark\?: "one" \| "many" \| null;/.test(askCard), true);
  /*
   * ⚠ **A square box, and `rounded-sm` was not one.** That token is `.375rem` — 6px
   * of radius on a 16px box — so against a circle of the same size the two read as
   * the same shape, which is the whole difference this indicator exists to draw.
   * Reported that way. The radius is spent all the way, and the filled states differ
   * by shape as well: a tick in the box, a dot in the circle.
   */
  check(
    "a box for several and a circle for one",
    /mark === "many" \? "rounded-none" : "rounded-full"/.test(askCard),
    true,
  );
  // Scoped to the indicator itself: `rounded-sm` is right elsewhere on this card
  // (the `+N` chip wears it), and a file-wide sweep would fail on that.
  const markBody = askCode.slice(askCode.indexOf("export function ChoiceMark"));
  check("the scan found the indicator", markBody.length > 200, true);
  check("and no radius creeps back onto the box", /rounded-sm/.test(markBody), false);
  check(
    "filled, one is a tick and the other a dot",
    [/<Icon as=\{Check\}/.test(askCard), /h-1\.5 w-1\.5 rounded-full bg-ink/.test(askCard)],
    [true, true],
  );
  /*
   * The slot is reserved rather than conditional — `ChoiceRow`'s idiom — so a row
   * does not move when it becomes the answer, and the fill is a `ring`, which is a
   * box-shadow and costs no layout. `CHOSEN`'s docblock is the argument: a signal
   * that reflows the row it is applied to is not a signal.
   */
  check("and it is a ring rather than a border, so nothing reflows", /ring-1 ring-inset \$\{chosen/.test(askCard), true);
  /*
   * ⚠ **The role is claimed only where a `<button>` keeps it.** `role="checkbox"`
   * promises Space and Enter, which a button does by itself; `role="radio"` would
   * promise arrow-key roving this card does not implement, and `web-shell.md`
   * records both popups that drew a widget role without keeping one. So a
   * single-choice row is `aria-pressed`, the idiom `ChoiceRow` already uses.
   */
  check(
    "a multi-select row claims checkbox, a select row claims nothing it cannot keep",
    [/role=\{option\.mark === "many" \? "checkbox" : undefined\}/.test(askCode), /role="radio"/.test(askCode)],
    [true, false],
  );
  check(
    "and says the state either way",
    [/aria-checked=\{option\.mark === "many"/.test(askCard), /aria-pressed=\{option\.mark === "one"/.test(askCard)],
    [true, true],
  );
  /*
   * **Absent draws nothing, which is every permission.** ACP hands back exactly
   * one `optionId` and a tap dispatches it, so there is no pending selection an
   * indicator could be about — a circle there would promise a choice the tap is
   * not going to leave you room to make.
   */
  const permissionCard = readFileSync(new URL("../src/ui/PermissionCard.tsx", import.meta.url), "utf8");
  check("a permission's options carry no mark at all", /\bmark:/.test(permissionCard), false);
  /*
   * **Both halves of one form draw the same shape.** The card's numbered rows hold
   * only the step's *leader*; a form with two selects in a row draws the second by
   * hand, and that second copy is exactly where one form comes to draw two idioms.
   */
  check("the leader's rows say which kind they are", /mark: multi \? "many" : "one",/.test(elicitation), true);
  /*
   * ⭐ **The box you type your own answer into is one of the answers.**
   *
   * The adapter puts an optional free-text field after every `AskUserQuestion` —
   * its own "Other" — and it was drawn as a labelled input *under* the list, which
   * reads as a different kind of thing from the rows it sits with. On a
   * multi-select, typing your own answer is picking one. Reported that way.
   *
   * Asserted as **one treatment rather than two that match**: the row goes through
   * `askRowTone`, the same function the option rows use, so `CHOSEN`'s three
   * signals are stated once. A class list here that happened to spell the same
   * thing is the failure this is guarding.
   */
  check("the typed answer is painted by the rows' own function", /askRowTone\(counted\)/.test(elicitationCode), true);
  check("and the option rows go through it too", /askRowTone\(option\.chosen === true\)/.test(askCode), true);
  check("it carries the step's own mark", /<ChoiceMark mark=\{mark\} chosen=\{counted\} \/>/.test(elicitationCode), true);
  /*
   * ⚠ **Picked here means *counted*, never "the box has text in it".** A suppressed
   * or switched-off answer keeps every character somebody typed and loses only its
   * mark, so the row must read the body rather than the draft — asserted as the
   * absence of the value test it used to make.
   */
  check("and it reads the body rather than the box", /chosen=\{typeof value === "string"/.test(elicitationCode), false);
  check("the mark comes from one rule", /mark=\{answerMark\(form, field\)\}/.test(elicitationCode), true);
  check("and a field on a form still draws as a field", /min-h-11 w-full rounded-md border border-edge bg-raised/.test(elicitationCode), true);
  /*
   * ⚠ **The mark says "there is an answer in here" and deliberately not "this one
   * wins".** Measured on claude-agent-acp 0.73.0: `applyAskElicitationResponse`
   * takes a non-empty custom answer *instead of* the selection, on a multi-select
   * as well as a single one. Modelling that would mean knowing this field is a
   * custom-answer box, and the only two ways to know are the key suffix — which
   * `acp-agents.md` forbids by name, codex spelling it `__other` where claude
   * spells it `_custom` — and `_meta`, which the daemon drops at ingest. So no
   * suffix is read here, and the assertion is that none is.
   */
  check("nothing keys on the custom field's name", /_custom|__other/.test(elicitationCode), false);
  /*
   * ⭐ **The mark is a control, asked for directly**: on a multi-select you must be
   * able to switch your own answer off from that square having already written it.
   *
   * ⚠ **Which is why the row is not a `<label>` any anymore.** It was one, so a tap
   * anywhere landed in the box — and a label forwards its activation to the field it
   * names, so a nested button would have focused the input instead of toggling.
   * Pinned as an absence, because the label is what a later reader restores to get
   * the row-wide tap back.
   */
  check("the mark is a button", /<button\n\s+type="button"\n\s+onClick=\{\(\) => onToggle\(!counted\)\}/.test(elicitationCode), true);
  check("and the row is no longer a label", /<label className=\{`tap flex min-h-11/.test(elicitationCode), false);
  check("it keeps the roles the option rows use", [
    /role=\{mark === "many" \? "checkbox" : undefined\}/.test(elicitationCode),
    /aria-pressed=\{mark === "one" \? counted : undefined\}/.test(elicitationCode),
  ], [true, true]);

  const { elicitationForm, elicitationAnswer, displacedBy, answerMark } = await import("../src/elicitation.js");
  const pendingOf = (message: string, fieldCount: number): any => ({
    elicitationId: "elic-1-abc",
    toolCallId: "tc_1",
    message,
    fieldCount,
    raisedAt: 1_000,
  });

  /*
   * ⭐ **Two answers to one question, of which the agent keeps one.**
   *
   * Measured on claude-agent-acp 0.73.0: `applyAskElicitationResponse` reads the
   * custom answer and returns — the selection is never looked at — for a
   * multi-select as well as a single one. Left alone the card drew both as picked
   * and sent both, which on a single-choice question is two filled circles.
   * Reported as *"I picked two options where two cannot be picked"*.
   *
   * The relation is the **agent's own** `alternativeTo`, projected out of `_meta`
   * by the daemon. It runs both ways, one hop, and it is deliberately **not**
   * derived from `steps` — that grouping is accepted precisely because it is
   * presentational, so clearing a value on it would let a wrong grouping destroy
   * an answer.
   */
  const pairFields: any[] = [
    {
      key: "question_0",
      kind: "string",
      title: "Store",
      description: null,
      required: false,
      options: [
        { value: "Postgres", label: "Postgres", description: null },
        { value: "MongoDB", label: "MongoDB", description: null },
      ],
      min: null,
      max: null,
      format: null,
      default: null,
      alternativeTo: null,
    },
    { key: "question_0_custom", kind: "string", title: "Other", description: null, required: false, options: null, min: null, max: null, format: null, default: null, alternativeTo: "question_0" },
  ];
  const pair = elicitationForm(pendingOf("Which store?", 2), pairFields);
  /*
   * ⭐ **Exactly one direction, and that is the correction.**
   *
   * It ran both ways for a release: picking an option emptied the box. Reported —
   * *"the user may tap by accident and then change their mind; they simply chose
   * another option, the field is not zeroed"* — and it is obviously right, a pick
   * being one tap to redo where a sentence is not.
   *
   * So writing your own answer clears the *selection*, which is how you switch to
   * it, and picking clears **nothing**. What keeps the card honest instead is
   * `elicitationAnswer`, which stops sending an alternative while the question it
   * answers holds a value — asserted below on the body rather than on the draft.
   */
  check("typing your own answer displaces the selection", displacedBy(pair, "question_0_custom"), ["question_0"]);
  check("and picking one displaces nothing", displacedBy(pair, "question_0"), []);
  check("it is one hop, never a walk", displacedBy(pair, "question_0_custom").flatMap((k) => displacedBy(pair, k)), []);
  /*
   * ⭐ **The text survives every one of those, which is the whole point.** Driven
   * over the sequence that was reported: write your own answer, then pick an option.
   * The box still holds every character; only the mark moves.
   */
  const kept: Record<string, unknown> = {};
  kept["question_0_custom"] = "мой ответ";
  kept["question_0"] = "Postgres";
  check("a pick takes the answer without taking the text", [
    kept["question_0_custom"],
    Object.keys(elicitationAnswer(pair, kept as never).content).sort(),
  ], ["мой ответ", ["question_0"]]);
  check("and releasing the pick gives the answer back", [
    kept["question_0_custom"],
    Object.keys(elicitationAnswer(pair, { ...kept, question_0: "" } as never).content).sort(),
  ], ["мой ответ", ["question_0_custom"]]);
  /*
   * ⭐ **And the square switches it off by hand, text intact.** `excluded` is
   * `ask.ts`'s, passed in rather than derived, because there is no spelling of
   * "present but not an answer" in a `DraftValue`.
   */
  check("switching it off keeps the text and drops the answer", [
    Object.keys(elicitationAnswer(pair, { question_0_custom: "мой ответ" } as never, new Set(["question_0_custom"])).content),
    Object.keys(elicitationAnswer(pair, { question_0_custom: "мой ответ" } as never).content),
  ], [[], ["question_0_custom"]]);
  /*
   * ⚠ **The same pair with nothing declared behaves the same**, and that is the
   * correction: an earlier version gated both the mark and the displacement on
   * `alternativeTo`, so against any daemon that did not yet send it the free-text
   * box lost its indicator altogether — which is every daemon until its owner
   * restarts one. The declaration makes the pairing *exact*; the step already makes
   * it **known**, and `groupIntoSteps` grouping these two is precisely the
   * presentational reading `ElicitationForm.steps` is licensed for.
   */
  const undeclared = elicitationForm(pendingOf("Which store?", 2), [
    { ...pairFields[0] },
    { ...pairFields[1], key: "question_0__other", alternativeTo: null },
  ] as never);
  check("an undeclared pair displaces the same way", [
    displacedBy(undeclared, "question_0"),
    displacedBy(undeclared, "question_0__other"),
  ], [[], ["question_0"]]);
  /*
   * The mark's *shape* comes from the question and never from the box, and it is
   * drawn whether or not anything was declared — a layout may not wait on a wire
   * field.
   */
  check(
    "the box wears the question's own mark, declared or not",
    [
      answerMark(pair, pair.fields[1]!),
      answerMark(undeclared, undeclared.fields[1]!),
      answerMark(pair, pair.fields[0]!),
    ],
    ["one", "one", null],
  );
  /*
   * ⭐ **And several answers stay several.** A multi-select is what "more than one"
   * means, so nothing displaces there — deliberately disagreeing with both adapters,
   * which use the typed text *instead of* the selection. Somebody who ticked two
   * boxes and then wrote a third answer meant three, and taking their ticks away to
   * match the adapter would be this card editing an answer they gave.
   */
  const multiPair = elicitationForm(pendingOf("Which stores?", 2), [
    { ...pairFields[0], kind: "multi_select" },
    { ...pairFields[1] },
  ] as never);
  check("a multi-select's box is a box", answerMark(multiPair, multiPair.fields[1]!), "many");
  check("and nothing displaces anything on one", [
    displacedBy(multiPair, "question_0"),
    displacedBy(multiPair, "question_0_custom"),
  ], [[], []]);
  /*
   * A multi-select suppresses nothing either — several is what it means — so ticks
   * and a typed answer are all sent, and the square is the only way to drop one.
   */
  const both = { question_0: ["Postgres"], question_0_custom: "мой ответ" };
  check("ticks and a typed answer are all sent", Object.keys(elicitationAnswer(multiPair, both as never).content).sort(), ["question_0", "question_0_custom"]);
  check("until the square switches one off", Object.keys(elicitationAnswer(multiPair, both as never, new Set(["question_0_custom"])).content), ["question_0"]);
  // The card writes through it, both ways, and only for a value — clearing must not
  // cascade, or emptying the box would take the selection with it a second time.
  check("the card writes through the rule", /for \(const other of displacedBy\(form, field\)\) set\(other, ""\);/.test(elicitationCode), true);
  check("and a cleared value displaces nothing", /if \(empty\) return;/.test(elicitationCode), true);
  check("and the hand-rolled rows draw the same component", /<ChoiceMark mark=\{multi \? "many" : "one"\}/.test(elicitation), true);
  check(
    "with the same roles on the same terms",
    [/role=\{multi \? "checkbox" : undefined\}/.test(elicitationCode), /role="radio"/.test(elicitationCode)],
    [true, false],
  );
}
