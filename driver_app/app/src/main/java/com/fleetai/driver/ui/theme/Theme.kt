package com.fleetai.driver.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import com.fleetai.driver.data.model.ThemeMode

private val FleetDarkScheme = darkColorScheme(
    primary = FleetBlue,
    secondary = FleetGreen,
    tertiary = FleetCyan,
    background = FleetBlueDark,
    surface = Color(0xFF0B1830),
    surfaceVariant = Color(0xFF132340),
    onPrimary = Color.White,
    onSecondary = Color.White,
    onBackground = Color.White,
    onSurface = Color.White
)

private val FleetLightScheme = lightColorScheme(
    primary = FleetBlue,
    secondary = FleetGreen,
    tertiary = FleetCyan,
    background = FleetBackground,
    surface = FleetSurface,
    surfaceVariant = FleetSurfaceHigh,
    onPrimary = Color.White,
    onSecondary = Color.White,
    onBackground = FleetText,
    onSurface = FleetText,
    outline = FleetBorder,
    error = FleetDanger
)

@Composable
fun FleetAITheme(themeMode: ThemeMode, content: @Composable () -> Unit) {
    val scheme = if (themeMode == ThemeMode.LIGHT) FleetLightScheme else FleetDarkScheme
    MaterialTheme(
        colorScheme = scheme,
        typography = FleetTypography,
        content = content
    )
}
