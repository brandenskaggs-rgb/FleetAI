package com.fleetai.driver.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import android.content.Intent
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
    var deviceLabel by remember { mutableStateOf("Tablet 01") }
    var statusMessage by remember { mutableStateOf("Enter the 6-digit pairing code from dispatch.") }
    var isSubmitting by remember { mutableStateOf(false) }

    Column(
        modifier = Modifier.padding(PaddingValues(16.dp)),
        verticalArrangement = Arrangement.spacedBy(16.dp)
    ) {
        FleetCard(modifier = Modifier.fillMaxWidth()) {
            Text(text = "Pair Device", style = MaterialTheme.typography.headlineMedium)
            Spacer(modifier = Modifier.height(8.dp))
            Text(
                text = "Device ID: ${sessionState.deviceId}",
                style = MaterialTheme.typography.bodySmall
            )
            Spacer(modifier = Modifier.height(12.dp))

            OutlinedTextField(
                value = pairingCode,
                onValueChange = { raw ->
                    pairingCode = raw
                        .filter(Char::isLetterOrDigit)
                        .uppercase()
                        .take(6)
                },
                label = { Text("Pairing code") },
                modifier = Modifier.fillMaxWidth()
            )
            Spacer(modifier = Modifier.height(10.dp))
            OutlinedTextField(
                value = deviceLabel,
                onValueChange = { deviceLabel = it },
                label = { Text("Device label") },
                modifier = Modifier.fillMaxWidth()
            )
            Spacer(modifier = Modifier.height(16.dp))

            FleetButton(
                text = if (isSubmitting) "Pairing..." else "Claim & Pair",
                onClick = {
                    if (pairingCode.isBlank()) {
                        statusMessage = "Pairing code required."
                        return@FleetButton
                    }
                    isSubmitting = true
                    sessionViewModel.claimPairing(pairingCode, deviceLabel) { success, message ->
                        statusMessage = if (success) "Paired. Loading home..." else message
                        isSubmitting = false
                    }
                },
                modifier = Modifier.fillMaxWidth()
            )
            Spacer(modifier = Modifier.height(12.dp))
            Text(text = statusMessage, style = MaterialTheme.typography.bodyMedium)
            Spacer(modifier = Modifier.height(4.dp))
            TextButton(
                onClick = { context.startActivity(Intent(context, ConnectActivity::class.java)) }
            ) {
                Text(text = "Server settings")
            }
        }

        FleetButton(
            text = "Sign out",
            onClick = { sessionViewModel.logout() },
            modifier = Modifier.fillMaxWidth()
        )
    }
}
