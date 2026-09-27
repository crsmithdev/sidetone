package dev.crsmith.sidetone

import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/**
 * The lines on the screen, and the log of how they got there (14.7, 14.9, 17.12).
 *
 * Every message that changes a line comes through one of the `on` functions.
 * That is the one place where the change is made and where the log hears of it,
 * so the log cannot say something the screen did not show. The [Conversation]
 * owns one and gives its `lines` to the screen.
 */
class Transcript(val log: ScreenLog = ScreenLog()) {
    var lines: List<Line> = emptyList()
        private set

    /** 14.7 the line the answer is growing on, by index, since a note may land after it. */
    private var growing: Growing? = null

    /** Lines that no answer grows: what Chris said, a note, the history. A line with no time gets `now`. */
    fun onLines(kind: String, now: Long, vararg added: Line) {
        val before = lines
        lines = before + added.map { if (it.at == null) it.copy(at = now) else it }
        log.record(now, kind, null, null, null, before, lines)
    }

    fun onSentence(sentence: Incoming.Sentence, now: Long) {
        val before = lines
        val (next, at) = grow(before, growing, sentence, now)
        lines = next
        growing = at
        log.record(now, "sentence", sentence.answer, null, sentence.text, before, next)
    }

    /** 14.9 a block of an answer begins. It opens the bubble, which stays hidden until its first word. */
    fun onBlock(start: Incoming.BlockStart, now: Long) = words("block", start.answer, start.block, "", null, now)

    fun onDelta(delta: Incoming.Delta, now: Long) = words("delta", delta.answer, delta.block, delta.text, delta.seq, now)

    private fun words(kind: String, answer: Int, block: Int, text: String, seq: Int?, now: Long) {
        val before = lines
        val (next, at) = write(before, growing, answer, block, text, seq, now)
        lines = next
        growing = at
        log.record(now, kind, answer, block, text.ifEmpty { null }, before, next)
    }

    fun onTurn(turn: Incoming.Turn, now: Long) {
        val before = lines
        lines = answered(before, growing, turn, now)
        growing = null
        log.record(now, "turn", turn.answer, null, turn.line.text, before, lines)
    }

    /** 4.3.1 something the app records and does not show, such as a microphone cut. It is no line. */
    fun onEvent(kind: String, text: String, now: Long) = log.add(Shown(now, kind, null, null, null, null, text))

    /** 17.11 the working sign changed. It is no line, so the entry has no bubble, and its text is the words of the sign. */
    fun onSign(sign: Sign, now: Long) = log.add(Shown(now, "working", null, null, null, null, signWord(sign)))

    fun clear() {
        lines = emptyList()
        growing = null
        log.clear()
    }
}

/**
 * 14.7 the line an answer grows on: where it is, and which answer it is. A
 * bridge from before 21 September names no answer, and null matches null.
 * `block` is set when the line is the bubble of a block (14.9); a line grown by
 * sentences has none. `parts` are the deltas of the bubble, in the order of their `seq`.
 */
data class Growing(val at: Int, val answer: Int?, val block: Int? = null, val parts: List<Part> = emptyList())

/** 14.9.2 one delta in its bubble: its number in the block, and its words. */
data class Part(val seq: Int, val text: String)

/**
 * A sentence joins the line of its own answer, or starts a line at the end.
 * An interrupted answer sends no turn, so its line stays growing; the next
 * answer used to grow on it, above the words that came in between.
 *
 * 14.9.5 An answer with bubbles already holds the sentence in the words of its
 * blocks, so the sentence changes nothing. Only an answer with no bubble, such as
 * one that began before this client joined, grows on the sentences.
 */
fun grow(lines: List<Line>, growing: Growing?, sentence: Incoming.Sentence, now: Long): Pair<List<Line>, Growing> {
    if (growing != null && growing.block != null && growing.answer == sentence.answer) return lines to growing
    if (growing == null || growing.answer != sentence.answer) {
        return lines + Line(Line.Kind.BRIDGE, sentence.text, now) to Growing(lines.size, sentence.answer)
    }
    val grown = lines.toMutableList()
    grown[growing.at] = grown[growing.at].let { it.copy(text = "${it.text} ${sentence.text}") }
    return grown to growing
}

/**
 * 14.9 words join the bubble of their own block, or start a bubble at the end.
 * A block start is these words with none, so it opens the bubble at once and a
 * delta that arrives with no start, from a block that began before this client
 * joined, opens it as well.
 *
 * Item 43: the LiveKit SDK hands each message to the app from a coroutine of
 * its own, on a pool of threads, so two deltas can arrive in the wrong order.
 * The words go into the bubble in the order of `seq`, not of arrival. A delta
 * with no `seq` goes at the end.
 */
fun write(lines: List<Line>, growing: Growing?, answer: Int, block: Int, text: String, seq: Int?, now: Long): Pair<List<Line>, Growing> {
    val same = growing != null && growing.answer == answer && growing.block == block
    val before = if (same) growing!!.parts else emptyList()
    val parts = if (text.isEmpty()) before else (before + Part(seq ?: ((before.lastOrNull()?.seq ?: 0) + 1), text)).sortedBy { it.seq }
    val words = parts.joinToString("") { it.text }
    if (!same) return lines + Line(Line.Kind.BRIDGE, words, now) to Growing(lines.size, answer, block, parts)
    val grown = lines.toMutableList()
    grown[growing!!.at] = grown[growing.at].copy(text = words)
    return grown to growing.copy(parts = parts)
}

/**
 * The whole answer takes its own growing line's place, or a line of its own at
 * the end. 14.9.5 It takes no bubble's place: the bubbles already hold the
 * answer, and a second copy of it would stand beside them.
 */
fun answered(lines: List<Line>, growing: Growing?, turn: Incoming.Turn, now: Long): List<Line> {
    if (growing == null || growing.answer != turn.answer) return lines + turn.line.copy(at = now)
    if (growing.block != null) return lines
    return lines.toMutableList().also { it[growing.at] = turn.line.copy(at = it[growing.at].at ?: now) }
}

/** 17.9 the time a bubble shows: hours and minutes on a 24-hour clock, in the phone's time zone. */
fun clock(at: Long, zone: ZoneId = ZoneId.systemDefault()): String =
    DateTimeFormatter.ofPattern("HH:mm").format(Instant.ofEpochMilli(at).atZone(zone))
