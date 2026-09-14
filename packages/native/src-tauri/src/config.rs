//! Which control plane this installation talks to.
//!
//! **Not a secret, and deliberately not in the keyring.** A server address is a
//! preference; the credential for it is the secret, and it lives in
//! `credential.rs` keyed on the origin this file stores. Keeping them apart is
//! what makes a machine whose keyring is unusable still remember *which* server
//! it was pointed at — it just asks for the password again.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use url::Url;

#[derive(Serialize, Deserialize, Default)]
struct Stored {
    server: Option<String>,
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
    fs::create_dir_all(dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    let text = serde_json::to_string_pretty(&Stored {
        server: Some(origin.to_string()),
    })
    .map_err(|e| e.to_string())?;
    fs::write(server_file(dir), text).map_err(|e| format!("could not write the server file: {e}"))
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
    use super::normalize_origin;

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
