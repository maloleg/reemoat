//! The control-plane credential, at rest.
//!
//! **Keyed on the server's origin, and that is the whole of the scoping rule.**
//! A browser gets this for free — one origin, one `localStorage` — and a native
//! shell does not: there is one webview origin for every server somebody might
//! point this app at. So the origin is the *lookup key*, which means a credential
//! cannot be read for a server it was not issued by. Structurally, rather than
//! because a code path remembered to clear it on a change.
//!
//! What is never stored here: the person's password (there is no "remember me" —
//! `POST /v1/me/password` asks for the current one whichever credential presents,
//! and a stored password would make that a formality), and any daemon credential.
//! A machine token is 300 seconds long and derived; it belongs in
//! `packages/web/src/machine.ts` and nowhere near an OS keyring.

use keyring::Entry;

/// One constant, because Windows keys on a target string and macOS on
/// service+account, and two spellings would be two stores on two platforms.
const SERVICE: &str = "com.reemoat.app";

/// Every secret this app keeps, and there is one.
///
/// A named set with a single member rather than a string at each call site, so
/// adding a second is a visible edit in one place. There is deliberately **no
/// device id** here: a value generated at first run and persisted *is* device
/// identity, arriving by accident, and it would be a new fact about a person that
/// nothing in this fleet has agreed to record.
pub const CREDENTIAL: &str = "credential";

/// What a secret store has to do, and pointedly not more.
///
/// A trait with one implementation, for the reason `SessionRuntime` is one in the
/// daemon: it is the seam a second platform arrives through, and it costs nothing
/// now. `keyring`'s Android support is behind its own feature with a different API
/// and iOS reaches the Apple keychain by a third path, so scattering
/// `Entry::new(…)` through the commands is precisely what would make a mobile arm
/// expensive later.
///
/// ⚠ **`read` and `write` carry a `String`, which is what says a private key may
/// not use them.** A key this process can read is a key this process can leak, so
/// the future shape for one is a `sign(key, bytes)` that never returns it, backed
/// by the Secure Enclave or a TPM. That is named here and built nowhere.
///
/// And there is no `list`. Enumerating is what a device-key rotation would want,
/// and shipping the verb now is shipping the feature.
pub trait SecretStore {
    fn read(&self, key: &str, scope: &str) -> Option<String>;
    fn write(&self, key: &str, scope: &str, value: &str) -> Result<(), String>;
    fn erase(&self, key: &str, scope: &str) -> Result<(), String>;
}

/// The one implementation: the platform's own credential store.
pub struct PlatformStore;

impl SecretStore for PlatformStore {
    fn read(&self, key: &str, scope: &str) -> Option<String> {
        let entry = entry(&account_for(key, scope)).ok()?;
        match entry.get_password() {
            Ok(value) if !value.is_empty() => Some(value),
            // Absent, locked, or a store that answered an error: all of them mean
            // "ask for the password again", which is a working degraded mode.
            _ => None,
        }
    }

    fn write(&self, key: &str, scope: &str, value: &str) -> Result<(), String> {
        entry(&account_for(key, scope))?
            .set_password(value)
            .map_err(|e| format!("could not save the sign-in: {e}"))
    }

    fn erase(&self, key: &str, scope: &str) -> Result<(), String> {
        let entry = entry(&account_for(key, scope))?;
        match entry.delete_credential() {
            Ok(()) => Ok(()),
            // Deleting what is not there is the outcome the caller wanted.
            Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(format!("could not clear the sign-in: {e}")),
        }
    }
}

/// `#` as the delimiter, chosen rather than defaulted: a URL origin cannot
/// contain one, so "the key is the origin" needs no escaping to be unambiguous —
/// and a later `credential#<origin>#<account>` is an extension of this shape
/// rather than a migration away from it.
fn account_for(key: &str, scope: &str) -> String {
    format!("{key}#{scope}")
}

fn entry(account: &str) -> Result<Entry, String> {
    Entry::new(SERVICE, account).map_err(|e| format!("no credential store: {e}"))
}

/* The control-plane credential, which is the only secret this app has. Thin
 * wrappers rather than the trait at every call site, because the commands read
 * better for it and the seam is still one type away. */

pub fn read(origin: &str) -> Option<String> {
    PlatformStore.read(CREDENTIAL, origin)
}

pub fn write(origin: &str, value: &str) -> Result<(), String> {
    PlatformStore.write(CREDENTIAL, origin, value)
}

pub fn erase(origin: &str) -> Result<(), String> {
    PlatformStore.erase(CREDENTIAL, origin)
}

/// Whether this machine's store actually keeps what it is given.
///
/// **A probe, never a `cfg!`.** macOS and Windows always have a store; a Linux
/// box may have no D-Bus session or no unlocked collection, and `keyring`'s
/// secret-service backend then fails at runtime on a build that compiled fine.
/// Worse, a store that *accepts* a write and loses it is the failure that reads
/// as working — so this writes a canary, reads it back, compares it and erases
/// it, and only a full round trip counts as durable.
///
/// What the app does with a `false` is say so, in the sentence `cp.ts` already
/// has for a browser with storage disabled: it still works for one session, it
/// just asks for the password again next time. One state, one sentence, from one
/// place — two spellings of one state is a defect this repository has shipped
/// before.
pub fn probe() -> bool {
    let store = PlatformStore;
    let canary = "reemoat-durability-probe";
    // A scope no origin can normalize to, so the probe can never collide with a
    // real server's entry: a normalized origin always carries its scheme, and this
    // has none. (`normalize_origin` would *accept* this string as input and answer
    // `https://probe.invalid`, which is a different value — that is the point.)
    let scope = "probe.invalid";
    if store.write(CREDENTIAL, scope, canary).is_err() {
        return false;
    }
    let round_tripped = store.read(CREDENTIAL, scope).as_deref() == Some(canary);
    let _ = store.erase(CREDENTIAL, scope);
    round_tripped
}

#[cfg(test)]
mod tests {
    use super::account_for;

    #[test]
    fn the_scope_is_the_key() {
        assert_eq!(
            account_for("credential", "https://a.example"),
            "credential#https://a.example"
        );
        assert_ne!(
            account_for("credential", "https://a.example"),
            account_for("credential", "https://b.example")
        );
        // The scheme is part of the identity, so these are two entries.
        assert_ne!(
            account_for("credential", "http://a.example"),
            account_for("credential", "https://a.example")
        );
    }
}
