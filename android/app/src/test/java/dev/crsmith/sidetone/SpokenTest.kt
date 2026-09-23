package dev.crsmith.sidetone

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.LinkAnnotation
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Test

class SpokenTest {
    /** The words that show grey, in order. */
    private fun greyOf(words: String, end: Int) = greyAfter(markdown(words), words, end, Color.Gray).let { shown ->
        shown.spanStyles.filter { it.item.color == Color.Gray }.map { shown.text.substring(it.start, it.end) }
    }

    @Test
    fun theNewestBubbleOfTheAgentThatHoldsTheSentenceIsFound() {
        val lines = listOf(
            Line(Line.Kind.BRIDGE, "Done. Next."),
            Line(Line.Kind.YOU, "Done."),
            Line(Line.Kind.BRIDGE, "  Okay. Done. More."),
            Line(Line.Kind.NOTE, "Done."),
        )
        // the end is counted in the trimmed words, as the bubble shows them
        assertEquals(2 to 11, spokenIn(lines, "Done."))
        assertEquals(0 to 11, spokenIn(lines, "Next."))
        assertNull(spokenIn(lines, "Never said."))
        assertNull(spokenIn(lines, ""))
    }

    @Test
    fun theWordsAfterTheSpokenSentenceAreGrey() {
        assertEquals(listOf(" Two. Three."), greyOf("One. Two. Three.", 4))
        // the last sentence spoken greys nothing
        val words = "One. Two."
        val shown = markdown(words)
        assertSame(shown, greyAfter(shown, words, words.length, Color.Gray))
    }

    @Test
    fun theGreyStartsWhereTheFormattedWordsOfTheSentenceEnd() {
        // the markers go, so the raw end is 4 characters further on than the shown one
        assertEquals(listOf(" Then this."), greyOf("Use **bold** now. Then `this`.", 17))
    }

    @Test
    fun theFormattingAndTheLinksStayUnderTheGrey() {
        val words = "Look. See **this** at https://example.com now."
        val shown = greyAfter(markdown(words), words, 5, Color.Gray)
        assertEquals(markdown(words).text, shown.text)
        assertEquals(listOf("https://example.com"), shown.getLinkAnnotations(0, shown.length).map { (it.item as LinkAnnotation.Url).url })
        assertEquals(1, shown.spanStyles.count { it.item.fontWeight != null })
    }
}
