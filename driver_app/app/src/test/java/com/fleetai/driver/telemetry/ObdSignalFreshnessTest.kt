package com.fleetai.driver.telemetry

import com.fleetai.driver.data.model.SensorStatus
import org.junit.Assert.assertEquals
import org.junit.Test

class ObdSignalFreshnessTest {
    @Test fun separatesFirstReadFromLostReading() {
        val now = 100_000L
        fun state(value: Double?, time: Long) = ObdSignalFreshness.status(value, time, now, 30_000L)
        assertEquals(SensorStatus.WAITING, state(null, 0))
        assertEquals(SensorStatus.LIVE, state(0.0, 70_000))
        assertEquals(SensorStatus.STALE, state(0.0, 69_999))
        assertEquals(SensorStatus.STALE, state(null, 99_000))
        assertEquals(SensorStatus.STALE, state(1.0, 100_001))
    }

    @Test fun countsOnlyPolledSignalsWithinTheirOwnWindow() {
        val plan = mapOf("rpm" to 500L, "odometerKm" to 30_000L, "fuelLevelPct" to 1000L)
        val values = mapOf("rpm" to 800.0, "odometerKm" to 23.0, "boostPsi" to 2.0)
        val times = mapOf("rpm" to 180_000L, "odometerKm" to 90_000L, "boostPsi" to 200_000L)
        assertEquals(2, ObdSignalFreshness.count(plan, values, times, 200_000L))
        assertEquals(0, ObdSignalFreshness.count(plan, values, times, 210_001L))
    }
}
