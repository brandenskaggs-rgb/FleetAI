package com.fleetai.driver.obd

object ObdParser {
    fun parsePid(command: String, response: String): Map<String, Double> {
        val normalized = command.replace(" ", "").uppercase()
        if (!normalized.startsWith("01") || normalized.length != 4) return emptyMap()
        val pid = normalized.substring(2)
        val bytes = extractBytes(response, "41 $pid") ?: return emptyMap()
        fun a() = bytes.getOrNull(0)
        fun u16() = if (bytes.size >= 2) bytes[0] * 256 + bytes[1] else null
        fun u32() = if (bytes.size >= 4) {
            ((bytes[0].toLong() shl 24) or (bytes[1].toLong() shl 16) or
                (bytes[2].toLong() shl 8) or bytes[3].toLong()).toDouble()
        } else null
        fun pct() = a()?.let { it * 100.0 / 255.0 }
        fun trim() = a()?.let { (it - 128) * 100.0 / 128.0 }
        fun temp() = a()?.minus(40)?.toDouble()
        fun catalystTemp() = u16()?.let { it / 10.0 - 40.0 }
        fun torque() = a()?.minus(125)?.toDouble()
        val pair: Pair<String, Double?> = when (pid) {
            "04" -> "engineLoadPct" to pct()
            "05" -> "coolantTempC" to temp()
            "06" -> "shortTermFuelTrimBank1Pct" to trim()
            "07" -> "longTermFuelTrimBank1Pct" to trim()
            "08" -> "shortTermFuelTrimBank2Pct" to trim()
            "09" -> "longTermFuelTrimBank2Pct" to trim()
            "0A" -> "fuelPressureKpa" to a()?.times(3.0)
            "0B" -> "mapKpa" to a()?.toDouble()
            "0C" -> "rpm" to u16()?.div(4.0)
            "0D" -> "speedKph" to a()?.toDouble()
            "0E" -> "ignitionTimingAdvanceDeg" to a()?.div(2.0)?.minus(64.0)
            "0F" -> "intakeAirTempC" to temp()
            "10" -> "mafGramsPerSec" to u16()?.div(100.0)
            "11" -> "throttlePosPct" to pct()
            "14" -> "o2B1S1VoltageV" to a()?.div(200.0)
            "15" -> "o2B1S2VoltageV" to a()?.div(200.0)
            "18" -> "o2B2S1VoltageV" to a()?.div(200.0)
            "19" -> "o2B2S2VoltageV" to a()?.div(200.0)
            "1F" -> "engineRunTimeSec" to u16()?.toDouble()
            "21" -> "distanceWithMilOnKm" to u16()?.toDouble()
            "22" -> "fuelRailPressureRelativeKpa" to u16()?.times(0.079)
            "23" -> "fuelRailGaugePressureKpa" to u16()?.times(10.0)
            "2C" -> "commandedEgrPct" to pct()
            "2D" -> "egrErrorPct" to trim()
            "2E" -> "commandedEvapPurgePct" to pct()
            "2F" -> "fuelLevelPct" to pct()
            "30" -> "warmupsSinceClear" to a()?.toDouble()
            "31" -> "distanceSinceClearKm" to u16()?.toDouble()
            "32" -> "evapSystemVaporPressurePa" to u16()?.div(4.0)?.minus(8192.0)
            "33" -> "barometricPressureKpa" to a()?.toDouble()
            "3C" -> "catalystTempB1S1C" to catalystTemp()
            "3D" -> "catalystTempB2S1C" to catalystTemp()
            "3E" -> "catalystTempB1S2C" to catalystTemp()
            "3F" -> "catalystTempB2S2C" to catalystTemp()
            "42" -> "batteryVoltageV" to u16()?.div(1000.0)
            "43" -> "absoluteLoadPct" to u16()?.times(100.0)?.div(255.0)
            "44" -> "commandedEquivalenceRatio" to u16()?.times(2.0)?.div(65536.0)
            "45" -> "relativeThrottlePosPct" to pct()
            "46" -> "ambientTempC" to temp()
            "47" -> "absoluteThrottleBPosPct" to pct()
            "48" -> "absoluteThrottleCPosPct" to pct()
            "49" -> "acceleratorPedalDPosPct" to pct()
            "4A" -> "acceleratorPedalEPosPct" to pct()
            "4B" -> "acceleratorPedalFPosPct" to pct()
            "4C" -> "commandedThrottleActuatorPct" to pct()
            "4D" -> "milRunTimeMin" to u16()?.toDouble()
            "4E" -> "timeSinceClearMin" to u16()?.toDouble()
            "52" -> "ethanolFuelPct" to pct()
            "53" -> "absoluteEvapVaporPressureKpa" to u16()?.div(200.0)
            "54" -> "evapSystemVaporPressureWidePa" to u16()?.minus(32767.0)
            "59" -> "fuelRailAbsolutePressureKpa" to u16()?.times(10.0)
            "5A" -> "relativeAcceleratorPedalPct" to pct()
            "5B" -> "hybridBatteryRemainingPct" to pct()
            "5C" -> "oilTempC" to temp()
            "5D" -> "fuelInjectionTimingDeg" to u16()?.div(128.0)?.minus(210.0)
            "5E" -> "fuelRateLph" to u16()?.times(0.05)
            "61" -> "driverDemandTorquePct" to torque()
            "62" -> "actualTorquePct" to torque()
            "63" -> "referenceTorqueNm" to u16()?.toDouble()
            "A6" -> "odometerKm" to u32()?.div(10.0)
            else -> "" to null
        }
        val value = pair.second
        return if (pair.first.isNotEmpty() && value != null && value.isFinite()) mapOf(pair.first to value) else emptyMap()
    }

    fun hasResponse(response: String, mode: String, pid: String): Boolean {
        val tokens = tokenizeHex(response)
        val expected = listOf(mode.uppercase(), pid.uppercase())
        return tokens.windowed(expected.size).any { it == expected }
    }

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

    fun parseBaro(response: String): Double? {
        val bytes = extractBytes(response, "41 33") ?: return null
        val a = bytes.firstOrNull() ?: return null
        return a.toDouble()
    }

    fun parseFuelLevel(response: String): Double? {
        val bytes = extractBytes(response, "41 2F") ?: return null
        val a = bytes.firstOrNull() ?: return null
        return (a * 100.0) / 255.0
    }

    fun parseOilTemp(response: String): Double? {
        val bytes = extractBytes(response, "41 5C") ?: return null
        val a = bytes.firstOrNull() ?: return null
        return (a - 40).toDouble()
    }

    fun parseVin(response: String): String? {
        val tokens = tokenizeHex(response)
        val start = tokens.windowed(2).indexOf(listOf("49", "02"))
        if (start < 0) return null
        // The byte after 49 02 is the message count/record number. ELM line
        // labels such as "0:" and "1:" are discarded by tokenizeHex().
        val vin = tokens.drop(start + 3)
            .mapNotNull { it.toIntOrNull(16) }
            .filter { it in 0x20..0x7e }
            .map { it.toChar() }
            .joinToString("")
            .filter { it.isLetterOrDigit() }
            .take(17)
            .uppercase()
        return vin.takeIf { it.length == 17 }
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
        val parts = tokenizeHex(response)
        if (parts.size < 6) return emptySet()
        val supported = mutableSetOf<String>()
        for (i in 0 until (parts.size - 5)) {
            if (parts[i] != "41") continue
            val basePid = parts[i + 1].toIntOrNull(16) ?: continue
            val masks = parts.subList(i + 2, i + 6).mapNotNull { it.toIntOrNull(16) }
            if (masks.size < 4) continue
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
        }
        return supported
    }

    private fun extractBytes(response: String, prefix: String): List<Int>? {
        val tokens = tokenizeHex(response)
        val prefixTokens = prefix.split(" ").map { it.uppercase() }
        val start = tokens.windowed(prefixTokens.size).indexOf(prefixTokens)
        if (start < 0) return null
        val bytes = tokens.drop(start + prefixTokens.size).mapNotNull { it.toIntOrNull(16) }
        return bytes
    }

    internal fun tokenizeHex(response: String): List<String> {
        return response
            .replace("\r", " ")
            .replace("\n", " ")
            .replace(">", " ")
            .split(" ")
            .flatMap { token ->
                val hex = token.trim().uppercase()
                if (hex.length >= 2 && hex.length % 2 == 0 && hex.matches(Regex("^[0-9A-F]+$"))) {
                    hex.chunked(2)
                } else {
                    emptyList()
                }
            }
    }
}
