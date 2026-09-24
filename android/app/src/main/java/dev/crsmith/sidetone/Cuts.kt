package dev.crsmith.sidetone

/**
 * 17.10.5 the three cuts of the button row. They are kept on the phone, so a
 * new process opens the microphone only when Chris left it open. Before,
 * they lived in [Bridge.State] only, and after a process death the next room
 * opened the microphone without a word.
 */
data class Cuts(val micOn: Boolean = true, val audioOn: Boolean = true, val musicOn: Boolean = true) {
    fun applyTo(state: Bridge.State) = state.copy(micOn = micOn, audioOn = audioOn, musicOn = musicOn)

    companion object {
        fun of(state: Bridge.State) = Cuts(state.micOn, state.audioOn, state.musicOn)
    }
}

/** The cuts by key. `read` gives null for a key that was never written. */
class CutStore(private val read: (String) -> Boolean?, private val write: (String, Boolean) -> Unit) {
    fun load() = Cuts(read(MIC) ?: true, read(AUDIO) ?: true, read(MUSIC) ?: true)

    fun save(cuts: Cuts) {
        write(MIC, cuts.micOn)
        write(AUDIO, cuts.audioOn)
        write(MUSIC, cuts.musicOn)
    }

    private companion object {
        const val MIC = "micOn"
        const val AUDIO = "audioOn"
        const val MUSIC = "musicOn"
    }
}
