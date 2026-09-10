package com.fleetai.driver.ui.components

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.painterResource
import com.fleetai.driver.R

@Composable
fun FleetBrandMark(
    modifier: Modifier = Modifier,
    contentDescription: String = "Fleet AI"
) {
    Box(
        modifier = modifier,
        contentAlignment = Alignment.CenterStart
    ) {
        Image(
            painter = painterResource(R.drawable.fleet_ai_link),
            contentDescription = contentDescription,
            contentScale = ContentScale.Fit,
            alignment = Alignment.CenterStart,
            colorFilter = androidx.compose.ui.graphics.ColorFilter.tint(androidx.compose.material3.MaterialTheme.colorScheme.onSurface),
            modifier = Modifier.fillMaxSize()
        )
    }
}
