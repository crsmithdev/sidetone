package dev.crsmith.sidetone

import android.content.Context
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

/** The QR code the bridge prints, `<origin>/#pair=<code>`. See `pairingLink` in src/serve.ts. */
data class Link(val origin: String, val code: String)

/** 12.2 what one pairing gives: where LiveKit is, and a long-lived token for it. */
data class Credentials(val url: String, val token: String)

class PairingException(message: String) : Exception(message)

fun parseLink(text: String): Link? {
    val uri = runCatching { URI(text.trim()) }.getOrNull() ?: return null
    if (uri.scheme != "https" && uri.scheme != "http") return null
    val fragment = uri.rawFragment ?: return null
    if (!fragment.startsWith("pair=")) return null
    val code = fragment.removePrefix("pair=")
    if (code.isBlank() || uri.host == null) return null
    val port = if (uri.port == -1) "" else ":${uri.port}"
    return Link("${uri.scheme}://${uri.host}$port", code)
}

/**
 * 12.4 a token the server refuses is worth throwing away. Anything else, such
 * as a tunnel with no signal or LiveKit restarting, is not: clearing the token
 * then sends the phone back to the machine for a new code.
 */
fun refused(reason: String): Boolean =
    Regex("unauthor|invalid token|invalid api key|expired|permission|denied|403|401", RegexOption.IGNORE_CASE).containsMatchIn(reason)

suspend fun pair(link: Link): Credentials = withContext(Dispatchers.IO) {
    val connection = URL("${link.origin}/pair").openConnection() as HttpURLConnection
    try {
        connection.requestMethod = "POST"
        connection.doOutput = true
        connection.setRequestProperty("content-type", "application/json")
        connection.connectTimeout = 10_000
        // a wrong code waits up to ten seconds on the bridge before it answers
        connection.readTimeout = 30_000
        connection.outputStream.use { it.write(buildJsonObject { put("code", link.code) }.toString().toByteArray()) }
        val status = connection.responseCode
        val stream = if (status in 200..299) connection.inputStream else connection.errorStream
        val body = stream?.bufferedReader()?.use { it.readText() }.orEmpty()
        val json = runCatching { Json.parseToJsonElement(body).jsonObject }.getOrNull()
        if (status !in 200..299 || json == null) {
            throw PairingException(json?.get("error")?.jsonPrimitive?.contentOrNull ?: "pairing failed ($status)")
        }
        val url = json["url"]?.jsonPrimitive?.contentOrNull
        val token = json["token"]?.jsonPrimitive?.contentOrNull
        if (url == null || token == null) throw PairingException("the bridge answered without a token")
        Credentials(url, token)
    } finally {
        connection.disconnect()
    }
}

/** The web client keeps the token in localStorage; this is the same thing. */
class CredentialStore(context: Context) {
    private val prefs = context.getSharedPreferences("sidetone-credentials", Context.MODE_PRIVATE)

    fun load(): Credentials? {
        val url = prefs.getString("url", null) ?: return null
        val token = prefs.getString("token", null) ?: return null
        return Credentials(url, token)
    }

    fun save(credentials: Credentials) {
        prefs.edit().putString("url", credentials.url).putString("token", credentials.token).apply()
    }

    fun clear() {
        prefs.edit().clear().apply()
    }
}
