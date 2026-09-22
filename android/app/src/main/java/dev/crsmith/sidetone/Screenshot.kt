package dev.crsmith.sidetone

import android.content.ContentResolver
import android.content.ContentUris
import android.content.Context
import android.graphics.Bitmap
import android.graphics.ImageDecoder
import android.net.Uri
import android.os.Bundle
import android.provider.MediaStore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream
import java.util.Base64
import kotlin.math.roundToInt

/** 17.18 the longest edge of the image the app sends, in pixels. */
const val SCREENSHOT_EDGE = 1_080

/** 17.18 the JPEG quality of the image the app sends. */
const val SCREENSHOT_QUALITY = 70

/**
 * 14.12 the size of one part of a screenshot, in bytes. The data channel carries
 * about 15 KiB. The part holds base64, which is 4 bytes for each 3 of the image.
 */
const val SCREENSHOT_PART_BYTES = 12_000

/** Room in a part for what is not the image: the kind, the id and the two numbers. */
private const val SCREENSHOT_ENVELOPE_BYTES = 128

/** 17.18 how often, and how many times, the app looks for the new screenshot, which the system can write late. */
private const val FIND_MS = 500L
private const val FIND_TRIES = 10

/** 17.18 a screenshot added this many seconds before the callback is still the new one. */
private const val FIND_SLACK_S = 2

/**
 * 14.12 one image as messages for the bridge, each of at most `limit` bytes,
 * because one data message is small. Each part holds a slice of the base64 of
 * the image. A slice is a multiple of 4 characters, so each part decodes alone.
 */
fun screenshotParts(jpeg: ByteArray, id: String, limit: Int = SCREENSHOT_PART_BYTES): List<ByteArray> {
    val data = Base64.getEncoder().encodeToString(jpeg)
    val size = (limit - SCREENSHOT_ENVELOPE_BYTES) / 4 * 4
    val slices = if (data.isEmpty()) listOf("") else data.chunked(size)
    return slices.mapIndexed { index, slice -> Outgoing.screenshot(id, index + 1, slices.size, slice) }
}

/** 17.18 the size that fits `width` by `height` into `edge` on its longest side. A smaller image keeps its size. */
fun fitted(width: Int, height: Int, edge: Int = SCREENSHOT_EDGE): Pair<Int, Int> {
    val scale = edge.toDouble() / maxOf(width, height)
    if (scale >= 1) return width to height
    return maxOf(1, (width * scale).roundToInt()) to maxOf(1, (height * scale).roundToInt())
}

/**
 * 17.18 the screenshot added since `at`, in milliseconds, as a small JPEG, or
 * null when there is none. It needs READ_MEDIA_IMAGES.
 */
suspend fun newestScreenshot(context: Context, at: Long): ByteArray? = withContext(Dispatchers.IO) {
    val resolver = context.contentResolver
    repeat(FIND_TRIES) {
        find(resolver, at / 1_000 - FIND_SLACK_S)?.let { return@withContext shrink(resolver, it) }
        delay(FIND_MS)
    }
    null
}

/** The newest image in a Screenshots directory, added at or after `since`, in seconds. */
private fun find(resolver: ContentResolver, since: Long): Uri? {
    val images = MediaStore.Images.Media.EXTERNAL_CONTENT_URI
    val query = Bundle().apply {
        putString(
            ContentResolver.QUERY_ARG_SQL_SELECTION,
            "${MediaStore.Images.Media.RELATIVE_PATH} LIKE ? AND ${MediaStore.Images.Media.DATE_ADDED} >= ?",
        )
        putStringArray(ContentResolver.QUERY_ARG_SQL_SELECTION_ARGS, arrayOf("%Screenshots%", since.toString()))
        putStringArray(ContentResolver.QUERY_ARG_SORT_COLUMNS, arrayOf(MediaStore.Images.Media.DATE_ADDED))
        putInt(ContentResolver.QUERY_ARG_SORT_DIRECTION, ContentResolver.QUERY_SORT_DIRECTION_DESCENDING)
        putInt(ContentResolver.QUERY_ARG_LIMIT, 1)
    }
    resolver.query(images, arrayOf(MediaStore.Images.Media._ID), query, null)?.use { cursor ->
        if (cursor.moveToFirst()) return ContentUris.withAppendedId(images, cursor.getLong(0))
    }
    return null
}

private fun shrink(resolver: ContentResolver, uri: Uri): ByteArray {
    val bitmap = ImageDecoder.decodeBitmap(ImageDecoder.createSource(resolver, uri)) { decoder, info, _ ->
        // a hardware bitmap cannot always be compressed
        decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
        val (width, height) = fitted(info.size.width, info.size.height)
        decoder.setTargetSize(width, height)
    }
    return ByteArrayOutputStream().use { out ->
        bitmap.compress(Bitmap.CompressFormat.JPEG, SCREENSHOT_QUALITY, out)
        bitmap.recycle()
        out.toByteArray()
    }
}
