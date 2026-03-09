package com.fleetai.driver.telemetry

data class PidSpec(
    val pid: String,
    val name: String,
    val bytes: Int,
    val unit: String,
    val minIntervalMs: Long = 500L
)

object J1979Spec {
    // Minimum viable stable set (core)
    val core: List<PidSpec> = listOf(
        PidSpec("010C", "Engine RPM", 2, "rpm", 200),
        PidSpec("010D", "Vehicle speed", 1, "kph", 200),
        PidSpec("0105", "Coolant temp", 1, "C", 500),
        PidSpec("010F", "Intake temp", 1, "C", 500),
        PidSpec("0142", "Control module voltage", 2, "V", 500)
    )

    // Extended set polled slower
    val extended: List<PidSpec> = listOf(
        PidSpec("0104", "Engine load", 1, "%", 1000),
        PidSpec("0110", "MAF", 2, "g/s", 1000),
        PidSpec("0111", "Throttle position", 1, "%", 1000),
        PidSpec("010B", "MAP", 1, "kPa", 1000),
        PidSpec("012F", "Fuel level", 1, "%", 1200),
        PidSpec("0133", "BARO", 1, "kPa", 1200),
        PidSpec("015C", "Oil temp", 1, "C", 1200)
    )

    fun minimumSet(): List<PidSpec> = core
    fun extendedSet(): List<PidSpec> = core + extended
}
