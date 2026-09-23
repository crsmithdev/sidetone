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
 * So the statuses and the decision live here, and they are an event in and a
 * status plus a [Next] out. `Bridge` keeps the room and does what [Next] says.
 */
class Joining(private val retryMs: Long = RETRY_MS) {
    /** What the app does after a room ends. */
    sealed interface Next {
        /** Open a room again now. */
        data object Open : Next

        /** Wait, then open a room again. The wait is the only thing between two tries. */
        data class WaitThenOpen(val ms: Long) : Next

        /** The bridge refused the saved pairing. Forget it, stop, and show [Joining.error]. */
        data object Forget : Next
    }

    var status: Status = Status.IDLE
        private set

    /** What the screen says went wrong. Null while nothing has. */
    var error: String? = null
        private set

    /** 18.9 when the last rejoin was asked for, on the elapsed clock. Null before the first. */
    private var rejoinedAt: Long? = null

    /**
     * A room is about to open. 18.9 a rejoin keeps its own word in the status
     * light until the room is back, so Chris does not read a rejoin as a drop.
     */
    fun opening() {
        if (status != Status.REJOINING) status = Status.CONNECTING
    }

    /** The room is up and messages can come. */
    fun open() {
        status = Status.LISTENING
        error = null
    }

    /** The transport lost the room and is getting it back by itself. */
    fun reconnecting() {
        status = Status.RECONNECTING
    }

    /** The transport has the room back. */
    fun reconnected() {
        status = Status.LISTENING
    }

    /**
     * 18.9 the bridge hears no sound from the microphone track, and only the
     * app can publish a new one. True when the app should end the room, which
     * makes it join again. A request inside [REJOIN_MS] of the last one is
     * refused, so a phone that is simply silent cannot loop.
     */
    fun rejoinAsked(now: Long): Boolean {
        if (!rejoinDue(rejoinedAt, now)) return false
        rejoinedAt = now
        status = Status.REJOINING
        return true
    }

    /**
     * The room ended, for the reason the transport gave. A refused pairing is
     * the one end the app does not try again after: nothing it can do alone
     * makes a refusal into a room. Every other reason waits and tries again,
     * including the ones a bridge restart gives, so no restart leaves the app
     * sitting in a dead status (docs/todo.md item 7).
     */
    fun ended(reason: String): Next {
        if (reason == REJOINING) return Next.Open
        if (refused(reason)) {
            status = Status.IDLE
            error = "The bridge refused the saved pairing ($reason). Scan the code again."
            return Next.Forget
        }
        status = Status.UNREACHABLE
        error = "Cannot reach the bridge: $reason. Retrying."
        return Next.WaitThenOpen(retryMs)
    }

    /** The conversation ended by hand: nothing is open and nothing is wrong. */
    fun left() {
        status = Status.IDLE
        error = null
        rejoinedAt = null
    }

    companion object {
        /** How long the app waits before it tries the bridge again. */
        const val RETRY_MS = 5_000L

        /** The reason a room gives when the bridge asked for a rejoin, which is no fault. */
        const val REJOINING = "rejoining"
    }
}
