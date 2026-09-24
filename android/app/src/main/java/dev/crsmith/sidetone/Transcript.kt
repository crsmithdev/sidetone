package dev.crsmith.sidetone

/**
 * The lines on the screen, and the log of how they got there (14.7, 14.9, 17.12).
 *
 * Every message that changes a line comes through one of the `on` functions.
 * That is the one place where the change is made and where the log hears of it,
 * so the log cannot say something the screen did not show. `Bridge` owns one and
 * copies `lines` into its state after each call.
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
