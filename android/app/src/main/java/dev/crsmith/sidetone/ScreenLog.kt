package dev.crsmith.sidetone

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/** 17.12 the most changes the log holds. The oldest go first. */
const val SCREEN_MAX_ENTRIES = 500

/** 17.12 the most characters of text the log holds, over all its changes. */
const val SCREEN_MAX_CHARS = 200_000

/** 17.12 the most characters one change keeps. A longer bubble keeps its last characters, and `from` says how many went. */
const val SCREEN_MAX_TEXT = 4_000

/** 14.11 the size of one part sent to the bridge, in bytes. The data channel carries about 15 KiB. */
const val SCREEN_PART_BYTES = 12_000

/** Room in a part for what is not entries: the kind, the id, the two numbers and the brackets. */
private const val ENVELOPE_BYTES = 128

/**
 * 17.12 one change on the screen. `bubble` is the place in the transcript of
 * the line the change went into, and null when it went into none: a sentence
 * that a bubble already holds (14.9.5), the end of a block, and the sign.
 * `text` is the text of that line on the screen after the change, trimmed as
 * the screen trims it. `got` is the text the message carried.
 */
data class Shown(
    val at: Long,
    val kind: String,
    val answer: Int?,
    val block: Int?,
    val bubble: Int?,
    val got: String?,
    val text: String,
    val from: Int = 0,
)

/** 17.12 hours, minutes, seconds and milliseconds, on the 24-hour clock of the phone. */
fun stamp(at: Long, zone: ZoneId = ZoneId.systemDefault()): String =
    DateTimeFormatter.ofPattern("HH:mm:ss.SSS").format(Instant.ofEpochMilli(at).atZone(zone))

fun Shown.toJson(zone: ZoneId = ZoneId.systemDefault()): JsonObject = buildJsonObject {
    put("at", at)
    put("time", stamp(at, zone))
    put("kind", kind)
    put("answer", answer)
    put("block", block)
    put("bubble", bubble)
    put("got", got)
    put("text", text)
    if (from > 0) put("from", from)
}

/**
 * 17.12 what the app showed, in the order it showed it, and capped in size. It
 * holds changes, not the transcript: the transcript is `Bridge.State.lines`.
 */
class ScreenLog(
    private val maxEntries: Int = SCREEN_MAX_ENTRIES,
    private val maxChars: Int = SCREEN_MAX_CHARS,
    /** 14.11 hears of each entry as it is added, so it can go to the bridge. */
    private val onAdd: (Shown) -> Unit = {},
) {
    private val shown = ArrayDeque<Shown>()
    private var chars = 0

    val entries: List<Shown> get() = shown.toList()

    /**
     * One message changed the lines from `before` to `after`. Each line that is
     * new or different is one entry. A message that changed no line is one entry
     * with no bubble, so the log still says it arrived.
     */
    fun record(at: Long, kind: String, answer: Int?, block: Int?, got: String?, before: List<Line>, after: List<Line>) {
        val changed = after.indices.filter { it >= before.size || before[it] != after[it] }
        if (changed.isEmpty()) {
            add(Shown(at, kind, answer, block, null, got, ""))
            return
        }
        for (bubble in changed) {
            val full = after[bubble].text.trim()
            val text = full.takeLast(SCREEN_MAX_TEXT)
            add(Shown(at, kind, answer, block, bubble, got, text, full.length - text.length))
        }
    }

    fun add(entry: Shown) {
        onAdd(entry)
        shown.addLast(entry)
        chars += entry.text.length + (entry.got?.length ?: 0)
        while (shown.size > 1 && (shown.size > maxEntries || chars > maxChars)) {
            val gone = shown.removeFirst()
            chars -= gone.text.length + (gone.got?.length ?: 0)
        }
    }

    fun clear() {
        shown.clear()
        chars = 0
    }
}

/**
 * 14.11 entries as messages for the bridge, each of at most `limit` bytes,
 * because one data message is small. The bridge appends each to the file of `id`.
 */
fun screenParts(entries: List<Shown>, id: String, limit: Int = SCREEN_PART_BYTES, zone: ZoneId = ZoneId.systemDefault()): List<ByteArray> {
    val groups = mutableListOf(mutableListOf<JsonObject>())
    var size = 0
    for (entry in entries) {
        val json = entry.toJson(zone)
        val bytes = json.toString().encodeToByteArray().size + 1
        if (groups.last().isNotEmpty() && size + bytes > limit - ENVELOPE_BYTES) {
            groups.add(mutableListOf())
            size = 0
        }
        groups.last().add(json)
        size += bytes
    }
    return groups.mapIndexed { index, group -> Outgoing.screen(id, index + 1, groups.size, group) }
}
