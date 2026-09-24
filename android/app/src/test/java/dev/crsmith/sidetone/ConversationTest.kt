package dev.crsmith.sidetone

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Every message the bridge can send, and what the client does with it — with no
 * room, no LiveKit and no Android. This is the test that could not be written
 * while the dispatch lived inside `Bridge.on`.
 */
class ConversationTest {
    private val c = Conversation()

    /** One message as the bridge writes it on the wire. */
    private fun send(json: String, at: Long = 1_000, since: Long = 1_000, inFront: Boolean = true, audioOn: Boolean = true) =
        c.receive(decode(json.encodeToByteArray()), at, since, inFront, audioOn)

    private fun texts() = c.lines.map { it.text }

    private fun logKinds() = c.transcript.log.entries.map { it.kind }

    @Test
    fun aToolCallSplitsAnAnswerIntoTwoBubbles() {
        send("""{"kind":"heard","text":"look and tell me"}""", at = 1_000)
        send("""{"kind":"blockStart","answer":1,"block":1}""", at = 2_000)
        send("""{"kind":"delta","text":"Let me ","answer":1,"block":1}""", at = 2_100)
        send("""{"kind":"delta","text":"look.","answer":1,"block":1}""", at = 2_200)
        send("""{"kind":"blockEnd","answer":1,"block":1}""", at = 2_300)
        send("""{"kind":"narration","text":"running Bash"}""", at = 3_000)
        send("""{"kind":"blockStart","answer":1,"block":2}""", at = 9_000)
        send("""{"kind":"delta","text":"Found it.","answer":1,"block":2}""", at = 9_100)
        assertEquals(listOf("look and tell me", "Let me look.", "running Bash", "Found it."), texts())
        // each bubble keeps the time it began, and later words do not move it
        assertEquals(listOf<Long?>(1_000, 2_000, 3_000, 9_000), c.lines.map { it.at })
    }

    @Test
    fun theLogSaysWhichMessageMadeEachChange() {
        send("""{"kind":"heard","text":"what is two plus two"}""")
        send("""{"kind":"blockStart","answer":1,"block":1}""")
        send("""{"kind":"delta","text":"Four.","answer":1,"block":1}""")
        send("""{"kind":"sentence","text":"Four.","answer":1}""")
        send("""{"kind":"turn","number":1,"text":"Four.","costUsd":0.01,"answer":1}""")
        // 17.12 the log cannot say a kind the screen did not show
        assertEquals(listOf("heard", "block", "delta", "sentence", "turn"), logKinds())
    }

    @Test
    fun aReplyTheVoiceDidNotPlayIsWorthANotification() {
        val quiet = send("""{"kind":"turn","number":1,"text":"It is four.","costUsd":0.01,"answer":1}""", inFront = false, audioOn = false)
        assertEquals(listOf(Conversation.Effect.Alert("Reply", "It is four.")), quiet)
        // in front, or with the voice playing, the screen and the speaker are enough
        assertTrue(send("""{"kind":"turn","number":2,"text":"Again.","costUsd":0.01,"answer":2}""", inFront = false, audioOn = true).isEmpty())
        assertTrue(send("""{"kind":"turn","number":3,"text":"Again.","costUsd":0.01,"answer":3}""", inFront = true, audioOn = false).isEmpty())
    }

    @Test
    fun anAnnouncementReachesAPhoneInAPocket() {
        assertEquals(
            listOf(Conversation.Effect.Alert("Sidetone", "Job research finished.")),
            send("""{"kind":"narration","text":"Job research finished.","announce":true}""", inFront = false),
        )
        assertTrue(send("""{"kind":"narration","text":"and again","announce":true}""", inFront = true).isEmpty())
    }

    @Test
    fun theProtocolGivesTheStopButtonItsWordsAndOffersTheApp() {
        val effects = send("""{"kind":"protocol","endTurn":"end turn","apk":{"url":"https://b/sidetone.apk","sha256":"ab"}}""")
        assertEquals("end turn", c.endTurn)
        assertEquals(listOf(Conversation.Effect.Offer(Apk("https://b/sidetone.apk", "ab")), Conversation.Effect.Device), effects)
    }

    @Test
    fun eachGreetingIsAnsweredWithTheDeviceOnceAndNothingElseIs() {
        // 14.15 a bridge that restarted greets the phone again, and has to be told what it is again
        assertEquals(listOf(Conversation.Effect.Offer(null), Conversation.Effect.Device), send("""{"kind":"protocol","endTurn":"end turn"}"""))
        assertEquals(listOf(Conversation.Effect.Offer(null), Conversation.Effect.Device), send("""{"kind":"protocol","endTurn":"end turn"}"""))
        assertTrue(send("""{"kind":"settings","settings":{}}""").isEmpty())
        assertTrue(send("""{"kind":"history","turns":[]}""").isEmpty())
    }

    @Test
    fun aNewBuildIsOfferedAtAnyTimeAndChangesNothingElse() {
        send("""{"kind":"protocol","endTurn":"end turn"}""")
        val effects = send("""{"kind":"apk","apk":{"url":"https://b/sidetone.apk","sha256":"cd"}}""")
        assertEquals(listOf(Conversation.Effect.Offer(Apk("https://b/sidetone.apk", "cd"))), effects)
        assertEquals("end turn", c.endTurn)
        assertTrue(c.lines.isEmpty())
    }

    @Test
    fun aRejoinIsAskedOfTheRoomAndNothingElse() {
        assertEquals(listOf(Conversation.Effect.Rejoin), send("""{"kind":"rejoin"}"""))
        assertTrue(c.lines.isEmpty())
    }

    @Test
    fun aSetupIsAskedOfTheRoomAndNothingElse() {
        // 18.15 the room is built with the setup at join, so the room has to be asked; the screen shows nothing
        val names = SetupNames("normal", "media", "none", "software", noiseSuppression = true, autoGainControl = true)
        assertEquals(
            listOf(Conversation.Effect.Setup(names)),
            send("""{"kind":"setup","default":false,"mode":"normal","output":"media","focus":"none","canceller":"software","noiseSuppression":true,"autoGainControl":true}"""),
        )
        assertEquals(listOf(Conversation.Effect.Setup(null)), send("""{"kind":"setup","default":true}"""))
        assertTrue(c.lines.isEmpty())
    }

    @Test
    fun theHistoryIsShownOnceAndSaysWhereItEnds() {
        send("""{"kind":"history","turns":[{"kind":"heard","text":"earlier question","at":5}]}""")
        assertEquals(listOf("earlier", "earlier question", "now"), texts())
        send("""{"kind":"history","turns":[{"kind":"heard","text":"earlier question","at":5}]}""")
        assertEquals(listOf("earlier", "earlier question", "now"), texts())
        // 17.11.10 a room that opens again inside one conversation, after a leave or a drop, keeps its
        // lines, and the history the bridge sends it holds the turns those lines already show
        c.roomEnded(2_000, 2_000)
        send("""{"kind":"history","turns":[{"kind":"heard","text":"later question","at":6}]}""")
        assertEquals(listOf("earlier", "earlier question", "now"), texts())
    }

    @Test
    fun anEmptyHistoryShowsNothingAtAll() {
        send("""{"kind":"history","turns":[]}""")
        assertTrue(c.lines.isEmpty())
    }

    @Test
    fun aMessageThisAppDoesNotKnowIsSaidPlainly() {
        send("""{"kind":"sideways","text":"?"}""")
        assertEquals(listOf("(unknown message: sideways)"), texts())
    }

    @Test
    fun theSignFollowsTheBridgeAndThenTheClock() {
        assertEquals(Sign.OFF, c.sign)
        send("""{"kind":"working","on":true}""", since = 10_000)
        assertEquals(Sign.WORKING, c.sign)
        send("""{"kind":"working","on":false}""", since = 11_000)
        assertEquals(Sign.OFF, c.sign)
        // 17.11 with the bridge silent, the sign goes stale on the clock alone
        send("""{"kind":"working","on":true}""", since = 12_000)
        assertEquals(Sign.WORKING, c.sign)
        assertTrue(c.tick(12_000 + WORKING_STALE_MS + 1))
        assertEquals(Sign.SILENT, c.sign)
        // and the log kept every change of it
        assertTrue(logKinds().contains("working"))
    }

    @Test
    fun theVoiceReachingASentenceMarksWhereTheBubbleGoesGrey() {
        send("""{"kind":"heard","text":"two things"}""")
        send("""{"kind":"blockStart","answer":1,"block":1}""")
        send("""{"kind":"delta","text":"One. Two. Three.","answer":1,"block":1}""")
        // the words are on the screen, and the voice has not reached them yet
        assertEquals(null, c.spoken)
        send("""{"kind":"speaking","text":"One.","answer":1}""")
        assertEquals(1 to 4, c.spoken)
        send("""{"kind":"speaking","text":"Two.","answer":1}""")
        assertEquals(1 to 9, c.spoken)
        // the whole answer arrives while the voice still says it
        send("""{"kind":"turn","number":1,"text":"One. Two. Three.","costUsd":0.01,"answer":1}""")
        assertEquals(1 to 9, c.spoken)
        // a barge-in cut "Three." and the voice says it again from its start
        send("""{"kind":"speaking","text":"Three.","answer":1}""")
        send("""{"kind":"speaking","text":"Three.","answer":1}""")
        assertEquals(1 to 16, c.spoken)
    }

    @Test
    fun aSentenceNoBubbleHoldsLeavesTheGreyWhereItWas() {
        send("""{"kind":"blockStart","answer":1,"block":1}""")
        send("""{"kind":"delta","text":"One. Two.","answer":1,"block":1}""")
        send("""{"kind":"speaking","text":"One.","answer":1}""")
        // a reply from the bridge during a hold is in no bubble of the agent
        send("""{"kind":"speaking","text":"Holding."}""")
        assertEquals(0 to 4, c.spoken)
        c.clear()
        assertEquals(null, c.spoken)
    }

    @Test
    fun theSettingsInForceArriveAndAreKept() {
        send("""{"kind":"settings","settings":{"holdMusic":true,"tones":false,"ttsVoice":"som_00295","holdMusicGain":0.4}}""")
        assertEquals(mapOf("holdMusic" to true, "tones" to false), c.settingsOn)
        assertEquals("som_00295", c.settingWords["ttsVoice"])
        // item 28 a number is neither a switch nor a word: the volume slider reads it
        assertEquals(null, c.settingsOn["holdMusicGain"])
        assertEquals(0.4, c.settingNumbers["holdMusicGain"])
    }

    @Test
    fun aSettingMessageIsWhatTheAppSendsToChangeOne() {
        assertEquals(
            """{"kind":"setting","patch":{"holdMusic":false}}""",
            Outgoing.setting("holdMusic", false).decodeToString(),
        )
        assertEquals(
            """{"kind":"setting","patch":{"voice":"male"}}""",
            Outgoing.voice("male").decodeToString(),
        )
        // item 28 the options menu sends the verbosity and the volume by the same message
        assertEquals(
            """{"kind":"setting","patch":{"verbosity":"brief"}}""",
            Outgoing.setting("verbosity", "brief").decodeToString(),
        )
        assertEquals(
            """{"kind":"setting","patch":{"holdMusicGain":0.25}}""",
            Outgoing.setting("holdMusicGain", 0.25).decodeToString(),
        )
        // item 44 the end-of-turn pause is milliseconds, so it goes as a whole number
        assertEquals(
            """{"kind":"setting","patch":{"endOfTurnPauseMs":1600}}""",
            Outgoing.setting("endOfTurnPauseMs", 1600).decodeToString(),
        )
    }

    @Test
    fun everySettingsMessageIsCountedSoASliderCanGoBackToWhatTheBridgeHolds() {
        // item 44 a refused value comes back as the same settings again: equal
        // maps say nothing changed, and the count is what says a message came
        send("""{"kind":"settings","settings":{"bargeInLevel":0.05,"minSpeechPeak":0.15,"endOfTurnPauseMs":1500}}""")
        send("""{"kind":"settings","settings":{"bargeInLevel":0.05,"minSpeechPeak":0.15,"endOfTurnPauseMs":1500}}""")
        assertEquals(2, c.settingsCount)
        assertEquals(1500.0, c.settingNumbers["endOfTurnPauseMs"])
        c.clear()
        assertEquals(0, c.settingsCount)
    }

    @Test
    fun aRoomThatEndedTakesItsProtocolAndItsWorkWithIt() {
        send("""{"kind":"heard","text":"what is two plus two"}""")
        send("""{"kind":"protocol","endTurn":"end turn"}""")
        send("""{"kind":"working","on":true}""", since = 20_000)
        c.roomEnded(20_500, 20_500)
        assertNull(c.endTurn)
        assertEquals(Sign.OFF, c.sign)
        // the lines stay: what the screen shows belongs to the conversation, not to the room
        assertEquals(listOf("what is two plus two"), texts())
    }

    @Test
    fun aScreenshotTheBridgeHasIsOneLineWhoseStateFollowsTheBridge() {
        send("""{"kind":"screenshot","id":"a","state":"pending"}""", at = 1_000)
        assertEquals(listOf(Line(Line.Kind.SCREENSHOT, "a", 1_000)), c.lines)
        assertEquals(mapOf("a" to "pending"), c.screenshots)
        send("""{"kind":"heard","text":"what is doubled"}""", at = 2_000)
        send("""{"kind":"screenshot","id":"a","state":"sent"}""", at = 2_000)
        // the state changes, and the thumbnail stays where it was
        assertEquals(listOf("a", "what is doubled"), texts())
        assertEquals(mapOf("a" to "sent"), c.screenshots)
        assertEquals(listOf("screenshot", "heard", "screenshot"), logKinds())
    }

    @Test
    fun aDroppedScreenshotKeepsItsLineSoAGrowingAnswerStaysPut() {
        send("""{"kind":"blockStart","answer":1,"block":1}""")
        send("""{"kind":"delta","text":"Let me ","answer":1,"block":1}""")
        send("""{"kind":"screenshot","id":"a","state":"pending"}""")
        send("""{"kind":"screenshot","id":"a","state":"dropped"}""")
        send("""{"kind":"delta","text":"look.","answer":1,"block":1}""")
        assertEquals(listOf("Let me look.", "a"), texts())
        assertEquals("dropped", c.screenshots["a"])
        c.clear()
        assertEquals(emptyMap<String, String>(), c.screenshots)
    }
}
