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
            // the row says "listening" only when the transport has the room
            assertTrue(at, !live || status == Status.LISTENING)
            assertEquals(at, r.light == Light.RED, status == Status.UNREACHABLE)
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
            ),
            words,
        )
    }

    /** 17.11.9 the legend names each word the row can show, once, with the colour the light has for it. */
    @Test
    fun theLegendHasEveryState() {
        val shown = everyReading().map { (status, quality, sign) -> reading(status, quality, sign) }
        val legend = LEGEND.map { it.first }
        assertEquals(shown.map { it.word to it.light }.toSet(), legend.map { it.word to it.light }.toSet())
        assertEquals(legend.size, legend.map { it.word }.toSet().size)
    }

    /** A live room hides nothing: the quality shows as the ring and the sign as the motion. */
    @Test
    fun aLiveRoomShowsItsQualityAndItsSign() {
        for (sign in Sign.entries) {
            assertEquals(Reading(Light.GREEN, "listening", Ring.THICK, sign), reading(Status.LISTENING, "excellent", sign))
        }
        assertEquals(Ring.MEDIUM, reading(Status.LISTENING, "good", Sign.OFF).ring)
        assertEquals(Ring.THIN, reading(Status.LISTENING, "poor", Sign.OFF).ring)
        // a quality not known yet draws no ring
        assertEquals(Reading(Light.GREEN, "listening", null, Sign.OFF), reading(Status.LISTENING, null, Sign.OFF))
    }

    /** The row the brief names: a quality and a sign kept from before the drop. */
    @Test
    fun aRoomThatIsGoneSaysOnlyWhy() {
        assertEquals(Reading(Light.AMBER, "reconnecting", null, Sign.OFF), reading(Status.RECONNECTING, "excellent", Sign.SILENT))
        assertEquals(Reading(Light.RED, "disconnected", null, Sign.OFF), reading(Status.UNREACHABLE, "excellent", Sign.WORKING))
        assertEquals(Reading(Light.AMBER, "rejoining", null, Sign.OFF), reading(Status.REJOINING, "good", Sign.WORKING))
    }

    /** The transport holds the room and LiveKit says the phone's media is lost. "stalled" would blame the bridge. */
    @Test
    fun aLostQualityIsNotALiveRoom() {
        assertEquals(Reading(Light.AMBER, "signal lost", null, Sign.OFF), reading(Status.LISTENING, "lost", Sign.SILENT))
    }
}
