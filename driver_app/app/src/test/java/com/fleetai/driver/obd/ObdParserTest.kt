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
    fun `classifies ECU probe responses without mistaking adapter errors for data`() {
        assertEquals("", ObdResponseDiagnostics.classifyEcuProbe("SEARCHING... 41 00 BE 3E A8 13"))
        assertEquals("", ObdResponseDiagnostics.classifyEcuProbe("4100BE3EA813"))
        assertTrue(ObdResponseDiagnostics.classifyEcuProbe("NO DATA").contains("ignition"))
        assertTrue(ObdResponseDiagnostics.classifyEcuProbe("UNABLE TO CONNECT").contains("protocol"))
        assertTrue(ObdResponseDiagnostics.classifyEcuProbe(null).contains("No response"))
    }
}
