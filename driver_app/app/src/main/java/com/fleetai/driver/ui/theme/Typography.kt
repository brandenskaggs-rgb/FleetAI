package com.fleetai.driver.ui.theme

import androidx.compose.material3.Typography
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import com.fleetai.driver.R

private val FleetSans = FontFamily(
    Font(R.font.source_sans_regular, FontWeight.Normal),
    Font(R.font.source_sans_semibold, FontWeight.SemiBold)
)

private fun fleetType(size: Int, line: Int, weight: FontWeight = FontWeight.Normal) = TextStyle(
    fontFamily = FleetSans, fontWeight = weight,
    fontSize = size.sp, lineHeight = line.sp, letterSpacing = 0.sp
)

val FleetTypography = Typography(
    displayLarge = fleetType(48, 56, FontWeight.SemiBold),
    displayMedium = fleetType(40, 48, FontWeight.SemiBold),
    displaySmall = fleetType(34, 42, FontWeight.SemiBold),
    headlineLarge = fleetType(30, 38, FontWeight.SemiBold),
    headlineMedium = fleetType(26, 34, FontWeight.SemiBold),
    headlineSmall = fleetType(22, 30, FontWeight.SemiBold),
    titleLarge = fleetType(20, 28, FontWeight.SemiBold),
    titleMedium = fleetType(18, 26, FontWeight.SemiBold),
    titleSmall = fleetType(16, 24, FontWeight.SemiBold),
    bodyLarge = fleetType(18, 27),
    bodyMedium = fleetType(16, 24),
    bodySmall = fleetType(14, 21),
    labelLarge = fleetType(16, 22, FontWeight.SemiBold),
    labelMedium = fleetType(14, 20, FontWeight.SemiBold),
    labelSmall = fleetType(13, 18, FontWeight.SemiBold)
)
