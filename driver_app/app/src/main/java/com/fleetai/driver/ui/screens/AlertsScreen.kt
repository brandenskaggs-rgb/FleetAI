package com.fleetai.driver.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.fleetai.driver.DriverAppState
import com.fleetai.driver.network.DriverApi
import com.fleetai.driver.network.DriverAlert
import com.fleetai.driver.ui.components.FleetButton
import com.fleetai.driver.ui.components.FleetCard
import kotlinx.coroutines.launch

@Composable
fun AlertsScreen(appState: DriverAppState, api: DriverApi) {
    var alerts by remember { mutableStateOf<List<DriverAlert>>(emptyList()) }
    var statusMessage by remember { mutableStateOf("Fetching alerts...") }
    val scope = rememberCoroutineScope()

    LaunchedEffect(appState.vehicleId) {
        if (appState.vehicleId.isBlank()) {
            statusMessage = "Select a vehicle to load alerts."
            return@LaunchedEffect
        }
        try {
            alerts = api.listAlerts(appState.vehicleId)
            statusMessage = if (alerts.isEmpty()) "No alerts." else ""
        } catch (_: Exception) {
            statusMessage = "Failed to load alerts."
        }
    }

    FleetCard(modifier = Modifier.fillMaxWidth()) {
        Text(text = "Driver Alerts", style = MaterialTheme.typography.headlineSmall)
        Spacer(modifier = Modifier.height(12.dp))

        if (statusMessage.isNotBlank()) {
            Text(text = statusMessage)
            Spacer(modifier = Modifier.height(8.dp))
        }

        LazyColumn(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            items(alerts) { alert ->
                FleetCard(modifier = Modifier.fillMaxWidth()) {
                    Text(text = alert.message, style = MaterialTheme.typography.titleMedium)
                    Text(text = "Severity: ${alert.severity}")
                    Text(text = "Created: ${alert.created_at}")
                    Spacer(modifier = Modifier.height(8.dp))
                    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        FleetButton(
                            text = "Acknowledge",
                            onClick = {
                                scope.launch {
                                    try {
                                        api.ackAlert(alert.id)
                                        alerts = alerts.filterNot { it.id == alert.id }
                                    } catch (_: Exception) {
                                        statusMessage = "Failed to acknowledge alert."
                                    }
                                }
                            }
                        )
                    }
                }
            }
        }
    }
}
