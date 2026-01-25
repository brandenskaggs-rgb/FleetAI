package com.fleetai.driver.obd

object ObdParser {
    fun parseRpm(response: String): Double? {
        val bytes = extractBytes(response, "41 0C") ?: return null
        if (bytes.size < 2) return null
        return ((bytes[0] * 256) + bytes[1]) / 4.0
    }

    fun parseSpeed(response: String): Double? {
        val bytes = extractBytes(response, "41 0D") ?: return null
        return bytes.firstOrNull()?.toDouble()
    }

    fun parseCoolant(response: String): Double? {
        val bytes = extractBytes(response, "41 05") ?: return null
        return bytes.firstOrNull()?.minus(40)?.toDouble()
    }

    fun parseVoltage(response: String): Double? {
        val bytes = extractBytes(response, "41 42") ?: return null
        if (bytes.size < 2) return null
        return ((bytes[0] * 256) + bytes[1]) / 1000.0
    }

    fun parseIntake(response: String): Double? {
        val bytes = extractBytes(response, "41 0F") ?: return null
        return bytes.firstOrNull()?.minus(40)?.toDouble()
    }

    fun parseDtcs(response: String): List<String> {
        val hex = response.replace(" ", "").replace("\r", "").replace(">", "")
        if (!hex.startsWith("43")) return emptyList()
        val data = hex.drop(2)
        val codes = mutableListOf<String>()
        var i = 0
        while (i + 4 <= data.length) {
            val a = data.substring(i, i + 2).toIntOrNull(16) ?: break
            val b = data.substring(i + 2, i + 4).toIntOrNull(16) ?: break
            if (a == 0 && b == 0) break
            val type = when (a shr 6) {
                0 -> "P"
                1 -> "C"
                2 -> "B"
                else -> "U"
            }
            val code = ((a and 0x3F) shl 8) + b
            codes.add(type + code.toString().padStart(4, '0'))
            i += 4
        }
        return codes
    }

    private fun extractBytes(response: String, prefix: String): List<Int>? {
        val normalized = response.replace("\r", " ").replace(">", " ")
        val tokens = normalized.split(" ").filter { it.isNotBlank() }
        val prefixTokens = prefix.split(" ")
        val start = tokens.windowed(prefixTokens.size).indexOf(prefixTokens)
        if (start < 0) return null
        val bytes = tokens.drop(start + prefixTokens.size).mapNotNull { it.toIntOrNull(16) }
        return bytes
    }
}
