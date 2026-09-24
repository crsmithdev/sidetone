package dev.crsmith.sidetone

import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.media.MediaRecorder
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 4.2.2 and 18.13 the echo canceller lives in the phone, where no unit test
 * reaches. What a test can do is hold the app to the one setup the phone was
 * last checked with, and fail any change to the audio path that went round it.
 * The volume slider of 21 September was such a change: a gain on the bridge's
 * track, set in Bridge.kt, that no test looked at.
 */
class AudioTest {
    private val setup = Audio.setup

    @Test
    fun `the microphone goes through an echo canceller`() {
        assertEquals("Android cancels echo only on the VOICE_COMMUNICATION source", MediaRecorder.AudioSource.VOICE_COMMUNICATION, setup.source)
        assertTrue("barge-in needs the echo canceller (4.2, 11.4)", setup.echoCancellation)
    }

    @Test
    fun `a setup with no focus asks for no mode`() {
        // the handler sets the mode only in the call that asks for focus
        if (setup.focus == null) assertEquals(AudioManager.MODE_NORMAL, setup.mode)
    }

    @Test
    fun `the setup is the one the phone was checked with`() {
        assertEquals(
            "the audio setup changed. Install the app, run `bun scripts/echo-check.ts` with the phone in the room, " +
                "and set Audio.checked and Audio.CHECKED_ON only when it passes (18.13)",
            Audio.checked,
            setup,
        )
    }

    @Test
    fun `only Audio_kt touches the audio path`() {
        val sources = File("src/main/java").walk().filter { it.isFile && it.extension == "kt" && it.name != "Audio.kt" }.toList()
        assertTrue("no sources found from ${File(".").absolutePath}", sources.isNotEmpty())
        val found = sources.flatMap { file ->
            file.readLines().withIndex()
                .filter { (_, line) -> AUDIO_PATH.any { it.containsMatchIn(line) } }
                .map { (index, line) -> "${file.name}:${index + 1}: ${line.trim()}" }
        }
        assertEquals("the audio path changes in Audio.kt, where AudioTest sees it (18.13)", emptyList<String>(), found)
    }

    @Test
    fun `the canceller named to the bridge is the one that runs`() {
        // 14.15 WebRTC runs its own canceller when the phone's is off or missing
        assertEquals("hardware", Audio.canceller(setup.copy(hardwareEchoCanceller = true), available = true))
        assertEquals("software", Audio.canceller(setup.copy(hardwareEchoCanceller = true), available = false))
        assertEquals("software", Audio.canceller(setup.copy(hardwareEchoCanceller = false), available = true))
    }

    @Test
    fun `a route is named the way the journal says it`() {
        assertEquals("speaker", Audio.routeName(AudioDeviceInfo.TYPE_BUILTIN_SPEAKER, "Pixel 8"))
        assertEquals("Bluetooth SCO (SYNC)", Audio.routeName(AudioDeviceInfo.TYPE_BLUETOOTH_SCO, "SYNC"))
        assertEquals("Bluetooth A2DP (SYNC)", Audio.routeName(AudioDeviceInfo.TYPE_BLUETOOTH_A2DP, "SYNC"))
        assertEquals("wired", Audio.routeName(AudioDeviceInfo.TYPE_WIRED_HEADPHONES, ""))
        assertEquals("device type 9999 (x)", Audio.routeName(9999, "x"))
    }

    private companion object {
        /** What changes the sound the phone plays or hears: a gain, a mode, focus, routing, a player of its own. */
        val AUDIO_PATH = listOf(
            Regex("""\.setVolume\("""),
            Regex("""^import android\.media\."""),
            Regex("""^import io\.livekit\.android\.audio\."""),
            Regex("""^import io\.livekit\.android\.(AudioOptions|AudioType|LiveKitOverrides)\b"""),
            Regex("""^import io\.livekit\.android\.room\.track\.(LocalAudioTrackOptions|RemoteAudioTrack)\b"""),
            Regex("""\bAUDIO_SERVICE\b"""),
        )
    }
}
