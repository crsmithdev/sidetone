package dev.crsmith.sidetone

import android.Manifest
import android.app.ActivityManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.SystemClock
import android.util.Log
import io.livekit.android.LiveKit
import io.livekit.android.RoomOptions
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineExceptionHandler
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.io.File

/**
 * The conversation, above the screen. It lives in the process, not in the
 * activity, so it goes on while the screen is off (17.2). [BridgeService] keeps
 * the process in the foreground for as long as there is a conversation.
 */
object Bridge {
    data class State(
        val paired: Boolean = false,
        val status: Status = Status.IDLE,
        val quality: String? = null,
        val micOn: Boolean = true,
        /** 9.5.1 the hold to talk button is down. */
        val holding: Boolean = false,
        /** What the screen shows of the conversation. */
        val screen: OnScreen = OnScreen(),
        val error: String? = null,
        /** 17.15 the app the bridge serves, when it is not the one installed. */
        val update: Apk? = null,
        /** 17.15 the update downloads, or waits for Chris to confirm it. */
        val updating: Boolean = false,
        /** 17.18.5 the JPEG of each screenshot this app sent, by id, for its thumbnail. */
        val thumbnails: Map<String, ByteArray> = emptyMap(),
        /** 14.15 the SHA-256 of this app, for the menu. Null until it is read, or when it cannot be. */
        val build: String? = null,
    )

    private const val TAG = "Sidetone"

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state

    /** 17.20.4 an error in a launched coroutine is written down, and the app goes on. */
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate + CoroutineExceptionHandler { _, e -> caught("a coroutine", e) })
    private lateinit var app: Context
    private lateinit var store: CredentialStore

    /** The rules of the client, apart from Android and LiveKit. */
    private lateinit var client: ClientRoom
    private var session: Job? = null

    /** 17.17 whether the app is on the screen. [MainActivity] sets it. */
    var inFront: Boolean
        get() = client.inFront
        set(value) {
            client.inFront = value
        }

    fun load(context: Context) {
        if (::store.isInitialized) return
        app = context.applicationContext
        store = CredentialStore(context.applicationContext)
        val audio = app.getSharedPreferences("sidetone-audio", Context.MODE_PRIVATE)
        val setups = SetupStore(read = { audio.getString("setup", null) }, write = { kept ->
            audio.edit().apply { if (kept == null) remove("setup") else putString("setup", kept) }.apply()
        })
        val cut = app.getSharedPreferences("sidetone-cuts", Context.MODE_PRIVATE)
        val cuts = CutStore(read = { key -> if (cut.contains(key)) cut.getBoolean(key, true) else null }, write = { key, on -> cut.edit().putBoolean(key, on).apply() })
        // 17.20 a crash writes a report, and the next room sends it
        val crashes = Crashes(File(app.filesDir, "crashes"))
        client = ClientRoom(_state, scope, cuts, setups, crashes, Logcat, SystemClock::elapsedRealtime,
            forget = {
                store.clear()
                stop(app)
            },
            phone = { room, effect ->
                when (effect) {
                    is Conversation.Effect.Alert -> Alerts.post(app, effect.title, effect.text)
                    is Conversation.Effect.Offer -> offer(effect.apk)
                    Conversation.Effect.Device -> sendDevice(room)
                    else -> Unit
                }
            },
        )
        crashes.catchAll { crashState(_state.value) }
        // 17.20.5 the deaths the handler cannot see: a native crash, an ANR, a kill
        scope.launch(Dispatchers.IO) { crashes.saveExits(exits(app)) }
        _state.update { cuts.load().applyTo(it.copy(paired = store.load() != null)) }
        scope.launch { Updater.installedHash(app)?.let { build -> _state.update { it.copy(build = build) } } }
    }

    suspend fun pairWith(link: Link) {
        store.save(pair(link))
        _state.update { it.copy(paired = true, error = null) }
    }

    /**
     * Join the room when the app opens, and rejoin it after any end but a
     * refused token. Call with the app in the foreground. The screen asks each
     * time it is built, so a room Chris left by hand (17.11.10) is not opened
     * here: it waits for his tap, which is [enter].
     */
    fun join(context: Context) {
        if (client.status == Status.LEFT) return
        open(context)
    }

    /**
     * 17.11.10 the way back into a room Chris left. The pairing is the one the
     * app has, and the bridge greets it as it greets any client that joins.
     */
    fun enter(context: Context) {
        if (session != null) return
        client.record("leave", "rejoining by hand")
        open(context)
    }

    private fun open(context: Context) {
        if (session != null) return
        val credentials = store.load() ?: return
        val app = context.applicationContext
        app.startForegroundService(Intent(app, BridgeService::class.java))
        session = scope.launch { client.loop { runRoom(app, credentials) } }
    }

    /**
     * 17.11.10 leave the room and stay open. In the room the phone is in a call
     * as far as the car is concerned (4.2.2), and the car parks its own music
     * for the call, so Chris leaves to listen and comes back to talk. The
     * lines stay as history. The session goes, and with it the room, the
     * microphone track and the route the app picked, as on a quit or a swipe.
     */
    fun leave(context: Context) {
        client.record("leave", "left the room")
        stop(context.applicationContext)
        client.link(Joining.Event.Left)
    }

    /** 17.22.4 leave the room and end the conversation. The next open of the app starts afresh. */
    fun quit(context: Context) {
        stop(context.applicationContext)
        client.quit(paired = store.load() != null)
    }

    /** End the session. The room that is open ends with it, and [runRoom] releases what the room held. */
    private fun stop(app: Context) {
        session?.cancel()
        session = null
        app.stopService(Intent(app, BridgeService::class.java))
    }

    /** One LiveKit room, from connect to its end. Returns why it ended. */
    private suspend fun runRoom(app: Context, credentials: Credentials): String {
        // 18.15 the room is built with the setup in force, so a pushed one takes a rejoin
        val (setup, _) = client.setupInForce()
        val room = LiveKit.create(
            app,
            RoomOptions(
                adaptiveStream = true,
                // 4.2 the framework's echo cancellation, which keeps the microphone open while the bridge speaks
                audioTrackCaptureDefaults = Audio.capture(setup),
            ),
            Audio.overrides(app, setup),
        )
        try {
            return client.inRoom(LiveKitRoom(room)) {
                room.connect(credentials.url, credentials.token)
                // 4.2.2.1 a setup with no focus picks its output device itself, once the room's audio is up
                Audio.pickRoute(app, setup)?.let { Log.i(TAG, "route picked: $it") }
                room.remoteParticipants.values.any { isBridge(it.identity?.value) }
            }
        } finally {
            // release disposes every published track, the microphone included
            room.release()
            Audio.clearRoute(app, setup)
        }
    }

    /**
     * Cut the microphone properly. Unpublish the track and dispose it, so the
     * device is released and the phone's own indicator goes out; a muted track
     * keeps recording. Tell the bridge, so it drops a half-recorded sentence.
     */
    fun setMic(on: Boolean) = client.setMic(on)

    /** 9.5.1 hold to talk: the microphone is open while the button is down. */
    fun hold() = client.hold()

    /** 9.5.2 the button is up: cut the microphone, and tell the bridge the words end now. */
    fun release() = client.release()

    /** 17.10 cut the bridge's audio, without stopping the conversation. */
    fun setAudio(on: Boolean) = client.setAudio(on)

    /** 17.10 turn the hold music off or on, as "music off" and "music on" do (15.7.3). */
    fun setMusic(on: Boolean) = client.setMusic(on)

    /** Item 28 a setting from the options screen (9.4.9). */
    fun change(setting: ByteArray) = client.change(setting)

    /** 17.15 show the update when the bridge serves an app that is not this one. */
    private fun offer(apk: Apk?) {
        scope.launch {
            val update = updateFor(Updater.installedHash(app), apk)
            _state.update { it.copy(update = update) }
        }
    }

    /** 17.15 download the bridge's app and give it to the system installer, which asks Chris to confirm. */
    fun installUpdate() {
        val apk = _state.value.update ?: return
        if (_state.value.updating) return
        _state.update { it.copy(updating = true) }
        scope.launch {
            try {
                Updater.install(app, apk)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                Log.w(TAG, "the update failed", e)
                updateEnded("the update failed: ${e.message ?: e}")
            }
        }
    }

    /** 17.15 the installer finished or refused. A success ends this process, so this is a refusal or a cancel. */
    fun updateEnded(note: String?) = client.updateEnded(note)

    fun say(text: String) = client.say(text)

    /** 9.4.8 by hand, for a car that is too loud to be heard in. */
    fun endTurn() = client.endTurn()

    /**
     * 17.18 Chris took a screenshot at `at`, in milliseconds, and the app was on the
     * screen. Send the image to the bridge (14.12). Without the permission, the
     * image or the room, nothing goes and nothing is said.
     */
    fun sendScreenshot(at: Long) {
        if (app.checkSelfPermission(Manifest.permission.READ_MEDIA_IMAGES) != PackageManager.PERMISSION_GRANTED) return
        scope.launch {
            val jpeg = try {
                newestScreenshot(app, at)
            } catch (e: Exception) {
                Log.w(TAG, "the screenshot was not read", e)
                null
            } ?: return@launch
            client.sendScreenshot(at.toString(), jpeg)
        }
    }

    /** 17.18.5 Chris tapped a pending screenshot: no turn takes it (14.12.7). The bridge says when it is gone. */
    fun dropScreenshot(id: String) = client.dropScreenshot(id)

    /**
     * 14.15 the phone says what it is, which canceller runs, where the audio plays, its build,
     * and 18.15 the setup in force and whether the bridge pushed it.
     * It answers each `protocol`: a restart of the bridge keeps the room, so the join is not enough.
     */
    private fun sendDevice(room: Room) {
        scope.launch {
            val aec = Audio.hardwareCanceller()
            val (setup, pushed) = client.setupInForce()
            val route = runCatching { Audio.route(app, setup) }.getOrElse { "unknown: ${it.message}" }
            val message = Outgoing.device(Build.MODEL, aec, Audio.canceller(setup, aec), route, Updater.installedHash(app), Audio.names(setup), pushed)
            room.send(message).onFailure { Log.w(TAG, "the device message did not go", it) }
        }
    }

    /** 17.20.4 an error the app lived through goes to the log and, once the app is loaded, to a crash report. */
    private fun caught(what: String, error: Throwable) {
        if (::client.isInitialized) client.caught(what, error) else Log.e(TAG, "$what failed", error)
    }

    /** 17.20.5 the system's record of each death of this app that it still keeps, with the start of its trace. */
    private fun exits(app: Context): List<Exit> =
        app.getSystemService(ActivityManager::class.java).getHistoricalProcessExitReasons(null, 0, 0).map { info ->
            val trace = runCatching { info.traceInputStream?.use { it.readNBytes(TRACE_BYTES) } }.getOrNull()
            Exit(info.timestamp, info.reason, info.description, info.status, info.importance, info.pss, info.rss, trace)
        }

    /** What the client writes goes to logcat under one tag. */
    private object Logcat : ClientRoom.Logcat {
        override fun info(text: String) {
            Log.i(TAG, text)
        }

        override fun warn(text: String, error: Throwable?) {
            if (error == null) Log.w(TAG, text) else Log.w(TAG, text, error)
        }

        override fun error(text: String, error: Throwable) {
            Log.e(TAG, text, error)
        }
    }
}
