package com.fleetai.driver

import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.NavigationRail
import androidx.compose.material3.NavigationRailItem
import androidx.compose.ui.unit.dp
import com.fleetai.driver.ui.components.FleetBrandMark
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.ListAlt
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material.icons.filled.Rule
import androidx.compose.material.icons.filled.Speed
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.lifecycle.ViewModelStore
import androidx.lifecycle.ViewModelStoreOwner
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation.NavDestination.Companion.hierarchy
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import com.fleetai.driver.navigation.MainRoute
import com.fleetai.driver.navigation.MainScreen
import com.fleetai.driver.navigation.MainNavGraph
import com.fleetai.driver.ui.screens.PairDeviceScreen
import com.fleetai.driver.ui.viewmodel.SessionState
import com.fleetai.driver.ui.viewmodel.SessionViewModel
import com.fleetai.driver.ui.viewmodel.SensorViewModel

private class MainTelemetryViewModelStoreOwner : ViewModelStoreOwner {
    override val viewModelStore = ViewModelStore()
}

@Composable
fun FleetAIDriverApp(
    sessionViewModel: SessionViewModel,
    sessionState: SessionState
) {
    when {
        !sessionState.isLoggedIn || sessionState.vehicleId.isBlank() -> {
            PairDeviceScreen(sessionViewModel = sessionViewModel, sessionState = sessionState)
        }
        else -> {
            MainScaffold(sessionState = sessionState)
        }
    }
}

@Composable
private fun MainScaffold(sessionState: SessionState) {
    val navController = rememberNavController()
    // One owner for the OBD transport, polling scheduler, and uploader. Route-scoped
    // instances would compete for the adapter and upload alternating partial snapshots.
    val telemetryOwner = remember { MainTelemetryViewModelStoreOwner() }
    DisposableEffect(telemetryOwner) {
        onDispose { telemetryOwner.viewModelStore.clear() }
    }
    val sensorViewModel: SensorViewModel = viewModel(
        viewModelStoreOwner = telemetryOwner,
        factory = AppGraph.viewModelFactory
    )
    val navBackStackEntry by navController.currentBackStackEntryAsState()
    val currentDestination = navBackStackEntry?.destination

    val items = listOf(
        MainScreen.Home,
        MainScreen.Logbook,
        MainScreen.Inspections,
        MainScreen.Sensors,
        MainScreen.Notifications
    )

    Surface(color = MaterialTheme.colorScheme.background) {
      BoxWithConstraints {
       val wide = maxWidth >= 840.dp
       Row {
        if (wide) {
            NavigationRail(
                modifier = Modifier.width(120.dp).fillMaxHeight().verticalScroll(rememberScrollState()),
                containerColor = MaterialTheme.colorScheme.surface,
                header = {
                    FleetBrandMark(Modifier.size(42.dp).padding(top = 4.dp))
                    Text("Fleet AI", style = MaterialTheme.typography.titleMedium)
                    Spacer(Modifier.height(24.dp))
                }
            ) {
                items.forEach { screen ->
                    NavigationRailItem(
                        modifier = Modifier.padding(vertical = 10.dp),
                        selected = currentDestination?.hierarchy?.any { it.route == screen.route } == true,
                        onClick = { navController.navigate(screen.route) {
                            popUpTo(MainRoute.Home) { saveState = true }
                            launchSingleTop = true
                            restoreState = screen != MainScreen.Home
                        } },
                        icon = { Icon(when (screen) {
                            MainScreen.Home -> Icons.Default.Home
                            MainScreen.Logbook -> Icons.Default.ListAlt
                            MainScreen.Inspections -> Icons.Default.Rule
                            MainScreen.Sensors -> Icons.Default.Speed
                            MainScreen.Notifications -> Icons.Default.Notifications
                        }, contentDescription = null) },
                        label = { Text(screen.label) }
                    )
                }
            }
        }
        Scaffold(
            modifier = Modifier.weight(1f).fillMaxSize(),
            bottomBar = {
              if (!wide) {
                NavigationBar(containerColor = MaterialTheme.colorScheme.surface) {
                    items.forEach { screen ->
                        val selected = currentDestination?.hierarchy?.any { it.route == screen.route } == true
                        val icon = when (screen) {
                            MainScreen.Home -> Icons.Default.Home
                            MainScreen.Logbook -> Icons.Default.ListAlt
                            MainScreen.Inspections -> Icons.Default.Rule
                            MainScreen.Sensors -> Icons.Default.Speed
                            MainScreen.Notifications -> Icons.Default.Notifications
                        }
                        NavigationBarItem(
                            selected = selected,
                            onClick = {
                                navController.navigate(screen.route) {
                                    popUpTo(MainRoute.Home) { saveState = true }
                                    launchSingleTop = true
                                    restoreState = screen != MainScreen.Home
                                }
                            },
                            icon = { Icon(imageVector = icon, contentDescription = screen.label) },
                            label = { Text(screen.label) },
                            colors = NavigationBarItemDefaults.colors(
                                selectedIconColor = MaterialTheme.colorScheme.primary,
                                selectedTextColor = MaterialTheme.colorScheme.primary,
                                indicatorColor = MaterialTheme.colorScheme.primary.copy(alpha = 0.10f),
                                unselectedIconColor = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.58f),
                                unselectedTextColor = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.58f)
                            )
                        )
                    }
                }
              }
            }
        ) { padding ->
            MainNavGraph(
                navController = navController,
                contentPadding = padding,
                sessionState = sessionState,
                sensorViewModel = sensorViewModel
            )
        }
       }
      }
    }
}
