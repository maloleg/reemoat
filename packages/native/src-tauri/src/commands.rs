//! Everything the webview may ask this process to do, and nothing else.
//!
//! Twelve, and the list is short on purpose: an app-defined command is not
//! ACL-gated, so this file *is* the capability surface. `pnpm nativecheck` holds
//! it to the set `packages/web/src/native.ts` actually calls, in both directions —
//! a command nobody calls is a door nobody is watching, and a call with no command
//! behind it is a runtime failure no offline check would otherwise see.

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
    let claimed = origin.as_deref().and_then(|origin| daemon::read_claim(&host.config_dir, origin));
    /*
     * ⚠ **Answered on every state read, because the caller's *first* decision
     * depends on it.** A store that cannot see an existing env file creates a
     * machine for a computer that already had one — permanently, since a machine
     * row is never given back. `daemon::config_state` carries the measurement.
     */
    let config = daemon::config_state(&home, origin.as_deref()).to_string();
    let Ok(mut supervisor) = host.supervisor.lock() else {
        return daemon::DaemonState { status: "absent".to_string(), claimed, config, ..Default::default() };
    };
    let ours = supervisor.owns_running();

    let mut state = match (announced, ours) {
        (Some(found), true) => daemon::DaemonState {
            status: "running".to_string(),
            machine_id: Some(found.machine_id),
            claimed,
            detail: None,
            ..Default::default()
        },
        // Announced by somebody else's daemon — the shell installer's, or one left
        // from a previous run of this app that outlived it.
        (Some(found), false) => daemon::DaemonState {
            status: "foreign".to_string(),
            machine_id: Some(found.machine_id),
            claimed,
            detail: None,
            ..Default::default()
        },
        (None, true) => daemon::DaemonState { status: "starting".to_string(), claimed, ..Default::default() },
        (None, false) => {
            let tail = supervisor.tail();
            daemon::DaemonState {
                // A tail with no live child means one was started and is gone;
                // with no tail at all, nothing was ever tried here.
                status: if tail.is_some() { "exited" } else { "absent" }.to_string(),
                machine_id: None,
                claimed,
                detail: tail,
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
    let home = app.path().home_dir().map_err(|_| "no home directory".to_string())?;
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
        let control_plane = origin.clone().ok_or_else(|| "no server has been chosen yet".to_string())?;
        let dir = env_file.parent().ok_or_else(|| "bad env path".to_string())?;
        std::fs::create_dir_all(dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
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
        return Err("a control plane and an enrollment code are needed to set this machine up".into());
    }

    /*
     * ⚠ **Recorded before the daemon is started, never after.** The whole point of
     * the claim is to survive the app dying between creating a machine and that
     * machine being enrolled — so writing it after a successful start would leave
     * open exactly the window it exists to close.
     */
    if !machine_id.is_empty() {
        if let Some(origin) = origin.as_deref() {
            daemon::write_claim(&host.config_dir, origin, &machine_id)?;
        }
    }

    let text = std::fs::read_to_string(&env_file).map_err(|e| format!("could not read {}: {e}", env_file.display()))?;
    let env = daemon::parse_env(&text);
    host.supervisor
        .lock()
        .map_err(|_| "the supervisor is poisoned".to_string())?
        .start(&payload, &home, &env)?;
    Ok(daemon::DaemonState {
        status: "starting".to_string(),
        claimed: if machine_id.is_empty() { None } else { Some(machine_id) },
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

/// `0600` inside a `0700` directory, on the platforms that have modes.
///
/// The enrollment code is a full machine identity until it is redeemed, so this
/// is the same discipline `src/announce.ts` applies to `daemon.json` and
/// `deploy/install.sh` to this very file. A filesystem with no POSIX modes is not
/// a reason to refuse — it is the same judgement `store/sqlite.ts` already makes.
fn write_private(path: &std::path::Path, contents: &str) -> Result<(), String> {
    std::fs::write(path, contents).map_err(|e| format!("could not write {}: {e}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Some(dir) = path.parent() {
            let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
        }
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

/// Where `bundle.resources` landed, in a bundle and in `tauri dev` alike.
fn resource_dir(app: &AppHandle) -> std::path::PathBuf {
    app.path().resource_dir().unwrap_or_else(|_| std::path::PathBuf::from("."))
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
}

#[tauri::command]
pub fn host_boot(app: AppHandle, host: State<'_, Host>) -> Boot {
    let server = host.origin();
    let credential = server.as_deref().and_then(credential::read);
    Boot {
        server,
        credential,
        platform: std::env::consts::OS.to_string(),
        host_name: daemon::host_name(),
        app_version: app.package_info().version.to_string(),
        durable: host.durable,
    }
}

/// Adopt a server, and give up the previous one's sign-in in the same act.
///
/// The erase is not tidiness. A credential this app is no longer going to present
/// is one it has no reason to keep, and doing it here — rather than on some later
/// sign-out that may never happen — is what makes "no credential is retained for a
/// server you are not using" true of the act rather than of an intention.
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
#[tauri::command]
pub fn host_local_daemon(app: AppHandle) -> Option<LocalDaemon> {
    let home = app.path().home_dir().ok()?;
    local::read(&home)
}

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
