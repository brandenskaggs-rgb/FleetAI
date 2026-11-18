package com.fleetai.driver.updates

import org.junit.Assert.*
import org.junit.Test

class DriverUpdatePolicyTest {
    private val pilot = DriverRelease("pilot-debug", 19, "1.10.7", "https://fleetaiops.com/downloads/driver/fleetai-19.apk")
    @Test fun preventsDowngradesAndWrongDistributionChannel() {
        assertTrue(DriverUpdatePolicy.allowed(pilot, true, 18))
        assertFalse(DriverUpdatePolicy.allowed(pilot, true, 19))
        assertFalse(DriverUpdatePolicy.allowed(pilot, false, 18))
        val play = pilot.copy(channel = "play", url = "https://play.google.com/store/apps/details?id=com.fleetai.driver")
        assertTrue(DriverUpdatePolicy.allowed(play, false, 18))
        assertFalse(DriverUpdatePolicy.allowed(play, true, 18))
    }
    @Test fun rejectsUntrustedDownloadLinks() {
        listOf("http://fleetaiops.com/downloads/driver/a.apk", "https://evil.example/a.apk", "https://fleetaiops.com/downloads/driver/../a.apk", "https://fleetaiops.com/downloads/driver/%2e%2e.apk", "https://user@fleetaiops.com/downloads/driver/a.apk", "https://fleetaiops.com/downloads/driver/a.apk?x=y").forEach {
            assertFalse(it, DriverUpdatePolicy.allowed(pilot.copy(url = it), true, 18))
        }
    }
}
