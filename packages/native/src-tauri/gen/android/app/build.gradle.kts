/*
 * ⚠ **Hand-edited, and `tauri android init` overwrites this file.**
 *
 * Three things below are in no template and are this repository's: the
 * `signingConfigs` block with the conditional `signingConfig` in `release`, the
 * `repositories { maven … }` block that asks cargo where the
 * `rustls-platform-verifier` `.aar` is, and the dependency on it. Compared
 * against the `build.gradle.kts` embedded in `@tauri-apps/cli` on 2026-09-19:
 * it carries none of them. An `init` re-run therefore produces a release APK
 * that is unsigned and whose every TLS connection fails at run time — and it
 * compiles, links and ships.
 *
 * ⚠ **`init` is not optional on a new machine.**
 * `gen/android/tauri.settings.gradle` holds that computer's cargo registry
 * paths, so it is gitignored, and `settings.gradle` applies it during Gradle's
 * *settings evaluation*: a clone fails there before any project is configured.
 * `.claude/rules/native-packaging.md` carries the two-command recipe that
 * survives an `init`, and `nativecheck` asserts each edge above against this
 * file's **code** — this banner names all three, so read raw it would satisfy
 * them by itself.
 */
import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("rust")
}

val tauriProperties = Properties().apply {
    val propFile = file("tauri.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

android {
    compileSdk = 36
    namespace = "com.reemoat.app"
    defaultConfig {
        applicationId = "com.reemoat.app"
        minSdk = 24
        targetSdk = 36
        versionCode = tauriProperties.getProperty("tauri.android.versionCode", "1").toInt()
        versionName = tauriProperties.getProperty("tauri.android.versionName", "1.0")
    }
    /*
     * **Environment only, and that is `signingIdentity: null`'s rule on the
     * platform that spells it differently.** No keystore, no path to one and no
     * password is in this repository; a release runner decodes one secret into
     * `$RUNNER_TEMP` and exports the four names below, and
     * `deploy/ci-release.sh`'s `app` verb refuses the android target unless all
     * four are set.
     */
    signingConfigs {
        create("release") {
            val store = System.getenv("ANDROID_KEYSTORE_PATH")
            if (store != null) {
                storeFile = file(store)
                storePassword = System.getenv("ANDROID_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("ANDROID_KEY_ALIAS")
                keyPassword = System.getenv("ANDROID_KEY_PASSWORD")
            }
        }
    }
    buildTypes {
        getByName("debug") {
            isDebuggable = true
            isJniDebuggable = true
            isMinifyEnabled = false
            packaging {                jniLibs.keepDebugSymbols.add("*/arm64-v8a/*.so")
                jniLibs.keepDebugSymbols.add("*/armeabi-v7a/*.so")
                jniLibs.keepDebugSymbols.add("*/x86/*.so")
                jniLibs.keepDebugSymbols.add("*/x86_64/*.so")
            }
        }
        getByName("release") {
            /*
             * ⚠ **Conditional, so a build with no secrets still works.** Setting
             * `signingConfig` unconditionally makes `tauri android build` fail on
             * any machine without the four variables — which is every machine but
             * a release runner, and is the same reason a macOS build with no
             * identity is ad-hoc signed rather than refused.
             */
            if (System.getenv("ANDROID_KEYSTORE_PATH") != null) {
                signingConfig = signingConfigs.getByName("release")
            }
            isMinifyEnabled = true
            proguardFiles(
                *fileTree(".") { include("**/*.pro") }
                    .plus(getDefaultProguardFile("proguard-android-optimize.txt"))
                    .toList().toTypedArray()
            )
        }
    }
    kotlinOptions {
        jvmTarget = "1.8"
    }
    buildFeatures {
        buildConfig = true
    }
}

rust {
    rootDirRel = "../../../"
}

/*
 * **`rustls-platform-verifier` is a Rust crate with a Kotlin half, and without
 * this block every TLS connection fails at run time.**
 *
 * `reqwest`'s `default-tls` resolves to rustls with that verifier on Android —
 * measured, `cargo tree` carries no `openssl-sys` at all — and the verifier calls
 * `org.rustls.platformverifier.CertificateVerifier` over JNI. That class ships as
 * an `.aar` inside the `rustls-platform-verifier-android` crate, so the crate's
 * own directory is the Maven repository.
 *
 * Located by asking cargo rather than by writing a path down: the answer is under
 * `CARGO_HOME`, which differs per machine and per checkout, and a literal here
 * would be this computer's path in everybody's build.
 *
 * ⚠ **The version is read from that same answer, and it used to be
 * `latest.release`.** Upstream's README recommends that string and gives the
 * reason: *"We always use the latest release because cargo keeps it in sync with
 * the associated Rust crate's version."* That reasoning holds for a build whose
 * only repository is the on-disk one. This is not that build. The root
 * `gen/android/build.gradle.kts` declares `allprojects { repositories { google();
 * mavenCentral() } }`, and an `allprojects` block is evaluated before a
 * subproject's own — so the coordinate was looked for in two public repositories
 * first, and `latest.release` means *the highest version any of them offers*.
 * Anybody who publishes `rustls:rustls-platform-verifier` to Maven Central with a
 * larger number wins the build, and what wins is a Kotlin `.aar` loaded into the
 * process that holds the fleet's credential.
 *
 * ⚠ **A pin does not close that on its own, which is why `exclusiveContent` is
 * here and not just a version string.** A pinned `0.1.1` is still *looked for* in
 * `google()` and `mavenCentral()` before this directory, so the same coordinate
 * published there at the same version still wins. `exclusiveContent` states the
 * two things that are actually true: the `rustls` group comes from this directory
 * and nowhere else, and this directory serves only that group. The fence decides
 * which repository may answer; the pin decides which version may. Neither is a
 * substitute for the other.
 *
 * And the pin costs nothing of the property the paragraph above is proud of.
 * `cargo metadata` already answers this package's `version` beside its
 * `manifest_path`, and the Maven artifact carries the crate's own version by
 * construction — the crate builds its local repository during packaging, which is
 * the mechanism upstream's "cargo keeps it in sync" is describing. So both values
 * come out of one `cargo` invocation and neither is written down twice.
 */
@Suppress("UnstableApiUsage")
val rustlsAndroid: Map<*, *> =
    providers.exec {
        workingDir = File(rootDir, "../../")
        commandLine(
            "cargo", "metadata", "--format-version", "1",
            "--filter-platform", "aarch64-linux-android",
        )
    }.standardOutput.asText.get()
        .let { groovy.json.JsonSlurper().parseText(it) as Map<*, *> }
        .let { it["packages"] as List<*> }
        .map { it as Map<*, *> }
        .first { it["name"] == "rustls-platform-verifier-android" }

val rustlsMaven: String = File(File(rustlsAndroid["manifest_path"] as String).parentFile, "maven").path
val rustlsVersion: String = rustlsAndroid["version"] as String

repositories {
    exclusiveContent {
        forRepository {
            maven {
                url = uri(rustlsMaven)
                metadataSources.artifact()
            }
        }
        filter { includeGroup("rustls") }
    }
}

dependencies {
    implementation("rustls:rustls-platform-verifier:$rustlsVersion")
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.lifecycle:lifecycle-process:2.10.0")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.4")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.0")
}

apply(from = "tauri.build.gradle.kts")