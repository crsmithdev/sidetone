package dev.crsmith.sidetone

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class MessagesTest {
    private fun bytes(json: String) = json.encodeToByteArray()

    @Test
    fun eachKindBecomesALine() {
        assertEquals(Incoming.Said(Line(Line.Kind.YOU, "hello")), decode(bytes("""{"kind":"heard","text":"hello"}""")))
        assertEquals(Incoming.Said(Line(Line.Kind.BRIDGE, "hi")), decode(bytes("""{"kind":"turn","text":"hi"}""")))
        assertEquals(Incoming.Said(Line(Line.Kind.NOTE, "reading a file")), decode(bytes("""{"kind":"narration","text":"reading a file"}""")))
        assertEquals(Incoming.Said(Line(Line.Kind.NOTE, "oops")), decode(bytes("""{"kind":"error","text":"oops"}""")))
        // 14.7 a sentence of the answer, ahead of the voice
        assertEquals(Incoming.Sentence("Two plus two is four."), decode(bytes("""{"kind":"sentence","text":"Two plus two is four."}""")))
    }

    @Test
    fun aSentenceAndATurnNameTheirAnswer() {
        assertEquals(Incoming.Sentence("Four.", 3), decode(bytes("""{"kind":"sentence","text":"Four.","answer":3}""")))
        assertEquals(Incoming.Said(Line(Line.Kind.BRIDGE, "Four."), 3), decode(bytes("""{"kind":"turn","text":"Four.","answer":3}""")))
    }

    @Test
    fun anAnswerGrowsOnItsOwnLine() {
        var lines = listOf(Line(Line.Kind.YOU, "count to three"))
        var growing: Growing? = null
        fun sentence(text: String, answer: Int) { grow(lines, growing, Incoming.Sentence(text, answer)).let { lines = it.first; growing = it.second } }
        sentence("One.", 1)
        sentence("Two.", 1)
        // Chris cuts in; answer 1 is interrupted and never sends its turn
        lines = lines + Line(Line.Kind.YOU, "stop, what is four plus four")
        sentence("Eight.", 2)
        lines = answered(lines, growing, Incoming.Said(Line(Line.Kind.BRIDGE, "Eight."), 2))
        assertEquals(
            listOf("count to three", "One. Two.", "stop, what is four plus four", "Eight."),
            lines.map { it.text },
        )
    }

    @Test
    fun aTurnWithNoSentencesIsALineOfItsOwn() {
        // the agent's own turn after a background task names no answer
        val lines = listOf(Line(Line.Kind.BRIDGE, "One."), Line(Line.Kind.YOU, "thanks"))
        val after = answered(lines, Growing(0, 1), Incoming.Said(Line(Line.Kind.BRIDGE, "The job finished.")))
        assertEquals(listOf("One.", "thanks", "The job finished."), after.map { it.text })
    }

    @Test
    fun historyKeepsTheTurnsOnly() {
        val history = decode(bytes("""{"kind":"history","turns":[{"kind":"heard","text":"a"},{"kind":"narration","text":"x"},{"kind":"turn","text":"b"}]}"""))
        assertEquals(Incoming.History(listOf(Line(Line.Kind.YOU, "a"), Line(Line.Kind.BRIDGE, "b"))), history)
    }

    @Test
    fun takesTheWordsTheBridgeOwns() {
        // src/messages.ts sends this when the app joins the room
        assertEquals(
            Incoming.Protocol("sidetone end the turn"),
            decode(bytes("""{"kind":"protocol","endTurn":"sidetone end the turn","incoming":{},"outgoing":[]}""")),
        )
    }

    @Test
    fun saysSoWhenTheTwoEndsHaveDrifted() {
        // dropping it silently is how a new kind stayed invisible
        assertEquals(Incoming.Unknown("stats"), decode(bytes("""{"kind":"stats"}""")))
    }

    @Test
    fun ignoresWhatItDoesNotKnow() {
        assertNull(decode(bytes("not json")))
        assertNull(decode(bytes("[1,2]")))
    }

    @Test
    fun outgoingMatchesTheWebClient() {
        assertEquals("""{"kind":"said","text":"sidetone end the turn"}""", Outgoing.said("sidetone end the turn").decodeToString())
        assertEquals("""{"kind":"mic","on":false}""", Outgoing.mic(false).decodeToString())
        assertEquals("""{"kind":"quality","quality":"good"}""", Outgoing.quality("good").decodeToString())
    }
}
