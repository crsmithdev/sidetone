package dev.crsmith.sidetone

/**
 * 17.11 how long the app trusts a `working` message: three heartbeats of the
 * bridge (14.10.2). The app has no settings file, so this is a constant.
 */
const val WORKING_STALE_MS = 15_000L

/** What the working sign shows. */
enum class Sign { OFF, WORKING, SILENT }

/**
 * 17.11 the sign, given what the bridge last said and when. `at` and `now` are
 * on the same clock, in milliseconds. "On" that is older than [WORKING_STALE_MS]
 * is [Sign.SILENT]: the bridge said it works and has stopped saying so, which
 * is what a bridge that is stuck looks like from here.
 */
fun sign(on: Boolean, at: Long, now: Long): Sign = when {
    !on -> Sign.OFF
    now - at > WORKING_STALE_MS -> Sign.SILENT
    else -> Sign.WORKING
}

/** 17.11 the words of the sign. The screen and the screen log (17.12) both use them. */
fun signWord(sign: Sign): String = when (sign) {
    Sign.OFF -> ""
    Sign.WORKING -> "working"
    Sign.SILENT -> "stalled"
}

/**
 * 17.11.6 the sign that shows beside the status word. Outside a live room no
 * message can come, so the status word says why and the sign shows nothing.
 * In a live room the link is up, so "stalled" can only be the bridge.
 */
fun shownSign(status: Status, sign: Sign): Sign =
    if (status == Status.LISTENING) sign else Sign.OFF
