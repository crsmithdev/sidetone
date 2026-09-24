package dev.crsmith.sidetone

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Slider
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.unit.dp
import kotlin.math.roundToInt

/** 9.4.10 the levels of the verbosity, shortest first. */
private val LEVELS = listOf("brief", "normal", "full")

/** 17.22.6 the end-of-turn pause moves one step a tap, between these two. */
private const val PAUSE_STEP_MS = 100
private const val PAUSE_MIN_MS = 500
private const val PAUSE_MAX_MS = 3_000

/**
 * 17.22 the options menu, behind the gear at the end of the status row.
 * Each control sends the `setting` message (9.4.9), so the bridge does what
 * the spoken command does. Each shows what the bridge last sent back, and is
 * disabled until the bridge has sent it. `sent` counts the settings messages,
 * for the sliders (17.22.5). "Leave" keeps the app open (17.11.10) and "Quit"
 * closes it (17.22.4); out of the room only "Quit" shows.
 */
@Composable
fun Options(settings: Incoming.Settings, sent: Int, build: String?, inRoom: Boolean, onQuit: () -> Unit) {
    val context = LocalContext.current
    var open by remember { mutableStateOf(false) }
    Box {
        IconButton(onClick = { open = true }) {
            Icon(painterResource(R.drawable.ic_gear), contentDescription = "Options")
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }, modifier = Modifier.width(288.dp)) {
            Verbosity(settings.words["verbosity"])
            Tones(settings.on["tones"])
            Level("Hold music volume", "holdMusicGain", settings.numbers["holdMusicGain"], 0f..1f, sent)
            Level("Barge-in level", "bargeInLevel", settings.numbers["bargeInLevel"], 0f..0.2f, sent)
            Level("Quietest speech peak", "minSpeechPeak", settings.numbers["minSpeechPeak"], 0f..0.5f, sent)
            Pause(settings.numbers["endOfTurnPauseMs"])
            HorizontalDivider()
            if (inRoom) {
                DropdownMenuItem(text = { Text("Leave") }, onClick = {
                    open = false
                    Bridge.leave(context)
                })
            }
            DropdownMenuItem(text = { Text("Quit") }, onClick = {
                open = false
                onQuit()
            })
            // 14.15 the first 12 characters of the SHA-256, as the bridge's journal gives them
            DropdownMenuItem(text = { Text("Build ${build?.take(12) ?: "unknown"}") }, onClick = {}, enabled = false)
        }
    }
}

/** 17.22.1 the three levels, as "verbosity brief", "verbosity normal" and "verbosity full" set them. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun Verbosity(level: String?) {
    Column(Modifier.padding(horizontal = 12.dp, vertical = 8.dp)) {
        Text("Verbosity", style = MaterialTheme.typography.labelLarge)
        SingleChoiceSegmentedButtonRow {
            LEVELS.forEachIndexed { index, each ->
                SegmentedButton(
                    selected = level == each,
                    onClick = { Bridge.change(Outgoing.setting("verbosity", each)) },
                    shape = SegmentedButtonDefaults.itemShape(index, LEVELS.size),
                    enabled = level != null,
                ) { Text(each) }
            }
        }
    }
}

/** 17.22.2 the tones, as "tones on" and "tones off" set them. */
@Composable
private fun Tones(on: Boolean?) {
    DropdownMenuItem(
        text = { Text("Tones") },
        onClick = { if (on != null) Bridge.change(Outgoing.setting("tones", !on)) },
        enabled = on != null,
        trailingIcon = { Switch(checked = on == true, onCheckedChange = null, enabled = on != null) },
    )
}

/**
 * 17.22.3 and 17.22.5 a level, as a fraction of full scale: the hold music
 * volume, the barge-in level and the quietest speech peak. The slider moves
 * under the finger and sends once, when the finger lifts. Each settings
 * message puts it back to what the bridge holds, so a value the bridge
 * refused does not stay under the thumb. The label shows the bridge's value.
 */
@Composable
private fun Level(label: String, name: String, value: Double?, range: ClosedFloatingPointRange<Float>, sent: Int) {
    var shown by remember(sent) { mutableFloatStateOf(value?.toFloat() ?: 0f) }
    Column(Modifier.padding(horizontal = 12.dp, vertical = 8.dp)) {
        Text(if (value == null) label else "$label $value", style = MaterialTheme.typography.labelLarge)
        Slider(
            value = shown,
            onValueChange = { shown = it },
            onValueChangeFinished = { Bridge.change(Outgoing.setting(name, (shown * 100).roundToInt() / 100.0)) },
            valueRange = range,
            enabled = value != null,
        )
    }
}

/**
 * 17.22.6 the end-of-turn pause, `endOfTurnPauseMs` on the bridge. A pause is
 * tried a step at a time, so it is two buttons and not a slider: each tap
 * sends the bridge's value moved by one step, and the text is the bridge's
 * value alone. The buttons stop at the ends of the range.
 */
@Composable
private fun Pause(ms: Double?) {
    val held = ms?.roundToInt()
    Row(Modifier.padding(horizontal = 12.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        Text("End-of-turn pause", style = MaterialTheme.typography.labelLarge, modifier = Modifier.weight(1f))
        TextButton(
            onClick = { held?.let { Bridge.change(Outgoing.setting("endOfTurnPauseMs", it - PAUSE_STEP_MS)) } },
            enabled = held != null && held - PAUSE_STEP_MS >= PAUSE_MIN_MS,
        ) { Text("\u2212") }
        Text(if (held == null) "\u2014" else "${held / 100 / 10.0} s")
        TextButton(
            onClick = { held?.let { Bridge.change(Outgoing.setting("endOfTurnPauseMs", it + PAUSE_STEP_MS)) } },
            enabled = held != null && held + PAUSE_STEP_MS <= PAUSE_MAX_MS,
        ) { Text("+") }
    }
}
