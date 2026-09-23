package dev.crsmith.sidetone

import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import org.junit.Assert.assertEquals
import org.junit.Test

class MarkdownTest {
    /** The words that carry a style, in order. */
    private fun AnnotatedString.styled(pick: (androidx.compose.ui.text.SpanStyle) -> Boolean) =
        spanStyles.filter { pick(it.item) }.map { text.substring(it.start, it.end) }

    private fun AnnotatedString.bold() = styled { it.fontWeight == FontWeight.Bold }
    private fun AnnotatedString.italic() = styled { it.fontStyle == FontStyle.Italic }
    private fun AnnotatedString.code() = styled { it.fontFamily == FontFamily.Monospace }

    /** Each link as the words it covers and the address a tap opens. */
    private fun AnnotatedString.links() = getLinkAnnotations(0, length).map {
        text.substring(it.start, it.end) to (it.item as LinkAnnotation.Url).url
    }

    @Test
    fun plainWordsStayAsTheyAre() {
        val shown = markdown("Voice bridge is working, 2 * 3 is 6.")
        assertEquals("Voice bridge is working, 2 * 3 is 6.", shown.text)
        assertEquals(emptyList<Any>(), shown.spanStyles)
    }

    @Test
    fun codeLosesItsTicksAndShowsInMonospace() {
        // from the screen log of 22 September
        val shown = markdown("Found it. `interruptOnSpeech` is on.")
        assertEquals("Found it. interruptOnSpeech is on.", shown.text)
        assertEquals(listOf("interruptOnSpeech"), shown.code())
    }

    @Test
    fun boldAndItalicLoseTheirStars() {
        val shown = markdown("The question: **`p2-flat` or `p2-narrow`.** What moves is the *weight*.")
        assertEquals("The question: p2-flat or p2-narrow. What moves is the weight.", shown.text)
        assertEquals(listOf("p2-flat or p2-narrow."), shown.bold())
        assertEquals(listOf("p2-flat", "p2-narrow"), shown.code())
        assertEquals(listOf("weight"), shown.italic())
    }

    @Test
    fun aMarkerWithNoPartnerStaysAsText_soAGrowingBubbleShowsWhatCameSoFar() {
        assertEquals("the **half", markdown("the **half").text)
        assertEquals("the `half", markdown("the `half").text)
        assertEquals("the [half](http", markdown("the [half](http").text)
    }

    @Test
    fun aNamedLinkShowsItsWordsAndOpensItsAddress() {
        val shown = markdown("- [Anycons - Niagara Launcher Help](https://help.niagaralauncher.app/article/149-anycons)")
        assertEquals("• Anycons - Niagara Launcher Help", shown.text)
        assertEquals(listOf("Anycons - Niagara Launcher Help" to "https://help.niagaralauncher.app/article/149-anycons"), shown.links())
    }

    @Test
    fun aBareAddressIsALink_withoutTheStopThatEndsTheSentence() {
        val shown = markdown("Open https://example.com/a?b=1. Then (see http://x.home/#draw/1).")
        assertEquals("Open https://example.com/a?b=1. Then (see http://x.home/#draw/1).", shown.text)
        assertEquals(
            listOf("https://example.com/a?b=1" to "https://example.com/a?b=1", "http://x.home/#draw/1" to "http://x.home/#draw/1"),
            shown.links(),
        )
    }

    @Test
    fun anAddressInCodeIsStillALink() {
        val shown = markdown("Link: `http://cloudchamber.home/#draw/20260918210334-6067`")
        assertEquals("Link: http://cloudchamber.home/#draw/20260918210334-6067", shown.text)
        assertEquals(listOf("http://cloudchamber.home/#draw/20260918210334-6067"), shown.links().map { it.second })
        assertEquals(listOf("http://cloudchamber.home/#draw/20260918210334-6067"), shown.code())
    }

    @Test
    fun listsKeepTheirShapeWithABulletOrTheirNumber() {
        val shown = markdown("Two fixes:\n\n1. **Sheet one** first\n2. then two\n\n- a\n  * nested")
        assertEquals("Two fixes:\n\n1. Sheet one first\n2. then two\n\n• a\n  • nested", shown.text)
        assertEquals(listOf("Sheet one"), shown.bold())
    }

    @Test
    fun aHeadingIsBoldWithoutItsHashes() {
        val shown = markdown("## The number\n\nThe rehearsal never dials.")
        assertEquals("The number\n\nThe rehearsal never dials.", shown.text)
        assertEquals(listOf("The number"), shown.bold())
    }

    @Test
    fun aFenceIsCodeLineForLine_andItsInsideIsNotMarkdown() {
        val shown = markdown("Read off the server:\n\n```\nROOM **r-1**\n - agent\n```\nDone.")
        assertEquals("Read off the server:\n\nROOM **r-1**\n - agent\nDone.", shown.text)
        assertEquals(listOf("ROOM **r-1**", " - agent"), shown.code())
    }

    @Test
    fun aFenceThatIsStillOpenIsCode() {
        assertEquals(listOf("still coming"), markdown("```kotlin\nstill coming").code())
    }

    @Test
    fun aTableLosesItsRule_andItsHeadIsBold() {
        val shown = markdown("| Where | Real? |\n|---|:---:|\n| Rundown | **Yes.** `x` |")
        assertEquals("Where | Real?\nRundown | Yes. x", shown.text)
        assertEquals(listOf("Where | Real?", "Yes."), shown.bold())
        assertEquals(listOf("x"), shown.code())
    }

    @Test
    fun aQuoteIsItalicWithoutItsMarker() {
        val shown = markdown("> let's use colors that match")
        assertEquals("let's use colors that match", shown.text)
        assertEquals(listOf("let's use colors that match"), shown.italic())
    }
}
