package dev.crsmith.sidetone

/**
 * 17.11.6 the colour of the dot in the status row: whether the bridge hears
 * Chris. GREEN it hears him; AMBER not now, and the app gets it back; RED not
 * now, and nothing fixes it; GREY 17.11.10 out of the room by hand.
 */
enum class Light { GREEN, AMBER, RED, GREY }

/**
 * 17.11.6 what the status row says about the room: the colour of the dot, the
 * status word, and whether the dot pulses. The row shows [word] beside the dot
 * (17.11.7), and the notification starts with it (17.16). A pulse is work in
 * progress: by the agent on a green dot, by the app on an amber or red one.
 */
data class Reading(val light: Light, val word: String, val pulse: Boolean) {
    /** 17.11.2 the agent works. The notification adds "working" for it (17.16.1). */
    val working: Boolean get() = light == Light.GREEN && pulse
}

/** LiveKit's word for a participant whose media no longer reaches the server. */
private const val LOST = "lost"

/**
 * 17.11.6 one reading of the room, so the row cannot show a live room and
 * "no signal", or "reconnecting" and a working agent, at once. The sign is a
 * reading of a live room: "stalled" blames the bridge, which is true only
 * while the link is up.
 *
 * The room is live when the transport has it and the phone's own quality is
 * not [LOST]. A lost quality says the link is down while the transport still
 * holds the room, so the word says that and nothing else shows.
 */
fun reading(status: Status, quality: String?, sign: Sign): Reading = when (status) {
    Status.LISTENING -> when {
        quality == LOST -> Reading(Light.RED, "signal lost", pulse = false)
        // 17.11.3 no heartbeat for 15 s: the bridge probably does not hear Chris
        sign == Sign.SILENT -> Reading(Light.RED, signWord(Sign.SILENT), pulse = false)
        else -> Reading(Light.GREEN, "listening", pulse = sign == Sign.WORKING)
    }
    Status.IDLE, Status.CONNECTING -> Reading(Light.AMBER, "connecting", pulse = true)
    Status.RECONNECTING -> Reading(Light.AMBER, "reconnecting", pulse = true)
    // 17.11.11 the phone is in the room and the bridge is not, as during a restart: the bridge is gone, not stuck
    Status.WAITING -> Reading(Light.AMBER, "waiting", pulse = true)
    // 14.16 the bridge is back and loads its speech workers, about 20 seconds from cold
    Status.STARTING -> Reading(Light.AMBER, "starting", pulse = true)
    // 18.9 a rejoin shows in the light, not in a note
    Status.REJOINING -> Reading(Light.AMBER, "rejoining", pulse = true)
    // the app tries again every Joining.RETRY_MS, which is work in progress
    Status.UNREACHABLE -> Reading(Light.RED, "disconnected", pulse = true)
    // 17.11.10 nothing is wrong and nothing is tried, so neither amber nor red says it
    Status.LEFT -> Reading(Light.GREY, "left", pulse = false)
}

/**
 * 17.11.9 one row of the legend: a colour, what it means to Chris, a line
 * under that if it needs one, and the readings of that colour. A reading can
 * have its own line, when its word asks something else of Chris.
 */
data class LegendRow(val means: String, val detail: String?, val readings: List<Pair<Reading, String?>>) {
    val light: Light get() = readings.first().first.light

    /** The words of the row, in order, each once. */
    val words: List<String> get() = readings.map { it.first.word }.distinct()

    /** The dots the row draws: solid, then pulsing, each once. */
    val pulses: List<Boolean> get() = readings.map { it.first.pulse }.distinct().sorted()
}

/**
 * 17.11.9 the legend of the light: one row for each colour, in the order
 * green, amber, red, grey. The readings come from [reading], so a test can
 * check that no state is missing.
 */
val LEGEND: List<LegendRow> = listOf(
    LegendRow(
        "It hears you.",
        null,
        listOf(reading(Status.LISTENING, null, Sign.OFF) to null, reading(Status.LISTENING, null, Sign.WORKING) to null),
    ),
    LegendRow(
        "Not now. The app is getting it back.",
        null,
        listOf(
            reading(Status.CONNECTING, null, Sign.OFF) to null,
            reading(Status.REJOINING, null, Sign.OFF) to null,
            reading(Status.RECONNECTING, null, Sign.OFF) to null,
            reading(Status.WAITING, null, Sign.OFF) to null,
            reading(Status.STARTING, null, Sign.OFF) to null,
        ),
    ),
    LegendRow(
        "Not now, and nothing is fixing it.",
        null,
        listOf(
            reading(Status.UNREACHABLE, null, Sign.OFF) to
                "the app cannot reach the bridge. It tries again every ${Joining.RETRY_MS / 1000} seconds.",
            reading(Status.LISTENING, LOST, Sign.OFF) to "the phone's network does not carry its sound. Wait for coverage.",
            reading(Status.LISTENING, null, Sign.SILENT) to "the bridge stopped reporting. Look at it when you stop.",
        ),
    ),
    LegendRow(
        "You left.",
        "The bridge carries on. Tap Rejoin to go back in.",
        listOf(reading(Status.LEFT, null, Sign.OFF) to null),
    ),
)
