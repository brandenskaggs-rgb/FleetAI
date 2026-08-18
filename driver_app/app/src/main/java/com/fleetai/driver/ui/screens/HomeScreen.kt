package com.fleetai.driver.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Engineering
import androidx.compose.material.icons.filled.Route
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Speed
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import com.fleetai.driver.AppGraph
import com.fleetai.driver.data.model.DutyStatus
import com.fleetai.driver.ui.components.FleetButton
import com.fleetai.driver.ui.components.FleetCard
import com.fleetai.driver.ui.components.WarningBanner
import com.fleetai.driver.ui.viewmodel.HomeViewModel
import com.fleetai.driver.ui.viewmodel.SensorViewModel
import com.fleetai.driver.ui.viewmodel.SessionState

@Composable
fun HomeScreen(
    contentPadding: PaddingValues,
    sessionState: SessionState,
    sensorViewModel: SensorViewModel,
    onOpenStatus: () -> Unit,
    onOpenDiagnostics: () -> Unit,
    onOpenRoute: () -> Unit,
    onOpenSettings: () -> Unit
) {
    val viewModel: HomeViewModel = viewModel(factory = AppGraph.viewModelFactory)
    val state by viewModel.uiState.collectAsState()
    val obdStatus by sensorViewModel.status.collectAsState()

    Column(
        modifier = Modifier
            .padding(contentPadding)
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp)
    ) {
        FleetCard(modifier = Modifier.fillMaxWidth()) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                Box(
                    modifier = Modifier
                        .background(MaterialTheme.colorScheme.primary, CircleShape)
                        .padding(13.dp),
                    contentAlignment = Alignment.Center
                ) {
                    Icon(Icons.Default.Speed, contentDescription = null, tint = MaterialTheme.colorScheme.onPrimary)
                }
                Column(modifier = Modifier.weight(1f)) {
                    Text("Good shift, ${sessionState.driverName.ifBlank { "Driver" }}", style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.ExtraBold)
                    Text("Vehicle ${sessionState.vehicleId.ifBlank { "--" }} · ${if (sessionState.demoMode) "Demo feed" else "Live-ready"}", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.64f))
                }
                AssistChip(onClick = {}, label = { Text(obdStatus) })
            }
            Spacer(modifier = Modifier.height(18.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.fillMaxWidth()) {
                StatusTile("Duty", state.dutyStatus.name.replace("_", " "), Modifier.weight(1f))
                StatusTile(
                    "ELD",
                    when {
                        !state.eldEnabled -> "Not enabled"
                        state.productionAuthorized -> "Recording"
                        else -> "Shadow"
                    },
                    Modifier.weight(1f)
                )
                StatusTile("Motion", if (state.vehicleMoving) "Moving" else "Stopped", Modifier.weight(1f))
                StatusTile("Diagnostics", state.activeDiagnosticCount.toString(), Modifier.weight(1f))
            }
            if (state.lastTelemetryAt.isNotBlank()) {
                Spacer(modifier = Modifier.height(10.dp))
                Text("Last engine sync: ${state.lastTelemetryAt}", style = MaterialTheme.typography.bodySmall)
            }
        }

        FleetCard(modifier = Modifier.fillMaxWidth()) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
                modifier = Modifier.fillMaxWidth()
            ) {
                Column {
                    Text("Hours of service", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.ExtraBold)
                    Text(
                        state.hosRuleLabel.ifBlank { "Rule profile not available" },
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.64f)
                    )
                }
                AssistChip(
                    onClick = { viewModel.refresh() },
                    label = { Text(if (state.hosHistorySufficient) "Clock history complete" else "History incomplete") }
                )
            }
            Spacer(modifier = Modifier.height(12.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.fillMaxWidth()) {
                StatusTile("Drive left", formatClock(state.driveRemainingMinutes), Modifier.weight(1f))
                StatusTile("Window left", formatClock(state.windowRemainingMinutes), Modifier.weight(1f))
                StatusTile(
                    "Break in",
                    if (state.hosRuleLabel.startsWith("California")) "Not required" else formatClock(state.breakRemainingMinutes),
                    Modifier.weight(1f)
                )
                StatusTile("Cycle left", formatClock(state.cycleRemainingMinutes), Modifier.weight(1f))
            }
            Spacer(modifier = Modifier.height(10.dp))
            Text(
                "Base clock reset: 10 consecutive hours off duty. Split-sleeper and other exception relief is not applied automatically.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.64f)
            )
            if (!state.hosHistorySufficient) {
                Spacer(modifier = Modifier.height(10.dp))
                Text(
                    "Fleet AI cannot prove available hours until the required prior-duty history is present.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error
                )
            }
        }

        FleetCard(modifier = Modifier.fillMaxWidth()) {
            Text("Ready checklist", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.ExtraBold)
            Spacer(modifier = Modifier.height(10.dp))
            ChecklistLine("Complete pre-trip inspection before driving when required.")
            ChecklistLine("Review unresolved defects from the last DVIR before operating.")
            ChecklistLine("Confirm ELD recording is active before relying on Fleet AI for legal logs.")
        }

        if (state.statusMessage.isNotBlank()) {
            WarningBanner(
                message = state.statusMessage,
                isCritical = !state.eldEnabled || !state.productionAuthorized || state.activeDiagnosticCount > 0
            )
        }

        if (state.hosViolations.isNotEmpty() || state.drivingProhibitedReasons.isNotEmpty()) {
            val reasons = (state.hosViolations + state.drivingProhibitedReasons).distinct()
            WarningBanner(
                message = "Do not drive: " + reasons.joinToString(", ").replace("_", " "),
                isCritical = true
            )
        }

        FleetCard(modifier = Modifier.fillMaxWidth()) {
            Text("Duty actions", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.ExtraBold)
            Text(
                "Driving status is automatic at 5 mph and cannot be started manually.",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.64f)
            )
            Spacer(modifier = Modifier.height(10.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.fillMaxWidth()) {
                FleetButton(
                    text = "On Duty",
                    onClick = { viewModel.setDutyStatus(DutyStatus.ON) },
                    enabled = !state.actionInProgress && !state.vehicleMoving,
                    modifier = Modifier.weight(1f)
                )
                FleetButton(
                    text = "Sleeper",
                    onClick = { viewModel.setDutyStatus(DutyStatus.SLEEPER) },
                    enabled = !state.actionInProgress && !state.vehicleMoving,
                    modifier = Modifier.weight(1f)
                )
            }
            Spacer(modifier = Modifier.height(8.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.fillMaxWidth()) {
                FleetButton(
                    text = "Off Duty",
                    onClick = { viewModel.setDutyStatus(DutyStatus.OFF) },
                    enabled = !state.actionInProgress && !state.vehicleMoving,
                    modifier = Modifier.weight(1f)
                )
                FleetButton(
                    text = "Refresh ELD",
                    onClick = { viewModel.refresh() },
                    enabled = !state.actionInProgress,
                    modifier = Modifier.weight(1f)
                )
            }
        }

        FleetCard(modifier = Modifier.fillMaxWidth()) {
            Text("Tools", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.ExtraBold)
            Spacer(modifier = Modifier.height(10.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.fillMaxWidth()) {
                ToolButton("Status", Icons.Default.CheckCircle, onOpenStatus, Modifier.weight(1f))
                ToolButton("Diagnostics", Icons.Default.Engineering, onOpenDiagnostics, Modifier.weight(1f))
                ToolButton("Route", Icons.Default.Route, onOpenRoute, Modifier.weight(1f))
                ToolButton("Settings", Icons.Default.Settings, onOpenSettings, Modifier.weight(1f))
            }
        }
    }
}

@Composable
private fun StatusTile(label: String, value: String, modifier: Modifier = Modifier) {
    Column(
        modifier = modifier
            .background(MaterialTheme.colorScheme.surfaceVariant, MaterialTheme.shapes.medium)
            .padding(12.dp)
    ) {
        Text(label, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.58f))
        Spacer(modifier = Modifier.height(6.dp))
        Text(value, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.ExtraBold)
    }
}

@Composable
private fun ChecklistLine(text: String) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(9.dp), modifier = Modifier.padding(vertical = 4.dp)) {
        Icon(Icons.Default.CheckCircle, contentDescription = null, tint = MaterialTheme.colorScheme.secondary)
        Text(text, style = MaterialTheme.typography.bodyMedium)
    }
}

@Composable
private fun ToolButton(label: String, icon: androidx.compose.ui.graphics.vector.ImageVector, onClick: () -> Unit, modifier: Modifier = Modifier) {
    androidx.compose.material3.OutlinedButton(onClick = onClick, modifier = modifier.height(64.dp)) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Icon(icon, contentDescription = null)
            Text(label, style = MaterialTheme.typography.labelLarge)
        }
    }
}

private fun formatClock(minutes: Int?, unavailable: String = "--"): String {
    if (minutes == null) return unavailable
    return (minutes / 60).toString() + "h " + (minutes % 60).toString() + "m"
}
