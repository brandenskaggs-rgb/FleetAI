package com.fleetai.driver.obd

internal object ObdResponseCleaner {
    fun clean(raw: String, command: String): String? = raw
        .replace(">", " ")
        .replace("\r", "\n")
        .replace(Regex("(?i)SEARCHING\\.{0,3}"), " ")
        .lines()
        .map { it.trim() }
        .filter { line ->
            line.isNotBlank() &&
                !line.replace(" ", "").equals(command.replace(" ", ""), ignoreCase = true)
        }
        // ECU packets and numbered ELM frames must remain separate for DTC parsing.
        .joinToString("\n")
        .trim()
        .ifBlank { null }
}
