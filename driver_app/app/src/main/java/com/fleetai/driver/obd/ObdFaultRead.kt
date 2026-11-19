package com.fleetai.driver.obd

data class ObdFaultRead(
    val capturedAt: Long,
    val confirmed: List<String>?,
    val pending: List<String>?,
    val permanent: List<String>?,
    val monitor: ObdDtcParser.MonitorStatus?
) {
    val inconsistent: Boolean get() = confirmed != null && monitor != null &&
        (monitor.maxStoredCodeCount > confirmed.size || (monitor.milOn && confirmed.isEmpty()))
    val codes: List<String> get() = confirmed.orEmpty()
    val allCodes: List<String> get() = (codes + pending.orEmpty() + permanent.orEmpty()).distinct().sorted()
    val status: String get() = when {
        inconsistent -> "inconsistent"
        confirmed == null || pending == null || permanent == null || monitor == null -> "partial"
        else -> "read"
    }
    fun metadata(): Map<String, Any?> = mapOf(
        "capturedAt" to java.time.Instant.ofEpochMilli(capturedAt).toString(),
        "confirmed" to confirmed, "pending" to pending, "permanent" to permanent,
        "milOn" to monitor?.milOn, "reportedCodeCount" to monitor?.maxStoredCodeCount
    )
}
