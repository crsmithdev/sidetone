package dev.crsmith.sidetone

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class WorkTest {
    @Test
    fun theSignIsOffWhenTheBridgeSaysOff_howeverOldTheWordIs() {
        assertEquals(Sign.OFF, sign(on = false, at = 0, now = 0))
        assertEquals(Sign.OFF, sign(on = false, at = 0, now = 10 * WORKING_STALE_MS))
    }

    @Test
    fun theSignWorksWhileTheHeartbeatComes() {
        assertEquals(Sign.WORKING, sign(on = true, at = 1_000, now = 1_000))
        assertEquals(Sign.WORKING, sign(on = true, at = 1_000, now = 1_000 + WORKING_STALE_MS))
    }

    @Test
    fun aBridgeThatSaidItWorksAndWentQuietIsSilent() {
        assertEquals(Sign.SILENT, sign(on = true, at = 1_000, now = 1_001 + WORKING_STALE_MS))
    }

    @Test
    fun theStaleTimeIsThreeHeartbeatsOfTheBridge() {
        // src/working.ts HEARTBEAT_MS is 5000. Change both or neither.
        assertEquals(3 * 5_000L, WORKING_STALE_MS)
    }

    @Test
    fun theSignHasWordsOnlyWhenItShows() {
        assertEquals("", signWord(Sign.OFF))
        assertEquals("working", signWord(Sign.WORKING))
        assertEquals("stalled", signWord(Sign.SILENT))
    }

    @Test
    fun theSignShowsOnlyInALiveRoom() {
        // 17.11.6 "reconnecting" beside "stalled" would name two causes for one silence
        for (sign in Sign.entries) assertEquals(sign, shownSign(Status.LISTENING, sign))
        for (status in Status.entries.filter { it != Status.LISTENING }) {
            for (sign in Sign.entries) assertEquals(Sign.OFF, shownSign(status, sign))
        }
    }

    @Test
    fun theQualityShowsOnlyInALiveRoom() {
        assertEquals("excellent", qualityWord(Status.LISTENING, "excellent"))
        assertEquals("—", qualityWord(Status.LISTENING, null))
        // a reading kept from before the drop would say "excellent" beside "reconnecting"
        assertNull(qualityWord(Status.RECONNECTING, "excellent"))
        assertNull(qualityWord(Status.UNREACHABLE, null))
    }

    @Test
    fun takesTheWorkingMessage() {
        // src/messages.ts: { kind: "working"; on: boolean }
        assertEquals(Incoming.Working(true), decode("""{"kind":"working","on":true}""".encodeToByteArray()))
        assertEquals(Incoming.Working(false), decode("""{"kind":"working","on":false}""".encodeToByteArray()))
        // a message with no answer to give is dropped, not shown as "unknown"
        assertNull(decode("""{"kind":"working"}""".encodeToByteArray()))
    }
}
