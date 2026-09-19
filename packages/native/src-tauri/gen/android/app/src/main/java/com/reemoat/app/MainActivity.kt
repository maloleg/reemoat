/*
 * ⚠ **Hand-edited, and `tauri android init` overwrites this file.**
 *
 * The pristine template — embedded in `@tauri-apps/cli`, read out of it on
 * 2026-09-19 — is a `package` line, `import android.os.Bundle`, `import
 * androidx.activity.enableEdgeToEdge`, and a `MainActivity` whose whole
 * `onCreate` is `enableEdgeToEdge()` and then `super.onCreate`. The `Context`
 * import, the `System.loadLibrary` companion, the `external fun`, and the call
 * placed *before* `super.onCreate` are all this repository's, and an `init`
 * re-run takes every one of them back out saying nothing.
 *
 * ⚠ **And `init` is not a thing somebody chooses to run.**
 * `gen/android/tauri.settings.gradle` holds that computer's cargo registry
 * paths, so it is gitignored — and `settings.gradle` applies it during Gradle's
 * *settings evaluation*, before any project is configured. A clone fails there
 * until `init` writes it. The recipe that survives one is two commands, and
 * `.claude/rules/native-packaging.md` has both.
 *
 * `nativecheck` asserts each edit named above against this file's **code**:
 * measured on a pristine copy carrying only this banner, the same three
 * patterns all matched the prose and said `ok`.
 */
package com.reemoat.app

import android.content.Context
import android.os.Bundle
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
  companion object {
    /*
     * Loaded here rather than left to `super.onCreate`, because `initNdkContext`
     * below has to resolve before that call rather than after it.
     * `System.loadLibrary` is idempotent, so the load Tauri does anyway is a
     * no-op.
     */
    init {
      System.loadLibrary("reemoat_native_lib")
    }
  }

  /** `credential.rs`'s `Java_com_reemoat_app_MainActivity_initNdkContext`. */
  private external fun initNdkContext(context: Context)

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    /*
     * ⚠ **Before `super.onCreate`, and the order is the whole of it.**
     *
     * `TauriActivity.onCreate` is what calls into Rust and runs `run()`, which
     * runs `setup()`, which reaches the credential store. The store reads the
     * Android context out of `ndk-context` — and **nothing in this dependency
     * tree ever sets it**: `initialize_android_context` is called by
     * `ndk-context` itself and by the keyring store's own Kotlin companion,
     * which is not in this APK. Tauri, tao and wry call it never.
     *
     * Measured: with this line absent the first Android build panicked inside
     * `setup` and the app died on launch, before drawing anything.
     * `credential.rs` refuses to abort on it now, so getting the *store* half
     * wrong costs a sign-in that is not remembered rather than an app that will
     * not open — but this is what makes it remembered.
     *
     * ⚠ **It is two handles now, and the second has no degraded mode.** The same
     * function also hands the JVM to `rustls-platform-verifier`, which is what
     * `reqwest` verifies TLS with on Android and which reads nothing
     * `ndk-context` holds — a different crate with a different handle, so "the
     * context is already set" is not an answer for it. Without that call the
     * **first** `/v1` request reaches
     * `.expect("Expect rustls-platform-verifier to be initialized")` inside the
     * rustls handshake, and nobody signs in at all. So deleting this line now
     * costs the whole app rather than one convenience.
     *
     * ⚠ **This ordering is what `credential.rs` assumes and cannot state.**
     * "Before Tauri" is enforced here, and `nativecheck` compares the two
     * indices below. "Earliest in the process" is *not* enforced: Android
     * instantiates this package's content providers — the manifest's
     * `FileProvider` and `lifecycle-process`'s `InitializationProvider` —
     * before any activity. It holds anyway because neither loads
     * `libreemoat_native_lib.so`: the only two `System.loadLibrary` calls are
     * the companion above and the generated `Rust` object's, and the built
     * library exports no `JNI_OnLoad` (measured on the `.so`'s `.dynsym`). A
     * `Service`, a `BroadcastReceiver` or a provider of this app's own that
     * reached the credential store or a TLS call would end that, and the repair
     * is to **move** this call rather than add a second one: `ndk-context`'s
     * slot may be written once, and a second write is an abort.
     *
     * `applicationContext`, not `this`: the store outlives the activity.
     */
    initNdkContext(applicationContext)
    super.onCreate(savedInstanceState)
  }
}
