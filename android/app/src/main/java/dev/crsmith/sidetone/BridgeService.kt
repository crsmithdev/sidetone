package dev.crsmith.sidetone

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.IBinder
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch

/**
 * 17.2 screen-off voice. A web page loses the microphone when the screen locks
 * (17.6); a foreground service of type microphone keeps it. The conversation
 * itself is [Bridge]; this only holds the process in the foreground.
 *
 * 17.16 its notification shows the state and three buttons, on the lock screen too.
 */
class BridgeService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var watch: Job? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val manager = getSystemService(NotificationManager::class.java)
        // 17.16 a channel's importance cannot be raised once it exists, so the silent one goes
        manager.deleteNotificationChannel(OLD_CHANNEL)
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL, "Conversation", NotificationManager.IMPORTANCE_DEFAULT).apply {
                setSound(null, null)
                enableVibration(false)
                setShowBadge(false)
            },
        )
        startForeground(ID, notification(Shown.of(Bridge.state.value)), ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
        if (watch == null) {
            watch = scope.launch {
                Bridge.state.map(Shown::of).distinctUntilChanged().collect { manager.notify(ID, notification(it)) }
            }
        }
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }

    /**
     * The app was swiped away. The room ends with it, so nothing is held by a
     * process Chris thinks he closed: on the drive of 18 September the app
     * kept the car's audio after he had left it.
     */
    override fun onTaskRemoved(rootIntent: Intent?) {
        Bridge.leave(this)
        super.onTaskRemoved(rootIntent)
    }

    /** What the notification shows, so a change elsewhere in the state does not post it again. */
    data class Shown(val status: Bridge.Status, val micOn: Boolean, val audioOn: Boolean, val inRoom: Boolean, val sign: Sign) {
        companion object {
            fun of(state: Bridge.State) = Shown(state.status, state.micOn, state.audioOn, state.endTurn != null, state.sign)
        }
    }

    private fun notification(shown: Shown): Notification {
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        val builder = Notification.Builder(this, CHANNEL)
            .setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setContentTitle(getString(R.string.app_name))
            .setContentText(stateLine(shown))
            .setContentIntent(open)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setVisibility(Notification.VISIBILITY_PUBLIC)
            .addAction(action(Controls.MIC, if (shown.micOn) "Mic off" else "Mic on"))
            .addAction(action(Controls.AUDIO, if (shown.audioOn) "Audio off" else "Audio on"))
        // the phrase belongs to the bridge, so the button waits for the room, as the app's does
        if (shown.inRoom) builder.addAction(action(Controls.END_TURN, "End turn"))
        return builder.build()
    }

    private fun action(name: String, label: String): Notification.Action {
        val intent = Intent(this, Controls::class.java).setAction(name)
        val pending = PendingIntent.getBroadcast(this, name.hashCode(), intent, PendingIntent.FLAG_IMMUTABLE)
        return Notification.Action.Builder(null, label, pending).build()
    }

    /** Receives the notification's buttons. It is not exported. */
    class Controls : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            val state = Bridge.state.value
            when (intent.action) {
                MIC -> Bridge.setMic(!state.micOn)
                AUDIO -> Bridge.setAudio(!state.audioOn)
                END_TURN -> Bridge.endTurn()
            }
        }

        companion object {
            const val MIC = "dev.crsmith.sidetone.MIC"
            const val AUDIO = "dev.crsmith.sidetone.AUDIO"
            const val END_TURN = "dev.crsmith.sidetone.END_TURN"
        }
    }

    private companion object {
        const val ID = 1
        const val OLD_CHANNEL = "conversation"
        const val CHANNEL = "conversation-controls"
    }
}

/** 17.16 the status, and what is cut or running, in one line: "listening · mic off · working". */
fun stateLine(shown: BridgeService.Shown): String = buildList {
    add(statusWord(shown.status))
    if (!shown.micOn) add("mic off")
    if (!shown.audioOn) add("audio off")
    if (shown.sign != Sign.OFF) add(signWord(shown.sign))
}.joinToString(" · ")
