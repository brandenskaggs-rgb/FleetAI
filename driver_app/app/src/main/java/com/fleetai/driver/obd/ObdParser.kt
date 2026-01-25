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

    fun parseMaf(response: String): Double? {
        val bytes = extractBytes(response, "41 10") ?: return null
        if (bytes.size < 2) return null
        return ((bytes[0] * 256) + bytes[1]) / 100.0
    }

    fun parseLoad(response: String): Double? {
        val bytes = extractBytes(response, "41 04") ?: return null
        val a = bytes.firstOrNull() ?: return null
        return (a * 100.0) / 255.0
    }

    fun parseThrottle(response: String): Double? {
        val bytes = extractBytes(response, "41 11") ?: return null
        val a = bytes.firstOrNull() ?: return null
        return (a * 100.0) / 255.0
    }

    fun parseMap(response: String): Double? {
        val bytes = extractBytes(response, "41 0B") ?: return null
        val a = bytes.firstOrNull() ?: return null
        return a.toDouble() // kPa
    }

    fun parseVin(response: String): String? {
        // Accept typical multi-line 09 02 response, pull ASCII bytes after the service/header tokens
        val cleaned = response.replace("\r", " ").replace(">", " ").trim()
        val parts = cleaned.split(" ").filter { it.isNotBlank() }
        if (!parts.any { it.equals("49", true) }) return null
        // Remove mode/service tokens (49 02 xx) if present
        val asciiBytes = parts.dropWhile { it.equals("49", true) || it.equals("02", true) || it.length != 2 }
            .mapNotNull { it.toIntOrNull(16) }
        if (asciiBytes.isEmpty()) return null
        val vin = asciiBytes.map { it.toChar() }.joinToString("").trim()
        return vin.ifBlank { null }
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

    fun parseSupportedPids(response: String): Set<String> {
        val cleaned = response.replace("\r", " ").replace(">", " ").trim()
        val parts = cleaned.split(" ").filter { it.isNotBlank() }
        if (parts.size < 3) return emptySet()
        // Expect mode 41 followed by base PID and 4 bytes bitmask
        val mode = parts.getOrNull(0) ?: return emptySet()
        val basePidHex = parts.getOrNull(1) ?: return emptySet()
        if (mode != "41") return emptySet()
        val basePid = basePidHex.toIntOrNull(16) ?: return emptySet()
        val masks = parts.drop(2).take(4).mapNotNull { it.toIntOrNull(16) }
        if (masks.size < 4) return emptySet()
        val supported = mutableSetOf<String>()
        var pidOffset = basePid + 1
        masks.forEach { mask ->
            for (bit in 7 downTo 0) {
                if ((mask shr bit) and 0x1 == 1) {
                    val pid = pidOffset + (7 - bit)
                    supported.add(String.format("01%02X", pid))
                }
            }
            pidOffset += 8
        }
        return supported
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
