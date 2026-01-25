package com.fleetai.driver.ui.screens

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
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
import androidx.compose.ui.unit.dp
import androidx.compose.ui.platform.LocalContext
import android.content.Intent
import com.fleetai.driver.ConnectActivity
import com.fleetai.driver.ui.components.FleetButton
import com.fleetai.driver.ui.components.FleetCard
import com.fleetai.driver.ui.viewmodel.SessionViewModel

@Composable
fun LoginScreen(sessionViewModel: SessionViewModel) {
    val context = LocalContext.current
    var companyCode by remember { mutableStateOf("") }
    var driverPin by remember { mutableStateOf("") }
    var statusMessage by remember { mutableStateOf("Enter company code and driver PIN.") }

    FleetCard(modifier = Modifier.fillMaxWidth()) {
        Text(text = "Fleet AI Driver", style = MaterialTheme.typography.headlineMedium)
        Spacer(modifier = Modifier.height(12.dp))

        OutlinedTextField(
            value = companyCode,
            onValueChange = { companyCode = it },
            label = { Text("Company code") },
            modifier = Modifier.fillMaxWidth()
        )
        Spacer(modifier = Modifier.height(10.dp))
        OutlinedTextField(
            value = driverPin,
            onValueChange = { driverPin = it },
            label = { Text("Driver PIN") },
            modifier = Modifier.fillMaxWidth()
        )
        Spacer(modifier = Modifier.height(16.dp))

        FleetButton(
            text = "Sign In",
            onClick = {
                if (companyCode.isBlank() || driverPin.isBlank()) {
                    statusMessage = "Company code and PIN required."
                    return@FleetButton
                }
                sessionViewModel.login(companyCode, driverPin) { success, error ->
                    statusMessage = if (success) "Signed in." else error
                }
            },
            modifier = Modifier.fillMaxWidth()
        )

        Spacer(modifier = Modifier.height(16.dp))
        Text(text = statusMessage, style = MaterialTheme.typography.bodyMedium)

        Spacer(modifier = Modifier.height(8.dp))
        TextButton(
            onClick = {
                context.startActivity(Intent(context, ConnectActivity::class.java))
            }
        ) {
            Text(text = "Server settings")
        }
    }
}
