package dev.crsmith.sidetone

import com.sun.net.httpserver.HttpServer
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import java.io.File
import java.io.IOException
import java.net.InetSocketAddress
import java.security.MessageDigest

/**
 * 17.15 the app updates itself from the bridge. Robolectric gives the app its
 * installed file and a package installer that keeps its sessions; the bridge
 * is a local HTTP server.
 */
@RunWith(RobolectricTestRunner::class)
class UpdateTest {
    private val context = RuntimeEnvironment.getApplication()
    private val installer = context.packageManager.packageInstaller
    private val served = mutableListOf<String>()
    private val bridge = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0).apply {
        createContext("/sidetone.apk") { exchange ->
            served += exchange.requestURI.path
            val body = ByteArray(200_000) { (it % 251).toByte() }
            exchange.sendResponseHeaders(200, body.size.toLong())
            exchange.responseBody.use { it.write(body) }
        }
        createContext("/gone.apk") { exchange -> exchange.sendResponseHeaders(404, -1); exchange.close() }
        start()
    }
    private val base = "http://127.0.0.1:${bridge.address.port}"

    @After
    fun stop() = bridge.stop(0)

    @Test
    fun theHashIsTheInstalledFileInHex() = runBlocking {
        val file = File(context.applicationInfo.sourceDir)
        val hash = Updater.installedHash(context)
        assertEquals(MessageDigest.getInstance("SHA-256").digest(file.readBytes()).joinToString("") { "%02x".format(it) }, hash)
        // the bridge sends lowercase hex, and updateFor compares the two
        assertEquals(null, updateFor(hash, Apk("$base/sidetone.apk", hash!!.uppercase())))
    }

    @Test
    fun anInstallStreamsTheBridgesAppIntoASessionAndReportsToTheApp() = runBlocking {
        Updater.install(context, Apk("$base/sidetone.apk", "ab12"))
        assertEquals(listOf("/sidetone.apk"), served)
        val session = installer.allSessions.single()
        assertEquals(context.packageName, session.appPackageName)
        // the system installer says how it went through the intent the commit carried
        shadowOf(installer).setSessionSucceeds(session.sessionId)
        val status = shadowOf(context).nextStartedActivity
        assertEquals(Updater.ACTION_STATUS, status.action)
        assertEquals(MainActivity::class.java.name, status.component?.className)
    }

    @Test
    fun aBridgeThatRefusesTheFileLeavesNoSession() = runBlocking {
        try {
            Updater.install(context, Apk("$base/gone.apk", "ab12"))
            fail("the install went on without the file")
        } catch (e: IOException) {
            assertEquals("the bridge answered 404", e.message)
        }
        assertTrue(installer.allSessions.isEmpty())
    }

    @Test
    fun aBridgeThatIsNotThereLeavesNoSession() = runBlocking {
        bridge.stop(0)
        try {
            Updater.install(context, Apk("$base/sidetone.apk", "ab12"))
            fail("the install went on with no bridge")
        } catch (_: IOException) {
        }
        assertTrue(installer.allSessions.isEmpty())
    }
}
