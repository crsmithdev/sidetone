package dev.crsmith.sidetone

import io.livekit.android.room.participant.ConnectionQuality
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
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
     * Each part of the row says whether the room is live. The dot, the word,
     * the quality and the sign have to say the same, for every input: two parts
     * that disagree are two readings, such as "listening · excellent · stalled"
     * from a room that is gone.
     */
    @Test
    fun noInputGivesTwoReadingsThatContradict() {
        for ((status, quality, sign) in everyReading()) {
            val r = reading(status, quality, sign)
            val at = "$status $quality $sign -> $r"
            val live = r.light == Light.LIVE
            assertEquals(at, live, r.word == "listening")
            assertEquals(at, live, r.quality != null)
            assertTrue(at, live || r.sign == Sign.OFF)
            // a lost quality says the link is down, so it cannot stand beside a live room
            assertFalse(at, r.quality == "lost")
            assertEquals(at, r.light == Light.REJOINING, r.word == "rejoining")
            // the row says "listening" only when the transport has the room
            assertTrue(at, !live || status == Status.LISTENING)
        }
    }

    /** A live room hides nothing: the quality and the sign show as they are. */
    @Test
    fun aLiveRoomShowsItsQualityAndItsSign() {
        for (sign in Sign.entries) {
            assertEquals(Reading(Light.LIVE, "listening", "excellent", sign), reading(Status.LISTENING, "excellent", sign))
        }
        assertEquals(Reading(Light.LIVE, "listening", "—", Sign.OFF), reading(Status.LISTENING, null, Sign.OFF))
    }

    /** The row the brief names: a quality and a sign kept from before the drop. */
    @Test
    fun aRoomThatIsGoneSaysOnlyWhy() {
        assertEquals(Reading(Light.OFF, "reconnecting", null, Sign.OFF), reading(Status.RECONNECTING, "excellent", Sign.SILENT))
        assertEquals(Reading(Light.OFF, "disconnected", null, Sign.OFF), reading(Status.UNREACHABLE, "excellent", Sign.WORKING))
        assertEquals(Reading(Light.REJOINING, "rejoining", null, Sign.OFF), reading(Status.REJOINING, "good", Sign.WORKING))
    }

    /** The transport holds the room and LiveKit says the phone's media is lost. "stalled" would blame the bridge. */
    @Test
    fun aLostQualityIsNotALiveRoom() {
        assertEquals(Reading(Light.OFF, "signal lost", null, Sign.OFF), reading(Status.LISTENING, "lost", Sign.SILENT))
    }
}
