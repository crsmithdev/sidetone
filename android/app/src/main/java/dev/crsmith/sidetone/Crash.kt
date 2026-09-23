package dev.crsmith.sidetone

import java.io.File
import java.io.PrintWriter
import java.io.StringWriter
import java.time.Instant

/** 14.14.1 the most bytes of one crash message. It fits one data message, as a part of a screenshot does. */
const val CRASH_MESSAGE_BYTES = 12_000

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
