package dev.crsmith.sidetone

import org.junit.Assert.assertEquals
import org.junit.Test

class CutsTest {
    @Test
    fun `nothing is cut before a cut was ever kept`() {
        assertEquals(Cuts(micOn = true, audioOn = true, musicOn = true), CutStore(read = { null }, write = { _, _ -> }).load())
    }

    @Test
    fun `the cuts come back in a new process`() {
        // 17.10.5 a process death took the cuts, and the next room opened the microphone Chris had cut
        val kept = mutableMapOf<String, Boolean>()
        val store = CutStore(read = kept::get, write = kept::set)
        store.save(Cuts(micOn = false, audioOn = false, musicOn = true))
        assertEquals(Cuts(micOn = false, audioOn = false, musicOn = true), CutStore(read = kept::get, write = { _, _ -> }).load())
        store.save(Cuts(micOn = true, audioOn = true, musicOn = false))
        assertEquals(Cuts(micOn = true, audioOn = true, musicOn = false), CutStore(read = kept::get, write = { _, _ -> }).load())
    }

    @Test
    fun `the state takes the kept cuts and nothing else`() {
        val state = Bridge.State(paired = true, error = "x")
        val cut = Cuts(micOn = false, audioOn = true, musicOn = false).applyTo(state)
        assertEquals(state.copy(micOn = false, musicOn = false), cut)
        assertEquals(Cuts(micOn = false, audioOn = true, musicOn = false), Cuts.of(cut))
    }
}
