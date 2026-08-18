package com.fleetai.driver.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import com.fleetai.driver.AppGraph
import com.fleetai.driver.data.model.DutyStatus
import com.fleetai.driver.ui.components.FleetButton
import com.fleetai.driver.ui.components.FleetCard
import com.fleetai.driver.ui.viewmodel.LogbookViewModel
import java.time.LocalDate

@Composable
fun LogbookScreen(contentPadding: PaddingValues) {
    val viewModel: LogbookViewModel = viewModel(factory = AppGraph.viewModelFactory)
    val events by viewModel.events.collectAsState()
    val message by viewModel.message.collectAsState()
    var showDialog by remember { mutableStateOf(false) }

    Column(
        modifier = Modifier
            .padding(contentPadding)
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp)
    ) {
        FleetCard(modifier = Modifier.fillMaxWidth()) {
            Row(horizontalArrangement = Arrangement.SpaceBetween, modifier = Modifier.fillMaxWidth()) {
                Text(text = "Daily Log", style = MaterialTheme.typography.headlineMedium)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    FleetButton(text = "Add Duty Event", onClick = { showDialog = true })
                    FleetButton(text = "Certify", onClick = { viewModel.certify() })
                }
            }
            Spacer(modifier = Modifier.height(6.dp))
            Text(text = LocalDate.now().toString(), style = MaterialTheme.typography.bodyMedium)
            if (message.isNotBlank()) {
                Spacer(modifier = Modifier.height(6.dp))
                Text(text = message, style = MaterialTheme.typography.bodySmall)
            }
        }

        if (events.isEmpty()) {
            FleetCard(modifier = Modifier.fillMaxWidth()) {
                Text(text = "No log entries yet.")
            }
        } else {
            LazyColumn(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                items(events) { event ->
                    FleetCard(modifier = Modifier.fillMaxWidth()) {
                        Text(text = "${event.startTime} - ${event.endTime}")
                        Text(text = "Status: ${event.status.name}")
                        if (event.notes.isNotBlank()) {
                            Text(text = "Notes: ${event.notes}")
                        }
                    }
                }
            }
        }
    }

    if (showDialog) {
        AddLogDialog(
            onDismiss = { showDialog = false },
            onSave = { start, end, status, notes ->
                viewModel.addEntry(status, start, end, notes)
                showDialog = false
            }
        )
    }
}

@Composable
private fun AddLogDialog(
    onDismiss: () -> Unit,
    onSave: (String, String, DutyStatus, String) -> Unit
) {
    var startTime by remember { mutableStateOf("") }
    var endTime by remember { mutableStateOf("") }
    var notes by remember { mutableStateOf("") }
    var status by remember { mutableStateOf(DutyStatus.OFF) }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Add Log Entry") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(
                    value = startTime,
                    onValueChange = { startTime = it },
                    label = { Text("Start time (HH:MM)") },
                    modifier = Modifier.fillMaxWidth()
                )
                OutlinedTextField(
                    value = endTime,
                    onValueChange = { endTime = it },
                    label = { Text("End time (HH:MM)") },
                    modifier = Modifier.fillMaxWidth()
                )
                OutlinedTextField(
                    value = notes,
                    onValueChange = { notes = it },
                    label = { Text("Notes") },
                    modifier = Modifier.fillMaxWidth()
                )
                StatusPicker(selected = status, onSelected = { status = it })
            }
        },
        confirmButton = {
            TextButton(onClick = { onSave(startTime, endTime, status, notes) }) {
                Text("Save")
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text("Cancel") }
        }
    )
}

@Composable
private fun StatusPicker(selected: DutyStatus, onSelected: (DutyStatus) -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(text = "Duty type", style = MaterialTheme.typography.bodyMedium)
        DutyStatus.values().filterNot { it == DutyStatus.DRIVING }.forEach { status ->
            TextButton(onClick = { onSelected(status) }) {
                Text(if (status == selected) "* ${status.name}" else status.name)
            }
        }
    }
}
