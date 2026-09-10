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
import com.fleetai.driver.ui.components.FleetTextField as OutlinedTextField
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.ui.Alignment
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
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
import com.fleetai.driver.ui.viewmodel.InspectionViewModel

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
    "Exhaust and emissions equipment"
)

@Composable
fun InspectionScreen(
    contentPadding: PaddingValues,
    sessionState: SessionState,
    viewModel: InspectionViewModel
) {
    var inspectionType by remember { mutableStateOf("Pre-trip") }
    var odometer by remember { mutableStateOf("") }
    var notes by remember { mutableStateOf("") }
    var signature by remember { mutableStateOf("") }
    val message by viewModel.message.collectAsState()
    val submitting by viewModel.submitting.collectAsState()
    val results = remember { mutableStateMapOf<String, ItemResult>() }

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
                "Mark each item Pass, Defect, or Not applicable. Report safety-related defects before operating.",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.68f)
            )
            Spacer(modifier = Modifier.height(12.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                listOf("Pre-trip", "Post-trip").forEach { type ->
                    FilterChip(
                        border = null,
                        selected = inspectionType == type,
                        onClick = { inspectionType = type },
                        label = { Text(type) }
                    )
                }
            }
            Spacer(modifier = Modifier.height(12.dp))
            Text("Vehicle ${sessionState.vehicleId.ifBlank { "--" }}", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
            Text("${results.size} of ${InspectionItems.size} checks recorded", style = MaterialTheme.typography.bodyLarge)
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
                InspectionChoiceRow(item, results[item]) { results[item] = it }
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
                    if (results.size != InspectionItems.size || odometer.isBlank() || signature.isBlank()) {
                        return@FleetButton
                    }
                    if (defects > 0 && notes.isBlank()) {
                        return@FleetButton
                    }
                    val inspectedItems = InspectionItems.map { item ->
                        val result = when (results[item]) {
                            ItemResult.DEFECT -> "defect"
                            ItemResult.NA -> "not_applicable"
                            else -> "pass"
                        }
                        "$item: $result"
                    }
                    viewModel.submit(
                        type = inspectionType,
                        odometer = odometer.toLongOrNull() ?: 0L,
                        inspectedItems = inspectedItems,
                        defects = notes,
                        signature = signature
                    )
                },
                modifier = Modifier.fillMaxWidth(),
                enabled = !submitting && results.size == InspectionItems.size &&
                    odometer.isNotBlank() && signature.isNotBlank() &&
                    (results.values.none { it == ItemResult.DEFECT } || notes.isNotBlank())
            )
            Spacer(modifier = Modifier.height(10.dp))
            Text(message, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.72f))
        }
    }
}

@Composable
private fun InspectionChoiceRow(item: String, selected: ItemResult?, onSelect: (ItemResult) -> Unit) {
    val choices: @Composable () -> Unit = {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            ItemResult.entries.forEach { result ->
                FilterChip(
                    modifier = Modifier.heightIn(min = 52.dp),
                    selected = selected == result, onClick = { onSelect(result) }, border = null,
                    colors = FilterChipDefaults.filterChipColors(
                        containerColor = MaterialTheme.colorScheme.surfaceVariant,
                        selectedContainerColor = MaterialTheme.colorScheme.primary,
                        selectedLabelColor = MaterialTheme.colorScheme.onPrimary
                    ),
                    label = { Text(when (result) {
                        ItemResult.PASS -> "Pass"
                        ItemResult.DEFECT -> "Defect"
                        ItemResult.NA -> "N/A"
                    }) }
                )
            }
        }
    }
    BoxWithConstraints(Modifier.fillMaxWidth()) {
        if (maxWidth >= 600.dp) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(24.dp)) {
                Text(item, Modifier.weight(1f), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                choices()
            }
        } else {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text(item, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                choices()
            }
        }
    }
}
