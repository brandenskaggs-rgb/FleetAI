package com.fleetai.driver.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import com.fleetai.driver.ui.components.FleetTextField as OutlinedTextField
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
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
import com.fleetai.driver.ui.viewmodel.StatusViewModel

@Composable
fun StatusScreen(contentPadding: PaddingValues) {
    val viewModel: StatusViewModel = viewModel(factory = AppGraph.viewModelFactory)
    val currentStatus by viewModel.dutyStatus.collectAsState()
    val message by viewModel.message.collectAsState()
    var notifyText by remember { mutableStateOf("") }

    Column(
        modifier = Modifier
            .padding(contentPadding)
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp)
    ) {
        FleetCard(modifier = Modifier.fillMaxWidth()) {
            Text(text = "Duty Status", style = MaterialTheme.typography.headlineMedium)
            Spacer(modifier = Modifier.height(8.dp))
            DutyStatus.values().forEach { status ->
                FleetButton(
                    text = if (status == currentStatus) "Current: ${status.name}" else status.name,
                    onClick = { viewModel.setStatus(status) },
                    modifier = Modifier.fillMaxWidth()
                )
                Spacer(modifier = Modifier.height(6.dp))
            }
        }

        FleetCard(modifier = Modifier.fillMaxWidth()) {
            Text(text = "Notify Fleet Manager", style = MaterialTheme.typography.headlineMedium)
            Spacer(modifier = Modifier.height(8.dp))
            OutlinedTextField(
                value = notifyText,
                onValueChange = { notifyText = it },
                label = { Text("Message") },
                modifier = Modifier.fillMaxWidth()
            )
            Spacer(modifier = Modifier.height(12.dp))
            FleetButton(
                text = "Send Notification",
                onClick = { viewModel.notifyFleet(notifyText) },
                modifier = Modifier.fillMaxWidth()
            )
            Spacer(modifier = Modifier.height(8.dp))
            FleetButton(
                text = "Break Alert",
                onClick = { viewModel.notifyFleet("Break started") },
                modifier = Modifier.fillMaxWidth()
            )
            Spacer(modifier = Modifier.height(8.dp))
            FleetButton(
                text = "Lunch Alert",
                onClick = { viewModel.notifyFleet("Lunch started") },
                modifier = Modifier.fillMaxWidth()
            )
            if (message.isNotBlank()) {
                Spacer(modifier = Modifier.height(8.dp))
                Text(text = message, style = MaterialTheme.typography.bodyMedium)
            }
        }
    }
}
