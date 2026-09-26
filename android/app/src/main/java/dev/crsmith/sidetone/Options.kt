package dev.crsmith.sidetone

import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconToggleButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderDefaults
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.dp
import kotlin.math.roundToInt

/** 9.4.10 the levels of the verbosity, shortest first. */
private val LEVELS = listOf("brief", "normal", "full")

/** 17.22.7 the hold music delays on offer, in seconds. Zero, the music off, is the music button's (17.10.3). */
private val DELAYS_S = listOf(3, 5, 8, 12)

/** 17.22.6 the end-of-turn pause moves one step a tap, between these two. */
private const val PAUSE_STEP_MS = 100
private const val PAUSE_MIN_MS = 500
private const val PAUSE_MAX_MS = 3_000

/** 17.22 the height of a row on the options screen: a target for a thumb in a moving car. */
private val ROW = 64.dp

/** 17.22 the gear at the end of the status row. It opens the options screen, and the same tap closes it. */
@Composable
fun OptionsGear(open: Boolean, onToggle: () -> Unit) {
    IconToggleButton(checked = open, onCheckedChange = { onToggle() }, modifier = Modifier.size(48.dp)) {
        Icon(painterResource(R.drawable.ic_gear), contentDescription = "Options")
    }
}

/**
 * 17.22 the options screen, under the status row. Each control sends the
 * `setting` message (9.4.9), so the bridge does what the spoken command does.
 * Each shows what the bridge last sent back, and is disabled until the bridge
 * has sent it. `sent` counts the settings messages, for the sliders (17.22.5).
 * "Leave" keeps the app open (17.11.10) and "Quit" closes it (17.22.4); out of
 * the room only "Quit" shows.
 */
@Composable
fun OptionsScreen(
    settings: Incoming.Settings,
    sent: Int,
    build: String?,
    inRoom: Boolean,
    onClose: () -> Unit,
    onQuit: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val context = LocalContext.current
    Column(modifier.fillMaxWidth().verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Verbosity(settings.words["verbosity"])
        Tones(settings.on["tones"])
        HorizontalDivider()
        Level("Hold music volume", "holdMusicGain", settings.numbers["holdMusicGain"], 0f..1f, sent)
        MusicDelay(settings.numbers["holdMusicAfterMs"])
        Level("Barge-in level", "bargeInLevel", settings.numbers["bargeInLevel"], 0f..0.2f, sent)
        Level("Quietest speech peak", "minSpeechPeak", settings.numbers["minSpeechPeak"], 0f..0.5f, sent)
        Pause(settings.numbers["endOfTurnPauseMs"])
        HorizontalDivider()
        if (inRoom) {
            FilledTonalButton(
                onClick = {
                    onClose()
                    Bridge.leave(context)
                },
                modifier = Modifier.fillMaxWidth().height(ROW),
            ) { Text("Leave", style = MaterialTheme.typography.titleMedium) }
        }
        OutlinedButton(onClick = onQuit, modifier = Modifier.fillMaxWidth().height(ROW)) {
            Text("Quit", style = MaterialTheme.typography.titleMedium)
        }
        // 14.15 the first 12 characters of the SHA-256, as the bridge's journal gives them
        Text(
            "Build ${build?.take(12) ?: "unknown"}",
            modifier = Modifier.padding(vertical = 8.dp),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

/** 17.22.1 the three levels, as "verbosity brief", "verbosity normal" and "verbosity full" set them. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun Verbosity(level: String?) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("Verbosity", style = MaterialTheme.typography.titleMedium)
        SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
            LEVELS.forEachIndexed { index, each ->
                SegmentedButton(
                    selected = level == each,
                    onClick = { Bridge.change(Outgoing.setting("verbosity", each)) },
                    shape = SegmentedButtonDefaults.itemShape(index, LEVELS.size),
                    modifier = Modifier.heightIn(min = 56.dp),
                    enabled = level != null,
                ) { Text(each, style = MaterialTheme.typography.titleSmall) }
            }
        }
    }
}

/**
 * 17.22.7 the hold music delay, `holdMusicAfterMs` on the bridge (15.7.6): a
 * selector of a few times, as the verbosity is. A value the bridge holds that
 * is not on offer selects none of them.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun MusicDelay(ms: Double?) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("Hold music after", style = MaterialTheme.typography.titleMedium)
        SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
            DELAYS_S.forEachIndexed { index, seconds ->
                SegmentedButton(
                    selected = ms?.roundToInt() == seconds * 1_000,
                    onClick = { Bridge.change(Outgoing.musicDelay(seconds)) },
                    shape = SegmentedButtonDefaults.itemShape(index, DELAYS_S.size),
                    modifier = Modifier.heightIn(min = 56.dp),
                    enabled = ms != null,
                ) { Text("$seconds s", style = MaterialTheme.typography.titleSmall) }
            }
        }
    }
}

/** 17.22.2 the tones, as "tones on" and "tones off" set them. The whole row is the switch. */
@Composable
private fun Tones(on: Boolean?) {
    Row(
        Modifier.fillMaxWidth().height(ROW).toggleable(
            value = on == true,
            enabled = on != null,
            role = Role.Switch,
            onValueChange = { Bridge.change(Outgoing.setting("tones", it)) },
        ),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text("Tones", style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
        Switch(checked = on == true, onCheckedChange = null, enabled = on != null)
    }
}

/**
 * 17.22.3 and 17.22.5 a level, as a fraction of full scale: the hold music
 * volume, the barge-in level and the quietest speech peak. The slider moves
 * under the finger and sends once, when the finger lifts. Each settings
 * message puts it back to what the bridge holds, so a value the bridge
 * refused does not stay under the thumb. The label shows the bridge's value.
 * The thumb and the track are larger than the default, for a moving car.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun Level(label: String, name: String, value: Double?, range: ClosedFloatingPointRange<Float>, sent: Int) {
    var shown by remember(sent) { mutableFloatStateOf(value?.toFloat() ?: 0f) }
    val source = remember { MutableInteractionSource() }
    val enabled = value != null
    Column {
        Row(Modifier.fillMaxWidth()) {
            Text(label, style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
            Text(value?.toString() ?: "—", style = MaterialTheme.typography.titleMedium)
        }
        Slider(
            value = shown,
            onValueChange = { shown = it },
            modifier = Modifier.fillMaxWidth().height(ROW),
            enabled = enabled,
            onValueChangeFinished = { Bridge.change(Outgoing.setting(name, (shown * 100).roundToInt() / 100.0)) },
            interactionSource = source,
            thumb = { SliderDefaults.Thumb(source, enabled = enabled, thumbSize = DpSize(8.dp, 56.dp)) },
            track = { SliderDefaults.Track(it, modifier = Modifier.height(24.dp), enabled = enabled) },
            valueRange = range,
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
    Row(
        Modifier.fillMaxWidth().height(ROW),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text("End-of-turn pause", style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
        FilledTonalButton(
            onClick = { held?.let { Bridge.change(Outgoing.setting("endOfTurnPauseMs", it - PAUSE_STEP_MS)) } },
            enabled = held != null && held - PAUSE_STEP_MS >= PAUSE_MIN_MS,
            modifier = Modifier.size(ROW),
            contentPadding = PaddingValues(0.dp),
        ) { Text("−", style = MaterialTheme.typography.titleLarge) }
        Text(if (held == null) "—" else "${held / 100 / 10.0} s", style = MaterialTheme.typography.titleMedium)
        FilledTonalButton(
            onClick = { held?.let { Bridge.change(Outgoing.setting("endOfTurnPauseMs", it + PAUSE_STEP_MS)) } },
            enabled = held != null && held + PAUSE_STEP_MS <= PAUSE_MAX_MS,
            modifier = Modifier.size(ROW),
            contentPadding = PaddingValues(0.dp),
        ) { Text("+", style = MaterialTheme.typography.titleLarge) }
    }
}
