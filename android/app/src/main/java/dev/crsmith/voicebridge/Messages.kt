package dev.crsmith.voicebridge

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

/** One line of the transcript (14.7). */
data class Line(val kind: Kind, val text: String) {
    enum class Kind { YOU, BRIDGE, NOTE }
}

/** 4.3 a message on the control channel, from the bridge. */
sealed interface Incoming {
    data class Said(val line: Line) : Incoming

    /** 14.8 the turns that happened while this client was away. */
    data class History(val lines: List<Line>) : Incoming
}

fun decode(payload: ByteArray): Incoming? {
    val message = runCatching { Json.parseToJsonElement(payload.decodeToString()) as? JsonObject }.getOrNull() ?: return null
    if (message.string("kind") == "history") {
        val turns = message["turns"] as? JsonArray ?: return Incoming.History(emptyList())
        val lines = turns.mapNotNull { (it as? JsonObject)?.let(::lineOf) }.filter { it.kind != Line.Kind.NOTE }
        return Incoming.History(lines)
    }
    return lineOf(message)?.let { Incoming.Said(it) }
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

/** 4.3 messages to the bridge. `src/serve.ts` reads each kind. */
object Outgoing {
    fun said(text: String): ByteArray = encode(buildJsonObject { put("kind", "said"); put("text", text) })

    fun mic(on: Boolean): ByteArray = encode(buildJsonObject { put("kind", "mic"); put("on", on) })

    fun quality(quality: String): ByteArray = encode(buildJsonObject { put("kind", "quality"); put("quality", quality) })

    private fun encode(message: JsonObject): ByteArray = message.toString().encodeToByteArray()
}
