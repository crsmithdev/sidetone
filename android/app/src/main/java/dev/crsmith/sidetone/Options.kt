package dev.crsmith.sidetone

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
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
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.unit.dp
import kotlin.math.roundToInt

/** 9.4.10 the levels of the verbosity, shortest first. */
private val LEVELS = listOf("brief", "normal", "full")

/**
 * 17.22 the options menu, behind the gear at the end of the status row.
 * Each control sends the `setting` message (9.4.9), so the bridge does what
 * the spoken command does. Each shows what the bridge last sent back, and is
 * disabled until the bridge has sent it.
 */
@Composable
fun Options(settings: Incoming.Settings, build: String?, onLeave: () -> Unit) {
    var open by remember { mutableStateOf(false) }
    Box {
        IconButton(onClick = { open = true }) {
            Icon(painterResource(R.drawable.ic_gear), contentDescription = "Options")
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }, modifier = Modifier.width(288.dp)) {
            Verbosity(settings.words["verbosity"])
            Tones(settings.on["tones"])
            MusicVolume(settings.numbers["holdMusicGain"])
            HorizontalDivider()
            DropdownMenuItem(text = { Text("Leave") }, onClick = {
                open = false
                onLeave()
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
 * 17.22.3 the hold music volume, `holdMusicGain` on the bridge. The slider
 * moves under the finger and sends once, when the finger lifts.
 */
@Composable
private fun MusicVolume(gain: Double?) {
    var shown by remember(gain) { mutableFloatStateOf(gain?.toFloat() ?: 0f) }
    Column(Modifier.padding(horizontal = 12.dp, vertical = 8.dp)) {
        Text("Hold music volume", style = MaterialTheme.typography.labelLarge)
        Slider(
            value = shown,
            onValueChange = { shown = it },
            onValueChangeFinished = { Bridge.change(Outgoing.setting("holdMusicGain", (shown * 100).roundToInt() / 100.0)) },
            enabled = gain != null,
        )
    }
}
