package com.fleetai.driver.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.MaterialTheme
import com.fleetai.driver.ui.components.FleetTextField as OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import com.fleetai.driver.AppGraph
import com.fleetai.driver.ui.components.FleetButton
import com.fleetai.driver.ui.components.FleetCard
import com.fleetai.driver.ui.viewmodel.SessionViewModel
import com.fleetai.driver.ui.viewmodel.VehicleViewModel

@Composable
fun VehicleSelectScreen(sessionViewModel: SessionViewModel) {
    val viewModel: VehicleViewModel = viewModel(factory = AppGraph.viewModelFactory)
    val vehicles by viewModel.vehicles.collectAsState()
    val message by viewModel.message.collectAsState()
    var query by remember { mutableStateOf("") }

    LaunchedEffect(Unit) {
        viewModel.loadVehicles()
    }

    Column(
        modifier = Modifier
            .padding(PaddingValues(16.dp)),
        verticalArrangement = Arrangement.spacedBy(16.dp)
    ) {
        FleetCard(modifier = Modifier.fillMaxWidth()) {
            Text(text = "Select Vehicle", style = MaterialTheme.typography.headlineMedium)
            Spacer(modifier = Modifier.height(8.dp))
            OutlinedTextField(
                value = query,
                onValueChange = { query = it },
                label = { Text("Search unit") },
                modifier = Modifier.fillMaxWidth()
            )
            if (message.isNotBlank()) {
                Spacer(modifier = Modifier.height(6.dp))
                Text(text = message, style = MaterialTheme.typography.bodySmall)
            }
        }

        val filtered = vehicles.filter { it.unitNumber.contains(query, ignoreCase = true) }
        if (filtered.isEmpty()) {
            FleetCard(modifier = Modifier.fillMaxWidth()) {
                Text(text = "No vehicles available. Check your company code.")
            }
        } else {
            LazyColumn(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                items(filtered) { vehicle ->
                    FleetCard(modifier = Modifier.fillMaxWidth()) {
                        Text(text = vehicle.unitNumber, style = MaterialTheme.typography.titleLarge)
                        Text(text = "${vehicle.make} ${vehicle.model}")
                        Text(text = "VIN: ${vehicle.vin}")
                        Spacer(modifier = Modifier.height(10.dp))
                        FleetButton(
                            text = "Use this vehicle",
                            onClick = { viewModel.selectVehicle(vehicle.id) { } },
                            modifier = Modifier.fillMaxWidth()
                        )
                    }
                }
            }
        }

        FleetButton(
            text = "Sign out",
            onClick = { sessionViewModel.logout() },
            modifier = Modifier.fillMaxWidth()
        )
    }
}
