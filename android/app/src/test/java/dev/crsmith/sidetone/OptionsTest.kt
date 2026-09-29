package dev.crsmith.sidetone

import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertIsNotSelected
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/** 17.22 the options screen, drawn from the settings the bridge sent, with no room. */
@RunWith(RobolectricTestRunner::class)
class OptionsTest {
    @get:Rule val compose = createComposeRule()

    /** Each setting the screen sends, as the bridge would get it. */
    private val sent = mutableListOf<String>()

    private fun show(words: Map<String, String>) {
        compose.setContent {
            OptionsScreen(
                Incoming.Settings(on = emptyMap(), words = words),
                sent = 1,
                build = null,
                inRoom = false,
                onClose = {},
                onQuit = {},
                change = { sent += it.decodeToString() },
            )
        }
    }

    @Test
    fun theModelAndTheEffortShowWhatTheBridgeSentBack() {
        show(mapOf("verbosity" to "normal", "model" to "opus", "effort" to "medium"))
        compose.onNodeWithText("Model").assertExists()
        compose.onNodeWithText("Effort").assertExists()
        compose.onNodeWithText("opus").assertIsSelected()
        compose.onNodeWithText("sonnet").assertIsNotSelected()
        compose.onNodeWithText("medium").assertIsSelected()
        compose.onNodeWithText("default").assertIsNotSelected()
    }

    @Test
    fun aTapSendsTheSettingAndChangesNothingOnTheScreen() {
        show(mapOf("verbosity" to "normal", "model" to "sonnet", "effort" to "default"))
        compose.onNodeWithText("haiku").performClick()
        compose.onNodeWithText("high").performClick()
        assertEquals(listOf(Outgoing.setting("model", "haiku"), Outgoing.setting("effort", "high")).map { it.decodeToString() }, sent)
        // the app keeps no copy: the screen waits for the bridge's settings message
        compose.onNodeWithText("sonnet").assertIsSelected()
        compose.onNodeWithText("haiku").assertIsNotSelected()
    }

    @Test
    fun theNotificationsLevelShowsWhatTheBridgeSentAndATapSendsIt() {
        show(mapOf("verbosity" to "normal", "notifications" to "brief"))
        compose.onNodeWithText("Notifications").assertExists()
        // "brief" and "full" are also levels of the verbosity, which is first on the screen
        compose.onAllNodesWithText("brief")[1].assertIsSelected()
        compose.onNodeWithText("off").assertIsNotSelected()
        compose.onNodeWithText("off").performClick()
        assertEquals(listOf(Outgoing.setting("notifications", "off").decodeToString()), sent)
        // the app keeps no copy: the screen waits for the bridge's settings message
        compose.onAllNodesWithText("brief")[1].assertIsSelected()
    }

    @Test
    fun beforeTheBridgeSendsThemTheyAreDisabled() {
        show(mapOf("verbosity" to "normal"))
        compose.onNodeWithText("opus").assertIsNotEnabled()
        compose.onNodeWithText("low").assertIsNotEnabled()
        compose.onNodeWithText("off").assertIsNotEnabled()
    }
}
