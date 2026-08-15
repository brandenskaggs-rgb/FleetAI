package com.fleetai.driver.j1939

import java.util.concurrent.ConcurrentHashMap

data class J1939DecodeResult(
    val metrics: Map<String, Double> = emptyMap(),
    val activeDtcs: List<String> = emptyList(),
    val vin: String? = null,
    val pgn: Int? = null
)

/** Decodes standard broadcast PGNs without transmitting requests onto the bus. */
class J1939Decoder {
    private data class TpSession(
        val source: Int,
        val destination: Int,
        val targetPgn: Int,
        val totalBytes: Int,
        val totalPackets: Int,
        val startedAt: Long,
        val packets: MutableMap<Int, ByteArray> = mutableMapOf()
    )

    private val sessions = ConcurrentHashMap<String, TpSession>()

    fun decode(frame: CanFrame): J1939DecodeResult {
        expireSessions(frame.capturedAtEpochMs)
        return when (frame.pgn) {
            PGN_TP_CM -> { beginTransport(frame); J1939DecodeResult(pgn = frame.pgn) }
            PGN_TP_DT -> completeTransport(frame)?.let { decodePayload(it.first, it.second) }
                ?: J1939DecodeResult(pgn = frame.pgn)
            else -> decodePayload(frame.pgn, frame.data)
        }
    }

    private fun decodePayload(pgn: Int, bytes: ByteArray): J1939DecodeResult {
        val metrics = linkedMapOf<String, Double>()
        fun u8(index: Int): Int? = bytes.getOrNull(index)?.toInt()?.and(0xff)?.takeUnless { it == 0xff }
        fun u16(index: Int): Int? {
            val lo = bytes.getOrNull(index)?.toInt()?.and(0xff) ?: return null
            val hi = bytes.getOrNull(index + 1)?.toInt()?.and(0xff) ?: return null
            val raw = lo or (hi shl 8)
            return raw.takeUnless { it == 0xffff }
        }
        fun u32(index: Int): Long? {
            if (index + 3 >= bytes.size) return null
            var value = 0L
            for (offset in 0..3) value = value or ((bytes[index + offset].toLong() and 0xff) shl (offset * 8))
            return value.takeUnless { it == 0xffffffffL }
        }

        when (pgn) {
            61444 -> {
                u16(3)?.let { metrics["rpm"] = it * 0.125 }
                u8(1)?.let { metrics["driverDemandTorquePct"] = it - 125.0 }
                u8(2)?.let { metrics["actualTorquePct"] = it - 125.0 }
            }
            65262 -> {
                u8(0)?.let { metrics["coolantTempC"] = it - 40.0 }
                u8(1)?.let { metrics["fuelTempC"] = it - 40.0 }
                u16(2)?.let { metrics["oilTempC"] = it * 0.03125 - 273.0 }
            }
            65263 -> {
                u8(0)?.let { metrics["fuelDeliveryPressureKpa"] = it * 4.0 }
                u8(1)?.let { metrics["engineOilLevelPct"] = it * 0.4 }
                u8(3)?.let { metrics["engineOilPressureKpa"] = it * 4.0 }
                u8(7)?.let { metrics["coolantLevelPct"] = it * 0.4 }
            }
            65265 -> u16(1)?.let { metrics["speedKph"] = it / 256.0 }
            65266 -> {
                u16(0)?.let { metrics["fuelRateLph"] = it * 0.05 }
                u16(2)?.let { metrics["instantFuelEconomyKmPerL"] = it / 512.0 }
            }
            65253 -> u32(0)?.let { metrics["engineHours"] = it * 0.05 }
            65248 -> {
                u32(0)?.let { metrics["tripDistanceKm"] = it * 0.125 }
                u32(4)?.let { metrics["odometerKm"] = it * 0.125 }
            }
            65271 -> {
                u16(2)?.let { metrics["alternatorVoltageV"] = it * 0.05 }
                u16(4)?.let { metrics["batteryVoltageV"] = it * 0.05 }
            }
            65269 -> {
                u8(0)?.let { metrics["barometricPressureKpa"] = it * 0.5 }
                u16(3)?.let { metrics["ambientTempC"] = it * 0.03125 - 273.0 }
            }
            65270 -> u16(0)?.let { metrics["egtC"] = it * 0.03125 - 273.0 }
            65276 -> u8(1)?.let { metrics["fuelLevelPct"] = it * 0.4 }
            65226 -> return J1939DecodeResult(activeDtcs = decodeDm1(bytes), pgn = pgn)
            65260 -> return J1939DecodeResult(vin = decodeVin(bytes), pgn = pgn)
        }
        return J1939DecodeResult(metrics = metrics, pgn = pgn)
    }

    private fun decodeDm1(bytes: ByteArray): List<String> {
        val out = mutableListOf<String>()
        var index = 2
        while (index + 3 < bytes.size) {
            val b0 = bytes[index].toInt() and 0xff
            val b1 = bytes[index + 1].toInt() and 0xff
            val b2 = bytes[index + 2].toInt() and 0xff
            val b3 = bytes[index + 3].toInt() and 0xff
            if (b0 == 0xff && b1 == 0xff && b2 == 0xff && b3 == 0xff) break
            val spn = b0 or (b1 shl 8) or ((b2 and 0xe0) shl 11)
            val fmi = b2 and 0x1f
            val occurrences = b3 and 0x7f
            out += "SPN $spn FMI $fmi OC $occurrences"
            index += 4
        }
        return out
    }

    private fun decodeVin(bytes: ByteArray): String? {
        val value = bytes.take(17).map { (it.toInt() and 0xff).toChar() }.joinToString("").trim('\u0000', '\u00ff', ' ')
        return value.takeIf { it.length == 17 && it.all { c -> c.isLetterOrDigit() && c !in "IOQioq" } }?.uppercase()
    }

    private fun beginTransport(frame: CanFrame) {
        val bytes = frame.data
        if (bytes.size < 8) return
        val control = bytes[0].toInt() and 0xff
        if (control != 0x10 && control != 0x20) return
        val totalBytes = (bytes[1].toInt() and 0xff) or ((bytes[2].toInt() and 0xff) shl 8)
        val totalPackets = bytes[3].toInt() and 0xff
        val targetPgn = (bytes[5].toInt() and 0xff) or ((bytes[6].toInt() and 0xff) shl 8) or ((bytes[7].toInt() and 0xff) shl 16)
        if (totalBytes !in 1..1785 || totalPackets !in 1..255) return
        val session = TpSession(frame.sourceAddress, frame.destinationAddress, targetPgn, totalBytes, totalPackets, frame.capturedAtEpochMs)
        sessions[sessionKey(frame.sourceAddress, frame.destinationAddress)] = session
    }

    private fun completeTransport(frame: CanFrame): Pair<Int, ByteArray>? {
        val session = sessions[sessionKey(frame.sourceAddress, frame.destinationAddress)] ?: return null
        val sequence = frame.data.firstOrNull()?.toInt()?.and(0xff) ?: return null
        if (sequence !in 1..session.totalPackets) return null
        session.packets.putIfAbsent(sequence, frame.data.drop(1).toByteArray())
        if (session.packets.size != session.totalPackets) return null
        val payload = ByteArray(session.totalBytes)
        var cursor = 0
        for (number in 1..session.totalPackets) {
            val packet = session.packets[number] ?: return null
            for (byte in packet) if (cursor < payload.size) payload[cursor++] = byte
        }
        sessions.remove(sessionKey(session.source, session.destination))
        return session.targetPgn to payload
    }

    private fun expireSessions(now: Long) {
        sessions.entries.removeIf { now - it.value.startedAt > TP_TIMEOUT_MS }
    }

    private fun sessionKey(source: Int, destination: Int) = "$source:$destination"

    companion object {
        private const val PGN_TP_CM = 60416
        private const val PGN_TP_DT = 60160
        private const val TP_TIMEOUT_MS = 2_000L
    }
}
