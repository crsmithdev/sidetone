package dev.crsmith.sidetone

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.time.ZoneOffset

class MessagesTest {
    private fun bytes(json: String) = json.encodeToByteArray()

    @Test
    fun eachKindBecomesALine() {
        assertEquals(Incoming.Said(Line(Line.Kind.YOU, "hello")), decode(bytes("""{"kind":"heard","text":"hello"}""")))
        assertEquals(Incoming.Said(Line(Line.Kind.NOTE, "reading a file")), decode(bytes("""{"kind":"narration","text":"reading a file"}""")))
        assertEquals(Incoming.Said(Line(Line.Kind.NOTE, "oops")), decode(bytes("""{"kind":"error","text":"oops"}""")))
        // 14.7 a sentence of the answer, ahead of the voice
        assertEquals(Incoming.Sentence("Two plus two is four."), decode(bytes("""{"kind":"sentence","text":"Two plus two is four."}""")))
    }

    @Test
    fun aSentenceAndATurnNameTheirAnswer() {
        assertEquals(Incoming.Sentence("Four.", 3), decode(bytes("""{"kind":"sentence","text":"Four.","answer":3}""")))
        assertEquals(Incoming.Turn(Line(Line.Kind.BRIDGE, "Four."), 3), decode(bytes("""{"kind":"turn","text":"Four.","answer":3}""")))
    }

    @Test
    fun aTurnThatNamesNoAnswerIsDrift() {
        // 11.11.1 every turn names its answer, the agent's own after a background task too
        assertEquals(Incoming.Unknown("turn with no answer"), decode(bytes("""{"kind":"turn","text":"hi"}""")))
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
        lines = answered(lines, growing, Incoming.Turn(Line(Line.Kind.BRIDGE, "Eight."), 2), 0)
        assertEquals(
            listOf("count to three", "One. Two.", "stop, what is four plus four", "Eight."),
            lines.map { it.text },
        )
    }

    @Test
    fun aTurnWhoseAnswerGrewNothingIsALineOfItsOwn() {
        // the client joined after the answer's words went by
        val lines = listOf(Line(Line.Kind.BRIDGE, "One."), Line(Line.Kind.YOU, "thanks"))
        val after = answered(lines, Growing(0, 1), Incoming.Turn(Line(Line.Kind.BRIDGE, "The job finished."), 2), 0)
        assertEquals(listOf("One.", "thanks", "The job finished."), after.map { it.text })
    }

    @Test
    fun takesTheBlocksOfAnAnswer() {
        // src/messages.ts: a block start, the words of the block, the block end
        assertEquals(Incoming.BlockStart(3, 1), decode(bytes("""{"kind":"blockStart","answer":3,"block":1}""")))
        assertEquals(Incoming.Delta("Let me ", 3, 1, 2), decode(bytes("""{"kind":"delta","text":"Let me ","answer":3,"block":1,"seq":2}""")))
        // a bridge from before item 43 numbers no delta
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
    fun deltasThatArriveOutOfOrderShowInTheOrderTheBridgeSentThem() {
        // item 43, 23 September: the SDK swapped two deltas, and the bubble read "but it Dropping such only logs it."
        val screen = Screen()
        screen.receive("""{"kind":"blockStart","answer":20,"block":2}""", 1_000)
        screen.receive("""{"kind":"delta","text":"speech, but it","answer":20,"block":2,"seq":1}""", 1_001)
        screen.receive("""{"kind":"delta","text":" Dropping such","answer":20,"block":2,"seq":3}""", 1_002)
        screen.receive("""{"kind":"delta","text":" only logs it.","answer":20,"block":2,"seq":2}""", 1_003)
        screen.receive("""{"kind":"delta","text":" a turn.","answer":20,"block":2,"seq":4}""", 1_004)
        assertEquals(listOf("speech, but it only logs it. Dropping such a turn."), screen.lines.map { it.text })
    }

    @Test
    fun aDeltaThatArrivesBeforeItsBlockStartKeepsItsPlace() {
        val screen = Screen()
        screen.receive("""{"kind":"delta","text":"Log which can","answer":20,"block":2,"seq":1}""", 1_000)
        screen.receive("""{"kind":"blockStart","answer":20,"block":2}""", 1_001)
        screen.receive("""{"kind":"delta","text":"celler ran.","answer":20,"block":2,"seq":2}""", 1_002)
        assertEquals(listOf("Log which canceller ran."), screen.lines.map { it.text })
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
    fun anAnswerNobodyAskedForIsABubbleOfItsOwn() {
        // 11.11.1 the agent's own turn after a background task streams under an answer of its own
        val screen = Screen()
        screen.receive("""{"kind":"delta","text":"Started.","answer":1,"block":1}""", 1_000)
        screen.receive("""{"kind":"turn","number":1,"text":"Started.","costUsd":0.01,"answer":1}""", 1_100)
        screen.receive("""{"kind":"blockStart","answer":2,"block":1}""", 60_000)
        screen.receive("""{"kind":"delta","text":"The job finished.","answer":2,"block":1}""", 60_100)
        screen.receive("""{"kind":"blockEnd","answer":2,"block":1}""", 60_200)
        screen.receive("""{"kind":"sentence","text":"The job finished.","answer":2}""", 60_300)
        screen.receive("""{"kind":"turn","number":2,"text":"The job finished.","costUsd":0.01,"answer":2}""", 60_400)
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

    /**
     * ADR 0007 what the bridge really sends, which `test/fixture.test.ts` writes from the
     * bridge itself. A change there that this app cannot read fails here, not in the car.
     * Gradle runs this test in android/app.
     */
    private val fixture = File("../../test/fixtures/messages.jsonl").readLines().filter { it.isNotBlank() }

    @Test
    fun readsEverythingTheBridgeSends() {
        val decoded = fixture.map { decode(bytes(it)) }
        decoded.forEachIndexed { at, message ->
            assertTrue("line ${at + 1} of the fixture: ${fixture[at]}", message != null && message !is Incoming.Unknown)
        }
        assertEquals(Incoming.Protocol("sidetone end the turn"), decoded.first())
        assertTrue(Incoming.Protocol("sidetone end the turn", Apk("https://bridge:3100/sidetone.apk", "ab12")) in decoded)
        assertTrue(Incoming.Announce(Line(Line.Kind.NOTE, "Job build finished.")) in decoded)
        assertTrue(Incoming.Offer(Apk("https://bridge:3100/sidetone.apk", "cd34")) in decoded)
        assertTrue(Incoming.Rejoin in decoded)
        assertTrue(Incoming.Setup(SetupNames("normal", "media", "none", "software", noiseSuppression = true, autoGainControl = true)) in decoded)
        assertTrue(Incoming.Setup(null) in decoded)
        assertTrue(Incoming.Working(true) in decoded)
        // 14.16 the bridge says it loads, and that it has loaded
        assertTrue(Incoming.Starting(true) in decoded)
        assertTrue(Incoming.Starting(false) in decoded)
        assertTrue(Incoming.Screenshot("1789999559000", "pending") in decoded)
        assertTrue(Incoming.Screenshot("1789999559000", "sent") in decoded)
        val history = decoded.filterIsInstance<Incoming.History>().last()
        assertEquals(listOf("look and tell me", "Let me look. Found it.", "and again", "The build is green."), history.lines.map { it.text })
    }

    @Test
    fun theBridgesOwnMessagesMakeTheBubbles() {
        val screen = Screen()
        for ((at, json) in fixture.withIndex()) {
            when (decode(bytes(json))) {
                is Incoming.Said, is Incoming.Turn, is Incoming.Sentence, is Incoming.BlockStart, is Incoming.Delta, is Incoming.BlockEnd -> screen.receive(json, at.toLong())
                else -> Unit
            }
        }
        // 14.9 a tool call splits the answer into two bubbles, and its turn adds no third
        assertEquals(
            listOf("look and tell me", "Let me look. ", "running Bash", "Found it.", "and again", "the agent died", "The build is green."),
            screen.lines.map { it.text },
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
        // 17.10 the music button sets the hold music (15.7.3)
        assertEquals("""{"kind":"music","on":false}""", Outgoing.music(false).decodeToString())
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
        fun line(status: Status, sign: Sign, micOn: Boolean = true, audioOn: Boolean = true) =
            stateLine(BridgeService.Shown(reading(status, "good", sign), micOn, audioOn, inRoom = true))
        assertEquals("listening", line(Status.LISTENING, Sign.OFF))
        assertEquals("listening · mic off · audio off · working", line(Status.LISTENING, Sign.WORKING, micOn = false, audioOn = false))
        // 17.11.6 the sign of a room that is not live does not show
        assertEquals("reconnecting", line(Status.RECONNECTING, Sign.SILENT))
        // 17.11.3 a stalled bridge is the word itself
        assertEquals("stalled · audio off", line(Status.LISTENING, Sign.SILENT, audioOn = false))
    }

    @Test
    fun theDeviceMessageSaysWhatThePhoneIs() {
        val code = SetupNames("call", "voice", "gain", "hardware", noiseSuppression = true, autoGainControl = true)
        // 14.15 the bridge's src/device.ts reads these names; 18.15 the setup in force, and whether the bridge pushed it
        assertEquals(
            """{"kind":"device","model":"Pixel 8","aec":true,"canceller":"software","route":"speaker","apk":"ab12",""" +
                """"setup":{"mode":"call","output":"voice","focus":"gain","canceller":"hardware","noiseSuppression":true,"autoGainControl":true},"pushed":false}""",
            Outgoing.device("Pixel 8", true, "software", "speaker", "ab12", code, pushed = false).decodeToString(),
        )
        // a hash the app could not read is left out, not sent empty
        assertEquals(
            """{"kind":"device","model":"Pixel 8","aec":false,"canceller":"software","route":"none",""" +
                """"setup":{"mode":"normal","output":"media","focus":"none","canceller":"software","noiseSuppression":true,"autoGainControl":false},"pushed":true}""",
            Outgoing.device("Pixel 8", false, "software", "none", null, code.copy(mode = "normal", output = "media", focus = "none", canceller = "software", autoGainControl = false), pushed = true).decodeToString(),
        )
    }

    @Test
    fun aSetupComesInNamesOrAsksForTheDefault() {
        // 18.15 no Android constant crosses the wire; Audio.kt maps each name
        assertEquals(
            Incoming.Setup(SetupNames("normal", "media", "none", "software", noiseSuppression = true, autoGainControl = false)),
            decode(bytes("""{"kind":"setup","default":false,"mode":"normal","output":"media","focus":"none","canceller":"software","noiseSuppression":true,"autoGainControl":false}""")),
        )
        // a default reads nothing else, so a stale name cannot ride along
        assertEquals(Incoming.Setup(null), decode(bytes("""{"kind":"setup","default":true}""")))
        assertEquals(Incoming.Setup(null), decode(bytes("""{"kind":"setup","default":true,"mode":"communication"}""")))
        // a setup with a name missing is not a setup, and never the default
        assertNull(decode(bytes("""{"kind":"setup","default":false,"mode":"normal","output":"media","focus":"none","canceller":"software","noiseSuppression":true}""")))
        assertNull(decode(bytes("""{"kind":"setup"}""")))
    }
}
