package com.fleetai.driver.telemetry

data class TelemetryMetricSnapshot(
    val value: Double?,
    val source: String,
    val fresh: Boolean,
    val lastUpdatedAt: Long
)

data class TelemetrySnapshot(
    val metrics: Map<String, TelemetryMetricSnapshot>,
    val obdConnected: Boolean,
    val packetAt: Long,
    val protocol: String = "OBD2"
) {
    fun liveMetricValues(): Map<String, Any?> {
        return metrics.mapValues { (_, metric) -> metric.value }
    }

    fun freshnessMap(): Map<String, Any?> {
        return metrics.mapValues { (_, metric) ->
            mapOf(
                "source" to metric.source,
                "fresh" to metric.fresh,
                "lastUpdatedAt" to metric.lastUpdatedAt
            )
        }
    }
}
