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
     * Each part of the row says whether the room is live. The dot, the ring,
     * the motion and the word have to say the same, for every input: two parts
     * that disagree are two readings, such as a stalled blink and a thick ring
     * on a room that is gone.
     */
    @Test
    fun noInputGivesTwoReadingsThatContradict() {
        for ((status, quality, sign) in everyReading()) {
            val r = reading(status, quality, sign)
            val at = "$status $quality $sign -> $r"
            val live = r.light == Light.GREEN
            assertEquals(at, live, r.word == "listening")
            assertTrue(at, live || r.ring == null)
            assertTrue(at, live || r.sign == Sign.OFF)
            // a live room shows no word: the dot says it
            assertTrue(at, !live || r.caption == null)
            // the row says "listening" only when the transport has the room
            assertTrue(at, !live || status == Status.LISTENING)
            assertEquals(at, r.light == Light.RED, status == Status.UNREACHABLE)
        }
    }

    /** Words show only for the surprising states. Connecting and rejoining show in the colour. */
    @Test
    fun onlyASurprisingStateHasAWord() {
        for ((status, quality, sign) in everyReading()) {
            val r = reading(status, quality, sign)
            val surprising = status == Status.RECONNECTING || status == Status.UNREACHABLE ||
                (status == Status.LISTENING && quality == "lost")
            assertEquals("$status $quality $sign -> $r", surprising, r.caption != null)
        }
        assertEquals(Light.AMBER, reading(Status.CONNECTING, null, Sign.OFF).light)
        assertEquals(Light.AMBER, reading(Status.REJOINING, "good", Sign.OFF).light)
    }

    /** A live room hides nothing: the quality shows as the ring and the sign as the motion. */
    @Test
    fun aLiveRoomShowsItsQualityAndItsSign() {
        for (sign in Sign.entries) {
            assertEquals(Reading(Light.GREEN, "listening", null, Ring.THICK, sign), reading(Status.LISTENING, "excellent", sign))
        }
        assertEquals(Ring.MEDIUM, reading(Status.LISTENING, "good", Sign.OFF).ring)
        assertEquals(Ring.THIN, reading(Status.LISTENING, "poor", Sign.OFF).ring)
        // a quality not known yet draws no ring
        assertEquals(Reading(Light.GREEN, "listening", null, null, Sign.OFF), reading(Status.LISTENING, null, Sign.OFF))
    }

    /** The row the brief names: a quality and a sign kept from before the drop. */
    @Test
    fun aRoomThatIsGoneSaysOnlyWhy() {
        assertEquals(Reading(Light.AMBER, "reconnecting", "reconnecting", null, Sign.OFF), reading(Status.RECONNECTING, "excellent", Sign.SILENT))
        assertEquals(Reading(Light.RED, "disconnected", "disconnected", null, Sign.OFF), reading(Status.UNREACHABLE, "excellent", Sign.WORKING))
        assertEquals(Reading(Light.AMBER, "rejoining", null, null, Sign.OFF), reading(Status.REJOINING, "good", Sign.WORKING))
    }

    /** The transport holds the room and LiveKit says the phone's media is lost. "stalled" would blame the bridge. */
    @Test
    fun aLostQualityIsNotALiveRoom() {
        assertEquals(Reading(Light.AMBER, "signal lost", "signal lost", null, Sign.OFF), reading(Status.LISTENING, "lost", Sign.SILENT))
    }
}
