package dev.crsmith.sidetone

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

/** One line of the transcript (14.7). */
data class Line(val kind: Kind, val text: String) {
    enum class Kind { YOU, BRIDGE, NOTE }
}

/** 4.3 a message on the control channel, from the bridge. */
sealed interface Incoming {
    /** `answer` is on a turn only: the answer it closes. */
    data class Said(val line: Line, val answer: Int? = null) : Incoming

    /** 14.7 one sentence of the answer, ahead of the voice; the turn that follows carries the whole. */
    data class Sentence(val text: String, val answer: Int? = null) : Incoming

    /** 14.8 the turns that happened while this client was away. */
    data class History(val lines: List<Line>) : Incoming

    /** What only the bridge knows: the words this client has to say back to it. */
    data class Protocol(val endTurn: String) : Incoming

    /** 18.9 the microphone track carries no sound: leave the room and join it again. */
    data object Rejoin : Incoming

    /**
     * A kind this app does not know, which means the two ends have drifted
     * apart. It is shown rather than dropped: dropping it is how the drift
     * stayed hidden.
     */
    data class Unknown(val kind: String) : Incoming
}

fun decode(payload: ByteArray): Incoming? {
    val message = runCatching { Json.parseToJsonElement(payload.decodeToString()) as? JsonObject }.getOrNull() ?: return null
    val kind = message.string("kind") ?: return null
    if (kind == "protocol") {
        val endTurn = message.string("endTurn") ?: return null
        return Incoming.Protocol(endTurn)
    }
    if (kind == "rejoin") return Incoming.Rejoin
    if (kind == "sentence") {
        val text = message.string("text") ?: return null
        return Incoming.Sentence(text, message.int("answer"))
    }
    if (kind == "history") {
        val turns = message["turns"] as? JsonArray ?: return Incoming.History(emptyList())
        val lines = turns.mapNotNull { (it as? JsonObject)?.let(::lineOf) }.filter { it.kind != Line.Kind.NOTE }
        return Incoming.History(lines)
    }
    return lineOf(message)?.let { Incoming.Said(it, message.int("answer")) } ?: Incoming.Unknown(kind)
}

/** 18.9.4 the shortest time between two rejoins that the bridge asked for. */
const val REJOIN_MS = 30_000L

/** 18.9.4 whether a request to rejoin is due, given when the last rejoin began. Times are in milliseconds. */
fun rejoinDue(lastAt: Long?, now: Long): Boolean = lastAt == null || now - lastAt >= REJOIN_MS

/**
 * 14.7 the line an answer grows on: where it is, and which answer it is. A
 * bridge from before 21 September names no answer, and null matches null.
 */
data class Growing(val at: Int, val answer: Int?)

/**
 * A sentence joins the line of its own answer, or starts a line at the end.
 * An interrupted answer sends no turn, so its line stays growing; the next
 * answer used to grow on it, above the words that came in between.
 */
fun grow(lines: List<Line>, growing: Growing?, sentence: Incoming.Sentence): Pair<List<Line>, Growing> {
    if (growing == null || growing.answer != sentence.answer) {
        return lines + Line(Line.Kind.BRIDGE, sentence.text) to Growing(lines.size, sentence.answer)
    }
    val grown = lines.toMutableList()
    grown[growing.at] = Line(Line.Kind.BRIDGE, "${grown[growing.at].text} ${sentence.text}")
    return grown to growing
}

/** The whole answer takes its own growing line's place, or a line of its own at the end. */
fun answered(lines: List<Line>, growing: Growing?, turn: Incoming.Said): List<Line> {
    if (growing == null || growing.answer != turn.answer) return lines + turn.line
    return lines.toMutableList().also { it[growing.at] = turn.line }
}

private fun lineOf(message: JsonObject): Line? {
    val text = message.string("text") ?: return null
    val kind = when (message.string("kind")) {
        "heard" -> Line.Kind.YOU
        "turn" -> Line.Kind.BRIDGE
        "narration", "error" -> Line.Kind.NOTE
        else -> return null
    }
    return Line(kind, text)
}

private fun JsonObject.string(key: String): String? = (this[key] as? kotlinx.serialization.json.JsonPrimitive)?.contentOrNull

private fun JsonObject.int(key: String): Int? = (this[key] as? kotlinx.serialization.json.JsonPrimitive)?.intOrNull

/** 4.3 messages to the bridge. `src/serve.ts` reads each kind. */
object Outgoing {
    fun said(text: String): ByteArray = encode(buildJsonObject { put("kind", "said"); put("text", text) })

    /**
     * 9.5.2 `release` says the cut is a hold to talk button let go: the bridge
     * ends what was recorded as an utterance. A cut without it drops the words.
     */
    fun mic(on: Boolean, release: Boolean = false): ByteArray =
        encode(buildJsonObject { put("kind", "mic"); put("on", on); if (release) put("release", true) })

    fun quality(quality: String): ByteArray = encode(buildJsonObject { put("kind", "quality"); put("quality", quality) })

    /** 11.12 cut the speech and keep the words, for somewhere the bridge must not be heard. */
    fun voice(on: Boolean): ByteArray = encode(buildJsonObject { put("kind", "voice"); put("on", on) })

    private fun encode(message: JsonObject): ByteArray = message.toString().encodeToByteArray()
}
