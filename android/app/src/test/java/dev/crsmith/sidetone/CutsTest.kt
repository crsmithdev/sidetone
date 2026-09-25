package dev.crsmith.sidetone

import org.junit.Assert.assertEquals
import org.junit.Test

class CutsTest {
    @Test
    fun `nothing is cut before a cut was ever kept`() {
        assertEquals(Cuts(micOn = true), CutStore(read = { null }, write = { _, _ -> }).load())
    }

    @Test
    fun `the cut comes back in a new process`() {
        // 17.10.5 a process death took the cuts, and the next room opened the microphone Chris had cut
        val kept = mutableMapOf<String, Boolean>()
        val store = CutStore(read = kept::get, write = kept::set)
        store.save(Cuts(micOn = false))
        assertEquals(Cuts(micOn = false), CutStore(read = kept::get, write = { _, _ -> }).load())
        store.save(Cuts(micOn = true))
        assertEquals(Cuts(micOn = true), CutStore(read = kept::get, write = { _, _ -> }).load())
    }

    @Test
    fun `the state takes the kept cut and nothing else`() {
        // 17.10.6 the audio and the music come from the bridge, so a kept cut does not touch them
        val state = Bridge.State(paired = true, error = "x", audioOn = false, musicOn = false)
        val cut = Cuts(micOn = false).applyTo(state)
        assertEquals(state.copy(micOn = false), cut)
        assertEquals(Cuts(micOn = false), Cuts.of(cut))
    }
}
