package dev.crsmith.sidetone

/**
 * 17.10.5 the one cut the phone keeps: the microphone. It is kept on the
 * phone, so a new process opens the microphone only when Chris left it open.
 * Before, it lived in [Bridge.State] only, and after a process death the next
 * room opened the microphone without a word. The audio and the music are the
 * bridge's settings, and the buttons show what the bridge sends (17.10.6).
 */
data class Cuts(val micOn: Boolean = true) {
    fun applyTo(state: Bridge.State) = state.copy(micOn = micOn)

    companion object {
        fun of(state: Bridge.State) = Cuts(state.micOn)
    }
}

/** The cuts by key. `read` gives null for a key that was never written. */
class CutStore(private val read: (String) -> Boolean?, private val write: (String, Boolean) -> Unit) {
    fun load() = Cuts(read(MIC) ?: true)

    fun save(cuts: Cuts) {
        write(MIC, cuts.micOn)
    }

    private companion object {
        const val MIC = "micOn"
    }
}
