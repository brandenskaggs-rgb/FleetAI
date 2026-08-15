package com.fleetai.driver.j1939

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SlcanCodecTest {
    @Test
    fun parsesChunkedExtendedFrame() {
        val codec = SlcanCodec()
        assertEquals(0, codec.feed("T0CF00400800E07D".toByteArray(), 1000).size)
        val frames = codec.feed("2EE0FFFFFF\r".toByteArray(), 1000)
        assertEquals(1, frames.size)
        assertEquals(0x0CF00400L, frames[0].id)
        assertArrayEquals(byteArrayOf(0, 0xE0.toByte(), 0x7D, 0x2E, 0xE0.toByte(), 0xFF.toByte(), 0xFF.toByte(), 0xFF.toByte()), frames[0].data)
    }

    @Test
    fun rejectsInvalidDlcAndIdentifier() {
        val codec = SlcanCodec()
        assertNull(codec.parseLine("TFFFFFFFF900000000000000000"))
        assertNull(codec.parseLine("TZZZZZZZZ1AA"))
    }

    @Test
    fun reportsRejectedRecordsAndSupportsBothJ1939Bitrates() {
        val codec = SlcanCodec()
        val result = codec.feedDetailed("not-a-frame\rT18FEEE00882FFFFFFFFFFFFFF\r".toByteArray(), 1000)
        assertEquals(1, result.rejectedRecords)
        assertEquals(1, result.frames.size)
        assertEquals("S5\r", SlcanCodec.SET_J1939_250K)
        assertEquals("S6\r", SlcanCodec.SET_J1939_500K)
    }
}
