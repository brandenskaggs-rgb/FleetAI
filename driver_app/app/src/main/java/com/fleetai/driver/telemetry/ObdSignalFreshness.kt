package com.fleetai.driver.telemetry

import com.fleetai.driver.data.model.SensorStatus

object ObdSignalFreshness {
    fun window(intervalMs: Long) = (intervalMs * 4).coerceIn(30_000L, 120_000L)

    fun status(value: Double?, measuredAt: Long, now: Long, windowMs: Long): SensorStatus = when {
        measuredAt <= 0L -> SensorStatus.WAITING
        value == null || now - measuredAt !in 0L..windowMs -> SensorStatus.STALE
        else -> SensorStatus.LIVE
    }

    fun count(plan: Map<String, Long>, values: Map<String, Double>, times: Map<String, Long>, now: Long) =
        plan.count { (key, interval) -> status(values[key], times[key] ?: 0L, now, window(interval)) == SensorStatus.LIVE }
}
