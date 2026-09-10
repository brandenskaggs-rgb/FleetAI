package com.fleetai.driver.ui.screens

import android.content.Intent
import androidx.core.net.toUri
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.heightIn
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.material.icons.filled.Visibility
import androidx.compose.material.icons.filled.VisibilityOff
import androidx.compose.material3.IconButton
import com.fleetai.driver.R
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
import androidx.compose.material3.TextButton
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.ui.graphics.Color
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
import com.fleetai.driver.ui.components.FleetBrandMark
import com.fleetai.driver.ui.components.FleetCard
import com.fleetai.driver.ui.viewmodel.SessionState
import com.fleetai.driver.ui.viewmodel.SessionViewModel

@Composable
@OptIn(ExperimentalLayoutApi::class)
fun PairDeviceScreen(
    sessionViewModel: SessionViewModel,
    sessionState: SessionState
) {
    val context = LocalContext.current
    var pairingCode by remember { mutableStateOf("") }
    var driverPin by remember { mutableStateOf("") }
    var deviceLabel by remember { mutableStateOf("Fleet AI Tablet") }
    var statusMessage by remember { mutableStateOf("") }
    var isSubmitting by remember { mutableStateOf(false) }
    var showPin by remember { mutableStateOf(false) }
    var showDetails by remember { mutableStateOf(false) }

    Surface(color = MaterialTheme.colorScheme.background) {
      BoxWithConstraints {
        val wide = maxWidth >= 840.dp
        val paneWidth = if (wide) minOf(500.dp, (maxWidth - 80.dp) / 2) else minOf(600.dp, maxWidth - 40.dp)
        Column(
            modifier = Modifier
                .fillMaxSize()
                .safeDrawingPadding()
                .imePadding()
                .verticalScroll(rememberScrollState())
                .padding(20.dp),
            verticalArrangement = Arrangement.Center,
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
            FlowRow(
                modifier = Modifier
                    .widthIn(max = if (wide) 1040.dp else paneWidth)
                    .fillMaxWidth(),
                verticalArrangement = Arrangement.spacedBy(24.dp),
                horizontalArrangement = Arrangement.spacedBy(40.dp),
                maxItemsInEachRow = if (wide) 2 else 1
            ) {
                Column(modifier = Modifier.width(paneWidth)) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                        FleetBrandMark(modifier = Modifier.width(48.dp).height(48.dp))
                        Text("Fleet AI", style = MaterialTheme.typography.headlineSmall)
                    }
                    Spacer(modifier = Modifier.height(12.dp))
                    Text("Connect your tablet", style = MaterialTheme.typography.headlineLarge)
                    Spacer(modifier = Modifier.height(8.dp))
                    Text(
                        "Enter the pairing code and driver PIN issued by your fleet manager.",
                        style = MaterialTheme.typography.bodyLarge,
                        color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.70f)
                    )
                    Spacer(modifier = Modifier.height(14.dp))
                    Image(painterResource(R.drawable.fleetai_connection), contentDescription = null,
                        contentScale = ContentScale.Fit, modifier = Modifier.fillMaxWidth().height(if (wide) 280.dp else 100.dp))
                }

                FleetCard(modifier = Modifier.width(paneWidth)) {
                    TextField(
                        colors = pairingFieldColors(),
                        value = pairingCode,
                        onValueChange = { raw ->
                            pairingCode = raw.filter(Char::isDigit).take(6)
                        },
                        leadingIcon = { Icon(Icons.Default.Pin, contentDescription = null) },
                        label = { Text("1. Pairing code (6 digits)") },
                        enabled = !isSubmitting,
                        textStyle = MaterialTheme.typography.headlineSmall,
                        singleLine = true,
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                        modifier = Modifier.fillMaxWidth()
                    )
                    Spacer(modifier = Modifier.height(12.dp))
                    TextField(
                        colors = pairingFieldColors(),
                        value = driverPin,
                        onValueChange = { raw -> driverPin = raw.filter(Char::isDigit).take(6) },
                        leadingIcon = { Icon(Icons.Default.AdminPanelSettings, contentDescription = null) },
                        label = { Text("2. Driver PIN (6 digits)") },
                        enabled = !isSubmitting,
                        textStyle = MaterialTheme.typography.headlineSmall,
                        singleLine = true,
                        visualTransformation = if (showPin) VisualTransformation.None else PasswordVisualTransformation(),
                        trailingIcon = { IconButton(onClick = { showPin = !showPin }) {
                            Icon(if (showPin) Icons.Default.VisibilityOff else Icons.Default.Visibility,
                                contentDescription = if (showPin) "Hide PIN" else "Show PIN")
                        } },
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword),
                        modifier = Modifier.fillMaxWidth()
                    )
                    Spacer(modifier = Modifier.height(12.dp))
                    TextButton(onClick = { showDetails = !showDetails }, enabled = !isSubmitting) {
                        Text(if (showDetails) "Hide tablet details" else "Tablet details")
                    }
                    if (showDetails) {
                    Text("Device ${sessionState.deviceId.take(10)}", style = MaterialTheme.typography.bodySmall)
                    TextField(
                        colors = pairingFieldColors(),
                        value = deviceLabel,
                        onValueChange = { deviceLabel = it.take(48) },
                        leadingIcon = { Icon(Icons.Default.Devices, contentDescription = null) },
                        label = { Text("Tablet label") },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth()
                    )
                    }
                    Spacer(modifier = Modifier.height(16.dp))
                    FleetButton(
                        text = if (isSubmitting) "Pairing..." else "Pair tablet",
                        enabled = !isSubmitting,
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
                    if (statusMessage.isNotBlank()) {
                        Text(statusMessage, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurface)
                    }
                    Spacer(modifier = Modifier.height(12.dp))
                    if (showDetails) {
                    if (com.fleetai.driver.BuildConfig.DEBUG) {
                        TextButton(
                            onClick = { context.startActivity(Intent(context, ConnectActivity::class.java)) },
                            modifier = Modifier.fillMaxWidth()
                        ) {
                            Text("Server settings")
                        }
                    }
                    TextButton(
                        onClick = { sessionViewModel.startTrainingDemo() },
                        modifier = Modifier.fillMaxWidth()
                    ) {
                        Text("View training demo")
                    }
                    Text(
                        "Training demo uses sample data and does not access a fleet account.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.62f)
                    )
                    }
                    androidx.compose.material3.TextButton(
                        onClick = {
                            context.startActivity(Intent(Intent.ACTION_VIEW, "https://fleetaiops.com/legal/privacy.html".toUri()))
                        },
                        modifier = Modifier.fillMaxWidth()
                    ) {
                        Text("Privacy policy")
                    }
                }
            }
        }
      }
    }
}

@Composable
private fun pairingFieldColors() = TextFieldDefaults.colors(
    focusedContainerColor = MaterialTheme.colorScheme.surfaceVariant,
    unfocusedContainerColor = MaterialTheme.colorScheme.surfaceVariant,
    focusedIndicatorColor = Color.Transparent,
    unfocusedIndicatorColor = Color.Transparent
)
