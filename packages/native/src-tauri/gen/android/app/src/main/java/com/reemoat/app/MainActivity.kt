/*
 * ⚠ **Hand-edited, and `tauri android init` overwrites this file.**
 *
 * The pristine template — embedded in `@tauri-apps/cli`, read out of it on
 * 2026-09-19 — is a `package` line, `import android.os.Bundle`, `import
 * androidx.activity.enableEdgeToEdge`, and a `MainActivity` whose whole
 * `onCreate` is `enableEdgeToEdge()` and then `super.onCreate`. The `Context`
 * import, the `System.loadLibrary` companion, the `external fun`, the call
 * placed *before* `super.onCreate`, and the `handleBackNavigation` override are
 * all this repository's, and an `init` re-run takes every one of them back out
 * saying nothing.
 *
 * ⚠ **And `init` is not a thing somebody chooses to run.**
 * `gen/android/tauri.settings.gradle` holds that computer's cargo registry
 * paths, so it is gitignored — and `settings.gradle` applies it during Gradle's
 * *settings evaluation*, before any project is configured. A clone fails there
 * until `init` writes it. The recipe that survives one is two commands, and
 * `.claude/rules/native-packaging.md` has both.
 *
 * `nativecheck` asserts each edit named above against this file's **code**:
 * measured on a pristine copy carrying only this banner, the three patterns
 * there were then all matched the prose and said `ok`.
 *
 * ⚠ **The back override is the one edit here with nothing to difference it
 * against.** The property it overrides and the Tauri override it reverses both
 * live in `app/src/main/java/com/reemoat/app/generated/`, which
 * `gen/android/app/.gitignore` ignores — so a `check`-job checkout does not
 * carry them and no offline driver may read them. What catches a wry release
 * that renamed or removed the property is the Kotlin compiler in the APK leg:
 * an `override` of nothing does not build.
 */
package com.reemoat.app

import android.content.Context
import android.os.Bundle
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
  /*
   * ⚠ **Back closed the app, from the first press, on every screen.**
   *
   * `WryActivity` ships the behaviour this wants: an `OnBackPressedCallback`
   * that calls `goBack()` while the webview `canGoBack()` and otherwise
   * disables itself and lets the activity finish. `TauriActivity` overrides
   * `handleBackNavigation` to `false`, so no callback is registered at all and
   * the platform default runs — `finish()`. On a phone that is the app quitting
   * instead of a session closing.
   *
   * ⚠ **This app is a pathname router and a Back press is a route pop.** Every
   * pop-up in it is a real entry: `router.ts`'s `navigate` is `pushState`, and
   * `nav.ts`'s `sheetKind` names the five routes that are drawn as panels over
   * a screen. So the webview's history *is* the app's back stack, and one press
   * leaving Settings — rather than the app — is what `.claude/rules/web-shell.md`
   * is written around. The last entry still closes the app, which is the
   * platform convention and is the `else` arm in wry's own callback.
   *
   * ⚠ **The override rather than a callback of our own.** A second
   * `onBackPressedDispatcher.addCallback` here would stack ahead of wry's and
   * the two would disagree about who finishes the activity; registering one and
   * leaving `handleBackNavigation` false means this file owns a policy wry
   * already implements. Reversing one `Boolean` is the whole edit.
   *
   * ⚠ **No `android:enableOnBackInvokedCallback` on the manifest, deliberately.**
   * That attribute opts into the *platform* `OnBackInvokedCallback` and the
   * predictive-back gesture from API 33 up; `OnBackPressedCallback` — which is
   * what wry registers and what `enableEdgeToEdge` already proves this activity
   * is `ComponentActivity` enough for — is dispatched on every level from
   * `minSdk` 24 up without it. Opting in is a fifth manifest attribute, a
   * gesture animation nobody has measured on this UI, and the row in
   * `.claude/rules/native-packaging.md` growing again.
   */
  override val handleBackNavigation: Boolean = true

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
