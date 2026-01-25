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
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
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

    Column(
        modifier = Modifier
            .padding(contentPadding)
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp)
    ) {
        FleetCard(modifier = Modifier.fillMaxWidth()) {
            Text(text = "Diagnostics", style = MaterialTheme.typography.headlineMedium)
            Spacer(modifier = Modifier.height(8.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                FleetButton(text = "Scan", onClick = { viewModel.scan() })
                FleetButton(text = "Clear", onClick = { viewModel.clear() })
            }
            if (message.isNotBlank()) {
                Spacer(modifier = Modifier.height(8.dp))
                Text(text = message)
            }
        }

        if (dtcs.isNotEmpty()) {
            WarningBanner(message = "Check engine: diagnostic codes detected.", isCritical = true)
        }

        LazyColumn(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            items(dtcs) { dtc ->
                FleetCard(modifier = Modifier.fillMaxWidth()) {
                    Text(text = dtc.code, style = MaterialTheme.typography.titleLarge)
                    Text(text = dtc.description)
                    Text(text = "Severity: ${dtc.severity}")
                    Spacer(modifier = Modifier.height(8.dp))
                    FleetButton(text = "Explain (stub)", onClick = { })
                }
            }
        }
    }
}
