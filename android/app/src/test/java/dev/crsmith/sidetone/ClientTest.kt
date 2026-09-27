package dev.crsmith.sidetone

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.async
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.yield
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/**
 * The client with a room, with no LiveKit and no Android. The room writes down
 * what it was sent, and a send fails when the test says so.
 */
class ClientTest {
    @get:Rule
    val folder = TemporaryFolder()

    private class FakeRoom(
        /** The sends that fail, counted from 1. */
        private val failing: Set<Int> = emptySet(),
    ) : Room {
        val sent = mutableListOf<String>()
        val mic = mutableListOf<String>()
        var tries = 0
        val incoming = Channel<Room.Event>(Channel.UNLIMITED)
        override val events: Flow<Room.Event> = incoming.receiveAsFlow()

        override suspend fun send(payload: ByteArray): Result<Unit> {
            tries++
            if (tries in failing) return Result.failure(IllegalStateException("the room is reconnecting"))
            sent += payload.decodeToString()
            return Result.success(Unit)
        }

        override suspend fun openMic() {
            mic += "open"
        }

        override fun closeMic() {
            mic += "close"
        }
    }

    private val state = MutableStateFlow(Bridge.State())

    /** The cuts on the phone, and each write of them. */
    private val kept = mutableMapOf<String, Boolean>()
    private val cutWrites = mutableListOf<Pair<String, Boolean>>()

    private var setup: String? = null
    private var forgotten = 0

    private fun client(scope: CoroutineScope, crashes: Crashes = Crashes(folder.newFolder())) = Client(
        state, scope,
        CutStore(read = kept::get, write = { key, on -> cutWrites += key to on; kept[key] = on }),
        SetupStore(read = { setup }, write = { setup = it }),
        crashes, object : Client.Logcat {}, elapsed = { 100_000L },
        forget = { forgotten++ },
        phone = { _, _ -> },
    )

    private fun kind(message: String) = Json.parseToJsonElement(message).jsonObject["kind"]?.jsonPrimitive?.content

    /** Run the rest of the test's coroutines until `done`. */
    private suspend fun until(done: () -> Boolean) = withTimeout(5_000) { while (!done()) yield() }

    @Test
    fun aHoldAndItsReleaseSendTheReleaseAndKeepNoCut() = runBlocking {
        state.value = Bridge.State(micOn = false)
        val room = FakeRoom()
        val client = client(this)
        val inRoom = async { client.inRoom(room) { true } }
        until { client.status == Status.LISTENING }

        client.hold()
        client.release()
        until { room.sent.size == 2 }

        // 9.5.2 the release tells the bridge the words end now, rather than to drop them
        assertEquals(listOf("""{"kind":"mic","on":true,"hold":true}""", """{"kind":"mic","on":false,"release":true}"""), room.sent)
        assertEquals(listOf("open", "close"), room.mic)
        // 17.10.5 a hold is not a cut: a death while the button is down must not leave the microphone cut or open
        assertEquals(emptyList<Pair<String, Boolean>>(), cutWrites)
        assertEquals(false, state.value.micOn)
        assertEquals(false, state.value.holding)

        room.incoming.send(Room.Event.Ended("done"))
        assertEquals("done", inRoom.await())
    }

    @Test
    fun aCutByHandIsKept() = runBlocking {
        val room = FakeRoom()
        val client = client(this)
        val inRoom = async { client.inRoom(room) { true } }
        until { client.status == Status.LISTENING }

        client.setMic(false)
        until { room.sent.size == 1 }

        assertEquals(listOf("""{"kind":"mic","on":false}"""), room.sent)
        assertEquals(listOf("micOn" to false), cutWrites)

        room.incoming.send(Room.Event.Ended("done"))
        inRoom.await()
        Unit
    }

    @Test
    fun aScreenLogPartThatFailsGoesBackFirstWithTheRest() = runBlocking {
        val client = client(this)
        // entries of 3,000 characters, so a part of 12,000 bytes holds three
        val texts = (0 until 10).map { "$it".repeat(3_000) }
        for (text in texts) client.record("note", text)

        client.sendScreenLog(FakeRoom(failing = setOf(2)))
        // an entry that comes while the room is gone goes after the ones that did not go
        client.record("note", "late")
        val next = FakeRoom()
        client.sendScreenLog(next)

        val sent = next.sent.flatMap { part ->
            Json.parseToJsonElement(part).jsonObject["entries"]!!.jsonArray.map { it.jsonObject["text"]!!.jsonPrimitive.content }
        }
        assertEquals(texts.drop(3) + "late", sent)
    }

    @Test
    fun aSetupWithANameThisAppDoesNotKnowSendsNothingAndKeepsTheRoom() = runBlocking {
        val room = FakeRoom()
        val client = client(this)
        val inRoom = async { client.inRoom(room) { true } }
        until { client.status == Status.LISTENING }

        room.incoming.send(Room.Event.Data(
            """{"kind":"setup","default":false,"mode":"loud","output":"media","focus":"none","canceller":"software","noiseSuppression":true,"autoGainControl":true}""".encodeToByteArray(),
        ))
        room.incoming.send(Room.Event.Ended("done"))

        // a rejoin would have ended the room first, as "rejoining"
        assertEquals("done", inRoom.await())
        assertEquals(null, setup)
        assertEquals(emptyList<String>(), room.sent.filter { kind(it) != "screen" })
    }

    @Test
    fun aSetupThisAppKnowsIsKeptAndEndsTheRoom() = runBlocking {
        val room = FakeRoom()
        val client = client(this)
        val inRoom = async { client.inRoom(room) { true } }
        until { client.status == Status.LISTENING }

        room.incoming.send(Room.Event.Data(
            """{"kind":"setup","default":false,"mode":"normal","output":"media","focus":"none","canceller":"software","noiseSuppression":true,"autoGainControl":true}""".encodeToByteArray(),
        ))
        room.incoming.send(Room.Event.Ended("done"))

        assertEquals(Joining.REJOINING, inRoom.await())
        assertEquals(SetupNames("normal", "media", "none", "software", noiseSuppression = true, autoGainControl = true), SetupStore(read = { setup }, write = {}).load())
    }

    @Test
    fun aCrashReportThatDoesNotGoStaysOnDiskAndEachGoesOnce() = runBlocking {
        val crashes = Crashes(folder.newFolder())
        crashes.save(1_000, "main", "state", IllegalStateException("one"))
        crashes.save(2_000, "main", "state", IllegalStateException("two"))
        val client = client(this, crashes)

        val first = FakeRoom(failing = setOf(2))
        val inFirst = async { client.inRoom(first) { true } }
        until { first.tries == 2 }
        first.incoming.send(Room.Event.Ended("done"))
        inFirst.await()

        assertEquals(1, first.sent.size)
        assertTrue(first.sent[0], first.sent[0].contains("\"1000\""))
        assertEquals(listOf("2000"), crashes.unsent().map { it.nameWithoutExtension })

        val second = FakeRoom()
        val inSecond = async { client.inRoom(second) { true } }
        until { crashes.unsent().isEmpty() }
        second.incoming.send(Room.Event.Ended("done"))
        inSecond.await()

        assertEquals(1, second.sent.size)
        assertTrue(second.sent[0], second.sent[0].contains("\"2000\""))
    }

    @Test
    fun aRefusedPairingIsForgottenOnceAndTheCutStays() = runBlocking {
        kept["micOn"] = false
        var rooms = 0
        val client = client(this)

        client.loop {
            rooms++
            "unauthorized"
        }

        assertEquals(1, rooms)
        assertEquals(1, forgotten)
        assertEquals(Status.IDLE, state.value.status)
        assertEquals(false, state.value.micOn)
        assertEquals(false, state.value.paired)
        assertTrue(state.value.error!!, state.value.error!!.contains("refused"))
    }
}
