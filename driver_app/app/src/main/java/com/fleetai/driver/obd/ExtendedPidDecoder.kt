package com.fleetai.driver.obd

object ExtendedPidDecoder {
    fun decode(definition: ExtendedPidDefinition, response: String): ExtendedPidReading? {
        ExtendedPidSafety.validate(definition)
        val prefix = ExtendedPidSafety.normalizeHex(definition.responsePrefix).chunked(2)
        val tokens = ObdParser.tokenizeHex(response)
        val start = tokens.windowed(prefix.size).indexOf(prefix)
        if (start < 0) return null
        val data = tokens
            .drop(start + prefix.size)
            .take(definition.expectedBytes)
            .mapNotNull { it.toIntOrNull(16) }
        if (data.size != definition.expectedBytes) return null
        val value = ExtendedPidFormula.evaluate(definition.formula, data)
        if (definition.minValue != null && value < definition.minValue) return null
        if (definition.maxValue != null && value > definition.maxValue) return null
        return ExtendedPidReading(definition.key, definition.name, definition.unit, value)
    }
}
