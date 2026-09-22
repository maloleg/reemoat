import type { SessionKey } from "./ids";

/**
 * Which finished background rows a reader has said they are done with.
 *
 * **`echo.ts`'s shape, and the fourth of `attach.ts`'s** — a module `Map` keyed by
 * session with subscribers, at `src/` rather than under `ui/` because `store.ts`
 * has to clear it and may not import from `ui/`.
 *
 * ⚠ **This hides rows; it destroys nothing on the machine.** There is exactly one
 * background-task route in the daemon — stopping one — and no forget, no delete,
 * no clear. The daemon keeps every terminal row by decision, so that the panel can
 * answer *did that build finish*; `evictFinishedTask` gives the oldest of them up
 * only when a 33rd task needs the room. Another tab still sees everything, and so
 * does this one after a reload. What this records is a reader saying *I have read
 * these*: per session, in this tab, for this sitting.
 *
 * ⚠ **In memory rather than `localStorage`, which is the opposite call from
 * `groups.ts`'s collapse set and `rail.ts`'s width, and the same call `echo.ts`
 * made.** Those persist a *preference about this client*. This is a *claim about
 * rows on a remote machine*, and three separate things destroy those with nothing
 * to tell the browser: a daemon restart (`asyncTasks` is a `Map` with nothing in
 * SQLite), the agent's own `/clear`, and eviction at the cap. A persisted set
 * would outlive every one of them and go on hiding ids that will never be seen
 * again, while a freshly spawned row that happened to reuse an id would be born
 * hidden.
 */

/** One shared empty set, so an untouched session's snapshot is reference-stable. */
const NONE: ReadonlySet<string> = new Set();
const hidden = new Map<SessionKey, ReadonlySet<string>>();
const listeners = new Set<() => void>();

/**
 * Bumped on every change, and it is what `useSyncExternalStore` subscribes to.
 *
 * The *set* cannot be the snapshot: `hiddenFinished` would have to return a fresh
 * object for a session nobody has touched, and `useSyncExternalStore` compares by
 * `Object.is` and would loop. A counter beside `NONE` is `groups.ts`'s own answer
 * to the same shape.
 */
let version = 0;

function announce(): void {
  version += 1;
  for (const listener of [...listeners]) listener();
}

export function hiddenFinished(key: SessionKey): ReadonlySet<string> {
  return hidden.get(key) ?? NONE;
}

export function hiddenFinishedVersion(): number {
  return version;
}

export function subscribeHiddenFinished(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/**
 * Hide every finished row this session is carrying **at this instant**.
 *
 * ⚠ **The write replaces rather than unions, and that is the prune.** Unioned, the
 * set would grow for ever with ids the wire can never match again — and worse, an
 * agent-chosen id that was evicted and later reused would be born already hidden
 * the moment it finished. Stored as exactly what is finished now, the set is
 * always a subset of what the wire holds, bounded by the daemon's own cap, and
 * still the union of everything ever cleared: a row cleared an hour ago is
 * finished now too, so it is in the new set as well.
 *
 * The caller passes the ids rather than this module reading them, because the
 * panel already holds the list and `background` is a fresh array off every
 * snapshot — closing over it would rebuild the callback on every poll for nothing.
 */
export function hideFinished(key: SessionKey, ids: readonly string[]): void {
  if (ids.length === 0) return;
  hidden.set(key, new Set(ids));
  announce();
}

/**
 * A session that is gone. `store.ts` calls this beside `clearEcho`, which is where
 * `forgetSession`'s own docblock says anything added per session belongs.
 */
export function forgetHiddenFinished(key: SessionKey): void {
  if (!hidden.delete(key)) return;
  announce();
}
