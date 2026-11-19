package com.fleetai.driver.telemetry

/** Bounded priority boost, not an additional polling loop or ECU command source. */
object SensorWatchPolicy {
    fun priorityScore(now: Long, lastRead: Long, intervalMs: Long, priority: Int, focused: Boolean): Double {
        val age = (now - lastRead).coerceAtLeast(0)
        val expiryMs = (intervalMs * 4).coerceIn(30_000L, 120_000L)
        // Absolute deadlines stop high-rate PIDs from starving slower channels.
        // Use attempt times: a nonresponding PID must not monopolize the adapter.
        if (age >= expiryMs / 2) return 100.0 + age.toDouble() / expiryMs
        return (age.toDouble() / intervalMs.coerceAtLeast(1)).coerceAtMost(10.0) +
            (2 - priority) * 0.5 + if (focused) 1.0 else 0.0
    }

    fun supportedKeys(requested: List<String>, standard: List<PidSpec>, extendedKeys: List<String>): List<String> {
        val known = standard.map { it.key }.toSet() + extendedKeys
        return requested.distinct().take(64).filter { it in known }
    }
}
