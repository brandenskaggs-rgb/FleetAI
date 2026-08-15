package com.fleetai.driver.j1939

/** Incremental parser for the documented Lawicel/SLCAN ASCII wire format. */
class SlcanCodec {
    private val buffer = StringBuilder()

    data class FeedResult(val frames: List<CanFrame>, val rejectedRecords: Int)

    fun feed(bytes: ByteArray, receivedAtEpochMs: Long = System.currentTimeMillis()): List<CanFrame> {
        return feedDetailed(bytes, receivedAtEpochMs).frames
    }

    fun feedDetailed(bytes: ByteArray, receivedAtEpochMs: Long = System.currentTimeMillis()): FeedResult {
        val out = mutableListOf<CanFrame>()
        var rejected = 0
        for (byte in bytes) {
            val char = byte.toInt().toChar()
            when (char) {
                '\r', '\u0007' -> {
                    val line = buffer.toString()
                    buffer.clear()
                    if (line.isNotBlank()) {
                        val frame = parseLine(line, receivedAtEpochMs)
                        if (frame == null) rejected += 1 else out += frame
                    }
                }
                '\n' -> Unit
                else -> if (buffer.length < MAX_LINE_LENGTH) {
                    buffer.append(char)
                } else {
                    buffer.clear()
                    rejected += 1
                }
            }
        }
        return FeedResult(out, rejected)
    }

    fun reset() = buffer.clear()

    fun parseLine(line: String, receivedAtEpochMs: Long = System.currentTimeMillis()): CanFrame? {
        if (line.isBlank()) return null
        val type = line[0]
        if (type != 'T' && type != 't') return null
        val extended = type == 'T'
        val idLength = if (extended) 8 else 3
        if (line.length < 1 + idLength + 1) return null
        val id = line.substring(1, 1 + idLength).toLongOrNull(16) ?: return null
        val dlc = line.substring(1 + idLength, 2 + idLength).toIntOrNull(16) ?: return null
        if (dlc !in 0..8) return null
        val dataStart = 2 + idLength
        val dataEnd = dataStart + dlc * 2
        if (line.length < dataEnd) return null
        val data = ByteArray(dlc)
        for (index in 0 until dlc) {
            data[index] = (line.substring(dataStart + index * 2, dataStart + index * 2 + 2)
                .toIntOrNull(16) ?: return null).toByte()
        }
        return runCatching { CanFrame(id, data, receivedAtEpochMs, extended) }.getOrNull()
    }

    companion object {
        const val CLOSE = "C\r"
        const val SET_J1939_250K = "S5\r"
        const val SET_J1939_500K = "S6\r"
        const val ENABLE_TIMESTAMPS = "Z1\r"
        const val OPEN_LISTEN_ONLY = "L\r"
        private const val MAX_LINE_LENGTH = 64
    }
}
