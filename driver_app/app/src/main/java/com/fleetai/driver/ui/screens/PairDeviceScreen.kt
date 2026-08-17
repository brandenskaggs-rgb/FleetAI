package com.fleetai.driver.ui.screens

import android.content.Intent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AdminPanelSettings
import androidx.compose.material.icons.filled.Devices
import androidx.compose.material.icons.filled.Pin
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import com.fleetai.driver.ConnectActivity
import com.fleetai.driver.ui.components.FleetButton
import com.fleetai.driver.ui.components.FleetCard
import com.fleetai.driver.ui.viewmodel.SessionState
import com.fleetai.driver.ui.viewmodel.SessionViewModel

@Composable
fun PairDeviceScreen(
    sessionViewModel: SessionViewModel,
    sessionState: SessionState
) {
    val context = LocalContext.current
    var pairingCode by remember { mutableStateOf("") }
    var driverPin by remember { mutableStateOf("") }
    var deviceLabel by remember { mutableStateOf("Fleet AI Tablet") }
    var statusMessage by remember { mutableStateOf("Enter both six-digit values shown in Fleet AI dispatch.") }
    var isSubmitting by remember { mutableStateOf(false) }

    Surface(color = MaterialTheme.colorScheme.background) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(20.dp),
            verticalArrangement = Arrangement.Center,
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .widthIn(max = 1040.dp),
                horizontalArrangement = Arrangement.spacedBy(18.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                FleetCard(modifier = Modifier.weight(1f)) {
                    Text("Activate this tablet", style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.ExtraBold)
                    Spacer(modifier = Modifier.height(8.dp))
                    Text(
                        "The pairing code and driver PIN securely identify the company, driver, vehicle, and this tablet in one step. The PIN is not stored on the device.",
                        style = MaterialTheme.typography.bodyLarge,
                        color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.70f)
                    )
                    Spacer(modifier = Modifier.height(14.dp))
                    AssistChip(
                        onClick = {},
                        label = { Text("Secure dispatch activation") },
                        leadingIcon = { Icon(Icons.Default.AdminPanelSettings, contentDescription = null) }
                    )
                    Spacer(modifier = Modifier.height(8.dp))
                    AssistChip(
                        onClick = {},
                        label = { Text("Device: ${sessionState.deviceId.take(10)}") },
                        leadingIcon = { Icon(Icons.Default.Devices, contentDescription = null) }
                    )
                }

                FleetCard(modifier = Modifier.weight(0.95f)) {
                    Text("Enter dispatch codes", style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.ExtraBold)
                    Spacer(modifier = Modifier.height(16.dp))
                    OutlinedTextField(
                        value = pairingCode,
                        onValueChange = { raw ->
                            pairingCode = raw.filter(Char::isDigit).take(6)
                        },
                        leadingIcon = { Icon(Icons.Default.Pin, contentDescription = null) },
                        label = { Text("Pairing code") },
                        singleLine = true,
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                        modifier = Modifier.fillMaxWidth()
                    )
                    Spacer(modifier = Modifier.height(12.dp))
                    OutlinedTextField(
                        value = driverPin,
                        onValueChange = { raw -> driverPin = raw.filter(Char::isDigit).take(6) },
                        leadingIcon = { Icon(Icons.Default.AdminPanelSettings, contentDescription = null) },
                        label = { Text("Driver PIN") },
                        singleLine = true,
                        visualTransformation = PasswordVisualTransformation(),
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword),
                        modifier = Modifier.fillMaxWidth()
                    )
                    Spacer(modifier = Modifier.height(12.dp))
                    OutlinedTextField(
                        value = deviceLabel,
                        onValueChange = { deviceLabel = it.take(48) },
                        leadingIcon = { Icon(Icons.Default.Devices, contentDescription = null) },
                        label = { Text("Tablet label") },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth()
                    )
                    Spacer(modifier = Modifier.height(16.dp))
                    FleetButton(
                        text = if (isSubmitting) "Pairing..." else "Pair tablet",
                        onClick = {
                            if (pairingCode.length != 6) {
                                statusMessage = "Enter the 6-digit pairing code from dispatch."
                                return@FleetButton
                            }
                            if (driverPin.length != 6) {
                                statusMessage = "Enter the 6-digit driver PIN from dispatch."
                                return@FleetButton
                            }
                            isSubmitting = true
                            sessionViewModel.claimPairing(pairingCode, driverPin, deviceLabel) { success, message ->
                                statusMessage = if (success) "Paired. Loading vehicle console." else message
                                isSubmitting = false
                            }
                        },
                        modifier = Modifier.fillMaxWidth()
                    )
                    Spacer(modifier = Modifier.height(12.dp))
                    Text(statusMessage, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.72f))
                    Spacer(modifier = Modifier.height(12.dp))
                    OutlinedButton(
                        onClick = { context.startActivity(Intent(context, ConnectActivity::class.java)) },
                        modifier = Modifier.fillMaxWidth()
                    ) {
                        Text("Server settings")
                    }
                    OutlinedButton(
                        onClick = { sessionViewModel.logout() },
                        modifier = Modifier.fillMaxWidth()
                    ) {
                        Text("Sign out")
                    }
                }
            }
        }
    }
}
