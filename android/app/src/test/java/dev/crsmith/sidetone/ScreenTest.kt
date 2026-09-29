package dev.crsmith.sidetone

import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/** The conversation screen, drawn from a state, with no phone and no room. */
@RunWith(RobolectricTestRunner::class)
class ScreenTest {
    @get:Rule val compose = createComposeRule()

    /**
     * Out of the room, so the screen shows Rejoin. The hold to talk button
     * calls [Bridge] as it draws, and no [Bridge] runs here.
     */
    private fun show(state: Bridge.State = Bridge.State(paired = true, status = Status.LEFT)) {
        compose.setContent { Conversation(state, onQuit = {}) }
    }

    @Test
    fun theScreenHasNoEndTheTurnButton() {
        show()
        compose.onNodeWithText("Send").assertExists()
        compose.onNodeWithText("End the turn").assertDoesNotExist()
    }
}
