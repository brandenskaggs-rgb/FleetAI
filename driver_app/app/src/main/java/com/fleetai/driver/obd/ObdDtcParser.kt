package com.fleetai.driver.obd

/** Mode 03, ELM headers-off output. null means unreadable, not a clean scan. */
object ObdDtcParser {
    fun parse(response: String, can: Boolean): List<String>? {
        val packets = mutableListOf<String>()
        var multi = ""
        var nextLine = 0
        var expectedLength: Int? = null
        fun finish(): Boolean {
            if (multi.isEmpty()) return true
            if (expectedLength != null && multi.length < expectedLength!! * 2) return false
            packets.add(expectedLength?.let { multi.take(it * 2) } ?: multi)
            multi = ""
            nextLine = 0
            expectedLength = null
            return true
        }
        for (raw in response.uppercase().replace(">", "").split(Regex("[\\r\\n]+"))) {
            val line = raw.trim().replace(" ", "").replace("\t", "")
            if (line.isEmpty() || line == "03" || line == "SEARCHING..." || line == "BUSINIT:OK") continue
            if (line.matches(Regex("[0-9A-F]{3}"))) {
                if (!finish()) return null
                expectedLength = line.toInt(16)
                continue
            }
            val numbered = Regex("^([0-9A-F]+):([0-9A-F]+)$").matchEntire(line)
            if (numbered != null) {
                val index = numbered.groupValues[1].toIntOrNull(16) ?: return null
                if (index == 0 && multi.isNotEmpty() && !finish()) return null
                if (index != nextLine++) return null
                multi += numbered.groupValues[2]
            } else {
                if (!finish()) return null
                if (!line.matches(Regex("43[0-9A-F]*"))) return null
                packets.add(line)
            }
        }
        if (!finish() || packets.isEmpty()) return null
        val codes = mutableSetOf<String>()
        for (packet in packets) {
            if (!packet.startsWith("43") || packet.length % 2 != 0) return null
            var data = packet.drop(2).chunked(2).map { it.toInt(16) }
            if (can) {
                val count = data.firstOrNull() ?: return null
                if (data.size < 1 + count * 2) return null
                data = data.drop(1).take(count * 2)
            }
            if (data.isEmpty() && !can || data.size % 2 != 0) return null
            for (pair in data.chunked(2)) {
                val a = pair[0]; val b = pair[1]
                if (a == 0 && b == 0) continue
                val prefix = "PCBU"[a shr 6]
                codes.add("$prefix${(a shr 4) and 3}${(a and 15).toString(16).uppercase()}${b.toString(16).uppercase().padStart(2, '0')}")
            }
        }
        return codes.sorted()
    }
}
