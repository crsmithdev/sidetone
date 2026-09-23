package dev.crsmith.sidetone

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class JoiningTest {
    @Test
    fun aRoomThatOpensIsListening() {
        val joining = Joining()
        assertEquals(Status.IDLE, joining.status)
        joining.opening()
        assertEquals(Status.CONNECTING, joining.status)
        joining.open()
        assertEquals(Status.LISTENING, joining.status)
        assertNull(joining.error)
    }

    @Test
    fun theTransportGettingTheRoomBackByItselfSaysSo() {
        val joining = Joining()
        joining.opening()
        joining.open()
        joining.reconnecting()
        assertEquals(Status.RECONNECTING, joining.status)
        joining.reconnected()
        assertEquals(Status.LISTENING, joining.status)
    }

    /**
     * docs/todo.md item 7. The bridge restarting does not end the phone's room,
     * because LiveKit runs apart from the bridge, but a restart that does end it
     * gives an ordinary reason. The app has to wait and try again, whatever that
     * reason says, or Chris has to force quit the app to get it back.
     */
    @Test
    fun everyEndButARefusalIsTriedAgain() {
        val reasons = listOf(
            "the connection dropped",
            "client initiated",
            "server shutdown",
            "duplicate identity",
            "signal close",
            "room closed",
            "java.net.SocketTimeoutException: timeout",
            "",
        )
        for (reason in reasons) {
            val joining = Joining()
            joining.opening()
            joining.open()
            val next = joining.ended(reason)
            assertEquals("$reason should be tried again", Joining.Next.WaitThenOpen(Joining.RETRY_MS), next)
            assertEquals(Status.UNREACHABLE, joining.status)
            assertTrue(joining.error!!.contains("Retrying"))
        }
    }

    /** A bridge that stays down is asked again and again, not once. */
    @Test
    fun aBridgeThatStaysDownIsTriedAgainEveryTime() {
        val joining = Joining()
        for (attempt in 1..20) {
            joining.opening()
            assertEquals(Status.CONNECTING, joining.status)
            assertEquals(Joining.Next.WaitThenOpen(Joining.RETRY_MS), joining.ended("the connection dropped"))
        }
        // and the room it finally gets is an ordinary live room
        joining.opening()
        joining.open()
        assertEquals(Status.LISTENING, joining.status)
        assertNull(joining.error)
    }

    @Test
    fun aRefusedPairingIsTheOneEndThatStops() {
        val joining = Joining()
        joining.opening()
        val next = joining.ended("unauthorized")
        assertEquals(Joining.Next.Forget, next)
        assertEquals(Status.IDLE, joining.status)
        assertTrue(joining.error!!.contains("Scan the code again"))
    }

    /** 18.9 a rejoin is the app's own doing, so it opens again at once and says nothing went wrong. */
    @Test
    fun aRejoinOpensAgainAtOnceAndIsNoFault() {
        val joining = Joining()
        joining.opening()
        joining.open()
        assertTrue(joining.rejoinAsked(now = 1_000))
        assertEquals(Status.REJOINING, joining.status)
        assertEquals(Joining.Next.Open, joining.ended(Joining.REJOINING))
        assertNull(joining.error)
        // the word stays until the room is back, so a rejoin does not read as a drop
        joining.opening()
        assertEquals(Status.REJOINING, joining.status)
        joining.open()
        assertEquals(Status.LISTENING, joining.status)
    }

    /** 18.9 a phone that is simply silent asks for rejoin after rejoin. Only the first counts. */
    @Test
    fun aSecondRejoinInsideTheWindowIsRefused() {
        val joining = Joining()
        joining.opening()
        joining.open()
        assertTrue(joining.rejoinAsked(now = 1_000))
        assertFalse(joining.rejoinAsked(now = 1_000 + REJOIN_MS - 1))
        assertTrue(joining.rejoinAsked(now = 1_000 + REJOIN_MS))
    }

    @Test
    fun aConversationEndedByHandIsIdleAndHasNothingWrong() {
        val joining = Joining()
        joining.opening()
        joining.ended("the connection dropped")
        joining.left()
        assertEquals(Status.IDLE, joining.status)
        assertNull(joining.error)
    }

    /** The reason the room gives goes on the screen, so Chris can say what he saw. */
    @Test
    fun theReasonTheRoomGaveIsShown() {
        val joining = Joining()
        joining.opening()
        joining.ended("the connection dropped")
        assertEquals("Cannot reach the bridge: the connection dropped. Retrying.", joining.error)
    }
}
