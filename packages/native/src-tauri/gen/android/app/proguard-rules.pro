# ⚠ **Hand-edited, and `tauri android init` overwrites this file.** The
# template embedded in `@tauri-apps/cli` ends at the
# `#-renamesourcefileattribute` line below; everything after it is this
# repository's. So an `init` re-run deletes the keep rule and nothing says so —
# the debug build is unaffected, `isMinifyEnabled` being false there, and only a
# signed release fails, at run time, on every TLS connection.
#
# `init` is not optional on a new machine: `gen/android/tauri.settings.gradle`
# holds that computer's cargo registry paths and is gitignored, and
# `settings.gradle` applies it. `.claude/rules/native-packaging.md` has the
# two-command recipe that survives one; `nativecheck` asserts this file's
# comment-stripped code, which is why this paragraph cannot pass for the rule.

# Add project specific ProGuard rules here.
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# If your project uses WebView with JS, uncomment the following
# and specify the fully qualified class name to the JavaScript interface
# class:
#-keepclassmembers class fqcn.of.javascript.interface.for.webview {
#   public *;
#}

# Uncomment this to preserve the line number information for
# debugging stack traces.
#-keepattributes SourceFile,LineNumberTable

# If you keep the line number information, uncomment this to
# hide the original source file name.
#-renamesourcefileattribute SourceFile
# ⚠ **R8 strips a class only JNI reaches, and the symptom is every TLS
# connection failing in a signed build while debug works.**
#
# `reqwest` resolves to rustls with `rustls-platform-verifier` on Android
# (Cargo.toml says why there is no OpenSSL), and the verifier calls
# `org.rustls.platformverifier.CertificateVerifier` with `FindClass` from
# `libreemoat_native_lib.so`. Proguard cannot see a JNI use, so with
# `isMinifyEnabled = true` it removed all five of that package's classes —
# measured on this checkout: `outputs/mapping/universalRelease/usage.txt` listed
# them as removed, `classes.dex` carried zero occurrences, and the `.so` still
# carried the class name it was about to look up. Debug builds were unaffected
# (`isMinifyEnabled = false`), which is what makes this the shape the rule calls
# "compiles, links and ships before anybody notices".
#
# The Gradle dependency in `app/build.gradle.kts` is the other half of one
# decision; `nativecheck` asserts the pair.
-keep, includedescriptorclasses class org.rustls.platformverifier.** { *; }
