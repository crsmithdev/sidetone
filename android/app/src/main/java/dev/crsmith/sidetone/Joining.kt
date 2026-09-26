package dev.crsmith.sidetone

/**
 * 17.11 what the app can say about the room. REJOINING: 18.9 the bridge asked
 * for a new microphone track, and the app is joining again. LEFT: 17.11.10
 * Chris left the room by hand, and the app waits for him to come back.
 * WAITING: 17.11.11 the phone is in the room and the bridge is not, as during
 * a restart. STARTING: 14.16 the bridge is in the room and loads its speech
 * workers.
 */
enum class Status { IDLE, CONNECTING, LISTENING, RECONNECTING, REJOINING, UNREACHABLE, LEFT, WAITING, STARTING }

/**
 * 17.11.11 whether a participant is the bridge. The bridge joins as
 * `bridge-<clock>-<random>`, a new name for each process (src/transport.ts).
 */
fun isBridge(identity: String?): Boolean = identity?.startsWith("bridge") == true

/**
 * The link to the bridge: the status word the screen shows, and what the app
 * does after a room ends (17.11, 18.9).
 *
 * This used to be spread across three places in `Bridge`: the loop in `join`
 * set CONNECTING and UNREACHABLE and held the retry, `runRoom` set LISTENING,
 * and the room's own events set RECONNECTING and REJOINING. None of it ran
 * without a `Room` and an Android context, so the one rule that matters —
 * the app gives up only when the bridge refuses the pairing, and keeps trying
 * for every other end (docs/todo.md item 7) — could not be asserted at all.
 *
 * So the statuses and the decisions live here, as [Conversation]'s do: an
 * [Event] and the time in, a new status and a list of [Effect]s out. The time
 * is [android.os.SystemClock.elapsedRealtime], so a test gives its own clock.
 * `Bridge` keeps the room, turns the room's events into [Event]s, and does the
 * effects.
 */
class Joining(private val retryMs: Long = RETRY_MS) {
    /** What happened to the room. */
    sealed interface Event {
        /** A room is about to open. */
        data object Opening : Event

        /**
         * The room is up and messages can come. `bridgeHere` says whether the
         * bridge was in the room at the join. A bridge that is there is taken
         * as ready until it says it starts (14.16).
         */
        data class Connected(val bridgeHere: Boolean = true) : Event

        /** 17.11.11 the bridge came into the room. A new bridge process starts before it hears (14.16). */
        data object BridgeArrived : Event

        /** 17.11.11 the last bridge left the room, as on a restart. The phone's room stays up. */
        data object BridgeLeft : Event

        /** 14.16 the bridge says it loads its speech workers, or that it has. */
        data class Starting(val on: Boolean) : Event

        /** The transport lost the room and is getting it back by itself. */
        data object Reconnecting : Event

        /** The transport has the room back. */
        data object Reconnected : Event

        /** The room ended, or never opened, for the reason the transport gave. */
        data class Ended(val reason: String) : Event

        /** 18.9 the bridge hears no sound from the microphone track and asks for a new one. */
        data object RejoinAsked : Event

        /** 18.15 the audio setup changed, and the room is built with it at join. */
        data object SetupChanged : Event

        /** 17.11.10 Chris left the room by hand, and the app stays open with the conversation. */
        data object Left : Event

        /** 17.22.4 the conversation ended by hand, and the app closes. */
        data object Quit : Event
    }

    /** What the app does to the room. */
    sealed interface Effect {
        /** Open a room at `at`, on the same clock as the events. A time already past means now. */
        data class Open(val at: Long) : Effect

        /** End the room that is open, with this reason. It comes back as [Event.Ended]. */
        data class End(val reason: String) : Effect

        /** The bridge refused the saved pairing. Forget it, stop, and show [Joining.error]. */
        data object Forget : Effect
    }

    /** The phone's own link to the room. The status is this, unless the link is up. */
    private var link: Status = Status.IDLE

    /** 17.11.11 the bridge in the room, as far as the app knows. */
    private enum class Presence { GONE, STARTING, READY }

    private var bridge = Presence.GONE

    /** With the link up, what the bridge is doing decides the word (17.11.11). */
    val status: Status
        get() = if (link != Status.LISTENING) link else when (bridge) {
            Presence.GONE -> Status.WAITING
            Presence.STARTING -> Status.STARTING
            Presence.READY -> Status.LISTENING
        }

    /** What the screen says went wrong. Null while nothing has. */
    var error: String? = null
        private set

    /** 18.9 when the last rejoin was asked for. Null before the first. */
    private var rejoinedAt: Long? = null

    fun on(event: Event, now: Long): List<Effect> {
        when (event) {
            // 18.9 a rejoin keeps its own word until the room is back, so Chris does not read a rejoin as a drop
            Event.Opening -> {
                if (link != Status.REJOINING) link = Status.CONNECTING
                bridge = Presence.GONE
            }
            is Event.Connected -> {
                link = Status.LISTENING
                error = null
                // a `starting` that came during the join already said more than this
                if (!event.bridgeHere) bridge = Presence.GONE
                else if (bridge == Presence.GONE) bridge = Presence.READY
            }
            Event.Reconnecting -> link = Status.RECONNECTING
            Event.Reconnected -> link = Status.LISTENING
            // a new bridge process joins before its workers load, and says so at once
            Event.BridgeArrived -> if (bridge == Presence.GONE) bridge = Presence.STARTING
            Event.BridgeLeft -> bridge = Presence.GONE
            is Event.Starting -> bridge = if (event.on) Presence.STARTING else Presence.READY
            is Event.Ended -> return ended(event.reason, now)
            Event.RejoinAsked -> {
                // 18.9 a request inside REJOIN_MS of the last one is refused, so a phone that is simply silent cannot loop
                if (!rejoinDue(rejoinedAt, now)) return emptyList()
                rejoinedAt = now
                link = Status.REJOINING
                return listOf(Effect.End(REJOINING))
            }
            Event.SetupChanged -> {
                // 18.15 a push is one message from a script, not a silent phone, so the window of 18.9.4 does not hold it
                rejoinedAt = now
                link = Status.REJOINING
                return listOf(Effect.End(REJOINING))
            }
            // 17.11.10 a leave by hand is no fault and tries nothing again: the room is Chris's to come back to
            Event.Left -> {
                link = Status.LEFT
                error = null
                rejoinedAt = null
            }
            Event.Quit -> {
                link = Status.IDLE
                error = null
                rejoinedAt = null
            }
        }
        return emptyList()
    }

    /**
     * A refused pairing is the one end the app does not try again after:
     * nothing it can do alone makes a refusal into a room. Every other reason
     * waits and tries again, including the ones a bridge restart gives, so no
     * restart leaves the app sitting in a dead status (docs/todo.md item 7).
     */
    private fun ended(reason: String, now: Long): List<Effect> {
        if (reason == REJOINING) return listOf(Effect.Open(now))
        if (refused(reason)) {
            link = Status.IDLE
            error = "The bridge refused the saved pairing ($reason). Scan the code again."
            return listOf(Effect.Forget)
        }
        link = Status.UNREACHABLE
        error = "Cannot reach the bridge: $reason. Retrying."
        return listOf(Effect.Open(now + retryMs))
    }

    companion object {
        /** How long the app waits before it tries the bridge again. */
        const val RETRY_MS = 5_000L

        /** The reason a room gives when the bridge asked for a rejoin, which is no fault. */
        const val REJOINING = "rejoining"
    }
}
