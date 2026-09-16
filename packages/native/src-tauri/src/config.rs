//! Which control plane this installation talks to, and what that server calls it.
//!
//! **Not a secret, and deliberately not in the keyring.** A server address is a
//! preference; the credential for it is the secret, and it lives in
//! `credential.rs` keyed on the origin this file stores. Keeping them apart is
//! what makes a machine whose keyring is unusable still remember *which* server
//! it was pointed at — it just asks for the password again.
//!
//! **The device id is here for exactly that reason, and not beside the
//! credential.** It is an identifier the control plane handed back, not a secret:
//! holding one authorizes nothing, because every request still carries the
//! session token and the id is only read *after* that token has resolved. Put it
//! in the keyring instead and the cost lands precisely on the machines
//! `credential::probe` exists to detect — a Linux box with no unlocked collection
//! silently discards every write, so that installation would register a brand new
//! device on every launch and burn through the account's device limit without ever
//! reading one back. It would also put a second keychain read on the first-paint
//! path, which on an ad-hoc-signed development build is a second prompt per build.
//!
//! ⚠ This reverses the narrowest half of the "no device id" position
//! `credential.rs` still states — *"a value generated at first run and persisted
//! **is** device identity, arriving by accident"*. What changed is that it is no
//! longer an accident: the control plane has a `devices` table, the id comes from
//! there rather than from a local generator, and a person can see and retire the
//! row. The three refusals that entry makes *at the interface* — no `list()`, no
//! private key through a `String`, no first-run generation — all still stand, and
//! the keyring seam stays reserved for the device **key** that has none of these
//! properties.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use url::Url;

#[derive(Serialize, Deserialize, Default)]
struct Stored {
    server: Option<String>,
    /// The device this app is registered as, per server.
    ///
    /// **A map rather than one current value**, and that is the one place this
    /// file's shape departs from `credential.rs`'s. `host_set_server` erases the
    /// previous origin's *credential* because a credential this app will not
    /// present is one it has no reason to hold. The same act on a device id would
    /// be destructive rather than tidy: the row on that server is not deleted by
    /// anything here, so forgetting the id leaves an installation the person can
    /// no longer recognise in their own list and spends a second slot the next
    /// time they point back. Retaining it leaks nothing, because it is not a
    /// secret.
    ///
    /// `BTreeMap` rather than `HashMap` so the file is stable on disk — a
    /// preferences file that reorders itself on every write is one nobody can
    /// diff. Absent in every file written before this field existed, which
    /// `Default` answers with an empty map: no migration, and an app that has
    /// never registered is indistinguishable from one upgrading, correctly.
    #[serde(default)]
    devices: BTreeMap<String, String>,
}

pub fn server_file(dir: &Path) -> PathBuf {
    dir.join("server.json")
}

/// The stored origin, or `None`.
///
/// Every failure answers `None` — an unreadable or corrupt file is "no server
/// chosen", which lands on the picker. The alternative is an app that cannot be
/// started at all because of a file nobody can see, for a value one form re-enters.
pub fn read_server(dir: &Path) -> Option<String> {
    let text = fs::read_to_string(server_file(dir)).ok()?;
    let stored: Stored = serde_json::from_str(&text).ok()?;
    let server = stored.server?;
    // Re-normalized on the way out rather than trusted: the file is on disk and a
    // person can edit it, and every other rule here keys on the canonical form.
    normalize_origin(&server).ok()
}

pub fn write_server(dir: &Path, origin: &str) -> Result<(), String> {
    let mut stored = read_stored(dir);
    stored.server = Some(origin.to_string());
    write_stored(dir, &stored)
}

/// The whole file, or its defaults.
///
/// Every failure answers `Default`, which is `read_server`'s posture applied one
/// level up and for its reason: an unreadable or hand-edited file must land on
/// the picker and an empty device map, never stop the app starting. It is read
/// whole and written whole because the two fields are written by different acts —
/// choosing a server and registering a device — and a partial write would be the
/// one that silently discards the other.
fn read_stored(dir: &Path) -> Stored {
    fs::read_to_string(server_file(dir))
        .ok()
        .and_then(|text| serde_json::from_str::<Stored>(&text).ok())
        .unwrap_or_default()
}

fn write_stored(dir: &Path, stored: &Stored) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    let text = serde_json::to_string_pretty(stored).map_err(|e| e.to_string())?;
    fs::write(server_file(dir), text).map_err(|e| format!("could not write the server file: {e}"))
}

/// The device this installation is registered as on `origin`, or `None`.
///
/// Keyed on the **canonical** origin, exactly as the keyring account is, so one
/// server is one entry however its address was typed. A value stored under a
/// spelling `normalize_origin` no longer produces is simply never read — which is
/// the same cost a credential under a stale key already carries.
pub fn read_device(dir: &Path, origin: &str) -> Option<String> {
    read_stored(dir).devices.get(origin).cloned()
}

pub fn write_device(dir: &Path, origin: &str, device: &str) -> Result<(), String> {
    let mut stored = read_stored(dir);
    stored
        .devices
        .insert(origin.to_string(), device.to_string());
    write_stored(dir, &stored)
}

/// Give up the device recorded for one server.
///
/// Called when the control plane says that installation has been retired — at
/// which point keeping the id is actively harmful, because the next sign-in would
/// offer it again. The server refuses to bind a retired id and registers a fresh
/// device instead, so this is belt rather than the only guard; what it buys is
/// that the app stops presenting something it has been told is finished.
pub fn erase_device(dir: &Path, origin: &str) -> Result<(), String> {
    let mut stored = read_stored(dir);
    if stored.devices.remove(origin).is_none() {
        return Ok(());
    }
    write_stored(dir, &stored)
}

/// What somebody typed, turned into the one canonical spelling — or a sentence
/// saying why it is not an address.
///
/// **The canonical form is an origin**: scheme, host and a port only where it is
/// not the scheme's default. Everything else is dropped, because a path, a query
/// or a fragment on a control-plane address is a value that would make one server
/// look like two — and two spellings of one server means two credentials, one of
/// which a sign-out would not reach.
///
/// A missing scheme is **filled in** rather than refused. `isAbsoluteHttpUrl` in
/// `packages/web/src/instance.ts` refuses one, and it is right to: a scheme-less
/// value there becomes a *relative href* on the page's own origin. Here the value
/// can never become one — it is joined in this process against nothing — and a
/// form that refuses `my.server.example` refuses what everybody types.
///
/// The scheme is never normalized away. `http://` and `https://` are different
/// trust boundaries, and letting them share a credential key would hand a
/// plaintext origin the session minted for a TLS one.
pub fn normalize_origin(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("Type the address of a Reemoat server.".into());
    }
    let candidate = if trimmed.contains("://") {
        trimmed.to_string()
    } else {
        format!("https://{trimmed}")
    };
    let parsed = Url::parse(&candidate)
        .map_err(|_| format!("{trimmed} is not an address this can reach."))?;
    match parsed.scheme() {
        "http" | "https" => {}
        other => {
            return Err(format!(
                "{other}: is not a scheme this can reach. A Reemoat server is http or https."
            ))
        }
    }
    // A URL carrying a username or a password is refused rather than stripped:
    // silently dropping half of what somebody pasted is how a credential ends up
    // somewhere nobody meant to put it.
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("Leave the username and password out of the address.".into());
    }
    if parsed.host_str().is_none() {
        return Err("That address names no host.".into());
    }
    // `Url::origin()` answers a tuple that serializes to exactly scheme://host[:port],
    // with a default port omitted — which is the whole normalization, done by the
    // parser rather than by string work.
    let origin = parsed.origin().ascii_serialization();
    if origin == "null" {
        return Err("That address names no host.".into());
    }
    Ok(origin)
}

#[cfg(test)]
mod tests {
    use super::{
        erase_device, normalize_origin, read_device, read_server, write_device, write_server,
    };

    /// The property the map exists for: two servers, two devices, neither
    /// reachable from the other's origin.
    #[test]
    fn a_device_is_scoped_to_its_server() {
        let dir = std::env::temp_dir().join(format!("reemoat-cfg-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        write_server(&dir, "https://a.example").unwrap();
        write_device(&dir, "https://a.example", "dv_aaa").unwrap();
        write_device(&dir, "https://b.example", "dv_bbb").unwrap();

        assert_eq!(
            read_device(&dir, "https://a.example").as_deref(),
            Some("dv_aaa")
        );
        assert_eq!(
            read_device(&dir, "https://b.example").as_deref(),
            Some("dv_bbb")
        );
        assert_eq!(read_device(&dir, "https://c.example"), None);
        // And the server survives a device write — the two fields are written by
        // different acts and a partial write is the one that loses the other.
        assert_eq!(read_server(&dir).as_deref(), Some("https://a.example"));

        // Changing servers keeps both, which is where this deliberately differs
        // from the credential: the row on the old server still exists.
        write_server(&dir, "https://b.example").unwrap();
        assert_eq!(
            read_device(&dir, "https://a.example").as_deref(),
            Some("dv_aaa")
        );

        erase_device(&dir, "https://a.example").unwrap();
        assert_eq!(read_device(&dir, "https://a.example"), None);
        assert_eq!(
            read_device(&dir, "https://b.example").as_deref(),
            Some("dv_bbb")
        );
        // Erasing what is not there is the outcome the caller wanted.
        erase_device(&dir, "https://a.example").unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A file written before this field existed, and one somebody edited into
    /// nonsense: both answer "no device" rather than stopping the app.
    #[test]
    fn a_file_without_devices_reads_as_none() {
        let dir = std::env::temp_dir().join(format!("reemoat-cfg-old-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            super::server_file(&dir),
            r#"{"server":"https://a.example"}"#,
        )
        .unwrap();
        assert_eq!(read_server(&dir).as_deref(), Some("https://a.example"));
        assert_eq!(read_device(&dir, "https://a.example"), None);
        // And a device can still be added to it, which is the migration.
        write_device(&dir, "https://a.example", "dv_new").unwrap();
        assert_eq!(
            read_device(&dir, "https://a.example").as_deref(),
            Some("dv_new")
        );
        assert_eq!(read_server(&dir).as_deref(), Some("https://a.example"));

        std::fs::write(super::server_file(&dir), "not json at all").unwrap();
        assert_eq!(read_device(&dir, "https://a.example"), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn one_server_is_one_spelling() {
        for raw in [
            "https://a.example",
            "https://a.example/",
            "https://a.example/v1/login",
            "  https://a.example  ",
            "https://A.EXAMPLE",
            "https://a.example:443",
            "a.example",
            "https://a.example?x=1#y",
        ] {
            assert_eq!(normalize_origin(raw).unwrap(), "https://a.example", "{raw}");
        }
    }

    #[test]
    fn the_scheme_is_part_of_the_identity() {
        assert_eq!(
            normalize_origin("http://a.example").unwrap(),
            "http://a.example"
        );
        assert_ne!(
            normalize_origin("http://a.example").unwrap(),
            normalize_origin("https://a.example").unwrap()
        );
        // A non-default port stays, because it is part of which server this is.
        assert_eq!(
            normalize_origin("https://a.example:8443").unwrap(),
            "https://a.example:8443"
        );
        assert_eq!(
            normalize_origin("http://a.example:80").unwrap(),
            "http://a.example"
        );
    }

    #[test]
    fn what_is_refused() {
        for raw in [
            "",
            "   ",
            "ftp://a.example",
            "file:///etc/passwd",
            "https://u:p@a.example",
        ] {
            assert!(normalize_origin(raw).is_err(), "{raw} should be refused");
        }
    }
}
