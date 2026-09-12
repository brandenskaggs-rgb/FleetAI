package com.fleetai.driver.ui.screens

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowLeft
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.fleetai.driver.AppGraph
import com.fleetai.driver.data.model.DutyStatus
import com.fleetai.driver.data.model.LogbookRules
import com.fleetai.driver.ui.components.FleetButton
import com.fleetai.driver.ui.components.FleetCard
import com.fleetai.driver.ui.components.FleetTextField
import com.fleetai.driver.ui.viewmodel.LogbookViewModel
import java.time.Instant
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun LogbookScreen(
    contentPadding: PaddingValues,
    model: LogbookViewModel = viewModel(factory = AppGraph.viewModelFactory)
) {
    val events by model.events.collectAsStateWithLifecycle()
    val message by model.message.collectAsStateWithLifecycle()
    val date by model.selectedDate.collectAsStateWithLifecycle()
    val loading by model.loading.collectAsStateWithLifecycle()
    val saving by model.saving.collectAsStateWithLifecycle()
    val offline by model.offline.collectAsStateWithLifecycle()
    val unreadable by model.unreadable.collectAsStateWithLifecycle()
    val canCertify by model.canCertify.collectAsStateWithLifecycle()
    var adding by remember { mutableStateOf(false) }
    var certifying by remember { mutableStateOf(false) }
    val zone = ZoneId.systemDefault()
    val today = LocalDate.now()

    LazyColumn(modifier = Modifier.fillMaxSize().padding(contentPadding),
        contentPadding = PaddingValues(24.dp), verticalArrangement = Arrangement.spacedBy(18.dp)) {
        item {
            Text("Driver log", style = MaterialTheme.typography.headlineMedium)
            Text("Duty changes and upload status", style = MaterialTheme.typography.bodyLarge,
                color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        item {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                IconButton(onClick = { model.loadLogs(date.minusDays(1)) },
                    enabled = date > today.minusDays(7) && !saving) {
                    Icon(Icons.AutoMirrored.Filled.KeyboardArrowLeft, contentDescription = "Previous day")
                }
                Column(Modifier.weight(1f).padding(horizontal = 8.dp)) {
                    Text(date.format(DateTimeFormatter.ofPattern("EEEE, MMM d")), style = MaterialTheme.typography.titleLarge)
                    Text("Tablet time: ${zone.id}", style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                IconButton(onClick = { model.loadLogs(date.plusDays(1)) }, enabled = date < today && !saving) {
                    Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = "Next day")
                }
            }
            FlowRow(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                FleetButton("Record duty change", { model.clearMessage(); adding = true }, enabled = !saving)
                TextButton(onClick = { model.loadLogs() }, enabled = !loading && !saving) { Text("Refresh") }
                TextButton(onClick = { certifying = true }, enabled = canCertify && !loading && !saving) { Text("Review & certify") }
            }
        }
        item {
            if (loading) LinearProgressIndicator(Modifier.fillMaxWidth())
            else Text(if (offline) "Offline / showing entries saved on this tablet only"
                else "${events.size} entries / ${events.count { it.pendingUpload }} waiting to upload",
                style = MaterialTheme.typography.bodyLarge,
                color = if (offline) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant)
            if (unreadable > 0) Text("$unreadable records could not be displayed. Contact your fleet manager.",
                color = MaterialTheme.colorScheme.error)
            if (!adding && message.isNotBlank()) Text(message, Modifier.padding(top = 8.dp), style = MaterialTheme.typography.bodyLarge)
        }
        item {
            Text("Pilot logging", style = MaterialTheme.typography.titleMedium)
            Text("Keep using your carrier's registered ELD for legal logs. This view is not a complete roadside inspection display. Confirm the tablet timezone matches your home terminal before entering a time.",
                style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        if (!loading && events.isEmpty()) item {
            Text(if (offline) "No entries saved locally for this day. This does not mean there was no driving."
                else "No duty entries returned for this day.", Modifier.padding(vertical = 24.dp),
                style = MaterialTheme.typography.bodyLarge)
        }
        items(events, key = { it.id }) { event ->
            FleetCard(Modifier.fillMaxWidth()) {
                FlowRow(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(20.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(LogbookRules.label(event.status), style = MaterialTheme.typography.titleLarge)
                    Text(readableLogTime(event.startTime, zone), style = MaterialTheme.typography.titleMedium)
                }
                if (event.notes.isNotBlank()) Text(event.notes, Modifier.padding(top = 8.dp), style = MaterialTheme.typography.bodyLarge)
                if (event.pendingUpload) Text("Saved locally / awaiting server confirmation", Modifier.padding(top = 8.dp),
                    style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.error)
            }
        }
    }
    if (adding) {
        var time by remember { mutableStateOf(if (date == today) LocalTime.now().format(DateTimeFormatter.ofPattern("HH:mm")) else "") }
        var notes by remember { mutableStateOf("") }
        var status by remember { mutableStateOf(DutyStatus.OFF) }
        AlertDialog(onDismissRequest = { if (!saving) adding = false },
            title = { Text("Record duty change") },
            text = {
                Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Text("$date / ${zone.id}")
                    Text("Records when a duty status began. Driving entries cannot be added manually.")
                    FleetTextField(value = time, onValueChange = { time = it.take(5) }, label = { Text("Time (24-hour, HH:mm)") }, modifier = Modifier.fillMaxWidth())
                    DutyStatus.values().filterNot { it == DutyStatus.DRIVING }.forEach { option ->
                        Row(Modifier.fillMaxWidth().heightIn(min = 48.dp)
                            .selectable(selected = status == option, role = Role.RadioButton, enabled = !saving, onClick = { status = option }),
                            verticalAlignment = Alignment.CenterVertically) {
                            RadioButton(selected = status == option, onClick = null)
                            Text(LogbookRules.label(option), Modifier.padding(start = 12.dp))
                        }
                    }
                    FleetTextField(value = notes, onValueChange = { notes = it.take(60) }, label = { Text("Reason (4 to 60 characters)") }, modifier = Modifier.fillMaxWidth())
                    if (message.isNotBlank()) Text(message, color = MaterialTheme.colorScheme.error)
                }
            },
            confirmButton = { TextButton(enabled = !saving, onClick = { model.recordDutyChange(status, time, notes) { adding = false } }) { Text(if (saving) "Saving..." else "Save entry") } },
            dismissButton = { TextButton(enabled = !saving, onClick = { adding = false }) { Text("Cancel") } })
    }
    if (certifying) AlertDialog(onDismissRequest = { certifying = false }, title = { Text("Certify $date?") },
        text = { Text("Confirm you reviewed the full day and that your records are complete and accurate. Do not certify a day with missing driving or duty entries.") },
        confirmButton = { TextButton(onClick = { certifying = false; model.certify() }) { Text("Certify this day") } },
        dismissButton = { TextButton(onClick = { certifying = false }) { Text("Keep reviewing") } })
}

private fun readableLogTime(value: String, zone: ZoneId): String = try {
    Instant.parse(value).atZone(zone).format(DateTimeFormatter.ofPattern("HH:mm"))
} catch (_: Exception) { value.ifBlank { "Time unavailable" } }
