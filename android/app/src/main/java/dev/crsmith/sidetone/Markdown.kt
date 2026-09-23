package dev.crsmith.sidetone

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.withStyle

/**
 * 17.19 the markdown of a bubble, as one styled string. It covers only what the
 * agent writes: code, fences, bold, italic, links, headings, lists, quotes and
 * tables. The markers go, so the text of the result is what a copy gives (17.14).
 * A marker with no partner stays as text, because a bubble grows word by word (14.9.2).
 */
fun markdown(source: String, code: Color = Color.Unspecified, link: Color = Color.Unspecified): AnnotatedString {
    val codeStyle = SpanStyle(fontFamily = FontFamily.Monospace, background = code)
    val linkStyle = TextLinkStyles(SpanStyle(color = link, textDecoration = TextDecoration.Underline))
    val lines = source.lines()
    return buildAnnotatedString {
        val inline = Inline(this, codeStyle, linkStyle)
        var fenced = false
        var first = true
        for ((index, line) in lines.withIndex()) {
            if (line.trimStart().startsWith("```")) {
                fenced = !fenced
                continue
            }
            if (!fenced && TABLE_RULE.matches(line)) continue
            if (!first) append('\n')
            first = false
            if (fenced) {
                withStyle(codeStyle) { append(line) }
                continue
            }
            // a row over a rule is the head of the table
            val head = lines.getOrNull(index + 1)?.let(TABLE_RULE::matches) == true
            block(line, head, inline)
        }
    }
}

private fun AnnotatedString.Builder.block(line: String, head: Boolean, inline: Inline) {
    HEADING.matchEntire(line)?.let {
        withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { inline.add(it.groupValues[1]) }
        return
    }
    BULLET.matchEntire(line)?.let {
        append(it.groupValues[1])
        append("• ")
        inline.add(it.groupValues[2])
        return
    }
    QUOTE.matchEntire(line)?.let {
        withStyle(SpanStyle(fontStyle = FontStyle.Italic)) { inline.add(it.groupValues[1]) }
        return
    }
    TABLE_ROW.matchEntire(line)?.let {
        val cells = it.groupValues[1].split('|').map(String::trim)
        val row = { cells.forEachIndexed { at, cell -> if (at > 0) append(" | "); inline.add(cell) } }
        if (head) withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { row() } else row()
        return
    }
    inline.add(line)
}

private val HEADING = Regex("""#{1,6} +(.*)""")
private val BULLET = Regex("""( *)[-*+] +(.*)""")
private val QUOTE = Regex("""> ?(.*)""")
private val TABLE_ROW = Regex("""\|(.*)\|\s*""")
private val TABLE_RULE = Regex("""\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*""")
private val URL = Regex("""https?://[^\s<>`]+""")

/** The markdown inside one line. A numbered item needs nothing: its number is already text. */
private class Inline(val out: AnnotatedString.Builder, val codeStyle: SpanStyle, val linkStyle: TextLinkStyles) {
    fun add(text: String) {
        var at = 0
        while (at < text.length) {
            at = code(text, at) ?: bold(text, at) ?: italic(text, at) ?: named(text, at) ?: bare(text, at) ?: run {
                out.append(text[at])
                at + 1
            }
        }
    }

    private fun code(text: String, at: Int): Int? {
        if (text[at] != '`') return null
        val end = text.indexOf('`', at + 1)
        if (end <= at + 1) return null
        val inside = text.substring(at + 1, end)
        // the agent puts an address in code more often than not, and it is still an address
        if (URL.matches(inside)) {
            out.withLink(LinkAnnotation.Url(inside, linkStyle)) { out.withStyle(codeStyle) { out.append(inside) } }
        } else {
            out.withStyle(codeStyle) { out.append(inside) }
        }
        return end + 1
    }

    private fun bold(text: String, at: Int): Int? {
        if (!text.startsWith("**", at)) return null
        val end = text.indexOf("**", at + 2)
        if (end <= at + 2 || text[at + 2].isWhitespace() || text[end - 1].isWhitespace()) return null
        out.withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { add(text.substring(at + 2, end)) }
        return end + 2
    }

    private fun italic(text: String, at: Int): Int? {
        if (text[at] != '*' || text.getOrNull(at + 1)?.let { it == '*' || it.isWhitespace() } != false) return null
        var end = text.indexOf('*', at + 1)
        while (end > 0 && text.getOrNull(end + 1) == '*') end = text.indexOf('*', end + 2)
        if (end < 0 || text[end - 1].isWhitespace()) return null
        out.withStyle(SpanStyle(fontStyle = FontStyle.Italic)) { add(text.substring(at + 1, end)) }
        return end + 1
    }

    /** `[words](address)`: the words show, and a tap opens the address. */
    private fun named(text: String, at: Int): Int? {
        if (text[at] != '[') return null
        val close = text.indexOf("](", at + 1)
        if (close < 0) return null
        val end = text.indexOf(')', close + 2)
        if (end < 0) return null
        val url = text.substring(close + 2, end)
        if (url.isBlank() || url.any(Char::isWhitespace)) return null
        out.withLink(LinkAnnotation.Url(url, linkStyle)) { add(text.substring(at + 1, close)) }
        return end + 1
    }

    private fun bare(text: String, at: Int): Int? {
        val found = URL.matchAt(text, at) ?: return null
        // the stop at the end of a sentence is not part of the address
        val url = found.value.trimEnd('.', ',', ';', ':', '!', '?', ')', '*', '\'', '"')
        out.withLink(LinkAnnotation.Url(url, linkStyle)) { out.append(url) }
        return at + url.length
    }
}
