package dev.crsmith.voicebridge

import android.content.Context
import android.content.Intent
import android.util.Log
import io.livekit.android.LiveKit
import io.livekit.android.RoomOptions
import io.livekit.android.events.DisconnectReason
import io.livekit.android.events.RoomEvent
import io.livekit.android.events.collect
import io.livekit.android.room.Room
import io.livekit.android.room.track.LocalAudioTrack
import io.livekit.android.room.track.LocalAudioTrackOptions
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
        /** 11.12 whether the bridge speaks its answers, or only writes them. */
        val voiceOn: Boolean = true,
        /** 9.4.8 what the Stop button says, as the bridge gave it. */
        val endTurn: String? = null,
        val lines: List<Line> = emptyList(),
        val error: String? = null,
    )

    private const val TAG = "VoiceBridge"
    private const val RETRY_MS = 5_000L

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val micLock = Mutex()
    private lateinit var store: CredentialStore
    private var session: Job? = null
    private var room: Room? = null
    private var mic: LocalAudioTrack? = null
    private var historyShown = false

    fun load(context: Context) {
        if (::store.isInitialized) return
        store = CredentialStore(context.applicationContext)
        _state.update { it.copy(paired = store.load() != null) }
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
                if (refused(reason)) {
                    store.clear()
                    stop(app)
                    _state.value = State(error = "The bridge refused the saved pairing ($reason). Scan the code again.")
                    return@launch
                }
                _state.update { it.copy(status = Status.UNREACHABLE, error = "Cannot reach the bridge: $reason. Retrying.") }
                delay(RETRY_MS)
            }
        }
    }

    fun leave(context: Context) {
        stop(context.applicationContext)
        _state.value = State(paired = store.load() != null)
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
        try {
            room.connect(credentials.url, credentials.token)
            _state.update { it.copy(status = Status.LISTENING, error = null) }
            // the bridge starts every process speaking, so a voice cut has to be
            // said again to a room this app has only just joined
            if (!_state.value.voiceOn) tell(room, Outgoing.voice(false))
            if (_state.value.micOn) micLock.withLock { openMic(room) }
            ended.await()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            Log.w(TAG, "the room failed", e)
            e.message ?: e.toString()
        } finally {
            events.cancel()
            // the last reading belonged to a room that is gone
            // the protocol and the last reading belonged to a room that is gone
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
                is Incoming.Sentence -> grow(message.text)
                is Incoming.Said -> if (message.line.kind == Line.Kind.BRIDGE) answered(message.line) else append(message.line)
                is Incoming.Protocol -> _state.update { it.copy(endTurn = message.endTurn) }
                is Incoming.Unknown -> append(Line(Line.Kind.NOTE, "(unknown message: ${message.kind})"))
                is Incoming.History -> {
                    if (historyShown) return
                    historyShown = true
                    if (message.lines.isEmpty()) return
                    // say plainly that this is older, or it reads as the conversation in progress
                    append(Line(Line.Kind.NOTE, "earlier"), *message.lines.toTypedArray(), Line(Line.Kind.NOTE, "now"))
                }
                null -> Unit
            }
            else -> Unit
        }
    }

    /**
     * Cut the microphone properly. Unpublish the track and dispose it, so the
     * device is released and the phone's own indicator goes out; a muted track
     * keeps recording. Tell the bridge, so it drops a half-recorded sentence.
     */
    fun setMic(on: Boolean) {
        scope.launch {
            micLock.withLock {
                if (_state.value.micOn == on) return@launch
                _state.update { it.copy(micOn = on) }
                val room = room ?: return@launch
                if (on) openMic(room) else closeMic(room)
                tell(room, Outgoing.mic(on))
                append(Line(Line.Kind.NOTE, if (on) "microphone on" else "microphone off"))
            }
        }
    }

    /**
     * 11.12 stop the bridge speaking, without stopping the conversation. The
     * transcript is a data message and never went down the audio path, so the
     * words carry on arriving and only the voice goes.
     */
    fun setVoice(on: Boolean) {
        if (_state.value.voiceOn == on) return
        _state.update { it.copy(voiceOn = on) }
        val room = room ?: return
        tell(room, Outgoing.voice(on))
        append(Line(Line.Kind.NOTE, if (on) "voice on" else "voice off"))
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

    private fun append(vararg lines: Line) {
        _state.update { it.copy(lines = it.lines + lines) }
    }

    /** 14.7 the line the answer is growing on, by index, since a note may land after it. */
    private var growing: Int? = null

    private fun grow(text: String) {
        _state.update {
            val at = growing
            if (at == null) {
                growing = it.lines.size
                it.copy(lines = it.lines + Line(Line.Kind.BRIDGE, text))
            } else {
                val lines = it.lines.toMutableList()
                lines[at] = Line(Line.Kind.BRIDGE, "${lines[at].text} $text")
                it.copy(lines = lines)
            }
        }
    }

    /** The whole answer takes the growing line's place, or a line of its own. */
    private fun answered(line: Line) {
        val at = growing
        growing = null
        if (at == null) { append(line); return }
        _state.update {
            val lines = it.lines.toMutableList()
            lines[at] = line
            it.copy(lines = lines)
        }
    }
}
