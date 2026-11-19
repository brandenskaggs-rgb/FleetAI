package com.fleetai.driver.network

import com.squareup.moshi.Moshi
import com.squareup.moshi.kotlin.reflect.KotlinJsonAdapterFactory
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.*
import org.junit.Test
import retrofit2.Retrofit
import retrofit2.converter.moshi.MoshiConverterFactory

class SessionBoundUploaderTest {
    private val original = AuthenticatedSession("tenant-a", "driver-a", "vehicle-a", "test-token-a", "assignment-a")
    private val replacement = AuthenticatedSession("tenant-b", "driver-b", "vehicle-b", "test-token-b", "assignment-b")
    private val hos = DriverLogRequest("event-1", "2026-11-19", "start", "end", "OFF_DUTY", "private note")
    private val dvir = DvirSubmitRequest("inspection-1", "pre", 10, listOf("brakes"), "defect", "signature", "time")
    private val telemetry = TelemetryIngestRequest("batch-1", "vehicle-a", "driver-a", "device-1", timestamp = "time", metrics = emptyMap())
    private val uploads: List<suspend (SessionBoundUploader) -> Unit> = listOf(
        { it.postHosLog(original, hos); Unit },
        { it.submitDvir(original, dvir); Unit },
        { it.postAlert(original, AlertRequest("alert-1", "driver", "info", "message", "vehicle-a")); Unit },
        { it.ingestTelemetry(original, telemetry); Unit }
    )

    private class Harness(initial: AuthenticatedSession) {
        val current = AtomicReference(initial)
        val sent = CopyOnWriteArrayList<Request>()
        var beforeAuthentication: () -> Unit = {}
        var afterAuthentication: () -> Unit = {}
        var response = "{\"success\":true,\"ok\":true}"
        val client = OkHttpClient.Builder()
            .addInterceptor { chain ->
                beforeAuthentication()
                val request = SessionRequestAuthentication.authenticate(chain.request(), current.get())
                afterAuthentication()
                chain.proceed(request)
            }
            // Terminal interceptor: no sockets, DNS, server, or real credentials.
            .addInterceptor { chain ->
                sent.add(chain.request())
                Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1)
                    .code(200).message("OK").body(response.toResponseBody()).build()
            }.build()
        val api: ApiService = Retrofit.Builder().baseUrl("https://offline.invalid/").client(client)
            .addConverterFactory(MoshiConverterFactory.create(Moshi.Builder().add(KotlinJsonAdapterFactory()).build()))
            .build().create(ApiService::class.java)
        val uploader = SessionBoundUploader(api) { current.get() }

        fun close() {
            client.dispatcher.executorService.shutdownNow()
            client.connectionPool.evictAll()
        }
    }

    @Test fun everyReplayEndpointCarriesItsImmutableSessionTag() = runBlocking {
        val harness = Harness(original)
        try {
            uploads.forEach { it(harness.uploader) }
            assertEquals(4, harness.sent.size)
            harness.sent.forEach {
                assertEquals(original, it.tag(AuthenticatedSession::class.java))
                assertEquals("Bearer test-token-a", it.header("Authorization"))
                assertEquals("tenant-a", it.header("X-Tenant-Id"))
            }
        } finally { harness.close() }
    }

    @Test fun sessionSwitchBetweenSelectionAndDispatchNeverRebindsPayload() = runBlocking {
        for (upload in uploads) {
            val harness = Harness(original)
            try {
                harness.beforeAuthentication = { harness.current.set(replacement) }
                try { upload(harness.uploader); fail("Must preserve queued record") }
                catch (_: ReplaySessionChangedException) { }
                assertTrue(harness.sent.isEmpty())
            } finally { harness.close() }
        }
    }

    @Test fun switchAfterAuthenticationCannotChangeHeadersOrAcknowledgeOldRecord() = runBlocking {
        for (upload in uploads) {
            val harness = Harness(original)
            try {
                harness.afterAuthentication = { harness.current.set(replacement) }
                try { upload(harness.uploader); fail("Must not acknowledge after session switch") }
                catch (_: ReplaySessionChangedException) { }
                assertEquals("Bearer test-token-a", harness.sent.single().header("Authorization"))
                assertEquals("tenant-a", harness.sent.single().header("X-Tenant-Id"))
            } finally { harness.close() }
        }
    }

    @Test fun logoutTrainingTokenRotationAndAssignmentChangesRejectOldRequests() {
        val request = Request.Builder().url("https://offline.invalid/").tag(AuthenticatedSession::class.java, original).build()
        for (changed in listOf(original.copy(token = ""), original.copy(training = true),
            original.copy(token = "new-token"), original.copy(assignmentId = "new-assignment"),
            original.copy(driverId = "other-driver"), original.copy(vehicleId = "other-vehicle"))) {
            try { SessionRequestAuthentication.authenticate(request, changed); fail("Must reject changed session") }
            catch (_: java.io.IOException) { }
        }
        assertFalse(original.toString().contains(original.token))
    }

    @Test fun negativeAcknowledgmentsDoNotCompleteReplay() = runBlocking {
        val harness = Harness(original)
        try {
            harness.response = "{\"success\":false,\"ok\":false}"
            uploads.forEach { upload ->
                try { upload(harness.uploader); fail("Must preserve unacknowledged record") }
                catch (_: IllegalStateException) { }
            }
        } finally { harness.close() }
    }

    @Test fun unboundPairingRequestsStillUseCurrentCredentialsWithoutRequiringVehicle() {
        val unpaired = original.copy(vehicleId = "", token = "")
        val request = Request.Builder().url("https://offline.invalid/api/pairings/claim").build()
        val authenticated = SessionRequestAuthentication.authenticate(request, unpaired)
        assertNull(authenticated.header("Authorization"))
        assertEquals("tenant-a", authenticated.header("X-Tenant-Id"))
    }
}
