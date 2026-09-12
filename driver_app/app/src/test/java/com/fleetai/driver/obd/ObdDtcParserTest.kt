package com.fleetai.driver.obd

import org.junit.Assert.*
import org.junit.Test

class ObdDtcParserTest {
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
