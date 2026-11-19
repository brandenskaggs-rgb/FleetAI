package com.fleetai.driver.obd

import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull

data class GmTransmissionAttempt(
    val header: String,
    val temperatureC: Double?,
    val response: String,
    val status: String
)

/** Explicit bench test only. Never register these candidates in the live polling catalog. */
object GmTransmissionTest {
    const val COMMAND = "221940"
    val headers = listOf("7E2", "7E0")

    class RestoreFailed : IllegalStateException("Normal OBD address could not be restored")

    fun vehicleRejection(vin: String?, protocol: String): String? {
        val normalized = vin?.trim()?.uppercase().orEmpty()
        if (!Regex("[A-HJ-NPR-Z0-9]{17}").matches(normalized) ||
            !(normalized.startsWith("2G1F") || normalized.startsWith("1G1F")) ||
            normalized[7] != 'V' || normalized[9] != 'A') {
            return "Test requires a freshly read 2010 Camaro 3.6L VIN. No enhanced requests sent."
        }
        if (!Regex("CAN.*11.*500", RegexOption.IGNORE_CASE).containsMatchIn(protocol)) {
            return "Test requires an identified 11-bit, 500 kbit/s CAN connection. No enhanced requests sent."
        }
        return null
    }

    // ATH0/ATS1 is the app's normal adapter configuration. Reject multiple packets,
    // extra bytes and truncated replies rather than joining unrelated ECU data.
    private fun packet(raw: String?): String? {
        val lines = raw?.trim()?.lines()?.filter { it.isNotBlank() } ?: return null
        if (lines.size != 1) return null
        return lines.single().replace(" ", "").uppercase()
            .takeIf { Regex("[0-9A-F]+").matches(it) }
    }

    fun temperature(raw: String?): Double? {
        val payload = packet(raw) ?: return null
        if (!Regex("621940[0-9A-F]{2}").matches(payload)) return null
        return payload.takeLast(2).toInt(16) - 40.0
    }

    fun stationary(raw: String?): Boolean = packet(raw) == "410D00"

    suspend fun attempt(header: String, send: suspend (String) -> String?): GmTransmissionAttempt {
        require(header in headers) { "Unapproved test address" }
        if (send("ATSH7DF")?.trim() != "OK") throw RestoreFailed()
        check(stationary(send("010D"))) { "Fresh zero-speed reading required. Park the vehicle and retry." }
        try {
            if (send("ATSH$header")?.trim() != "OK") {
                return GmTransmissionAttempt(header, null, "", "Adapter did not accept the test address")
            }
            val raw = send(COMMAND)
            val value = temperature(raw)
            val payload = packet(raw)
            val status = when {
                value != null -> "Candidate temperature returned; not yet vehicle-validated"
                payload?.matches(Regex("7F22[0-9A-F]{2}")) == true -> "ECU returned a negative response"
                else -> "No valid temperature response; support remains unconfirmed"
            }
            // Display bounded diagnostic bytes only; no VIN, account data or arbitrary text.
            val evidence = payload?.take(48) ?: when (raw?.trim()) {
                "NO DATA", "STOPPED", "CAN ERROR", "?" -> raw.trim()
                else -> "No single valid packet"
            }
            return GmTransmissionAttempt(header, value, evidence, status)
        } finally {
            // Cancellation must not release the command mutex with a physical header set.
            val restored = withContext(NonCancellable) {
                runCatching {
                    withTimeoutOrNull(5_000) { send("ATSH7DF")?.trim() == "OK" } == true
                }.getOrDefault(false)
            }
            if (!restored) throw RestoreFailed()
        }
    }
}
