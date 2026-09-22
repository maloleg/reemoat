/**
 * What two long-running child processes have in common: a bounded transcript a
 * client reads through a cursor.
 *
 * ⚠ **This file exists because a *copy* of the function below is undetectable
 * drift, and that has already happened once here.** `daemoncheck` used to define
 * its own three-line `read` closure and assert *that*, under a comment about a
 * login transcript being "exactly where a lost line is the one with the code in
 * it" — identical to the real one, which is precisely what made the section stay
 * green over a deleted implementation. Exporting it fixed that for the login run;
 * a second copy for the install run would commit the same defect knowingly.
 *
 * ⚠ **What is deliberately *not* here is the buffer.** `LoginRun` and
 * `InstallRun` each keep their own `buffer`/`droppedBytes` and their own append,
 * five lines apiece. The ordering around that append is a measured defect — the
 * cap must run after every mutation, carry included, and the flushed carry goes
 * after the body text rather than before — and a login transcript has a pty, a
 * carry and a `scrub` that an install transcript has none of. Sharing a class to
 * save five lines would put that measurement in front of a second caller it was
 * never taken against.
 */

/** Where a cursor lands, and whether it missed anything. */
export interface TranscriptRead {
  /** Output from the requested cursor onwards. Empty when there is nothing new. */
  chunk: string;
  /** True when the requested cursor pointed at output that has been discarded. */
  gap: boolean;
}

/**
 * Where a client's cursor lands in a transcript that may have lost its front.
 *
 * `since` below `dropped` is a gap, not an error: the caller asked for output
 * that has been discarded, and the honest answer is the oldest that survives plus
 * a flag saying something is missing.
 */
export function readFrom(buffer: string, dropped: number, since: number): TranscriptRead {
  const from = Math.max(since, dropped);
  return { chunk: buffer.slice(from - dropped), gap: since < dropped };
}
