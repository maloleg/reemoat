import { useEffect, useState, type ReactNode } from "react";
import { Trash2 } from "lucide-react";
import { CONTROL_PLANE_UNREACHABLE } from "../../account";
import * as cp from "../../cp";
import { errorText } from "../../http";
import { hostDeviceKeyReset, inNativeShell } from "../../native";
import { platformName } from "../../platform";
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
 *
 * ⚠ **And this is the screen that answers *can this installation reach a machine
 * at all*, which is what `hasKey` was put on the wire for.** The control plane
 * has answered it on every row since device keys landed and nothing read it, so a
 * device that could not open an encrypted channel to anything drew exactly like
 * one that works — on the one list whose whole job is to tell installations
 * apart. The badge is that answer; `wire.ts`'s `DeviceRecord.hasKey` carries why
 * it is a boolean rather than the key.
 *
 * ⚠ **And the badge was an answer with nothing to press.** The state it names is
 * the one a client cannot leave on its own: `readDeviceInput` nulls a `publicKey`
 * it cannot parse and **keeps** the registration, so the row reports `hasKey:
 * false` for ever, and signing in again — which is what the sentence under the
 * list used to advise — re-sends the very bytes that were refused. The row now
 * carries the one act that ends it: `hostDeviceKeyReset()` and then
 * `cp.registerDevice()`, which `adoptDevice` writes onto the same row, so a
 * re-key spends no slot. Offered in the shell alone, because a browser holds no
 * keyring, and on your own row alone, because both calls are about the
 * installation that makes them. `native.ts` carries the other half of that pair.
 */
export function DevicesSection(): ReactNode {
  const [rows, setRows] = useState<DeviceRecord[] | null>(null);
  const [limit, setLimit] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);

  /**
   * Re-read the list — and hand the rows back, which is new.
   *
   * It answered nothing while its only caller was a Retire that wanted nothing
   * from it. A re-key does — and what makes the refreshed row the only statement
   * available is **this bundle's own client rather than the route**. `POST
   * /v1/me/devices` does answer the verdict (`hasKey: deviceKeyFor(db, deviceId)
   * !== null`, whose comment in `app.ts` names a client that has just re-keyed as
   * the caller it is there for), and `cp.registerDevice()` answers `body.id`
   * alone, dropping it. ⚠ **This paragraph used to blame the route** — *"answers
   * a row id for a key the Authority may have refused"* — which is false of it;
   * what is true either way is that `readDeviceInput` nulls a `publicKey` it
   * cannot parse and **keeps** the registration, so *it answered* is still not
   * *it took*. `null` is the read that failed, which is neither a yes nor a no
   * and is drawn as neither.
   */
  const refresh = (): Promise<DeviceRecord[] | null> =>
    cp
      .devices()
      .then((next) => {
        setRows(next.devices);
        setLimit(next.limit);
        setFailed(false);
        return next.devices;
      })
      .catch(() => {
        setFailed(true);
        return null;
      });

  // `useEffect(refresh, [])` stopped type-checking the moment this answered a
  // promise — `EffectCallback` returns `void | Destructor` and a `Promise` is
  // neither — so the wrapper is the compiler's, not a style choice, and the
  // `void` says the answer is deliberately dropped here.
  useEffect(() => {
    void refresh();
  }, []);

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
              <Button size="sm" onClick={() => void refresh()}>
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
        {/*
         * Drawn only where a row is in that state, unlike the two standing
         * limits below.
         *
         * Those are true of the list whatever it holds, so stating them is the
         * disclosure this screen is built around. This one is a fault, and a
         * sentence explaining a badge nobody can see is furniture on the ordinary
         * screen — the same reason `unavailableHint` sits in the menu of the
         * control it is about rather than on the strip.
         *
         * ⚠ **Keyed on `=== false`, never on `!row.hasKey`.** A control plane
         * older than the `public_key` migration sends no such field, so the
         * absent value is *nobody said* — read as falsy it would put this
         * sentence and every badge under it on a whole account's devices, none of
         * which is broken. `wire.ts` declares it optional for that reason.
         *
         * ⚠ **It said "Sign in again on it to register one", which named an act
         * that cannot terminate.** A sign-in re-sends the key that installation
         * already holds, and the Authority refused that key and kept the row —
         * so the advice looped and the badge under it never cleared. The remedy
         * is a new key, which only the computer holding the keyring can make, so
         * this sentence points at the row rather than offering anything itself:
         * the act is on the row for the same reason the question on it names a
         * device by name.
         */}
        {!failed && live.some((row) => row.hasKey === false) && (
          <p className="mt-1.5 text-2xs text-muted">
            A device with no key cannot reach your machines, and signing in again on it does not register one. Re-key it
            from its own row, on that computer.
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

function DeviceRow({
  row,
  onChanged,
}: {
  row: DeviceRecord;
  onChanged: () => Promise<DeviceRecord[] | null>;
}): ReactNode {
  // Which question is on the row, rather than whether one is: two acts share one
  // box, and the box has to know which of them it is about to perform.
  const [confirming, setConfirming] = useState<"retire" | "rekey" | null>(null);
  const now = Date.now();
  const retired = row.revokedAt !== null;
  /*
   * ⚠ **`row.current` is a correctness gate rather than tidiness.** Both halves
   * of a re-key are about *this* installation and neither one can be aimed
   * anywhere else: `hostDeviceKeyReset()` reaches `device::reset_key(config_dir,
   * origin)`, which is this computer's key for the chosen server, and
   * `cp.registerDevice()` sends `describeDevice()`, which offers
   * `currentDevice()` — this installation's own id — and never `row.id`, so
   * `adoptDevice` writes the new key onto *this* row.
   *
   * ⚠ **So the victim named here was the wrong one.** It read *"would hand a
   * third machine a key nobody asked for and leave the row that was pressed
   * exactly as broken"*; traced through those two calls there is no third party
   * at all. Drawn on somebody else's row, the control would act on **this**
   * computer twice and on the pressed row not at all — the device in front of
   * you re-keyed for nothing, with every capability already minted for it naming
   * a key it no longer holds until `onWrongDevice` or the next `mint` replaces
   * one, and the row that was pressed exactly as broken as before. Only the
   * second half of the old sentence survived the trace.
   *
   * `inNativeShell()` is the other half: a tab has no keyring to reset, and never
   * appears in this list in the first place.
   */
  const rekeyable = !retired && row.current && row.hasKey === false && inNativeShell();

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
      void onChanged();
    });

  /**
   * Give this installation a new key, and register it.
   *
   * **The one way out of `hasKey: false`, and it is two calls because no single
   * one can do it.** The shell makes the key — only it has the keyring — and the
   * Authority has to be told, which only a credential-holding call can do. They
   * are sequential rather than concurrent: `hostDeviceKeyReset` refreshes the
   * cached `NativeBoot` on the way out, and `describeDevice()` reads the new
   * public half off exactly that, so registering before it resolves would send
   * the key that was just given up.
   *
   * ⚠ **The verdict is read off the refreshed list, and the reason is the client
   * rather than the route.** `POST /v1/me/devices` *does* say whether the key
   * took — `hasKey: deviceKeyFor(db, deviceId) !== null` — while
   * `cp.registerDevice()` answers `body.id` alone and drops it, so it never
   * reaches this function. An earlier spelling of this paragraph blamed the route
   * (*"answers a row id whether or not the key was taken"*), which is false of
   * it; the half that is true either way is that `readDeviceInput` nulls a
   * `publicKey` it cannot parse and **keeps** the registration, so "it answered"
   * is not "it took". Narrowing what `registerDevice` answers is the one edit
   * that would let this read the verdict a call earlier.
   *
   * ⚠ **Three outcomes, and the middle one is why this function stopped having
   * two.** `device::reset_key` erases the keyring copy *and* the `server.json`
   * fallback **before** calling `ensure_key`, so the moment the first `await`
   * resolves the old key is gone and the act is not free to repeat:
   *
   *   - **Re-keyed and re-registered.** The refreshed row says `hasKey`, and
   *     nothing else on the account has to be pressed: the machines went
   *     unreachable because `POST /v1/tokens` refused with `device_key_required`,
   *     and each recovers on its own next mint.
   *   - **Re-keyed, and the Authority was not told.** `cp.registerDevice()`
   *     rejected, which is reachable rather than theoretical — the route is
   *     throttled (`spendWrite(c, "device")`, so `429`) and a control plane can
   *     simply be down. This computer now holds a key the Authority has never
   *     seen, which is *not* the state the toast used to report; the row keeps
   *     its Re-key control armed because `hasKey` is still `false`, and `mint`'s
   *     `device_key_required` retry and the channel's `onWrongDevice` each send
   *     the registration again on the next mint with nobody pressing anything.
   *   - **Not re-keyed at all.** `hostDeviceKeyReset()` itself rejected. The only
   *     arm where nothing was spent — except that `reset_key` erases before it
   *     generates, so a failure *inside* it can leave this installation holding
   *     no key rather than the one it had, and the string it rejects with is the
   *     whole of what `onFailure` can say about which.
   */
  const rekey = async (): Promise<void> => {
    /*
     * Only this call is left to `onFailure`, and the boundary moved on purpose.
     *
     * `errorText` is honest on it for a reason worth writing down: `commands.rs`
     * answers `Result<DeviceKey, String>`, so a keyring refusal crosses the
     * bridge as a string and `errorText` renders a string as itself. The arm that
     * would be wrong — `hostDeviceKeyReset`'s own `Error("no native shell")`,
     * which `isTransportFailure` reads as a dead link because that predicate is
     * `!ApiError` — is unreachable from here: `rekeyable` has already required
     * the shell.
     *
     * ⚠ **Everything after this line reports itself instead.** `twoStepAct` is
     * unchanged and still stands the question open on a rejection (`web-shell.md`:
     * closing only on the 200); what changed is that this caller stops handing it
     * one, because the act below the reset has already happened and standing over
     * an irreversible half invites a second tap that throws away a key the
     * Authority still has to be told about. The row's own Re-key is the retry.
     */
    await hostDeviceKeyReset();
    let id: string | null;
    try {
      id = await cp.registerDevice();
    } catch (cause) {
      // The cause is parenthesised and last so the instruction is the last thing
      // read: `errorText` answers a sentence about a link (`TRANSPORT_TEXT`) or
      // the Authority's own refusal, and neither of those is the next step.
      toast("error", `${rekeyToast(row.name, "unsent")} (${errorText(cause)})`);
      return;
    }
    /*
     * `null` is `describeDevice()` having nothing to describe, and under
     * `rekeyable` it cannot happen: it answers `null` only outside the shell or
     * with `nativeBoot()` at `null`, `hostReady` assigns `boot` in its `.then`
     * and nothing anywhere puts it back — so a shell whose `host_boot` rejected
     * sends no `device` on login either, no session is bound to a row,
     * `row.current` is false everywhere and this control is not drawn.
     *
     * ⚠ **An arm rather than the `id ?? row.id` fallback it replaces.** That
     * fallback looked up the row anyway, found `hasKey: false` — because nothing
     * had been sent — and reported *the server would not take it* about a request
     * that was never made. A dead arm is cheaper than a lie.
     */
    if (id === null) {
      toast("error", rekeyToast(row.name, "unsent"));
      return;
    }
    const listed = (await onChanged())?.find((one) => one.id === id) ?? null;
    // The refresh failed, or the row is gone. Either way the list on screen is
    // already saying so, and a toast inventing a verdict from nothing is exactly
    // the claim this function refuses to make.
    if (listed === null) return;
    // ⚠ **`=== false` here too, for the reason the list's own sentence gives**:
    // absent is *nobody said*, which is not the claim that the key was refused,
    // and saying it was would send somebody after a server that never spoke.
    const refused = listed.hasKey === false;
    toast(refused ? "error" : "ok", rekeyToast(row.name, refused ? "refused" : "registered"));
  };

  return (
    <div className="flex min-h-11 items-center gap-3 border-b border-edge/60 py-2 last:border-b-0">
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-2">
          <span className={`min-w-0 truncate text-sm font-medium ${retired ? "text-muted" : ""}`}>{row.name}</span>
          {/* `shrink-0` beside a truncating name, for the sign-in row's reason:
              the badge is the fact that makes the row recognisable and never
              gives way. One badge per row — retired outranks this device, since
              a row that no longer works is the more surprising of the two.

              ⚠ **`no key` is ranked between them, which is the machine row's own
              ordering** (`web-shell.md`: one badge per row, ranked *state · this
              device · shared*) applied to this list: a state a row is *in* beats
              a label saying which row you are on. Below `retired`, because a
              retired installation's key is not what is wrong with it and reading
              "no key" over a row somebody deliberately ended would send them
              looking for a fault.

              What it costs, said rather than hidden: your own row loses its
              `this device` mark for as long as it has no key. That is the right
              trade here — the mark is a convenience, the badge is the reason
              nothing on this account can reach a machine — and both places where
              being on your own row actually matters say so without it: the Retire
              confirmation in words (*This signs you out here*), and Re-key by
              existing at all, since `rekeyable` draws it on no other row. ⚠ **That
              second one is new and it is the reason this paragraph was re-read**:
              the mark and the badge are mutually exclusive by the ranking above,
              so a row wearing `no key` is precisely a row with no `this device` on
              it, and the control is what tells somebody the keyless installation
              in front of them is the one they are holding. */}
          {retired ? (
            <span className="shrink-0">
              <Badge>retired</Badge>
            </span>
          ) : row.hasKey === false ? (
            <span className="shrink-0">
              <Badge tone="strong">no key</Badge>
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
          {platformName(row.platform)}
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
       *
       * ⚠ **Two acts, one `TwoStep`, and that is structural rather than tidy.**
       * The primitive swaps the resting controls for the question and its two
       * answers *in one box*; two elements side by side would give the row two
       * boxes, so arming one would leave the other's resting button on screen
       * beside a question it has nothing to do with — and a row that can be
       * retired while it is asking about a re-key is the accident the whole
       * control exists to prevent. `confirming` carries which act is being asked
       * about; everything below reads it.
       */}
      {!retired && (
        <span className="shrink-0">
          <TwoStep
            armed={confirming !== null}
            /*
             * `TwoStep` only ever *disarms* — arming is `rest`'s own buttons',
             * because the tap is what says which of the two acts the question is
             * about. So there is no `true` arm to write here, and inventing one
             * would mean guessing a default act for a box that holds a
             * destructive one.
             */
            onArm={(next) => {
              if (!next) setConfirming(null);
            }}
            align="end"
            question={confirming === "rekey" ? `Give ${row.name} a new key?` : `Retire ${row.name}?`}
            consequence={
              confirming === "rekey"
                ? "The old key is given up first. This device keeps its place in the list."
                : row.current
                  ? "This signs you out here. Sign in again to use this device."
                  : "Its sign-ins end. No other device is affected."
            }
            act={
              confirming === "rekey"
                ? { label: "Re-key", ariaLabel: `Re-key ${row.name}` }
                : { label: "Retire", danger: true, icon: Trash2, ariaLabel: `Retire ${row.name}` }
            }
            onAct={confirming === "rekey" ? rekey : retire}
            onFailure={(cause) => toast("error", errorText(cause))}
            /*
             * ⚠ **Retire is last and that ordering is the safety property**, the
             * same one `web-shell.md` states for the confirming row's Cancel:
             * both groups lay out in one box, so the last child occupies the same
             * pixels, and `.tap` has removed the double-tap delay. With Retire
             * last, a second tap aimed at it lands on Cancel. Reversed, Retire
             * would sit where the *act* button lands and a double tap would
             * retire the device unasked — while a double tap on Re-key, which is
             * where the act button now falls, re-keys a row that already has no
             * key and costs nothing.
             */
            rest={
              <>
                {rekeyable && (
                  <Button size="sm" onClick={() => setConfirming("rekey")}>
                    Re-key
                  </Button>
                )}
                <Button size="sm" onClick={() => setConfirming("retire")}>
                  Retire
                </Button>
              </>
            }
          />
        </span>
      )}
    </div>
  );
}

/**
 * What to say after a re-key, given how far it got.
 *
 * ⚠ **A mapper rather than a ternary at the call site, and the reason is that
 * the ternary was wrong.** It had two arms for three outcomes, so a
 * registration that was never sent — `registerDevice()` answering `null`, or
 * rejecting on a `429` from that route's own write throttle — was reported with
 * *the server would not take the one this computer made*, a sentence about a
 * refusal by a server that had not been asked. Copy built inside a component is
 * also copy nothing can assert; `credentialToast` in `AgentsPanel.tsx` is the
 * shape this follows, and it is asserted arm by arm.
 *
 * **`unsent` is the one that carries an instruction, because it is the one
 * outcome that is neither done nor undone.** `device::reset_key` erases the old
 * key before it makes the new one, so by the time this can be reached the key on
 * this computer has already changed and the Authority still names the old one in
 * everything it has minted. Nothing is lost and nothing is at risk — `mint`'s
 * `device_key_required` retry and the channel's `onWrongDevice` both re-send the
 * registration on the next mint — so *press Re-key again* is the shortcut rather
 * than the only exit, and the row keeps that control armed because its `hasKey`
 * is still `false`.
 */
export function rekeyToast(name: string, outcome: "registered" | "unsent" | "refused"): string {
  switch (outcome) {
    case "registered":
      return `${name} has a new key.`;
    case "unsent":
      return `${name} has a new key, but the server was not told. Press Re-key again.`;
    case "refused":
      return `${name} still has no key: the server would not take the one this computer made.`;
    default: {
      /*
       * `AgentGlyph` is why this arm is written out rather than trusted to the
       * compiler: it answered `ReactNode`, `undefined` inhabits that, and a
       * `switch` falling off the end returned exactly `undefined` — so a blank
       * tile compiled clean for four releases. A `string` return type would catch
       * a fourth member here, but only as an error pointing at the signature; the
       * `never` points at the member.
       */
      const unreached: never = outcome;
      return unreached;
    }
  }
}
