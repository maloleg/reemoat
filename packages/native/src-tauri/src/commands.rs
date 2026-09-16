//! Everything the webview may ask this process to do, and nothing else.
//!
//! Fifteen, and the list is short on purpose: an app-defined command is not
//! ACL-gated, so this file *is* the capability surface. `pnpm nativecheck` holds
//! it to the set `packages/web/src/native.ts` actually calls, in both directions —
//! a command nobody calls is a door nobody is watching, and a call with no command
//! behind it is a runtime failure no offline check would otherwise see.
//!
//! ⚠ **That number is prose and nothing asserts it, which is why it was wrong.**
//! It read *twelve* while thirteen were registered — `host_daemon_log` arrived and
//! the sentence did not move — and a count restated in a comment is exactly the
//! kind of claim `docs/DECISIONS.md` records this repository learning not to keep.
//! What the driver compares is the two *lists*, which is the property that
//! matters; this sentence is a reader's orientation, and if it disagrees with
//! `generate_handler!` in `lib.rs`, the handler is right.

use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

use crate::config;
use crate::credential;
use crate::daemon;
use crate::local::{self, LocalDaemon};
use crate::proxy::{self, CpAnswer, CpRequest};

pub struct Host {
    pub server: Mutex<Option<String>>,
    pub client: reqwest::Client,
    pub config_dir: std::path::PathBuf,
    pub durable: bool,
    /// The daemon this app started, if it started one. See `daemon.rs`.
    pub supervisor: Mutex<daemon::Supervisor>,
}

impl Host {
    fn origin(&self) -> Option<String> {
        self.server.lock().ok().and_then(|held| held.clone())
    }
}

/* ── the daemon on this computer, when this app is the one running it ────── */

/// Where the daemon is and how it is doing.
///
/// ⚠ **The second question about a local daemon, and deliberately not merged into
/// `host_local_daemon`.** That one answers `None` to every failure because its
/// caller has exactly one question — *is there a daemon here worth showing a token
/// to?* — and a diagnostic on that path would be noise. This one exists because
/// the app is now sometimes *responsible* for the daemon, and reporting "none" for
/// a process that exited two seconds ago would be the app hiding its own failure.
///
/// The states, and each names a different thing to do about it:
///
/// - `unsupported` — no payload in this build. Nothing to offer; the relay is the
///   only route, as it was before any of this.
/// - `foreign` — a daemon is announced that this app did not start. Adopted, never
///   raced: `claimDaemonLock` would refuse a second process against one database,
///   and creating a second control-plane machine for one computer would burn a
///   quota slot permanently.
/// - `running` — this app started it and it has announced itself.
/// - `starting` — this app started it and it has not announced itself yet.
/// - `exited` — it was started and is gone. `detail` carries the tail of what it
///   printed, which is the whole reason this command exists.
/// - `absent` — nothing here, and nothing has been tried.
#[tauri::command]
pub fn host_daemon_state(app: AppHandle, host: State<'_, Host>) -> daemon::DaemonState {
    let unknown = |status: &str| daemon::DaemonState {
        status: status.to_string(),
        ..Default::default()
    };
    let Ok(home) = app.path().home_dir() else {
        return unknown("unsupported");
    };
    if daemon::Payload::locate(&resource_dir(&app), &exe_path()).is_none() {
        return unknown("unsupported");
    }

    let announced = local::read(&home);
    /*
     * What this app already spent a machine on, for *this* server. Read here rather
     * than left to the page, because the page would have to be told the origin to
     * ask the question and the origin is deliberately something only the host
     * knows — the same rule `host_cp` keeps.
     */
    let origin = host.origin();
    let claimed = origin
        .as_deref()
        .and_then(|origin| daemon::read_claim(&host.config_dir, origin));
    /*
     * ⚠ **Answered on every state read, because the caller's *first* decision
     * depends on it.** A store that cannot see an existing env file creates a
     * machine for a computer that already had one — a quota slot spent on a
     * machine nobody asked for, and one only a person who notices it can return. `daemon::config_state` carries the measurement.
     */
    let config = daemon::config_state(&home, origin.as_deref()).to_string();
    let Ok(mut supervisor) = host.supervisor.lock() else {
        return daemon::DaemonState {
            status: "absent".to_string(),
            claimed,
            config,
            ..Default::default()
        };
    };
    let ours = supervisor.owns_running();
    /*
     * ⚠ **A daemon this app did not start has to be *there*, not merely announced.**
     * `src/announce.ts` removes its file on a clean stop and cannot on an unclean
     * one, so a force quit, a crash or a power cut leaves one naming a port nobody
     * is on. Believing it answers `foreign`, which is the one status the setup flow
     * treats as "somebody else has this covered" — and then nothing starts a daemon
     * ever again, on a computer whose daemon dies with the app by design.
     * ⚠ **And it is `/health` rather than a bare connect, because the port is not
     * the daemon.** `REEMOAT_PORT` is a fixed value in the env file, so a stale
     * announce names an ordinary port that anything may hold afterwards. The
     * answer carries the same `instanceId` the file does, so this proves the
     * daemon rather than the socket.
     * Not asked when this app owns the child: the handle is better evidence than a
     * probe, and it keeps a round trip off the one-second polling path.
     */
    let announced =
        announced.filter(|found| ours || daemon::is_alive(&found.base, &found.instance_id));

    let mut state = match (announced, ours) {
        (Some(found), true) => daemon::DaemonState {
            status: "running".to_string(),
            machine_id: Some(found.machine_id),
            claimed,
            ..Default::default()
        },
        // Announced by somebody else's daemon — the shell installer's, or one left
        // from a previous run of this app that outlived it.
        (Some(found), false) => daemon::DaemonState {
            status: "foreign".to_string(),
            machine_id: Some(found.machine_id),
            claimed,
            ..Default::default()
        },
        (None, true) => daemon::DaemonState {
            status: "starting".to_string(),
            claimed,
            ..Default::default()
        },
        (None, false) => {
            let exit_code = supervisor.exit_code();
            daemon::DaemonState {
                exit_code,
                // A ring with something in it and no live child means one was
                // started and is gone; an empty one, that nothing was ever tried
                // here. The lines themselves are `host_daemon_log`'s — this poll
                // asks the ring for a bit and never for its contents (Q7.140).
                status: if supervisor.printed_anything() {
                    "exited"
                } else {
                    "absent"
                }
                .to_string(),
                machine_id: None,
                claimed,
                ..Default::default()
            }
        }
    };
    state.config = config;
    state
}

/// Bring the daemon up, provisioning this computer first if it is being asked to.
///
/// **Three cases, decided by what the caller brought and by what is already on
/// disk**, and the docblock that used to be here described none of them: it
/// claimed this "refuses rather than overwrites when an env file already exists",
/// while the code silently skipped the write and started the daemon on whatever
/// the file said. That is how a machine created at 15:15:54 was followed one
/// second later by a daemon enrolling with a *different* machine's hour-old code
/// and dying on `409 code_unusable`, with nothing on screen — measured on a real
/// machine 2026-09-15.
///
/// - **A code** — provisioning, whether this is the first time or a fresh code for
///   a machine whose last one expired. Writes the file, preserving every key this
///   app does not own (`daemon::env_rewritten`), and writes **this host's own
///   origin** as the control plane rather than anything the page supplied.
/// - **No code, and a file that names this server** — adoption. Start what is
///   already configured and create nothing. This is a `deploy/install.sh` machine,
///   or this app's own after a restart.
/// - **A file naming another server** — refused outright, both above. Overwriting
///   it would point somebody's working daemon at a fleet they did not choose.
#[tauri::command]
pub fn host_daemon_start(
    enroll_code: String,
    machine_id: String,
    app: AppHandle,
    host: State<'_, Host>,
) -> Result<daemon::DaemonState, String> {
    let home = app
        .path()
        .home_dir()
        .map_err(|_| "no home directory".to_string())?;
    let payload = daemon::Payload::locate(&resource_dir(&app), &exe_path())
        .ok_or_else(|| "this build carries no daemon".to_string())?;

    let env_file = daemon::env_path(&home);
    let origin = host.origin();
    if daemon::config_state(&home, origin.as_deref()) == daemon::CONFIG_ELSEWHERE {
        return Err(format!(
            "{} on this computer is set up for a different Reemoat server, so this one was left alone.",
            env_file.display()
        ));
    }

    if !enroll_code.is_empty() && !daemon::is_writable_value(&enroll_code) {
        return Err("that enrollment code is not a shape this can write down".into());
    }
    if !machine_id.is_empty() && !daemon::is_writable_value(&machine_id) {
        return Err("that machine id is not a shape this can write down".into());
    }

    /*
     * ⚠ **Before the env file, not after.** The claim is what stops the next launch
     * buying a second machine for this computer, and a machine row is never given
     * back — so if writing the file fails on a full disk or a bad permission, the
     * `?` must not carry away the record that a machine was already bought. Cheap
     * and idempotent, which is what makes ordering it first free.
     */
    if !machine_id.is_empty() {
        if let Some(origin) = origin.as_deref() {
            daemon::write_claim(&host.config_dir, origin, &machine_id)?;
        }
    }

    /*
     * ⚠ **A rewrite is refused while a background service owns the same file.** It
     * would respawn within its throttle interval, source the new file and race this
     * app's child for a single-use code, the database lock and the port — and
     * whichever loses, the code is spent. Only the rewrite: adoption below is
     * exactly the right thing to do with a machine somebody else set up.
     */
    if !enroll_code.is_empty() && env_file.exists() {
        if let Some(unit) = daemon::managed_unit(&home) {
            return Err(daemon::managed_unit_detail(&unit));
        }
    }

    if !enroll_code.is_empty() {
        /*
         * ⚠ **The origin this app is signed in to, never a URL from the page.**
         * `native-shell.md` already states the rule — *a path crosses the bridge,
         * never a URL* — and the first version of this broke it by writing
         * whatever `POST /v1/machines` answered in `controlPlaneUrl`. That value is
         * `installOrigin`, which is the *request's* origin with `x-forwarded-proto`
         * applied, so behind a proxy declaring `http` it is a different spelling
         * from the one this app uses — and a different spelling makes
         * `config_state` answer `elsewhere` on the next launch, which is this app
         * refusing a file it wrote itself, for ever. Writing the origin the host
         * already holds makes `CONFIG_HERE` true by construction rather than by
         * agreement between two services.
         */
        let control_plane = origin
            .clone()
            .ok_or_else(|| "no server has been chosen yet".to_string())?;
        let dir = env_file
            .parent()
            .ok_or_else(|| "bad env path".to_string())?;
        std::fs::create_dir_all(dir)
            .map_err(|e| format!("could not create {}: {e}", dir.display()))?;
        /*
         * ⚠ **A rewrite, not a replacement, when there is already a file.** The one
         * measured here carried a private CA path its owner had added by hand —
         * without which the daemon cannot reach that control plane at all. Writing
         * `env_contents` over it would have deleted the line and turned a refused
         * enrollment code into a TLS failure.
         */
        let text = match std::fs::read_to_string(&env_file) {
            Ok(existing) => daemon::env_rewritten(&existing, &control_plane, &enroll_code),
            Err(_) => daemon::env_contents(&control_plane, &enroll_code),
        };
        write_private(&env_file, &text)?;
    } else if !env_file.exists() {
        return Err(
            "a control plane and an enrollment code are needed to set this machine up".into(),
        );
    }

    let text = std::fs::read_to_string(&env_file)
        .map_err(|e| format!("could not read {}: {e}", env_file.display()))?;
    let env = daemon::parse_env(&text);
    host.supervisor
        .lock()
        .map_err(|_| "the supervisor is poisoned".to_string())?
        .start(&payload, &home, &env)?;
    Ok(daemon::DaemonState {
        status: "starting".to_string(),
        claimed: if machine_id.is_empty() {
            None
        } else {
            Some(machine_id)
        },
        // True by construction: every path that reaches here either wrote a file
        // naming this server or adopted one that already did.
        config: daemon::CONFIG_HERE.to_string(),
        ..Default::default()
    })
}

/// Stop the daemon this app started, and only that one.
#[tauri::command]
pub fn host_daemon_stop(host: State<'_, Host>) -> Result<(), String> {
    host.supervisor
        .lock()
        .map_err(|_| "the supervisor is poisoned".to_string())?
        .stop();
    Ok(())
}

/// What the daemon this app started has printed, newest last.
///
/// ⚠ **Its own command rather than a field on `host_daemon_state`, and that is
/// about what each is asked.** `host_daemon_state` answers a word on a one-second
/// poll while a computer is being set up; this answers two hundred lines to one
/// screen that somebody opened on purpose. Folding the second into the first would
/// put the log on the poll, and `DaemonState.detail` — which means *what explains
/// this failure* and is `None` wherever nothing needs explaining — would become a
/// log field by accident.
///
/// **Never `Err`.** A screen whose subject is "what did it say" has no use for a
/// refusal it would have to render instead; every reason there is nothing to show
/// — no daemon started here, a daemon somebody else's installer started, a daemon
/// that has printed nothing yet — is an empty list, and the screen says which of
/// those it is from the state it already has.
#[tauri::command]
pub fn host_daemon_log(host: State<'_, Host>) -> Vec<String> {
    match host.supervisor.lock() {
        Ok(supervisor) => supervisor.log_lines(),
        // See `log_lines`: a poisoned lock costs the evidence, never the app.
        Err(_) => Vec::new(),
    }
}

/// `0600` inside a `0700` directory, on the platforms that have modes.
///
/// The enrollment code is a full machine identity until it is redeemed, so this
/// is the same discipline `src/announce.ts` applies to `daemon.json` and
/// `deploy/install.sh` to this very file. A filesystem with no POSIX modes is not
/// a reason to refuse — it is the same judgement `store/sqlite.ts` already makes.
fn write_private(path: &std::path::Path, contents: &str) -> Result<(), String> {
    use std::io::Write;
    /*
     * ⚠ **`std::fs::write` was wrong here twice over, and this is the one file
     * that can afford neither.** It truncates before it writes, so a crash in
     * between leaves an env file with no `REEMOAT_CONTROL_PLANE` — which
     * `config_state` reads as `elsewhere`, and the app then refuses to touch a
     * file it corrupted itself, telling the person their computer is set up for
     * another server. Being locked out is bad; being locked out by a sentence that
     * is not true is worse. And the `chmod` landed *after* the bytes, so the
     * enrollment code and the certificate path sat at the umask's mode for the
     * length of a write.
     *
     * A temporary file created at `0600`, filled, flushed and renamed over the
     * target closes both: the mode is never wrong because it is set at creation,
     * and every reader sees either the whole old file or the whole new one.
     */
    let dir = path
        .parent()
        .ok_or_else(|| format!("{} has no directory", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
    }
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("daemon.env");
    let tmp = dir.join(format!("{name}.tmp.{}", std::process::id()));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&tmp)
        .map_err(|e| format!("could not write {}: {e}", tmp.display()))?;
    // `sync_all` rather than a plain close: a rename that beats its own contents to
    // disk is the failure this shape exists to prevent.
    if let Err(e) = file
        .write_all(contents.as_bytes())
        .and_then(|()| file.sync_all())
    {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("could not write {}: {e}", tmp.display()));
    }
    drop(file);
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("could not write {}: {e}", path.display())
    })
}

/// Where `bundle.resources` landed, in a bundle and in `tauri dev` alike.
fn resource_dir(app: &AppHandle) -> std::path::PathBuf {
    app.path()
        .resource_dir()
        .unwrap_or_else(|_| std::path::PathBuf::from("."))
}

/// This process's own executable, whose directory holds `bundle.externalBin`.
fn exe_path() -> std::path::PathBuf {
    std::env::current_exe().unwrap_or_else(|_| std::path::PathBuf::from("."))
}

/// What the first paint needs, in one round trip.
///
/// One call rather than four, because the webview cannot draw anything honest
/// until it knows all of it: whether there is a server, whether there is a
/// sign-in for that server, and whether a sign-in will survive a restart.
#[derive(Serialize)]
pub struct Boot {
    pub server: Option<String>,
    /// **The credential, handed over once.**
    ///
    /// It lives in the webview's memory from here, exactly as it does in a
    /// browser, and in the OS keyring at rest — never in `localStorage`. Keeping
    /// the value in this process instead was considered and refused: `cpFetch`
    /// attributes a 401 by comparing `credential === sent` by identity, and a
    /// handle it cannot compare would silently lose the rule that stops a late
    /// 401 signing you out of a session you just started.
    pub credential: Option<String>,
    pub platform: String,
    /// What this computer is called, for naming the machine it becomes.
    ///
    /// ⚠ **Not `platform`, and the difference is the whole reason this field
    /// exists.** `platform` is `std::env::consts::OS` — the literal string
    /// `"macos"` on every Mac ever made. Naming a control-plane machine from it
    /// succeeds once and then collides for ever, and the collision is checked
    /// case-insensitively against every machine the account can see, so the second
    /// computer gets a `409` for a name nobody typed.
    ///
    /// `None` where the host name cannot be read, which is a real state on a
    /// locked-down box: the caller then has to ask rather than guess.
    #[serde(rename = "hostName")]
    pub host_name: Option<String>,
    #[serde(rename = "appVersion")]
    pub app_version: String,
    /// `false` where this machine's keyring took a canary and lost it — see
    /// `credential::probe`.
    pub durable: bool,
    /// The device this installation is registered as on that server, or `None`.
    ///
    /// ⚠ **The `rename` is load-bearing and its absence is invisible.** This
    /// struct carries no `rename_all` — every camelCase field names itself, which
    /// is `local.rs`'s convention too — so `device_id` without this line
    /// serializes as `device_id`, `boot.deviceId` reads `undefined` for ever, and
    /// `tsc`, `cargo`, `nativecheck`, `webcheck` and `cargo test` all stay green.
    /// The app would then decide on every launch that it has no device, register
    /// one, and walk into the account's device limit. `nativecheck` compares this
    /// struct's serialized keys against `NativeBoot`'s for exactly that reason.
    ///
    /// It comes from `config.rs` rather than the keyring, and that is what makes
    /// it survive a machine whose credential store silently discards writes.
    #[serde(rename = "deviceId")]
    pub device_id: Option<String>,
    /// The address this build suggests, for the setup screen's field to open on.
    ///
    /// ⚠ **A suggestion, and never `server`.** They are different questions —
    /// *what shall I put in the box* against *which fleet is this installation
    /// on* — and the first draft answered them with one field by seeding the
    /// default into `server.json` on first run. That skipped the setup screen
    /// entirely, so the app chose somebody's fleet and told them afterwards, and
    /// it made a `credential#<origin>` keyring account for an origin nobody had
    /// confirmed. Two fields, and only the second one is ever written down.
    ///
    /// `None` in this repository: nothing here compiles a default in, which
    /// `nativecheck` asserts the way it asserts `signingIdentity: null`.
    #[serde(rename = "defaultServer")]
    pub default_server: Option<String>,
}

#[tauri::command]
pub fn host_boot(app: AppHandle, host: State<'_, Host>) -> Boot {
    let server = host.origin();
    let credential = server.as_deref().and_then(credential::read);
    // Read from the same origin the credential was, and in the same breath, so
    // the two cannot answer about different servers.
    let device_id = server
        .as_deref()
        .and_then(|origin| config::read_device(&host.config_dir, origin));
    Boot {
        server,
        credential,
        platform: std::env::consts::OS.to_string(),
        host_name: daemon::host_name(),
        app_version: app.package_info().version.to_string(),
        durable: host.durable,
        device_id,
        default_server: config::default_server(),
    }
}

/// Is there a daemon on *this computer*, and which machine is it?
///
/// A separate call rather than a field on {@link Boot}, because a daemon can start
/// after the app does — and usually has, on a laptop where both come up at login.
/// The client re-asks; a boot payload would be a one-shot answer to a question
/// whose answer changes.
///
/// `None` for every failure, including the ordinary one of there being no daemon
/// here. `local::read` is where the refusals are, and loopback is enforced inside
/// it so the page never sees the parts an address was built from.
///
/// ⚠ **`is_alive` before the base leaves this process, because the caller spends a
/// machine token on it.** `machine.ts`'s `proveLocal` sends `Authorization: Bearer`
/// to whatever this answers, and `.claude/rules/relay.md` states what that costs
/// if the listener is not the daemon: a 300-second bearer, spendable **through the
/// relay from anywhere**. The file being unplantable by another uid closes only
/// half of it — `src/announce.ts` cannot remove its file on a SIGKILL, a crash or a
/// power cut, `REEMOAT_PORT` is a fixed 7887 by decision, and anything may hold an
/// ordinary port afterwards. `host_daemon_state` already applies exactly this
/// filter, with a ⚠ saying exactly this; it was the *status* path that had the
/// proof and the token-bearing path that did not.
///
/// It costs one `/health` round trip against `PROBE_TIMEOUT`, and `localRoute.ts`
/// asks this once per route resolution — a wake or a fifteen-second retry, never
/// the four-second poll. It is paid on *this* thread, which is the main one until
/// this command is `#[tauri::command(async)]`.
#[tauri::command]
pub fn host_local_daemon(app: AppHandle) -> Option<LocalDaemon> {
    let home = app.path().home_dir().ok()?;
    local::read(&home).filter(|found| daemon::is_alive(&found.base, &found.instance_id))
}

/// Adopt a server, and give up the previous one's sign-in in the same act.
///
/// The erase is not tidiness. A credential this app is no longer going to present
/// is one it has no reason to keep, and doing it here — rather than on some later
/// sign-out that may never happen — is what makes "no credential is retained for a
/// server you are not using" true of the act rather than of an intention.
#[tauri::command]
pub fn host_set_server(url: String, host: State<'_, Host>) -> Result<String, String> {
    let origin = config::normalize_origin(&url)?;
    let previous = host.origin();
    if previous.as_deref() == Some(origin.as_str()) {
        return Ok(origin);
    }
    config::write_server(&host.config_dir, &origin)?;
    if let Some(previous) = previous {
        let _ = credential::erase(&previous);
    }
    if let Ok(mut held) = host.server.lock() {
        *held = Some(origin.clone());
    }
    Ok(origin)
}

#[tauri::command]
pub fn host_credential_set(value: String, host: State<'_, Host>) -> Result<(), String> {
    let origin = host.origin().ok_or("no server has been chosen")?;
    credential::write(&origin, &value)
}

#[tauri::command]
pub fn host_credential_clear(host: State<'_, Host>) -> Result<(), String> {
    let Some(origin) = host.origin() else {
        return Ok(());
    };
    credential::erase(&origin)
}

/// Remember which device this server registered us as.
///
/// Scoped to the chosen origin, like the credential beside it, so an id issued by
/// one control plane can never be offered to another — which matters more than it
/// looks: that id names a row in *that* server's table, and presenting it
/// elsewhere would at best register a stranger's-looking device and at worst be a
/// value from a fleet this person does not administer.
///
/// Unlike the credential, this is **not** erased when the server changes. See
/// `config.rs`: the row on the old server still exists, so forgetting the id
/// leaves an installation nobody can recognise in their own list and spends a
/// second slot the next time they point back.
#[tauri::command]
pub fn host_device_set(value: String, host: State<'_, Host>) -> Result<(), String> {
    let origin = host.origin().ok_or("no server has been chosen")?;
    config::write_device(&host.config_dir, &origin, &value)
}

/// Give up the device recorded for the chosen server.
///
/// Called when the control plane answers `device_revoked` — the one refusal that
/// means this installation's id is finished rather than its session. Without it
/// the next sign-in would offer the retired id again; the server declines to bind
/// it and registers a fresh device, so the loop terminates either way, but the app
/// would go on presenting something it has been told is dead.
#[tauri::command]
pub fn host_device_clear(host: State<'_, Host>) -> Result<(), String> {
    let Some(origin) = host.origin() else {
        return Ok(());
    };
    config::erase_device(&host.config_dir, &origin)
}

/// The `/v1/*` leg. See `proxy.rs` for why it is the only one here.
#[tauri::command]
pub async fn host_cp(req: CpRequest, host: State<'_, Host>) -> Result<CpAnswer, String> {
    // A candidate origin is accepted **only** from the server picker, which is
    // asking "is there a Reemoat at this address" before anything is stored. It is
    // normalized here rather than trusted, so the probe cannot reach a shape
    // `host_set_server` would have refused.
    let base = match &req.origin {
        Some(candidate) => config::normalize_origin(candidate)?,
        None => host.origin().ok_or("no server has been chosen")?,
    };
    proxy::send(&host.client, &base, &req).await
}

#[tauri::command]
pub fn host_copy_text(app: AppHandle, text: String) -> Result<(), String> {
    app.clipboard().write_text(text).map_err(|e| e.to_string())
}

/// The schemes a link may open, and this list is a **second copy on purpose**.
///
/// The policy is `OPENABLE` in `packages/web/src/ui/links.ts`, which is where the
/// argument lives — everything outside it is *"launching a program named by an
/// agent-chosen string"*, on a page that renders agent output. The webview
/// already applies it; this is the half that holds if the page is ever wrong, and
/// `pnpm nativecheck` reads both lists off disk and asserts they are the same set,
/// which is what stops a second copy from becoming a second policy.
const OPENABLE_SCHEMES: [&str; 3] = ["http", "https", "mailto"];

#[tauri::command]
pub fn host_open_external(app: AppHandle, url: String) -> Result<(), String> {
    let parsed = url::Url::parse(&url).map_err(|_| "not a link".to_string())?;
    if !OPENABLE_SCHEMES.contains(&parsed.scheme()) {
        return Err("refused: not a scheme this opens".into());
    }
    app.opener()
        .open_url(parsed.as_str(), None::<&str>)
        .map_err(|e| e.to_string())
}

/// Hand a file to the person who asked for it, through the platform's own panel.
///
/// **Raw bytes, never JSON.** The client's download bound is 100 MiB
/// (`MAX_DOWNLOAD_BYTES`), and 100 MiB as a JSON array of numbers is roughly
/// 600 MB of string — so this takes `tauri::ipc::Request`, whose body arrives as
/// bytes over Tauri's own IPC protocol, and the filename rides in a header because
/// a header is the only other field a raw request has.
///
/// Answers `false` where the panel was dismissed, which is not a failure and must
/// not be drawn as one.
#[tauri::command]
pub fn host_save_file(app: AppHandle, request: tauri::ipc::Request<'_>) -> Result<bool, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected the file as bytes".into());
    };
    let encoded = request
        .headers()
        .get("x-reemoat-filename")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("download");
    let name = percent_encoding::percent_decode_str(encoded)
        .decode_utf8()
        .map_err(|_| "that filename is not text".to_string())?
        .to_string();

    let chosen = app
        .dialog()
        .file()
        .set_file_name(&name)
        .blocking_save_file();
    let Some(path) = chosen else {
        return Ok(false);
    };
    let path = path
        .into_path()
        .map_err(|e| format!("could not use that location: {e}"))?;
    std::fs::write(&path, bytes).map_err(|e| format!("could not write the file: {e}"))?;
    Ok(true)
}
