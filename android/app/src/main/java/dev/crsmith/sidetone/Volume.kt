package dev.crsmith.sidetone

import android.content.Context

/**
 * 4.2.1 the slider position, 0 to 1, as the gain on the remote audio track.
 * The square gives the low end of the slider fine steps: a car is quiet and
 * a small gain is often what Chris wants. Full slider is a gain of 1, which
 * is the level the bridge sends.
 */
fun playbackGain(level: Float): Double {
    val clamped = level.coerceIn(0f, 1f).toDouble()
    return clamped * clamped
}

/**
 * 17.10 the gain the app puts on the remote track. The cut overrides the
 * slider: with the audio off the gain is zero, and on resume it is the
 * slider's again, because the slider position is never touched.
 */
fun outputGain(level: Float, audioOn: Boolean): Double = if (audioOn) playbackGain(level) else 0.0

/** 4.2.1 the slider position stays on the phone. It is not with the credentials, which a refused pairing clears. */
class VolumeStore(context: Context) {
    private val prefs = context.getSharedPreferences("sidetone-volume", Context.MODE_PRIVATE)

    fun load(): Float = prefs.getFloat("level", 1f).coerceIn(0f, 1f)

    fun save(level: Float) {
        prefs.edit().putFloat("level", level).apply()
    }
}
