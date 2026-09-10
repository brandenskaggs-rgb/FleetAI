package com.fleetai.driver.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import com.fleetai.driver.data.model.ThemeMode

private val FleetDarkScheme = darkColorScheme(
    primary = Color(0xFFF1F4F3),
    primaryContainer = Color(0xFF34433E),
    onPrimaryContainer = Color(0xFFF1F4F3),
    secondary = FleetGreen,
    secondaryContainer = Color(0xFF303942),
    onSecondaryContainer = Color(0xFFF1F4F7),
    tertiary = FleetCyan,
    background = FleetBlueDark,
    surface = Color(0xFF232A32),
    surfaceVariant = Color(0xFF303942),
    onSurfaceVariant = Color(0xFFD4DCE5),
    outline = Color(0xFF8C99A8),
    onPrimary = Color(0xFF172225),
    onSecondary = Color.White,
    onBackground = Color.White,
    onSurface = Color.White
)

private val FleetLightScheme = lightColorScheme(
    primary = FleetBlue,
    primaryContainer = Color(0xFFE1EAE5),
    onPrimaryContainer = Color(0xFF172225),
    secondary = FleetGreen,
    secondaryContainer = FleetSurfaceHigh,
    onSecondaryContainer = FleetText,
    tertiary = FleetCyan,
    background = FleetBackground,
    surface = FleetSurface,
    surfaceVariant = FleetSurfaceHigh,
    onPrimary = Color.White,
    onSecondary = Color.White,
    onBackground = FleetText,
    onSurface = FleetText,
    onSurfaceVariant = FleetTextMuted,
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
