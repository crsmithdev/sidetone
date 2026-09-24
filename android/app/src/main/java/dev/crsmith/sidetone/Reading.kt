package dev.crsmith.sidetone

/** 17.11.6 the colour of the dot in the status row. */
enum class Light { GREEN, AMBER, RED }

/** 17.11.6 the ring of the dot: the connection quality, thin when poor. */
enum class Ring { THICK, MEDIUM, THIN }

/**
 * 17.11.6 what the status row says about the room: the colour of the dot, the
 * status word, the ring and the working sign. The row shows [word] beside the
 * dot (17.11.7), and the notification starts with it (17.16). [ring] is null
 * and [sign] is [Sign.OFF] when they do not show.
 */
data class Reading(val light: Light, val word: String, val ring: Ring?, val sign: Sign)

/** LiveKit's word for a participant whose media no longer reaches the server. */
private const val LOST = "lost"

/**
 * 17.11.6 one reading of the room, so the row cannot show a live room and
 * "no signal", or "reconnecting" and a thick ring, at once. The ring and the
 * sign are readings of a live room: a quality from before a drop is old, and
 * "stalled" blames the bridge, which is true only while the link is up.
 *
 * The room is live when the transport has it and the phone's own quality is
 * not [LOST]. A lost quality says the link is down while the transport still
 * holds the room, so the word says that and nothing else shows.
 */
fun reading(status: Status, quality: String?, sign: Sign): Reading {
    if (status == Status.LISTENING && quality != LOST) return Reading(Light.GREEN, "listening", ring(quality), sign)
    return when (status) {
        Status.IDLE, Status.CONNECTING -> Reading(Light.AMBER, "connecting", null, Sign.OFF)
        Status.LISTENING -> Reading(Light.AMBER, "signal lost", null, Sign.OFF)
        Status.RECONNECTING -> Reading(Light.AMBER, "reconnecting", null, Sign.OFF)
        // 18.9 a rejoin shows in the light, not in a note
        Status.REJOINING -> Reading(Light.AMBER, "rejoining", null, Sign.OFF)
        Status.UNREACHABLE -> Reading(Light.RED, "disconnected", null, Sign.OFF)
    }
}

/**
 * 17.11.9 the legend of the light: each word the row can show and what it
 * means, in the order a room goes through them. The readings come from
 * [reading], so a test can check that no state is missing.
 */
val LEGEND: List<Pair<Reading, String>> = listOf(
    reading(Status.CONNECTING, null, Sign.OFF) to "The app joins the room.",
    reading(Status.LISTENING, null, Sign.OFF) to "The room is live. The bridge hears you.",
    reading(Status.REJOINING, null, Sign.OFF) to "The bridge heard no sound from the microphone, so the app joins again.",
    reading(Status.RECONNECTING, null, Sign.OFF) to "The link dropped. The app tries to get it back.",
    reading(Status.LISTENING, LOST, Sign.OFF) to "The room is open, but the sound of the phone does not reach it.",
    reading(Status.UNREACHABLE, null, Sign.OFF) to "The app cannot reach the bridge. It tries again every ${Joining.RETRY_MS / 1000} seconds.",
)

/** LiveKit's quality as the ring. A quality not known yet draws no ring. */
private fun ring(quality: String?): Ring? = when (quality) {
    "excellent" -> Ring.THICK
    "good" -> Ring.MEDIUM
    "poor" -> Ring.THIN
    else -> null
}
