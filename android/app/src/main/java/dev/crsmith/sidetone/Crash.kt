package dev.crsmith.sidetone

import android.app.ApplicationExitInfo
import java.io.File
import java.io.PrintWriter
import java.io.StringWriter
import java.time.Instant

/** 14.14.1 the most bytes of one crash message. It fits one data message, as a part of a screenshot does. */
const val CRASH_MESSAGE_BYTES = 12_000

/** 17.20.5 the most bytes of an exit trace that are read. An ANR dump can be megabytes, and one message keeps its start only. */
const val TRACE_BYTES = 256_000

/**
 * 17.20 the crash reports the app wrote and has not sent. One file holds one
 * report, and its name is the time of the crash in milliseconds.
 */
class Crashes(private val dir: File) {
    /**
     * Write a report for each uncaught error, then pass the error to the handler
     * that was there before, which ends the process. A report that cannot be
     * written is lost: the crash goes on.
     */
    fun catchAll(state: () -> String) {
        val next = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, error ->
            try {
                save(System.currentTimeMillis(), thread.name, state(), error)
            } catch (_: Throwable) {
            }
            next?.uncaughtException(thread, error)
        }
    }

    fun save(at: Long, thread: String, state: String, error: Throwable) {
        dir.mkdirs()
        File(dir, "$at.txt").writeText(crashReport(at, thread, state, error))
    }

    /**
     * 17.20.4 an error the app caught and lived through. `what` says where it
     * was caught. A report that cannot be written is lost: the app goes on.
     */
    fun caught(what: String, state: String, error: Throwable) {
        try {
            save(System.currentTimeMillis(), "${Thread.currentThread().name}, $what; the app went on", state, error)
        } catch (_: Throwable) {
        }
    }

    /**
     * 17.20.5 write a report for each exit newer than the newest one written
     * before, and remember the newest. The system lists the same exits at each
     * launch, and a sent report is deleted, so the mark and not the files says
     * what went. A report is written under another name and then renamed, so a
     * send that runs at the same time does not read half of it.
     */
    fun saveExits(exits: List<Exit>) {
        val seen = File(dir, "exits-seen")
        val after = if (seen.exists()) seen.readText().trim().toLongOrNull() ?: 0 else 0
        val new = exits.filter { it.at > after }.sortedBy { it.at }
        if (new.isEmpty()) return
        dir.mkdirs()
        for (exit in new) {
            val part = File(dir, "${exit.at}-exit.part")
            part.writeText(exitReport(exit))
            part.renameTo(File(dir, "${exit.at}-exit.txt"))
        }
        seen.writeText(new.last().at.toString())
    }

    /** The reports not sent yet, oldest first. */
    fun unsent(): List<File> = dir.listFiles { file -> file.extension == "txt" }?.sortedBy { it.name }.orEmpty()
}

/** 17.20.1 the time, the thread, the stack trace and the app state, in that order, so a cut keeps the trace. */
fun crashReport(at: Long, thread: String, state: String, error: Throwable): String {
    val trace = StringWriter().also { error.printStackTrace(PrintWriter(it)) }.toString()
    return "time: ${Instant.ofEpochMilli(at)}\nthread: $thread\n\n$trace\nstate: $state\n"
}

/** 17.20.1 the app state without the lines, which the screen log already holds. */
fun crashState(state: Bridge.State): String =
    state.copy(lines = emptyList()).toString().replace("lines=[]", "lines=${state.lines.size}")

/** 14.14.1 one report as one message. A report too long for it loses its end, and says so. */
fun crashMessage(id: String, text: String, limit: Int = CRASH_MESSAGE_BYTES): ByteArray {
    var kept = text
    while (true) {
        val message = Outgoing.crash(id, if (kept.length < text.length) "$kept\n[cut]\n" else kept)
        if (message.size <= limit) return message
        kept = kept.take(kept.length * 9 / 10)
    }
}

/** 17.20.5 one death as the system kept it (`ApplicationExitInfo`), with the start of its trace. */
class Exit(
    val at: Long,
    val reason: Int,
    val description: String?,
    val status: Int,
    val importance: Int,
    val pss: Long,
    val rss: Long,
    val trace: ByteArray?,
)

/**
 * 17.20.5 the time, the reason, what the system said, the memory and then the
 * trace, so a cut keeps what the system said. An ANR trace is the text of the
 * thread dump. A native crash gives a tombstone in protobuf, of which only the
 * readable runs are kept: the names of the frames and the libraries.
 */
fun exitReport(exit: Exit): String {
    val head = "time: ${Instant.ofEpochMilli(exit.at)}\nexit: ${exitReason(exit.reason)}\ndescription: ${exit.description ?: "none"}\n" +
        "status: ${exit.status}\nimportance: ${exit.importance}\nmemory: pss ${exit.pss} kB, rss ${exit.rss} kB\n"
    val trace = exit.trace ?: return head
    if (exit.reason != ApplicationExitInfo.REASON_CRASH_NATIVE) return "$head\n${trace.decodeToString()}"
    return "$head\nthe readable runs of the tombstone:\n" + readableRuns(trace).joinToString("") { "$it\n" }
}

/** Runs of four or more printable ASCII characters, as `strings` gives them. */
private fun readableRuns(bytes: ByteArray): List<String> =
    Regex("[\\x20-\\x7e]{4,}").findAll(String(bytes, Charsets.ISO_8859_1)).map { it.value }.toList()

private fun exitReason(reason: Int): String = when (reason) {
    ApplicationExitInfo.REASON_EXIT_SELF -> "exit self"
    ApplicationExitInfo.REASON_SIGNALED -> "signaled"
    ApplicationExitInfo.REASON_LOW_MEMORY -> "low memory"
    ApplicationExitInfo.REASON_CRASH -> "crash"
    ApplicationExitInfo.REASON_CRASH_NATIVE -> "crash native"
    ApplicationExitInfo.REASON_ANR -> "anr"
    ApplicationExitInfo.REASON_INITIALIZATION_FAILURE -> "initialization failure"
    ApplicationExitInfo.REASON_PERMISSION_CHANGE -> "permission change"
    ApplicationExitInfo.REASON_EXCESSIVE_RESOURCE_USAGE -> "excessive resource usage"
    ApplicationExitInfo.REASON_USER_REQUESTED -> "user requested"
    ApplicationExitInfo.REASON_USER_STOPPED -> "user stopped"
    ApplicationExitInfo.REASON_DEPENDENCY_DIED -> "dependency died"
    ApplicationExitInfo.REASON_OTHER -> "other"
    ApplicationExitInfo.REASON_FREEZER -> "freezer"
    ApplicationExitInfo.REASON_PACKAGE_STATE_CHANGE -> "package state change"
    ApplicationExitInfo.REASON_PACKAGE_UPDATED -> "package updated"
    else -> "unknown ($reason)"
}
