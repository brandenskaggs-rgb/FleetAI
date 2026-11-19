package com.fleetai.driver.obd

import org.junit.Assert.*
import org.junit.Test

class ObdDtcParserTest {
    @Test fun pendingAndPermanentKeepTheirResponseModes() {
        assertEquals(listOf("P0300"), ObdDtcParser.parse("07\r47 01 03 00\r>", true, "07"))
        assertEquals(listOf("P0420"), ObdDtcParser.parse("4A 01 04 20", true, "0A"))
        assertNull(ObdDtcParser.parse("43 01 04 20", true, "07"))
        assertNull(ObdDtcParser.parse("NO DATA", true, "0A"))
        assertNull(ObdDtcParser.parse("43 00 03 00", true))
    }
    @Test fun monitorStatusDoesNotInventAnOffLamp() {
        assertEquals(ObdDtcParser.MonitorStatus(true, 1), ObdDtcParser.parseMonitorStatus("0101\r41 01 81 07 65 04\r>"))
        assertEquals(ObdDtcParser.MonitorStatus(true, 2), ObdDtcParser.parseMonitorStatus("410100076504\r410182076504\r410182076504"))
        assertNull(ObdDtcParser.parseMonitorStatus("NO DATA"))
        assertNull(ObdDtcParser.parseMonitorStatus("410181"))
        assertNull(ObdDtcParser.parseMonitorStatus("410100076504\rCAN ERROR"))
    }
    @Test fun faultReadSeparatesMissingEmptyAndInconsistent() {
        val complete = ObdFaultRead(1000, emptyList(), emptyList(), emptyList(), ObdDtcParser.MonitorStatus(false, 0))
        assertEquals("read", complete.status)
        assertEquals("partial", complete.copy(pending = null).status)
        assertEquals("inconsistent", complete.copy(monitor = ObdDtcParser.MonitorStatus(true, 1)).status)
        val permanent = complete.copy(permanent = listOf("P0420"))
        assertEquals(emptyList<String>(), permanent.codes)
        assertEquals(listOf("P0420"), permanent.allCodes)
        assertNull(complete.copy(confirmed = null).metadata()["confirmed"])
    }
    @Test fun legacyCodesKeepHexDigits() {
        assertEquals(listOf("P0133", "P0420", "U012C"), ObdDtcParser.parse("43 01 33 04 20 C1 2C\r>", false))
    }
    @Test fun canCountIsNotPartOfTheCode() {
        assertEquals(listOf("P0420"), ObdDtcParser.parse("03\r43 01 04 20 00 00 00\r>", true))
    }
    @Test fun independentEcusAreCombined() {
        assertEquals(listOf("P0133", "P0420"), ObdDtcParser.parse("43 01 04 20\r43 01 01 33\n>", true))
    }
    @Test fun numberedCanMessagesAreReassembled() {
        assertEquals(listOf("P0133", "P0420", "P1234", "U012C"), ObdDtcParser.parse("00A\r0: 43 04 01 33 04 20\r1: C1 2C 12 34\r>", true))
    }
    @Test fun noResponseDoesNotMeanNoCodes() {
        listOf("", "NO DATA\r>", "STOPPED", "UNABLE TO CONNECT", "43 02 01 33", "43 01 01").forEach {
            assertNull(it, ObdDtcParser.parse(it, true))
        }
    }
    @Test fun validEmptyResponsesAreDistinguished() {
        assertEquals(emptyList<String>(), ObdDtcParser.parse("43 00 00 00 00 00 00", true))
        assertEquals(emptyList<String>(), ObdDtcParser.parse("43 00 00 00 00 00 00", false))
    }
    @Test fun incompleteMultiFrameIsNotAccepted() {
        assertNull(ObdDtcParser.parse("00A\r0:430401330420\r2:C12C1234", true))
        assertNull(ObdDtcParser.parse("00A\r0:430401330420", true))
    }
    @Test fun allCodeFamiliesDecodeCorrectly() {
        assertEquals(listOf("B2ABC", "C1234", "P3FFF", "U3001"), ObdDtcParser.parse("43 04 3F FF 52 34 AA BC F0 01", true))
    }
}
