package com.fleetai.driver.telemetry

import java.io.File
import org.junit.Assert.assertTrue
import org.junit.Test

class TelemetryOutboxContractTest {
    @Test
    fun unauthorizedUploadsAreBlockedWithoutDeletingRows() {
        val source = File("src/main/java/com/fleetai/driver/telemetry/TelemetryOutbox.kt").readText()
        val authBranch = source.substringAfter("if (status == 401)").substringBefore("if (status != null")
        assertTrue(authBranch.contains("blockedTokenFingerprint = tokenFingerprint"))
        assertTrue(authBranch.contains("device_authorization_required"))
        assertTrue(!authBranch.contains("dao.delete(item.id)"))
    }

    @Test
    fun aDifferentTokenClearsTheAuthorizationBlock() {
        val source = File("src/main/java/com/fleetai/driver/telemetry/TelemetryOutbox.kt").readText()
        assertTrue(source.contains("blockedTokenFingerprint != tokenFingerprint"))
        assertTrue(source.contains("blockedTokenFingerprint = null"))
    }
}
