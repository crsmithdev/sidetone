package dev.crsmith.sidetone

import dev.crsmith.sidetone.Joining.Effect
import dev.crsmith.sidetone.Joining.Event
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The link to the bridge, with no room, no LiveKit and no Android. The clock is
 * the test's own, so a retry is a time in an [Effect.Open], not a wait.
 */
class JoiningTest {
    private val joining = Joining()

    /** The elapsed clock, in milliseconds. */
    private var now = 100_000L

    private fun on(event: Event) = joining.on(event, now)

    /**
     * What `Bridge.join` does with the effects: wait until an [Effect.Open] is
     * due, then open. Returns the time the next room opens, or null for none.
     */
    private fun ended(reason: String): Long? {
        val effects = on(Event.Ended(reason))
        return effects.filterIsInstance<Effect.Open>().singleOrNull()?.at
    }

    private fun opened() {
        on(Event.Opening)
        on(Event.Connected)
    }

    @Test
    fun aRoomThatOpensIsListening() {
        assertEquals(Status.IDLE, joining.status)
        assertEquals(emptyList<Effect>(), on(Event.Opening))
        assertEquals(Status.CONNECTING, joining.status)
        assertEquals(emptyList<Effect>(), on(Event.Connected))
        assertEquals(Status.LISTENING, joining.status)
        assertNull(joining.error)
    }

    @Test
    fun theTransportGettingTheRoomBackByItselfSaysSo() {
        opened()
        on(Event.Reconnecting)
        assertEquals(Status.RECONNECTING, joining.status)
        on(Event.Reconnected)
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
            "failed to validate connection",
            "websocket failure: Failed to connect to /100.64.12.9:7880",
            "",
        )
        for (reason in reasons) {
            val joining = Joining()
            joining.on(Event.Opening, now)
            joining.on(Event.Connected, now)
            val effects = joining.on(Event.Ended(reason), now)
            assertEquals("$reason should be tried again", listOf(Effect.Open(now + Joining.RETRY_MS)), effects)
            assertEquals(Status.UNREACHABLE, joining.status)
            assertTrue(joining.error!!.contains("Retrying"))
        }
    }

    /**
     * docs/todo.md item 7, the restart that ends the room: LiveKit restarts with
     * the bridge. The transport tries to get the room back and fails, the room
     * ends, and while LiveKit is down every try fails at once. The app tries
     * every 5 s on the clock, and the first try after LiveKit is back is an
     * ordinary live room, with no touch and with the pairing kept.
     */
    @Test
    fun theAppIsListeningAgainAfterTheServerComesBack() {
        opened()
        now += 60_000
        on(Event.Reconnecting)
        assertEquals(Status.RECONNECTING, joining.status)
        now += 15_000
        var at = ended("the connection dropped")!!
        assertEquals(now + Joining.RETRY_MS, at)
        assertEquals(Status.UNREACHABLE, joining.status)
        // LiveKit takes 40 s to come back; each try inside that fails
        val back = now + 40_000
        var tries = 0
        while (true) {
            now = at
            on(Event.Opening)
            tries++
            assertEquals(Status.CONNECTING, joining.status)
            if (now >= back) break
            at = ended("websocket failure: Failed to connect to /100.64.12.9:7880")!!
            assertEquals(now + Joining.RETRY_MS, at)
        }
        on(Event.Connected)
        assertEquals(Status.LISTENING, joining.status)
        assertNull(joining.error)
        // the first try at or after the server is back, and not a try later
        assertEquals(8, tries)
        assertTrue(now - back < Joining.RETRY_MS)
    }

    /**
     * docs/todo.md item 7, the restart that keeps the room: the bridge restarts
     * and LiveKit does not. The transport sees a blip at most, and gets the room
     * back itself. Nothing ends, so nothing is tried again and nothing is forgotten.
     */
    @Test
    fun aBridgeRestartThatKeepsTheRoomNeedsNothing() {
        opened()
        now += 1_000
        assertEquals(emptyList<Effect>(), on(Event.Reconnecting))
        now += 3_000
        assertEquals(emptyList<Effect>(), on(Event.Reconnected))
        assertEquals(Status.LISTENING, joining.status)
        assertNull(joining.error)
    }

    /** A bridge that stays down is asked again and again, not once, and never forgotten. */
    @Test
    fun aBridgeThatStaysDownIsTriedAgainEveryTime() {
        for (attempt in 1..20) {
            on(Event.Opening)
            assertEquals(Status.CONNECTING, joining.status)
            val effects = on(Event.Ended("the connection dropped"))
            assertEquals(listOf(Effect.Open(now + Joining.RETRY_MS)), effects)
            now += Joining.RETRY_MS
        }
        opened()
        assertEquals(Status.LISTENING, joining.status)
        assertNull(joining.error)
    }

    @Test
    fun aRefusedPairingIsTheOneEndThatStops() {
        on(Event.Opening)
        assertEquals(listOf(Effect.Forget), on(Event.Ended("unauthorized")))
        assertEquals(Status.IDLE, joining.status)
        assertTrue(joining.error!!.contains("Scan the code again"))
    }

    /** 18.9 a rejoin is the app's own doing, so it ends the room, opens again at once and says nothing went wrong. */
    @Test
    fun aRejoinOpensAgainAtOnceAndIsNoFault() {
        opened()
        assertEquals(listOf(Effect.End(Joining.REJOINING)), on(Event.RejoinAsked))
        assertEquals(Status.REJOINING, joining.status)
        assertEquals(listOf(Effect.Open(now)), on(Event.Ended(Joining.REJOINING)))
        assertNull(joining.error)
        // the word stays until the room is back, so a rejoin does not read as a drop
        on(Event.Opening)
        assertEquals(Status.REJOINING, joining.status)
        on(Event.Connected)
        assertEquals(Status.LISTENING, joining.status)
    }

    /** 18.9 a phone that is simply silent asks for rejoin after rejoin. Only the first counts. */
    @Test
    fun aSecondRejoinInsideTheWindowIsRefused() {
        opened()
        assertEquals(1, on(Event.RejoinAsked).size)
        on(Event.Ended(Joining.REJOINING))
        opened()
        now += REJOIN_MS - 1
        assertEquals(emptyList<Effect>(), on(Event.RejoinAsked))
        assertEquals(Status.LISTENING, joining.status)
        now += 1
        assertEquals(1, on(Event.RejoinAsked).size)
    }

    /**
     * 18.15 a pushed setup applies by a rejoin, at once. The window of 18.9.4
     * is for a phone that is simply silent; a push is one message from a
     * script, so it is not held to it, and it counts as the last rejoin.
     */
    @Test
    fun aChangedSetupRejoinsAtOnceEvenInsideTheWindow() {
        opened()
        on(Event.RejoinAsked)
        on(Event.Ended(Joining.REJOINING))
        opened()
        now += 1_000
        assertEquals(listOf(Effect.End(Joining.REJOINING)), on(Event.SetupChanged))
        assertEquals(Status.REJOINING, joining.status)
        assertEquals(listOf(Effect.Open(now)), on(Event.Ended(Joining.REJOINING)))
        assertNull(joining.error)
        opened()
        now += REJOIN_MS - 1
        assertEquals(emptyList<Effect>(), on(Event.RejoinAsked))
    }

    /** 17.22.4 a quit ends the conversation: the next open of the app starts afresh. */
    @Test
    fun aConversationQuitByHandIsIdleAndHasNothingWrong() {
        on(Event.Opening)
        on(Event.Ended("the connection dropped"))
        assertEquals(emptyList<Effect>(), on(Event.Quit))
        assertEquals(Status.IDLE, joining.status)
        assertNull(joining.error)
    }

    /**
     * 17.11.10 Chris leaves the room by hand and the app stays open. Nothing is
     * wrong and nothing tries again: the room is his to come back to, and the
     * way back in is an ordinary join, with the word of one.
     */
    @Test
    fun aRoomLeftByHandStaysLeftUntilHeComesBack() {
        opened()
        assertEquals(emptyList<Effect>(), on(Event.Left))
        assertEquals(Status.LEFT, joining.status)
        assertNull(joining.error)
        on(Event.Opening)
        assertEquals(Status.CONNECTING, joining.status)
        on(Event.Connected)
        assertEquals(Status.LISTENING, joining.status)
    }

    /**
     * 17.11.10 a leave in the middle of a retry gives no retry, and a leave
     * after a rejoin starts the window of 18.9.4 afresh: the room Chris comes
     * back to is a new one, by his own hand.
     */
    @Test
    fun aLeaveEndsTheRetryAndTheRejoinWindow() {
        on(Event.Opening)
        on(Event.Ended("the connection dropped"))
        assertEquals(Status.UNREACHABLE, joining.status)
        assertEquals(emptyList<Effect>(), on(Event.Left))
        assertEquals(Status.LEFT, joining.status)
        assertNull(joining.error)
        opened()
        on(Event.RejoinAsked)
        on(Event.Ended(Joining.REJOINING))
        opened()
        on(Event.Left)
        now += 1_000
        opened()
        assertEquals(1, on(Event.RejoinAsked).size)
    }

    /** The reason the room gives goes on the screen, so Chris can say what he saw. */
    @Test
    fun theReasonTheRoomGaveIsShown() {
        on(Event.Opening)
        on(Event.Ended("the connection dropped"))
        assertEquals("Cannot reach the bridge: the connection dropped. Retrying.", joining.error)
    }
}
