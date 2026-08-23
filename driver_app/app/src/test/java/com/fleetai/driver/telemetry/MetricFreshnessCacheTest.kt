package com.fleetai.driver.telemetry

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class MetricFreshnessCacheTest {
    @Test
    fun unrelatedFramesDoNotRefreshOlderSignals() {
        val cache = MetricFreshnessCache { 1_000L }
        cache.update(mapOf("rpm" to 1_200.0), 1_000L)

        val snapshot = cache.update(mapOf("coolantTempC" to 92.0), 1_500L)

        assertEquals(1_000L, snapshot.updatedAt["rpm"])
        assertEquals(1_500L, snapshot.updatedAt["coolantTempC"])
    }

    @Test
    fun signalsExpireByTheirOwnTtl() {
        val cache = MetricFreshnessCache { key -> if (key == "fuelLevelPct") 5_000L else 1_000L }
        cache.update(mapOf("rpm" to 800.0, "fuelLevelPct" to 50.0), 1_000L)

        val snapshot = cache.update(emptyMap(), 2_500L)

        assertFalse(snapshot.values.containsKey("rpm"))
        assertTrue(snapshot.values.containsKey("fuelLevelPct"))
    }

    @Test
    fun outOfOrderFramesCannotReplaceNewerValues() {
        val cache = MetricFreshnessCache { 10_000L }
        cache.update(mapOf("rpm" to 1_500.0), 2_000L)

        val snapshot = cache.update(mapOf("rpm" to 900.0), 1_500L)

        assertEquals(1_500.0, snapshot.values["rpm"]!!, 0.001)
        assertEquals(2_000L, snapshot.updatedAt["rpm"])
    }
}
