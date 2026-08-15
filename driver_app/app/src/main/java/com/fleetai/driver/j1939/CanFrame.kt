package com.fleetai.driver.j1939

data class CanFrame(
    val id: Long,
    val data: ByteArray,
    val capturedAtEpochMs: Long,
    val extended: Boolean = true
) {
    init {
        require(id in 0..0x1FFFFFFF) { "CAN identifier outside 29-bit range" }
        require(data.size <= 8) { "Classic CAN frame cannot exceed 8 bytes" }
    }

    val sourceAddress: Int get() = (id and 0xff).toInt()
    val priority: Int get() = ((id shr 26) and 0x07).toInt()
    val destinationAddress: Int
        get() {
            val pf = ((id shr 16) and 0xff).toInt()
            return if (pf < 240) ((id shr 8) and 0xff).toInt() else 0xff
        }
    val pgn: Int get() = extractPgn(id)

    override fun equals(other: Any?): Boolean =
        other is CanFrame && id == other.id && data.contentEquals(other.data) &&
            capturedAtEpochMs == other.capturedAtEpochMs && extended == other.extended

    override fun hashCode(): Int = 31 * id.hashCode() + data.contentHashCode()

    companion object {
        fun extractPgn(id: Long): Int {
            val pf = ((id shr 16) and 0xff).toInt()
            val ps = ((id shr 8) and 0xff).toInt()
            val dp = ((id shr 24) and 0x01).toInt()
            return if (pf < 240) (dp shl 16) or (pf shl 8)
            else (dp shl 16) or (pf shl 8) or ps
        }
    }
}
