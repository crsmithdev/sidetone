package dev.crsmith.sidetone

import io.livekit.android.room.participant.ConnectionQuality
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** 17.11.6 the status row says one thing about the room, whatever the inputs. */
class ReadingTest {
    /** Every quality `Bridge` can hold: LiveKit's own levels, as it writes them, and none yet. */
    private val qualities = ConnectionQuality.entries.map { it.name.lowercase() } + null

    private fun everyReading() = Status.entries.flatMap { status ->
        qualities.flatMap { quality -> Sign.entries.map { sign -> Triple(status, quality, sign) } }
    }

    /**
     * 17.11.6 each word has one colour and one motion, for every input. The
     * colour says whether the bridge hears Chris; the pulse says work is in
     * progress. Only "listening" has both a solid and a pulsing dot: the
     * pulse there is the agent that works.
     */
    @Test
    fun eachWordHasItsColourAndItsMotion() {
        val expected = mapOf(
            "listening" to Light.GREEN,
            "connecting" to Light.AMBER,
            "rejoining" to Light.AMBER,
            "reconnecting" to Light.AMBER,
            "waiting" to Light.AMBER,
            "starting" to Light.AMBER,
            "disconnected" to Light.RED,
            "signal lost" to Light.RED,
            "stalled" to Light.RED,
            "left" to Light.GREY,
        )
        for ((status, quality, sign) in everyReading()) {
            val r = reading(status, quality, sign)
            val at = "$status $quality $sign -> $r"
            assertEquals(at, expected[r.word], r.light)
            val pulse = when (r.light) {
                Light.GREEN -> sign == Sign.WORKING
                Light.AMBER -> true
                // the app retries every Joining.RETRY_MS, so that is work in progress
                Light.RED -> r.word == "disconnected"
                Light.GREY -> false
            }
            assertEquals(at, pulse, r.pulse)
            assertEquals(at, r.light == Light.GREEN && r.pulse, r.working)
        }
    }

    /**
     * The row is green only when the bridge hears Chris: the transport holds
     * the room, the phone's media reaches it, and the heartbeat comes.
     */
    @Test
    fun greenIsOnlyARoomThatHearsYou() {
        for ((status, quality, sign) in everyReading()) {
            val r = reading(status, quality, sign)
            val hears = status == Status.LISTENING && quality != "lost" && sign != Sign.SILENT
            assertEquals("$status $quality $sign -> $r", hears, r.light == Light.GREEN)
            // 17.11.10 grey is the one colour that says nothing is wrong and nothing is being tried
            assertEquals("$status $quality $sign -> $r", status == Status.LEFT, r.light == Light.GREY)
        }
    }

    /**
     * 17.11.7 the row shows the status word beside the light in every state.
     * It showed a word only in the surprising states, so Chris, who mostly
     * sees a live room, never saw one (docs/todo.md item 45).
     */
    @Test
    fun everyStateHasItsOwnWord() {
        val words = Status.entries.associateWith { reading(it, "good", Sign.OFF).word }
        assertEquals(
            mapOf(
                Status.IDLE to "connecting",
                Status.CONNECTING to "connecting",
                Status.LISTENING to "listening",
                Status.RECONNECTING to "reconnecting",
                Status.REJOINING to "rejoining",
                Status.UNREACHABLE to "disconnected",
                Status.LEFT to "left",
                Status.WAITING to "waiting",
                Status.STARTING to "starting",
            ),
            words,
        )
    }

    /** 17.11.3 a heartbeat that stopped in a live room is its own reading: red and still. */
    @Test
    fun aStalledBridgeIsRedAndStill() {
        for (quality in listOf("excellent", "good", "poor", null)) {
            assertEquals(Reading(Light.RED, "stalled", pulse = false), reading(Status.LISTENING, quality, Sign.SILENT))
        }
    }

    /** A live room shows the sign as the pulse; the quality no longer shows. */
    @Test
    fun aLiveRoomPulsesWhileTheAgentWorks() {
        for (quality in listOf("excellent", "good", "poor", null)) {
            assertEquals(Reading(Light.GREEN, "listening", pulse = false), reading(Status.LISTENING, quality, Sign.OFF))
            assertEquals(Reading(Light.GREEN, "listening", pulse = true), reading(Status.LISTENING, quality, Sign.WORKING))
        }
    }

    /** The row the brief names: a sign kept from before the drop does not show. */
    @Test
    fun aRoomThatIsGoneSaysOnlyWhy() {
        assertEquals(Reading(Light.AMBER, "reconnecting", pulse = true), reading(Status.RECONNECTING, "excellent", Sign.SILENT))
        assertEquals(Reading(Light.RED, "disconnected", pulse = true), reading(Status.UNREACHABLE, "excellent", Sign.WORKING))
        assertEquals(Reading(Light.AMBER, "rejoining", pulse = true), reading(Status.REJOINING, "good", Sign.WORKING))
        // 17.11.10 a room Chris left by hand is not a room that is being got back
        assertEquals(Reading(Light.GREY, "left", pulse = false), reading(Status.LEFT, "excellent", Sign.WORKING))
        // 17.11.11 a bridge that is gone or starts sends no heartbeat, so no "stalled" and no pulse of work
        assertEquals(Reading(Light.AMBER, "waiting", pulse = true), reading(Status.WAITING, "excellent", Sign.SILENT))
        assertEquals(Reading(Light.AMBER, "starting", pulse = true), reading(Status.STARTING, "excellent", Sign.SILENT))
    }

    /** The transport holds the room and LiveKit says the phone's media is lost. "stalled" would blame the bridge. */
    @Test
    fun aLostQualityIsNotALiveRoom() {
        for (sign in Sign.entries) {
            assertEquals(Reading(Light.RED, "signal lost", pulse = false), reading(Status.LISTENING, "lost", sign))
        }
    }

    /** 17.11.9 the legend has one row for each colour, in the order green, amber, red, grey. */
    @Test
    fun theLegendHasOneRowForEachColour() {
        assertEquals(listOf(Light.GREEN, Light.AMBER, Light.RED, Light.GREY), LEGEND.map { it.light })
        for (row in LEGEND) {
            assertTrue("$row", row.readings.all { (r, _) -> r.light == row.light })
        }
    }

    /**
     * 17.11.9 the legend names each word the row can show, with its colour and
     * its motion, so each dot it draws is a dot the row can show.
     */
    @Test
    fun theLegendHasEveryState() {
        val shown = everyReading().map { (status, quality, sign) -> reading(status, quality, sign) }.toSet()
        assertEquals(shown, LEGEND.flatMap { row -> row.readings.map { it.first } }.toSet())
        // each word is in one row, once
        val words = LEGEND.flatMap { it.words }
        assertEquals(words.size, words.toSet().size)
    }

    /** 17.11.9 where a colour has a solid and a pulsing dot, the legend draws both, solid first. */
    @Test
    fun theLegendDrawsEachMotionOfAColour() {
        assertEquals(
            listOf(listOf(false, true), listOf(true), listOf(false, true), listOf(false)),
            LEGEND.map { it.pulses },
        )
    }

    /** 17.11.9 red lists each of its words with one line, because each asks something else of Chris. */
    @Test
    fun eachRedWordHasItsLine() {
        val red = LEGEND.single { it.light == Light.RED }
        assertEquals(listOf("disconnected", "signal lost", "stalled"), red.words)
        assertTrue(red.readings.all { (_, line) -> !line.isNullOrBlank() })
        assertTrue(red.readings.first().second!!.contains("${Joining.RETRY_MS / 1000} seconds"))
    }
}
