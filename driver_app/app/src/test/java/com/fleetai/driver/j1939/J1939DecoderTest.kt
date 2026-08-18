package com.fleetai.driver.j1939

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class J1939DecoderTest {
    private val decoder = J1939Decoder()

    @Test
    fun decodesEngineSpeedCoolantAndFuelRate() {
        val rpm = decoder.decode(frame(0x0CF00400, byteArrayOf(0, 0, 0, 0xE0.toByte(), 0x2E, -1, -1, -1)))
        assertEquals(1500.0, rpm.metrics["rpm"]!!, 0.001)

        val coolant = decoder.decode(frame(0x18FEEE00, byteArrayOf(130.toByte(), -1, -1, -1, -1, -1, -1, -1)))
        assertEquals(90.0, coolant.metrics["coolantTempC"]!!, 0.001)

        val fuel = decoder.decode(frame(0x18FEF200, byteArrayOf(0xF4.toByte(), 0x01, -1, -1, -1, -1, -1, -1)))
        assertEquals(25.0, fuel.metrics["fuelRateLph"]!!, 0.001)
    }

    @Test
    fun decodesDm1SpnFmiAndOccurrenceCount() {
        // SPN 110, FMI 0, occurrence count 3.
        val result = decoder.decode(frame(0x18FECA00, byteArrayOf(0, 0, 110, 0, 0, 3, -1, -1)))
        assertTrue(result.activeDtcs.contains("SPN 110 FMI 0 OC 3"))
    }

    @Test
    fun decodesElectronicBrakeControllerSignals() {
        // EBC1: traction active, ABS active, service brake active, pedal at 40%.
        val result = decoder.decode(frame(0x18F0010B, byteArrayOf(0x54, 100, -1, -1, -1, -1, -1, -1)))
        assertEquals(1.0, result.metrics["tractionControlBrakeActive"]!!, 0.001)
        assertEquals(1.0, result.metrics["absActive"]!!, 0.001)
        assertEquals(1.0, result.metrics["serviceBrakeActive"]!!, 0.001)
        assertEquals(40.0, result.metrics["brakePedalPositionPct"]!!, 0.001)
    }

    private fun frame(id: Long, data: ByteArray) = CanFrame(id, data, 1_000L)
}
