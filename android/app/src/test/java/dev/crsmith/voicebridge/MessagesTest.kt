package dev.crsmith.voicebridge

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
            Incoming.Protocol("hey bridge end the turn"),
            decode(bytes("""{"kind":"protocol","endTurn":"hey bridge end the turn","incoming":{},"outgoing":[]}""")),
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
        assertEquals("""{"kind":"said","text":"hey bridge end the turn"}""", Outgoing.said("hey bridge end the turn").decodeToString())
        assertEquals("""{"kind":"mic","on":false}""", Outgoing.mic(false).decodeToString())
        assertEquals("""{"kind":"quality","quality":"good"}""", Outgoing.quality("good").decodeToString())
    }
}
