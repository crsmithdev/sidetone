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

/**
 * 14.11 the size of one part sent to the bridge, in bytes. Measured 22 September
 * 2026: a data packet over about 64,000 bytes is refused outright, so this is
 * well inside what the channel carries.
 */
const val SCREEN_PART_BYTES = 12_000

/** Room in a part for what is not entries: the kind, the id, the two numbers and the brackets. */
private const val ENVELOPE_BYTES = 128

/**
 * 17.12 one change on the screen. `bubble` is the place in the transcript of
 * the line the change went into, and null when it went into none: a sentence
 * that a bubble already holds (14.9.5), the end of a block, and the sign.
 * `text` is the text of that line on the screen after the change, trimmed as
 * the screen trims it. `got` is the text the message carried, trimmed the same
 * way: a turn's `got` is the whole answer, and one entry of an answer's length
 * is larger than a part may be, which stalls the stream rather than losing one
 * entry, because a part that fails is sent again (14.11.1).
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
    /** how many characters of `got` went, the same way `from` counts `text` */
    val gotFrom: Int = 0,
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
    if (gotFrom > 0) put("gotFrom", gotFrom)
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
            add(Shown(at, kind, answer, block, bubble, got, after[bubble].text.trim()))
        }
    }

    /**
     * 17.12 one entry, bounded here rather than by whoever makes it, so the
     * promise `screenParts` makes about a part's size holds for every caller.
     */
    fun add(entry: Shown) {
        val bounded = entry.bounded()
        onAdd(bounded)
        shown.addLast(bounded)
        chars += bounded.text.length + (bounded.got?.length ?: 0)
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

/** 17.12 a change keeps its last characters, and says how many went. */
private fun Shown.bounded(): Shown {
    val keptText = text.takeLast(SCREEN_MAX_TEXT)
    val keptGot = got?.takeLast(SCREEN_MAX_TEXT)
    if (keptText.length == text.length && keptGot?.length == got?.length) return this
    return copy(
        got = keptGot,
        text = keptText,
        from = from + (text.length - keptText.length),
        gotFrom = gotFrom + ((got?.length ?: 0) - (keptGot?.length ?: 0)),
    )
}

/** 14.11 one `screen` message and the number of entries in it. */
class ScreenPart(val message: ByteArray, val count: Int)

/**
 * 14.11 entries as messages for the bridge, each of at most `limit` bytes,
 * because one data message is small. The bridge appends each to the file of `id`.
 */
fun screenParts(entries: List<Shown>, id: String, limit: Int = SCREEN_PART_BYTES, zone: ZoneId = ZoneId.systemDefault()): List<ScreenPart> {
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
    return groups.mapIndexed { index, group -> ScreenPart(Outgoing.screen(id, index + 1, groups.size, group), group.size) }
}
