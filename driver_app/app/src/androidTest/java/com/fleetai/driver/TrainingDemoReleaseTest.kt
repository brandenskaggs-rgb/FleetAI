package com.fleetai.driver

import android.os.Build
import androidx.room.Room
import androidx.lifecycle.ViewModelStore
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.fleetai.driver.data.local.AppPreferences
import com.fleetai.driver.data.local.DriverDatabase
import com.fleetai.driver.data.model.DutyStatus
import com.fleetai.driver.data.model.DvirRecord
import com.fleetai.driver.data.repository.DefaultDriverRepository
import com.fleetai.driver.network.ApiClient
import com.fleetai.driver.network.ApiService
import com.fleetai.driver.network.MockApiService
import com.fleetai.driver.ui.viewmodel.SensorViewModel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.IOException
import java.lang.reflect.Proxy
import java.time.Instant
import java.time.LocalDate

/** Emulator-only acceptance of the shipped repository, DataStore and HTTP boundary. */
@RunWith(AndroidJUnit4::class)
class TrainingDemoReleaseTest {
    @Test
    fun trainingWorksOfflineAndCannotReplaceOrUploadIntoAPilot() = runBlocking {
        assumeTrue(Build.HARDWARE == "ranchu" || Build.HARDWARE == "goldfish")
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val prefs = AppPreferences(context)
        // Refuse to run against any pre-existing paired install, even on an emulator.
        check(prefs.token.first().isBlank()) { "Acceptance test requires a clean emulator install." }
        val db = Room.inMemoryDatabaseBuilder(context, DriverDatabase::class.java).build()
        var apiCalls = 0
        val forbiddenApi = Proxy.newProxyInstance(ApiService::class.java.classLoader,
            arrayOf(ApiService::class.java)) { _, method, _ ->
            apiCalls++
            throw AssertionError("Demo called live API: ${method.name}")
        } as ApiService
        val repo = DefaultDriverRepository(forbiddenApi, MockApiService(), prefs,
            db.hosDao(), db.notificationDao(), db.vehicleDao(), db.dvirDao())
        try {
            val deviceId = prefs.ensureDeviceId()
            prefs.startTrainingSession()
            assertTrue(prefs.trainingSession.first())
            assertEquals("DEMO", prefs.tenantId.first())
            assertEquals("DEMO_VEHICLE", prefs.vehicleId.first())
            assertEquals(deviceId, prefs.ensureDeviceId())
            assertFalse(repo.getEldDeviceStatus().enabled)
            assertFalse(repo.getEldDeviceStatus().productionAuthorized)
            assertTrue(repo.getEldDeviceStatus().trainingDemo)
            repo.recordEldLogin()
            repo.updateDutyStatus(DutyStatus.ON, "Training shift")
            assertEquals(DutyStatus.ON, repo.getEldDeviceStatus().dutyStatus)
            val day = LocalDate.now().toString()
            val log = repo.getLogbook(day)
            assertEquals(1, log.events.size)
            assertFalse(log.events.single().pendingUpload)
            val inspection = DvirRecord("demo-inspection", "DEMO", "DEMO_VEHICLE", "DEMO_DRIVER",
                "pre", 100L, listOf("Brakes: pass"), "", "Training Driver", Instant.now().toString())
            assertTrue(repo.submitInspection(inspection))
            assertTrue(db.dvirDao().getPending("DEMO", "DEMO_VEHICLE", "DEMO_DRIVER").isEmpty())
            repo.notifyFleet("Training note")
            assertEquals(1, repo.getNotifications().size)
            assertTrue(repo.getDiagnosticCodes().isNotEmpty())
            repo.syncPending()
            repo.recordEldLogout()
            assertTrue(runCatching { repo.certifyEldRecords("260914") }.isFailure)
            assertTrue(runCatching { repo.claimPairing("123456", "123456", deviceId, "Review") }.isFailure)
            assertTrue(runCatching { repo.submitInspection(inspection.copy(tenantId = "OTHER")) }.isFailure)
            assertEquals(0, apiCalls)

            val store = ViewModelStore()
            lateinit var sensors: SensorViewModel
            InstrumentationRegistry.getInstrumentation().runOnMainSync {
                sensors = SensorViewModel(prefs)
                store.put("training-sensors", sensors)
            }
            try {
                val readings = withTimeout(10_000) { sensors.readings.first { it.size == 6 } }
                val coolant = readings.first { it.pid == "0105" }
                assertEquals("F", coolant.unit)
                assertTrue(coolant.value.toDouble() in 172.4..204.8)
                sensors.toggleUnits(tempF = false, speedMph = false)
                val metric = withTimeout(10_000) {
                    sensors.readings.first { it.firstOrNull { r -> r.pid == "0105" }?.unit == "C" }
                }
                assertTrue(metric.first { it.pid == "0105" }.value.toDouble() in 78.0..96.0)
                assertEquals("km/h", metric.first { it.pid == "010D" }.unit)
                sensors.connectUsbJ1939()
                assertTrue(sensors.status.value.contains("hardware is disabled"))
                sensors.setLocationSharingEnabled(true)
                assertFalse(sensors.locationSharingEnabled.value)
            } finally {
                InstrumentationRegistry.getInstrumentation().runOnMainSync { store.clear() }
            }

            // Exercise the real HTTP interceptor: rejection must occur before any network request.
            ApiClient.init(context, prefs)
            val blocked = runCatching { ApiClient.api.getEldDeviceStatus() }.exceptionOrNull()
            assertTrue(blocked is IOException)
            assertTrue(blocked?.message.orEmpty().contains("Training demo is local only"))
            // Old builds could leave a demo token after switching the toggle off.
            prefs.setDemoMode(false)
            assertTrue(prefs.trainingSession.first())
            assertTrue(runCatching { ApiClient.api.getEldDeviceStatus() }.exceptionOrNull() is IOException)
            prefs.exitTrainingSession()
            assertFalse(prefs.trainingSession.first())
            assertEquals("", prefs.token.first())
            assertEquals(deviceId, prefs.ensureDeviceId())

            // Fixture credentials are deliberately invalid and never sent to a server.
            prefs.saveClaimedSession("TEST_PILOT", "TEST_DRIVER", "Test", "TEST_VEHICLE", "TEST_PAIR", "test-only-token")
            assertTrue(runCatching { prefs.startTrainingSession() }.isFailure)
            assertEquals("TEST_VEHICLE", prefs.vehicleId.first())
            assertEquals("test-only-token", prefs.token.first())
            assertFalse(prefs.trainingSession.first())
            assertTrue(db.hosDao().getEventsByDate("TEST_PILOT", "TEST_DRIVER", day).isEmpty())
            assertTrue(db.dvirDao().getPending("TEST_PILOT", "TEST_VEHICLE", "TEST_DRIVER").isEmpty())
        } finally {
            prefs.clearSession()
            prefs.setDemoMode(false)
            db.close()
        }
    }
}
