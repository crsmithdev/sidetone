package dev.crsmith.sidetone

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString

/**
 * 17.21 where the spoken sentence (14.13) is: the index of the newest bubble of
 * the agent that holds it, and where it ends in the trimmed words of that bubble.
 * Null when no bubble holds it.
 */
fun spokenIn(lines: List<Line>, sentence: String): Pair<Int, Int>? {
    if (sentence.isEmpty()) return null
    for (index in lines.indices.reversed()) {
        val line = lines[index]
        if (line.kind != Line.Kind.BRIDGE) continue
        val at = line.text.trim().indexOf(sentence)
        if (at >= 0) return index to at + sentence.length
    }
    return null
}

/**
 * 17.21 the formatted bubble, grey after the spoken sentence. `end` is where the
 * sentence ends in the raw `words`. The grey starts at the length of the words
 * up to `end` once formatted, so a sentence that ends inside a bold or code span
 * can show a slightly wrong edge.
 */
fun greyAfter(shown: AnnotatedString, words: String, end: Int, grey: Color): AnnotatedString {
    val from = markdown(words.substring(0, end.coerceAtMost(words.length))).length
    if (from >= shown.length) return shown
    return buildAnnotatedString {
        append(shown)
        addStyle(SpanStyle(color = grey), from, shown.length)
    }
}
