package dev.crsmith.sidetone

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.time.ZoneOffset

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
        fun sentence(text: String, answer: Int) { grow(lines, growing, Incoming.Sentence(text, answer), 0).let { lines = it.first; growing = it.second } }
        sentence("One.", 1)
        sentence("Two.", 1)
        // Chris cuts in; answer 1 is interrupted and never sends its turn
        lines = lines + Line(Line.Kind.YOU, "stop, what is four plus four")
        sentence("Eight.", 2)
        lines = answered(lines, growing, Incoming.Said(Line(Line.Kind.BRIDGE, "Eight."), 2), 0)
        assertEquals(
            listOf("count to three", "One. Two.", "stop, what is four plus four", "Eight."),
            lines.map { it.text },
        )
    }

    @Test
    fun aTurnWithNoSentencesIsALineOfItsOwn() {
        // the agent's own turn after a background task names no answer
        val lines = listOf(Line(Line.Kind.BRIDGE, "One."), Line(Line.Kind.YOU, "thanks"))
        val after = answered(lines, Growing(0, 1), Incoming.Said(Line(Line.Kind.BRIDGE, "The job finished.")), 0)
        assertEquals(listOf("One.", "thanks", "The job finished."), after.map { it.text })
    }

    @Test
    fun takesTheBlocksOfAnAnswer() {
        // src/messages.ts: a block start, the words of the block, the block end
        assertEquals(Incoming.BlockStart(3, 1), decode(bytes("""{"kind":"blockStart","answer":3,"block":1}""")))
        assertEquals(Incoming.Delta("Let me ", 3, 1), decode(bytes("""{"kind":"delta","text":"Let me ","answer":3,"block":1}""")))
        assertEquals(Incoming.BlockEnd(3, 1), decode(bytes("""{"kind":"blockEnd","answer":3,"block":1}""")))
        // without the two numbers there is no bubble to put the words in
        assertNull(decode(bytes("""{"kind":"delta","text":"Let me "}""")))
    }

    /**
     * What a client does with each message. It is the real [Conversation], not
     * a copy of its dispatch: the copy that used to live here had already
     * drifted, and handled four of the message kinds by failing.
     */
    private class Screen {
        private val c = Conversation()
        val lines: List<Line> get() = c.lines
        fun receive(json: String, now: Long) {
            c.receive(decode(json.encodeToByteArray()), now, now, inFront = true, audioOn = true)
        }
    }

    @Test
    fun aToolCallSplitsAnAnswerIntoTwoBubbles() {
        val screen = Screen()
        screen.receive("""{"kind":"heard","text":"look and tell me"}""", 1_000)
        screen.receive("""{"kind":"blockStart","answer":1,"block":1}""", 2_000)
        screen.receive("""{"kind":"delta","text":"Let me ","answer":1,"block":1}""", 2_100)
        screen.receive("""{"kind":"delta","text":"look.","answer":1,"block":1}""", 2_200)
        screen.receive("""{"kind":"blockEnd","answer":1,"block":1}""", 2_300)
        screen.receive("""{"kind":"narration","text":"running Bash"}""", 3_000)
        screen.receive("""{"kind":"blockStart","answer":1,"block":2}""", 9_000)
        screen.receive("""{"kind":"delta","text":"Found it.","answer":1,"block":2}""", 9_100)
        screen.receive("""{"kind":"blockEnd","answer":1,"block":2}""", 9_200)
        assertEquals(
            listOf("look and tell me", "Let me look.", "running Bash", "Found it."),
            screen.lines.map { it.text },
        )
        // each bubble keeps the time it began, and the words that came later do not move it
        assertEquals(listOf<Long?>(1_000, 2_000, 3_000, 9_000), screen.lines.map { it.at })
    }

    @Test
    fun theAnswerStandsOnceWhenTheVoiceFinishes() {
        // drive.md test 4: the bridge sends the words, then the sentences, then the turn
        val screen = Screen()
        screen.receive("""{"kind":"blockStart","answer":1,"block":1}""", 1_000)
        screen.receive("""{"kind":"delta","text":"Let me look. ","answer":1,"block":1}""", 1_100)
        screen.receive("""{"kind":"sentence","text":"Let me look.","answer":1}""", 1_200)
        screen.receive("""{"kind":"blockEnd","answer":1,"block":1}""", 1_300)
        screen.receive("""{"kind":"blockStart","answer":1,"block":2}""", 2_000)
        screen.receive("""{"kind":"delta","text":"Found it.","answer":1,"block":2}""", 2_100)
        screen.receive("""{"kind":"blockEnd","answer":1,"block":2}""", 2_200)
        screen.receive("""{"kind":"sentence","text":"Found it.","answer":1}""", 2_300)
        screen.receive("""{"kind":"turn","number":1,"text":"Let me look. Found it.","costUsd":0.01,"answer":1}""", 2_400)
        assertEquals(listOf("Let me look. ", "Found it."), screen.lines.map { it.text })
    }

    @Test
    fun aBridgeThatSendsNoBlocksStillGrowsOneLineForEachAnswer() {
        // a bridge not yet restarted sends sentences and a turn only; the turn takes the line's place
        val screen = Screen()
        screen.receive("""{"kind":"sentence","text":"One.","answer":1}""", 1_000)
        screen.receive("""{"kind":"sentence","text":"Two.","answer":1}""", 2_000)
        screen.receive("""{"kind":"turn","number":1,"text":"One. Two.","costUsd":0.01,"answer":1}""", 3_000)
        assertEquals(listOf("One. Two."), screen.lines.map { it.text })
        assertEquals(listOf<Long?>(1_000), screen.lines.map { it.at })
    }

    @Test
    fun aDeltaWithNoStartOpensItsOwnBubble() {
        // the client joined in the middle of a block
        val screen = Screen()
        screen.receive("""{"kind":"delta","text":"the rest of it","answer":4,"block":2}""", 5_000)
        screen.receive("""{"kind":"delta","text":".","answer":4,"block":2}""", 5_100)
        assertEquals(listOf("the rest of it."), screen.lines.map { it.text })
    }

    @Test
    fun aNewAnswerStartsNewBubblesAfterAnInterruptedOne() {
        val screen = Screen()
        screen.receive("""{"kind":"delta","text":"One two three","answer":1,"block":1}""", 1_000)
        // Chris cuts in; answer 1 sends no turn
        screen.receive("""{"kind":"heard","text":"stop"}""", 2_000)
        screen.receive("""{"kind":"delta","text":"Stopped.","answer":2,"block":1}""", 3_000)
        assertEquals(listOf("One two three", "stop", "Stopped."), screen.lines.map { it.text })
    }

    @Test
    fun aTurnWithNoAnswerAfterBubblesIsALineOfItsOwn() {
        // the agent's own turn after a background task, in a bridge that names answers
        val screen = Screen()
        screen.receive("""{"kind":"delta","text":"Started.","answer":1,"block":1}""", 1_000)
        screen.receive("""{"kind":"turn","number":1,"text":"Started.","costUsd":0.01,"answer":1}""", 1_100)
        screen.receive("""{"kind":"turn","number":2,"text":"The job finished.","costUsd":0.01}""", 60_000)
        assertEquals(listOf("Started.", "The job finished."), screen.lines.map { it.text })
        assertEquals(listOf<Long?>(1_000, 60_000), screen.lines.map { it.at })
    }

    @Test
    fun aKeptLineCarriesTheTimeTheBridgeKeptIt() {
        val history = decode(bytes("""{"kind":"history","turns":[{"kind":"heard","text":"a","at":1789000000000},{"kind":"turn","text":"b","at":1789000005000}]}"""))
        assertEquals(
            Incoming.History(listOf(Line(Line.Kind.YOU, "a", 1_789_000_000_000), Line(Line.Kind.BRIDGE, "b", 1_789_000_005_000))),
            history,
        )
    }

    @Test
    fun theClockIsHoursAndMinutesInTheGivenZone() {
        // 2026-09-21 14:05:59 UTC
        val at = 1_789_999_559_000L
        assertEquals("14:05", clock(at, ZoneOffset.UTC))
        assertEquals("16:05", clock(at, ZoneOffset.ofHours(2)))
        // the minute is cut off, not rounded, and midnight is 00:00
        assertEquals("23:59", clock(1_790_035_199_000L, ZoneOffset.UTC))
        assertEquals("00:00", clock(1_790_035_200_000L, ZoneOffset.UTC))
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
    fun takesTheRequestToRejoin() {
        // src/channel.ts sends this when the microphone track carries no sound
        assertEquals(Incoming.Rejoin, decode(bytes("""{"kind":"rejoin"}""")))
    }

    @Test
    fun rejoinsOnceInThirtySeconds() {
        assertEquals(true, rejoinDue(null, 5_000))
        assertEquals(false, rejoinDue(1_000, 30_999))
        assertEquals(true, rejoinDue(1_000, 31_000))
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
        // 9.5.2 a hold to talk button let go: the bridge ends the utterance
        assertEquals("""{"kind":"mic","on":false,"release":true}""", Outgoing.mic(false, release = true).decodeToString())
        // 15.12 a hold to talk button pressed: the bridge plays the press cue
        assertEquals("""{"kind":"mic","on":true,"hold":true}""", Outgoing.mic(true, hold = true).decodeToString())
        assertEquals("""{"kind":"quality","quality":"good"}""", Outgoing.quality("good").decodeToString())
        // 11.12 the audio cut keeps the kind the bridge already knows
        assertEquals("""{"kind":"voice","on":false}""", Outgoing.audio(false).decodeToString())
    }

    @Test
    fun theJoinMessageCarriesTheServedApp() {
        assertEquals(
            Incoming.Protocol("sidetone end the turn", Apk("https://bridge:3100/sidetone.apk", "ab12")),
            decode(bytes("""{"kind":"protocol","endTurn":"sidetone end the turn","apk":{"url":"https://bridge:3100/sidetone.apk","sha256":"ab12"}}""")),
        )
        // a bridge from before 17.15 sends no app
        assertEquals(Incoming.Protocol("sidetone end the turn"), decode(bytes("""{"kind":"protocol","endTurn":"sidetone end the turn"}""")))
    }

    @Test
    fun anUpdateIsOfferedOnlyForADifferentApp() {
        val apk = Apk("https://bridge:3100/sidetone.apk", "AB12")
        assertEquals(apk, updateFor("cd34", apk))
        assertNull(updateFor("ab12", apk))
        assertNull(updateFor("cd34", null))
        // the installed file could not be read, so there is nothing to compare
        assertNull(updateFor(null, apk))
    }

    @Test
    fun anAnnouncedNarrationIsAnAnnouncement() {
        assertEquals(
            Incoming.Announce(Line(Line.Kind.NOTE, "Job build finished.")),
            decode(bytes("""{"kind":"narration","text":"Job build finished.","announce":true}""")),
        )
        // a plain narration stays a note
        assertEquals(Incoming.Said(Line(Line.Kind.NOTE, "reading a file")), decode(bytes("""{"kind":"narration","text":"reading a file"}""")))
    }

    @Test
    fun theNotificationSaysTheStateInOneLine() {
        assertEquals("listening", stateLine(BridgeService.Shown(Bridge.Status.LISTENING, micOn = true, audioOn = true, inRoom = true, sign = Sign.OFF)))
        assertEquals(
            "listening · mic off · audio off · working",
            stateLine(BridgeService.Shown(Bridge.Status.LISTENING, micOn = false, audioOn = false, inRoom = true, sign = Sign.WORKING)),
        )
    }
}
