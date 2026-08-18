package com.fleetai.driver.obd

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ObdParserTest {
    @Test
    fun `decodes compact ELM327 responses`() {
        assertEquals(1726.0, ObdParser.parseRpm("410C1AF8")!!, 0.001)
        assertEquals(95.0, ObdParser.parseSpeed("410D5F")!!, 0.001)
        assertEquals(88.0, ObdParser.parseCoolant("410580")!!, 0.001)
        assertEquals(13.884, ObdParser.parseVoltage("4142363C")!!, 0.001)
    }

    @Test
    fun `continues to decode spaced and multiline responses`() {
        assertEquals(1726.0, ObdParser.parseRpm("41 0C 1A F8\r> ")!!, 0.001)
        assertEquals(88.0, ObdParser.parseCoolant("41 05 80\r41 0F 55")!!, 0.001)
    }

    @Test
    fun `decodes compact supported PID bitmap`() {
        val supported = ObdParser.parseSupportedPids("4100BE3EA813")
        assertTrue("0101" in supported)
        assertTrue("010C" in supported)
        assertTrue("010D" in supported)
    }

    @Test
    fun `decodes compact and formatted VIN responses`() {
        assertEquals("1G1FA1RX0A0123456", ObdParser.parseVin("4902013147314641315258304130313233343536"))
        assertEquals(
            "1G1FA1RX0A0123456",
            ObdParser.parseVin("014\r0: 49 02 01 31 47 31 46\r1: 41 31 52 58 30 41 30\r2: 31 32 33 34 35 36\r>")
        )
    }

    @Test
    fun `decodes expanded standardized powertrain sensors`() {
        assertEquals(96.0, ObdParser.parsePid("010A", "41 0A 20")["fuelPressureKpa"]!!, 0.001)
        assertEquals(1000.0, ObdParser.parsePid("0123", "41 23 00 64")["fuelRailGaugePressureKpa"]!!, 0.001)
        assertEquals(0.0, ObdParser.parsePid("010E", "41 0E 80")["ignitionTimingAdvanceDeg"]!!, 0.001)
        assertEquals(360.0, ObdParser.parsePid("013C", "41 3C 0F A0")["catalystTempB1S1C"]!!, 0.001)
        assertEquals(14.0, ObdParser.parsePid("0142", "41 42 36 B0")["batteryVoltageV"]!!, 0.001)
        assertEquals(12345.6, ObdParser.parsePid("01A6", "41 A6 00 01 E2 40")["odometerKm"]!!, 0.001)
    }

    @Test
    fun `classifies ECU probe responses without mistaking adapter errors for data`() {
        assertEquals("", ObdResponseDiagnostics.classifyEcuProbe("SEARCHING... 41 00 BE 3E A8 13"))
        assertEquals("", ObdResponseDiagnostics.classifyEcuProbe("4100BE3EA813"))
        assertTrue(ObdResponseDiagnostics.classifyEcuProbe("NO DATA").contains("ignition"))
        assertTrue(ObdResponseDiagnostics.classifyEcuProbe("UNABLE TO CONNECT").contains("protocol"))
        assertTrue(ObdResponseDiagnostics.classifyEcuProbe(null).contains("No response"))
    }
}
