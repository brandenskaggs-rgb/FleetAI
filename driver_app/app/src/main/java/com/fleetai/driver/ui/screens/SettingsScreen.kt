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
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import com.fleetai.driver.AppGraph
import com.fleetai.driver.data.model.ThemeMode
import com.fleetai.driver.ui.components.FleetButton
import com.fleetai.driver.ui.components.FleetCard
import com.fleetai.driver.ui.viewmodel.SettingsViewModel

@Composable
fun SettingsScreen(contentPadding: PaddingValues) {
    val viewModel: SettingsViewModel = viewModel(factory = AppGraph.viewModelFactory)
    val state by viewModel.state.collectAsState()

    Column(
        modifier = Modifier
            .padding(contentPadding)
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp)
    ) {
        FleetCard(modifier = Modifier.fillMaxWidth()) {
            Text(text = "Settings", style = MaterialTheme.typography.headlineMedium)
            Spacer(modifier = Modifier.height(8.dp))
            Text(text = "Tenant: ${state.tenantId.ifBlank { "--" }}")
            Text(text = "Driver: ${state.driverName.ifBlank { "--" }}")
            Text(text = "Vehicle: ${state.vehicleId.ifBlank { "--" }}")
        }

        FleetCard(modifier = Modifier.fillMaxWidth()) {
            Text(text = "Theme", style = MaterialTheme.typography.titleLarge)
            Spacer(modifier = Modifier.height(8.dp))
            Row(horizontalArrangement = Arrangement.SpaceBetween, modifier = Modifier.fillMaxWidth()) {
                Text(text = if (state.themeMode == ThemeMode.DARK) "Dark" else "Light")
                Switch(
                    checked = state.themeMode == ThemeMode.LIGHT,
                    onCheckedChange = { checked ->
                        viewModel.setThemeMode(if (checked) ThemeMode.LIGHT else ThemeMode.DARK)
                    }
                )
            }
        }

        FleetCard(modifier = Modifier.fillMaxWidth()) {
            Text(text = "Demo Mode", style = MaterialTheme.typography.titleLarge)
            Spacer(modifier = Modifier.height(8.dp))
            Row(horizontalArrangement = Arrangement.SpaceBetween, modifier = Modifier.fillMaxWidth()) {
                Text(text = if (state.demoMode) "On" else "Off")
                Switch(
                    checked = state.demoMode,
                    onCheckedChange = { viewModel.setDemoMode(it) }
                )
            }
        }

        FleetButton(
            text = "Sign out",
            onClick = { viewModel.logout() },
            modifier = Modifier.fillMaxWidth()
        )
    }
}
