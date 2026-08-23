package com.fleetai.driver.telemetry

data class FreshMetricSnapshot(
    val values: Map<String, Double>,
    val updatedAt: Map<String, Long>
)

/** Retains each decoded signal only for its own freshness window. */
class MetricFreshnessCache(private val ttlFor: (String) -> Long) {
    private val values = mutableMapOf<String, Double>()
    private val updatedAt = mutableMapOf<String, Long>()

    @Synchronized
    fun update(changes: Map<String, Double>, timestamp: Long): FreshMetricSnapshot {
        changes.forEach { (key, value) ->
            if (timestamp >= (updatedAt[key] ?: Long.MIN_VALUE)) {
                values[key] = value
                updatedAt[key] = timestamp
            }
        }
        val expired = values.keys.filter { key ->
            timestamp - (updatedAt[key] ?: 0L) > ttlFor(key)
        }
        expired.forEach { key ->
            values.remove(key)
            updatedAt.remove(key)
        }
        return FreshMetricSnapshot(values.toMap(), updatedAt.toMap())
    }

    @Synchronized
    fun clear() {
        values.clear()
        updatedAt.clear()
    }
}
