package dev.crsmith.sidetone

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Base64

class ScreenshotTest {
    private fun parse(part: ByteArray): JsonObject = Json.parseToJsonElement(part.decodeToString()).jsonObject

    /** Bytes of every value, as a JPEG has. */
    private val image = ByteArray(200_000) { (it * 7).toByte() }

    @Test
    fun theImageGoesToTheBridgeInPartsThatFitOneMessage() {
        val parts = screenshotParts(image, "1758472812345")
        assertTrue(parts.size > 1)
        for (part in parts) assertTrue("a part of ${part.size} bytes", part.size <= SCREENSHOT_PART_BYTES)
        val messages = parts.map(::parse)
        assertEquals(parts.indices.map { it + 1 }, messages.map { it["part"]!!.jsonPrimitive.int })
        for (message in messages) {
            assertEquals("screenshot", message["kind"]!!.jsonPrimitive.content)
            assertEquals("1758472812345", message["id"]!!.jsonPrimitive.content)
            assertEquals(parts.size, message["of"]!!.jsonPrimitive.int)
        }
        // in order, none lost, none twice
        val data = messages.joinToString("") { it["data"]!!.jsonPrimitive.content }
        assertArrayEquals(image, Base64.getDecoder().decode(data))
    }

    @Test
    fun eachPartDecodesAlone() {
        for (part in screenshotParts(image, "1")) {
            val data = parse(part)["data"]!!.jsonPrimitive.content
            assertEquals(0, data.length % 4)
            Base64.getDecoder().decode(data)
        }
    }

    @Test
    fun aPartIsFullBeforeTheNextStarts() {
        // base64 grows the image by a third, and the parts use the room they have
        val parts = screenshotParts(image, "1")
        val base64 = (image.size + 2) / 3 * 4
        val per = parts.first().let { parse(it)["data"]!!.jsonPrimitive.content.length }
        assertEquals((base64 + per - 1) / per, parts.size)
        assertTrue("a part holds $per characters", per > SCREENSHOT_PART_BYTES - 200)
    }

    @Test
    fun anImageWithNothingInItIsOnePartWithNoData() {
        val message = parse(screenshotParts(ByteArray(0), "1").single())
        assertEquals(1, message["part"]!!.jsonPrimitive.int)
        assertEquals(1, message["of"]!!.jsonPrimitive.int)
        assertEquals("", message["data"]!!.jsonPrimitive.content)
    }

    @Test
    fun theLongestEdgeComesDownToTheLimitAndTheShapeStays() {
        assertEquals(486 to 1_080, fitted(1_080, 2_400))
        assertEquals(1_080 to 486, fitted(2_400, 1_080))
        assertEquals(1_080 to 1_080, fitted(1_440, 1_440))
    }

    @Test
    fun aSmallImageKeepsItsSize() {
        assertEquals(720 to 1_080, fitted(720, 1_080))
        assertEquals(300 to 200, fitted(300, 200))
    }
}
