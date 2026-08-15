package com.fleetai.driver.j1939

enum class J1939BusProfile(val bitrate: Int?, val label: String) {
    AUTO(null, "Auto detect"),
    J1939_250K(250_000, "250 kbit/s"),
    J1939_500K(500_000, "500 kbit/s");

    companion object {
        fun fromStored(value: String?): J1939BusProfile = entries.firstOrNull { it.name == value } ?: AUTO
    }
}

enum class J1939ConnectorProfile(val label: String) {
    UNKNOWN("Not specified"),
    BLACK_9_PIN("Black 9-pin"),
    GREEN_9_PIN("Green 9-pin Type II"),
    RP1226("RP1226"),
    BENCH_HARNESS("Bench harness");

    companion object {
        fun fromStored(value: String?): J1939ConnectorProfile = entries.firstOrNull { it.name == value } ?: UNKNOWN
    }
}

data class J1939ConnectionProfile(
    val bus: J1939BusProfile = J1939BusProfile.AUTO,
    val connector: J1939ConnectorProfile = J1939ConnectorProfile.UNKNOWN
)
