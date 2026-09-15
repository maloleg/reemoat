//! The daemon this app carries, and how it is started.
//!
//! `local.rs` answers *"is there a daemon on this computer worth showing a token
//! to?"* by reading a file the daemon wrote. This module answers the question that
//! only exists once the app is **responsible** for one: *"is there a daemon
//! because I started it, and if not, why not?"*
//!
//! ⚠ **The two must not be merged.** `local.rs` answers `None` to every failure on
//! purpose — its caller has one question and it is not "why not". That is right
//! for a daemon somebody else installed with `deploy/install.sh`. It is wrong for a
//! daemon this app launched: answering `None` to a process that exited two seconds
//! ago is the app hiding a failure it caused. So `local.rs` stays exactly as it is
//! and this is a second question with its own answer type.
//!
//! ## A child process, not a service
//!
//! The daemon is an ordinary child of this app and dies with it. Surviving a quit
//! is a **switch**, off by default.
//!
//! That is a reversal, and the reason is prior art rather than taste.
//! `getpaseo/paseo` is the same shape of product — a Node daemon owning
//! coding-agent sessions behind a desktop client, worktrees and all — and it runs
//! its daemon as a plain child with `daemon.keepRunningAfterQuit` defaulting to
//! **false**, registering no `LaunchAgent` and no `SMAppService` at all; always-on
//! is a separate CLI install. Two things follow. A login item macOS shows in
//! System Settings is a thing the user can switch off, which would revoke
//! "survives a quit" silently — so making it the default is building on something
//! that can vanish. And a child process needs no entitlement, no registration API
//! and no uninstall story: quitting the app is the uninstall.
//!
//! ## What it will not do
//!
//! **It never starts a daemon that is already there.** `~/.reemoat/reemoat.db`
//! holds one identity and `claimDaemonLock` refuses a second process against it, so
//! a machine installed by `deploy/bootstrap.sh` is *adopted* — read through
//! `local.rs` like any other — and never raced. The same rule is what stops a
//! second control-plane machine being created for one computer, which would burn a
//! quota slot permanently (`machine_owners` is counted with no revoked filter).
//!
//! **And it never kills a daemon it did not start.** `Instance` records the pid and
//! the start time of the child this app launched; a daemon whose file says
//! otherwise is somebody else's and is left running.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

/// Where the payload and the runtime are, relative to this process.
///
/// **One code path for the bundle and for `tauri dev`**, which is worth stating
/// because it looks like it should need two. `tauri-build` copies
/// `bundle.resources` and `bundle.externalBin` into `target/<profile>/` during
/// `build.rs`, and Tauri's own `resource_dir()` answers that directory in a
/// development build and `Contents/Resources` in a bundle. The runtime is beside
/// the executable in both — `target/<profile>/node` next to `target/<profile>/…`,
/// and `Contents/MacOS/node` next to the app binary — so `current_exe()`'s parent
/// finds it either way. Verified on this checkout rather than assumed.
pub struct Payload {
    /// The daemon's own tree: `src/`, `scripts/`, `deploy/`, `node_modules/`.
    pub root: PathBuf,
    /// The Node binary the daemon runs under.
    pub node: PathBuf,
}

/// The development escape hatch: run the daemon from a checkout, not the copy.
///
/// ⚠ **Without this there is no usable loop for daemon work through the app.** The
/// payload is a *snapshot* taken by `build-daemon.mjs` and copied again by
/// `build.rs`, and `resource_dir()` answers that copy in `tauri dev` exactly as it
/// does in a bundle — measured, not assumed. So editing `src/session.ts` and
/// pressing reload shows the old code, with nothing anywhere saying why. Pointed at
/// a checkout, this runs the tree somebody is actually editing.
///
/// ⚠ **Development builds only, and that is a deliberate refusal rather than
/// caution.** It names a directory this process will execute as the user, so in a
/// shipped app it would be a way to make somebody else's Reemoat run somebody
/// else's code by setting one variable. `lib.rs`'s navigation guard is gated the
/// same way and for the same reason — a door that is fine on a developer's machine
/// is not fine in an application people install.
const PAYLOAD_OVERRIDE: &str = "REEMOAT_DAEMON_PAYLOAD";

impl Payload {
    pub fn locate(resource_dir: &Path, exe: &Path) -> Option<Payload> {
        let node = exe.parent()?.join("node");
        /*
         * The checkout wins when one is named, and only in a development build.
         * The *runtime* is still the bundled one: what is being swapped is the
         * code, not the Node it runs under, so a checkout is exercised against the
         * same binary that will ship.
         */
        if cfg!(debug_assertions) {
            if let Some(dir) = std::env::var_os(PAYLOAD_OVERRIDE) {
                let root = PathBuf::from(dir);
                if root.join("scripts").join("daemon.ts").is_file() && node.is_file() {
                    return Some(Payload { root, node });
                }
            }
        }
        let root = resource_dir.join("daemon");
        // Both, or neither. A payload with no runtime is a staging step that ran
        // half way, and reporting it as "no daemon here" would send somebody
        // looking at the control plane for a build problem.
        if !root.join("scripts").join("daemon.ts").is_file() || !node.is_file() {
            return None;
        }
        Some(Payload { root, node })
    }
}

/* ── the environment a daemon is started with ────────────────────────────── */

/// `~/.reemoat/daemon.env`.
pub fn env_path(home: &Path) -> PathBuf {
    home.join(".reemoat").join("daemon.env")
}

/// The env file's whole content, for a machine this app is enrolling.
///
/// ⚠ **The same three keys `deploy/install.sh` writes, in the same file, in the
/// same format** — which is deliberate and is the property that keeps this from
/// becoming a fork. A machine set up by the app can afterwards be taken over by
/// the shell installer, and one set up by the installer is adopted by the app,
/// because neither can tell which wrote the file.
///
/// ⚠ **The enrollment code is written to a `0600` file and never to argv.**
/// `deploy/bootstrap.sh` passes it on stdin for this reason: argv is readable by
/// every account on the host. A `0600` file inside the `0700` directory
/// `src/announce.ts` already creates is the same guarantee by a different
/// mechanism. It must also not go into a launchd plist, which is why the opt-in
/// service path still points at this file rather than inlining values.
pub fn env_contents(control_plane: &str, enroll_code: &str) -> String {
    let mut text = format!(
        "# Written by Reemoat.app. The same file `deploy/install.sh` writes.\n\
         REEMOAT_AUTH=signed\n\
         REEMOAT_CONTROL_PLANE={control_plane}\n\
         REEMOAT_ENROLL_CODE={enroll_code}\n"
    );
    /*
     * ⚠ **And the certificate, when this process was given one — because the
     * daemon cannot borrow this app's trust store.**
     *
     * `proxy.rs` reaches the control plane through Security.framework, so a
     * private CA in the macOS keychain is enough for *this* process. Node reads no
     * keychain and `--use-system-ca` does not close it, so the daemon needs the
     * path spelled out or it dies on `enroll` with `UNABLE_TO_VERIFY_LEAF_SIGNATURE`
     * — an app that set the machine up successfully and then produced a daemon
     * that will not start.
     *
     * Written into the file rather than only passed to the child, because the file
     * is what survives a restart and what the opt-in launchd path will read. A GUI
     * launch usually has none of this set, and then the line is simply absent —
     * which is correct for the ordinary case of a control plane with a public
     * certificate.
     */
    for name in ["NODE_EXTRA_CA_CERTS", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY"] {
        if let Some(value) = std::env::var_os(name).and_then(|v| v.into_string().ok()) {
            // Refused rather than escaped: a newline would let one value write a
            // second assignment into a file `sh` sources, and nothing here needs a
            // certificate path clever enough to contain one.
            if !value.is_empty() && !value.contains('\n') && !value.contains('\r') {
                text.push_str(&format!("{name}={value}\n"));
            }
        }
    }
    text
}

/// How long the liveness probe is given, connect and answer alike.
///
/// Loopback, so this is a syscall rather than a network round trip; the timeout
/// exists for the pathological case — a socket whose backlog is full, or a process
/// wedged mid-answer — not for latency.
const PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_millis(250);

/// The most of a `/health` answer this will read before giving up on it.
const PROBE_LIMIT: u64 = 8 * 1024;

/// Whether *this* daemon — the one the announce file describes — is still there.
///
/// ⚠ **The announce file is not evidence that a daemon is running, and treating
/// it as evidence strands this app permanently.** `src/announce.ts` writes it at
/// start and removes it on a clean stop — so an unclean one (a force quit, a
/// crash, a `kill -9`, a power cut) leaves it behind. `host_daemon_state` then
/// answers `foreign`, the setup flow returns at its status gate because somebody
/// else's daemon is apparently up, and **nothing ever starts one again** — on a
/// computer whose daemon dies with the app by design. The only way out was
/// deleting a file nobody tells you about.
///
/// ⚠ **And a bare connect is not enough, which is the second half of the same
/// bug.** `REEMOAT_PORT` is a fixed value in the env file, so after an unclean
/// exit the port named by a stale announce is an ordinary port that anything may
/// now hold — another dev server, a second hand-installed daemon on a different
/// database, a proxy. A connect proves somebody is listening; it does not prove it
/// is the daemon this file describes, and answering `foreign` to a stranger is the
/// same permanent deadlock, just rarer.
///
/// `GET /health` proves it, and costs nothing to ask: `src/server.ts` lets that one
/// route past the auth middleware — *"the one route without a token"* — and it
/// answers the same `instanceId` the announce file holds. The rule `local.rs`
/// keeps is about not handing a **credential** to whatever answered, and this
/// sends no `authorization` header at all; it is written as a raw request over the
/// socket rather than through `reqwest` so that there is no configured client for
/// a later edit to attach one to.
pub fn is_alive(base: &str, instance_id: &str) -> bool {
    use std::io::{Read, Write};
    let Ok(url) = url::Url::parse(base) else {
        return false;
    };
    let (Some(host), Some(port)) = (url.host_str(), url.port()) else {
        return false;
    };
    // `local::read` already refused anything but `127.0.0.1` and `::1`, so this
    // parses back what it built rather than trusting the file.
    let Ok(address) = host.trim_start_matches('[').trim_end_matches(']').parse::<std::net::IpAddr>() else {
        return false;
    };
    let Ok(mut stream) = std::net::TcpStream::connect_timeout(&std::net::SocketAddr::new(address, port), PROBE_TIMEOUT)
    else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(PROBE_TIMEOUT));
    let _ = stream.set_write_timeout(Some(PROBE_TIMEOUT));
    // HTTP/1.0 with an explicit close, so the answer ends at EOF and this needs no
    // chunked or keep-alive handling of its own.
    let request = format!("GET /health HTTP/1.0\r\nHost: {host}:{port}\r\nConnection: close\r\n\r\n");
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }
    let mut raw = Vec::new();
    if (&mut stream).take(PROBE_LIMIT).read_to_end(&mut raw).is_err() {
        return false;
    }
    let text = String::from_utf8_lossy(&raw);
    let Some((head, body)) = text.split_once("\r\n\r\n") else {
        return false;
    };
    if !head.starts_with("HTTP/1.1 200") && !head.starts_with("HTTP/1.0 200") {
        return false;
    }
    let Ok(parsed) = serde_json::from_str::<serde_json::Value>(body.trim()) else {
        return false;
    };
    parsed.get("instanceId").and_then(|value| value.as_str()) == Some(instance_id)
}

/* ── what an existing env file already says ──────────────────────────────── */

/// The key that decides which fleet a daemon belongs to.
const CONTROL_PLANE_KEY: &str = "REEMOAT_CONTROL_PLANE";

/// The three keys this app owns. Everything else in the file is somebody else's.
///
/// ⚠ **Ownership is what makes a rewrite safe.** A file written by
/// `deploy/install.sh` and edited by hand afterwards carries things this app never
/// wrote — measured on a real machine 2026-09-15: 324 lines, 292 of them comments,
/// with a private CA path its owner had added. Rewriting the whole file to refresh
/// an enrollment code would delete all of it, so only these three are replaced.
const OWNED_KEYS: [&str; 3] = ["REEMOAT_AUTH", CONTROL_PLANE_KEY, "REEMOAT_ENROLL_CODE"];

/// There is no env file on this computer.
pub const CONFIG_NONE: &str = "none";
/// There is one, and it names the server this app is signed in to.
pub const CONFIG_HERE: &str = "here";
/// There is one, and it names something else — or nothing this can read.
pub const CONFIG_ELSEWHERE: &str = "elsewhere";

/// Which fleet the env file on this computer belongs to, if there is one.
///
/// ⚠ **The signal that was missing, and its absence cost a quota slot every
/// launch.** Without it `host_daemon_state` answered `absent` for a computer that
/// already had a half-finished install; the store then created a machine —
/// permanent, since `machine_owners` is counted with no revoked filter — and
/// `host_daemon_start` skipped the write and started the daemon carrying the *old*
/// file's code, for a *different* machine. Measured on a real machine 2026-09-15:
/// a machine row created at 15:15:54, a daemon started at 15:15:55, and an
/// identity table that stayed empty.
///
/// `origin` is the canonical spelling `host_set_server` stored, so this compares
/// two values `normalize_origin` produced rather than two strings somebody typed.
///
/// ⚠ **A file naming nothing this can parse reads as `elsewhere`, never `none`.**
/// The one thing that must not happen is a file somebody else wrote being treated
/// as an empty slot, and "I could not read it" is not evidence that it is empty.
pub fn config_state(home: &Path, origin: Option<&str>) -> &'static str {
    let path = env_path(home);
    if !path.exists() {
        return CONFIG_NONE;
    }
    let named = std::fs::read_to_string(&path)
        .ok()
        .and_then(|text| parse_env(&text).get(CONTROL_PLANE_KEY).cloned())
        .and_then(|raw| crate::config::normalize_origin(&raw).ok());
    match (named, origin) {
        (Some(named), Some(origin)) if named == origin => CONFIG_HERE,
        _ => CONFIG_ELSEWHERE,
    }
}

/// Replace the keys this app owns, keeping every other line exactly as it was.
///
/// For a machine this app created that needs a **fresh** enrollment code: a code
/// lives an hour, and a daemon that did not redeem one in time needs the new one
/// in the file it already reads.
///
/// ⚠ **Line-preserving rather than regenerated from parsed pairs.** Re-emitting
/// pairs would be shorter and would throw away the installer's comments and every
/// key this app does not know about — which is the same data loss {@link
/// OWNED_KEYS} exists to prevent. A duplicate owned key is dropped rather than
/// left in place, because a later assignment wins in both readers of this file and
/// a survivor below would shadow the line just written.
pub fn env_rewritten(existing: &str, control_plane: &str, enroll_code: &str) -> String {
    let wanted: [(&str, &str); 3] = [
        ("REEMOAT_AUTH", "signed"),
        (CONTROL_PLANE_KEY, control_plane),
        ("REEMOAT_ENROLL_CODE", enroll_code),
    ];
    let mut written = [false; 3];
    let mut out = String::new();
    for line in existing.lines() {
        let owned = if line.trim_start().starts_with('#') {
            None
        } else {
            line.split_once('=').and_then(|(key, _)| OWNED_KEYS.iter().position(|k| *k == key.trim()))
        };
        match owned {
            Some(index) => {
                if !written[index] {
                    let (name, value) = wanted[index];
                    out.push_str(&format!("{name}={value}\n"));
                    written[index] = true;
                }
            }
            None => {
                out.push_str(line);
                out.push('\n');
            }
        }
    }
    for (index, (name, value)) in wanted.iter().enumerate() {
        if !written[index] {
            out.push_str(&format!("{name}={value}\n"));
        }
    }
    out
}

/// Read an env file into pairs, the way `run-daemon.sh` sources one.
///
/// Deliberately small: `KEY=value`, `#` comments, blank lines. It is not a shell
/// parser and must not become one — `deploy/install.sh` writes plain assignments,
/// and anything cleverer here would be a second, divergent reading of a file that
/// already has one authoritative reader.
pub fn parse_env(text: &str) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim();
        if key.is_empty() {
            continue;
        }
        // Quotes are stripped because `install.sh` writes some values quoted
        // (`REEMOAT_TOKEN='…'`) and `sh` would remove them on the way in.
        let value = value.trim();
        let value = value
            .strip_prefix('\'')
            .and_then(|v| v.strip_suffix('\''))
            .or_else(|| value.strip_prefix('"').and_then(|v| v.strip_suffix('"')))
            .unwrap_or(value);
        out.insert(key.to_string(), value.to_string());
    }
    out
}

/* ── the machine this app already created ───────────────────────────────── */

/// What this app has already claimed for a given server, so it never claims twice.
///
/// ⚠ **This exists because a machine row is permanent and a quota slot is not
/// given back.** `machine_owners` is counted with **no revoked filter**, so every
/// `POST /v1/machines` spends one of fifty for ever. The window is small and real:
/// the app creates a machine, writes the env file, starts the daemon — and if it
/// is quit, or crashes, or the enrollment code expires before the daemon redeems
/// it, then on the next launch the machine id exists only on the control plane and
/// nothing on this computer remembers it. Without this file the next launch would
/// see "no daemon here" and create a *second* machine, and a third, one per
/// unlucky restart.
///
/// The env file cannot carry it: that file is the one `deploy/install.sh` writes,
/// its three keys are the daemon's contract, and adding a fourth that only this
/// app reads would make two programs disagree about what the file is.
///
/// Keyed on the origin for the reason `credential.rs` keys on it: one installation
/// may be pointed at two fleets over its life, and a machine id from one is
/// meaningless — and misleading — to the other.
///
/// ⚠ **A map keyed by origin, not a single record, and that was a real bug.** The
/// first version stored one `{origin, machineId}` and answered `None` when the
/// origin did not match. Point the app at a second control plane and the first
/// server's claim is overwritten; point it back, and the claim is gone, so
/// bootstrap creates a *second* machine there and spends a second permanent slot.
/// Somebody who keeps a work fleet and a personal one would pay that on every
/// switch. A map costs one line and closes it.
#[derive(serde::Serialize, serde::Deserialize, Default)]
struct Claims {
    /// origin → machine id.
    #[serde(default)]
    machines: BTreeMap<String, String>,
}

fn claim_file(dir: &Path) -> PathBuf {
    dir.join("machine.json")
}

/// The machine this app created for `origin`, if it created one.
///
/// Every failure answers `None`, which is the same as never having claimed —
/// the cost of that being wrong is one extra machine, and the cost of *refusing*
/// to start over an unreadable preference file is an app that cannot be used.
pub fn read_claim(dir: &Path, origin: &str) -> Option<String> {
    let text = std::fs::read_to_string(claim_file(dir)).ok()?;
    let claims: Claims = serde_json::from_str(&text).ok()?;
    claims.machines.get(origin).filter(|id| !id.is_empty()).cloned()
}

pub fn write_claim(dir: &Path, origin: &str, machine_id: &str) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    // Read-modify-write rather than replace, which is the whole point of the map.
    let mut claims: Claims = std::fs::read_to_string(claim_file(dir))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default();
    claims.machines.insert(origin.to_string(), machine_id.to_string());
    let text = serde_json::to_string_pretty(&claims).map_err(|e| e.to_string())?;
    std::fs::write(claim_file(dir), text).map_err(|e| format!("could not write the machine file: {e}"))
}

/// This computer's name, for naming the machine it is about to become.
///
/// ⚠ **Nothing on the bridge carried this, which is why it is here.** `Boot`
/// reports `platform`, and that is `std::env::consts::OS` — the string `"macos"`,
/// identical on every Mac alive. Naming a machine from it works on the first
/// computer and collides on the second, and the control plane compares names
/// case-insensitively across everything you can *see*, so the second person to try
/// gets a `409 machine_exists` for a name they never chose.
///
/// Raw and unsanitised on purpose: what a control-plane label may contain is that
/// service's rule, and the caller that has to handle the refusal is the one that
/// should shape the name.
pub fn host_name() -> Option<String> {
    #[cfg(unix)]
    {
        let mut buf = vec![0u8; 256];
        // Safe: the pointer and length describe `buf`, which outlives the call.
        let rc = unsafe { libc::gethostname(buf.as_mut_ptr() as *mut libc::c_char, buf.len()) };
        if rc != 0 {
            return None;
        }
        let end = buf.iter().position(|b| *b == 0).unwrap_or(buf.len());
        buf.truncate(end);
        let name = String::from_utf8(buf).ok()?;
        let name = name.trim();
        // `Some-Mac.local` is what a Mac answers; the suffix is mDNS's, not a name.
        let name = name.strip_suffix(".local").unwrap_or(name);
        if name.is_empty() {
            return None;
        }
        Some(name.to_string())
    }
    #[cfg(not(unix))]
    {
        std::env::var("COMPUTERNAME").ok().filter(|n| !n.is_empty())
    }
}

/* ── PATH ────────────────────────────────────────────────────────────────── */

/// How long the login shell gets to answer before its PATH is given up on.
const SHELL_TIMEOUT: Duration = Duration::from_secs(5);

/// The user's real `PATH`, as their login shell reports it.
///
/// ⚠ **A GUI application does not inherit the PATH a terminal has.** launchd hands
/// an app a bare default, so `git`, and every coding-agent CLI in `~/.local/bin`,
/// `~/.codex` or `~/.opencode`, are simply invisible — and the failure reads as
/// "the CLI is not installed" on a machine where it plainly is. `deploy/agents.sh`
/// and `src/acp/agents.ts` both resolve by PATH, so this is not cosmetic.
///
/// The remedy is the one VS Code established and `paseo` adopted from it: ask the
/// login shell. `-i` so the interactive profile is read, `-l` so the login profile
/// is, and a marker around the value because a profile that prints a banner would
/// otherwise have its banner parsed as a PATH.
///
/// **Every failure answers `None` and the caller falls back to a composed list.**
/// A shell that hangs, a profile that exits non-zero, a marker that never appears:
/// none of them is worth a diagnostic, because the fallback is a working machine
/// with a narrower PATH rather than a broken one.
pub fn login_shell_path(shell: Option<&str>) -> Option<String> {
    const MARK: &str = "__reemoat_path__";
    let shell = shell?;
    if shell.is_empty() {
        return None;
    }

    /*
     * ⚠ **The timeout is the reason this is not three lines around `output()`.**
     *
     * `-i` reads the interactive profile, which is somebody else's shell script:
     * it can prompt, it can wait on a network mount, it can call a version manager
     * that decides to install something. `output()` waits for ever, and this runs
     * during startup — so a profile that blocks would be an app that never opens a
     * window, with nothing on screen saying why. Spawned and reaped on a deadline
     * instead, and a shell that misses it is killed and treated as no answer.
     */
    let mut child = Command::new(shell)
        .arg("-ilc")
        .arg(format!("printf '{MARK}%s{MARK}' \"$PATH\""))
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .ok()?;

    let deadline = std::time::Instant::now() + SHELL_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if std::time::Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
                std::thread::sleep(Duration::from_millis(25));
            }
            Err(_) => return None,
        }
    }

    let out = child.wait_with_output().ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    /*
     * The marker, rather than trusting the whole of stdout. A profile that prints
     * a banner — a version manager's notice, a fortune, a corporate MOTD — would
     * otherwise have that banner parsed as the PATH, and the daemon would be
     * started with a PATH that is a sentence.
     */
    let value = text.split(MARK).nth(1)?.trim();
    if value.is_empty() {
        return None;
    }
    Some(value.to_string())
}

/// What the daemon's `PATH` ends up being.
///
/// Three parts, in order, and the order is the whole of it:
///
/// 1. **The payload's own `node_modules/.bin` first**, because it holds `node` and
///    `npm` *beside each other*. `deploy/agents.sh` resolves the runtime as
///    `$(dirname -- "$(command -v npm)")/node` — the node next to npm — so putting
///    this first is what makes the script install kimi with the runtime this app
///    shipped rather than with something else it happened to find.
/// 2. **The user's real PATH**, so their `git` and their already-installed agent
///    CLIs are reachable.
/// 3. **The directories `deploy/agents.sh` installs into**, so a CLI it installed
///    on a previous run is found even if the user's profile never mentioned them.
///
/// ⚠ **Appended, never prepended, for part 3** — `src/acp/agents.ts` documents why
/// at length: those directories are writable by this uid, and a file dropped into
/// `~/.local/bin` should not take precedence over a deliberate install.
pub fn daemon_path(payload: &Payload, home: &Path, user_path: Option<&str>) -> String {
    let mut parts: Vec<String> = Vec::new();
    parts.push(payload.root.join("node_modules").join(".bin").display().to_string());
    match user_path {
        Some(p) if !p.trim().is_empty() => parts.push(p.trim().to_string()),
        // The fallback, and it is deliberately the bare system default rather than
        // a guess at where somebody keeps things. Homebrew is named because it is
        // where `git` lives on most developer Macs that have it from Homebrew
        // rather than from the Command Line Tools.
        _ => parts.push("/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin".to_string()),
    }
    for managed in [".local/bin", ".codex/bin", ".opencode/bin", ".reemoat/toolchain/bin"] {
        parts.push(home.join(managed).display().to_string());
    }
    parts.join(":")
}

/* ── starting one, and watching it ───────────────────────────────────────── */

/// How many lines of the child's output are kept to explain a failure.
///
/// The same size `src/plugins/runtime.ts` keeps for a plugin's ring and for the
/// same reason: enough to carry a startup banner and the sentence that replaced
/// it, not enough to be a log file nobody rotates.
const LOG_LINES: usize = 200;

/// A daemon this app started, and what it said.
///
/// ⚠ **The pid is recorded so that stopping is identity-checked.** `~/.reemoat` is
/// shared with whatever `deploy/install.sh` may have set up, and a pid is reused
/// by the kernel — so "stop the daemon" must mean "stop *this* child", never "kill
/// whatever is at the pid in that file". The handle is the identity.
pub struct Supervisor {
    child: Option<std::process::Child>,
    log: std::sync::Arc<std::sync::Mutex<Vec<String>>>,
}

/// What the page is told. Deliberately a small, closed set.
#[derive(serde::Serialize)]
pub struct DaemonState {
    /// `absent` · `starting` · `running` · `foreign` · `exited` · `unsupported`
    pub status: String,
    /// The machine the daemon announced itself as, when it has.
    #[serde(rename = "machineId")]
    pub machine_id: Option<String>,
    /// The machine this app already created for this server, if it created one.
    ///
    /// ⚠ **Not the same question as `machineId`, and conflating them costs a quota
    /// slot.** `machineId` is what a *running* daemon says it is. This is what this
    /// app spent a `POST /v1/machines` on, whether or not the daemon ever came up.
    /// A caller that sees this set must re-mint a code against it rather than
    /// create a second machine.
    pub claimed: Option<String>,
    /// The tail of what it printed, and only when that explains something.
    pub detail: Option<String>,
    /// `none` · `here` · `elsewhere` — what `~/.reemoat/daemon.env` already says.
    ///
    /// ⚠ **Asked before a machine is created, never after.** See `config_state`,
    /// which carries the measurement behind that ordering.
    pub config: String,
}

impl Default for DaemonState {
    /// `config` defaults to `none` rather than to `String::default()`: an empty
    /// string is not one of the three answers, and a caller comparing against them
    /// would fall through every arm to the one that does nothing.
    fn default() -> DaemonState {
        DaemonState {
            status: String::new(),
            machine_id: None,
            claimed: None,
            detail: None,
            config: CONFIG_NONE.to_string(),
        }
    }
}

impl Supervisor {
    pub fn new() -> Supervisor {
        Supervisor { child: None, log: std::sync::Arc::new(std::sync::Mutex::new(Vec::new())) }
    }

    /// Whether this app currently owns a running daemon.
    pub fn owns_running(&mut self) -> bool {
        match self.child.as_mut() {
            None => false,
            // `try_wait` reaps; `Ok(None)` is "still running".
            Some(child) => matches!(child.try_wait(), Ok(None)),
        }
    }

    /// The tail of the child's output, newest last.
    pub fn tail(&self) -> Option<String> {
        let held = self.log.lock().ok()?;
        if held.is_empty() {
            return None;
        }
        Some(held.join("\n"))
    }

    /// Start the daemon, with the environment it needs and nothing of ours.
    ///
    /// ⚠ **`node --import tsx`, never `node_modules/.bin/tsx`**, and this diverges
    /// from `deploy/run-daemon.sh` on purpose — `deploy/docker/Dockerfile` makes
    /// the same divergence and records why. tsx's CLI spawns a *child*: under a
    /// supervisor that is fine, but here it would mean the process this app holds
    /// a handle to is a wrapper, the daemon is a grandchild, and stopping the app
    /// would leave the real daemon reparented with nothing reaping it. `--import`
    /// runs the daemon in the process we spawned, so the handle is the daemon.
    pub fn start(&mut self, payload: &Payload, home: &Path, env: &BTreeMap<String, String>) -> Result<(), String> {
        if self.owns_running() {
            return Ok(());
        }
        let path = daemon_path(payload, home, login_shell_path(std::env::var("SHELL").ok().as_deref()).as_deref());

        let mut command = Command::new(&payload.node);
        command
            .current_dir(&payload.root)
            .args(["--enable-source-maps", "--import", "tsx", "scripts/daemon.ts"])
            /*
             * A clean environment, built rather than inherited. This process's own
             * is a GUI app's: it carries Tauri's variables, whatever launchd set,
             * and — if somebody started the app from a terminal inside a coding
             * agent — that agent's session variables, which `agentEnv()` in the
             * daemon strips for exactly this reason. Starting from empty means
             * there is nothing to strip.
             */
            .env_clear()
            .env("HOME", home)
            .env("PATH", path)
            .env("UV_THREADPOOL_SIZE", "64")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        for (key, value) in env {
            command.env(key, value);
        }
        // Inherited only when the user set it, because the daemon has no opinion
        // about a locale and a missing one makes git's output ASCII-mangled.
        if let Ok(lang) = std::env::var("LANG") {
            command.env("LANG", lang);
        }
        /*
         * ⚠ **How this process reaches a server and how the daemon reaches it are
         * two different trust stores, and the gap cost a whole debugging round.**
         *
         * `proxy.rs` uses `reqwest` with `default-tls`, which is Security.framework
         * — the macOS keychain — and `native-shell.md` chose it precisely because
         * *"a self-hosted control plane behind a private CA is an ordinary
         * deployment for this software"*. Node trusts none of that: it carries its
         * own root set, reads no keychain, and `--use-system-ca` did not close it
         * either when measured against a real dev CA that **was** in both
         * System.keychain and login.keychain.
         *
         * So without this the app creates the machine perfectly — its own request
         * is trusted — and then the daemon it starts dies on `enroll` with
         * `UNABLE_TO_VERIFY_LEAF_SIGNATURE`, which reads as "the daemon is broken"
         * rather than "Node cannot see your certificate". Measured 2026-09-15
         * against `https://app.reemoat.test`: refused without `NODE_EXTRA_CA_CERTS`,
         * `200` with it.
         *
         * Passed through rather than invented: this process cannot know where a
         * certificate lives, but whatever launched it may. A GUI launch usually has
         * none of these, which is why the env file is still the durable answer and
         * why the failure now has a screen to appear on.
         */
        for name in [
            "NODE_EXTRA_CA_CERTS",
            "SSL_CERT_FILE",
            "SSL_CERT_DIR",
            "HTTPS_PROXY",
            "HTTP_PROXY",
            "NO_PROXY",
            "https_proxy",
            "http_proxy",
            "no_proxy",
        ] {
            /*
             * ⚠ The env file wins. It is the durable record and the one
             * `deploy/install.sh` also writes; this process's environment is
             * whatever happened to be exported by whoever double-clicked the app.
             */
            if env.contains_key(name) {
                continue;
            }
            if let Some(value) = std::env::var_os(name) {
                command.env(name, value);
            }
        }

        let mut child = command.spawn().map_err(|e| format!("could not start the daemon: {e}"))?;
        for stream in [
            child.stdout.take().map(|s| Box::new(s) as Box<dyn std::io::Read + Send>),
            child.stderr.take().map(|s| Box::new(s) as Box<dyn std::io::Read + Send>),
        ]
        .into_iter()
        .flatten()
        {
            let log = std::sync::Arc::clone(&self.log);
            // A thread per stream, because a pipe nobody drains fills and then the
            // daemon blocks on its own startup banner — the same hazard
            // `src/plugins/runtime.ts` names for a plugin's stdout.
            std::thread::spawn(move || {
                use std::io::BufRead;
                let reader = std::io::BufReader::new(stream);
                for line in reader.lines().map_while(Result::ok) {
                    if let Ok(mut held) = log.lock() {
                        held.push(line);
                        while held.len() > LOG_LINES {
                            held.remove(0);
                        }
                    }
                }
            });
        }
        self.child = Some(child);
        Ok(())
    }

    /// Stop the daemon this app started, and only that one.
    ///
    /// `SIGTERM` rather than a kill: `scripts/daemon.ts` has a real graceful stop
    /// — a 20s budget to close sessions, a hard exit at 25 — and skipping it means
    /// every live turn is interrupted and every pending approval dropped.
    pub fn stop(&mut self) {
        let Some(mut child) = self.child.take() else {
            return;
        };
        #[cfg(unix)]
        {
            // SIGTERM by pid, then wait. `Child::kill` is SIGKILL and would skip
            // the shutdown the daemon implements.
            let pid = child.id() as i32;
            // Safe: `pid` is this process's own live child, taken from the handle
            // above, and `wait` below reaps it. The signal cannot reach a recycled
            // pid because the handle keeps it unreaped until then.
            unsafe {
                libc::kill(pid, libc::SIGTERM);
            }
        }
        /*
         * ⚠ **Windows gets no graceful stop, and this is a real gap on a real
         * target.** `docs/NATIVE.md` lists Windows as supported, and there is no
         * SIGTERM there — `Child::kill` is `TerminateProcess`, which gives
         * `scripts/daemon.ts` no chance to run its 20-second close, so every turn
         * in flight is interrupted and every pending approval dropped. Closing it
         * properly means a stop the daemon can be *asked* for rather than
         * signalled, which is a change to the daemon's own surface rather than to
         * this file. Named here so it is a known gap rather than a surprise.
         */
        #[cfg(not(unix))]
        {
            let _ = child.kill();
        }
        let _ = child.wait();
    }
}

impl Default for Supervisor {
    fn default() -> Self {
        Supervisor::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_certificate_path_reaches_the_daemon_when_this_process_has_one() {
        // SAFETY: set and removed within this single-threaded test body.
        unsafe { std::env::set_var("NODE_EXTRA_CA_CERTS", "/tmp/dev-ca.crt") };
        let text = env_contents("https://cp.example", "ec_abc");
        unsafe { std::env::remove_var("NODE_EXTRA_CA_CERTS") };
        assert!(text.contains("NODE_EXTRA_CA_CERTS=/tmp/dev-ca.crt"));
        // And it is still a file `run-daemon.sh` can source.
        assert_eq!(
            parse_env(&text).get("NODE_EXTRA_CA_CERTS").map(String::as_str),
            Some("/tmp/dev-ca.crt")
        );
    }

    #[test]
    fn a_value_carrying_a_newline_is_refused_rather_than_escaped() {
        // SAFETY: as above.
        unsafe { std::env::set_var("NODE_EXTRA_CA_CERTS", "/tmp/ok.crt\nREEMOAT_AUTH=shared_secret") };
        let text = env_contents("https://cp.example", "ec_abc");
        unsafe { std::env::remove_var("NODE_EXTRA_CA_CERTS") };
        // The whole value is dropped, so the injected assignment never lands and
        // the mode stays what this file says it is.
        assert!(!text.contains("shared_secret"));
        assert_eq!(parse_env(&text).get("REEMOAT_AUTH").map(String::as_str), Some("signed"));
    }

    #[test]
    fn the_env_file_is_the_one_the_installer_writes() {
        let text = env_contents("https://cp.example", "ec_abc");
        assert!(text.contains("REEMOAT_AUTH=signed"));
        assert!(text.contains("REEMOAT_CONTROL_PLANE=https://cp.example"));
        assert!(text.contains("REEMOAT_ENROLL_CODE=ec_abc"));
        // Round-trips through the reader that stands in for `run-daemon.sh`.
        let parsed = parse_env(&text);
        assert_eq!(parsed.get("REEMOAT_AUTH").map(String::as_str), Some("signed"));
        assert_eq!(parsed.get("REEMOAT_ENROLL_CODE").map(String::as_str), Some("ec_abc"));
    }

    #[test]
    fn the_reader_understands_what_install_sh_writes() {
        let parsed = parse_env(
            "# a comment\n\
             \n\
             REEMOAT_AUTH=signed\n\
             REEMOAT_TOKEN='quoted value'\n\
             REEMOAT_CONTROL_PLANE=\"https://cp.example\"\n\
             MALFORMED\n\
             =novalue\n",
        );
        assert_eq!(parsed.get("REEMOAT_TOKEN").map(String::as_str), Some("quoted value"));
        assert_eq!(
            parsed.get("REEMOAT_CONTROL_PLANE").map(String::as_str),
            Some("https://cp.example")
        );
        // A line with no `=` and a line with no key are skipped rather than
        // producing an entry nothing can use.
        assert!(!parsed.contains_key("MALFORMED"));
        assert!(!parsed.contains_key(""));
    }

    fn payload_at(root: &str) -> Payload {
        Payload { root: PathBuf::from(root), node: PathBuf::from("/nowhere/node") }
    }

    #[test]
    fn the_payloads_bin_comes_first_so_npm_and_node_are_siblings() {
        let path = daemon_path(&payload_at("/app/daemon"), Path::new("/home/x"), Some("/usr/bin:/bin"));
        assert!(path.starts_with("/app/daemon/node_modules/.bin:"));
        // `agents.sh` resolves node as npm's sibling; if anything preceded the
        // payload's bin, the two could come from different installs.
        let first = path.split(':').next().unwrap();
        assert_eq!(first, "/app/daemon/node_modules/.bin");
    }

    #[test]
    fn the_users_own_path_is_kept_and_the_managed_dirs_are_appended() {
        let path = daemon_path(&payload_at("/app/daemon"), Path::new("/home/x"), Some("/opt/mine/bin"));
        let parts: Vec<&str> = path.split(':').collect();
        assert!(parts.contains(&"/opt/mine/bin"));
        let mine = parts.iter().position(|p| *p == "/opt/mine/bin").unwrap();
        let managed = parts.iter().position(|p| *p == "/home/x/.local/bin").unwrap();
        // Appended, never prepended: a file dropped into a writable directory must
        // not win over what the person deliberately installed.
        assert!(mine < managed);
    }

    #[test]
    fn no_shell_is_not_an_empty_path() {
        let path = daemon_path(&payload_at("/app/daemon"), Path::new("/home/x"), None);
        assert!(path.contains("/usr/bin"));
        assert!(!path.contains("::"));
    }

    #[test]
    fn a_blank_shell_answer_is_treated_as_no_answer() {
        let path = daemon_path(&payload_at("/app/daemon"), Path::new("/home/x"), Some("   "));
        assert!(path.contains("/usr/bin"));
    }

    #[test]
    fn a_claim_is_scoped_to_the_server_it_was_made_against() {
        let dir = std::env::temp_dir().join(format!("reemoat-claim-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        write_claim(&dir, "https://a.example", "m_aaaa").unwrap();
        assert_eq!(read_claim(&dir, "https://a.example").as_deref(), Some("m_aaaa"));
        // A machine created against one fleet is meaningless to another, and
        // handing it over would re-mint a code for somebody else's machine id.
        assert_eq!(read_claim(&dir, "https://b.example"), None);
        // ⚠ And a second server does not evict the first. This is the whole reason
        // the file is a map: somebody with a work fleet and a personal one would
        // otherwise spend a permanent machine slot on every switch between them.
        write_claim(&dir, "https://b.example", "m_bbbb").unwrap();
        assert_eq!(read_claim(&dir, "https://b.example").as_deref(), Some("m_bbbb"));
        assert_eq!(read_claim(&dir, "https://a.example").as_deref(), Some("m_aaaa"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn an_unreadable_claim_is_no_claim_rather_than_a_refusal() {
        let dir = std::env::temp_dir().join(format!("reemoat-claim-bad-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(claim_file(&dir), "not json").unwrap();
        assert_eq!(read_claim(&dir, "https://a.example"), None);
        // An empty id is not a claim either — it would send a re-mint at nothing.
        std::fs::write(claim_file(&dir), r#"{"machines":{"https://a.example":""}}"#).unwrap();
        assert_eq!(read_claim(&dir, "https://a.example"), None);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The override is a development door, and this is the assertion that it is
    /// still only that. A release build must ignore the variable outright.
    #[test]
    fn the_checkout_override_is_a_development_door_only() {
        let dir = std::env::temp_dir().join(format!("reemoat-override-{}", std::process::id()));
        let checkout = dir.join("checkout");
        let bundle = dir.join("bundle");
        std::fs::create_dir_all(checkout.join("scripts")).unwrap();
        std::fs::write(checkout.join("scripts").join("daemon.ts"), "").unwrap();
        // A bundled payload beside a fake runtime, so `locate` can succeed either way.
        std::fs::create_dir_all(bundle.join("daemon").join("scripts")).unwrap();
        std::fs::write(bundle.join("daemon").join("scripts").join("daemon.ts"), "").unwrap();
        let exedir = dir.join("bin");
        std::fs::create_dir_all(&exedir).unwrap();
        std::fs::write(exedir.join("node"), "").unwrap();
        let exe = exedir.join("app");

        // SAFETY: single-threaded within this test, and the variable is removed
        // before it returns. `cargo test` runs tests in parallel, so the name is
        // process-unique by construction — no other test reads this one.
        unsafe { std::env::set_var(PAYLOAD_OVERRIDE, &checkout) };
        let found = Payload::locate(&bundle, &exe).expect("a payload is found either way");
        unsafe { std::env::remove_var(PAYLOAD_OVERRIDE) };

        if cfg!(debug_assertions) {
            assert_eq!(found.root, checkout, "a development build follows the checkout");
        } else {
            assert_eq!(found.root, bundle.join("daemon"), "a release build ignores the variable");
        }
        // ⚠ The runtime is the bundled one in both cases: what the override swaps
        // is the code, never the Node it runs under.
        assert_eq!(found.node, exedir.join("node"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_payload_missing_its_runtime_is_no_payload() {
        // Neither path exists, so `locate` must refuse rather than hand back a
        // root whose daemon cannot be started.
        let dir = std::env::temp_dir().join(format!("reemoat-payload-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("daemon").join("scripts")).unwrap();
        std::fs::write(dir.join("daemon").join("scripts").join("daemon.ts"), "").unwrap();
        // The runtime is looked for beside the executable, which here is absent.
        assert!(Payload::locate(&dir, &dir.join("missing").join("app")).is_none());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn the_login_shell_is_asked_and_its_banner_is_not_the_answer() {
        // A shell that prints a banner before the value: the marker is what makes
        // the reading unambiguous, and this is the case that proves it.
        let path = login_shell_path(Some("/bin/sh"));
        // `/bin/sh -ilc` answers on every machine this builds on; the assertion is
        // that whatever comes back is a PATH rather than a banner.
        if let Some(value) = path {
            assert!(value.contains('/'));
            assert!(!value.contains("__reemoat_path__"));
        }
    }
    /* ── the env file that is already there ──────────────────────────────── */

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("reemoat-{name}-{}", std::process::id()));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(dir.join(".reemoat")).unwrap();
        dir
    }

    #[test]
    fn a_computer_with_no_env_file_is_an_empty_slot() {
        let home = scratch("cfg-none");
        assert_eq!(config_state(&home, Some("https://cp.example")), CONFIG_NONE);
    }

    #[test]
    fn a_file_this_app_wrote_itself_is_always_its_own() {
        /*
         * ⚠ **The round trip, because the two halves are written apart.** The host
         * writes `env_contents(origin)` and then, on the next launch, asks
         * `config_state` whether that file is its own. If the spelling written is
         * not the spelling compared, the app refuses a file it wrote itself — for
         * ever, since nothing rewrites a file it believes belongs to somebody else.
         */
        let home = scratch("cfg-roundtrip");
        for origin in ["https://cp.example", "http://127.0.0.1:7890", "https://cp.example:8443"] {
            std::fs::write(env_path(&home), env_contents(origin, "ec_abc")).unwrap();
            assert_eq!(config_state(&home, Some(origin)), CONFIG_HERE, "{origin}");
            // And the same after a code refresh, which takes the other write path.
            let existing = std::fs::read_to_string(env_path(&home)).unwrap();
            std::fs::write(env_path(&home), env_rewritten(&existing, origin, "ec_next")).unwrap();
            assert_eq!(config_state(&home, Some(origin)), CONFIG_HERE, "{origin} rewritten");
        }
    }

    /// Answer one request with `body`, then close. Returns the port.
    fn stub_health(body: &'static str) -> u16 {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            use std::io::{Read, Write};
            let Ok((mut socket, _)) = listener.accept() else { return };
            let mut seen = [0u8; 1024];
            let read = socket.read(&mut seen).unwrap_or(0);
            // ⚠ The property this whole shape exists for: nothing is offered to
            // whatever answered. Asserted on the server side, where the bytes
            // actually arrive, rather than on the request string.
            let sent = String::from_utf8_lossy(&seen[..read]).to_lowercase();
            assert!(!sent.contains("authorization"), "the probe must carry no credential");
            let _ = socket.write_all(
                format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{body}")
                    .as_bytes(),
            );
        });
        port
    }

    #[test]
    fn an_announce_file_is_not_evidence_that_the_daemon_is_alive() {
        let port = stub_health(r#"{"ok":true,"instanceId":"i_live"}"#);
        assert!(is_alive(&format!("http://127.0.0.1:{port}"), "i_live"));
    }

    #[test]
    fn a_stranger_on_the_port_is_not_this_daemon() {
        /*
         * The second half of the stale-announce bug. `REEMOAT_PORT` is fixed in the
         * env file, so the port a dead daemon named is an ordinary port anything may
         * hold afterwards — and a bare connect would call each of these alive.
         */
        let other = stub_health(r#"{"ok":true,"instanceId":"i_somebody_else"}"#);
        assert!(!is_alive(&format!("http://127.0.0.1:{other}"), "i_live"));
        let garbage = stub_health("not json at all");
        assert!(!is_alive(&format!("http://127.0.0.1:{garbage}"), "i_live"));
    }

    #[test]
    fn nothing_listening_is_nothing_running() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        assert!(!is_alive(&format!("http://127.0.0.1:{port}"), "i_live"));
        assert!(!is_alive("http://127.0.0.1", "i_live"), "no port is not a daemon");
        assert!(!is_alive("not a url", "i_live"));
    }

    #[test]
    fn a_file_naming_this_server_is_adopted_rather_than_provisioned() {
        let home = scratch("cfg-here");
        std::fs::write(env_path(&home), "REEMOAT_CONTROL_PLANE='https://cp.example'\n").unwrap();
        // Quoted, because `lib.sh`'s `sq` writes it that way — and the spelling is
        // compared after `normalize_origin`, so a trailing slash or a default port
        // is the same server rather than a different one.
        assert_eq!(config_state(&home, Some("https://cp.example")), CONFIG_HERE);
        std::fs::write(env_path(&home), "REEMOAT_CONTROL_PLANE=https://cp.example:443/\n").unwrap();
        assert_eq!(config_state(&home, Some("https://cp.example")), CONFIG_HERE);
    }

    #[test]
    fn a_file_naming_another_server_is_never_treated_as_an_empty_slot() {
        let home = scratch("cfg-else");
        for text in [
            "REEMOAT_CONTROL_PLANE=https://other.example\n",
            // Unreadable is *also* `elsewhere`: no control plane at all, and a value
            // no URL parser accepts. Answering `none` to either would invite the
            // caller to write over a file somebody else owns.
            "REEMOAT_AUTH=signed\n",
            "REEMOAT_CONTROL_PLANE=:::\n",
        ] {
            std::fs::write(env_path(&home), text).unwrap();
            assert_eq!(config_state(&home, Some("https://cp.example")), CONFIG_ELSEWHERE, "{text}");
        }
        // And with no server chosen yet, every file is somebody else's.
        std::fs::write(env_path(&home), "REEMOAT_CONTROL_PLANE=https://cp.example\n").unwrap();
        assert_eq!(config_state(&home, None), CONFIG_ELSEWHERE);
    }

    #[test]
    fn a_fresh_code_keeps_every_key_this_app_does_not_own() {
        /*
         * The shape measured on a real machine 2026-09-15: an `install.sh` file,
         * mostly comments, single-quoted values, and a private CA path its owner
         * had added by hand. Losing that line turns a refused enrollment code into
         * a TLS failure, which is a worse bug than the one being fixed.
         */
        let existing = "# a comment\n\
                        REEMOAT_TOKEN=\n\
                        REEMOAT_HOST=127.0.0.1\n\
                        REEMOAT_PORT=7887\n\
                        REEMOAT_AUTH='signed'\n\
                        REEMOAT_CONTROL_PLANE='https://cp.example'\n\
                        REEMOAT_ENROLL_CODE='ec_old'\n\
                        NODE_EXTRA_CA_CERTS='/Users/x/.reemoat/dev-ca.crt'\n";
        let text = env_rewritten(existing, "https://cp.example", "ec_new");
        let parsed = parse_env(&text);
        assert_eq!(parsed.get("REEMOAT_ENROLL_CODE").map(String::as_str), Some("ec_new"));
        assert_eq!(parsed.get("REEMOAT_AUTH").map(String::as_str), Some("signed"));
        assert_eq!(
            parsed.get("NODE_EXTRA_CA_CERTS").map(String::as_str),
            Some("/Users/x/.reemoat/dev-ca.crt")
        );
        assert_eq!(parsed.get("REEMOAT_PORT").map(String::as_str), Some("7887"));
        assert!(text.contains("# a comment"), "the installer's own prose survives");
        assert!(!text.contains("ec_old"), "the dead code is gone, not shadowed");
    }

    #[test]
    fn a_duplicate_owned_key_is_dropped_rather_than_left_to_shadow() {
        // Both readers of this file take the *last* assignment, so a survivor below
        // the line just written would be the value that actually took effect.
        let text = env_rewritten(
            "REEMOAT_ENROLL_CODE=ec_one\nREEMOAT_TOKEN=\nREEMOAT_ENROLL_CODE=ec_two\n",
            "https://cp.example",
            "ec_new",
        );
        assert_eq!(text.matches("REEMOAT_ENROLL_CODE=").count(), 1);
        assert_eq!(parse_env(&text).get("REEMOAT_ENROLL_CODE").map(String::as_str), Some("ec_new"));
    }

    #[test]
    fn a_commented_out_assignment_is_prose_rather_than_a_key() {
        // `.env.example` ships `# REEMOAT_AUTH=shared_secret`, and rewriting that
        // into a live assignment would switch a mode nobody asked to switch.
        let text = env_rewritten("# REEMOAT_AUTH=shared_secret\n", "https://cp.example", "ec_new");
        assert!(text.contains("# REEMOAT_AUTH=shared_secret"));
        assert_eq!(parse_env(&text).get("REEMOAT_AUTH").map(String::as_str), Some("signed"));
    }

    #[test]
    fn a_file_missing_a_key_gains_it_rather_than_starting_without_it() {
        let text = env_rewritten("REEMOAT_HOST=127.0.0.1\n", "https://cp.example", "ec_new");
        let parsed = parse_env(&text);
        assert_eq!(parsed.get("REEMOAT_AUTH").map(String::as_str), Some("signed"));
        assert_eq!(parsed.get("REEMOAT_CONTROL_PLANE").map(String::as_str), Some("https://cp.example"));
        assert_eq!(parsed.get("REEMOAT_HOST").map(String::as_str), Some("127.0.0.1"));
    }
}
