package com.fleetai.driver.obd

import org.junit.Assert.*
import org.junit.Test

class ObdResponseCleanerTest {
    private fun clean(raw: String, command: String) = requireNotNull(ObdResponseCleaner.clean(raw, command))

    @Test fun multipleEcusSurviveTransportCleaningInEveryFaultMode() {
        for ((mode, prefix) in listOf("03" to "43", "07" to "47", "0A" to "4A")) {
            for (separator in listOf("\r", "\n", "\r\n")) {
                val raw = listOf(mode, "SEARCHING...", "$prefix 01 04 20", "${prefix}010133", ">").joinToString(separator)
                assertEquals(listOf("P0133", "P0420"), ObdDtcParser.parse(clean(raw, mode), true, mode))
            }
        }
    }

    @Test fun numberedFramesKeepLengthAndSequenceBoundaries() {
        val raw = "03\rSEARCHING...\r00A\r0: 43 04 01 33 04 20\r1: C1 2C 12 34\r>"
        assertEquals(listOf("P0133", "P0420", "P1234", "U012C"), ObdDtcParser.parse(clean(raw, "03"), true))
        assertNull(ObdDtcParser.parse(clean(raw.replace("1:", "2:"), "03"), true))
        assertNull(ObdDtcParser.parse(clean("00A\r0:430401330420\r>", "03"), true))
    }

    @Test fun multipleMonitorRepliesRetainLampAndCount() {
        val raw = "0101\r410100076504\r410182076504\r>"
        assertEquals(ObdDtcParser.MonitorStatus(true, 2), ObdDtcParser.parseMonitorStatus(clean(raw, "0101")))
        assertNull(ObdDtcParser.parseMonitorStatus(clean(raw.replace(">", "CAN ERROR\r>"), "0101")))
    }

    @Test fun legacyPacketsAndEmptyResultsStayDistinctFromErrors() {
        assertEquals(listOf("P0133", "P0420"), ObdDtcParser.parse(clean("43 01 33\r43 04 20\r>", "03"), false))
        assertEquals(emptyList<String>(), ObdDtcParser.parse(clean("03\r43 00 00 00 00 00 00\r>", "03"), true))
        assertNull(ObdDtcParser.parse(clean("03\rNO DATA\r>", "03"), true))
        assertNull(ObdResponseCleaner.clean("03\r>", "03"))
    }

    @Test fun ordinaryPidAndCapabilityParsingRemainCompatible() {
        assertEquals(1726.0, ObdParser.parseRpm(clean("010C\r41 0C 1A F8\r>", "010C")))
        assertEquals(setOf("0101", "0102"), ObdParser.parseSupportedPids(
            clean("0100\r41 00 80 00 00 00\r41 00 40 00 00 00\r>", "0100")))
    }

    @Test fun vinDiscoveryStillHandlesNumberedReplies() {
        val raw = "0902\r014\r0: 49 02 01 31 47 31 46\r1: 41 31 52 58 30 41 30\r2: 31 32 33 34 35 36\r>"
        assertEquals("1G1FA1RX0A0123456", ObdParser.parseVin(clean(raw, "0902")))
    }
}
