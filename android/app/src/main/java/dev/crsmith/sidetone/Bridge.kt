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
import io.livekit.android.events.DisconnectReason
import io.livekit.android.events.RoomEvent
import io.livekit.android.events.collect
import io.livekit.android.room.Room
import io.livekit.android.room.track.LocalAudioTrack
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineExceptionHandler
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
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
        /** 11.12 whether the bridge makes any sound, or only writes its answers. */
        val audioOn: Boolean = true,
        /** 15.7.3 whether the bridge may play hold music. */
        val musicOn: Boolean = true,
        /** 9.4.8 what the Stop button says, as the bridge gave it. */
        val endTurn: String? = null,
        /** 17.11 whether the bridge says the agent works. It is shown whatever the audio does. */
        val sign: Sign = Sign.OFF,
        val lines: List<Line> = emptyList(),
        /** 17.21 the line of the spoken sentence and where the sentence ends in it. */
        val spoken: Pair<Int, Int>? = null,
        val error: String? = null,
        /** 17.15 the app the bridge serves, when it is not the one installed. */
        val update: Apk? = null,
        /** 17.15 the update downloads, or waits for Chris to confirm it. */
        val updating: Boolean = false,
        /** 17.18.5 the JPEG of each screenshot this app sent, by id, for its thumbnail. */
        val thumbnails: Map<String, ByteArray> = emptyMap(),
        /** 14.12.7 what became of each screenshot, by id, as the bridge last said. */
        val screenshots: Map<String, String> = emptyMap(),
        /** 14.15 the SHA-256 of this app, for the menu. Null until it is read, or when it cannot be. */
        val build: String? = null,
        /** 9.4.9 the settings in force on the bridge, which the options screen shows (item 28). */
        val settings: Incoming.Settings = Incoming.Settings(emptyMap(), emptyMap(), emptyMap()),
        /** Item 44 how many settings messages came; each puts the sliders back to what the bridge holds. */
        val settingsCount: Int = 0,
    )

    private const val TAG = "Sidetone"

    /** 14.11 how often the app sends new screen log entries. */
    private const val STREAM_MS = 1_000L

    /** 14.11 the most entries kept for the bridge while the room is gone. The oldest go first. */
    private const val UNSENT_MAX = 2_000

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state

    /** 17.20.4 an error in a launched coroutine is written down, and the app goes on. */
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate + CoroutineExceptionHandler { _, e -> caught("a coroutine", e) })
    private val micLock = Mutex()
    private lateinit var app: Context
    private lateinit var store: CredentialStore

    /** 18.15 the setup the bridge pushed, kept across a restart. Empty, the app runs with the one in its code. */
    private lateinit var setups: SetupStore
    private lateinit var crashes: Crashes
    private var session: Job? = null
    private var room: Room? = null
    private var mic: LocalAudioTrack? = null

    /** 17.11 and 18.9 the status word, the retry and the rejoin, apart from the room. */
    private val joining = Joining()

    /** 17.17 whether the app is on the screen. [MainActivity] sets it. */
    var inFront = false

    /** 14.11 screen log entries the bridge has not had yet, oldest first. */
    private val unsent = ArrayDeque<Shown>()

    /** 14.11 names the file the bridge appends this conversation's log to. */
    private var logId = System.currentTimeMillis().toString()

    /** 14.12 one screenshot goes at a time, so the parts of two do not mix. */
    private val screenshotLock = Mutex()

    /** 14.7 and 17.12 what a message does to the screen and to the log of it. */
    private val conversation = Conversation(Transcript(ScreenLog(onAdd = { entry ->
        unsent.addLast(entry)
        while (unsent.size > UNSENT_MAX) unsent.removeFirst()
    })))

    fun load(context: Context) {
        if (::store.isInitialized) return
        app = context.applicationContext
        store = CredentialStore(context.applicationContext)
        val audio = app.getSharedPreferences("sidetone-audio", Context.MODE_PRIVATE)
        setups = SetupStore(read = { audio.getString("setup", null) }, write = { kept ->
            audio.edit().apply { if (kept == null) remove("setup") else putString("setup", kept) }.apply()
        })
        // 17.20 a crash writes a report, and the next room sends it
        crashes = Crashes(File(app.filesDir, "crashes"))
        crashes.catchAll { crashState(_state.value) }
        // 17.20.5 the deaths the handler cannot see: a native crash, an ANR, a kill
        scope.launch(Dispatchers.IO) { crashes.saveExits(exits(app)) }
        _state.update { it.copy(paired = store.load() != null) }
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
        if (joining.status == Status.LEFT) return
        open(context)
    }

    /**
     * 17.11.10 the way back into a room Chris left. The pairing is the one the
     * app has, and the bridge greets it as it greets any client that joins.
     */
    fun enter(context: Context) {
        if (session != null) return
        record("leave", "rejoining by hand")
        open(context)
    }

    private fun open(context: Context) {
        if (session != null) return
        val credentials = store.load() ?: return
        val app = context.applicationContext
        app.startForegroundService(Intent(app, BridgeService::class.java))
        session = scope.launch {
            while (true) {
                link(Joining.Event.Opening)
                // 17.20.4 a room that throws ends as any room ends, so the loop opens the next one
                val reason = try {
                    runRoom(app, credentials)
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    caught("the room", e)
                    e.message ?: e.toString()
                }
                Log.i(TAG, "the room ended: $reason")
                for (effect in link(Joining.Event.Ended(reason))) when (effect) {
                    is Joining.Effect.Open -> delay(effect.at - SystemClock.elapsedRealtime())
                    is Joining.Effect.Forget -> {
                        store.clear()
                        stop(app)
                        reset()
                        _state.value = State(error = joining.error)
                        return@launch
                    }
                    // no room is open to end
                    is Joining.Effect.End -> Unit
                }
            }
        }
    }

    /**
     * 17.11.10 leave the room and stay open. In the room the phone is in a call
     * as far as the car is concerned (4.2.2), and the car parks its own music
     * for the call, so Chris leaves to listen and comes back to talk. The
     * lines stay as history. The session goes, and with it the room, the
     * microphone track and the route the app picked, as on a quit or a swipe.
     */
    fun leave(context: Context) {
        record("leave", "left the room")
        stop(context.applicationContext)
        link(Joining.Event.Left)
    }

    /** 17.22.4 leave the room and end the conversation. The next open of the app starts afresh. */
    fun quit(context: Context) {
        stop(context.applicationContext)
        reset()
        link(Joining.Event.Quit)
        _state.value = State(paired = store.load() != null)
    }

    /** A conversation that ended has no lines, no log and no work to show. */
    private fun reset() {
        conversation.clear()
        unsent.clear()
        logId = System.currentTimeMillis().toString()
    }

    /** End the session. The room that is open ends with it, and [runRoom] releases what the room held. */
    private fun stop(app: Context) {
        session?.cancel()
        session = null
        app.stopService(Intent(app, BridgeService::class.java))
    }

    /** One room, from connect to its end. Returns why it ended. */
    private suspend fun runRoom(app: Context, credentials: Credentials): String = coroutineScope {
        // 18.15 the room is built with the setup in force, so a pushed one takes a rejoin
        val (setup, _) = setupInForce()
        val room = LiveKit.create(
            app,
            RoomOptions(
                adaptiveStream = true,
                // 4.2 the framework's echo cancellation, which keeps the microphone open while the bridge speaks
                audioTrackCaptureDefaults = Audio.capture(setup),
            ),
            Audio.overrides(app, setup),
        )
        this@Bridge.room = room
        val ended = CompletableDeferred<String>()
        val events = launch { room.events.collect { on(room, it, ended) } }
        // 17.11 the sign goes to "stalled" with no message to say so, so it is looked at on the clock
        val watch = launch { while (true) { delay(1_000); showSign() } }
        // 14.11 the screen log goes to the bridge as it grows
        val stream = launch { while (true) { delay(STREAM_MS); sendScreenLog(room) } }
        try {
            room.connect(credentials.url, credentials.token)
            // 4.2.2.1 a setup with no focus picks its output device itself, once the room's audio is up
            Audio.pickRoute(app, setup)?.let { Log.i(TAG, "route picked: $it") }
            link(Joining.Event.Connected)
            // the bridge starts every process with its audio on, so an audio cut has to be
            // said again to a room this app has only just joined
            if (!_state.value.audioOn) tell(room, Outgoing.audio(false))
            if (!_state.value.musicOn) tell(room, Outgoing.music(false))
            if (_state.value.micOn) micLock.withLock { openMic(room) }
            sendCrashes(room)
            ended.await()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            Log.w(TAG, "the room failed", e)
            e.message ?: e.toString()
        } finally {
            events.cancel()
            watch.cancel()
            stream.cancel()
            // the protocol, the last reading and the last word about work belonged to a room that is gone
            conversation.roomEnded(SystemClock.elapsedRealtime(), now())
            _state.update { it.copy(quality = null, endTurn = conversation.endTurn, sign = conversation.sign) }
            this@Bridge.room = null
            mic = null
            // release disposes every published track, the microphone included
            room.release()
            Audio.clearRoute(app, setup)
        }
    }

    /** 17.20.4 an event that fails is dropped and written down, and the room goes on. */
    private fun on(room: Room, event: RoomEvent, ended: CompletableDeferred<String>) {
        try {
            handle(room, event, ended)
        } catch (e: Exception) {
            caught("a room event", e)
        }
    }

    private fun handle(room: Room, event: RoomEvent, ended: CompletableDeferred<String>) {
        when (event) {
            is RoomEvent.Reconnecting -> link(Joining.Event.Reconnecting)
            is RoomEvent.Reconnected -> link(Joining.Event.Reconnected)
            is RoomEvent.Disconnected -> ended.complete(event.error?.message ?: reasonWord(event.reason))
            // N.1.4 the phone reads its own uplink and tells the bridge
            is RoomEvent.ConnectionQualityChanged -> {
                if (event.participant != room.localParticipant) return
                val quality = event.quality.name.lowercase()
                if (quality == _state.value.quality) return
                _state.update { it.copy(quality = quality) }
                tell(room, Outgoing.quality(quality))
            }
            is RoomEvent.DataReceived -> {
                val effects = conversation.receive(decode(event.data), now(), SystemClock.elapsedRealtime(), inFront, _state.value.audioOn)
                shown()
                for (effect in effects) when (effect) {
                    is Conversation.Effect.Alert -> Alerts.post(app, effect.title, effect.text)
                    is Conversation.Effect.Offer -> offer(effect.apk)
                    is Conversation.Effect.Rejoin -> rejoin(ended)
                    is Conversation.Effect.Device -> sendDevice(room)
                    is Conversation.Effect.Setup -> applySetup(effect.names, ended)
                }
            }
            else -> Unit
        }
    }

    /**
     * 18.9 the bridge hears no sound from the microphone track, and only this
     * end can publish a new one. Ending the room makes [join] connect again,
     * and [runRoom] opens the microphone again if it was open. A request inside
     * [REJOIN_MS] of the last rejoin is ignored, so a silent phone cannot loop.
     */
    private fun rejoin(ended: CompletableDeferred<String>) {
        val effects = link(Joining.Event.RejoinAsked)
        if (effects.isEmpty()) Log.i(TAG, "the bridge asked for a rejoin inside ${REJOIN_MS / 1000} s of the last one; ignored")
        for (effect in effects) when (effect) {
            is Joining.Effect.End -> {
                Log.i(TAG, "the bridge asked for a rejoin")
                record("rejoin", "rejoining to publish a new microphone track")
                ended.complete(effect.reason)
            }
            // a rejoin asks only for the room to end; the loop in join opens the next
            is Joining.Effect.Open, Joining.Effect.Forget -> Unit
        }
    }

    /**
     * 18.15 the setup the room is built with, and whether the bridge pushed it.
     * A kept setup that does not read, such as one an older app wrote, is no
     * setup: the app runs with the one in its code and says so.
     */
    private fun setupInForce(): Pair<AudioSetup, Boolean> {
        val pushed = setups.load()?.let(Audio::named) ?: return Audio.setup to false
        return pushed to true
    }

    /**
     * 18.15 the bridge pushed a setup, or asked for the one in the code. It is
     * kept first, so it survives a restart, and then the room ends the way a
     * rejoin does (18.9): [join] opens the next room with it. A name this app
     * does not map is refused and written down, and nothing changes.
     */
    private fun applySetup(names: SetupNames?, ended: CompletableDeferred<String>) {
        if (names == null) {
            setups.clear()
            record("setup", "the audio setup is the one in the code again; rejoining")
        } else {
            if (Audio.named(names) == null) {
                Log.w(TAG, "a pushed audio setup has a name this app does not know: $names")
                record("setup", "a pushed audio setup was refused, a name this app does not know: $names")
                return
            }
            setups.save(names)
            record("setup", "a pushed audio setup: ${names.mode} mode, ${names.output} output, ${names.focus} focus, ${names.canceller} canceller, " +
                "noise suppression ${if (names.noiseSuppression) "on" else "off"}, auto gain control ${if (names.autoGainControl) "on" else "off"}; rejoining")
        }
        Log.i(TAG, "the audio setup changed; rejoining")
        for (effect in link(Joining.Event.SetupChanged)) if (effect is Joining.Effect.End) ended.complete(effect.reason)
    }

    /**
     * Cut the microphone properly. Unpublish the track and dispose it, so the
     * device is released and the phone's own indicator goes out; a muted track
     * keeps recording. Tell the bridge, so it drops a half-recorded sentence.
     */
    fun setMic(on: Boolean) = switchMic(on, byHold = false)

    /**
     * 9.5.1 hold to talk: the microphone is open while the button is down. The
     * lock keeps a press and its release in order. No note is written, or
     * every press would add two lines to the transcript.
     */
    fun hold() {
        if (_state.value.micOn || _state.value.holding) return
        _state.update { it.copy(holding = true) }
        switchMic(true, byHold = true)
    }

    /** 9.5.2 the button is up: cut the microphone, and tell the bridge the words end now. */
    fun release() {
        if (!_state.value.holding) return
        _state.update { it.copy(holding = false) }
        switchMic(false, byHold = true)
    }

    private fun switchMic(on: Boolean, byHold: Boolean) {
        scope.launch {
            micLock.withLock {
                if (_state.value.micOn == on) return@launch
                val room = room
                // with no room the state is what the next room opens; with one it follows the track
                if (room != null) {
                    try {
                        if (on) openMic(room) else closeMic(room)
                    } catch (e: CancellationException) {
                        throw e
                    } catch (e: Exception) {
                        // a publish fails while the room reconnects: the button stays as it was
                        Log.w(TAG, "the microphone did not switch", e)
                        append("note", Line(Line.Kind.NOTE, "the microphone did not ${if (on) "open" else "close"}: ${e.message ?: e}"))
                        return@launch
                    }
                }
                _state.update { it.copy(micOn = on) }
                room ?: return@launch
                tell(room, Outgoing.mic(on, release = byHold && !on, hold = byHold && on))
                if (!byHold) record("microphone", if (on) "microphone on" else "microphone off")
            }
        }
    }

    /**
     * 17.10 cut the bridge's audio, without stopping the conversation. The
     * transcript is a data message and never went down the audio path, so the
     * words carry on arriving and only the sound goes.
     */
    fun setAudio(on: Boolean) {
        if (_state.value.audioOn == on) return
        _state.update { it.copy(audioOn = on) }
        val room = room ?: return
        tell(room, Outgoing.audio(on))
        record("audio", if (on) "audio on" else "audio off")
    }

    /**
     * 17.10 turn the hold music off or on, as "music off" and "music on" do
     * (15.7.3). The voice and the tones carry on.
     */
    fun setMusic(on: Boolean) {
        if (_state.value.musicOn == on) return
        _state.update { it.copy(musicOn = on) }
        val room = room ?: return
        tell(room, Outgoing.music(on))
        record("music", if (on) "music on" else "music off")
    }

    /**
     * Item 28 a setting from the options screen (9.4.9). The screen does not
     * change it here: it waits for the settings the bridge sends back, so
     * the menu shows only what the bridge holds.
     */
    fun change(setting: ByteArray) {
        val room = room ?: return
        tell(room, setting)
    }

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
    fun updateEnded(note: String?) {
        _state.update { it.copy(updating = false) }
        note?.let { append("note", Line(Line.Kind.NOTE, it)) }
    }

    fun say(text: String) {
        room?.let { tell(it, Outgoing.said(text)) }
    }

    /** 9.4.8 by hand, for a car that is too loud to be heard in. */
    fun endTurn() {
        // the phrase belongs to the bridge, which owns the wake word
        _state.value.endTurn?.let { say(it) }
    }

    private suspend fun openMic(room: Room) {
        if (mic != null) return
        val track = room.localParticipant.createAudioTrack()
        track.start()
        if (!room.localParticipant.publishAudioTrack(track)) {
            track.dispose()
            throw IllegalStateException("could not publish the microphone")
        }
        mic = track
    }

    private fun closeMic(room: Room) {
        val track = mic ?: return
        mic = null
        room.localParticipant.unpublishTrack(track)
        track.dispose()
    }

    private fun tell(room: Room, payload: ByteArray) {
        scope.launch {
            room.localParticipant.publishData(payload).onFailure { Log.w(TAG, "the bridge was not told", it) }
        }
    }

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
            val id = at.toString()
            // 17.18.5 the thumbnail shows once the bridge says it has the image
            _state.update { it.copy(thumbnails = it.thumbnails + (id to jpeg)) }
            screenshotLock.withLock {
                for (part in screenshotParts(jpeg, id)) {
                    val room = room ?: return@launch
                    if (room.localParticipant.publishData(part).isFailure) {
                        Log.w(TAG, "the screenshot did not go")
                        return@launch
                    }
                }
            }
        }
    }

    /** 17.18.5 Chris tapped a pending screenshot: no turn takes it (14.12.7). The bridge says when it is gone. */
    fun dropScreenshot(id: String) {
        room?.let { tell(it, Outgoing.dropScreenshot(id)) }
    }

    /** The room says why it ended as an enum, and the screen says it to Chris. */
    private fun reasonWord(reason: DisconnectReason): String = when (reason) {
        // what a link that dies in a tunnel gives back, with no message on it
        DisconnectReason.UNKNOWN_REASON -> "the connection dropped"
        else -> reason.name.lowercase().replace('_', ' ')
    }

    private fun now() = System.currentTimeMillis()

    /**
     * 17.9 a line the bridge sent live is stamped with the time it arrived; a kept
     * line keeps the time the bridge gave it. `kind` is what the screen log (17.12) calls the message.
     */
    private fun append(kind: String, vararg lines: Line) {
        conversation.transcript.onLines(kind, now(), *lines)
        shown()
    }

    /** 4.3.1 an event for the screen log, with no line on the screen. */
    private fun record(kind: String, text: String) = conversation.record(kind, text, now())

    /** One event for the link, on the elapsed clock. The screen shows what the link says after it. */
    private fun link(event: Joining.Event): List<Joining.Effect> {
        val effects = joining.on(event, SystemClock.elapsedRealtime())
        _state.update { it.copy(status = joining.status, error = joining.error) }
        return effects
    }

    /** The screen shows what the conversation holds now. */
    private fun shown() {
        _state.update { it.copy(lines = conversation.lines, spoken = conversation.spoken, endTurn = conversation.endTurn, sign = conversation.sign, screenshots = conversation.screenshots,
            settings = Incoming.Settings(conversation.settingsOn, conversation.settingWords, conversation.settingNumbers), settingsCount = conversation.settingsCount) }
    }

    /**
     * 17.11 the sign, from what the bridge last said and the clock. A change goes
     * to the screen and to the log.
     */
    private fun showSign() {
        if (conversation.tick(SystemClock.elapsedRealtime(), now())) shown()
    }

    /**
     * 14.15 the phone says what it is, which canceller runs, where the audio plays, its build,
     * and 18.15 the setup in force and whether the bridge pushed it.
     * It answers each `protocol`: a restart of the bridge keeps the room, so the join is not enough.
     */
    private fun sendDevice(room: Room) {
        scope.launch {
            val aec = Audio.hardwareCanceller()
            val (setup, pushed) = setupInForce()
            val route = runCatching { Audio.route(app, setup) }.getOrElse { "unknown: ${it.message}" }
            val message = Outgoing.device(Build.MODEL, aec, Audio.canceller(setup, aec), route, Updater.installedHash(app), Audio.names(setup), pushed)
            room.localParticipant.publishData(message).onFailure { Log.w(TAG, "the device message did not go", it) }
        }
    }

    /** 17.20.4 an error the app lived through goes to the log and to a crash report. */
    private fun caught(what: String, error: Throwable) {
        Log.e(TAG, "$what failed", error)
        if (::crashes.isInitialized) crashes.caught(what, crashState(_state.value), error)
    }

    /** 17.20.5 the system's record of each death of this app that it still keeps, with the start of its trace. */
    private fun exits(app: Context): List<Exit> =
        app.getSystemService(ActivityManager::class.java).getHistoricalProcessExitReasons(null, 0, 0).map { info ->
            val trace = runCatching { info.traceInputStream?.use { it.readNBytes(TRACE_BYTES) } }.getOrNull()
            Exit(info.timestamp, info.reason, info.description, info.status, info.importance, info.pss, info.rss, trace)
        }

    /** 17.20.2 each report goes once, oldest first. A report that fails goes with the next room. */
    private fun sendCrashes(room: Room) {
        scope.launch {
            for (file in crashes.unsent()) {
                if (room.localParticipant.publishData(crashMessage(file.nameWithoutExtension, file.readText())).isFailure) {
                    Log.w(TAG, "the crash report did not go")
                    return@launch
                }
                file.delete()
            }
        }
    }

    /**
     * 14.11 send the entries the bridge has not had, in parts that fit one
     * message. A part that fails goes back, with those after it, for the next try.
     */
    private suspend fun sendScreenLog(room: Room) {
        if (unsent.isEmpty()) return
        val batch = unsent.toList()
        unsent.clear()
        var sent = 0
        for (part in screenParts(batch, logId)) {
            val count = Json.parseToJsonElement(part.decodeToString()).jsonObject["entries"]!!.jsonArray.size
            if (room.localParticipant.publishData(part).isFailure) {
                batch.drop(sent).asReversed().forEach(unsent::addFirst)
                return
            }
            sent += count
        }
    }
}
