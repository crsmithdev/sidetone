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
 * state plus a few [Effect]s out. [ClientRoom] keeps the room, the microphone and
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
        /** 14.16 the bridge loads its speech workers, or has loaded them: the status row says which (17.11.11). */
        data class Starting(val on: Boolean) : Effect
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
    /** 9.4.9.1 the `seq` of the settings shown, so a late older message changes nothing. */
    private var settingsSeq: Long? = null

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
                val last = settingsSeq
                if (message.seq == null || last == null || message.seq > last) {
                    settingsSeq = message.seq
                    settingsOn = message.on
                    settingWords = message.words
                    settingNumbers = message.numbers
                    settingsCount += 1
                }
            }
            is Incoming.Working -> {
                workingOn = message.on
                workingAt = since
                tick(since)
            }
            is Incoming.Starting -> {
                // a bridge that starts is a new process: the word about work was the old one's.
                // The protocol came just before this, from the new one, so it stays.
                if (message.on) {
                    workingOn = false
                    tick(since, at)
                }
                return listOf(Effect.Starting(message.on))
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

    /**
     * The bridge is gone, or the room with it: its protocol and its last word
     * about work went with it. 17.11.11 a bridge that left does not go
     * "stalled": it stopped sending because it is not there.
     */
    fun bridgeGone(since: Long, at: Long = System.currentTimeMillis()) {
        workingOn = false
        endTurn = null
        tick(since, at)
    }

    /**
     * What the screen shows now. The rules of what shows are here, so a test
     * reads them; the screen only draws the result.
     */
    fun onScreen(): OnScreen {
        // 14.9 a bubble with no words yet is not shown: the block has begun and the first word has not come.
        // 17.18.5 nor is a screenshot that Chris dropped. The line stays, so a growing line keeps its index.
        val visible = lines.indices.filter { i ->
            val line = lines[i]
            line.text.isNotBlank() && !(line.kind == Line.Kind.SCREENSHOT && screenshots[line.text] == "dropped")
        }
        return OnScreen(
            lines = visible.map { lines[it] },
            // 17.21 the spoken line by its place among the visible lines; a hidden line greys nothing
            spoken = spoken?.let { (at, end) -> visible.indexOf(at).takeIf { it >= 0 }?.let { it to end } },
            endTurn = endTurn,
            sign = sign,
            screenshotWords = screenshots.mapNotNull { (id, state) -> screenshotWords(state)?.let { id to it } }.toMap(),
            pending = screenshots.filterValues { it == "pending" }.keys,
            // 17.10.6 the saved settings are the bridge's: on until it says otherwise, and each button waits for it
            audioOn = settingsOn["audio"] ?: true,
            audioEnabled = "audio" in settingsOn,
            musicOn = settingsOn["holdMusic"] ?: true,
            musicEnabled = "holdMusic" in settingsOn,
            settings = Incoming.Settings(settingsOn, settingWords, settingNumbers),
            settingsCount = settingsCount,
        )
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
        settingsSeq = null
        spoken = null
        screenshots = emptyMap()
    }
}

/**
 * What the screen shows of the conversation, from [Conversation.onScreen]. The
 * screen draws it and decides nothing.
 */
data class OnScreen(
    /** The lines that show, in order: no empty bubble, no dropped screenshot. */
    val lines: List<Line> = emptyList(),
    /** 17.21 the spoken sentence: the index of its line in [lines], and where it ends in the trimmed words. */
    val spoken: Pair<Int, Int>? = null,
    /** 9.4.8 what the Stop button says, as the bridge gave it. Null disables the button. */
    val endTurn: String? = null,
    /** 17.11 whether the bridge says the agent works. It is shown whatever the audio does. */
    val sign: Sign = Sign.OFF,
    /** 17.18.5 the words under a screenshot's thumbnail, by id. A screenshot with none says nothing. */
    val screenshotWords: Map<String, String> = emptyMap(),
    /** 14.12.7 the ids of the pending screenshots, which a tap drops. */
    val pending: Set<String> = emptySet(),
    /** 11.12 whether the bridge makes any sound, or only writes its answers, as the bridge last said (17.10.6). */
    val audioOn: Boolean = true,
    /** 17.10.6 the Audio button waits for the bridge to send the setting. */
    val audioEnabled: Boolean = false,
    /** 15.7.3 whether the bridge may play hold music, as the bridge last said (17.10.6). */
    val musicOn: Boolean = true,
    /** 17.10.6 the Music button waits for the bridge to send the setting. */
    val musicEnabled: Boolean = false,
    /** 9.4.9 the settings in force on the bridge, which the options screen shows (item 28). */
    val settings: Incoming.Settings = Incoming.Settings(emptyMap(), emptyMap(), emptyMap()),
    /** Item 44 how many settings messages came; each puts the sliders back to what the bridge holds. */
    val settingsCount: Int = 0,
)

/** 17.18.5 what a thumbnail says under it for each state the bridge gives (14.12.7). A sent one says nothing. */
fun screenshotWords(state: String): String? = when (state) {
    "pending" -> "attached to your next message"
    "expired" -> "not sent: it waited too long"
    else -> null
}
