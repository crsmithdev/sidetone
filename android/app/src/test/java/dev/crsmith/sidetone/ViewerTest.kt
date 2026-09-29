package dev.crsmith.sidetone

import android.graphics.Bitmap
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/**
 * 17.23 the card of a shown file and the viewer, drawn with no phone and no
 * room. Robolectric has no PDF engine: its PdfRenderer opens a file and finds
 * no pages. So a PDF here is [Pages] drawn by the test, and the phone's
 * [PdfPages] is checked on the phone.
 */
@RunWith(RobolectricTestRunner::class)
class ViewerTest {
    @get:Rule val compose = createComposeRule()

    private val plan = ShownFile("f1", "docs/plan.md", ShownFile.Format.MARKDOWN, text = "# Plan\n\n- **first** step\n- second step")
    private val notes = ShownFile("f2", "notes.txt", ShownFile.Format.TEXT, text = "line 1\nline 2")
    private val paper = ShownFile("f3", "docs/paper.pdf", ShownFile.Format.PDF, url = "https://bridge:3100/shown/f3", bytes = 18_214)

    /** Pages of one colour each, in the shape of an A4 page. */
    private class FakePages(override val count: Int) : Pages {
        var closed = false
        val drawn = mutableListOf<Int>()
        override fun ratio(index: Int) = 297f / 210f
        override fun render(index: Int, width: Int): Bitmap {
            drawn += index
            return Bitmap.createBitmap(width, (width * ratio(index)).toInt(), Bitmap.Config.ARGB_8888)
        }
        override fun close() { closed = true }
    }

    /** A conversation out of the room, as `ScreenTest` draws it, with these files shown. */
    private fun conversation(vararg files: ShownFile, pages: Pages = FakePages(2)): Bridge.State {
        val lines = files.mapIndexed { i, file -> Line(Line.Kind.FILE, file.id, i.toLong()) }
        val state = Bridge.State(paired = true, status = Status.LEFT, screen = OnScreen(lines = lines, files = files.associateBy { it.id }))
        compose.setContent { Conversation(state, onQuit = {}, pages = { _, _ -> pages }) }
        return state
    }

    @Test
    fun theCardShowsTheNameTheKindAndTheFirstLinesFormatted() {
        var opened = 0
        compose.setContent { FileCard(plan, onOpen = { opened++ }) }
        compose.onNodeWithText("docs/plan.md").assertIsDisplayed()
        compose.onNodeWithText("markdown").assertIsDisplayed()
        // 17.19 the markers go: the heading and the bold show as words
        compose.onNodeWithText("Plan", substring = true).assertIsDisplayed()
        compose.onNodeWithText("• first step", substring = true).assertIsDisplayed()
        compose.onNodeWithText("docs/plan.md").performClick()
        assertEquals(1, opened)
    }

    @Test
    fun aPdfCardSaysItsSizeAndShowsNoText() {
        compose.setContent { FileCard(paper, onOpen = {}) }
        compose.onNodeWithText("docs/paper.pdf").assertIsDisplayed()
        compose.onNodeWithText("PDF, 18 KB").assertIsDisplayed()
    }

    @Test
    fun aTapOnTheCardOpensTheViewerAndCloseGoesBack() {
        conversation(notes)
        compose.onNodeWithText("Send").assertExists()
        compose.onNodeWithText("notes.txt").performClick()
        // the viewer takes the whole window: the conversation's controls are gone
        compose.onNodeWithText("Close").assertIsDisplayed()
        compose.onNodeWithText("line 1\nline 2").assertIsDisplayed()
        compose.onNodeWithText("Send").assertDoesNotExist()
        compose.onNodeWithText("Close").performClick()
        compose.onNodeWithText("Send").assertExists()
        compose.onNodeWithText("notes.txt").assertIsDisplayed()
    }

    @Test
    fun theViewerShowsAPdfPageByPageWithWhereYouAre() {
        val pages = FakePages(3)
        conversation(paper, pages = pages)
        compose.onNodeWithText("docs/paper.pdf").performClick()
        compose.waitUntil(5_000) { pages.drawn.isNotEmpty() }
        compose.onNodeWithContentDescription("page 1").assertIsDisplayed()
        compose.onNodeWithText("page 1 of 3").assertIsDisplayed()
        compose.onNodeWithText("Close").performClick()
        compose.waitForIdle()
        // the renderer is closed with the viewer
        assertEquals(true, pages.closed)
    }

    @Test
    fun aPdfThatDoesNotOpenSaysWhy() {
        val state = Bridge.State(paired = true, status = Status.LEFT, screen = OnScreen(lines = listOf(Line(Line.Kind.FILE, "f3", 0)), files = mapOf("f3" to paper)))
        compose.setContent { Conversation(state, onQuit = {}, pages = { _, _ -> throw java.io.IOException("the bridge answered 404") }) }
        compose.onNodeWithText("docs/paper.pdf").performClick()
        compose.onNodeWithText("The PDF did not open: the bridge answered 404").assertIsDisplayed()
    }
}
