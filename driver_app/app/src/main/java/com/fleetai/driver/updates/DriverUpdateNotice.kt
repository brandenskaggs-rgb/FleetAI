package com.fleetai.driver.updates

import android.content.Intent
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import androidx.core.net.toUri
import com.fleetai.driver.telemetry.ObdRuntime
import com.fleetai.driver.telemetry.J1939Runtime

@Composable
fun DriverUpdateNotice() {
    val state by DriverUpdates.state.collectAsState()
    val obdState by ObdRuntime.state.collectAsState()
    val j1939State by J1939Runtime.state.collectAsState()
    var dismissed by remember { mutableStateOf<Int?>(null) }
    var openingError by remember { mutableStateOf(false) }
    val release = state.release ?: return
    val context = LocalContext.current
    // Never interrupt a connected or reconnecting monitoring session with a modal.
    if (obdState != ObdRuntime.State.STOPPED || j1939State != J1939Runtime.State.STOPPED) return
    if (dismissed == release.versionCode) return
    AlertDialog(
        onDismissRequest = { dismissed = release.versionCode },
        title = { Text("Fleet AI ${release.versionName} available") },
        text = { Text(if (openingError) "No app could open the update link. Use Settings to try again or contact support."
            else "${release.notes}\n\nDo not uninstall Fleet AI. Android must accept the update with the same signing key to keep your login and pairing.") },
        confirmButton = { TextButton(onClick = {
            openingError = runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, release.url.toUri())) }.isFailure
            if (!openingError) dismissed = release.versionCode
        }) { Text("I'm parked - open update") } },
        dismissButton = { TextButton(onClick = { dismissed = release.versionCode }) { Text("Later") } }
    )
}
