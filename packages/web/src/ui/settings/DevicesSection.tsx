import { useEffect, useState, type ReactNode } from "react";
import { Trash2 } from "lucide-react";
import { CONTROL_PLANE_UNREACHABLE } from "../../account";
import * as cp from "../../cp";
import { errorText } from "../../http";
import type { DeviceRecord } from "../../wire";
import { Badge, Button, Empty, SETTINGS_HEADING, SETTINGS_SECTION, SkeletonRow, TwoStep, shortDuration } from "../bits";
import { toast } from "../Toast";

/**
 * The apps signed in to this account, and how to retire one.
 *
 * **A device is not a session, and the two lists say different things.** Signed
 * in, over in Account, is where a *token* is ended — the computer keeps working
 * and asks for the password again. This is where a **computer** is retired: its
 * sign-ins end with it and it cannot bind another until somebody signs in on it
 * afresh. That is why this is a section of its own rather than a second block
 * beside that one, and `settings.ts` carries the argument against the reading
 * that it reverses decision 1B.
 *
 * ⚠ **Two honest limits are stated on the screen rather than left to be
 * discovered**, because both are the kind of gap a person only finds at the
 * worst moment:
 *
 *   - **An API key has no device.** A key is not a sign-in, so nothing that came
 *     in on one appears here and nothing here revokes one. The remedy is the API
 *     keys screen, and the sentence says so and points at it.
 *   - **A machine token already minted keeps working for a few minutes.** The
 *     relay reads users, machines and grants per request and has never read a
 *     device row — deliberately, since permissions belong to the person and not
 *     to the computer. So retiring one stops it here on its next request, and
 *     lets a token it holds run out. Saying so is the same disclosure Settings →
 *     Machines makes about the loopback path.
 */
export function DevicesSection(): ReactNode {
  const [rows, setRows] = useState<DeviceRecord[] | null>(null);
  const [limit, setLimit] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);

  const refresh = (): void => {
    void cp
      .devices()
      .then((next) => {
        setRows(next.devices);
        setLimit(next.limit);
        setFailed(false);
      })
      .catch(() => setFailed(true));
  };

  useEffect(refresh, []);

  const live = rows === null ? [] : rows.filter((row) => row.revokedAt === null);
  const retired = rows === null ? [] : rows.filter((row) => row.revokedAt !== null);

  return (
    <>
      <section>
        <h2 className={SETTINGS_HEADING}>Devices</h2>
        {/*
         * One placeholder row, for `SignIns`' reason: this list is commonly one
         * row long, and a three-row skeleton collapsing to one implies two
         * devices that never existed.
         */}
        {rows === null && !failed && <SkeletonRow />}
        {failed && (
          <Empty
            failed
            action={
              <Button size="sm" onClick={refresh}>
                Try again
              </Button>
            }
          >
            {CONTROL_PLANE_UNREACHABLE}
          </Empty>
        )}
        {!failed && rows !== null && live.length === 0 && (
          /*
           * Not an empty list, which would read as "nothing can reach your
           * account" while something plainly can. The two ordinary ways to be
           * here are a browser — which is a tab rather than an installation
           * somebody registered — and an API key.
           */
          <p className="mt-1.5 text-xs text-muted">
            No devices registered. The Reemoat app registers one when you sign in; a browser and an API key do not.
          </p>
        )}
        {!failed && live.length > 0 && (
          <div className="mt-2">
            {live.map((row) => (
              <DeviceRow key={row.id} row={row} onChanged={refresh} />
            ))}
          </div>
        )}
        {!failed && rows !== null && limit !== null && live.length > 0 && (
          <p className="mt-2 text-2xs text-muted">
            {`${String(live.length)} of ${String(limit)} allowed. Retiring one makes room straight away.`}
          </p>
        )}
      </section>

      {/*
       * Retired rows, kept and drawn.
       *
       * The question this screen gets opened for is usually asked *after*
       * something has gone wrong, and a list that had simply lost a row cannot
       * tell "I retired that laptop on Tuesday" from "that laptop was never
       * registered". `user_sessions`' own docblock names keeping rows for a list
       * that then filters them out as the mistake worth not repeating.
       */}
      {!failed && retired.length > 0 && (
        <section className={SETTINGS_SECTION}>
          <h2 className={SETTINGS_HEADING}>Recently retired</h2>
          <div className="mt-2">
            {retired.map((row) => (
              <DeviceRow key={row.id} row={row} onChanged={refresh} />
            ))}
          </div>
        </section>
      )}

      <section className={SETTINGS_SECTION}>
        <h2 className={SETTINGS_HEADING}>What this covers</h2>
        <p className="mt-1.5 text-xs text-muted">
          An API key is not a sign-in, so nothing holding one appears here. Retire a key under API keys.
        </p>
        <p className="mt-1.5 text-xs text-muted">
          Retiring a device ends its sign-ins at once. Work already open on one of your machines can carry on for a few
          minutes before it stops.
        </p>
      </section>
    </>
  );
}

function DeviceRow({ row, onChanged }: { row: DeviceRecord; onChanged: () => void }): ReactNode {
  const [confirming, setConfirming] = useState(false);
  const now = Date.now();
  const retired = row.revokedAt !== null;

  const retire = (): Promise<void> =>
    cp.revokeDevice(row.id).then((answer) => {
      /*
       * The number the server actually ended, not one this row computed: the
       * list is a poll old, and `sessionsRevoked` is the answer to what just
       * happened. `SignIns`' `signOutOthers` makes the same choice.
       *
       * ⚠ **No toast on your own row, because the app is about to sign out.** The
       * next request answers `401 device_revoked`, `store.handleSignedOut` drops
       * to the sign-in screen, and a toast that arrives on the way there is a
       * message about success nobody reads on a screen that has been replaced.
       */
      if (row.current) return;
      toast(
        "ok",
        answer.sessionsRevoked === 1
          ? `${row.name} retired. 1 sign-in ended.`
          : `${row.name} retired. ${String(answer.sessionsRevoked)} sign-ins ended.`,
      );
      onChanged();
    });

  return (
    <div className="flex min-h-11 items-center gap-3 border-b border-edge/60 py-2 last:border-b-0">
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-2">
          <span className={`min-w-0 truncate text-sm font-medium ${retired ? "text-muted" : ""}`}>{row.name}</span>
          {/* `shrink-0` beside a truncating name, for the sign-in row's reason:
              the badge is the fact that makes the row recognisable and never
              gives way. One badge per row — retired outranks this device, since
              a row that no longer works is the more surprising of the two. */}
          {retired ? (
            <span className="shrink-0">
              <Badge>retired</Badge>
            </span>
          ) : (
            row.current && (
              <span className="shrink-0">
                <Badge tone="strong">this device</Badge>
              </span>
            )
          )}
        </span>
        <span className="mt-0.5 block text-2xs text-muted">
          {row.platform}
          {" · "}
          {retired
            ? `retired ${shortDuration(Math.max(0, now - (row.revokedAt ?? now)))} ago`
            : row.current
              ? "in use"
              : row.lastSeenAt === null
                ? "never signed in"
                : `last used ${shortDuration(Math.max(0, now - row.lastSeenAt))} ago`}
        </span>
      </span>

      {/*
       * ⚠ **Offered on your own row too, unlike Sign out one list over**, and the
       * difference is which mistake each prevents. There, the act already exists
       * at the foot of the screen and a second copy beside four neighbours is how
       * somebody ends their own session aiming at one of them. Here there is no
       * other way to do it — and retiring the computer you are giving away is
       * exactly what somebody reaches for. Refusing would also mean the last
       * device on an account could never be retired.
       *
       * What makes it safe is the confirmation naming the subject, which is what
       * `TwoStep` is for, plus a consequence line saying this session ends.
       */}
      {!retired && (
        <span className="shrink-0">
          <TwoStep
            armed={confirming}
            onArm={setConfirming}
            align="end"
            question={`Retire ${row.name}?`}
            consequence={
              row.current
                ? "This signs you out here. Sign in again to use this device."
                : "Its sign-ins end. No other device is affected."
            }
            act={{ label: "Retire", danger: true, icon: Trash2, ariaLabel: `Retire ${row.name}` }}
            onAct={retire}
            onFailure={(cause) => toast("error", errorText(cause))}
            rest={
              <Button size="sm" onClick={() => setConfirming(true)}>
                Retire
              </Button>
            }
          />
        </span>
      )}
    </div>
  );
}
