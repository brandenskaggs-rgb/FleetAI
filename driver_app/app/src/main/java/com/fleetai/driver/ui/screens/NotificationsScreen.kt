package com.fleetai.driver.ui.screens

import android.Manifest
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
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
import com.fleetai.driver.ui.viewmodel.NotificationsViewModel

@Composable
fun NotificationsScreen(contentPadding: PaddingValues) {
    val viewModel: NotificationsViewModel = viewModel(factory = AppGraph.viewModelFactory)
    val items by viewModel.items.collectAsState()
    val context = LocalContext.current

    var hasNotificationsPermission by remember {
        mutableStateOf(hasNotificationPermission(context))
    }
    val permissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        hasNotificationsPermission = granted
    }

    Column(
        modifier = Modifier
            .padding(contentPadding)
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp)
    ) {
        FleetCard(modifier = Modifier.fillMaxWidth()) {
            Text(text = "Notifications", style = MaterialTheme.typography.headlineMedium)
            Spacer(modifier = Modifier.height(8.dp))
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && !hasNotificationsPermission) {
                FleetButton(
                    text = "Enable Notifications",
                    onClick = { permissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS) },
                    modifier = Modifier.fillMaxWidth()
                )
            }
            FleetButton(
                text = "Refresh",
                onClick = { viewModel.refresh() },
                modifier = Modifier.fillMaxWidth()
            )
        }

        if (items.isEmpty()) {
            FleetCard(modifier = Modifier.fillMaxWidth()) {
                Text(text = "No notifications yet.")
            }
        } else {
            LazyColumn(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                items(items) { note ->
                    FleetCard(modifier = Modifier.fillMaxWidth()) {
                        Text(text = note.title, style = MaterialTheme.typography.titleLarge)
                        Text(text = note.message)
                        Text(text = "Severity: ${note.severity}")
                        Text(text = "Time: ${note.timestamp}")
                        Spacer(modifier = Modifier.height(8.dp))
                        FleetButton(
                            text = if (note.read) "Read" else "Mark Read",
                            onClick = { viewModel.markRead(note.id) },
                            modifier = Modifier.fillMaxWidth()
                        )
                    }
                }
            }
        }
    }
}

private fun hasNotificationPermission(context: android.content.Context): Boolean {
    return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        ContextCompat.checkSelfPermission(
            context,
            Manifest.permission.POST_NOTIFICATIONS
        ) == android.content.pm.PackageManager.PERMISSION_GRANTED
    } else {
        true
    }
}
