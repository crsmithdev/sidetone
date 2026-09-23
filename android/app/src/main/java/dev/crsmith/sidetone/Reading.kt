package dev.crsmith.sidetone

/** 17.11.6 the dot in the status row. */
enum class Light { LIVE, REJOINING, OFF }

/**
 * 17.11.6 what the status row says about the room: the dot, the status word,
 * the connection quality and the working sign. [quality] is null and [sign] is
 * [Sign.OFF] when they do not show.
 */
data class Reading(val light: Light, val word: String, val quality: String?, val sign: Sign)

/** LiveKit's word for a participant whose media no longer reaches the server. */
private const val LOST = "lost"

/**
 * 17.11.6 one reading of the room, so the row cannot say "listening" and
 * "no signal", or "reconnecting" and "excellent", at once. The quality and the
 * sign are readings of a live room: a quality from before a drop is old, and
 * "stalled" blames the bridge, which is true only while the link is up.
 *
 * The room is live when the transport has it and the phone's own quality is
 * not [LOST]. A lost quality says the link is down while the transport still
 * holds the room, so the word says that and nothing else shows.
 */
fun reading(status: Status, quality: String?, sign: Sign): Reading {
    if (status == Status.LISTENING && quality != LOST) return Reading(Light.LIVE, "listening", quality ?: "—", sign)
    val word = when (status) {
        Status.IDLE, Status.CONNECTING -> "connecting"
        Status.LISTENING -> "signal lost"
        Status.RECONNECTING -> "reconnecting"
        Status.REJOINING -> "rejoining"
        Status.UNREACHABLE -> "disconnected"
    }
    // 18.9 a rejoin shows in the light, not in a note
    return Reading(if (status == Status.REJOINING) Light.REJOINING else Light.OFF, word, null, Sign.OFF)
}
