package com.fleetai.driver.ui.components

import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.fleetai.driver.ui.theme.FleetDanger
import com.fleetai.driver.ui.theme.FleetWarning

@Composable
fun WarningBanner(message: String, isCritical: Boolean) {
    val color = if (isCritical) FleetDanger else FleetWarning
    Surface(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 6.dp),
        color = color.copy(alpha = 0.15f),
        contentColor = color,
        tonalElevation = 2.dp
    ) {
        Text(
            text = message,
            modifier = Modifier.padding(12.dp),
            style = MaterialTheme.typography.bodyLarge
        )
    }
}
