package com.fleetai.driver.obd

data class ObdDiagnostics(
    val transport: String = "NONE",
    val adapterResponding: Boolean = false,
    val ecuResponding: Boolean = false,
    val adapterIdentity: String = "",
    val adapterVoltage: String = "",
    val detectedProtocol: String = "",
    val lastCommand: String = "",
    val lastResponse: String = "",
    val failureReason: String = "",
    val updatedAt: Long = 0L
) {
    val ecuState: String
        get() = when {
            ecuResponding -> "live"
            adapterResponding -> "no_ecu_response"
            else -> "adapter_unavailable"
        }
}

object ObdResponseDiagnostics {
    fun classifyEcuProbe(response: String?): String = when {
        response.isNullOrBlank() -> "No response from the OBD adapter"
        ObdParser.hasResponse(response, "41", "00") -> ""
        response.contains("UNABLE TO CONNECT", ignoreCase = true) -> "Adapter cannot establish a vehicle protocol"
        response.contains("NO DATA", ignoreCase = true) -> "ECU returned NO DATA; verify ignition and diagnostic connection"
        response.contains("BUS INIT", ignoreCase = true) -> "Vehicle bus initialization failed"
        response.contains("BUS ERROR", ignoreCase = true) -> "Vehicle bus reported an electrical or protocol error"
        response.contains("CAN ERROR", ignoreCase = true) -> "CAN bus communication failed"
        response.contains("STOPPED", ignoreCase = true) -> "Adapter stopped while probing the ECU"
        response.contains("?", ignoreCase = true) -> "Adapter rejected the ECU probe command"
        else -> "ECU response was not recognized"
    }

    fun preview(response: String?, maxLength: Int = 120): String {
        return response
            .orEmpty()
            .replace(Regex("[\\r\\n\\t]+"), " ")
            .replace(Regex("\\s+"), " ")
            .trim()
            .take(maxLength)
    }
}
