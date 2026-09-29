package dev.crsmith.sidetone

import android.content.Context
import android.os.Looper
import com.sun.net.httpserver.HttpServer
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import java.net.InetSocketAddress

/**
 * [Bridge] is an object, and Robolectric keeps an object from one test to the
 * next while it gives each test a new application. This starts it again, as a
 * new process of the app would.
 */
fun newBridgeProcess() {
    fun field(name: String) = Bridge::class.java.getDeclaredField(name).apply { isAccessible = true }
    (field("session").get(null) as Job?)?.cancel()
    for (name in listOf("session", "store", "client")) field(name).set(null, null)
    @Suppress("UNCHECKED_CAST")
    (field("_state").get(null) as MutableStateFlow<Bridge.State>).value = Bridge.State()
}

/** Runs what the main thread has queued, as the phone's looper would. */
fun idle() = shadowOf(Looper.getMainLooper()).idle()

/**
 * The conversation above the screen: the pairing it keeps, the cuts that
 * outlive the process, and the room it opens and leaves. No LiveKit room
 * opens here: its WebRTC library is the phone's, so a join fails at the
 * room and the app waits to try again, as it does in a tunnel.
 */
@RunWith(RobolectricTestRunner::class)
class BridgeTest {
    private val app: Context = RuntimeEnvironment.getApplication()
    private val pairs = mutableListOf<String>()
    private val bridge = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0).apply {
        createContext("/pair") { exchange ->
            val code = exchange.requestBody.bufferedReader().readText()
            pairs += code
            val right = code.contains("kelp-cedar-jetty")
            val body = if (right) """{"url":"wss://bridge:7881","token":"t0ken"}""" else """{"error":"that code is not right"}"""
            exchange.sendResponseHeaders(if (right) 200 else 403, body.length.toLong())
            exchange.responseBody.use { it.write(body.toByteArray()) }
        }
        start()
    }
    private val origin = "http://127.0.0.1:${bridge.address.port}"

    @Before
    fun start() {
        newBridgeProcess()
        Bridge.load(app)
    }

    @After
    fun end() {
        Bridge.quit(app)
        bridge.stop(0)
    }

    @Test
    fun aPairingIsKeptForTheNextProcess() = runBlocking {
        assertFalse(Bridge.state.value.paired)
        Bridge.pairWith(Link(origin, "kelp-cedar-jetty"))
        assertEquals(listOf("""{"code":"kelp-cedar-jetty"}"""), pairs)
        assertTrue(Bridge.state.value.paired)
        newBridgeProcess()
        Bridge.load(app)
        assertTrue(Bridge.state.value.paired)
    }

    @Test
    fun aRefusedCodeIsTheBridgesWordsAndPairsNothing() = runBlocking {
        try {
            Bridge.pairWith(Link(origin, "amber-anchor-basalt"))
            fail("a refused code paired")
        } catch (e: PairingException) {
            assertEquals("that code is not right", e.message)
        }
        assertFalse(Bridge.state.value.paired)
    }

    @Test
    fun aCutMicrophoneStaysCutInTheNextProcess() {
        Bridge.setMic(false)
        assertFalse(Bridge.state.value.micOn)
        newBridgeProcess()
        Bridge.load(app)
        // 17.10.5 the cut is the phone's, so it outlives the process
        assertFalse(Bridge.state.value.micOn)
    }

    @Test
    fun withNoPairingAJoinOpensNothing() {
        Bridge.join(app)
        assertNull(shadowOf(RuntimeEnvironment.getApplication()).nextStartedService)
        assertEquals(Status.IDLE, Bridge.state.value.status)
    }

    @Test
    fun aJoinHoldsTheServiceAndALeaveLetsItGo() = runBlocking {
        Bridge.pairWith(Link(origin, "kelp-cedar-jetty"))
        val shadow = shadowOf(RuntimeEnvironment.getApplication())
        Bridge.join(app)
        assertEquals(BridgeService::class.java.name, shadow.nextStartedService.component?.className)
        // a second join while the session runs is the same session
        Bridge.join(app)
        assertNull(shadow.nextStartedService)

        // 17.11.10 left by hand: the room goes, and opening the app does not bring it back
        Bridge.leave(app)
        assertEquals(BridgeService::class.java.name, shadow.nextStoppedService.component?.className)
        assertEquals(Status.LEFT, Bridge.state.value.status)
        Bridge.join(app)
        assertNull(shadow.nextStartedService)
        // only the tap does
        Bridge.enter(app)
        assertEquals(BridgeService::class.java.name, shadow.nextStartedService.component?.className)

        // 17.22.4 a quit ends the conversation and keeps the pairing
        Bridge.quit(app)
        assertEquals(BridgeService::class.java.name, shadow.nextStoppedService.component?.className)
        assertEquals(Status.IDLE, Bridge.state.value.status)
        assertTrue(Bridge.state.value.paired)
    }

    @Test
    fun theBuildIsTheHashOfTheInstalledApp() = runBlocking {
        val expected = Updater.installedHash(app)
        // the hash is read off the main thread, and the state is set back on it
        for (i in 1..200) {
            if (Bridge.state.value.build != null) break
            idle()
            Thread.sleep(5)
        }
        assertEquals(expected, Bridge.state.value.build)
    }
}
