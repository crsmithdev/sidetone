package dev.crsmith.sidetone

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.math.BigInteger

class ReceivedTest {
    /** Item 56 WebRTC gives a uint64 as a BigInteger, a uint32 as a Long and a double as a Double. */
    @Test
    fun readsTheAudioInboundRtpAndItsCodec() {
        val report = mapOf(
            "T01" to Received.Stat("transport", mapOf("bytesReceived" to BigInteger.valueOf(9))),
            "IT01V" to Received.Stat("inbound-rtp", mapOf("kind" to "video", "packetsReceived" to 7L)),
            "IT01A" to Received.Stat("inbound-rtp", mapOf(
                "kind" to "audio", "codecId" to "CIT01_111", "packetsReceived" to 250L, "packetsLost" to 3,
                "totalSamplesReceived" to BigInteger.valueOf(240_000), "concealedSamples" to BigInteger.valueOf(4_800),
                "concealmentEvents" to BigInteger.valueOf(2), "insertedSamplesForDeceleration" to BigInteger.ZERO,
                "removedSamplesForAcceleration" to BigInteger.valueOf(480), "jitterBufferDelay" to 14_880.0,
                "jitterBufferEmittedCount" to BigInteger.valueOf(240_000),
            )),
            "CIT01_111" to Received.Stat("codec", mapOf("mimeType" to "audio/opus")),
        )
        val got = Received.of(report)!!
        assertEquals(Received(250, 3, 240_000, 4_800, 2, 0, 480, 14_880.0, 240_000, "audio/opus"), got)
        assertEquals(62, got.bufferMs)
    }

    @Test
    fun noAudioYetIsNoReading() {
        assertNull(Received.of(mapOf("T01" to Received.Stat("transport", emptyMap()))))
    }
}
