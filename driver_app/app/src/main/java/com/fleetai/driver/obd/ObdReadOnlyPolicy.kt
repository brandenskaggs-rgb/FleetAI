package com.fleetai.driver.obd

/** ECU reads only. ELM adapter setup is separate from diagnostic services. */
object ObdReadOnlyPolicy {
    private val adapterCommands = setOf("ATZ", "ATI", "ATE0", "ATL0", "ATS1", "ATH0", "ATSP0", "ATRV", "ATDP")
    private val headerCommand = Regex("ATSH([0-9A-F]{3}|[0-9A-F]{8})")
    private val standardRead = Regex("(01|02|09)[0-9A-F]{2}")
    private val extendedRead = Regex("(21|22)([0-9A-F]{2}){1,7}")

    fun allows(command: String): Boolean {
        if (command.any { it == '\r' || it == '\n' || it == '\u0000' }) return false
        val normalized = command.trim().uppercase().replace(" ", "")
        if (normalized in adapterCommands) return true
        if (headerCommand.matches(normalized)) return true
        // 0104 reads engine load; 04 clears emissions diagnostics and is never allowed.
        return standardRead.matches(normalized) ||
            normalized in setOf("03", "07", "0A") ||
            extendedRead.matches(normalized)
    }
}
