package dev.crsmith.sidetone

/**
 * Item 56 what the phone received of the bridge's voice: the inbound-rtp
 * counters of the audio track, as WebRTC keeps them from the start of the
 * track. A sentence Chris calls garbled is matched to the concealment at that
 * time, and the codec says whether RED is on.
 */
data class Received(
    val packets: Long,
    val lost: Long,
    /** samples played out, concealed ones included */
    val samples: Long,
    val concealed: Long,
    val events: Long,
    /** samples the jitter buffer added to slow the play out, and took out to speed it up */
    val inserted: Long,
    val removed: Long,
    /** seconds, summed over each sample the jitter buffer emitted */
    val bufferDelay: Double,
    val emitted: Long,
    val codec: String?,
) {
    /** What arrived since `before`. The codec is the one in use now. */
    operator fun minus(before: Received) = Received(
        packets - before.packets, lost - before.lost, samples - before.samples,
        concealed - before.concealed, events - before.events,
        inserted - before.inserted, removed - before.removed,
        bufferDelay - before.bufferDelay, emitted - before.emitted, codec,
    )

    /** The mean time a sample waited in the jitter buffer, in milliseconds. */
    val bufferMs: Long get() = if (emitted <= 0) 0 else Math.round(bufferDelay / emitted * 1_000)

    /** One entry of a WebRTC stats report: its type and its members. */
    class Stat(val type: String, val members: Map<String, Any?>)

    companion object {
        /** The first audio inbound-rtp in a report of the subscriber's connection, or null before one arrives. */
        fun of(report: Map<String, Stat>): Received? {
            val rtp = report.values.firstOrNull { it.type == "inbound-rtp" && it.members["kind"] == "audio" }?.members ?: return null
            fun count(name: String) = (rtp[name] as? Number)?.toLong() ?: 0
            val codec = report[rtp["codecId"] as? String]?.members?.get("mimeType") as? String
            return Received(
                count("packetsReceived"), count("packetsLost"), count("totalSamplesReceived"),
                count("concealedSamples"), count("concealmentEvents"),
                count("insertedSamplesForDeceleration"), count("removedSamplesForAcceleration"),
                (rtp["jitterBufferDelay"] as? Number)?.toDouble() ?: 0.0, count("jitterBufferEmittedCount"), codec,
            )
        }
    }
}
