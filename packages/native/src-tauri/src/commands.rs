//! Everything the webview may ask this process to do, and nothing else.
//!
//! Nine, and the list is short on purpose: an app-defined command is not
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
use crate::local::{self, LocalDaemon};
use crate::proxy::{self, CpAnswer, CpRequest};

pub struct Host {
    pub server: Mutex<Option<String>>,
    pub client: reqwest::Client,
    pub config_dir: std::path::PathBuf,
    pub durable: bool,
}

impl Host {
    fn origin(&self) -> Option<String> {
        self.server.lock().ok().and_then(|held| held.clone())
    }
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
