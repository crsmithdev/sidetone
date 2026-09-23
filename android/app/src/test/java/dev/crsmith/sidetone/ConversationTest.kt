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
        assertEquals(listOf(Conversation.Effect.Offer(Apk("https://b/sidetone.apk", "ab"))), effects)
    }

    @Test
    fun aRejoinIsAskedOfTheRoomAndNothingElse() {
        assertEquals(listOf(Conversation.Effect.Rejoin), send("""{"kind":"rejoin"}"""))
        assertTrue(c.lines.isEmpty())
    }

    @Test
    fun theHistoryIsShownOnceAndSaysWhereItEnds() {
        send("""{"kind":"history","turns":[{"kind":"heard","text":"earlier question","at":5}]}""")
        assertEquals(listOf("earlier", "earlier question", "now"), texts())
        send("""{"kind":"history","turns":[{"kind":"heard","text":"earlier question","at":5}]}""")
        assertEquals(listOf("earlier", "earlier question", "now"), texts())
        // a new room shows it again, because a client that comes back missed what it missed
        c.forgetHistory()
        send("""{"kind":"history","turns":[{"kind":"heard","text":"later question","at":6}]}""")
        assertTrue(texts().contains("later question"))
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
    fun theVoiceReachingASentenceIsKeptForTheScreen() {
        send("""{"kind":"blockStart","answer":1,"block":1}""")
        send("""{"kind":"delta","text":"One. Two.","answer":1,"block":1}""")
        // the words are on the screen, and the voice has not reached them yet
        assertEquals(null, c.speaking)
        send("""{"kind":"speaking","text":"One.","answer":1}""")
        assertEquals(1 to "One.", c.speaking)
        send("""{"kind":"speaking","text":"Two.","answer":1}""")
        assertEquals(1 to "Two.", c.speaking)
        // the whole answer arriving means the voice has finished with it
        send("""{"kind":"turn","number":1,"text":"One. Two.","costUsd":0.01,"answer":1}""")
        assertEquals(null, c.speaking)
    }

    @Test
    fun theSettingsInForceArriveAndAreKept() {
        send("""{"kind":"settings","settings":{"holdMusic":true,"tones":false,"ttsVoice":"som_00295","holdMusicGain":0.4}}""")
        assertEquals(mapOf("holdMusic" to true, "tones" to false), c.settingsOn)
        assertEquals("som_00295", c.settingWords["ttsVoice"])
        // a number is neither a switch nor a word the app shows today
        assertEquals(null, c.settingsOn["holdMusicGain"])
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
}
