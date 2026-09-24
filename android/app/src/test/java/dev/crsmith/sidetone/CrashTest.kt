package dev.crsmith.sidetone

import android.app.ApplicationExitInfo
import kotlinx.coroutines.CoroutineExceptionHandler
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
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

    private fun exit(at: Long, reason: Int = ApplicationExitInfo.REASON_ANR, trace: ByteArray? = null) =
        Exit(at, reason, "user request after error: Input dispatching timed out", 0, 100, 81_000, 190_000, trace)

    @Test
    fun anExitRecordGivesItsTimeReasonAndMemoryAndThenItsTrace() {
        val report = exitReport(exit(1_758_621_600_000, trace = "----- pid 4242 at 2025-09-23 10:00:00 -----\n\"main\" prio=5 tid=1 Blocked\n".encodeToByteArray()))
        assertEquals(
            "time: 2025-09-23T10:00:00Z\nexit: anr\ndescription: user request after error: Input dispatching timed out\n" +
                "status: 0\nimportance: 100\nmemory: pss 81000 kB, rss 190000 kB\n\n" +
                "----- pid 4242 at 2025-09-23 10:00:00 -----\n\"main\" prio=5 tid=1 Blocked\n",
            report,
        )
    }

    @Test
    fun aNativeCrashGivesTheReadableRunsOfItsTombstone() {
        // the tombstone is protobuf: the names in the backtrace are the only words in it
        val tombstone = byteArrayOf(0x0a, 0x05) + "abort".encodeToByteArray() + byteArrayOf(0x12, 0x01, 0x00, 0x1a) +
            "libwebrtc.so".encodeToByteArray() + byteArrayOf(0x12, 0x02) + "ab".encodeToByteArray()
        val report = exitReport(exit(1_758_621_600_000, ApplicationExitInfo.REASON_CRASH_NATIVE, tombstone))
        assertTrue(report, report.contains("exit: crash native\n"))
        assertTrue(report, report.endsWith("\n\nthe readable runs of the tombstone:\nabort\nlibwebrtc.so\n"))
    }

    @Test
    fun anExitWithNoTraceSaysNoneForWhatItLacks() {
        val report = exitReport(Exit(1_758_621_600_000, ApplicationExitInfo.REASON_LOW_MEMORY, null, 9, 125, 0, 0, null))
        assertTrue(report, report.contains("exit: low memory\ndescription: none\n"))
        assertTrue(report, report.endsWith("memory: pss 0 kB, rss 0 kB\n"))
    }

    @Test
    fun eachExitIsWrittenOnceOldestFirstAndNotAgainAfterItWent() {
        val dir = Files.createTempDirectory("crashes").toFile()
        val crashes = Crashes(dir)
        crashes.saveExits(listOf(exit(1_758_621_600_002), exit(1_758_621_600_001)))
        assertEquals(listOf("1758621600001-exit", "1758621600002-exit"), crashes.unsent().map { it.nameWithoutExtension })
        // 17.20.2 a sent report is deleted; the system still lists the record at the next launch
        crashes.unsent().forEach { it.delete() }
        crashes.saveExits(listOf(exit(1_758_621_600_003), exit(1_758_621_600_002), exit(1_758_621_600_001)))
        assertEquals(listOf("1758621600003-exit"), crashes.unsent().map { it.nameWithoutExtension })
        crashes.saveExits(listOf(exit(1_758_621_600_003)))
        assertEquals(1, crashes.unsent().size)
    }

    @Test
    fun anExitReportIsAMessageTheBridgeReads() {
        // 14.14.1 the bridge takes an id of letters, digits and hyphens, up to 64 (src/crash.ts)
        val id = "1758621600000-exit"
        assertTrue(Regex("^[A-Za-z0-9-]{1,64}$").matches(id))
        val message = parse(crashMessage(id, exitReport(exit(1_758_621_600_000))))
        assertEquals("crash", message["kind"]!!.jsonPrimitive.content)
        assertEquals(id, message["id"]!!.jsonPrimitive.content)
        assertTrue(message["text"]!!.jsonPrimitive.content.startsWith("time: 2025-09-23T10:00:00Z\nexit: anr\n"))
    }

    @Test
    fun aCaughtErrorWritesAReportThatSaysTheAppWentOn() {
        val crashes = Crashes(Files.createTempDirectory("crashes").toFile())
        crashes.caught("a message", "State(status=LIVE)", error)
        val report = crashes.unsent().single().readText()
        assertTrue(report, report.contains("thread: ${Thread.currentThread().name}, a message; the app went on\n"))
        assertTrue(report, report.contains("the microphone was not published"))
        assertTrue(report, report.endsWith("state: State(status=LIVE)\n"))
    }

    @Test
    fun aReportThatCannotBeWrittenIsLostAndNotThrown() {
        val file = Files.createTempFile("crashes", "").toFile()
        Crashes(file.resolve("under-a-file")).caught("a message", "", error)
    }

    @Test
    fun anErrorInALaunchedCoroutineIsWrittenDownAndTheScopeGoesOn() = runBlocking {
        val crashes = Crashes(Files.createTempDirectory("crashes").toFile())
        // the wiring of Bridge.scope, with a pool thread for the main one
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default + CoroutineExceptionHandler { _, e -> crashes.caught("a coroutine", "", e) })
        scope.launch { throw error }.join()
        assertTrue(crashes.unsent().single().readText().contains("a coroutine; the app went on"))
        assertEquals(2, scope.async { 1 + 1 }.await())
    }
}
