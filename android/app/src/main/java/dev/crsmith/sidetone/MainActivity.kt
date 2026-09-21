package dev.crsmith.sidetone

import android.Manifest
import android.content.pm.PackageManager
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
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
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
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
}

private val PERMISSIONS = arrayOf(
    Manifest.permission.RECORD_AUDIO,
    Manifest.permission.POST_NOTIFICATIONS,
    Manifest.permission.BLUETOOTH_CONNECT,
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
    LaunchedEffect(state.lines.size) {
        if (state.lines.isNotEmpty()) list.animateScrollToItem(state.lines.lastIndex)
    }
    fun send() {
        val text = draft.trim()
        if (text.isEmpty()) return
        draft = ""
        Bridge.say(text)
    }

    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            val live = state.status == Bridge.Status.LISTENING
            Box(Modifier.size(10.dp).background(if (live) Color(0xFF3DDC84) else MaterialTheme.colorScheme.outline, CircleShape))
            Text(statusWord(state.status), style = MaterialTheme.typography.titleMedium)
            Text(state.quality ?: "—", color = MaterialTheme.colorScheme.onSurfaceVariant)
            Spacer(Modifier.weight(1f))
            TextButton(onClick = onLeave) { Text("Leave") }
        }
        state.error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        LazyColumn(Modifier.weight(1f).fillMaxWidth(), state = list, verticalArrangement = Arrangement.spacedBy(8.dp)) {
            items(state.lines) { TranscriptLine(it) }
        }
        HoldToTalk(state)
        Button(onClick = { Bridge.setMic(!state.micOn) }, enabled = !state.holding, modifier = Modifier.fillMaxWidth()) {
            Text(if (state.micOn) "Cut the microphone" else "Microphone off — tap to resume")
        }
        Button(onClick = { Bridge.setVoice(!state.voiceOn) }, modifier = Modifier.fillMaxWidth()) {
            Text(if (state.voiceOn) "Cut the voice" else "Voice off — tap to resume")
        }
        OutlinedButton(
            onClick = Bridge::endTurn,
            modifier = Modifier.fillMaxWidth(),
            enabled = state.endTurn != null,
        ) { Text("End the turn") }
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

private fun statusWord(status: Bridge.Status) = when (status) {
    Bridge.Status.IDLE, Bridge.Status.CONNECTING -> "connecting"
    Bridge.Status.LISTENING -> "listening"
    Bridge.Status.RECONNECTING -> "reconnecting"
    Bridge.Status.UNREACHABLE -> "disconnected"
}

@Composable
private fun TranscriptLine(line: Line) {
    val colors = MaterialTheme.colorScheme
    when (line.kind) {
        Line.Kind.NOTE -> Text(
            line.text,
            modifier = Modifier.fillMaxWidth(),
            style = MaterialTheme.typography.bodySmall,
            fontStyle = FontStyle.Italic,
            color = colors.onSurfaceVariant,
        )
        Line.Kind.YOU, Line.Kind.BRIDGE -> {
            val you = line.kind == Line.Kind.YOU
            Box(Modifier.fillMaxWidth(), contentAlignment = if (you) Alignment.CenterEnd else Alignment.CenterStart) {
                Text(
                    line.text,
                    modifier = Modifier
                        .widthIn(max = 320.dp)
                        .background(if (you) colors.primaryContainer else colors.surfaceVariant, RoundedCornerShape(16.dp))
                        .padding(horizontal = 14.dp, vertical = 10.dp),
                    color = if (you) colors.onPrimaryContainer else colors.onSurfaceVariant,
                )
            }
        }
    }
}
