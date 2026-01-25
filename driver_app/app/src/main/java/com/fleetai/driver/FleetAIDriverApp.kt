package com.fleetai.driver

import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.ListAlt
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material.icons.filled.Speed
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.navigation.NavDestination.Companion.hierarchy
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import com.fleetai.driver.navigation.MainRoute
import com.fleetai.driver.navigation.MainScreen
import com.fleetai.driver.navigation.MainNavGraph
import com.fleetai.driver.ui.screens.LoginScreen
import com.fleetai.driver.ui.screens.PairDeviceScreen
import com.fleetai.driver.ui.viewmodel.SessionState
import com.fleetai.driver.ui.viewmodel.SessionViewModel

@Composable
fun FleetAIDriverApp(
    sessionViewModel: SessionViewModel,
    sessionState: SessionState
) {
    when {
        !sessionState.isLoggedIn -> {
            LoginScreen(sessionViewModel = sessionViewModel)
        }
        sessionState.vehicleId.isBlank() -> {
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
    val navBackStackEntry by navController.currentBackStackEntryAsState()
    val currentDestination = navBackStackEntry?.destination

    val items = listOf(
        MainScreen.Home,
        MainScreen.Logbook,
        MainScreen.Sensors,
        MainScreen.Notifications
    )

    Surface(color = MaterialTheme.colorScheme.background) {
        Scaffold(
            modifier = Modifier.fillMaxSize(),
            bottomBar = {
                NavigationBar(containerColor = MaterialTheme.colorScheme.surfaceVariant) {
                    items.forEach { screen ->
                        val selected = currentDestination?.hierarchy?.any { it.route == screen.route } == true
                        val icon = when (screen) {
                            MainScreen.Home -> Icons.Default.Home
                            MainScreen.Logbook -> Icons.Default.ListAlt
                            MainScreen.Sensors -> Icons.Default.Speed
                            MainScreen.Notifications -> Icons.Default.Notifications
                        }
                        NavigationBarItem(
                            selected = selected,
                            onClick = {
                                navController.navigate(screen.route) {
                                    popUpTo(MainRoute.Home) { saveState = true }
                                    launchSingleTop = true
                                    restoreState = true
                                }
                            },
                            icon = { Icon(imageVector = icon, contentDescription = screen.label) },
                            label = { Text(screen.label) }
                        )
                    }
                }
            }
        ) { padding ->
            MainNavGraph(
                navController = navController,
                contentPadding = padding,
                sessionState = sessionState
            )
        }
    }
}
