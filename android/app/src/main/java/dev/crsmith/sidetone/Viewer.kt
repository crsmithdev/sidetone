package dev.crsmith.sidetone

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Color as AndroidColor
import android.graphics.pdf.PdfRenderer
import android.os.ParcelFileDescriptor
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.calculatePan
import androidx.compose.foundation.gestures.calculateZoom
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import java.io.Closeable
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * 17.23 a shown file: its card in the transcript, and the viewer a tap on the
 * card opens. Read only: the viewer shows the file and never changes it.
 */

/** 17.23.5 the pages of a PDF as images. [PdfPages] is the phone's; a test gives its own. */
interface Pages : Closeable {
    val count: Int

    /** The height of page `index` over its width. */
    fun ratio(index: Int): Float

    /** Page `index`, drawn `width` pixels wide on white. */
    fun render(index: Int, width: Int): Bitmap
}

/** 17.23.5 the system's renderer. It opens one page at a time, so each call holds the lock. */
class PdfPages(file: File) : Pages {
    private val renderer = PdfRenderer(ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY))
    override val count: Int = renderer.pageCount

    @Synchronized
    override fun ratio(index: Int): Float = renderer.openPage(index).use { it.height.toFloat() / it.width }

    @Synchronized
    override fun render(index: Int, width: Int): Bitmap = renderer.openPage(index).use { page ->
        val bitmap = Bitmap.createBitmap(width, (width.toLong() * page.height / page.width).toInt(), Bitmap.Config.ARGB_8888)
        bitmap.eraseColor(AndroidColor.WHITE)
        page.render(bitmap, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
        bitmap
    }

    @Synchronized
    override fun close() = renderer.close()
}

/**
 * 17.23.5 download a shown PDF from the bridge, once, into the cache. The id is
 * new for each show, so a file of the same name shown again is fetched again.
 */
suspend fun downloadPages(context: Context, file: ShownFile): Pages = withContext(Dispatchers.IO) {
    val dir = File(context.cacheDir, "shown").apply { mkdirs() }
    val kept = File(dir, "${file.id}.pdf")
    if (!kept.exists()) {
        val part = File(dir, "${file.id}.part")
        val connection = URL(file.url).openConnection() as HttpURLConnection
        try {
            connection.connectTimeout = 10_000
            connection.readTimeout = 30_000
            if (connection.responseCode != 200) throw IOException("the bridge answered ${connection.responseCode}")
            part.outputStream().use { out -> connection.inputStream.use { it.copyTo(out, 64 * 1024) } }
        } finally {
            connection.disconnect()
        }
        part.renameTo(kept)
    }
    PdfPages(kept)
}

/** 17.23.4 what the card says under the name. */
fun fileWords(file: ShownFile): String = when (file.format) {
    ShownFile.Format.MARKDOWN -> "markdown"
    ShownFile.Format.TEXT -> "text"
    ShownFile.Format.PDF -> "PDF, ${size(file.bytes)}"
}

private fun size(bytes: Long): String = when {
    bytes >= 1_000_000 -> "%.1f MB".format(bytes / 1_000_000.0)
    bytes >= 1_000 -> "${bytes / 1_000} KB"
    else -> "$bytes bytes"
}

/** 17.23.4 how many lines of a text file the card shows. */
private const val CARD_LINES = 6

/** The words of a text file, formatted as a bubble formats the agent's (17.19) when it is markdown. */
@Composable
private fun formatted(file: ShownFile): AnnotatedString {
    val colors = MaterialTheme.colorScheme
    return remember(file.id, colors) {
        if (file.format == ShownFile.Format.MARKDOWN) markdown(file.text, code = colors.surfaceContainerHighest, link = colors.primary)
        else AnnotatedString(file.text)
    }
}

/**
 * 17.23.4 the card of a shown file, on the agent's side: the name, the kind,
 * and the first lines of a text file. A tap opens the viewer.
 */
@Composable
internal fun FileCard(file: ShownFile, onOpen: () -> Unit) {
    val colors = MaterialTheme.colorScheme
    Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.CenterStart) {
        Column(
            modifier = Modifier
                .widthIn(max = 320.dp)
                .background(colors.surfaceContainerHigh, MaterialTheme.shapes.large)
                .clickable(onClickLabel = "open", onClick = onOpen)
                .padding(horizontal = 14.dp, vertical = 10.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            Text(file.name, style = MaterialTheme.typography.titleSmall, fontFamily = FontFamily.Monospace)
            Text(fileWords(file), style = MaterialTheme.typography.labelSmall, color = colors.onSurfaceVariant)
            if (file.format != ShownFile.Format.PDF) {
                val words = formatted(file)
                Text(
                    words,
                    maxLines = CARD_LINES,
                    overflow = TextOverflow.Ellipsis,
                    style = MaterialTheme.typography.bodySmall,
                    fontFamily = if (file.format == ShownFile.Format.TEXT) FontFamily.Monospace else null,
                )
            }
        }
    }
}

/**
 * 17.23.5 the viewer: the whole file, over the whole window. Close or a back
 * gesture goes back to the conversation. `pages` opens a PDF.
 */
@Composable
internal fun FileViewer(file: ShownFile, onClose: () -> Unit, pages: suspend (ShownFile) -> Pages) {
    Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                file.name,
                modifier = Modifier.weight(1f),
                style = MaterialTheme.typography.titleMedium,
                fontFamily = FontFamily.Monospace,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
            TextButton(onClick = onClose) { Text("Close") }
        }
        Box(Modifier.weight(1f).fillMaxWidth()) {
            if (file.format == ShownFile.Format.PDF) PdfView(file, pages)
            else TextView(file)
        }
    }
}

@Composable
private fun TextView(file: ShownFile) {
    val words = formatted(file)
    // 17.14 the words are selectable, as a bubble's are
    SelectionContainer(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
        Text(
            words,
            style = MaterialTheme.typography.bodyMedium,
            fontFamily = if (file.format == ShownFile.Format.TEXT) FontFamily.Monospace else null,
        )
    }
}

/** 17.23.5 the most a page is zoomed, over the width of the window. */
private const val MAX_ZOOM = 5f

/**
 * 17.23.5 the pages one under another, as wide as the window. One finger
 * scrolls; two pinch the zoom and pan. While zoomed, one finger pans, and a
 * pan past the top or the bottom of the page scrolls to the next.
 */
@Composable
private fun PdfView(file: ShownFile, open: suspend (ShownFile) -> Pages) {
    var opened by remember(file.id) { mutableStateOf<Pages?>(null) }
    var problem by remember(file.id) { mutableStateOf<String?>(null) }
    LaunchedEffect(file.id) {
        try {
            opened = open(file)
        } catch (e: Exception) {
            problem = "The PDF did not open: ${e.message ?: e}"
        }
    }
    DisposableEffect(file.id) { onDispose { opened?.close() } }
    val pages = opened
    when {
        problem != null -> Text(problem!!, color = MaterialTheme.colorScheme.error)
        pages == null -> Text("Downloading ${fileWords(file)}…", color = MaterialTheme.colorScheme.onSurfaceVariant)
        pages.count == 0 -> Text("The PDF has no pages.", color = MaterialTheme.colorScheme.onSurfaceVariant)
        else -> PageList(pages)
    }
}

@Composable
private fun PageList(pages: Pages) {
    val list = rememberLazyListState()
    var scale by remember { mutableFloatStateOf(1f) }
    var offset by remember { mutableStateOf(Offset.Zero) }
    BoxWithConstraints(Modifier.fillMaxSize().clipToBounds()) {
        val width = constraints.maxWidth
        val height = constraints.maxHeight
        // a page is drawn wider than the window, so a zoom stays sharp for a while
        val drawn = (width * 3 / 2).coerceAtMost(1_600)
        Box(
            Modifier
                .fillMaxSize()
                .pointerInput(Unit) {
                    awaitEachGesture {
                        awaitFirstDown(requireUnconsumed = false)
                        do {
                            // the Initial pass sees the fingers before the list does, so a pinch is not a scroll
                            val event = awaitPointerEvent(PointerEventPass.Initial)
                            if (event.changes.size < 2 && scale == 1f) continue
                            scale = (scale * event.calculateZoom()).coerceIn(1f, MAX_ZOOM)
                            val pan = event.calculatePan()
                            val maxX = (scale - 1f) * width / 2
                            val maxY = (scale - 1f) * height / 2
                            val y = offset.y + pan.y
                            val kept = y.coerceIn(-maxY, maxY)
                            offset = Offset((offset.x + pan.x).coerceIn(-maxX, maxX), kept)
                            // what the pan moves past the edge of the zoomed page scrolls the list
                            if (y != kept) list.dispatchRawDelta((kept - y) / scale)
                            event.changes.forEach { it.consume() }
                        } while (event.changes.any { it.pressed })
                    }
                },
        ) {
            LazyColumn(
                Modifier.fillMaxSize().graphicsLayer {
                    scaleX = scale
                    scaleY = scale
                    translationX = offset.x
                    translationY = offset.y
                },
                state = list,
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                items(pages.count) { index -> Page(pages, index, drawn) }
            }
        }
        val first = list.firstVisibleItemIndex + 1
        Text(
            "page $first of ${pages.count}",
            modifier = Modifier
                .align(Alignment.BottomEnd)
                .padding(8.dp)
                .background(MaterialTheme.colorScheme.surfaceContainerHighest, MaterialTheme.shapes.small)
                .padding(horizontal = 8.dp, vertical = 4.dp),
            style = MaterialTheme.typography.labelMedium,
        )
    }
}

@Composable
private fun Page(pages: Pages, index: Int, width: Int) {
    val ratio = remember(pages, index) { pages.ratio(index) }
    val image by produceState<ImageBitmap?>(null, pages, index, width) {
        value = withContext(Dispatchers.IO) { pages.render(index, width).asImageBitmap() }
    }
    val described = Modifier.fillMaxWidth().aspectRatio(1f / ratio).semantics { contentDescription = "page ${index + 1}" }
    image?.let { Image(it, contentDescription = null, modifier = described) } ?: Box(described.background(Color.White))
}
