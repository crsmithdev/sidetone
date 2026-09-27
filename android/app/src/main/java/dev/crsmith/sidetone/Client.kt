package dev.crsmith.sidetone

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

/**
 * The client with a room: the microphone, what goes to the bridge, the setup
 * the bridge pushes, and the loop that opens one room after another.
 *
 * This used to be all of `Bridge`, an object with an Android context and a
 * LiveKit room in it, so none of these rules ran in a test: a hold writes no
 * cut (17.10.5), a screen log part that fails goes back first (14.11), a crash
 * report that does not go stays on disk (17.20.2), a setup name the app does
 * not know changes nothing (18.15). [Conversation] and [Joining] made this move
 * for their halves; this is the rest. The room is a [Room], so a test hands in
 * one that writes down what it was sent. `Bridge` keeps the context, the
 * service, the audio route and the LiveKit room, and calls this.
 */
class Client(
    /** What the screen shows. `Bridge` holds it, so the screen can read it before the app is loaded. */
    val state: MutableStateFlow<Bridge.State>,
    /** 17.20.4 an error in a launched coroutine is written down, and the app goes on. */
    private val scope: CoroutineScope,
    /** 17.10.5 the cuts, kept across a process death. */
    private val cuts: CutStore,
    /** 18.15 the setup the bridge pushed, kept across a restart. Empty, the app runs with the one in its code. */
    private val setups: SetupStore,
    private val crashes: Crashes,
    private val log: Logcat,
    /** The elapsed clock, [android.os.SystemClock.elapsedRealtime] in the app. */
    private val elapsed: () -> Long,
    /** 17.11 the bridge refused the pairing: forget it and stop the service. */
    private val forget: () -> Unit,
    /** What a message asks of the phone alone: 17.17 an alert, 17.15 an update, 14.15 the device message. */
    private val phone: (Room, Conversation.Effect) -> Unit,
) {
    /** Where the client writes for logcat. The app hands in `android.util.Log`; a test writes nothing. */
    interface Logcat {
        fun info(text: String) {}
        fun warn(text: String, error: Throwable? = null) {}
        fun error(text: String, error: Throwable) {}
    }

    private val micLock = Mutex()

    /** The room that is open, or null between rooms. */
    private var room: Room? = null

    /** 17.11 and 18.9 the status word, the retry and the rejoin, apart from the room. */
    private val joining = Joining()

    /** 17.17 whether the app is on the screen. */
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

    val status: Status get() = joining.status

    /**
     * Open one room after another, and stop only when the bridge refuses the
     * pairing. `runRoom` opens one room and returns why it ended.
     */
    suspend fun loop(runRoom: suspend () -> String) {
        while (true) {
            link(Joining.Event.Opening)
            // 17.20.4 a room that throws ends as any room ends, so the loop opens the next one
            val reason = try {
                runRoom()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                caught("the room", e)
                e.message ?: e.toString()
            }
            log.info("the room ended: $reason")
            for (effect in link(Joining.Event.Ended(reason))) when (effect) {
                is Joining.Effect.Open -> delay(effect.at - elapsed())
                is Joining.Effect.Forget -> {
                    forget()
                    reset()
                    state.value = cuts.load().applyTo(Bridge.State(error = joining.error))
                    return
                }
                // no room is open to end
                is Joining.Effect.End -> Unit
            }
        }
    }

    /** 17.22.4 the conversation ended. `paired` says whether the app still has a pairing. */
    fun quit(paired: Boolean) {
        reset()
        link(Joining.Event.Quit)
        // 17.10.5 the cuts are the phone's, not the conversation's, so they stay
        state.value = cuts.load().applyTo(Bridge.State(paired = paired))
    }

    /** A conversation that ended has no lines, no log and no work to show. */
    private fun reset() {
        conversation.clear()
        unsent.clear()
        logId = System.currentTimeMillis().toString()
    }

    /**
     * One room, from connect to its end. `connect` joins it and says whether
     * the bridge is in it. Returns why it ended.
     */
    suspend fun inRoom(room: Room, connect: suspend () -> Boolean): String = coroutineScope {
        this@Client.room = room
        val ended = CompletableDeferred<String>()
        val events = launch { room.events.collect { on(room, it, ended) } }
        // 17.11 the sign goes to "stalled" with no message to say so, so it is looked at on the clock
        val watch = launch { while (true) { delay(1_000); showSign() } }
        // 14.11 the screen log goes to the bridge as it grows
        val stream = launch { while (true) { delay(STREAM_MS); sendScreenLog(room) } }
        try {
            // 17.11.11 the phone can be in the room while the bridge is not, as during a restart
            link(Joining.Event.Connected(bridgeHere = connect()))
            if (state.value.micOn) micLock.withLock { room.openMic() }
            sendCrashes(room)
            ended.await()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            log.warn("the room failed", e)
            e.message ?: e.toString()
        } finally {
            events.cancel()
            watch.cancel()
            stream.cancel()
            // the protocol, the last reading and the last word about work belonged to a room that is gone
            conversation.bridgeGone(elapsed(), now())
            state.update { it.copy(quality = null, endTurn = conversation.endTurn, sign = conversation.sign) }
            this@Client.room = null
        }
    }

    /** 17.20.4 an event that fails is dropped and written down, and the room goes on. */
    private fun on(room: Room, event: Room.Event, ended: CompletableDeferred<String>) {
        try {
            handle(room, event, ended)
        } catch (e: Exception) {
            caught("a room event", e)
        }
    }

    private fun handle(room: Room, event: Room.Event, ended: CompletableDeferred<String>) {
        when (event) {
            Room.Event.Reconnecting -> link(Joining.Event.Reconnecting)
            Room.Event.Reconnected -> link(Joining.Event.Reconnected)
            is Room.Event.Ended -> ended.complete(event.reason)
            Room.Event.BridgeArrived -> {
                record("bridge", "the bridge joined the room")
                link(Joining.Event.BridgeArrived)
            }
            is Room.Event.BridgeLeft -> {
                record("bridge", "the bridge left the room")
                if (!event.last) return
                conversation.bridgeGone(elapsed(), now())
                shown()
                link(Joining.Event.BridgeLeft)
            }
            is Room.Event.Quality -> {
                if (event.quality == state.value.quality) return
                state.update { it.copy(quality = event.quality) }
                tell(room, Outgoing.quality(event.quality))
            }
            is Room.Event.Data -> {
                val effects = conversation.receive(decode(event.payload), now(), elapsed(), inFront, state.value.audioOn)
                shown()
                for (effect in effects) when (effect) {
                    is Conversation.Effect.Alert, is Conversation.Effect.Offer, Conversation.Effect.Device -> phone(room, effect)
                    is Conversation.Effect.Rejoin -> rejoin(ended)
                    is Conversation.Effect.Setup -> applySetup(effect.names, ended)
                    is Conversation.Effect.Starting -> link(Joining.Event.Starting(effect.on))
                }
            }
        }
    }

    /**
     * 18.9 the bridge hears no sound from the microphone track, and only this
     * end can publish a new one. Ending the room makes [loop] connect again,
     * and [inRoom] opens the microphone again if it was open. A request inside
     * [REJOIN_MS] of the last rejoin is ignored, so a silent phone cannot loop.
     */
    private fun rejoin(ended: CompletableDeferred<String>) {
        val effects = link(Joining.Event.RejoinAsked)
        if (effects.isEmpty()) log.info("the bridge asked for a rejoin inside ${REJOIN_MS / 1000} s of the last one; ignored")
        for (effect in effects) when (effect) {
            is Joining.Effect.End -> {
                log.info("the bridge asked for a rejoin")
                record("rejoin", "rejoining to publish a new microphone track")
                ended.complete(effect.reason)
            }
            // a rejoin asks only for the room to end; the loop opens the next
            is Joining.Effect.Open, Joining.Effect.Forget -> Unit
        }
    }

    /**
     * 18.15 the setup the room is built with, and whether the bridge pushed it.
     * A kept setup that does not read, such as one an older app wrote, is no
     * setup: the app runs with the one in its code and says so.
     */
    fun setupInForce(): Pair<AudioSetup, Boolean> {
        val pushed = setups.load()?.let(Audio::named) ?: return Audio.setup to false
        return pushed to true
    }

    /**
     * 18.15 the bridge pushed a setup, or asked for the one in the code. It is
     * kept first, so it survives a restart, and then the room ends the way a
     * rejoin does (18.9): [loop] opens the next room with it. A name this app
     * does not map is refused and written down, and nothing changes.
     */
    private fun applySetup(names: SetupNames?, ended: CompletableDeferred<String>) {
        if (names == null) {
            setups.clear()
            record("setup", "the audio setup is the one in the code again; rejoining")
        } else {
            if (Audio.named(names) == null) {
                log.warn("a pushed audio setup has a name this app does not know: $names")
                record("setup", "a pushed audio setup was refused, a name this app does not know: $names")
                return
            }
            setups.save(names)
            record("setup", "a pushed audio setup: ${names.mode} mode, ${names.output} output, ${names.focus} focus, ${names.canceller} canceller, " +
                "noise suppression ${if (names.noiseSuppression) "on" else "off"}, auto gain control ${if (names.autoGainControl) "on" else "off"}; rejoining")
        }
        log.info("the audio setup changed; rejoining")
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
        if (state.value.micOn || state.value.holding) return
        state.update { it.copy(holding = true) }
        switchMic(true, byHold = true)
    }

    /** 9.5.2 the button is up: cut the microphone, and tell the bridge the words end now. */
    fun release() {
        if (!state.value.holding) return
        state.update { it.copy(holding = false) }
        switchMic(false, byHold = true)
    }

    private fun switchMic(on: Boolean, byHold: Boolean) {
        scope.launch {
            micLock.withLock {
                if (state.value.micOn == on) return@launch
                val room = room
                // with no room the state is what the next room opens; with one it follows the track
                if (room != null) {
                    try {
                        if (on) room.openMic() else room.closeMic()
                    } catch (e: CancellationException) {
                        throw e
                    } catch (e: Exception) {
                        // a publish fails while the room reconnects: the button stays as it was
                        log.warn("the microphone did not switch", e)
                        append("note", Line(Line.Kind.NOTE, "the microphone did not ${if (on) "open" else "close"}: ${e.message ?: e}"))
                        return@launch
                    }
                }
                state.update { it.copy(micOn = on) }
                // a hold is not a cut: a death while the button is down must not leave the microphone open
                if (!byHold) keepCuts()
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
        // 17.10.6 the button changes when the bridge sends the settings back
        val room = room ?: return
        tell(room, Outgoing.audio(on))
        record("audio", if (on) "audio on" else "audio off")
    }

    /**
     * 17.10 turn the hold music off or on, as "music off" and "music on" do
     * (15.7.3). The voice and the tones carry on.
     */
    fun setMusic(on: Boolean) {
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

    /** 17.15 the installer finished or refused. A success ends this process, so this is a refusal or a cancel. */
    fun updateEnded(note: String?) {
        state.update { it.copy(updating = false) }
        note?.let { append("note", Line(Line.Kind.NOTE, it)) }
    }

    fun say(text: String) {
        room?.let { tell(it, Outgoing.said(text)) }
    }

    /** 9.4.8 by hand, for a car that is too loud to be heard in. */
    fun endTurn() {
        // the phrase belongs to the bridge, which owns the wake word
        state.value.endTurn?.let { say(it) }
    }

    private fun tell(room: Room, payload: ByteArray) {
        scope.launch {
            room.send(payload).onFailure { log.warn("the bridge was not told", it) }
        }
    }

    /**
     * 17.18 a screenshot Chris took, as a JPEG, named `id`. The thumbnail shows
     * at once; the image goes to the bridge in parts (14.12). Without a room,
     * or when a part fails, the rest does not go and nothing is said.
     */
    suspend fun sendScreenshot(id: String, jpeg: ByteArray) {
        // 17.18.5 the thumbnail shows once the bridge says it has the image
        state.update { it.copy(thumbnails = it.thumbnails + (id to jpeg)) }
        screenshotLock.withLock {
            for (part in screenshotParts(jpeg, id)) {
                val room = room ?: return
                if (room.send(part).isFailure) {
                    log.warn("the screenshot did not go")
                    return
                }
            }
        }
    }

    /** 17.18.5 Chris tapped a pending screenshot: no turn takes it (14.12.7). The bridge says when it is gone. */
    fun dropScreenshot(id: String) {
        room?.let { tell(it, Outgoing.dropScreenshot(id)) }
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

    /** 17.10.5 write the cuts down as they are now. */
    private fun keepCuts() = cuts.save(Cuts.of(state.value))

    /** 4.3.1 an event for the screen log, with no line on the screen. */
    fun record(kind: String, text: String) = conversation.record(kind, text, now())

    /** One event for the link, on the elapsed clock. The screen shows what the link says after it. */
    fun link(event: Joining.Event): List<Joining.Effect> {
        val effects = joining.on(event, elapsed())
        state.update { it.copy(status = joining.status, error = joining.error) }
        return effects
    }

    /** The screen shows what the conversation holds now. */
    private fun shown() {
        state.update { it.copy(lines = conversation.lines, spoken = conversation.spoken, endTurn = conversation.endTurn, sign = conversation.sign, screenshots = conversation.screenshots,
            settings = Incoming.Settings(conversation.settingsOn, conversation.settingWords, conversation.settingNumbers), settingsCount = conversation.settingsCount,
            // 17.10.6 the saved settings are the bridge's; on until it says otherwise
            audioOn = conversation.settingsOn["audio"] ?: true, musicOn = conversation.settingsOn["holdMusic"] ?: true) }
    }

    /**
     * 17.11 the sign, from what the bridge last said and the clock. A change goes
     * to the screen and to the log.
     */
    private fun showSign() {
        if (conversation.tick(elapsed(), now())) shown()
    }

    /** 17.20.4 an error the app lived through goes to the log and to a crash report. */
    fun caught(what: String, error: Throwable) {
        log.error("$what failed", error)
        crashes.caught(what, crashState(state.value), error)
    }

    /** 17.20.2 each report goes once, oldest first. A report that fails goes with the next room. */
    private fun sendCrashes(room: Room) {
        scope.launch {
            for (file in crashes.unsent()) {
                if (room.send(crashMessage(file.nameWithoutExtension, file.readText())).isFailure) {
                    log.warn("the crash report did not go")
                    return@launch
                }
                file.delete()
            }
        }
    }

    /**
     * 14.11 send the entries the bridge has not had, in parts that fit one
     * message. A part that fails goes back, with those after it, for the next try.
     * The parts are built off the main thread: after a long time out of the
     * room the backlog is up to 2,000 entries of JSON.
     */
    suspend fun sendScreenLog(room: Room) {
        if (unsent.isEmpty()) return
        val batch = unsent.toList()
        unsent.clear()
        val id = logId
        var sent = 0
        for (part in withContext(Dispatchers.Default) { screenParts(batch, id) }) {
            if (room.send(part.message).isFailure) {
                batch.drop(sent).asReversed().forEach(unsent::addFirst)
                return
            }
            sent += part.count
        }
    }

    private companion object {
        /** 14.11 how often the app sends new screen log entries. */
        const val STREAM_MS = 1_000L

        /** 14.11 the most entries kept for the bridge while the room is gone. The oldest go first. */
        const val UNSENT_MAX = 2_000
    }
}
