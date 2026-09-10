import { useState, type ReactNode } from "react";
import { ageText } from "../../account";
import type { ApiKeyRecord } from "../../cp";
import { errorText } from "../../http";
import { Badge, Button, SETTINGS_HEADING, Spinner } from "../bits";
import { toast } from "../Toast";

/**
 * API keys are a table: this element with {@link KeyRow}s in it, one line per
 * key, one column per fact. It has one caller now, the API keys screen — the
 * Users panel that drew somebody else's keys through the same row is deleted
 * with the admin routes behind it (Q1.631) — and the table stays its own
 * element rather than folding into that screen, because the split is what kept
 * the two lists from drifting into two markups while there were two.
 *
 * Four columns, the last one unheaded: the prefix, when it was made, when it was
 * last presented, and the verb. `table-fixed` is deliberately *not* set — the
 * prefix column is eight monospace characters and the action column is a button,
 * and letting the browser size them is what keeps it one line at 320px.
 */
export function KeyTable({ children }: { children: ReactNode }): ReactNode {
  return (
    <table className="mt-2 w-full text-sm">
      <thead>
        <tr className={`text-left ${SETTINGS_HEADING}`}>
          <th className="py-1.5 pr-3 font-semibold">Key</th>
          <th className="py-1.5 pr-3 font-semibold">Made</th>
          <th className="py-1.5 pr-3 font-semibold">Last used</th>
          <th className="py-1.5">
            <span className="sr-only">Action</span>
          </th>
        </tr>
      </thead>
      <tbody>{children}</tbody>
    </table>
  );
}

/**
 * One API key, as a table row.
 *
 * **Revoke is one tap.** Your own keys always were (Q3.219, kept whole in
 * decision 4C: every own key, the one this browser is holding included), and
 * your own are the only keys anybody lists now — the `confirm` prop that made
 * somebody else's a two-step question went with the admin panel that passed it
 * (Q1.631), so this row mounts no `TwoStep` and `webcheck`'s table of
 * confirmations no longer names this file. The button is the resting `Button`
 * with this row's own `busy`, since the resting button is the one that spins.
 *
 * - `thisBrowser` — draws the `this browser` badge and the one consequence that
 *   is allowed at rest, "revoking it signs you out", because the control beside
 *   it is one-tap (decision 10A). The caller decides it from the credential it
 *   holds (`thisBrowsersKey`); with a session credential no row is ever this.
 *
 * `revoke` is the request; `onRevoked` is what the caller does with the 200 —
 * re-read the list, or for this browser's own key, sign out on purpose.
 *
 * **Every Revoke names its key to a screen reader.** Visually the prefix is two
 * cells to the left; to a reader stepping through buttons, a table of them all
 * reading "Revoke" is a table where the one-tap act on your own keys has no
 * subject (review D18). The button carries `aria-label="Revoke <prefix>…"`.
 *
 * A revoked row keeps its place rather than vanishing: the question the table
 * answers is "is the one that leaked dead yet", and a row that disappears on
 * revocation cannot answer it. It is greyed, badged, and sorted last by the
 * caller.
 *
 * **Every row is the same height, and the height is the row's rather than its
 * contents'.** `h-12` on the `<tr>` and no vertical padding on any cell: a live
 * key's row used to be the Revoke button plus `py-2`, a revoked row its text
 * plus the same padding, a third shorter, and a table sized by which control
 * each row happens to hold read as three kinds of thing (Q3.554). 48px clears
 * `BUTTON_SIZE.sm` at both of its floors — 36px, and 44px under a coarse
 * pointer — with `align-middle` centring whatever the cell holds; the only
 * thing that can still grow a row is the this-browser sentence wrapping at
 * 320px, which is content, not chrome.
 */
export function KeyRow({
  record,
  thisBrowser = false,
  revoke,
  onRevoked,
}: {
  record: ApiKeyRecord;
  thisBrowser?: boolean;
  revoke: () => Promise<unknown>;
  onRevoked: () => void;
}): ReactNode {
  const [busy, setBusy] = useState(false);
  const revoked = record.revokedAt !== null;
  const now = Date.now();
  const lastUsed =
    record.lastUsedAt === undefined || record.lastUsedAt === null
      ? "never"
      : `${ageText(now - record.lastUsedAt)} ago`;

  const run = (): void => {
    setBusy(true);
    void revoke()
      .then(onRevoked)
      .catch((cause: unknown) => toast("error", errorText(cause)))
      .finally(() => setBusy(false));
  };

  return (
    <tr className={`h-12 border-t border-edge/60 align-middle ${revoked ? "text-muted" : ""}`}>
      <td className="pr-3">
        <span className="flex flex-wrap items-center gap-2">
          {/* The eight clear characters the lookup is indexed on — never the key
              and never its hash, neither of which the route will ever send. */}
          <span className="font-mono text-xs">{record.prefix}…</span>
          {revoked && <Badge>revoked</Badge>}
          {thisBrowser && !revoked && (
            <>
              <Badge tone="strong">this browser</Badge>
              {/* The one consequence drawn at rest on the keys screen, and only
                  here, because the button beside it acts on the first tap (10A).
                  `text-xs`, the row's own size: the one sentence on this screen
                  that says an act is irreversible was its smallest type. */}
              <span className="text-xs text-muted">revoking it signs you out</span>
            </>
          )}
        </span>
      </td>
      <td className="pr-3 text-xs whitespace-nowrap text-muted">{`${ageText(now - record.createdAt)} ago`}</td>
      <td className="pr-3 text-xs whitespace-nowrap text-muted">{lastUsed}</td>
      <td className="text-right">
        {!revoked && (
          <Button size="sm" disabled={busy} onClick={run} ariaLabel={`Revoke ${record.prefix}…`}>
            {busy ? <Spinner /> : "Revoke"}
          </Button>
        )}
      </td>
    </tr>
  );
}
