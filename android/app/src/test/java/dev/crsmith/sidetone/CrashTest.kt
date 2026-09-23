package dev.crsmith.sidetone

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.file.Files

class CrashTest {
    private fun parse(message: ByteArray): JsonObject = Json.parseToJsonElement(message.decodeToString()).jsonObject

    private val error = IllegalStateException("the microphone was not published")

    @Test
    fun theReportHoldsTheTimeTheThreadTheTraceAndTheState() {
        val report = crashReport(1_758_621_600_000, "main", "State(status=LIVE)", error)
        assertTrue(report, report.startsWith("time: 2025-09-23T10:00:00Z\nthread: main\n\njava.lang.IllegalStateException: the microphone was not published\n\tat dev.crsmith.sidetone.CrashTest"))
        assertTrue(report, report.endsWith("state: State(status=LIVE)\n"))
    }

    @Test
    fun theStateGivesTheNumberOfLinesAndNotTheirWords() {
        val state = Bridge.State(micOn = false, lines = listOf(Line(Line.Kind.YOU, "a secret"), Line(Line.Kind.BRIDGE, "another")))
        val said = crashState(state)
        assertTrue(said, said.contains("micOn=false"))
        assertTrue(said, said.contains("lines=2"))
        assertTrue(said, !said.contains("secret"))
    }

    @Test
    fun aShortReportGoesWhole() {
        val message = parse(crashMessage("1758621600000", "a short report"))
        assertEquals("crash", message["kind"]!!.jsonPrimitive.content)
        assertEquals("1758621600000", message["id"]!!.jsonPrimitive.content)
        assertEquals("a short report", message["text"]!!.jsonPrimitive.content)
    }

    @Test
    fun aLongReportKeepsItsStartFitsOneMessageAndSaysItWasCut() {
        // quotes and tabs take two bytes each in JSON, so the cut must count the message and not the text
        val text = "time: now\n" + "\t\"at\" a.b.c(D.kt:1)\n".repeat(2_000)
        val message = crashMessage("a", text)
        assertTrue("${message.size} bytes", message.size <= CRASH_MESSAGE_BYTES)
        val kept = parse(message)["text"]!!.jsonPrimitive.content
        assertTrue(kept.startsWith("time: now\n"))
        assertTrue(kept.endsWith("\n[cut]\n"))
    }

    @Test
    fun anUncaughtErrorWritesAReportAndThenReachesTheHandlerBefore() {
        val dir = Files.createTempDirectory("crashes").toFile()
        val before = Thread.getDefaultUncaughtExceptionHandler()
        var passed: Throwable? = null
        try {
            Thread.setDefaultUncaughtExceptionHandler { _, e -> passed = e }
            val crashes = Crashes(dir)
            crashes.catchAll { "State(status=LIVE)" }
            val thread = Thread { throw error }
            thread.name = "worker"
            thread.start()
            thread.join()
            assertEquals(error, passed)
            val files = crashes.unsent()
            assertEquals(1, files.size)
            val report = files[0].readText()
            assertTrue(report, report.contains("thread: worker"))
            assertTrue(report, report.contains("the microphone was not published"))
            assertTrue(report, report.contains("state: State(status=LIVE)"))
        } finally {
            Thread.setDefaultUncaughtExceptionHandler(before)
        }
    }

    @Test
    fun theUnsentReportsComeOldestFirst() {
        val dir = Files.createTempDirectory("crashes").toFile()
        val crashes = Crashes(dir)
        crashes.save(1_758_621_600_002, "main", "", error)
        crashes.save(1_758_621_600_001, "main", "", error)
        assertEquals(listOf("1758621600001", "1758621600002"), crashes.unsent().map { it.nameWithoutExtension })
    }

    @Test
    fun noDirectoryIsNoReport() {
        assertEquals(emptyList<Any>(), Crashes(Files.createTempDirectory("crashes").toFile().resolve("none")).unsent())
    }
}
