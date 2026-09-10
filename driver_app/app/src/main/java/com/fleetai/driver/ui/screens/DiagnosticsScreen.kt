package com.fleetai.driver.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.material3.TextButton
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import com.fleetai.driver.AppGraph
import com.fleetai.driver.ui.components.FleetButton
import com.fleetai.driver.ui.components.FleetCard
import com.fleetai.driver.ui.components.WarningBanner
import com.fleetai.driver.ui.viewmodel.DiagnosticsViewModel

@Composable
fun DiagnosticsScreen(contentPadding: PaddingValues) {
    val viewModel: DiagnosticsViewModel = viewModel(factory = AppGraph.viewModelFactory)
    val dtcs by viewModel.dtcs.collectAsState()
    val message by viewModel.message.collectAsState()
    val apiDiagnostics by viewModel.apiDiagnostics.collectAsState()
    val networkMessage by viewModel.networkMessage.collectAsState()
    val scanning by viewModel.scanning.collectAsState()
    var showNetwork by remember { mutableStateOf(false) }

    LazyColumn(
        modifier = Modifier
            .padding(contentPadding)
            .fillMaxSize(),
        contentPadding = PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp)
    ) {
        item {
            FleetCard(modifier = Modifier.fillMaxWidth()) {
                Text(text = "Fault codes", style = MaterialTheme.typography.headlineMedium)
                Text("Read-only diagnostics. Codes cannot be erased from this app.", color = MaterialTheme.colorScheme.onSurfaceVariant)
                Spacer(modifier = Modifier.height(8.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    FleetButton(text = if (scanning) "Reading codes..." else "Read fault codes", onClick = { viewModel.scan() }, enabled = !scanning)
                }
                if (message.isNotBlank()) {
                    Spacer(modifier = Modifier.height(8.dp))
                    Text(text = message)
                }
            }
        }

        item {
            FleetCard(modifier = Modifier.fillMaxWidth()) {
                TextButton(onClick = { showNetwork = !showNetwork }) { Text(if (showNetwork) "Hide connection details" else "Connection details") }
                if (showNetwork) {
                Spacer(modifier = Modifier.height(8.dp))
                Text(text = "Base URL: ${apiDiagnostics.baseUrl.ifBlank { "--" }}")
                Text(text = "Last Request: ${apiDiagnostics.lastMethod} ${apiDiagnostics.lastUrl}".trim())
                Text(text = "Last Status: ${apiDiagnostics.lastStatus.ifBlank { "--" }}")
                Text(text = "Last Error: ${apiDiagnostics.lastError.ifBlank { "--" }}")
                Spacer(modifier = Modifier.height(8.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    FleetButton(text = "Ping /health", onClick = { viewModel.ping("/health") })
                    FleetButton(text = "Ping pairing health", onClick = { viewModel.ping("/api/pairing/health") })
                }
                if (networkMessage.isNotBlank()) {
                    Spacer(modifier = Modifier.height(8.dp))
                    Text(text = networkMessage)
                }
                }
            }
        }

        if (dtcs.isNotEmpty()) {
            item { WarningBanner(message = "Share these codes with your maintenance team.", isCritical = false) }
        }

        items(dtcs, key = { it.code }) { dtc ->
            FleetCard(modifier = Modifier.fillMaxWidth()) {
                Text(text = dtc.code, style = MaterialTheme.typography.titleLarge)
                Text(text = dtc.description)
                Text(text = "Severity: ${dtc.severity}")
                Spacer(modifier = Modifier.height(8.dp))
            }
        }
    }
}
