package com.fleetai.driver.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.compose.ui.platform.LocalContext
import android.content.Intent
import androidx.core.net.toUri
import com.fleetai.driver.ConnectActivity
import com.fleetai.driver.AppGraph
import com.fleetai.driver.BuildConfig
import com.fleetai.driver.data.model.ThemeMode
import com.fleetai.driver.ui.components.FleetButton
import com.fleetai.driver.ui.components.FleetCard
import com.fleetai.driver.ui.viewmodel.SettingsViewModel

@Composable
fun SettingsScreen(contentPadding: PaddingValues) {
    val viewModel: SettingsViewModel = viewModel(factory = AppGraph.viewModelFactory)
    val state by viewModel.state.collectAsState()
    val context = LocalContext.current

    Column(
        modifier = Modifier
            .padding(contentPadding)
            .verticalScroll(rememberScrollState())
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

        if (BuildConfig.DEBUG) {
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
        }

        FleetButton(
            text = "Sign out",
            onClick = { viewModel.logout() },
            modifier = Modifier.fillMaxWidth()
        )

        if (BuildConfig.DEBUG) {
            FleetButton(
                text = "Server settings",
                onClick = { context.startActivity(Intent(context, ConnectActivity::class.java)) },
                modifier = Modifier.fillMaxWidth()
            )
        }

        FleetButton(
            text = "Reset pairing",
            onClick = { viewModel.resetPairing() },
            modifier = Modifier.fillMaxWidth()
        )

        FleetCard(modifier = Modifier.fillMaxWidth()) {
            Text(text = "Privacy and support", style = MaterialTheme.typography.titleLarge)
            Spacer(modifier = Modifier.height(8.dp))
            Text(
                text = "Fleet AI Driver ${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE})",
                style = MaterialTheme.typography.bodyMedium
            )
            Spacer(modifier = Modifier.height(12.dp))
            FleetButton(
                text = "Privacy policy",
                onClick = {
                    context.startActivity(Intent(Intent.ACTION_VIEW, "https://fleetaiops.com/legal/privacy.html".toUri()))
                },
                modifier = Modifier.fillMaxWidth()
            )
            Spacer(modifier = Modifier.height(8.dp))
            FleetButton(
                text = "Terms of service",
                onClick = {
                    context.startActivity(Intent(Intent.ACTION_VIEW, "https://fleetaiops.com/legal/terms.html".toUri()))
                },
                modifier = Modifier.fillMaxWidth()
            )
        }
    }
}
