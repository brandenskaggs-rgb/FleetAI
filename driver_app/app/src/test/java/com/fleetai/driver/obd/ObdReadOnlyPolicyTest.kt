package com.fleetai.driver.obd

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ObdReadOnlyPolicyTest {
    @Test fun rejectsEcuWritesAndCommandInjection() {
        listOf("04", "04 00", "14FFFFFF", "2E123400", "2F123400", "31010000", "2701", "1101", "010C\r04", "ATZ\n04", "ATSH7E0\r04", "").forEach {
            assertFalse(it, ObdReadOnlyPolicy.allows(it))
        }
    }

    @Test fun preservesLiveReadsVinDtcAndAdapterInitialization() {
        listOf("0104", "010C", "01FF", "0202", "03", "07", "0A", "0902", "221234", "ATZ", "ATI", "ATE0", "ATL0", "ATS1", "ATH0", "ATSP0", "ATRV", "ATDP", "ATSH7DF", "ATSH18DB33F1").forEach {
            assertTrue(it, ObdReadOnlyPolicy.allows(it))
        }
    }

    @Test fun preservesExtendedReadServicesSupportedByProfiles() {
        listOf("2101", "221234", "2212345678", "22123456789ABCDE").forEach {
            assertTrue(it, ObdReadOnlyPolicy.allows(it))
        }
        listOf("21", "221", "22123456789ABCDEFF").forEach {
            assertFalse(it, ObdReadOnlyPolicy.allows(it))
        }
    }
}
