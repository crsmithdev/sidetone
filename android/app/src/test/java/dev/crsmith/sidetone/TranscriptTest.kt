package dev.crsmith.sidetone

import org.junit.Assert.assertEquals
import org.junit.Test

/** The screen and its log, driven as `Bridge` drives them: one call for each message. */
class TranscriptTest {
    private fun Transcript.entries() = log.entries

    private fun Shown.brief() = "$kind b=$bubble '$text'" + (got?.let { " got '$it'" } ?: "")

    @Test
    fun anAnswerWithTwoBlocksLogsEachChangeInOrderAndTheExactTextOnScreen() {
        val t = Transcript()
        t.onLines("heard", 1_000, Line(Line.Kind.YOU, "what is in the todo file"))
        t.onBlock(Incoming.BlockStart(1, 1), 2_000)
        t.onDelta(Incoming.Delta("Let me ", 1, 1), 2_100)
        t.onDelta(Incoming.Delta("look.", 1, 1), 2_200)
        // 14.9.5 the bubble holds these words already
        t.onSentence(Incoming.Sentence("Let me look.", 1), 2_300)
        t.onBlock(Incoming.BlockStart(1, 2), 3_000)
        t.onDelta(Incoming.Delta("Two items.", 1, 2), 3_100)
        t.onTurn(Incoming.Said(Line(Line.Kind.BRIDGE, "Let me look. Two items."), 1), 3_200)
        t.onLines("note", 3_300, Line(Line.Kind.NOTE, "audio off"))

        assertEquals(
            listOf(
                "heard b=0 'what is in the todo file'",
                "block b=1 ''",
                "delta b=1 'Let me' got 'Let me '",
                "delta b=1 'Let me look.' got 'look.'",
                "sentence b=null '' got 'Let me look.'",
                "block b=2 ''",
                "delta b=2 'Two items.' got 'Two items.'",
                "turn b=null '' got 'Let me look. Two items.'",
                "note b=3 'audio off'",
            ),
            t.entries().map { it.brief() },
        )
        assertEquals(listOf(1_000L, 2_000, 2_100, 2_200, 2_300, 3_000, 3_100, 3_200, 3_300), t.entries().map { it.at })
        assertEquals(listOf(null, 1, 1, 1, 1, 1, 1, 1, null), t.entries().map { it.answer })
        assertEquals(listOf(null, 1, 1, 1, null, 2, 2, null, null), t.entries().map { it.block })
        // what the screen holds is what the last entry of each bubble says
        assertEquals(listOf("what is in the todo file", "Let me look.", "Two items.", "audio off"), t.lines.map { it.text.trim() })
    }

    @Test
    fun anAnswerWithNoBubblesGrowsOnSentencesAndTheTurnTakesItsPlace() {
        // an answer that began before this client joined has no blocks (14.9.5)
        val t = Transcript()
        t.onSentence(Incoming.Sentence("One.", 4), 10)
        t.onSentence(Incoming.Sentence("Two.", 4), 20)
        // 14.9.6 the turn holds what Chris heard, and a barge-in cut the voice after the first sentence
        t.onTurn(Incoming.Said(Line(Line.Kind.BRIDGE, "One."), 4), 30)
        assertEquals(
            listOf("sentence b=0 'One.' got 'One.'", "sentence b=0 'One. Two.' got 'Two.'", "turn b=0 'One.' got 'One.'"),
            t.entries().map { it.brief() },
        )
        assertEquals(listOf("One."), t.lines.map { it.text })
        // a turn that says what the line already says changes no line, and the log says so
        t.onSentence(Incoming.Sentence("Three.", 5), 40)
        t.onTurn(Incoming.Said(Line(Line.Kind.BRIDGE, "Three."), 5), 50)
        assertEquals("turn b=null '' got 'Three.'", t.entries().last().brief())
    }

    @Test
    fun theHistoryLogsEachLineItAdds() {
        val t = Transcript()
        t.onLines("history", 500, Line(Line.Kind.NOTE, "earlier"), Line(Line.Kind.YOU, "hello", 100), Line(Line.Kind.NOTE, "now"))
        assertEquals(listOf(0, 1, 2), t.entries().map { it.bubble })
        assertEquals(listOf("history", "history", "history"), t.entries().map { it.kind })
        assertEquals(listOf("earlier", "hello", "now"), t.entries().map { it.text })
        // a kept line shows the time the bridge kept it; the log says when it reached the screen
        assertEquals(100L, t.lines[1].at)
        assertEquals(listOf(500L, 500, 500), t.entries().map { it.at })
    }

    @Test
    fun theSignIsLoggedWithItsWordsAndNoBubble() {
        val t = Transcript()
        t.onSign(Sign.WORKING, 7)
        t.onSign(Sign.SILENT, 8)
        t.onSign(Sign.OFF, 9)
        assertEquals(listOf("working b=null 'working'", "working b=null 'stalled'", "working b=null ''"), t.entries().map { it.brief() })
        assertEquals(emptyList<Line>(), t.lines)
    }

    @Test
    fun clearingEmptiesTheScreenTheLogAndTheGrowingLine() {
        val t = Transcript()
        t.onSentence(Incoming.Sentence("One.", 1), 1)
        t.clear()
        assertEquals(emptyList<Line>(), t.lines)
        assertEquals(emptyList<Shown>(), t.entries())
        // a sentence of the same answer opens a new line, not a write at an index that is gone
        t.onSentence(Incoming.Sentence("Two.", 1), 2)
        assertEquals(listOf("Two."), t.lines.map { it.text })
    }

    @Test
    fun anEventIsLoggedAndStreamedButShowsNoLine() {
        val streamed = mutableListOf<String>()
        val t = Transcript(ScreenLog(onAdd = { streamed.add(it.kind) }))
        t.onLines("heard", 1_000, Line(Line.Kind.YOU, "hello"))
        t.onEvent("microphone", "microphone off", 2_000)
        assertEquals(listOf("hello"), t.lines.map { it.text })
        assertEquals(listOf("heard b=0 'hello'", "microphone b=null 'microphone off'"), t.entries().map { it.brief() })
        assertEquals(listOf("heard", "microphone"), streamed)
    }
}
