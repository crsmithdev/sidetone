package dev.crsmith.sidetone

import android.media.AudioAttributes
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.media.MediaRecorder
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
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

    @Test
    fun `a setup with no focus picks the car, then a headset, then the speaker, never the earpiece`() {
        // 4.2.2.1 the handler routes only in the call that asks for focus, so with none the app picks
        val sco = AudioDeviceInfo.TYPE_BLUETOOTH_SCO
        val ble = AudioDeviceInfo.TYPE_BLE_HEADSET
        val wired = AudioDeviceInfo.TYPE_WIRED_HEADSET
        val usb = AudioDeviceInfo.TYPE_USB_HEADSET
        val headphones = AudioDeviceInfo.TYPE_WIRED_HEADPHONES
        val speaker = AudioDeviceInfo.TYPE_BUILTIN_SPEAKER
        val earpiece = AudioDeviceInfo.TYPE_BUILTIN_EARPIECE
        assertEquals(sco, Audio.communicationDevice(listOf(earpiece, speaker, wired, ble, sco)))
        assertEquals(ble, Audio.communicationDevice(listOf(earpiece, speaker, wired, ble)))
        assertEquals(wired, Audio.communicationDevice(listOf(earpiece, speaker, headphones, usb, wired)))
        assertEquals(usb, Audio.communicationDevice(listOf(earpiece, speaker, headphones, usb)))
        assertEquals(headphones, Audio.communicationDevice(listOf(earpiece, speaker, headphones)))
        assertEquals(speaker, Audio.communicationDevice(listOf(earpiece, speaker)))
        // the app is used in a car and on a desk, never against an ear
        assertNull(Audio.communicationDevice(listOf(earpiece)))
        assertNull(Audio.communicationDevice(emptyList()))
        // A2DP is not a communication device, and a type this app does not know is not taken on trust
        assertNull(Audio.communicationDevice(listOf(earpiece, AudioDeviceInfo.TYPE_BLUETOOTH_A2DP, 9999)))
    }

    /** 18.15 the setup in the code, as the bridge names it: the words the `setup` and `device` messages carry. */
    private val codeNames = SetupNames(mode = "call", output = "voice", focus = "gain", canceller = "hardware", noiseSuppression = true, autoGainControl = true)

    @Test
    fun `each name maps to its constant, and back`() {
        assertEquals(codeNames, Audio.names(setup))
        assertEquals(setup, Audio.named(codeNames))
        val media = SetupNames(mode = "normal", output = "media", focus = "none", canceller = "software", noiseSuppression = false, autoGainControl = false)
        val named = Audio.named(media)!!
        assertEquals(AudioManager.MODE_NORMAL, named.mode)
        assertEquals(AudioAttributes.USAGE_MEDIA, named.usage)
        assertEquals(AudioAttributes.CONTENT_TYPE_MUSIC, named.contentType)
        assertEquals(AudioManager.STREAM_MUSIC, named.stream)
        assertNull(named.focus)
        assertFalse(named.hardwareEchoCanceller)
        assertFalse(named.noiseSuppression)
        assertFalse(named.autoGainControl)
        assertEquals(media, Audio.names(named))
    }

    @Test
    fun `a pushed setup keeps the capture source and the echo cancellation`() {
        // 18.15 the message has no source: VOICE_COMMUNICATION is the only one Android cancels echo on
        for (canceller in listOf("hardware", "software")) {
            val named = Audio.named(codeNames.copy(mode = "normal", canceller = canceller))!!
            assertEquals(MediaRecorder.AudioSource.VOICE_COMMUNICATION, named.source)
            assertTrue(named.echoCancellation)
        }
    }

    @Test
    fun `a name the app does not know maps to nothing`() {
        assertNull(Audio.named(codeNames.copy(mode = "communication")))
        assertNull(Audio.named(codeNames.copy(output = "speech")))
        assertNull(Audio.named(codeNames.copy(focus = "transient")))
        assertNull(Audio.named(codeNames.copy(canceller = "webrtc")))
    }

    @Test
    fun `a pushed setup does not touch the setup in the code`() {
        // 18.15 a pushed setup is an experiment, named in the device message and the record.
        // The guard of 18.13.1 holds the setup in the code, which is what ships.
        val pushed = Audio.named(SetupNames(mode = "normal", output = "media", focus = "none", canceller = "software", noiseSuppression = true, autoGainControl = true))!!
        assertTrue(pushed != Audio.setup)
        assertEquals(Audio.checked, Audio.setup)
        assertEquals(codeNames, Audio.names(Audio.setup))
    }

    @Test
    fun `the store keeps a pushed setup, and a default clears it`() {
        // 18.15 the setup survives an app restart, so a setup under test survives a drive
        var kept: String? = null
        val store = SetupStore(read = { kept }, write = { kept = it })
        assertNull(store.load())
        val names = SetupNames(mode = "normal", output = "media", focus = "none", canceller = "software", noiseSuppression = true, autoGainControl = false)
        store.save(names)
        assertEquals(names, store.load())
        assertEquals(names, SetupStore(read = { kept }, write = {}).load())
        store.clear()
        assertNull(kept)
        assertNull(store.load())
        // what an older app wrote, or a hand edit, is no setup
        kept = "{\"mode\":\"call\"}"
        assertNull(store.load())
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
