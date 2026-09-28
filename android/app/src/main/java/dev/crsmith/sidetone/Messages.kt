package dev.crsmith.sidetone

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put

/**
 * One line of the transcript (14.7). `at` is the time in milliseconds since 1970
 * that the line shows on its bubble (17.9), and null while nothing has stamped it.
 * 17.18.5 a [Kind.SCREENSHOT] line shows the thumbnail of a screenshot, and its text is the screenshot's id.
 */
data class Line(val kind: Kind, val text: String, val at: Long? = null) {
    enum class Kind { YOU, BRIDGE, NOTE, SCREENSHOT }
}

/** 4.3 a message on the control channel, from the bridge. */
sealed interface Incoming {
    /** A line that no answer grows: what Chris said, a narration, an error. */
    data class Said(val line: Line) : Incoming

    /** 14.7 the whole answer, and which answer it closes. 11.11.1 every turn names one. */
    data class Turn(val line: Line, val answer: Int) : Incoming

    /** 14.7 one sentence of the answer, ahead of the voice; the turn that follows carries the whole. */
    data class Sentence(val text: String, val answer: Int? = null) : Incoming

    /** 14.9 a block of the answer that holds text begins: one bubble. */
    data class BlockStart(val answer: Int, val block: Int) : Incoming

    /**
     * 14.9 words of the block, as the agent writes them. `seq` counts the deltas
     * of the block from 1. It is null from a bridge that numbers none.
     */
    data class Delta(val text: String, val answer: Int, val block: Int, val seq: Int? = null) : Incoming

    /** 14.9 the block is complete. The app has nothing to do: the next block names itself. */
    data class BlockEnd(val answer: Int, val block: Int) : Incoming

    /** 17.17 a line the bridge queued to say, such as the end of a job. The app notifies it when it is not in front. */
    data class Announce(val line: Line) : Incoming

    /** 14.8 the turns that happened while this client was away. */
    data class History(val lines: List<Line>) : Incoming

    /** What only the bridge knows: the words this client has to say back to it, and 17.15 the app it serves. */
    data class Protocol(val endTurn: String, val apk: Apk? = null) : Incoming

    /** 17.15.5 a new build of the app, served while this client is in the room. */
    data class Offer(val apk: Apk) : Incoming

    /** 18.9 the microphone track carries no sound: leave the room and join it again. */
    data object Rejoin : Incoming

    /**
     * 18.15 the audio setup to run with, in names, or null for the one in the
     * app's code. The room is built with the setup at join, so the app rejoins.
     */
    data class Setup(val names: SetupNames?) : Incoming

    /** 14.10 the agent works (`on`), or does not. The bridge repeats "on" every few seconds while the work lasts. */
    data class Working(val on: Boolean) : Incoming

    /** 14.16 the bridge loads its speech workers (`on`), or has loaded them and hears. */
    data class Starting(val on: Boolean) : Incoming

    /**
     * A kind this app does not know, which means the two ends have drifted
     * apart. It is shown rather than dropped: dropping it is how the drift
     * stayed hidden.
     */
    data class Unknown(val kind: String) : Incoming

    /**
     * 9.4.9 the settings in force on the bridge, sent when this client joins and
     * whenever one changes, however it changed. The app shows what it can and
     * sends [Outgoing.setting] to change one. 9.4.9.1 `seq` grows with each
     * message, so an older one that arrives late is dropped; null from a bridge
     * that sends none.
     */
    data class Settings(val on: Map<String, Boolean>, val words: Map<String, String>, val numbers: Map<String, Double> = emptyMap(), val seq: Long? = null) : Incoming

    /**
     * 14.13 the voice started saying this sentence. A [Sentence] says the words
     * are known; this says they are being heard, which is seconds later when the
     * queue is long. A sentence a barge-in cut is said again, so this can repeat.
     */
    data class Speaking(val text: String, val answer: Int?) : Incoming

    /**
     * 14.12.7 what became of a screenshot this app sent: "pending" until a turn
     * takes it, then "sent", or "expired", or "dropped" when Chris tapped it.
     */
    data class Screenshot(val id: String, val state: String) : Incoming
}

fun decode(payload: ByteArray): Incoming? {
    val message = runCatching { Json.parseToJsonElement(payload.decodeToString()) as? JsonObject }.getOrNull() ?: return null
    val kind = message.string("kind") ?: return null
    val apk = (message["apk"] as? JsonObject)?.let { offered ->
        val url = offered.string("url")
        val sha256 = offered.string("sha256")
        if (url != null && sha256 != null) Apk(url, sha256) else null
    }
    if (kind == "protocol") return Incoming.Protocol(message.string("endTurn") ?: return null, apk)
    if (kind == "apk") return Incoming.Offer(apk ?: return null)
    if (kind == "rejoin") return Incoming.Rejoin
    if (kind == "setup") {
        // a default reads nothing else, so a stale name cannot ride along
        if (message.bool("default") == true) return Incoming.Setup(null)
        return Incoming.Setup(setupNames(message) ?: return null)
    }
    if (kind == "screenshot") return Incoming.Screenshot(message.string("id") ?: return null, message.string("state") ?: return null)
    if (kind == "speaking") return Incoming.Speaking(message.string("text") ?: return null, message.int("answer"))
    if (kind == "settings") {
        val settings = message["settings"] as? JsonObject ?: return Incoming.Settings(emptyMap(), emptyMap())
        val on = mutableMapOf<String, Boolean>()
        val words = mutableMapOf<String, String>()
        val numbers = mutableMapOf<String, Double>()
        for ((name, value) in settings) {
            val primitive = value as? JsonPrimitive ?: continue
            if (primitive.isString) words[name] = primitive.content
            else primitive.content.toBooleanStrictOrNull()?.let { on[name] = it } ?: primitive.doubleOrNull?.let { numbers[name] = it }
        }
        return Incoming.Settings(on, words, numbers, message.long("seq"))
    }
    if (kind == "working") return Incoming.Working(message.bool("on") ?: return null)
    if (kind == "starting") return Incoming.Starting(message.bool("on") ?: return null)
    if (kind == "sentence") {
        val text = message.string("text") ?: return null
        return Incoming.Sentence(text, message.int("answer"))
    }
    if (kind == "blockStart" || kind == "blockEnd" || kind == "delta") {
        val answer = message.int("answer") ?: return null
        val block = message.int("block") ?: return null
        if (kind == "blockStart") return Incoming.BlockStart(answer, block)
        if (kind == "blockEnd") return Incoming.BlockEnd(answer, block)
        val text = message.string("text") ?: return null
        return Incoming.Delta(text, answer, block, message.int("seq"))
    }
    if (kind == "history") {
        val turns = message["turns"] as? JsonArray ?: return Incoming.History(emptyList())
        val lines = turns.mapNotNull { (it as? JsonObject)?.let(::lineOf) }.filter { it.kind != Line.Kind.NOTE }
        return Incoming.History(lines)
    }
    if (kind == "narration" && message.bool("announce") == true) return lineOf(message)?.let(Incoming::Announce)
    if (kind == "turn") {
        val answer = message.int("answer") ?: return Incoming.Unknown("turn with no answer")
        return lineOf(message)?.let { Incoming.Turn(it, answer) } ?: Incoming.Unknown(kind)
    }
    return lineOf(message)?.let(Incoming::Said) ?: Incoming.Unknown(kind)
}

/** 18.15 the six names of a setup, from the `setup` message or the store; null when one is missing. */
fun setupNames(message: JsonObject): SetupNames? = SetupNames(
    mode = message.string("mode") ?: return null,
    output = message.string("output") ?: return null,
    focus = message.string("focus") ?: return null,
    canceller = message.string("canceller") ?: return null,
    noiseSuppression = message.bool("noiseSuppression") ?: return null,
    autoGainControl = message.bool("autoGainControl") ?: return null,
)

/** 18.15 the six names as the `device` message and the store write them. */
fun setupJson(names: SetupNames): JsonObject = buildJsonObject {
    put("mode", names.mode)
    put("output", names.output)
    put("focus", names.focus)
    put("canceller", names.canceller)
    put("noiseSuppression", names.noiseSuppression)
    put("autoGainControl", names.autoGainControl)
}

private fun lineOf(message: JsonObject): Line? {
    val text = message.string("text") ?: return null
    val kind = when (message.string("kind")) {
        "heard" -> Line.Kind.YOU
        "turn" -> Line.Kind.BRIDGE
        "narration", "error" -> Line.Kind.NOTE
        else -> return null
    }
    // 17.9 a kept line carries the time the bridge kept it; a live one carries none, and the app stamps it
    return Line(kind, text, message.long("at"))
}

private fun JsonObject.string(key: String): String? = (this[key] as? kotlinx.serialization.json.JsonPrimitive)?.contentOrNull

private fun JsonObject.long(key: String): Long? = (this[key] as? kotlinx.serialization.json.JsonPrimitive)?.longOrNull

private fun JsonObject.bool(key: String): Boolean? = (this[key] as? kotlinx.serialization.json.JsonPrimitive)?.booleanOrNull

private fun JsonObject.int(key: String): Int? = (this[key] as? kotlinx.serialization.json.JsonPrimitive)?.intOrNull

/** 4.3 messages to the bridge. `decodeIncoming` in `src/messages.ts` reads each kind; `MessagesTest` writes them all to `test/fixtures/from-app.jsonl` (ADR 0007). */
object Outgoing {
    fun said(text: String): ByteArray = encode(buildJsonObject { put("kind", "said"); put("text", text) })

    /**
     * 9.5.2 `release` says the cut is a hold to talk button let go: the bridge
     * ends what was recorded as an utterance. A cut without it drops the words.
     * 15.12 `hold` says the open is a hold to talk button pressed, so the bridge
     * plays the press cue.
     */
    fun mic(on: Boolean, release: Boolean = false, hold: Boolean = false): ByteArray =
        encode(buildJsonObject {
            put("kind", "mic"); put("on", on)
            if (release) put("release", true)
            if (hold) put("hold", true)
        })

    fun quality(quality: String): ByteArray = encode(buildJsonObject { put("kind", "quality"); put("quality", quality) })

    /** Item 56 what the phone received of the bridge's voice in the last `ms`, as [Received] counts it. */
    fun receive(ms: Long, got: Received): ByteArray = encode(buildJsonObject {
        put("kind", "receive"); put("ms", ms)
        put("packets", got.packets); put("lost", got.lost)
        put("samples", got.samples); put("concealed", got.concealed); put("events", got.events)
        put("inserted", got.inserted); put("removed", got.removed); put("bufferMs", got.bufferMs)
        got.codec?.let { put("codec", it) }
    })

    /**
     * 9.4.9 change one setting. It does exactly what the spoken command does,
     * the voice's answer included, so a switch and the words cannot disagree.
     * The bridge ignores a name it has no command for.
     */
    fun setting(name: String, on: Boolean): ByteArray = encode(buildJsonObject {
        put("kind", "setting")
        put("patch", buildJsonObject { put(name, on) })
    })

    /** Item 28 the verbosity (9.4.10), as "verbosity brief" and the rest do. */
    fun setting(name: String, word: String): ByteArray = encode(buildJsonObject {
        put("kind", "setting")
        put("patch", buildJsonObject { put(name, word) })
    })

    /** Item 28 the hold music volume, from 0 to 1. It has no spoken command. */
    fun setting(name: String, number: Double): ByteArray = encode(buildJsonObject {
        put("kind", "setting")
        put("patch", buildJsonObject { put(name, number) })
    })

    /** Item 44 the end-of-turn pause, in milliseconds, so it goes as a whole number. */
    fun setting(name: String, number: Int): ByteArray = encode(buildJsonObject {
        put("kind", "setting")
        put("patch", buildJsonObject { put(name, number) })
    })

    /** 15.7.6 the hold music delay from the options screen, in seconds, sent as the bridge's milliseconds. */
    fun musicDelay(seconds: Int): ByteArray = setting("holdMusicAfterMs", seconds * 1_000)

    /**
     * 11.12 cut all the audio and keep the words, for somewhere the bridge must not be heard.
     * The kind is still "voice", the name it had when the voice was all the audio there was.
     */
    fun audio(on: Boolean): ByteArray = encode(buildJsonObject { put("kind", "voice"); put("on", on) })

    /** 15.7.3 the hold music off or on; the voice and the tones stay as they are. */
    fun music(on: Boolean): ByteArray = encode(buildJsonObject { put("kind", "music"); put("on", on) })

    /**
     * 14.11 one part of the screen log, for the bridge to write to disk. `id` names the
     * log, `part` counts from 1 and `of` is how many parts there are.
     */
    fun screen(id: String, part: Int, of: Int, entries: List<JsonObject>): ByteArray = encode(buildJsonObject {
        put("kind", "screen")
        put("id", id)
        put("part", part)
        put("of", of)
        put("entries", JsonArray(entries))
    })

    /**
     * 14.12 one part of a screenshot, for the bridge to write to disk. `id` names the
     * image, `part` counts from 1, `of` is how many parts there are, and `data` is a slice of its base64.
     */
    fun screenshot(id: String, part: Int, of: Int, data: String): ByteArray = encode(buildJsonObject {
        put("kind", "screenshot")
        put("id", id)
        put("part", part)
        put("of", of)
        put("data", data)
    })

    /** 14.12.7 drop a pending screenshot, so no turn takes it. */
    fun dropScreenshot(id: String): ByteArray = encode(buildJsonObject {
        put("kind", "screenshot")
        put("id", id)
        put("drop", true)
    })

    /** 14.14 one crash report, whole or cut to fit. */
    fun crash(id: String, text: String): ByteArray = encode(buildJsonObject {
        put("kind", "crash")
        put("id", id)
        put("text", text)
    })

    /**
     * 14.15 what the phone says about itself as it joins: the model, whether it
     * has a hardware echo canceller, which canceller runs, the audio route, and
     * the SHA-256 of its own app, when it could read it. 18.15 `setup` is the
     * setup in force and `pushed` whether the bridge pushed it, so the record
     * always names what ran.
     */
    fun device(model: String, aec: Boolean, canceller: String, route: String, apk: String?, setup: SetupNames, pushed: Boolean): ByteArray = encode(buildJsonObject {
        put("kind", "device")
        put("model", model)
        put("aec", aec)
        put("canceller", canceller)
        put("route", route)
        apk?.let { put("apk", it) }
        put("setup", setupJson(setup))
        put("pushed", pushed)
    })

    private fun encode(message: JsonObject): ByteArray = message.toString().encodeToByteArray()
}
