package dev.crsmith.sidetone

/**
 * 17.11 what the app can say about the room. REJOINING: 18.9 the bridge asked
 * for a new microphone track, and the app is joining again.
 */
enum class Status { IDLE, CONNECTING, LISTENING, RECONNECTING, REJOINING, UNREACHABLE }

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

        /** The room is up and messages can come. */
        data object Connected : Event

        /** The transport lost the room and is getting it back by itself. */
        data object Reconnecting : Event

        /** The transport has the room back. */
        data object Reconnected : Event

        /** The room ended, or never opened, for the reason the transport gave. */
        data class Ended(val reason: String) : Event

        /** 18.9 the bridge hears no sound from the microphone track and asks for a new one. */
        data object RejoinAsked : Event

        /** The conversation ended by hand. */
        data object Left : Event
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

    var status: Status = Status.IDLE
        private set

    /** What the screen says went wrong. Null while nothing has. */
    var error: String? = null
        private set

    /** 18.9 when the last rejoin was asked for. Null before the first. */
    private var rejoinedAt: Long? = null

    fun on(event: Event, now: Long): List<Effect> {
        when (event) {
            // 18.9 a rejoin keeps its own word until the room is back, so Chris does not read a rejoin as a drop
            Event.Opening -> if (status != Status.REJOINING) status = Status.CONNECTING
            Event.Connected -> {
                status = Status.LISTENING
                error = null
            }
            Event.Reconnecting -> status = Status.RECONNECTING
            Event.Reconnected -> status = Status.LISTENING
            is Event.Ended -> return ended(event.reason, now)
            Event.RejoinAsked -> {
                // 18.9 a request inside REJOIN_MS of the last one is refused, so a phone that is simply silent cannot loop
                if (!rejoinDue(rejoinedAt, now)) return emptyList()
                rejoinedAt = now
                status = Status.REJOINING
                return listOf(Effect.End(REJOINING))
            }
            Event.Left -> {
                status = Status.IDLE
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
            status = Status.IDLE
            error = "The bridge refused the saved pairing ($reason). Scan the code again."
            return listOf(Effect.Forget)
        }
        status = Status.UNREACHABLE
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
