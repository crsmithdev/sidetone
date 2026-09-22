package dev.crsmith.sidetone

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent

/**
 * 17.17 the notifications that alert: a job that ended, and a reply the voice
 * did not play. They are apart from the conversation notification (17.16),
 * which stays for as long as the conversation does.
 *
 * They go in a group of their own, with a summary. Left ungrouped, Android 16
 * put them in an automatic group with the conversation notification, and every
 * alert after the first came in silent (seen on the emulator, 21 September 2026).
 */
object Alerts {
    private const val CHANNEL = "alerts"
    private const val GROUP = "dev.crsmith.sidetone.ALERTS"
    private const val SUMMARY = 99
    private var next = 100

    fun post(context: Context, title: String, text: String) {
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(NotificationChannel(CHANNEL, "Replies and jobs", NotificationManager.IMPORTANCE_HIGH))
        val open = PendingIntent.getActivity(context, 0, Intent(context, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        val notification = Notification.Builder(context, CHANNEL)
            .setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setContentTitle(title)
            .setContentText(text)
            .setStyle(Notification.BigTextStyle().bigText(text))
            .setContentIntent(open)
            .setAutoCancel(true)
            .setGroup(GROUP)
            .build()
        manager.notify(next++, notification)
        val summary = Notification.Builder(context, CHANNEL)
            .setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setContentIntent(open)
            .setAutoCancel(true)
            .setGroup(GROUP)
            .setGroupSummary(true)
            // the new alert makes the sound, not the summary
            .setGroupAlertBehavior(Notification.GROUP_ALERT_CHILDREN)
            .build()
        manager.notify(SUMMARY, summary)
    }
}
