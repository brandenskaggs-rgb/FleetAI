package com.fleetai.driver.ui.screens

import android.Manifest
import android.content.res.Configuration
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.lifecycle.viewmodel.compose.viewModel
import com.fleetai.driver.AppGraph
import com.fleetai.driver.data.model.SensorReading
import com.fleetai.driver.data.model.SensorStatus
import com.fleetai.driver.data.model.Trend
import com.fleetai.driver.j1939.J1939BusProfile
import com.fleetai.driver.j1939.J1939ConnectorProfile
import com.fleetai.driver.ui.components.FleetButton
import com.fleetai.driver.ui.components.FleetCard
import com.fleetai.driver.ui.viewmodel.SensorViewModel
import java.text.SimpleDateFormat
import java.util.Date

@Composable
fun SensorsScreen(contentPadding: PaddingValues) {
    val viewModel: SensorViewModel = viewModel(factory = AppGraph.viewModelFactory)
    val status by viewModel.status.collectAsState()
    val demoMode by viewModel.demoMode.collectAsState()
    val savedDevice by viewModel.savedDevice.collectAsState()
    val readings by viewModel.readings.collectAsState()
    val debug by viewModel.debug.collectAsState()
    val unitPrefs by viewModel.unitPrefs.collectAsState()
    val j1939BusProfile by viewModel.j1939BusProfile.collectAsState()
    val j1939ConnectorProfile by viewModel.j1939ConnectorProfile.collectAsState()
    val context = LocalContext.current
    val isLandscape = LocalConfiguration.current.orientation == Configuration.ORIENTATION_LANDSCAPE
    val hasBluetooth = viewModel.hasBluetooth()
    val usbAdapters = viewModel.usbAdapters()

    val requiredPermissions = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        listOf(Manifest.permission.BLUETOOTH_CONNECT, Manifest.permission.BLUETOOTH_SCAN)
    } else {
        listOf(
            Manifest.permission.BLUETOOTH,
            Manifest.permission.BLUETOOTH_ADMIN,
            Manifest.permission.ACCESS_FINE_LOCATION
        )
    }
    var hasPermissions by remember { mutableStateOf(hasAllPermissions(context, requiredPermissions)) }
    val permissionLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { results ->
        hasPermissions = results.values.all { it }
    }

    LazyColumn(
        modifier = Modifier
            .padding(contentPadding)
            .fillMaxSize(),
        contentPadding = PaddingValues(12.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        item {
            ConnectionBanner(
                status = status,
                savedDevice = savedDevice,
                debug = debug,
                hasPermissions = hasPermissions,
                onGrantPermissions = { permissionLauncher.launch(requiredPermissions.toTypedArray()) },
                demoMode = demoMode,
                onToggleDemo = { viewModel.toggleDemo(!demoMode) },
                unitPrefs = unitPrefs,
                onToggleUnits = { viewModel.toggleUnits(tempF = !unitPrefs.tempF, speedMph = !unitPrefs.speedMph) }
            )
        }

        item {
            TruckNetworkPanel(
                adapterCount = usbAdapters.size,
                busProfile = j1939BusProfile,
                connectorProfile = j1939ConnectorProfile,
                onBusProfile = viewModel::setJ1939BusProfile,
                onConnectorProfile = viewModel::setJ1939ConnectorProfile,
                onConnect = viewModel::connectUsbJ1939
            )
        }

        item {
            if (!hasBluetooth) {
                FleetCard(modifier = Modifier.fillMaxWidth()) {
                    Text("Bluetooth is not available on this device.")
                }
            } else if (!hasPermissions) {
                FleetCard(modifier = Modifier.fillMaxWidth()) {
                    Text("Bluetooth permissions are required to connect to the OBD dongle.")
                }
            } else {
                PairedDevicesSection(
                    savedDevice = savedDevice,
                    onConnectSaved = { addr -> viewModel.pairedDevices().firstOrNull { it.address == addr }?.let { viewModel.connect(it) } },
                    onConnect = { viewModel.connect(it) },
                    onDisconnect = { viewModel.disconnect() },
                    devices = viewModel.pairedDevices()
                )
            }
        }

        item { SensorGrid(readings = readings, isLandscape = isLandscape) }
        item { RawDebugPanel(readings = readings, debug = debug) }
    }
}

@Composable
private fun TruckNetworkPanel(
    adapterCount: Int,
    busProfile: J1939BusProfile,
    connectorProfile: J1939ConnectorProfile,
    onBusProfile: (J1939BusProfile) -> Unit,
    onConnectorProfile: (J1939ConnectorProfile) -> Unit,
    onConnect: () -> Unit
) {
    FleetCard(modifier = Modifier.fillMaxWidth()) {
        Text("Truck Network", style = MaterialTheme.typography.titleLarge)
        Spacer(modifier = Modifier.height(6.dp))
        Text(
            if (adapterCount == 0) "Connect an approved USB SLCAN J1939 interface to the tablet."
            else "$adapterCount USB J1939 interface${if (adapterCount == 1) "" else "s"} detected. Capture remains listen-only.",
            style = MaterialTheme.typography.bodyMedium
        )
        Spacer(modifier = Modifier.height(8.dp))
        Text("Bus speed", style = MaterialTheme.typography.labelLarge)
        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            J1939BusProfile.entries.forEach { option ->
                TextButton(onClick = { onBusProfile(option) }, modifier = Modifier.weight(1f)) {
                    Text(
                        option.label,
                        color = if (option == busProfile) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            }
        }
        Text("Truck connector", style = MaterialTheme.typography.labelLarge)
        J1939ConnectorProfile.entries.chunked(3).forEach { rowOptions ->
            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                rowOptions.forEach { option ->
                    TextButton(onClick = { onConnectorProfile(option) }, modifier = Modifier.weight(1f)) {
                        Text(
                            option.label,
                            color = if (option == connectorProfile) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                }
                repeat(3 - rowOptions.size) { Spacer(modifier = Modifier.weight(1f)) }
            }
        }
        if (adapterCount > 0) {
            Spacer(modifier = Modifier.height(4.dp))
            FleetButton(text = "Verify and connect truck network", onClick = onConnect, modifier = Modifier.fillMaxWidth())
        }
    }
}

@Composable
private fun PairedDevicesSection(
    savedDevice: String,
    onConnectSaved: (String) -> Unit,
    onConnect: (android.bluetooth.BluetoothDevice) -> Unit,
    onDisconnect: () -> Unit,
    devices: List<android.bluetooth.BluetoothDevice>
) {
    if (devices.isEmpty()) return
    FleetCard(modifier = Modifier.fillMaxWidth()) {
        Text(text = "Paired Devices", style = MaterialTheme.typography.titleLarge)
        Spacer(modifier = Modifier.height(8.dp))
        devices.forEach { device ->
            FleetButton(
                text = device.name ?: device.address,
                onClick = { onConnect(device) },
                modifier = Modifier.fillMaxWidth()
            )
            Spacer(modifier = Modifier.height(6.dp))
        }
        if (savedDevice.isNotBlank()) {
            FleetButton(
                text = "Connect saved dongle",
                onClick = { onConnectSaved(savedDevice) },
                modifier = Modifier.fillMaxWidth()
            )
            Spacer(modifier = Modifier.height(6.dp))
        }
        FleetButton(
            text = "Disconnect",
            onClick = onDisconnect,
            modifier = Modifier.fillMaxWidth()
        )
    }
}

@Composable
private fun ConnectionBanner(
    status: String,
    savedDevice: String,
    debug: com.fleetai.driver.telemetry.TelemetrySender.DebugState,
    hasPermissions: Boolean,
    onGrantPermissions: () -> Unit,
    demoMode: Boolean,
    onToggleDemo: () -> Unit,
    unitPrefs: SensorViewModel.UnitPrefs,
    onToggleUnits: () -> Unit
) {
    FleetCard(modifier = Modifier.fillMaxWidth()) {
        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text("Live Telemetry", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
            Text("Status: $status", style = MaterialTheme.typography.bodyMedium)
            Text("Saved dongle: ${savedDevice.ifBlank { "--" }}", style = MaterialTheme.typography.bodySmall)
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp), modifier = Modifier.fillMaxWidth()) {
                StatusPill(label = debug.protocol, good = debug.ecuResponding || status.contains("live", true))
                StatusPill(label = "Vehicle bus", good = debug.lastObdReadAt > 0 && System.currentTimeMillis() - debug.lastObdReadAt < 3000)
                StatusPill(label = "Live", good = debug.lastSendAt > 0 && System.currentTimeMillis() - debug.lastSendAt < 3000)
            }
            Text(
                "Last upload: ${debug.lastSendAt.toTime()} | PIDs: ${debug.supportedPidCount} | CAN frames: ${debug.rawFrameCount} | Queued: ${debug.queuedBatches}",
                style = MaterialTheme.typography.bodySmall
            )
            if (debug.protocol == "OBD2") {
                Text(
                    "Adapter: ${debug.adapterIdentity.ifBlank { "not identified" }} | Voltage: ${debug.adapterVoltage.ifBlank { "--" }}",
                    style = MaterialTheme.typography.bodySmall
                )
                Text(
                    "ECU: ${if (debug.ecuResponding) "responding" else "no response"} | Protocol: ${debug.detectedProtocol.ifBlank { "not detected" }}",
                    style = MaterialTheme.typography.bodySmall,
                    color = if (debug.ecuResponding) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.error
                )
            }
            if (debug.protocol == "J1939") {
                Text(
                    "Bus: ${debug.bitrate?.let { "${it / 1_000} kbit/s" } ?: "probing"} | Connector: ${debug.connectorProfile.replace('_', ' ')} | " +
                        "Bytes: ${debug.bytesReceived} | Rejected records: ${debug.rejectedRecords} | Reconnects: ${debug.reconnectCount}",
                    style = MaterialTheme.typography.bodySmall
                )
            }
            if (debug.lastError.isNotBlank()) {
                Text("Last error: ${debug.lastError}", color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
            }
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp), modifier = Modifier.fillMaxWidth()) {
                FleetButton(
                    text = if (hasPermissions) "Permissions OK" else "Grant Bluetooth",
                    onClick = onGrantPermissions,
                    modifier = Modifier.weight(1f)
                )
                FleetButton(
                    text = if (demoMode) "Demo On" else "Demo Off",
                    onClick = onToggleDemo,
                    modifier = Modifier.weight(1f)
                )
            }
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp), modifier = Modifier.fillMaxWidth()) {
                FleetButton(
                    text = "Units: ${if (unitPrefs.tempF) "F / mph" else "C / kph"}",
                    onClick = onToggleUnits,
                    modifier = Modifier.weight(1f)
                )
            }
        }
    }
}

@Composable
private fun StatusPill(label: String, good: Boolean) {
    val bg = if (good) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.errorContainer
    val fg = if (good) MaterialTheme.colorScheme.onPrimaryContainer else MaterialTheme.colorScheme.onErrorContainer
    Box(
        modifier = Modifier
            .background(bg, shape = MaterialTheme.shapes.small)
            .padding(horizontal = 10.dp, vertical = 4.dp)
    ) {
        Text(label, color = fg, style = MaterialTheme.typography.labelMedium)
    }
}

@Composable
private fun SensorGrid(readings: List<SensorReading>, isLandscape: Boolean) {
    val columns = if (isLandscape) 2 else 1
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        readings.chunked(columns).forEach { rowReadings ->
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                rowReadings.forEach { reading ->
                    SensorTile(reading, Modifier.weight(1f))
                }
                repeat(columns - rowReadings.size) {
                    Spacer(modifier = Modifier.weight(1f))
                }
            }
        }
    }
}

@Composable
private fun SensorTile(reading: SensorReading, modifier: Modifier = Modifier) {
    val alpha = when (reading.status) {
        SensorStatus.UNSUPPORTED -> 0.4f
        SensorStatus.STALE -> 0.6f
        else -> 1f
    }
    val trendIcon = when (reading.trend) {
        Trend.UP -> "UP"
        Trend.DOWN -> "DN"
        else -> "--"
    }
    FleetCard(
        modifier = modifier
            .fillMaxWidth()
            .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.2f))
    ) {
        Column(
            verticalArrangement = Arrangement.spacedBy(4.dp),
            modifier = Modifier.alpha(alpha)
        ) {
            Row(horizontalArrangement = Arrangement.SpaceBetween, modifier = Modifier.fillMaxWidth()) {
                Text(reading.label, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                StatusPill(
                    label = when (reading.status) {
                        SensorStatus.LIVE -> "Live"
                        SensorStatus.STALE -> "Stale"
                        SensorStatus.UNSUPPORTED -> "Unsupported"
                    },
                    good = reading.status == SensorStatus.LIVE
                )
            }
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(reading.value, style = MaterialTheme.typography.displaySmall, fontWeight = FontWeight.Bold)
                Spacer(modifier = Modifier.width(6.dp))
                Text(reading.unit, style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Spacer(modifier = Modifier.width(6.dp))
                Text(trendIcon, style = MaterialTheme.typography.titleMedium)
            }
            Text(
                "PID: ${reading.pid} - Updated ${reading.lastUpdated.toTime()}",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
    }
}

@Composable
private fun RawDebugPanel(readings: List<SensorReading>, debug: com.fleetai.driver.telemetry.TelemetrySender.DebugState) {
    var expanded by remember { mutableStateOf(false) }
    FleetCard(modifier = Modifier.fillMaxWidth()) {
        Row(horizontalArrangement = Arrangement.SpaceBetween, modifier = Modifier.fillMaxWidth()) {
            Text("Raw Data / Debug", style = MaterialTheme.typography.titleLarge)
            TextButton(onClick = { expanded = !expanded }) {
                Text(if (expanded) "Hide" else "Show")
            }
        }
        if (expanded) {
            readings.forEach {
                Text("${it.pid}: raw=${it.raw ?: "--"} smoothed=${it.smoothed ?: "--"} @ ${it.lastUpdated.toTime()}", style = MaterialTheme.typography.bodySmall)
            }
            Text("Last OBD read: ${debug.lastObdReadAt.toTime()} | Last send: ${debug.lastSendAt.toTime()}", style = MaterialTheme.typography.bodySmall)
            if (debug.protocol == "OBD2") {
                Text(
                    "Adapter=${debug.adapterIdentity.ifBlank { "--" }} protocol=${debug.detectedProtocol.ifBlank { "--" }} " +
                        "ECU=${debug.ecuState} command=${debug.lastObdCommand.ifBlank { "--" }} response=${debug.lastObdResponse.ifBlank { "--" }}",
                    style = MaterialTheme.typography.bodySmall
                )
            }
            if (debug.lastError.isNotBlank()) {
                Text("Errors: ${debug.errors} - ${debug.lastError}", color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
            }
        }
    }
}

private fun hasAllPermissions(context: android.content.Context, permissions: List<String>): Boolean {
    return permissions.all { perm ->
        ContextCompat.checkSelfPermission(context, perm) == android.content.pm.PackageManager.PERMISSION_GRANTED
    }
}

private fun Long.toTime(): String {
    return if (this > 0) SimpleDateFormat("HH:mm:ss").format(Date(this)) else "--"
}
