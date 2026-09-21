package dev.crsmith.sidetone

import android.content.Context
import android.content.Intent
import android.os.SystemClock
import android.util.Log
import io.livekit.android.LiveKit
import io.livekit.android.RoomOptions
import io.livekit.android.events.DisconnectReason
import io.livekit.android.events.RoomEvent
import io.livekit.android.events.collect
import io.livekit.android.room.Room
import io.livekit.android.room.track.LocalAudioTrack
import io.livekit.android.room.track.LocalAudioTrackOptions
import io.livekit.android.room.track.RemoteAudioTrack
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
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

/**
 * The conversation, above the screen. It lives in the process, not in the
 * activity, so it goes on while the screen is off (17.2). [BridgeService] keeps
 * the process in the foreground for as long as there is a conversation.
 */
object Bridge {
    enum class Status { IDLE, CONNECTING, LISTENING, RECONNECTING, UNREACHABLE }

    data class State(
        val paired: Boolean = false,
        val status: Status = Status.IDLE,
        val quality: String? = null,
        val micOn: Boolean = true,
        /** 9.5.1 the hold to talk button is down. */
        val holding: Boolean = false,
        /** 11.12 whether the bridge makes any sound, or only writes its answers. */
        val audioOn: Boolean = true,
        /** 4.2.1 the playback slider, 0 to 1. It survives [leave] and a refused pairing. */
        val volume: Float = 1f,
        /** 9.4.8 what the Stop button says, as the bridge gave it. */
        val endTurn: String? = null,
        /** 17.11 whether the bridge says the agent works. It is shown whatever the audio does. */
        val sign: Sign = Sign.OFF,
        val lines: List<Line> = emptyList(),
        val error: String? = null,
    )

    private const val TAG = "Sidetone"
    private const val RETRY_MS = 5_000L

    /** The reason [runRoom] gives when the bridge asked for a rejoin, which is no fault. */
    private const val REJOINING = "rejoining"

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val micLock = Mutex()
    private lateinit var store: CredentialStore
    private lateinit var volumeStore: VolumeStore
    private var session: Job? = null
    private var room: Room? = null
    private var mic: LocalAudioTrack? = null
    private var historyShown = false
    private var rejoinedAt: Long? = null

    /** 17.11 what the bridge last said about work, and when, on the clock of [SystemClock.elapsedRealtime]. */
    private var workingOn = false
    private var workingAt = 0L

    /** 14.7 and 17.12 the lines on the screen and the log of them. */
    private val transcript = Transcript()

    fun load(context: Context) {
        if (::store.isInitialized) return
        store = CredentialStore(context.applicationContext)
        volumeStore = VolumeStore(context.applicationContext)
        _state.update { it.copy(paired = store.load() != null, volume = volumeStore.load()) }
    }

    suspend fun pairWith(link: Link) {
        store.save(pair(link))
        _state.update { it.copy(paired = true, error = null) }
    }

    /** Join the room, and rejoin it after any end but [leave] or a refused token. Call with the app in the foreground. */
    fun join(context: Context) {
        if (session != null) return
        val credentials = store.load() ?: return
        val app = context.applicationContext
        app.startForegroundService(Intent(app, BridgeService::class.java))
        session = scope.launch {
            while (true) {
                _state.update { it.copy(status = Status.CONNECTING) }
                val reason = runRoom(app, credentials)
                Log.i(TAG, "the room ended: $reason")
                if (reason == REJOINING) continue
                if (refused(reason)) {
                    store.clear()
                    stop(app)
                    reset()
                    _state.update { State(volume = it.volume, error = "The bridge refused the saved pairing ($reason). Scan the code again.") }
                    return@launch
                }
                _state.update { it.copy(status = Status.UNREACHABLE, error = "Cannot reach the bridge: $reason. Retrying.") }
                delay(RETRY_MS)
            }
        }
    }

    fun leave(context: Context) {
        stop(context.applicationContext)
        reset()
        _state.update { State(paired = store.load() != null, volume = it.volume) }
    }

    /** A conversation that ended has no lines, no log and no work to show. */
    private fun reset() {
        transcript.clear()
        workingOn = false
    }

    private fun stop(app: Context) {
        session?.cancel()
        session = null
        historyShown = false
        app.stopService(Intent(app, BridgeService::class.java))
    }

    /** One room, from connect to its end. Returns why it ended. */
    private suspend fun runRoom(app: Context, credentials: Credentials): String = coroutineScope {
        val room = LiveKit.create(
            app,
            RoomOptions(
                adaptiveStream = true,
                // 4.2 the framework's echo cancellation, which keeps the microphone open while the bridge speaks
                audioTrackCaptureDefaults = LocalAudioTrackOptions(echoCancellation = true, noiseSuppression = true, autoGainControl = true),
            ),
        )
        this@Bridge.room = room
        val ended = CompletableDeferred<String>()
        val events = launch { room.events.collect { on(room, it, ended) } }
        // 17.11 the sign goes to "no signal" with no message to say so, so it is looked at on the clock
        val watch = launch { while (true) { delay(1_000); showSign() } }
        try {
            room.connect(credentials.url, credentials.token)
            _state.update { it.copy(status = Status.LISTENING, error = null) }
            // the bridge starts every process with its audio on, so an audio cut has to be
            // said again to a room this app has only just joined
            if (!_state.value.audioOn) tell(room, Outgoing.audio(false))
            if (_state.value.micOn) micLock.withLock { openMic(room) }
            ended.await()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            Log.w(TAG, "the room failed", e)
            e.message ?: e.toString()
        } finally {
            events.cancel()
            watch.cancel()
            // the protocol, the last reading and the last word about work belonged to a room that is gone
            workingOn = false
            showSign()
            _state.update { it.copy(quality = null, endTurn = null) }
            this@Bridge.room = null
            mic = null
            // release disposes every published track, the microphone included
            room.release()
        }
    }

    private fun on(room: Room, event: RoomEvent, ended: CompletableDeferred<String>) {
        when (event) {
            is RoomEvent.Reconnecting -> _state.update { it.copy(status = Status.RECONNECTING) }
            is RoomEvent.Reconnected -> _state.update { it.copy(status = Status.LISTENING) }
            // 4.2.1 a track the bridge publishes later, or again, starts at the level in force
            is RoomEvent.TrackSubscribed -> (event.track as? RemoteAudioTrack)?.setVolume(currentGain())
            is RoomEvent.Disconnected -> ended.complete(event.error?.message ?: reasonWord(event.reason))
            // N.1.4 the phone reads its own uplink and tells the bridge
            is RoomEvent.ConnectionQualityChanged -> {
                if (event.participant != room.localParticipant) return
                val quality = event.quality.name.lowercase()
                if (quality == _state.value.quality) return
                _state.update { it.copy(quality = quality) }
                tell(room, Outgoing.quality(quality))
            }
            is RoomEvent.DataReceived -> when (val message = decode(event.data)) {
                is Incoming.Sentence -> show { it.onSentence(message, now()) }
                is Incoming.BlockStart -> show { it.onBlock(message, now()) }
                is Incoming.Delta -> show { it.onDelta(message, now()) }
                is Incoming.BlockEnd -> Unit
                is Incoming.Said -> when (message.line.kind) {
                    Line.Kind.BRIDGE -> show { it.onTurn(message, now()) }
                    Line.Kind.YOU -> append("heard", message.line)
                    Line.Kind.NOTE -> append("note", message.line)
                }
                is Incoming.Protocol -> _state.update { it.copy(endTurn = message.endTurn) }
                is Incoming.Rejoin -> rejoin(ended)
                is Incoming.Working -> {
                    workingOn = message.on
                    workingAt = SystemClock.elapsedRealtime()
                    showSign()
                }
                is Incoming.Unknown -> append("unknown", Line(Line.Kind.NOTE, "(unknown message: ${message.kind})"))
                is Incoming.History -> {
                    if (historyShown) return
                    historyShown = true
                    if (message.lines.isEmpty()) return
                    // say plainly that this is older, or it reads as the conversation in progress
                    append("history", Line(Line.Kind.NOTE, "earlier"), *message.lines.toTypedArray(), Line(Line.Kind.NOTE, "now"))
                }
                null -> Unit
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
        val now = SystemClock.elapsedRealtime()
        if (!rejoinDue(rejoinedAt, now)) {
            Log.i(TAG, "the bridge asked for a rejoin inside ${REJOIN_MS / 1000} s of the last one; ignored")
            return
        }
        rejoinedAt = now
        Log.i(TAG, "the bridge asked for a rejoin")
        append("note", Line(Line.Kind.NOTE, "rejoining to publish a new microphone track"))
        ended.complete(REJOINING)
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
                _state.update { it.copy(micOn = on) }
                val room = room ?: return@launch
                if (on) openMic(room) else closeMic(room)
                tell(room, Outgoing.mic(on, release = byHold && !on))
                if (!byHold) append("note", Line(Line.Kind.NOTE, if (on) "microphone on" else "microphone off"))
            }
        }
    }

    /**
     * 17.10 cut the bridge's audio, without stopping the conversation. The
     * transcript is a data message and never went down the audio path, so the
     * words carry on arriving and only the sound goes.
     *
     * The gain goes first, so the sound stops on the tap and does not wait for
     * the bridge to hear the message and stop.
     */
    fun setAudio(on: Boolean) {
        if (_state.value.audioOn == on) return
        _state.update { it.copy(audioOn = on) }
        val room = room ?: return
        applyGain(room)
        tell(room, Outgoing.audio(on))
        append("note", Line(Line.Kind.NOTE, if (on) "audio on" else "audio off"))
    }

    /**
     * 4.2.1 the level of everything the bridge sends, apart from the Android
     * stream volume. The bridge sends one audio track for the voice, the cues
     * and the hold music, so one gain on that track scales all three. While
     * the audio is cut (17.10) the slider moves and the gain stays at zero.
     */
    fun setVolume(level: Float) {
        val clamped = level.coerceIn(0f, 1f)
        _state.update { it.copy(volume = clamped) }
        volumeStore.save(clamped)
        room?.let(::applyGain)
    }

    private fun currentGain(): Double = outputGain(_state.value.volume, _state.value.audioOn)

    private fun applyGain(room: Room) {
        val gain = currentGain()
        room.remoteParticipants.values.forEach { participant ->
            participant.audioTrackPublications.forEach { (_, track) -> (track as? RemoteAudioTrack)?.setVolume(gain) }
        }
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
    private fun append(kind: String, vararg lines: Line) = show { it.onLines(kind, now(), *lines) }

    /** A message changes the transcript, and the screen shows what it holds now. */
    private fun show(change: (Transcript) -> Unit) {
        change(transcript)
        _state.update { it.copy(lines = transcript.lines) }
    }

    /**
     * 17.11 the sign, from what the bridge last said and the clock. A change goes
     * to the screen and to the log.
     */
    private fun showSign() {
        val next = sign(workingOn, workingAt, SystemClock.elapsedRealtime())
        if (next == _state.value.sign) return
        _state.update { it.copy(sign = next) }
        transcript.onSign(next, now())
    }

    /**
     * 17.13 send the screen log to the bridge, in parts, for the bridge to write
     * to disk. The bridge says in a note where it wrote the file.
     */
    fun sendScreenLog() {
        val room = room ?: return
        val parts = screenParts(transcript.log.entries, now().toString())
        scope.launch {
            val sent = parts.all { room.localParticipant.publishData(it).onFailure { e -> Log.w(TAG, "the screen log was not sent", e) }.isSuccess }
            if (!sent) append("note", Line(Line.Kind.NOTE, "the screen log was not sent"))
        }
    }
}
