package com.fleetai.driver.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import com.fleetai.driver.data.model.ThemeMode

private val FleetDarkScheme = darkColorScheme(
    primary = FleetBlue,
    secondary = FleetCyan,
    tertiary = FleetCyan,
    background = FleetBackground,
    surface = FleetSurface,
    surfaceVariant = FleetSurfaceHigh,
    onPrimary = FleetText,
    onSecondary = FleetText,
    onBackground = FleetText,
    onSurface = FleetText
)

private val FleetLightScheme = lightColorScheme(
    primary = FleetBlue,
    secondary = FleetCyan,
    tertiary = FleetCyan,
    background = LightBackground,
    surface = LightSurface,
    surfaceVariant = LightSurfaceHigh,
    onPrimary = FleetText,
    onSecondary = FleetText,
    onBackground = LightText,
    onSurface = LightText
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
