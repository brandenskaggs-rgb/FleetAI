package com.fleetai.driver.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import com.fleetai.driver.AppGraph
import com.fleetai.driver.data.model.DutyStatus
import com.fleetai.driver.ui.components.FleetButton
import com.fleetai.driver.ui.components.FleetCard
import com.fleetai.driver.ui.components.LargeActionButton
import com.fleetai.driver.ui.components.MetricRow
import com.fleetai.driver.ui.components.WarningBanner
import com.fleetai.driver.ui.viewmodel.HomeViewModel
import com.fleetai.driver.ui.viewmodel.SessionState

@Composable
fun HomeScreen(
    contentPadding: PaddingValues,
    sessionState: SessionState,
    onOpenStatus: () -> Unit,
    onOpenDiagnostics: () -> Unit,
    onOpenRoute: () -> Unit,
    onOpenSettings: () -> Unit
) {
    val viewModel: HomeViewModel = viewModel(factory = AppGraph.viewModelFactory)
    val state by viewModel.uiState.collectAsState()

    Column(
        modifier = Modifier
            .padding(contentPadding)
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp)
    ) {
        FleetCard(modifier = Modifier.fillMaxWidth()) {
            Text(text = "Welcome", style = MaterialTheme.typography.headlineMedium)
            Spacer(modifier = Modifier.height(8.dp))
            MetricRow("Driver", sessionState.driverName.ifBlank { "--" })
            MetricRow("Vehicle", sessionState.vehicleId.ifBlank { "--" })
            MetricRow("Mode", if (sessionState.demoMode) "Demo" else "Live")
        }

        FleetCard(modifier = Modifier.fillMaxWidth()) {
            MetricRow("Duty Status", state.dutyStatus.name)
            Spacer(modifier = Modifier.height(8.dp))
            MetricRow("Remaining Drive Hours", formatMinutes(state.remainingDriveMinutes))
            MetricRow("Remaining Shift Hours", formatMinutes(state.remainingShiftMinutes))
            MetricRow("Break Timer", formatMinutes(state.breakMinutesRemaining))
            Spacer(modifier = Modifier.height(8.dp))
            Text(
                text = "Compliance guidance only. Verify with official rules.",
                style = MaterialTheme.typography.bodySmall
            )
        }

        if (state.complianceWarning.isNotBlank()) {
            WarningBanner(message = state.complianceWarning, isCritical = state.complianceBlocked)
        }

        if (state.needsAcknowledgement) {
            LargeActionButton(
                text = "Acknowledge Compliance Warning",
                onClick = { viewModel.acknowledgeCompliance() }
            )
        }

        FleetCard(modifier = Modifier.fillMaxWidth()) {
            LargeActionButton(
                text = "Start Driving",
                onClick = { viewModel.startDriving() },
                enabled = state.dutyStatus != DutyStatus.DRIVING && !state.needsAcknowledgement
            )
            LargeActionButton(
                text = "Take Break",
                onClick = { viewModel.takeBreak() }
            )
            LargeActionButton(
                text = "Lunch",
                onClick = { viewModel.takeLunch() }
            )
            LargeActionButton(
                text = "End Shift",
                onClick = { viewModel.endShift() }
            )
        }

        FleetCard(modifier = Modifier.fillMaxWidth()) {
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                FleetButton(text = "Status", onClick = onOpenStatus, modifier = Modifier.weight(1f))
                FleetButton(text = "Diagnostics", onClick = onOpenDiagnostics, modifier = Modifier.weight(1f))
            }
            Spacer(modifier = Modifier.height(10.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                FleetButton(text = "Route", onClick = onOpenRoute, modifier = Modifier.weight(1f))
                FleetButton(text = "Settings", onClick = onOpenSettings, modifier = Modifier.weight(1f))
            }
        }
    }
}

private fun formatMinutes(minutes: Int): String {
    val hours = minutes / 60
    val mins = minutes % 60
    return "${hours}h ${mins}m"
}
