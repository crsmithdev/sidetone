package dev.crsmith.sidetone

import android.app.Notification
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf

/**
 * 17.2 and 17.16 the service that holds the process in the foreground, its
 * notification, and the notification's buttons, over the real [Bridge].
 */
@RunWith(RobolectricTestRunner::class)
class BridgeServiceTest {
    private val app: Context = RuntimeEnvironment.getApplication()
    private val notifications = app.getSystemService(NotificationManager::class.java)

    @Before
    fun start() {
        newBridgeProcess()
        Bridge.load(app)
    }

    @After
    fun end() = Bridge.quit(app)

    private fun started() = Robolectric.buildService(BridgeService::class.java).create().startCommand(0, 1)

    private fun Notification.text() = extras.getCharSequence(Notification.EXTRA_TEXT).toString()
    private fun Notification.buttons() = actions.orEmpty().map { it.title.toString() }

    @Test
    fun itIsInTheForegroundOnAChannelThatMakesNoSound() {
        notifications.createNotificationChannel(android.app.NotificationChannel("conversation", "old", NotificationManager.IMPORTANCE_LOW))
        val service = started().get()
        val shown = shadowOf(service).lastForegroundNotification
        assertEquals("conversation-controls", shown.channelId)
        val channel = notifications.getNotificationChannel("conversation-controls")
        assertEquals(NotificationManager.IMPORTANCE_DEFAULT, channel.importance)
        assertNull(channel.sound)
        assertFalse(channel.shouldVibrate())
        // 17.16 the silent channel of the first build goes, because its importance cannot be raised
        assertNull(notifications.getNotificationChannel("conversation"))
        assertEquals(Notification.VISIBILITY_PUBLIC, shown.visibility)
    }

    @Test
    fun theNotificationSaysTheStateAndOffersTheCuts() {
        val shown = shadowOf(started().get()).lastForegroundNotification
        assertEquals("connecting", shown.text())
        // not in a room: the end-turn phrase is the bridge's, so its button waits
        assertEquals(listOf("Mic off", "Audio off"), shown.buttons())
    }

    @Test
    fun aChangeOfStateIsPostedAgain() {
        started()
        Bridge.setMic(false)
        idle()
        val posted = shadowOf(notifications).allNotifications.single()
        assertEquals("connecting · mic off", posted.text())
        assertEquals(listOf("Mic on", "Audio off"), posted.buttons())
    }

    @Test
    fun theMicButtonCutsTheMicrophoneAndOpensItAgain() {
        val controls = BridgeService.Controls()
        controls.onReceive(app, Intent(BridgeService.Controls.MIC))
        idle()
        assertFalse(Bridge.state.value.micOn)
        controls.onReceive(app, Intent(BridgeService.Controls.MIC))
        idle()
        assertTrue(Bridge.state.value.micOn)
    }

    @Test
    fun swipingTheAppAwayEndsTheConversation() {
        val service = started()
        Bridge.setMic(false)
        service.get().onTaskRemoved(null)
        // the cut stays, because it is the phone's (17.10.5); the conversation does not
        assertEquals(Status.IDLE, Bridge.state.value.status)
        assertEquals(BridgeService::class.java.name, shadowOf(RuntimeEnvironment.getApplication()).nextStoppedService.component?.className)
    }
}
