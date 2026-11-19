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

    @Test fun slowChannelsGetAnAbsoluteDeadlineAheadOfBusyCorePids() {
        val fast = SensorWatchPolicy.priorityScore(60_000, 56_000, 250, 0, true)
        val slow = SensorWatchPolicy.priorityScore(60_000, 44_000, 3000, 2, false)
        assertTrue("A catalyst PID near expiry must outrank overdue RPM", slow > fast)
    }

    @Test fun busyAdapterStillAttemptsEverySupportedSignal() {
        val plan = J1979Spec.all.take(37)
        val lastAttempts = mutableMapOf<String, Long>()
        var now = 1_000_000L
        val seen = mutableSetOf<String>()
        var maximumRepeatGap = 0L
        repeat(240) {
            val due = plan.filter { now - (lastAttempts[it.command] ?: 0L) >= it.minIntervalMs }
                .sortedByDescending { priorityScoreForTest(now, lastAttempts[it.command] ?: 0L, it) }.take(6)
            due.forEach { spec ->
                now += 400L // Serialized adapter latency, not simultaneous sensor reads.
                lastAttempts[spec.command]?.let { maximumRepeatGap = maxOf(maximumRepeatGap, now - it) }
                lastAttempts[spec.command] = now
                seen.add(spec.command)
            }
            now += 100L
        }
        assertEquals(plan.map { it.command }.toSet(), seen)
        assertTrue("No supported channel should expire at this feasible bus load: $maximumRepeatGap", maximumRepeatGap < 30_000L)
    }

    private fun priorityScoreForTest(now: Long, last: Long, spec: PidSpec) =
        SensorWatchPolicy.priorityScore(now, last, spec.minIntervalMs, spec.priority, spec.key == "rpm")
}
