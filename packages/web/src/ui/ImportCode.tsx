import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, Copy, FileArchive, Loader2 } from "lucide-react";

import { store } from "../store";
import { ApiError, errorText } from "../http";
import { MAX_IMPORT_BYTES } from "../wire";
import { IMPORT_SKILL } from "../importSkill";
import { displayCwd } from "../paths";
import type { MachineId } from "../ids";
import { Button, Icon, SHEET_FOOT, SHEET_SCROLL } from "./bits";
import { Sheet } from "./Sheet";
import { copyText } from "./clipboard";
import { toast } from "./Toast";

/**
 * Bringing a project from another machine onto this one.
 *
 * **The shape of the problem is that the code is somewhere else.** A picker can
 * only offer what is already on the daemon's disk, so the answer to "I want an
 * agent on my laptop's repository" was, until this screen, to ask an agent to
 * clone it — which needs a remote, a credential on that host, and a repository
 * that is pushed somewhere. None of those is true of the work somebody actually
 * wants help with at eleven at night.
 *
 * So the flow runs the other way round: an agent *on the machine the code is on*
 * packs it, and this screen takes the result. Step one is a copy button rather
 * than a download because what it copies both installs the skill and runs it —
 * see `importSkill.ts`.
 *
 * **A pop-up over a pop-up, on component state, where every other pop-up in this
 * app is a route.** Q7.69 is right that a URL buys a deep link, a surviving
 * reload and a free Back button, and it is right about `/settings` and `/new`.
 * It does not transfer here: `App` draws the overlay from the *live* route, so a
 * nested route would unmount `NewSession` and take the machine, agent and folder
 * somebody has already chosen with it. This is a step inside a form rather than
 * a destination, and there is nothing in it worth linking to — the archive is on
 * their disk, not in the URL.
 *
 * ⚠ **"Escape still does the right thing for free" was written here and was
 * false, and nothing asserted it.** The arbitration was never the problem:
 * `overlay.ts` did give the key to this layer, every time. The problem was what
 * this layer did with it — `Sheet`'s `close` was `navigate(under, true)`, and
 * `under` is the screen the **New session** overlay was drawn over, not this
 * sheet's own. So Escape, the ✕ and a tap on the scrim each destroyed the whole
 * flow and discarded the machine, the agent and the folder, which is precisely
 * what the paragraph above says a nested route would have cost and what not
 * having one was supposed to buy.
 *
 * It is bought now, by `onClose`: all three dismissals and the ◀ land on the form
 * behind this sheet, and `webcheck` reads the four props off this file so the
 * claim cannot go back to being prose. What is still genuinely lost is Android's
 * Back closing only this one — it pops `/new/…` and takes both down — and that
 * one remains the cost being accepted rather than an oversight. The asymmetry
 * between Back and Escape is deliberate now rather than accidental.
 */

type Phase =
  | { kind: "idle" }
  /** Bytes are moving. `fraction` is what the bar draws. */
  | { kind: "sending"; name: string; fraction: number }
  /**
   * Everything has been sent and the request has not answered.
   *
   * A state of its own rather than a full bar, because it is the one the daemon
   * spends the longest in on a large archive and a bar sitting at 100% reads as
   * hung. `machine.upload`'s stall timer is cleared by the same event that puts
   * us here, for exactly this reason.
   */
  | { kind: "unpacking"; name: string }
  | { kind: "failed"; message: string };

/**
 * What a refusal from `POST /fs/import` should say.
 *
 * Keyed on the code and never the status, like every other refusal this client
 * reads. The one that is not the daemon's own is the important one: a machine
 * whose daemon predates this route answers Hono's bare 404, with no envelope and
 * so no code — and since `DAEMON_VERSION` is a label nothing may branch on, that
 * shape *is* the feature detection. A new client against an old daemon is the
 * ordinary state of this fleet between one deploy and whenever somebody updates
 * their laptop, so it gets a sentence saying what to do rather than "404".
 */
export function importFailure(error: unknown): string {
  if (error instanceof ApiError) {
    /*
     * `http_404` rather than a code of this system's own is what `parseBody`
     * produces for a response carrying no error envelope — which is what a daemon
     * with no such route answers. It is the whole of the feature detection, and it
     * has to be: `DAEMON_VERSION` is a label and rule 1 of the compatibility rule
     * is that nothing branches on one.
     */
    if (error.code === `http_${error.status}` && error.status === 404) {
      return "This machine's daemon is too old to import code. Update it and try again.";
    }
    const detail = error.detail as { name?: unknown } | null;
    switch (error.code) {
      case "import_exists":
        return `There is already a folder called ${typeof detail?.name === "string" ? detail.name : "that"} here.`;
      case "unsupported_archive":
        return "That is not a .zip or a .tar.gz.";
      case "archive_unsafe":
        return "That archive has something in it this daemon will not write — a link, or a path pointing outside itself.";
      case "archive_empty":
        return "There is nothing in that archive.";
      case "import_too_large":
        return `An archive has to be under ${Math.round(MAX_IMPORT_BYTES / (1024 * 1024))} MB.`;
      case "import_unpacked_too_large":
      case "import_too_many_entries":
        return "That archive unpacks to more than this daemon will take. Leave out build output and dependencies.";
      case "import_busy":
        return "This machine is already unpacking an import. Try again in a moment.";
      /*
       * The relay saying the stream died under it. The preflight below catches
       * the common cause — a daemon with no such route, refusing without
       * draining the body — so reaching this means something else went wrong
       * mid-upload, and the useful advice is to try it again.
       */
      case "tunnel_failed":
        return "The connection to this machine dropped while the archive was going up. Try again.";
      default:
        break;
    }
  }
  return errorText(error);
}

export function ImportCode({
  machineId,
  into,
  roots,
  onClose,
  onImported,
}: {
  machineId: MachineId;
  /** The folder the picker is standing in. The import lands inside it. */
  into: string;
  /**
   * The machine's browse roots, so this names the folder the way the bar three
   * inches above it does — `~/thing` rather than `…/rends/thing`.
   *
   * Passed rather than read, because this component is drawn by the picker that
   * already holds them. Defaulted nowhere: an empty array is a real answer here
   * (`displayCwd` falls to `shortPath`), and making the prop required is what
   * stops a second caller quietly re-introducing the bare-segment label below.
   */
  roots: readonly string[];
  onClose: () => void;
  /** The new folder's absolute path, for the picker to walk into. */
  onImported: (path: string) => void;
}): ReactNode {
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [dragging, setDragging] = useState(false);
  const [copied, setCopied] = useState(false);
  /*
   * **The tick takes itself down.** It used to be a permanent state — the icon
   * swapped on success and nothing ever swapped it back, so a screen left open
   * said "copied" about a clipboard that had long since moved on.
   *
   * 1.4s: long enough to catch out of the corner of an eye, short enough that a
   * second copy does not land while the first is still being confirmed. The
   * cross-fade is 300ms of CSS on either side of it and needs no coordination —
   * unlike the badge this replaced, nothing here is unmounted mid-animation.
   */
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1400);
    return () => clearTimeout(timer);
  }, [copied]);
  const input = useRef<HTMLInputElement>(null);
  const abort = useRef<AbortController | null>(null);
  /**
   * An upload nobody is watching is stopped when this unmounts.
   *
   * ⚠ **Owed by the close above having become cheap.** While ✕ tore down the whole
   * New session flow nobody pressed it mid-upload; now that every dismissal is one
   * tap back to the form, they will — and `POST /fs/import` is bounded at **one at
   * a time per machine** (`409 import_busy`). An orphaned stream therefore holds
   * the daemon's import lock, and the next attempt is refused with a sentence
   * about a request the reader believes they already cancelled.
   *
   * `abort()` on a controller that has already settled is a no-op, so the
   * successful path pays nothing for this.
   */
  useEffect(() => () => abort.current?.abort(), []);
  const busy = phase.kind === "sending" || phase.kind === "unpacking";

  const send = (file: File): void => {
    if (busy) return;
    // Refused here so somebody does not push a large file over a phone's uplink
    // to be told no at the other end. The daemon still decides.
    if (file.size === 0) {
      // A folder dropped rather than a file arrives as a zero-byte entry, which
      // is the likeliest way to reach this and needs saying plainly.
      setPhase({ kind: "failed", message: "That is empty. Drop the archive itself, not the folder." });
      return;
    }
    if (file.size > MAX_IMPORT_BYTES) {
      setPhase({
        kind: "failed",
        message: `An archive has to be under ${Math.round(MAX_IMPORT_BYTES / (1024 * 1024))} MB.`,
      });
      return;
    }

    const daemon = store.daemonFor(machineId);
    if (daemon === undefined) {
      setPhase({ kind: "failed", message: "That machine is not reachable right now." });
      return;
    }

    const controller = new AbortController();
    abort.current = controller;
    setPhase({ kind: "sending", name: file.name, fraction: 0 });

    /*
     * **The route is asked about before the archive moves, and that ordering is
     * the whole fix.**
     *
     * A daemon without this route answers 404 — but only to a request it can
     * refuse cheaply. With megabytes already in flight it refuses *without
     * draining the request body*, so its end of the tunnel stream dies and the
     * relay reports the only thing it can see: `tunnel_failed`. Measured against
     * a daemon predating this route, through a real relay — `502` after 3.4 MB of
     * a 5 MiB upload, where the identical request with an empty body answers a
     * clean 404. So the sentence about an old daemon was unreachable in exactly
     * the case it exists for.
     */
    const run = async (): Promise<void> => {
      if (!(await daemon.importSupported())) {
        setPhase({
          kind: "failed",
          message: "This machine's daemon is too old to import code. Update it and try again.",
        });
        return;
      }
      const answer = await daemon.importArchive(
        into,
        file,
        file.name,
        (fraction) => {
          setPhase(
            fraction >= 1
              ? { kind: "unpacking", name: file.name }
              : { kind: "sending", name: file.name, fraction },
          );
        },
        controller.signal,
      );
      toast("ok", `Imported ${answer.import.name}`);
      // The picker is moved only once the daemon has said the folder exists.
      // Nothing here is drawn ahead of that.
      onImported(answer.import.path);
      onClose();
    };

    void run()
      .catch((cause: unknown) => {
        if (controller.signal.aborted) {
          setPhase({ kind: "idle" });
          return;
        }
        setPhase({ kind: "failed", message: importFailure(cause) });
      })
      .finally(() => {
        abort.current = null;
      });
  };


  /**
   * Put the skill on the clipboard, and say so on the button for a moment.
   *
   * `copied` is only ever set on success. Setting it from the result — which is
   * what this did — lit the tick on an origin where the clipboard is *absent*
   * rather than refused, which is every LAN address this app is read on; see
   * `clipboard.ts`. A failure gets the toast and the button stays as it was.
   */
  const copy = (): void => {
    void copyText(IMPORT_SKILL).then((ok) => {
      if (!ok) {
        toast("error", "Could not copy. Select the text and copy it by hand.");
        return;
      }
      setCopied(true);
    });
  };

  const pick = (files: FileList | null): void => {
    const file = files?.[0];
    if (file !== undefined) send(file);
  };

  return (
    <Sheet
      title="Import code"
      /*
       * All four ways out land on the form behind this sheet, and that is the
       * whole of the repair above: `onClose` for the ✕, Escape and the scrim; `up`
       * for a chevron that was simply not here, so the only way back was a footer
       * button labelled `Done` — which reads as "finish", and which is replaced by
       * `Cancel` for the length of an upload.
       */
      onClose={onClose}
      up={onClose}
      upLabel="New session"
      footer={
        <div className={SHEET_FOOT}>
          {/*
            `font-mono`, and `displayCwd` rather than a private helper: this is a
            path, and it is the *same* path the picker's breadcrumb bar is drawing
            above this sheet. See `.claude/rules/web-typography.md`.
          */}
          <p className="min-w-0 flex-1 truncate text-2xs text-muted" title={into}>
            Unpacks into <span className="font-mono">{displayCwd(into, roots)}</span>
          </p>
          {busy ? (
            <Button
              onClick={() => {
                abort.current?.abort();
              }}
            >
              Cancel
            </Button>
          ) : (
            <Button onClick={onClose}>Done</Button>
          )}
        </div>
      }
    >
      <div
        className={SHEET_SCROLL}
        /*
         * The drop target is the whole body rather than the box below it. The box
         * says where to aim; this catches everything that misses, which on a
         * trackpad is most of it. `onDragOver` must `preventDefault` or `drop`
         * never fires — the browser's default is to refuse.
         *
         * It is also this screen's scroller and its padding, since `SHEET_BODY`
         * has neither (Q3.553): `SHEET_SCROLL` fills the body, so a drop anywhere
         * in it still lands, and the steps sit in the padding a screen gets. The
         * column of steps is nested rather than `flex` being appended to that
         * string — it decides `display`, and a call site adding its own is the
         * shape `AgentBuilder` declines for the same reason.
         */
        onDragOver={(event) => {
          if (!event.dataTransfer.types.includes("Files")) return;
          event.preventDefault();
          if (!dragging) setDragging(true);
        }}
        onDragLeave={(event) => {
          // Fires for every child the pointer crosses; only leaving the body counts.
          if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
          setDragging(false);
        }}
        onDrop={(event) => {
          setDragging(false);
          if (event.dataTransfer.files.length === 0) return;
          event.preventDefault();
          pick(event.dataTransfer.files);
        }}
      >
      <div className="flex flex-col gap-5">
        {/*
          * **"Machine" is a word this screen has already spent.** There is a machine
          * picker on the form behind this sheet, a Machines section in settings, and
          * an `m_…` on every row — so "that machine" reads as *the one you just
          * selected*, which is the opposite of what is meant. The source is named by
          * the code on it instead, and the word is not used here at all.
          */}
        <p className="text-sm text-muted">Bring in a project from wherever its code is now.</p>

        <Step n={1} text="Paste this into a coding agent open in that project.">
          {/*
            * The text is **on screen**, not only in the clipboard.
            *
            * What this asks somebody to do is paste an instruction into a session
            * that will then read their repository and write files. A button whose
            * only account of itself is the word "copy" asks them to take that on
            * trust, and the one place in this app with a comparable shape — the
            * one-time secret — already shows the value rather than describing it.
            * So the block is readable and scrollable, and the control is an icon in
            * its corner rather than the only thing there is to look at.
            *
            * `overscroll-contain` is load-bearing rather than decorative: the
            * `SHEET_SCROLL` this sits in is itself a scroller, and without it
            * reaching the end of this box starts moving the screen — the
            * nested-scroller failure `DirectoryPicker` describes one file over.
            */}
          <div className="relative w-full">
            <pre className="max-h-56 overflow-y-auto overscroll-contain rounded-md border border-edge-strong bg-ink py-2.5 pr-16 pl-3 font-mono text-2xs leading-relaxed whitespace-pre-wrap text-fg">
              {IMPORT_SKILL}
            </pre>
            {/*
              * On the wrapper rather than inside the scroller, so it stays put while
              * the text moves under it. `plain` rather than `ghost` because it sits
              * on top of content and has to stay legible over it.
              *
              * **Not `IconButton`.** It needs both glyphs mounted at once to
              * cross-fade between them, where that primitive takes one.
              *
              * **28x32 rather than the 36x48 it started at, and nearly square.** The
              * first geometry was `Button` at `sm`, chosen so the control read as
              * the same family as everything else on this screen. It does not sit
              * where those do: they own their patch of the layout and this one is
              * parked on the corner of a code block somebody is reading. At that
              * size it took a visible bite out of the block, and the extra width
              * bought nothing — there is one glyph in it, not a glyph and a word.
              *
              * `right-4`, and the 16px is measured against the scroller's own
              * furniture rather than picked to look balanced: `pre` paints its
              * scrollbar inside its right edge, so a control 8px in sat on top of
              * the thumb and a press near the corner grabbed one or the other
              * depending on the pixel. 16px clears an overlay scrollbar and a
              * classic one that reserves its track.
              */}
            <div className="absolute top-2 right-4">
              <button
                type="button"
                onClick={copy}
                aria-label={copied ? "Copied" : "Copy to clipboard"}
                className="tap press relative flex min-h-7 w-8 items-center justify-center rounded-md border border-edge-strong bg-surface text-muted hover:bg-raised hover:text-fg"
              >
                {/*
                  * **Both glyphs are drawn, stacked, and swapped by opacity.**
                  *
                  * The tick used to be a permanent state: it replaced the icon on
                  * success and nothing ever put it back, so a screen left open said
                  * "copied" about a clipboard that had long since moved on. It
                  * reverts on a timer now — and it *fades* rather than snaps, because
                  * a tick that simply vanishes reads as the state having been lost
                  * instead of having expired.
                  *
                  * Under `prefers-reduced-motion` the transition collapses to nothing
                  * and the swap is instant. That is the right half to lose: what goes
                  * is the fade, what stays is the confirmation and its expiry.
                  */}
                <Icon
                  as={Copy}
                  size={13}
                  className={`absolute transition-opacity duration-300 ${copied ? "opacity-0" : "opacity-100"}`}
                />
                <Icon
                  as={Check}
                  size={13}
                  className={`absolute transition-opacity duration-300 ${copied ? "opacity-100" : "opacity-0"}`}
                />
              </button>
            </div>
          </div>
        </Step>

        <Step n={2} text="The agent packs the project into an archive and prints where it saved it." />

        <Step n={3} text="Drop it here, or press to choose.">
          <input
            ref={input}
            type="file"
            accept=".zip,.tgz,.tar.gz,application/zip,application/gzip,application/x-gzip"
            className="hidden"
            onChange={(event) => {
              pick(event.target.files);
              // Cleared so choosing the same file twice still fires `change`.
              event.target.value = "";
            }}
          />
          <button
            type="button"
            disabled={busy}
            onClick={() => input.current?.click()}
            className={`tap press flex min-h-24 w-full flex-col items-center justify-center gap-1.5 rounded-md border border-dashed px-3 text-center disabled:opacity-60 ${
              dragging ? "border-edge-strong bg-raised" : "border-edge-strong bg-surface hover:bg-raised"
            }`}
          >
            {phase.kind === "sending" || phase.kind === "unpacking" ? (
              <>
                <span className="flex items-center gap-2 text-sm text-fg">
                  <Icon as={Loader2} size={14} className="animate-spin" />
                  {phase.kind === "unpacking" ? "Unpacking…" : "Sending…"}
                </span>
                <span className="w-full max-w-64 truncate text-2xs text-muted">{phase.name}</span>
                <span className="h-1 w-full max-w-64 overflow-hidden rounded-full bg-raised">
                  <span
                    className="block h-full bg-edge-strong transition-[width]"
                    style={{
                      width: phase.kind === "unpacking" ? "100%" : `${Math.round(phase.fraction * 100)}%`,
                    }}
                  />
                </span>
              </>
            ) : (
              <>
                <Icon as={FileArchive} size={16} className="text-muted" />
                <span className="text-sm text-fg">Drop the archive here</span>
                <span className="text-2xs text-muted">.zip or .tar.gz</span>
              </>
            )}
          </button>
        </Step>

        {phase.kind === "failed" && <p className="text-sm text-danger wrap-anywhere">{phase.message}</p>}
      </div>
      </div>
    </Sheet>
  );
}

function Step({ n, text, children }: { n: number; text: string; children?: ReactNode }): ReactNode {
  return (
    <div className="flex gap-3">
      <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-raised text-2xs font-semibold text-muted">
        {n}
      </span>
      <div className="flex min-w-0 flex-1 flex-col items-start gap-2">
        <p className="text-sm text-fg">{text}</p>
        {children}
      </div>
    </div>
  );
}
