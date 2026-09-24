package dev.crsmith.sidetone

import android.app.Application
import android.os.StrictMode

/**
 * Item 39 StrictMode, in the debug build only. It writes each disk read, each
 * network call and each slow call on the main thread, and each leak, to the
 * log, and stops nothing. Read it with `adb logcat -s StrictMode`.
 */
class DebugApp : Application() {
    override fun onCreate() {
        StrictMode.setThreadPolicy(StrictMode.ThreadPolicy.Builder().detectAll().penaltyLog().build())
        StrictMode.setVmPolicy(StrictMode.VmPolicy.Builder().detectAll().penaltyLog().build())
        super.onCreate()
    }
}
