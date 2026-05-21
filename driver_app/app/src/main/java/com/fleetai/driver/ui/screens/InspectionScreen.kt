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
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.fleetai.driver.ui.components.FleetButton
import com.fleetai.driver.ui.components.FleetCard
import com.fleetai.driver.ui.viewmodel.SessionState

private enum class ItemResult { PASS, DEFECT, NA }

private val InspectionItems = listOf(
    "Service brakes",
    "Parking brake",
    "Steering",
    "Lights and reflectors",
    "Tires, wheels, and rims",
    "Horn",
    "Windshield and wipers",
    "Mirrors",
    "Coupling devices",
    "Emergency equipment",
    "Cargo securement",
    "California emissions readiness"
)

@Composable
fun InspectionScreen(contentPadding: PaddingValues, sessionState: SessionState) {
    var inspectionType by remember { mutableStateOf("Pre-trip") }
    var odometer by remember { mutableStateOf("") }
    var notes by remember { mutableStateOf("") }
    var signature by remember { mutableStateOf("") }
    var message by remember { mutableStateOf("Complete each required item before submitting.") }
    val results = remember {
        mutableStateMapOf<String, ItemResult>().also { map ->
            InspectionItems.forEach { map[it] = ItemResult.PASS }
        }
    }

    Column(
        modifier = Modifier
            .padding(contentPadding)
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp)
    ) {
        FleetCard(modifier = Modifier.fillMaxWidth()) {
            Text("Vehicle inspection", style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.ExtraBold)
            Spacer(modifier = Modifier.height(6.dp))
            Text(
                "Record pass, defect, or not inspected. Defects should be reviewed before redispatch when safety is affected.",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.68f)
            )
            Spacer(modifier = Modifier.height(12.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                listOf("Pre-trip", "Post-trip").forEach { type ->
                    FilterChip(
                        selected = inspectionType == type,
                        onClick = { inspectionType = type },
                        label = { Text(type) }
                    )
                }
            }
            Spacer(modifier = Modifier.height(12.dp))
            Text("Vehicle ${sessionState.vehicleId.ifBlank { "--" }}", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
        }

        FleetCard(modifier = Modifier.fillMaxWidth()) {
            OutlinedTextField(
                value = odometer,
                onValueChange = { odometer = it.filter(Char::isDigit).take(9) },
                label = { Text("Odometer") },
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                modifier = Modifier.fillMaxWidth()
            )
        }

        InspectionItems.forEach { item ->
            FleetCard(modifier = Modifier.fillMaxWidth()) {
                Text(item, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.ExtraBold)
                Spacer(modifier = Modifier.height(10.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
                    ItemResult.values().forEach { result ->
                        FilterChip(
                            selected = results[item] == result,
                            onClick = { results[item] = result },
                            label = {
                                Text(
                                    when (result) {
                                        ItemResult.PASS -> "Pass"
                                        ItemResult.DEFECT -> "Defect"
                                        ItemResult.NA -> "N/A"
                                    }
                                )
                            }
                        )
                    }
                }
            }
        }

        FleetCard(modifier = Modifier.fillMaxWidth()) {
            OutlinedTextField(
                value = notes,
                onValueChange = { notes = it.take(1000) },
                label = { Text("Defect notes / repair instructions") },
                minLines = 3,
                modifier = Modifier.fillMaxWidth()
            )
            Spacer(modifier = Modifier.height(12.dp))
            OutlinedTextField(
                value = signature,
                onValueChange = { signature = it.take(80) },
                label = { Text("Driver signature") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth()
            )
            Spacer(modifier = Modifier.height(14.dp))
            FleetButton(
                text = "Submit inspection",
                onClick = {
                    val defects = results.values.count { it == ItemResult.DEFECT }
                    if (odometer.isBlank() || signature.isBlank()) {
                        message = "Odometer and driver signature are required."
                        return@FleetButton
                    }
                    if (defects > 0 && notes.isBlank()) {
                        message = "Add notes for any defect before submitting."
                        return@FleetButton
                    }
                    message = "$inspectionType inspection saved locally. Sync endpoint wiring is next."
                },
                modifier = Modifier.fillMaxWidth()
            )
            Spacer(modifier = Modifier.height(10.dp))
            Text(message, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.72f))
        }
    }
}
