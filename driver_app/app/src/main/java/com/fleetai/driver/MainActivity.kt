package com.fleetai.driver

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.enableEdgeToEdge
import androidx.activity.compose.setContent
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.SideEffect
import androidx.core.view.WindowCompat
import com.fleetai.driver.data.model.ThemeMode
import androidx.lifecycle.viewmodel.compose.viewModel
import com.fleetai.driver.ui.theme.FleetAITheme
import com.fleetai.driver.ui.viewmodel.SessionViewModel

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            val sessionViewModel: SessionViewModel = viewModel(factory = AppGraph.viewModelFactory)
            val sessionState by sessionViewModel.state.collectAsState()
            SideEffect {
                val light = sessionState.themeMode == ThemeMode.LIGHT
                WindowCompat.getInsetsController(window, window.decorView).apply {
                    isAppearanceLightStatusBars = light
                    isAppearanceLightNavigationBars = light
                }
            }
            FleetAITheme(themeMode = sessionState.themeMode) {
                FleetAIDriverApp(sessionViewModel = sessionViewModel, sessionState = sessionState)
            }
        }
    }
}
