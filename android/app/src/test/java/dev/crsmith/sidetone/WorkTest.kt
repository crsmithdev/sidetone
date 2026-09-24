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

    /**
     * 17.11.3 and 17.16.1 a stalled sign is the status word, not a sign beside
     * it: the row and the notification say "stalled", and "working" goes.
     */
    @Test
    fun aStalledSignIsTheWordOfTheRowAndOfTheNotification() {
        val stalled = reading(Status.LISTENING, "good", Sign.SILENT)
        assertEquals(signWord(Sign.SILENT), stalled.word)
        assertEquals("stalled", stateLine(BridgeService.Shown(stalled, micOn = true, audioOn = true, inRoom = true)))
        assertEquals("stalled · mic off", stateLine(BridgeService.Shown(stalled, micOn = false, audioOn = true, inRoom = true)))
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
