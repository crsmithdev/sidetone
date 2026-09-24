package dev.crsmith.sidetone

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageInstaller
import android.content.pm.PackageManager
import android.graphics.BitmapFactory
import android.os.Bundle
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
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
import androidx.compose.foundation.layout.width
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
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
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
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.Dp
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
                    App(onQuit = {
                        Bridge.quit(this)
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
private fun App(onQuit: () -> Unit) {
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
            else -> Conversation(state, onQuit)
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
private fun Conversation(state: Bridge.State, onQuit: () -> Unit) {
    var draft by remember { mutableStateOf("") }
    // 17.22 the options screen takes the window under the status row; the gear or a back gesture closes it
    var options by rememberSaveable { mutableStateOf(false) }
    BackHandler(enabled = options) { options = false }
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
            // 17.11.7 the word says the state that the colour shows
            Text(reading.word, style = MaterialTheme.typography.titleMedium)
            Spacer(Modifier.weight(1f))
            OptionsGear(open = options, onToggle = { options = !options })
        }
        if (options) {
            OptionsScreen(
                state.settings,
                state.settingsCount,
                state.build,
                inRoom = state.status != Status.LEFT,
                onClose = { options = false },
                onQuit = onQuit,
                modifier = Modifier.weight(1f),
            )
            return@Column
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
        // 17.11.10 out of the room there is no one to talk to, so the way back in takes the button's place
        if (state.status == Status.LEFT) Rejoin() else HoldToTalk(state)
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
 * 17.11.10 the way back into a room Chris left. It has the place and the size
 * of the hold to talk button, which is where his thumb already goes, and it
 * is the one filled button while he is out.
 */
@Composable
private fun Rejoin() {
    val context = LocalContext.current
    Button(onClick = { Bridge.enter(context) }, modifier = Modifier.fillMaxWidth().height(96.dp)) {
        Text("Rejoin", style = MaterialTheme.typography.titleLarge)
    }
}

/** 17.11.6 the colour of the dot for each room state. */
private fun fill(light: Light) = when (light) {
    Light.GREEN -> Color(0xFF34A853)
    Light.AMBER -> Color(0xFFF9AB00)
    Light.RED -> Color(0xFFEA4335)
    Light.GREY -> Color(0xFF9AA0A6)
}

/**
 * 17.11.6 the dot as the row and the legend draw it: the colour, and a slow
 * pulse while work is in progress. The pulse does not show when the system
 * removes animations, because the animator duration scale is then 0.
 */
@Composable
private fun Dot(light: Light, pulse: Boolean, size: Dp) {
    val context = LocalContext.current
    val still = remember(context) {
        Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f
    }
    val alpha = if (pulse && !still) {
        rememberInfiniteTransition(label = "pulse").animateFloat(
            initialValue = 0.25f,
            targetValue = 1f,
            animationSpec = infiniteRepeatable(tween(1_600), RepeatMode.Reverse),
            label = "pulse",
        ).value
    } else {
        1f
    }
    Box(Modifier.size(size).alpha(alpha).background(fill(light), CircleShape))
}

/**
 * 17.11.6 the room in one dot. The colour says whether the bridge hears
 * Chris, and a slow pulse says work is in progress. A tap opens the legend
 * (17.11.9).
 */
@Composable
private fun StatusDot(reading: Reading) {
    var legend by remember { mutableStateOf(false) }
    val said = listOfNotNull(reading.word, signWord(Sign.WORKING).takeIf { reading.working }).joinToString(", ")
    Box {
        Box(
            Modifier.size(26.dp).clip(CircleShape).clickable(onClickLabel = "Explain the light") { legend = true }
                .semantics { contentDescription = said },
            contentAlignment = Alignment.Center,
        ) {
            Dot(reading.light, reading.pulse, 18.dp)
        }
        DropdownMenu(expanded = legend, onDismissRequest = { legend = false }, modifier = Modifier.width(300.dp)) {
            Legend()
        }
    }
}

/**
 * 17.11.9 what the light means: one row for each colour, with its dots as the
 * row draws them, what the colour means, and the words it can show. Then what
 * the pulse means. It explains and does nothing, so a tap anywhere closes it.
 */
@Composable
private fun Legend() {
    val soft = MaterialTheme.colorScheme.onSurfaceVariant
    val words = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace)
    Column(Modifier.padding(horizontal = 16.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        for (row in LEGEND) {
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Column(Modifier.padding(top = 3.dp).width(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    for (pulse in row.pulses) Dot(row.light, pulse, 14.dp)
                }
                Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text(row.means, style = MaterialTheme.typography.labelLarge)
                    row.detail?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = soft) }
                    if (row.readings.all { it.second == null }) {
                        Text(row.words.joinToString(" · "), style = words, color = soft)
                    } else {
                        for ((reading, line) in row.readings) {
                            Text(
                                buildAnnotatedString {
                                    withStyle(words.toSpanStyle()) { append(reading.word) }
                                    append(": $line")
                                },
                                style = MaterialTheme.typography.bodySmall,
                                color = soft,
                            )
                        }
                    }
                }
            }
        }
        HorizontalDivider()
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Box(Modifier.padding(top = 3.dp)) { Dot(Light.GREEN, pulse = true, 14.dp) }
            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text("A slow pulse: work is in progress.", style = MaterialTheme.typography.labelLarge)
                Text("By the agent when green, by the app when amber or red.", style = MaterialTheme.typography.bodySmall, color = soft)
            }
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
