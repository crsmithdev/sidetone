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
}
