import type { AgentConfig, AgentConfigOption } from "./wire";
import type { SessionKey } from "./ids";

/**
 * What the agent's controls were set to, kept across a reload of this tab.
 *
 * **The fourth module of this shape and the first that touches storage.**
 * `attach.ts`, `choices.ts` and `echo.ts` are module state with subscribers,
 * living in `src/` rather than `ui/` because `store.ts` imports them; this is the
 * same arrangement for the same reason. What it deliberately is **not** is a field
 * on the store: `store.ts` writes to no storage at all — grep it — and that is a
 * property worth keeping, since everything in it is either on the wire or derived
 * from something that is. This is neither.
 *
 * ## What it is for
 *
 * `holdConfig` keeps the last set a *running* agent published, so the strip stays
 * the same shape while an agent is away — and it keeps it in `rows`, in memory. A
 * reload empties that, the daemon deliberately restores no `agentConfig` from disk,
 * and the strip falls to three placeholders reading `—` on a session whose values
 * were on screen a second earlier. That is the whole of what this fixes: **F5 stops
 * costing you what the tab already knew.**
 *
 * ⚠ **It does not put the settings back on the agent.** A daemon restart still
 * brings a session back on the agent's own defaults; this restores the *reading* of
 * what they were, dimmed and untappable, and nothing more. The two halves are
 * separate and only one of them is here.
 *
 * ## Why only the chosen choice is kept
 *
 * `chipValue` names a value through the *choice* that carries it, never through the
 * raw value — without one the model chip reads `openai/gpt-5` instead of `GPT-5`,
 * and for a model it also mines the choice's description to split `Opus 5 · Best
 * for…` into a name. So a memory of the value alone would restore the chip and get
 * it wrong.
 *
 * Keeping the whole option is not available either: opencode publishes **362**
 * models on one control, and a few hundred sessions of that is megabytes into a
 * budget shared with the credential. So each option keeps exactly the choice that
 * is selected, which is all a stale chip can draw — its menu is untappable by
 * construction, so there is nothing else to draw.
 *
 * ⚠ **Nothing read back from here is ever sent.** `drawnControls` answers
 * `stale: true` for a memory and `Select` is `disabled` under it, so a value that
 * has gone out of date since it was written cannot be posted to an agent that would
 * refuse it. That is what makes storing a possibly-stale value safe at all, and it
 * is the same argument the daemon makes for refusing to store one it *would* send.
 */
const STORAGE_KEY = "reemoat.configMemory";

/**
 * How many sessions are remembered, most recently seen first.
 *
 * The rail draws **60 sessions per machine per poll**, so this is two machines'
 * worth of a full list — enough that moving between the machines somebody actually
 * works on never loses a chip, and far short of a fleet's whole history.
 *
 * It is a count rather than a byte budget because the entries are uniform: three
 * or four controls, one choice each. A budget would need measuring on every write
 * to answer the same question this answers by construction.
 */
const MAX_REMEMBERED = 120;

/** One control, reduced to what a dimmed chip needs to draw itself. */
interface RememberedOption {
  readonly id: string;
  readonly name: string;
  readonly category: string | null;
  readonly kind: AgentConfigOption["kind"];
  readonly value: string | boolean;
  /** The selected one, or empty where the value matches nothing published. */
  readonly choices: AgentConfigOption["choices"];
}

interface Remembered {
  readonly at: number;
  readonly modes: AgentConfig["modes"];
  readonly options: readonly RememberedOption[];
}

/**
 * The reduction, and it is a pure function so `webcheck` can hold it to the two
 * properties that matter: the selected choice survives, and nothing else does.
 */
export function reduceConfig(config: AgentConfig): Remembered {
  return {
    at: Date.now(),
    /*
     * Modes keep only the current one in `available`. `restoreConfig` is the
     * daemon's business and never reads this; what draws from it is the mode
     * chip, which names `current` and nothing else.
     */
    modes:
      config.modes === null
        ? null
        : {
            current: config.modes.current,
            available: config.modes.available.filter((one) => one.id === config.modes?.current),
          },
    options: config.options.map((option) => ({
      id: option.id,
      name: option.name,
      category: option.category ?? null,
      kind: option.kind,
      value: option.value,
      choices: option.choices.filter((choice) => choice.value === option.value),
    })),
  };
}

/** Back to the shape the strip reads. Lossy by design — see the docblock. */
export function expandConfig(held: Remembered): AgentConfig {
  return {
    modes: held.modes,
    options: held.options.map((option) => ({
      id: option.id,
      name: option.name,
      description: null,
      category: option.category,
      kind: option.kind,
      value: option.value,
      choices: option.choices,
    })) as AgentConfig["options"],
  };
}

type Stored = Record<string, Remembered>;

/**
 * How long a live session's `at` may drift before it is worth a write.
 *
 * The LRU wants "recently seen" and every poll touches every live session, so
 * refreshing the file on each one would write four times a minute per session to
 * move a number nothing reads until the file is full. In memory `at` moves every
 * touch; on disk it moves at most once a minute, which is a minute of error in a
 * bound of 120 entries.
 */
const AT_REFRESH_MS = 60_000;

/**
 * Is this a memory, or is it something else that happens to be in that key?
 *
 * ⚠ **Per entry, and the sentence that used to be here claimed it without doing
 * it.** The guard was `typeof parsed === "object"` on the *container* alone, with
 * a comment reading *"this is a value a person can edit and a previous build may
 * have written. Anything that is not the shape is not a memory"* — and then
 * `return parsed as Stored`. So `{"m|s": 42}` parsed clean, `expandConfig` did
 * `held.options.map(...)` on `undefined`, and the `TypeError` came out **outside**
 * this function's `catch`. Measured, all four shapes: a number, a string, an entry
 * with no `options`, and an `options` that is not an array.
 *
 * Where it lands is what made it permanent rather than ugly. `rememberedConfig`
 * is called from `store.ts`'s per-session loop, which is not a render — so
 * `RootErrorBoundary` never sees it — and the throw aborts the loop before the
 * rows are committed. Nothing rewrites the key, so the same bad entry is read
 * again on the next poll, and that machine's session list never updates again.
 *
 * Structural only: a `value` this build cannot use still draws a chip that says
 * so, and `stale` already forbids sending it. What is refused is the shape that
 * would throw.
 */
function isRemembered(value: unknown): value is Remembered {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  if (typeof entry["at"] !== "number") return false;
  const modes = entry["modes"];
  if (modes !== null) {
    if (typeof modes !== "object" || modes === null) return false;
    if (!Array.isArray((modes as Record<string, unknown>)["available"])) return false;
  }
  const options = entry["options"];
  if (!Array.isArray(options)) return false;
  return options.every((option) => {
    if (typeof option !== "object" || option === null) return false;
    const one = option as Record<string, unknown>;
    return typeof one["id"] === "string" && typeof one["kind"] === "string" && Array.isArray(one["choices"]);
  });
}

/**
 * The parsed file, held for the life of the tab.
 *
 * ⚠ **A cache because the call site is a loop inside a poll, not because parsing
 * is slow.** `rememberHeld` runs once per session row; `store.ts` lists **60** per
 * machine and repeats that every `POLL_INTERVAL_MS`. Read straight through, that
 * was 60 `getItem` + `JSON.parse` of the whole file per machine per poll, and —
 * because `GET /sessions` really does carry `agentConfig` — 60 `JSON.stringify` +
 * `setItem` of the whole file with them. Measured on a full 120-entry file
 * (119,281 bytes): 14.4 ms of parse and 9.3 ms of stringify per machine per poll
 * on desktop V8, before the syscalls, and roughly 7.2 MB handed to `setItem`. On a
 * phone that is the main thread gone for a tenth of every four seconds.
 *
 * `null` until the first call rather than at module scope: `webcheck` imports this
 * file to drive the pure functions and stubs `window` lazily, and a module-scope
 * read would make importing it a side effect.
 */
let cache: Stored | null = null;
/** Set by a write that has not reached storage yet. See `flush`. */
let dirty = false;
/** Whether the `pagehide` backstop below has been attached. */
let backstopped = false;

function read(): Stored {
  if (cache !== null) return cache;
  cache = load();
  return cache;
}

function load(): Stored {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const out: Stored = {};
    // Per entry. A neighbour being unreadable is not a reason to forget the rest,
    // and one that is unreadable is dropped here rather than thrown over later.
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (isRemembered(value)) out[key] = value;
    }
    return out;
  } catch {
    // Private mode, a quota, a hand-edited value, or JSON from a build that
    // shaped this differently. A forgotten chip is not worth failing a render.
    return {};
  }
}

/**
 * One write per turn of the event loop, not one per session row.
 *
 * `queueMicrotask` rather than a timer: the whole poll loop is synchronous
 * between awaits, so every row it touches is marked before this runs and the
 * file is written once. A timer would do the same thing later and add a window
 * in which a reload loses what the tab already knew.
 *
 * `pagehide` is the backstop for the one case a microtask cannot cover — the
 * document going away between a mark and the flush — and is attached on first
 * use rather than at module scope, for `cache`'s reason.
 */
function markDirty(): void {
  if (dirty) return;
  dirty = true;
  queueMicrotask(flush);
  if (!backstopped && typeof window.addEventListener === "function") {
    backstopped = true;
    window.addEventListener("pagehide", flush);
  }
}

function flush(): void {
  if (!dirty || cache === null) return;
  dirty = false;
  cache = prune(cache);
  write(cache);
}

function write(next: Stored): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Same reasoning as `load`. The in-memory `rows` copy still works for this
    // session, which is every state this module improves on.
  }
}

/**
 * What a chip actually draws, as one string, so an unchanged poll costs nothing.
 *
 * Every poll of a live session hands this module the same values, and writing
 * them back differs only in `at`. Comparing the signature is O(controls) — three
 * or four of them — against a `JSON.stringify` of the whole file.
 */
function signatureOf(config: AgentConfig): string {
  const modes = config.modes === null ? "" : config.modes.current;
  return `${modes}\u0000${config.options.map((option) => `${option.id}=${String(option.value)}`).join("\u0001")}`;
}

const signatures = new Map<string, string>();

/**
 * The bound, applied on write rather than on read.
 *
 * On read it would answer differently depending on how full storage is, which is
 * the kind of thing that makes a chip appear on one load and not the next. On
 * write the file is bounded and the answer is stable.
 */
export function prune(entries: Stored, keep: number = MAX_REMEMBERED): Stored {
  const keys = Object.keys(entries);
  if (keys.length <= keep) return entries;
  const newest = keys
    .sort((a, b) => (entries[b]?.at ?? 0) - (entries[a]?.at ?? 0))
    .slice(0, keep);
  const out: Stored = {};
  for (const key of newest) {
    const entry = entries[key];
    if (entry !== undefined) out[key] = entry;
  }
  return out;
}

/** What this tab last saw a running agent publish for a session, if anything. */
export function rememberedConfig(key: SessionKey): AgentConfig | undefined {
  const entry = read()[key];
  return entry === undefined ? undefined : expandConfig(entry);
}

/**
 * Record what a running agent published.
 *
 * ⚠ **Only a non-empty set, which is what makes this a memory rather than a
 * mirror.** The daemon empties `agentConfig` while an agent is away, and writing
 * that through would delete the memory at exactly the moment it becomes the only
 * copy — the same asymmetry `holdConfig` is built around one file over.
 */
export function rememberConfig(key: SessionKey, config: AgentConfig | undefined): void {
  if (config === undefined || config.options.length === 0) return;
  const entries = read();
  const now = Date.now();
  const signature = signatureOf(config);
  const held = entries[key];
  /*
   * Three ways this is already known, and only the first two are cheap to say.
   * An unchanged set on a session whose stored `at` is recent is the common case
   * by far — every poll of every live session — and it costs one string compare.
   */
  if (held !== undefined && signatures.get(key) === signature && now - held.at < AT_REFRESH_MS) {
    return;
  }
  signatures.set(key, signature);
  entries[key] = { ...reduceConfig(config), at: now };
  markDirty();
}

/** Everything, on sign-out. A credential leaving takes what it was reading with it. */
export function forgetAllConfig(): void {
  // Before the storage call, and both of them: the cache is what this tab reads
  // and a pending `flush` would otherwise put the file straight back.
  cache = {};
  dirty = false;
  signatures.clear();
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing was read and nothing can be.
  }
}
