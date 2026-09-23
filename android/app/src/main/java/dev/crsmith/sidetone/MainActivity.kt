package dev.crsmith.sidetone

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageInstaller
import android.content.pm.PackageManager
import android.graphics.BitmapFactory
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Bridge.load(this)
        onInstallStatus(intent)
        enableEdgeToEdge()
        setContent {
            val context = LocalContext.current
            val colors = if (isSystemInDarkTheme()) dynamicDarkColorScheme(context) else dynamicLightColorScheme(context)
            MaterialTheme(colorScheme = colors) {
                Surface(Modifier.fillMaxSize()) {
                    App(onLeave = {
                        Bridge.leave(this)
                        finish()
                    })
                }
            }
        }
    }

    /** 17.18 the system says that Chris took a screenshot of the app. It does not give the image. */
    private val screenCapture = Activity.ScreenCaptureCallback { Bridge.sendScreenshot(System.currentTimeMillis()) }

    override fun onStart() {
        super.onStart()
        Bridge.inFront = true
        registerScreenCaptureCallback(mainExecutor, screenCapture)
    }

    override fun onStop() {
        unregisterScreenCaptureCallback(screenCapture)
        Bridge.inFront = false
        super.onStop()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        onInstallStatus(intent)
    }

    /**
     * 17.15 the system installer reports here. The first report asks Chris to
     * confirm, and the app shows the installer's own screen for that.
     */
    private fun onInstallStatus(intent: Intent?) {
        if (intent?.action != Updater.ACTION_STATUS) return
        when (val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)) {
            PackageInstaller.STATUS_PENDING_USER_ACTION ->
                intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java)?.let(::startActivity)
            PackageInstaller.STATUS_SUCCESS -> Bridge.updateEnded(null)
            PackageInstaller.STATUS_FAILURE_ABORTED -> Bridge.updateEnded("the update was cancelled")
            else -> Bridge.updateEnded("the update failed: ${intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE) ?: "status $status"}")
        }
    }
}

private val PERMISSIONS = arrayOf(
    Manifest.permission.RECORD_AUDIO,
    Manifest.permission.POST_NOTIFICATIONS,
    Manifest.permission.BLUETOOTH_CONNECT,
    // 17.18 the screenshot is read from the phone's images
    Manifest.permission.READ_MEDIA_IMAGES,
)

@Composable
private fun App(onLeave: () -> Unit) {
    val context = LocalContext.current
    val state by Bridge.state.collectAsStateWithLifecycle()
    fun hasMicrophone() = context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
    var microphone by remember { mutableStateOf(hasMicrophone()) }
    val ask = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { microphone = hasMicrophone() }

    LaunchedEffect(Unit) {
        if (PERMISSIONS.any { context.checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED }) ask.launch(PERMISSIONS)
    }
    // the service needs the microphone permission before it starts
    LaunchedEffect(microphone, state.paired) {
        if (microphone && state.paired) Bridge.join(context)
    }

    Box(Modifier.fillMaxSize().safeDrawingPadding().imePadding().padding(16.dp)) {
        when {
            !microphone -> Centered {
                Text("The bridge needs the microphone.", style = MaterialTheme.typography.titleMedium)
                Button(onClick = { ask.launch(PERMISSIONS) }) { Text("Allow the microphone") }
            }
            !state.paired -> Pairing(state.error)
            else -> Conversation(state, onLeave)
        }
    }
}

@Composable
private fun Centered(content: @Composable () -> Unit) {
    Column(
        Modifier.fillMaxSize(),
        verticalArrangement = Arrangement.spacedBy(16.dp, Alignment.CenterVertically),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) { content() }
}

@Composable
private fun Pairing(error: String?) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var busy by remember { mutableStateOf(false) }
    var problem by remember(error) { mutableStateOf(error) }

    Centered {
        Text("Sidetone", style = MaterialTheme.typography.headlineMedium)
        Text(
            "Scan the code the bridge prints when it starts.",
            style = MaterialTheme.typography.bodyLarge,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Button(enabled = !busy, onClick = {
            val options = GmsBarcodeScannerOptions.Builder().setBarcodeFormats(Barcode.FORMAT_QR_CODE).build()
            GmsBarcodeScanning.getClient(context, options).startScan()
                .addOnSuccessListener { barcode ->
                    val link = barcode.rawValue?.let(::parseLink)
                    if (link == null) {
                        problem = "That is not a Sidetone code."
                        return@addOnSuccessListener
                    }
                    busy = true
                    problem = null
                    scope.launch {
                        try {
                            Bridge.pairWith(link)
                        } catch (e: Exception) {
                            problem = e.message ?: "Pairing failed."
                        } finally {
                            busy = false
                        }
                    }
                }
                .addOnFailureListener { problem = it.message }
        }) { Text(if (busy) "Pairing…" else "Scan the code") }
        problem?.let { Text(it, color = MaterialTheme.colorScheme.error) }
    }
}

@Composable
private fun Conversation(state: Bridge.State, onLeave: () -> Unit) {
    var draft by remember { mutableStateOf("") }
    val list = rememberLazyListState()
    // 14.9 a bubble with no words yet is not shown: the block has begun and the first word has not come.
    // 17.18.5 nor is a screenshot that Chris dropped.
    val shown = state.lines.filter { it.text.isNotBlank() && !(it.kind == Line.Kind.SCREENSHOT && state.screenshots[it.text] == "dropped") }
    // the last bubble grows word by word, so the view follows its length as well as the count
    LaunchedEffect(shown.size, shown.lastOrNull()?.text?.length) {
        if (shown.isNotEmpty()) list.animateScrollToItem(shown.lastIndex)
    }
    fun send() {
        val text = draft.trim()
        if (text.isEmpty()) return
        draft = ""
        Bridge.say(text)
    }

    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            val reading = reading(state.status, state.quality, state.sign)
            StatusDot(reading)
            reading.caption?.let { Text(it, style = MaterialTheme.typography.titleMedium) }
            Spacer(Modifier.weight(1f))
            Options(onLeave)
        }
        state.error?.let { ErrorBanner(it) }
        // 17.15 only while the bridge serves an app that is not this one
        if (state.update != null) {
            FilledTonalButton(onClick = Bridge::installUpdate, enabled = !state.updating, modifier = Modifier.fillMaxWidth()) {
                Text(if (state.updating) "Downloading the update…" else "Update the app")
            }
        }
        Box(Modifier.weight(1f).fillMaxWidth()) {
            if (shown.isEmpty()) {
                Text(
                    "Nothing said yet.",
                    modifier = Modifier.align(Alignment.Center),
                    style = MaterialTheme.typography.bodyLarge,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            LazyColumn(Modifier.fillMaxSize(), state = list, verticalArrangement = Arrangement.spacedBy(8.dp)) {
                items(shown) { line ->
                    if (line.kind == Line.Kind.SCREENSHOT) ScreenshotLine(line, state.thumbnails[line.text], state.screenshots[line.text])
                    // 17.21 `shown` keeps the lines themselves, so the spoken line is found by identity
                    else TranscriptLine(line, state.spoken?.takeIf { state.lines.getOrNull(it.first) === line }?.second)
                }
            }
        }
        HoldToTalk(state)
        // 17.10 the three cuts share one row; each keeps its label, and the color shows the state
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Toggle(on = state.micOn, enabled = !state.holding, onClick = { Bridge.setMic(!state.micOn) }, modifier = Modifier.weight(1f)) {
                Text("Mic")
            }
            Toggle(on = state.audioOn, onClick = { Bridge.setAudio(!state.audioOn) }, modifier = Modifier.weight(1f)) {
                Text("Audio")
            }
            Toggle(on = state.musicOn, onClick = { Bridge.setMusic(!state.musicOn) }, modifier = Modifier.weight(1f)) {
                Text("Music")
            }
        }
        OutlinedButton(onClick = Bridge::endTurn, modifier = Modifier.fillMaxWidth(), enabled = state.endTurn != null) { Text("End the turn") }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedTextField(
                value = draft,
                onValueChange = { draft = it },
                modifier = Modifier.weight(1f),
                placeholder = { Text("Type instead") },
                singleLine = true,
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
                keyboardActions = KeyboardActions(onSend = { send() }),
            )
            Button(onClick = ::send) { Text("Send") }
        }
    }
}

/**
 * A button that cuts something (17.10). It is tonal while the thing is on, so
 * the hold to talk button stays the one filled button. While the thing is cut,
 * it takes the error container, so a cut shows at a glance.
 */
@Composable
private fun Toggle(on: Boolean, onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true, content: @Composable RowScope.() -> Unit) {
    val colors = if (on) {
        ButtonDefaults.filledTonalButtonColors()
    } else {
        ButtonDefaults.filledTonalButtonColors(
            containerColor = MaterialTheme.colorScheme.errorContainer,
            contentColor = MaterialTheme.colorScheme.onErrorContainer,
        )
    }
    FilledTonalButton(onClick = onClick, enabled = enabled, colors = colors, modifier = modifier, content = content)
}

/** A problem with the connection, in the error container rather than loose red text. */
@Composable
private fun ErrorBanner(text: String) {
    Surface(color = MaterialTheme.colorScheme.errorContainer, shape = MaterialTheme.shapes.medium, modifier = Modifier.fillMaxWidth()) {
        Text(
            text,
            modifier = Modifier.padding(horizontal = 16.dp, vertical = 12.dp),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onErrorContainer,
        )
    }
}

/**
 * 9.5.1 a hold to talk button, like the one on an old handset. It is enabled
 * while the microphone is cut, and while it is held: opening the microphone
 * must not disable the button under Chris's finger. The gesture follows the
 * pressed state, so a slide off the button or a system cancel also releases.
 */
@Composable
private fun HoldToTalk(state: Bridge.State) {
    val source = remember { MutableInteractionSource() }
    val pressed by source.collectIsPressedAsState()
    LaunchedEffect(pressed) { if (pressed) Bridge.hold() else Bridge.release() }
    // the screen can go while the finger is down, and the microphone must not stay open
    DisposableEffect(Unit) { onDispose { Bridge.release() } }
    Button(
        onClick = {},
        modifier = Modifier.fillMaxWidth().height(96.dp),
        enabled = !state.micOn || state.holding,
        interactionSource = source,
    ) {
        Text(if (state.holding) "Listening — let go to send" else "Hold to talk", style = MaterialTheme.typography.titleLarge)
    }
}

/**
 * 17.11.6 the room in one dot. The colour is the room state, the ring is the
 * connection quality, and the motion is the working sign (17.11): a slow pulse
 * while the agent works, a fast blink when it stalls. The outer size does not
 * change, so the row does not move when the ring goes.
 */
@Composable
private fun StatusDot(reading: Reading) {
    val fill = when (reading.light) {
        Light.GREEN -> Color(0xFF34A853)
        Light.AMBER -> Color(0xFFF9AB00)
        Light.RED -> Color(0xFFEA4335)
    }
    val ring = when (reading.ring) {
        Ring.THICK -> 4.dp
        Ring.MEDIUM -> 2.5.dp
        Ring.THIN -> 1.dp
        null -> 0.dp
    }
    val motion = rememberInfiniteTransition(label = "working")
    val alpha = when (reading.sign) {
        Sign.OFF -> 1f
        Sign.WORKING -> motion.animateFloat(
            initialValue = 0.25f,
            targetValue = 1f,
            animationSpec = infiniteRepeatable(tween(1_600), RepeatMode.Reverse),
            label = "pulse",
        ).value
        Sign.SILENT -> if (motion.animateFloat(0f, 1f, infiniteRepeatable(tween(400)), label = "blink").value < 0.5f) 1f else 0.15f
    }
    val said = listOf(reading.word, signWord(reading.sign)).filter { it.isNotEmpty() }.joinToString(", ")
    Box(
        Modifier.size(32.dp).border(ring, MaterialTheme.colorScheme.onSurface, CircleShape).semantics { contentDescription = said },
        contentAlignment = Alignment.Center,
    ) {
        Box(Modifier.size(22.dp).alpha(alpha).background(fill, CircleShape))
    }
}

/**
 * The options of the app, behind one button at the end of the status row. It
 * holds only "Leave" until the options menu of item 28 exists.
 */
@Composable
private fun Options(onLeave: () -> Unit) {
    var open by remember { mutableStateOf(false) }
    Box {
        TextButton(onClick = { open = true }, modifier = Modifier.semantics { contentDescription = "Options" }) {
            Text("⋮", style = MaterialTheme.typography.titleLarge)
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            DropdownMenuItem(text = { Text("Leave") }, onClick = {
                open = false
                onLeave()
            })
        }
    }
}

/**
 * 17.18.5 the thumbnail of a screenshot the bridge has, on Chris's side. While it
 * is pending it says so, and a tap drops it (14.12.7).
 */
@Composable
private fun ScreenshotLine(line: Line, jpeg: ByteArray?, state: String?) {
    val colors = MaterialTheme.colorScheme
    val image = remember(jpeg) { jpeg?.let { BitmapFactory.decodeByteArray(it, 0, it.size)?.asImageBitmap() } }
    val mark = when (state) {
        "pending" -> "attached to your next message"
        "expired" -> "not sent: it waited too long"
        else -> null
    }
    Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.CenterEnd) {
        Column(
            modifier = Modifier
                .widthIn(max = 160.dp)
                .clickable(enabled = state == "pending") { Bridge.dropScreenshot(line.text) }
                .semantics { contentDescription = listOfNotNull("screenshot", mark).joinToString(", ") },
            horizontalAlignment = Alignment.End,
        ) {
            if (image != null) Image(image, contentDescription = null, modifier = Modifier.clip(MaterialTheme.shapes.medium))
            else Text("screenshot", style = MaterialTheme.typography.bodySmall, color = colors.onSurfaceVariant)
            mark?.let { Text(it, style = MaterialTheme.typography.labelSmall, color = colors.onSurfaceVariant) }
        }
    }
}

@Composable
private fun TranscriptLine(line: Line, spokenEnd: Int? = null) {
    val colors = MaterialTheme.colorScheme
    when (line.kind) {
        // 17.14 each line of words is selectable, so Chris can copy it
        Line.Kind.NOTE -> SelectionContainer {
            Text(
                line.text,
                modifier = Modifier.fillMaxWidth(),
                style = MaterialTheme.typography.bodySmall,
                fontStyle = FontStyle.Italic,
                color = colors.onSurfaceVariant,
            )
        }
        // 17.18.5 the list shows a screenshot with ScreenshotLine
        Line.Kind.SCREENSHOT -> Unit
        Line.Kind.YOU, Line.Kind.BRIDGE -> {
            val you = line.kind == Line.Kind.YOU
            val ink = if (you) colors.onPrimaryContainer else colors.onSurface
            Box(Modifier.fillMaxWidth(), contentAlignment = if (you) Alignment.CenterEnd else Alignment.CenterStart) {
                Column(
                    modifier = Modifier
                        .widthIn(max = 320.dp)
                        .background(if (you) colors.primaryContainer else colors.surfaceContainerHigh, MaterialTheme.shapes.large)
                        .padding(horizontal = 14.dp, vertical = 10.dp),
                ) {
                    // 17.19 the agent's markdown shows formatted; what Chris said stays as the words he said
                    val words = line.text.trim()
                    val shown = remember(words, colors, spokenEnd) {
                        if (you) AnnotatedString(words) else {
                            val formatted = markdown(words, code = colors.surfaceContainerHighest, link = colors.primary)
                            // 17.21 the words after the spoken sentence are grey until the voice reaches them
                            if (spokenEnd == null) formatted else greyAfter(formatted, words, spokenEnd, colors.outline)
                        }
                    }
                    SelectionContainer { Text(shown, color = ink) }
                    // 17.9 the time the bubble began
                    line.at?.let {
                        Text(clock(it), modifier = Modifier.align(Alignment.End), style = MaterialTheme.typography.labelSmall, color = if (you) ink else colors.onSurfaceVariant)
                    }
                }
            }
        }
    }
}
