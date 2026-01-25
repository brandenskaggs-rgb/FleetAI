package com.fleetai.driver.telemetry

import com.fleetai.driver.network.TelemetrySample
import java.time.Instant
import java.time.format.DateTimeFormatter
import kotlin.random.Random

object TelemetrySimulator {
    fun generateSample(): TelemetrySample {
        val now = DateTimeFormatter.ISO_INSTANT.format(Instant.now())
        return TelemetrySample(
            ts = now,
            speed = Random.nextDouble(45.0, 72.0),
            rpm = Random.nextDouble(1200.0, 2200.0),
            coolant_temp = Random.nextDouble(180.0, 215.0),
            fuel_level = Random.nextDouble(20.0, 80.0),
            voltage = Random.nextDouble(12.6, 14.2),
            odometer = Random.nextDouble(40000.0, 120000.0)
        )
    }
}
