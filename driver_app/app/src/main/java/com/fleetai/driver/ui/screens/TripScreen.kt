package com.fleetai.driver.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.fleetai.driver.DriverAppState
import com.fleetai.driver.network.DriverApi
import com.fleetai.driver.network.TripEndRequest
import com.fleetai.driver.network.TripStartRequest
import com.fleetai.driver.telemetry.TelemetryUploader
import com.fleetai.driver.ui.components.FleetButton
import com.fleetai.driver.ui.components.FleetCard
import kotlinx.coroutines.launch

@Composable
fun TripScreen(appState: DriverAppState, api: DriverApi, uploader: TelemetryUploader) {
    val scope = rememberCoroutineScope()

    FleetCard(modifier = Modifier.fillMaxWidth()) {
        Text(text = "Trip Controls", style = MaterialTheme.typography.headlineSmall)
        Spacer(modifier = Modifier.height(12.dp))
        Text(text = "Device ID: ${appState.deviceId.ifBlank { "--" }}")
        Text(text = "Vehicle ID: ${appState.vehicleId.ifBlank { "--" }}")
        Text(text = "Trip ID: ${appState.tripId.ifBlank { "--" }}")
        Spacer(modifier = Modifier.height(12.dp))

        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            FleetButton(
                text = "Start Trip",
                onClick = {
                    scope.launch {
                        if (appState.deviceId.isBlank() || appState.vehicleId.isBlank()) {
                            return@launch
                        }
                        try {
                            val response = api.startTrip(
                                TripStartRequest(
                                    device_id = appState.deviceId,
                                    vehicle_id = appState.vehicleId
                                )
                            )
                            appState.tripId = response.trip_id
                            appState.tripStartedAt = response.started_at
                            appState.tripEndedAt = "--"
                            uploader.start(
                                deviceId = appState.deviceId,
                                vehicleId = appState.vehicleId,
                                tripId = appState.tripId,
                                samplingRateSeconds = appState.samplingRateSeconds,
                                uploadIntervalSeconds = appState.uploadIntervalSeconds
                            )
                        } catch (_: Exception) {
                            appState.connectionStatus = "Disconnected"
                        }
                    }
                },
                enabled = appState.tripId.isBlank()
            )
            FleetButton(
                text = "Stop Trip",
                onClick = {
                    scope.launch {
                        if (appState.tripId.isBlank()) {
                            return@launch
                        }
                        try {
                            val response = api.endTrip(TripEndRequest(trip_id = appState.tripId))
                            appState.tripEndedAt = response.ended_at
                            uploader.stop()
                            appState.tripId = ""
                        } catch (_: Exception) {
                            appState.connectionStatus = "Disconnected"
                        }
                    }
                },
                enabled = appState.tripId.isNotBlank()
            )
        }

        Spacer(modifier = Modifier.height(16.dp))
        Text(text = "Started: ${appState.tripStartedAt}")
        Text(text = "Ended: ${appState.tripEndedAt}")
    }
}
