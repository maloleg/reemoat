//! The Reemoat native shell.
//!
//! It draws nothing. The whole user interface is `packages/web`, built once and
//! **embedded in this binary** — which is the point of the exercise: the server
//! this app talks to cannot replace the code running in it.
//!
//! What this process adds is four things the webview cannot do for itself: reach
//! a control plane that answers no CORS, keep a sign-in in the operating system's
//! credential store, open a link in the real browser, and write a file through a
//! save panel. Everything else — the relay, the daemons, the WebSocket, every
//! retry rule — stays in the webview and is the same code the browser client runs.

mod commands;
mod config;
mod credential;
mod local;
mod proxy;

use std::sync::Mutex;

use tauri::Manager;

use commands::Host;

/// Where the window is allowed to *navigate*, which is not the same question as
/// where a link may open.
///
/// Only this app's own document. A link in agent output is opened by
/// `host_open_external`, in the browser, with its own allowlist; this refuses the
/// other shape — a script assigning `location.href`, or a form posting away —
/// which would otherwise replace the running app with somebody else's page inside
/// a window holding the fleet's credential.
///
/// The dev server is here because `tauri dev` loads the frontend from Vite, and a
/// rule that only worked in a packaged build is a rule nobody develops against —
/// but it is here *only* in a development build, and that is load-bearing rather
/// than tidy.
///
/// ⚠ **`localhost` and `127.0.0.1` were allowed unconditionally and that was a
/// hole.** A Reemoat control plane on loopback is the ordinary self-hosted shape —
/// `pnpm cp`, a dev stand, a single-box install — and it serves `index.html` at
/// `/`. Unconditionally allowed, a script assigning `location.href` could
/// therefore replace the running app with the *backend's* page, inside the window
/// holding the fleet's credential: the one thing bundling the frontend exists to
/// make impossible. The CSP cannot help — there is no `navigate-to` directive, and
/// neither `form-action` nor `base-uri` constrains a navigation. A local daemon at
/// `127.0.0.1:7887` falls under the same rule; it serves only JSON today, which is
/// luck rather than a boundary.
///
/// `tauri.localhost` stays in every build: it is the *bundle's* own origin on
/// Windows and Android, not a server's.
fn is_our_own(url: &url::Url) -> bool {
    match url.scheme() {
        // macOS and Linux serve the bundle from `tauri://localhost`.
        "tauri" => true,
        "http" | "https" => match url.host_str() {
            // Windows and Android serve the bundle from here. Always this app.
            Some("tauri.localhost") => true,
            // The Vite dev server — and, in a packaged build, somebody else's
            // service. See above.
            Some("localhost") | Some("127.0.0.1") => cfg!(debug_assertions),
            _ => false,
        },
        _ => false,
    }
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .invoke_handler(tauri::generate_handler![
            commands::host_boot,
            commands::host_local_daemon,
            commands::host_set_server,
            commands::host_credential_set,
            commands::host_credential_clear,
            commands::host_cp,
            commands::host_copy_text,
            commands::host_open_external,
            commands::host_save_file,
        ])
        .setup(|app| {
            /*
             * The configuration directory, from Tauri rather than hand-built.
             *
             * ⚠ Never `~/.reemoat`. That is the *daemon's* directory — it holds
             * `reemoat.db`, whose `identity.tunnel_key` is a live secret — and a
             * client writing into it would be a second writer on a tree with an
             * owner.
             */
            let dir = app.path().app_config_dir()?;
            let server = config::read_server(&dir);
            app.manage(Host {
                server: Mutex::new(server),
                client: proxy::client(),
                config_dir: dir,
                durable: credential::probe(),
            });

            /*
             * The window is declared in `tauri.conf.json` with `create: false` and
             * built here, so every setting stays in the configuration file and
             * this adds only the one thing a configuration cannot express.
             */
            let config = app
                .config()
                .app
                .windows
                .iter()
                .find(|window| window.label == "main")
                .cloned()
                .ok_or("tauri.conf.json declares no window labelled main")?;
            tauri::WebviewWindowBuilder::from_config(app, &config)?
                .on_navigation(is_our_own)
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("the Reemoat shell could not start");
}

#[cfg(test)]
mod tests {
    use super::is_our_own;
    use url::Url;

    fn at(raw: &str) -> bool {
        is_our_own(&Url::parse(raw).unwrap())
    }

    #[test]
    fn our_own_document_navigates() {
        assert!(at("tauri://localhost/"));
        assert!(at("tauri://localhost/m/m_ab12/s/s_cd34"));
        assert!(at("http://tauri.localhost/settings"));
    }

    /// The dev server, and the rule stated so it holds in **both** profiles.
    ///
    /// Written as an equality against `cfg!` rather than as two `#[cfg]` tests,
    /// because CI runs `cargo test` in debug only (`.github/workflows/check.yml`)
    /// and a release-only test there would assert nothing. This one fails in debug
    /// if the arm is deleted and in release if the `cfg!` is dropped, from one run.
    #[test]
    fn loopback_navigates_only_in_a_development_build() {
        let dev = cfg!(debug_assertions);
        assert_eq!(at("http://localhost:5173/"), dev);
        assert_eq!(at("http://127.0.0.1:5173/"), dev);
        // A control plane and a daemon are the two loopback services this app
        // actually meets, and a packaged build may navigate to neither.
        assert_eq!(at("http://127.0.0.1:7888/"), dev);
        assert_eq!(at("http://127.0.0.1:7887/sessions"), dev);
    }

    #[test]
    fn nothing_else_does() {
        for raw in [
            "https://evil.example/",
            "http://evil.example/",
            "file:///etc/passwd",
            "mailto:someone@example.com",
            "https://localhost.evil.example/",
        ] {
            assert!(!at(raw), "{raw} should not navigate this window");
        }
    }
}
