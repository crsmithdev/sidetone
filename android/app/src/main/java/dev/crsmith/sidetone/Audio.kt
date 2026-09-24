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
