package com.fleetai.driver.telemetry

/** Bounded priority boost, not an additional polling loop or ECU command source. */
object SensorWatchPolicy {
    fun priorityScore(now: Long, lastRead: Long, intervalMs: Long, priority: Int, focused: Boolean): Double =
        (now - lastRead).coerceAtLeast(0).toDouble() / intervalMs.coerceAtLeast(1) +
            (2 - priority) * 0.5 + if (focused) 1.0 else 0.0

    fun supportedKeys(requested: List<String>, standard: List<PidSpec>, extendedKeys: List<String>): List<String> {
        val known = standard.map { it.key }.toSet() + extendedKeys
        return requested.distinct().take(64).filter { it in known }
    }
}
