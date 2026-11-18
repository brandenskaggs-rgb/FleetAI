package com.fleetai.driver.telemetry

import org.junit.Assert.*
import org.junit.Test

class SensorWatchPolicyTest {
    @Test fun acceptsOnlyAlreadySupportedReadings() {
        val supported = SensorWatchPolicy.supportedKeys(listOf("rpm", "04", "absActive", "transmissionTempC"), J1979Spec.core, listOf("transmissionTempC"))
        assertEquals(listOf("rpm", "transmissionTempC"), supported)
    }
    @Test fun priorityBoostIsBoundedAndCannotStarveOverdueSignals() {
        val normal = SensorWatchPolicy.priorityScore(10_000, 9_000, 1000, 1, false)
        val focused = SensorWatchPolicy.priorityScore(10_000, 9_000, 1000, 1, true)
        assertEquals(normal + 1.0, focused, 0.0)
        assertTrue(SensorWatchPolicy.priorityScore(10_000, 0, 1000, 2, false) > focused)
    }
}
