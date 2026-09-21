package dev.crsmith.sidetone

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** 17.15 the app the bridge serves: where to fetch it, and its SHA-256 in hex. */
data class Apk(val url: String, val sha256: String)

/** 17.15 the app to offer: the bridge's, when its hash is not the installed app's. */
fun updateFor(installed: String?, offered: Apk?): Apk? {
    if (offered == null || installed == null) return null
    return if (offered.sha256.equals(installed, ignoreCase = true)) null else offered
}

/**
 * 17.15 the app updates itself from the bridge. It compares the hash of its
 * own installed file with the hash the bridge sends, so no version number is
 * needed. Every build is signed with the same debug key, so the install
 * replaces the app in place.
 */
object Updater {
    /** The action of the intent the system installer reports to. */
    const val ACTION_STATUS = "dev.crsmith.sidetone.INSTALL_STATUS"

    /** The installed file does not change while this process runs. */
    private var installed: String? = null

    suspend fun installedHash(context: Context): String? = withContext(Dispatchers.IO) {
        installed ?: runCatching { sha256(File(context.applicationInfo.sourceDir)) }.getOrNull()?.also { installed = it }
    }

    /** Stream the bridge's app into an install session, then commit it. The system asks Chris to confirm. */
    suspend fun install(context: Context, apk: Apk) = withContext(Dispatchers.IO) {
        val installer = context.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL)
        params.setAppPackageName(context.packageName)
        val id = installer.createSession(params)
        val session = installer.openSession(id)
        try {
            val connection = URL(apk.url).openConnection() as HttpURLConnection
            try {
                connection.connectTimeout = 10_000
                connection.readTimeout = 30_000
                if (connection.responseCode != 200) throw IOException("the bridge answered ${connection.responseCode}")
                session.openWrite("sidetone.apk", 0, connection.contentLengthLong).use { out ->
                    connection.inputStream.use { it.copyTo(out, 64 * 1024) }
                    session.fsync(out)
                }
            } finally {
                connection.disconnect()
            }
            val status = Intent(context, MainActivity::class.java).setAction(ACTION_STATUS)
            // mutable: the installer adds the status to it
            val pending = PendingIntent.getActivity(context, id, status, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE)
            session.commit(pending.intentSender)
            session.close()
        } catch (e: Exception) {
            session.abandon()
            throw e
        }
    }

    private fun sha256(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buffer = ByteArray(64 * 1024)
            while (true) {
                val read = input.read(buffer)
                if (read < 0) break
                digest.update(buffer, 0, read)
            }
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }
}
