package dev.crsmith.sidetone

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.ZoneOffset

class ScreenLogTest {
    private fun shown(text: String, at: Long = 0) = Shown(at, "delta", 1, 1, 0, text, text)

    private fun texts(log: ScreenLog) = log.entries.map { it.text }

    @Test
    fun theOldestEntriesGoFirstWhenThereAreTooMany() {
        val log = ScreenLog(maxEntries = 3)
        for (n in 1..5) log.add(shown("t$n"))
        assertEquals(listOf("t3", "t4", "t5"), texts(log))
    }

    @Test
    fun theOldestEntriesGoFirstWhenThereIsTooMuchText_butTheNewestStays() {
        val log = ScreenLog(maxChars = 15)
        // each entry counts its text and what it got: 10 characters
        for (n in 1..3) log.add(shown("text$n"))
        assertEquals(listOf("text3"), texts(log))
        log.add(shown("x".repeat(500)))
        assertEquals(1, log.entries.size)
    }

    @Test
    fun aLongBubbleKeepsItsEndAndSaysHowMuchWentFromTheFront() {
        val log = ScreenLog()
        val long = (1..5_000).joinToString("") { (it % 10).toString() }
        log.record(0, "delta", 1, 1, "x", listOf(Line(Line.Kind.BRIDGE, "")), listOf(Line(Line.Kind.BRIDGE, long)))
        val entry = log.entries.single()
        assertEquals(SCREEN_MAX_TEXT, entry.text.length)
        assertEquals(long.takeLast(SCREEN_MAX_TEXT), entry.text)
        assertEquals(5_000 - SCREEN_MAX_TEXT, entry.from)
    }

    @Test
    fun anEntryIsOneLineOfJsonWithTheSameKeysEachTime() {
        val at = 1_758_472_812_345L // 2026-09-21 16:40:12.345 UTC
        val json = Shown(at, "sentence", 3, null, null, "Four.", "").toJson(ZoneOffset.UTC)
        assertEquals("16:40:12.345", json["time"]!!.jsonPrimitive.content)
        assertEquals(at, json["at"]!!.jsonPrimitive.content.toLong())
        assertEquals(JsonNull, json["bubble"])
        assertEquals(JsonNull, json["block"])
        assertEquals(3, json["answer"]!!.jsonPrimitive.int)
        assertEquals(listOf("at", "time", "kind", "answer", "block", "bubble", "got", "text"), json.keys.toList())
        assertEquals(listOf("at", "time", "kind", "answer", "block", "bubble", "got", "text", "from"), Shown(at, "delta", 1, 1, 0, "x", "y", 7).toJson().keys.toList())
    }

    private fun parse(part: ByteArray): JsonObject = Json.parseToJsonElement(part.decodeToString()).jsonObject

    @Test
    fun theLogGoesToTheBridgeInPartsThatFitOneMessage() {
        val entries = (1..300).map { shown("word $it " + "y".repeat(200), at = it.toLong()) }
        val parts = screenParts(entries, "1758472812345", zone = ZoneOffset.UTC)
        assertTrue(parts.size > 1)
        for (part in parts) assertTrue("a part of ${part.size} bytes", part.size <= SCREEN_PART_BYTES)
        val messages = parts.map(::parse)
        assertEquals(parts.indices.map { it + 1 }, messages.map { it["part"]!!.jsonPrimitive.int })
        for (message in messages) {
            assertEquals("screen", message["kind"]!!.jsonPrimitive.content)
            assertEquals("1758472812345", message["id"]!!.jsonPrimitive.content)
            assertEquals(parts.size, message["of"]!!.jsonPrimitive.int)
        }
        // in order, none lost, none twice
        val got = messages.flatMap { (it["entries"] as JsonArray).map { entry -> entry.jsonObject["at"]!!.jsonPrimitive.content.toLong() } }
        assertEquals((1..300).map { it.toLong() }, got)
    }

    @Test
    fun aLogWithNothingInItIsOnePartWithNoEntries() {
        val parts = screenParts(emptyList(), "1")
        assertEquals(1, parts.size)
        val message = parse(parts.single())
        assertEquals(1, message["part"]!!.jsonPrimitive.int)
        assertEquals(1, message["of"]!!.jsonPrimitive.int)
        assertEquals(0, message["entries"]!!.jsonArray.size)
    }

    @Test
    fun aLongGotKeepsItsEndToo() {
        // a turn's `got` is the whole answer, and an entry of that length made
        // a part larger than one data message, which the retry then repeated
        val log = ScreenLog()
        val answer = (1..9_000).joinToString("") { (it % 10).toString() }
        log.record(0, "turn", 1, null, answer, listOf(Line(Line.Kind.BRIDGE, "")), listOf(Line(Line.Kind.BRIDGE, "spoken")))
        val entry = log.entries.single()
        assertEquals(SCREEN_MAX_TEXT, entry.got!!.length)
        assertEquals(answer.takeLast(SCREEN_MAX_TEXT), entry.got)
        assertEquals(9_000 - SCREEN_MAX_TEXT, entry.gotFrom)
    }

    @Test
    fun anEntryOfAnyLengthStillFitsOnePart() {
        val log = ScreenLog()
        val long = (1..20_000).joinToString("") { (it % 10).toString() }
        log.record(0, "turn", 1, null, long, listOf(Line(Line.Kind.BRIDGE, "")), listOf(Line(Line.Kind.BRIDGE, long)))
        for (part in screenParts(log.entries, "1")) assertTrue("a part of ${part.size} bytes", part.size <= SCREEN_PART_BYTES)
    }

    @Test
    fun aPartCountsBytesAndNotCharacters() {
        // each of these characters is three bytes in UTF-8
        val entries = (1..100).map { shown("é".repeat(300) + "語".repeat(300), at = it.toLong()) }
        for (part in screenParts(entries, "1")) assertTrue("a part of ${part.size} bytes", part.size <= SCREEN_PART_BYTES)
    }

    @Test
    fun noEntryHasNoBubbleWhenNothingChanged() {
        val log = ScreenLog()
        val lines = listOf(Line(Line.Kind.BRIDGE, "Four.", 1))
        log.record(5, "sentence", 1, null, "Four.", lines, lines)
        assertNull(log.entries.single().bubble)
        assertEquals("", log.entries.single().text)
        assertEquals("Four.", log.entries.single().got)
    }
}
