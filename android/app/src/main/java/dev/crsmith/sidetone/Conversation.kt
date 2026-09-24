package dev.crsmith.sidetone

/**
 * What the client knows about the conversation, and what one message does to it
 * (14.7, 14.9, 17.11, 17.12).
 *
 * This used to live inside `Bridge.on`, a function that takes the room and the
 * thing that ends it, so none of it ran without a room: nine of its eleven
 * branches need no room at all, and the two that do only send a reading and ask
 * for a rejoin. The cost showed in the tests, which held a second copy of the
 * dispatch so the behaviour could be asserted, and that copy had already
 * drifted away from this one.
 *
 * So the state and the decisions are here, and they are a message in and a new
 * state plus a few [Effect]s out. `Bridge` keeps the room, the microphone and
 * the retry, and does the effects.
 */
class Conversation(val transcript: Transcript = Transcript()) {
    /** What a message asks of the world outside the conversation. */
    sealed interface Effect {
        /** 17.17 a notification, because the phone is in a pocket or the audio is cut. */
        data class Alert(val title: String, val text: String) : Effect
        /** 17.15 the bridge named the app it serves; fetch it if it is not this one. */
        data class Offer(val apk: Apk?) : Effect
        /** 18.9 leave the room and join again, so a new microphone track is published. */
        data object Rejoin : Effect
        /** 14.15 the bridge greeted this app, so it is a bridge that has to be told what the phone is. */
        data object Device : Effect
        /** 18.15 run with this setup, or with the one in the code for null: keep it, and rejoin the room with it. */
        data class Setup(val names: SetupNames?) : Effect
    }

    val lines: List<Line> get() = transcript.lines

    /** 9.4.8 what the Stop button says, as the bridge gave it. Null when no room has said. */
    var endTurn: String? = null
        private set

    /**
     * 17.21 where the spoken sentence (14.13) is: the index of its line and where
     * it ends in the trimmed words. A sentence that no bubble holds, such as a reply
     * from the bridge during a hold, leaves it where it was. Null greys nothing.
     */
    var spoken: Pair<Int, Int>? = null
        private set

    /** 9.4.9 the settings in force on the bridge: the switches, and the words of the rest. */
    var settingsOn: Map<String, Boolean> = emptyMap()
        private set
    var settingWords: Map<String, String> = emptyMap()
        private set
    var settingNumbers: Map<String, Double> = emptyMap()
        private set
    /**
     * Item 44 how many settings messages came. A refused value comes back as
     * the same settings again, and equal maps say nothing changed: the count
     * is what puts a slider back to what the bridge holds (17.22.5).
     */
    var settingsCount = 0
        private set

    /**
     * 14.12.7 what became of each screenshot, by id, as the bridge last said:
     * "pending", "sent", "expired" or "dropped". A dropped one keeps its line
     * and is not shown, so the index of a growing line does not move.
     */
    var screenshots: Map<String, String> = emptyMap()
        private set

    /** 17.11 whether the bridge says the agent works. */
    var sign: Sign = Sign.OFF
        private set

    private var historyShown = false
    private var workingOn = false
    private var workingAt = 0L

    /**
     * One message from the bridge. `at` is the wall clock, which stamps a line,
     * and `since` is [android.os.SystemClock.elapsedRealtime], which decides
     * whether the sign has gone stale. `inFront` and `audioOn` decide only
     * whether a line is also worth a notification.
     */
    fun receive(message: Incoming?, at: Long, since: Long, inFront: Boolean, audioOn: Boolean): List<Effect> {
        when (message) {
            null -> return emptyList()
            is Incoming.Sentence -> transcript.onSentence(message, at)
            is Incoming.BlockStart -> transcript.onBlock(message, at)
            is Incoming.Delta -> transcript.onDelta(message, at)
            is Incoming.BlockEnd -> Unit
            is Incoming.Turn -> {
                // 14.13 the voice can still be saying the answer, so the spoken sentence stays
                transcript.onTurn(message, at)
                // 17.17.2 a reply the voice did not play
                if (!inFront && !audioOn) return listOf(Effect.Alert("Reply", message.line.text))
            }
            is Incoming.Said -> transcript.onLines(if (message.line.kind == Line.Kind.YOU) "heard" else "note", at, message.line)
            is Incoming.Protocol -> {
                endTurn = message.endTurn
                return listOf(Effect.Offer(message.apk), Effect.Device)
            }
            is Incoming.Offer -> return listOf(Effect.Offer(message.apk))
            is Incoming.Announce -> {
                transcript.onLines("note", at, message.line)
                // 17.17.1 the voice says it too, but not to a phone in a pocket with the audio cut
                if (!inFront) return listOf(Effect.Alert("Sidetone", message.line.text))
            }
            is Incoming.Rejoin -> return listOf(Effect.Rejoin)
            is Incoming.Setup -> return listOf(Effect.Setup(message.names))
            is Incoming.Speaking -> spokenIn(lines, message.text)?.let { spoken = it }
            is Incoming.Screenshot -> {
                // 17.18.5 the bridge has it: the thumbnail joins the transcript once
                if (message.id !in screenshots) transcript.onLines("screenshot", at, Line(Line.Kind.SCREENSHOT, message.id))
                else transcript.onEvent("screenshot", "${message.id} ${message.state}", at)
                screenshots = screenshots + (message.id to message.state)
            }
            is Incoming.Settings -> {
                settingsOn = message.on
                settingWords = message.words
                settingNumbers = message.numbers
                settingsCount += 1
            }
            is Incoming.Working -> {
                workingOn = message.on
                workingAt = since
                tick(since)
            }
            is Incoming.Unknown -> transcript.onLines("unknown", at, Line(Line.Kind.NOTE, "(unknown message: ${message.kind})"))
            is Incoming.History -> {
                if (historyShown) return emptyList()
                historyShown = true
                if (message.lines.isEmpty()) return emptyList()
                // say plainly that this is older, or it reads as the conversation in progress
                transcript.onLines("history", at, Line(Line.Kind.NOTE, "earlier"), *message.lines.toTypedArray(), Line(Line.Kind.NOTE, "now"))
            }
        }
        return emptyList()
    }

    /**
     * 17.11 the sign goes to "no signal" with no message to say so, so the clock
     * decides as well as the messages. True when it changed, which is when the
     * screen and the log need it.
     */
    fun tick(since: Long, at: Long = System.currentTimeMillis()): Boolean {
        val next = sign(workingOn, workingAt, since)
        if (next == sign) return false
        sign = next
        transcript.onSign(next, at)
        return true
    }

    /** 4.3.1 something the app records and does not show, such as a microphone cut. */
    fun record(kind: String, text: String, at: Long) = transcript.onEvent(kind, text, at)

    /** The room is gone: its protocol and its last word about work went with it. */
    fun roomEnded(since: Long, at: Long = System.currentTimeMillis()) {
        workingOn = false
        endTurn = null
        tick(since, at)
    }

    /** A conversation that ended has no lines, no log and no work to show. */
    fun clear() {
        transcript.clear()
        historyShown = false
        workingOn = false
        endTurn = null
        settingsOn = emptyMap()
        settingWords = emptyMap()
        settingNumbers = emptyMap()
        settingsCount = 0
        spoken = null
        screenshots = emptyMap()
    }
}
