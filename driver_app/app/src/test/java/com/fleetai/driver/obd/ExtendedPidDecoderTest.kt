package com.fleetai.driver.obd

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class ExtendedPidDecoderTest {
    private val transmissionTemperature = ExtendedPidDefinition(
        command = "221234",
        requestHeader = "7E1",
        responsePrefix = "621234",
        key = "transmissionFluidTempC",
        name = "Transmission fluid temperature",
        unit = "C",
        formula = "((A*256)+B)/10-40",
        expectedBytes = 2,
        minValue = -40.0,
        maxValue = 220.0,
        minIntervalMs = 2_000,
        priority = 1
    )

    @Test
    fun `decodes mode 22 response with constrained formula`() {
        val reading = ExtendedPidDecoder.decode(transmissionTemperature, "62 12 34 04 1A")
        assertEquals(65.0, reading!!.value, 0.001)
    }

    @Test
    fun `supports signed and bitwise formulas`() {
        assertEquals(-2.0, ExtendedPidFormula.evaluate("signed8(A)", listOf(0xFE)), 0.001)
        assertEquals(52.0, ExtendedPidFormula.evaluate("(A<<4)|(B&15)", listOf(3, 4)), 0.001)
        assertEquals(20.0, ExtendedPidFormula.evaluate("if(A>10,20,30)", listOf(11)), 0.001)
        assertEquals(1.0, ExtendedPidFormula.evaluate("getbit(A,3)", listOf(8)), 0.001)
    }

    @Test
    fun `rejects write and routine-control services`() {
        listOf("2E1234", "310100", "2701", "1101").forEach { command ->
            assertThrows(IllegalArgumentException::class.java) {
                ExtendedPidSafety.validate(transmissionTemperature.copy(command = command))
            }
        }
    }

    @Test
    fun `rejects values outside the declared engineering range`() {
        assertNull(ExtendedPidDecoder.decode(transmissionTemperature, "62 12 34 FF FF"))
    }

    @Test
    fun `matches the documented 2010 Camaro LLT VIN family`() {
        val match = ExtendedPidMatch(setOf("1G1", "2G1"), setOf("A"), setOf("V"))
        assertTrue(match.matches("1G1ABCDV0A0123456"))
    }
}
