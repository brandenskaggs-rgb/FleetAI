package com.fleetai.driver.navigation

import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import com.fleetai.driver.ui.screens.DiagnosticsScreen
import com.fleetai.driver.ui.screens.HomeScreen
import com.fleetai.driver.ui.screens.InspectionScreen
import com.fleetai.driver.ui.screens.LogbookScreen
import com.fleetai.driver.ui.screens.NotificationsScreen
import com.fleetai.driver.ui.screens.RouteScreen
import com.fleetai.driver.ui.screens.SensorsScreen
import com.fleetai.driver.ui.screens.SettingsScreen
import com.fleetai.driver.ui.screens.StatusScreen
import com.fleetai.driver.ui.viewmodel.SessionState

object MainRoute {
    const val Home = "home"
    const val Logbook = "logbook"
    const val Inspections = "inspections"
    const val Sensors = "sensors"
    const val Notifications = "notifications"
    const val Status = "status"
    const val Diagnostics = "diagnostics"
    const val Route = "route"
    const val Settings = "settings"
}

sealed class MainScreen(val route: String, val label: String) {
    data object Home : MainScreen(MainRoute.Home, "Home")
    data object Logbook : MainScreen(MainRoute.Logbook, "Logbook")
    data object Inspections : MainScreen(MainRoute.Inspections, "Inspect")
    data object Sensors : MainScreen(MainRoute.Sensors, "Sensors")
    data object Notifications : MainScreen(MainRoute.Notifications, "Notifications")
}

@Composable
fun MainNavGraph(
    navController: NavHostController,
    contentPadding: PaddingValues,
    sessionState: SessionState
) {
    NavHost(
        navController = navController,
        startDestination = MainRoute.Home,
        modifier = Modifier
    ) {
        composable(MainRoute.Home) {
            HomeScreen(
                contentPadding = contentPadding,
                sessionState = sessionState,
                onOpenStatus = { navController.navigate(MainRoute.Status) },
                onOpenDiagnostics = { navController.navigate(MainRoute.Diagnostics) },
                onOpenRoute = { navController.navigate(MainRoute.Route) },
                onOpenSettings = { navController.navigate(MainRoute.Settings) }
            )
        }
        composable(MainRoute.Logbook) {
            LogbookScreen(contentPadding = contentPadding)
        }
        composable(MainRoute.Inspections) {
            InspectionScreen(contentPadding = contentPadding, sessionState = sessionState)
        }
        composable(MainRoute.Sensors) {
            SensorsScreen(contentPadding = contentPadding)
        }
        composable(MainRoute.Notifications) {
            NotificationsScreen(contentPadding = contentPadding)
        }
        composable(MainRoute.Status) {
            StatusScreen(contentPadding = contentPadding)
        }
        composable(MainRoute.Diagnostics) {
            DiagnosticsScreen(contentPadding = contentPadding)
        }
        composable(MainRoute.Route) {
            RouteScreen(contentPadding = contentPadding)
        }
        composable(MainRoute.Settings) {
            SettingsScreen(contentPadding = contentPadding)
        }
    }
}
