package dev.crsmith.sidetone

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class VolumeTest {
    @Test
    fun fullSliderLeavesTheBridgeLevelAlone() {
        assertEquals(1.0, playbackGain(1f), 0.0)
    }

    @Test
    fun sliderAtZeroIsSilent() {
        assertEquals(0.0, playbackGain(0f), 0.0)
    }

    @Test
    fun lowerSliderGivesLowerGain() {
        assertEquals(0.25, playbackGain(0.5f), 1e-6)
        assertTrue(playbackGain(0.2f) < playbackGain(0.3f))
    }

    @Test
    fun theCutOverridesTheSlider() {
        assertEquals(0.0, outputGain(1f, false), 0.0)
        assertEquals(0.0, outputGain(0.5f, false), 0.0)
    }

    @Test
    fun resumeRestoresTheSliderLevel() {
        assertEquals(playbackGain(0.5f), outputGain(0.5f, true), 0.0)
        assertEquals(1.0, outputGain(1f, true), 0.0)
    }

    @Test
    fun valuesOutsideTheSliderAreClamped() {
        assertEquals(0.0, playbackGain(-0.5f), 0.0)
        assertEquals(1.0, playbackGain(3f), 0.0)
    }
}
