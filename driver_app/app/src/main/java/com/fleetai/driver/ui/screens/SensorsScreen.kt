package com.fleetai.driver.ui.screens

import android.Manifest
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
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
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.lifecycle.viewmodel.compose.viewModel
import com.fleetai.driver.AppGraph
import com.fleetai.driver.ui.components.FleetButton
import com.fleetai.driver.ui.components.FleetCard
import com.fleetai.driver.ui.viewmodel.SensorViewModel

@Composable
fun SensorsScreen(contentPadding: PaddingValues) {
    val viewModel: SensorViewModel = viewModel(factory = AppGraph.viewModelFactory)
    val status by viewModel.status.collectAsState()
    val demoMode by viewModel.demoMode.collectAsState()
    val readings by viewModel.readings.collectAsState()
    val context = LocalContext.current
    val hasBluetooth = viewModel.hasBluetooth()

    val requiredPermissions = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        listOf(
            Manifest.permission.BLUETOOTH_CONNECT,
            Manifest.permission.BLUETOOTH_SCAN
        )
    } else {
        listOf(
            Manifest.permission.BLUETOOTH,
            Manifest.permission.BLUETOOTH_ADMIN,
            Manifest.permission.ACCESS_FINE_LOCATION
        )
    }

    var hasPermissions by remember { mutableStateOf(hasAllPermissions(context, requiredPermissions)) }
    val permissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { results ->
        hasPermissions = results.values.all { it }
    }

    Column(
        modifier = Modifier
            .padding(contentPadding)
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp)
    ) {
        FleetCard(modifier = Modifier.fillMaxWidth()) {
            Text(text = "Sensors", style = MaterialTheme.typography.headlineMedium)
            Spacer(modifier = Modifier.height(8.dp))
            Text(text = "Status: $status")
            Spacer(modifier = Modifier.height(8.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                FleetButton(
                    text = if (hasPermissions) "Permissions OK" else "Grant Bluetooth",
                    onClick = { permissionLauncher.launch(requiredPermissions.toTypedArray()) },
                    modifier = Modifier.weight(1f)
                )
                FleetButton(
                    text = if (demoMode) "Demo On" else "Demo Off",
                    onClick = { viewModel.toggleDemo(!demoMode) },
                    modifier = Modifier.weight(1f)
                )
            }
        }

        if (!hasBluetooth) {
            FleetCard(modifier = Modifier.fillMaxWidth()) {
                Text(text = "Bluetooth is not available on this device.")
            }
        } else if (!hasPermissions) {
            FleetCard(modifier = Modifier.fillMaxWidth()) {
                Text(text = "Bluetooth permissions are required to connect to the OBD dongle.")
            }
        } else {
            val devices = viewModel.pairedDevices()
            if (devices.isNotEmpty()) {
                FleetCard(modifier = Modifier.fillMaxWidth()) {
                    Text(text = "Paired Devices", style = MaterialTheme.typography.titleLarge)
                    Spacer(modifier = Modifier.height(8.dp))
                    devices.forEach { device ->
                        FleetButton(
                            text = device.name ?: device.address,
                            onClick = { viewModel.connect(device) },
                            modifier = Modifier.fillMaxWidth()
                        )
                        Spacer(modifier = Modifier.height(6.dp))
                    }
                    FleetButton(
                        text = "Disconnect",
                        onClick = { viewModel.disconnect() },
                        modifier = Modifier.fillMaxWidth()
                    )
                }
            }
        }

        FleetCard(modifier = Modifier.fillMaxWidth()) {
            Text(text = "PID Dashboard", style = MaterialTheme.typography.titleLarge)
            Spacer(modifier = Modifier.height(8.dp))
            LazyColumn(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                items(readings) { reading ->
                    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                        Text(text = reading.label)
                        Text(text = "${reading.value} ${reading.unit}")
                    }
                }
            }
        }
    }
}

private fun hasAllPermissions(context: android.content.Context, permissions: List<String>): Boolean {
    return permissions.all { perm ->
        ContextCompat.checkSelfPermission(context, perm) == android.content.pm.PackageManager.PERMISSION_GRANTED
    }
}
