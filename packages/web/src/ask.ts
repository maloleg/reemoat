/**
 * What the ask card is holding that nothing else needs to know about.
 *
 * A module `Map` with its own subscribers, exactly as `attach.ts` holds files
 * staged for a message, and for the same two reasons stated there.
 *
 * **Not `useState`**: the phone's list → detail → back unmounts `SessionView`,
 * and a four-question form lost that way has nothing to retype from — the
 * questions are the agent's, not yours, so you cannot reconstruct what you were
 * halfway through answering. A card you deliberately collapsed springing open
 * again every time you come back is the same loss of place, one control over.
 *
 * **Not the store**: a keystroke must not wake the session list. `store.emit()`
 * notifies every subscriber including `SessionBrowser`, which is the cost
 * `Composer` already refuses to pay for its own draft text.
 *
 * At `src/` rather than `src/ui/` because `store.ts` imports it — `forgetSession`
 * is where per-session state dies, and an edge from `store.ts` into `ui/` would
 * be a new and wrong direction.
 *
 * **Keyed by `(session, ask)` and not by session alone.** Two requests can be
 * parked at once and the card draws whichever has waited longest, so a
 * session-keyed draft would be typed into one form and read back out of the
 * other — silently, and only when an agent asked twice.
 *
 * **This file used to be `elicitationDraft.ts` and the rename is the point.**
 * `collapsed` is keyed by an *ask* id, of either kind: `perm-N-salt` and
 * `elic-N-salt` come from one counter on the daemon, and from here a permission
 * and a question are one fact — the agent is waiting on you. A second collapse
 * map beside this one would be a second decision about what "put this away"
 * means, which is exactly the nine-call-sites problem `humanRequests` already
 * solved one layer up. What stays elicitation-shaped is the draft and the step,
 * because only a form has either.
 */

import type { SessionKey } from "./ids";
import type { DraftValue, ElicitationDraft } from "./elicitation";

const drafts = new Map<string, Record<string, DraftValue>>();
const listeners = new Set<() => void>();
let version = 0;

const EMPTY: ElicitationDraft = Object.freeze({});

function keyFor(session: SessionKey, askId: string): string {
  return `${session}/${askId}`;
}

function changed(): void {
  version += 1;
  // Guarded and evicting, the same way `SessionLog.append` fans out: one broken
  // subscriber must not stop the rest from hearing about a keystroke.
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      listeners.delete(listener);
    }
  }
}

export function draftFor(session: SessionKey, elicitationId: string): ElicitationDraft {
  return drafts.get(keyFor(session, elicitationId)) ?? EMPTY;
}

export function setDraftField(
  session: SessionKey,
  elicitationId: string,
  field: string,
  value: DraftValue,
): void {
  const key = keyFor(session, elicitationId);
  const current = drafts.get(key) ?? {};
  drafts.set(key, { ...current, [field]: value });
  changed();
}

/**
 * Everything held for one request, once it has been answered one way or another.
 *
 * **Three statements and not one `||` chain**, which is what this was and which
 * did not do what its own first line says. `a.delete(k) || b.delete(k)` stops at
 * the first `true`, so any elicitation that had a draft dropped the draft and
 * leaked its step index and its collapsed flag — visible when a poll already in
 * flight re-applies a snapshot that still lists the request, and the card comes
 * back folded shut on question three. Permissions escaped it only by accident,
 * having neither a draft nor a step.
 */
export function dropAsk(session: SessionKey, askId: string): void {
  const key = keyFor(session, askId);
  const hadDraft = drafts.delete(key);
  const hadStep = steps.delete(key);
  const hadCollapse = collapsed.delete(key);
  // Four statements and not an `||` chain, for the reason above: `a.delete(k) ||
  // b.delete(k)` stops at the first `true`.
  let hadExcluded = false;
  for (const entry of [...excluded]) {
    if (entry.startsWith(`${key}/`)) {
      excluded.delete(entry);
      hadExcluded = true;
    }
  }
  if (hadDraft || hadStep || hadCollapse || hadExcluded) changed();
}

/**
 * Everything for a session that is going away.
 *
 * Called from `store.forgetSession`, beside `forgetAttachments`. A draft for a
 * question the *agent* withdrew is the one residue left behind — a small object
 * that dies with the session, stated here rather than swept.
 */
export function forgetAsks(session: SessionKey): void {
  let removed = false;
  const mine = (key: string): boolean => key.startsWith(`${session}/`);
  for (const key of [...drafts.keys()]) {
    if (mine(key)) {
      drafts.delete(key);
      removed = true;
    }
  }
  for (const key of [...steps.keys()]) if (mine(key)) steps.delete(key);
  for (const key of [...collapsed]) if (mine(key)) collapsed.delete(key);
  for (const key of [...excluded]) if (mine(key)) excluded.delete(key);
  if (removed) changed();
}

/**
 * Which question is on screen, and whether the card is showing at all.
 *
 * Beside the draft rather than in the card, for the identical reason: the phone's
 * list → detail → back unmounts `SessionView`, and stepping back to question one
 * — or having a card you deliberately put away come back by itself — is the same
 * loss of place the draft exists to prevent.
 */
const steps = new Map<string, number>();
const collapsed = new Set<string>();

/**
 * Answers somebody has switched **off** without deleting, keyed `session/ask/field`.
 *
 * ⚠ **The whole reason this exists is that nothing typed may be erased.** A
 * question's free-text box is one of its answers, so it needs a way to stop being
 * one — and the obvious implementations both destroy: emptying the box, or leaving
 * it out of the draft. *"The user may tap by accident and then change their mind;
 * they simply chose another option, the field is not zeroed."*
 *
 * So the text stays in the draft, where it is what the box shows, and this says
 * whether it counts. `elicitationAnswer` reads it and omits the field from the
 * body; the row keeps its content and loses its mark.
 *
 * Beside the draft rather than in it, because `DraftValue` is what the *control*
 * holds and there is no spelling of "present but not an answer" in a string. Keyed
 * per field for the same reason the draft is: a form can have several.
 */
const excluded = new Set<string>();

export function stepFor(session: SessionKey, elicitationId: string): number {
  return steps.get(keyFor(session, elicitationId)) ?? 0;
}

export function setStep(session: SessionKey, elicitationId: string, index: number): void {
  steps.set(keyFor(session, elicitationId), Math.max(0, index));
  changed();
}

/** Whether this particular request is collapsed to its one-line bar. */
export function isCollapsed(session: SessionKey, askId: string): boolean {
  return collapsed.has(keyFor(session, askId));
}

/**
 * Fold the card away, or bring it back.
 *
 * Collapsing answers nothing — the session stays blocked and the agent stays
 * parked, which is the honest thing for a control that only moves a card. What it
 * buys is reading the conversation the request is *about*, which is exactly what
 * you need before answering it, and which the card would otherwise be sitting on
 * top of.
 *
 * Keyed per request rather than per session, so the next thing the agent asks
 * arrives open. "I have read this one" is not a preference about being asked.
 */
export function setCollapsed(session: SessionKey, askId: string, next: boolean): void {
  const key = keyFor(session, askId);
  if (next) collapsed.add(key);
  else collapsed.delete(key);
  changed();
}

/**
 * The answers this request has switched off, as the set `elicitationAnswer` takes.
 *
 * A fresh `Set` per call would defeat the `useMemo` on the answer, which runs on
 * every keystroke — so an empty request answers one frozen instance.
 */
export function excludedFor(session: SessionKey, askId: string): ReadonlySet<string> {
  const prefix = `${keyFor(session, askId)}/`;
  const out = new Set<string>();
  for (const entry of excluded) if (entry.startsWith(prefix)) out.add(entry.slice(prefix.length));
  return out.size === 0 ? NO_EXCLUSIONS : out;
}

const NO_EXCLUSIONS: ReadonlySet<string> = Object.freeze(new Set<string>());

/** Switch one answer off, or back on. The value it holds is never touched. */
export function setExcluded(session: SessionKey, askId: string, field: string, off: boolean): void {
  const entry = `${keyFor(session, askId)}/${field}`;
  if (off) excluded.add(entry);
  else excluded.delete(entry);
  changed();
}

export function subscribeAsks(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function asksVersion(): number {
  return version;
}
