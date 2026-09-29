plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.plugin.compose")
}

android {
    namespace = "dev.crsmith.sidetone"
    compileSdk {
        version = release(37) { minorApiLevel = 2 }
    }

    defaultConfig {
        applicationId = "dev.crsmith.sidetone"
        // 17.1 one phone, a Pixel 8a, side-loaded
        minSdk = 34
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0"
        ndk {
            // the phone, and the emulator this is checked on. Every other
            // architecture is 50 MB of WebRTC that nothing here runs.
            abiFilters += listOf("arm64-v8a", "x86_64")
        }
    }

    buildFeatures {
        compose = true
    }

    // Robolectric reads the app's resources, such as the notification's title
    testOptions {
        unitTests.isIncludeAndroidResources = true
        // Robolectric sets file descriptors through a JDK class that Java 21 does not export
        unitTests.all { it.jvmArgs("--add-exports=java.base/jdk.internal.access=ALL-UNNAMED") }
    }
}

dependencies {
    implementation("io.livekit:livekit-android:2.28.2")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.11.0")
    implementation("com.google.android.gms:play-services-code-scanner:16.1.0")
    implementation("androidx.activity:activity-compose:1.13.0")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.11.0")
    implementation(platform("androidx.compose:compose-bom:2026.09.00"))
    implementation("androidx.compose.material3:material3")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.robolectric:robolectric:4.17")
    // LiveKit's own harness: a Room over a mocked WebRTC and signal socket, under Robolectric
    testImplementation("io.livekit:livekit-android-test:2.28.2")
    // the harness's rules hand out a TestScope; the version is the app's coroutines
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.9.0")
    // UI tests: the Compose test rule, under Robolectric
    testImplementation(platform("androidx.compose:compose-bom:2026.09.00"))
    testImplementation("androidx.compose.ui:ui-test-junit4")
    // the empty activity the Compose test rule starts
    debugImplementation("androidx.compose.ui:ui-test-manifest")
}
