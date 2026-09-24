package dev.crsmith.sidetone

import android.app.UiModeManager
import android.content.Context
import android.content.res.Configuration
import android.media.AudioAttributes
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.media.MediaRecorder
import android.media.audiofx.AcousticEchoCanceler
import io.livekit.android.AudioOptions
import io.livekit.android.AudioType
import io.livekit.android.LiveKitOverrides
import io.livekit.android.audio.AudioSwitchHandler
import io.livekit.android.room.track.LocalAudioTrackOptions
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject

/**
 * 4.2.2 how the app sets up the phone's audio: the one place that does. Barge-in
 * depends on the echo canceller, and the canceller depends on every value here,
 * so a change to any of them is a change the phone has to be checked with
 * (18.13). `AudioTest` holds the app to that.
 */
data class AudioSetup(
    /** The [AudioManager] mode. Call mode makes the app act like a phone call. */
    val mode: Int,
    /** How the bridge's audio plays: the [AudioAttributes] usage, content type and stream. */
    val usage: Int,
    val contentType: Int,
    val stream: Int,
    /** The audio focus the app holds while it is in a room, or null for none. */
    val focus: Int?,
    /** The microphone's capture source. VOICE_COMMUNICATION is the one Android cancels echo on. */
    val source: Int,
    val echoCancellation: Boolean,
    /** Whether the phone's own canceller does the work, rather than the one in WebRTC. */
    val hardwareEchoCanceller: Boolean,
    val noiseSuppression: Boolean,
    val autoGainControl: Boolean,
)

/**
 * 18.15 a setup as the bridge names it, with no Android constant in it: the
 * words of the `setup` message, the `device` message and the store. [Audio.named]
 * maps each name to its constant, because 4.2.2 keeps the setup in one place.
 * The capture source is not named: VOICE_COMMUNICATION is the only source
 * Android cancels echo on, so it never changes.
 */
data class SetupNames(
    /** "call" or "normal" */
    val mode: String,
    /** "voice" or "media": how the bridge's audio plays */
    val output: String,
    /** "gain" or "none" */
    val focus: String,
    /** "hardware" or "software": which canceller is asked for; 14.15 says which one runs */
    val canceller: String,
    val noiseSuppression: Boolean,
    val autoGainControl: Boolean,
)

/**
 * 18.15 the pushed setup, kept across an app restart so a setup under test
 * survives a drive. `read` and `write` are the one string the app keeps, so a
 * test hands in a variable and the app hands in its preferences. The string
 * is the JSON of [SetupNames]; one an older app wrote, or one that does not
 * read, is no setup, and the app runs with the setup in its code.
 */
class SetupStore(private val read: () -> String?, private val write: (String?) -> Unit) {
    fun load(): SetupNames? {
        val kept = read() ?: return null
        val json = runCatching { Json.parseToJsonElement(kept) as? JsonObject }.getOrNull() ?: return null
        return setupNames(json)
    }

    fun save(names: SetupNames) = write(setupJson(names).toString())

    fun clear() = write(null)
}

object Audio {
    /**
     * 4.2.2 the setup the app runs with: a phone call, with the phone's own
     * canceller. The media setup of item 27 played the voice to the car as
     * music, and on 23 September the car's speakers reached the phone's
     * microphone: the echo check in the car brought the whole passage back at
     * peak 0.54, on the loudspeaker and with the software canceller. Call mode
     * is what the canceller holds through, so the app keeps it until a setup
     * that releases audio focus without leaving call mode is checked.
     */
    val setup = AudioSetup(
        mode = AudioManager.MODE_IN_COMMUNICATION,
        usage = AudioAttributes.USAGE_VOICE_COMMUNICATION,
        contentType = AudioAttributes.CONTENT_TYPE_SPEECH,
        stream = AudioManager.STREAM_VOICE_CALL,
        focus = AudioManager.AUDIOFOCUS_GAIN,
        source = MediaRecorder.AudioSource.VOICE_COMMUNICATION,
        echoCancellation = true,
        hardwareEchoCanceller = true,
        noiseSuppression = true,
        autoGainControl = true,
    )

    /**
     * 18.13 the setup that last passed the echo check on the phone, and when.
     * It is a copy, not a reference to [setup], so that a change to one fails
     * `AudioTest` until the check passes and the other follows it.
     */
    val checked = AudioSetup(
        mode = AudioManager.MODE_IN_COMMUNICATION,
        usage = AudioAttributes.USAGE_VOICE_COMMUNICATION,
        contentType = AudioAttributes.CONTENT_TYPE_SPEECH,
        stream = AudioManager.STREAM_VOICE_CALL,
        focus = AudioManager.AUDIOFOCUS_GAIN,
        source = MediaRecorder.AudioSource.VOICE_COMMUNICATION,
        echoCancellation = true,
        hardwareEchoCanceller = true,
        noiseSuppression = true,
        autoGainControl = true,
    )
    const val CHECKED_ON = "23 September 2026"

    /**
     * 18.15 the setup a pushed message names, or null when a name is not one
     * here. The output names the usage, the content type and the stream
     * together, because the three go together: a call plays speech on the
     * voice call stream, and media plays music on the music stream, which is
     * the setup of item 27 that the car defeated on 23 September.
     */
    fun named(names: SetupNames): AudioSetup? {
        val mode = when (names.mode) {
            "call" -> AudioManager.MODE_IN_COMMUNICATION
            "normal" -> AudioManager.MODE_NORMAL
            else -> return null
        }
        val (usage, contentType, stream) = when (names.output) {
            "voice" -> Triple(AudioAttributes.USAGE_VOICE_COMMUNICATION, AudioAttributes.CONTENT_TYPE_SPEECH, AudioManager.STREAM_VOICE_CALL)
            "media" -> Triple(AudioAttributes.USAGE_MEDIA, AudioAttributes.CONTENT_TYPE_MUSIC, AudioManager.STREAM_MUSIC)
            else -> return null
        }
        val focus = when (names.focus) {
            "gain" -> AudioManager.AUDIOFOCUS_GAIN
            "none" -> null
            else -> return null
        }
        val hardware = when (names.canceller) {
            "hardware" -> true
            "software" -> false
            else -> return null
        }
        return AudioSetup(
            mode = mode,
            usage = usage,
            contentType = contentType,
            stream = stream,
            focus = focus,
            source = MediaRecorder.AudioSource.VOICE_COMMUNICATION,
            echoCancellation = true,
            hardwareEchoCanceller = hardware,
            noiseSuppression = names.noiseSuppression,
            autoGainControl = names.autoGainControl,
        )
    }

    /** 18.15 a setup as the bridge names it, for the `device` message (14.15). */
    fun names(setup: AudioSetup) = SetupNames(
        mode = if (setup.mode == AudioManager.MODE_IN_COMMUNICATION) "call" else "normal",
        output = if (setup.usage == AudioAttributes.USAGE_VOICE_COMMUNICATION) "voice" else "media",
        focus = if (setup.focus == null) "none" else "gain",
        canceller = if (setup.hardwareEchoCanceller) "hardware" else "software",
        noiseSuppression = setup.noiseSuppression,
        autoGainControl = setup.autoGainControl,
    )

    /** 14.15 whether the phone has a hardware echo canceller. */
    fun hardwareCanceller(): Boolean = AcousticEchoCanceler.isAvailable()

    /** 14.15 which canceller runs: WebRTC's own runs when the phone's is off or missing. */
    fun canceller(setup: AudioSetup, available: Boolean): String =
        if (setup.hardwareEchoCanceller && available) "hardware" else "software"

    /** 14.15 where the bridge's audio plays now, and whether the phone is in car mode. */
    fun route(context: Context, setup: AudioSetup): String {
        val attributes = AudioAttributes.Builder().setUsage(setup.usage).setContentType(setup.contentType).build()
        val device = context.getSystemService(AudioManager::class.java).getAudioDevicesForAttributes(attributes).firstOrNull()
        val car = context.getSystemService(UiModeManager::class.java).currentModeType == Configuration.UI_MODE_TYPE_CAR
        val name = device?.let { routeName(it.type, it.productName.toString()) } ?: "none"
        return if (car) "$name, in car mode" else name
    }

    /** 14.15 a device type as the journal says it. A Bluetooth device keeps its name, which says which car. */
    fun routeName(type: Int, product: String): String = when (type) {
        AudioDeviceInfo.TYPE_BUILTIN_SPEAKER, AudioDeviceInfo.TYPE_BUILTIN_SPEAKER_SAFE -> "speaker"
        AudioDeviceInfo.TYPE_BUILTIN_EARPIECE -> "earpiece"
        AudioDeviceInfo.TYPE_BLUETOOTH_SCO -> "Bluetooth SCO ($product)"
        AudioDeviceInfo.TYPE_BLUETOOTH_A2DP -> "Bluetooth A2DP ($product)"
        AudioDeviceInfo.TYPE_BLE_HEADSET, AudioDeviceInfo.TYPE_BLE_SPEAKER, AudioDeviceInfo.TYPE_BLE_BROADCAST -> "Bluetooth LE ($product)"
        AudioDeviceInfo.TYPE_WIRED_HEADSET, AudioDeviceInfo.TYPE_WIRED_HEADPHONES, AudioDeviceInfo.TYPE_USB_HEADSET -> "wired"
        else -> "device type $type ($product)"
    }

    /** The capture half of [setup], for the room's microphone track. */
    fun capture(setup: AudioSetup) = LocalAudioTrackOptions(
        echoCancellation = setup.echoCancellation,
        noiseSuppression = setup.noiseSuppression,
        autoGainControl = setup.autoGainControl,
    )

    /** The playback half of [setup], and the capture source, for the room. */
    fun overrides(context: Context, setup: AudioSetup): LiveKitOverrides {
        val attributes = AudioAttributes.Builder().setUsage(setup.usage).setContentType(setup.contentType).build()
        // a handler of our own does not read the output type, so it is given every value itself
        val handler = AudioSwitchHandler(context).apply {
            audioMode = setup.mode
            audioAttributeUsageType = setup.usage
            audioAttributeContentType = setup.contentType
            audioStreamType = setup.stream
            // the handler sets the mode in the same call that asks for focus, so no focus leaves the mode alone
            manageAudioFocus = setup.focus != null
            setup.focus?.let { focusMode = it }
        }
        return LiveKitOverrides(
            audioOptions = AudioOptions(
                audioOutputType = AudioType.CustomAudioType(setup.mode, attributes, setup.stream),
                audioHandler = handler,
                javaAudioDeviceModuleCustomizer = { builder ->
                    builder.setAudioSource(setup.source)
                    builder.setUseHardwareAcousticEchoCanceler(setup.hardwareEchoCanceller)
                },
            ),
        )
    }
}
