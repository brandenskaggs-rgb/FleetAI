package com.fleetai.driver.telemetry

import com.fleetai.driver.data.local.TelemetryOutboxDao
import com.fleetai.driver.data.local.TelemetryOutboxEntity
import com.fleetai.driver.network.ApiService
import com.fleetai.driver.network.AuthenticatedSession
import com.fleetai.driver.network.BasicResponse
import com.fleetai.driver.network.TelemetryIngestRequest
import java.lang.reflect.Proxy
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.runBlocking
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.*
import org.junit.Test
import retrofit2.HttpException
import retrofit2.Response

class TelemetryOutboxSessionTest {
    private val original = AuthenticatedSession("tenant-a", "driver-a", "vehicle-a", "test-token-a")
    private val replacement = original.copy(driverId = "driver-b", token = "test-token-b")

    private class MemoryDao : TelemetryOutboxDao {
        val rows = linkedMapOf<String, TelemetryOutboxEntity>()
        var selected: () -> Unit = {}
        override suspend fun insert(item: TelemetryOutboxEntity): Long { rows.putIfAbsent(item.id, item); return 1L }
        private fun pending(tenantId: String, vehicleId: String, now: Long) = rows.values
            .filter { it.tenantId == tenantId && it.vehicleId == vehicleId && it.nextAttemptEpochMs <= now }
        override suspend fun pendingNewest(tenantId: String, vehicleId: String, now: Long, limit: Int) =
            pending(tenantId, vehicleId, now).sortedByDescending { it.createdAtEpochMs }.take(limit).also { selected() }
        override suspend fun pendingOldest(tenantId: String, vehicleId: String, now: Long, limit: Int) =
            pending(tenantId, vehicleId, now).sortedBy { it.createdAtEpochMs }.take(limit)
        override suspend fun deleteUnscoped(): Int = 0
        override suspend fun delete(id: String) { rows.remove(id) }
        override suspend fun markFailed(id: String, attempts: Int, nextAttempt: Long, error: String) {
            rows[id]?.let { rows[id] = it.copy(attemptCount = attempts, nextAttemptEpochMs = nextAttempt, lastError = error) }
        }
        override suspend fun count(tenantId: String, vehicleId: String) = rows.values.count { it.tenantId == tenantId && it.vehicleId == vehicleId }
        override suspend fun deleteOlderThan(cutoff: Long) { }
        override suspend fun trimToNewest(keepNewest: Int) { }
    }

    private fun api(upload: (TelemetryIngestRequest, AuthenticatedSession) -> BasicResponse): ApiService =
        Proxy.newProxyInstance(ApiService::class.java.classLoader, arrayOf(ApiService::class.java)) { _, method, args ->
            check(method.name == "ingestTelemetry")
            upload(args[0] as TelemetryIngestRequest, args[1] as AuthenticatedSession)
        } as ApiService

    private fun request(id: String = "batch-1") = TelemetryIngestRequest(id, original.vehicleId,
        original.driverId, "device-1", timestamp = "2026-11-19T00:00:00Z", metrics = mapOf("rpm" to 700.0))

    @Test fun switchedSessionLeavesSelectedRowsQueuedAndOriginalCanResume() = runBlocking {
        val dao = MemoryDao()
        var session = original
        val outbox = TelemetryOutbox(dao) { session }
        outbox.enqueue(request())
        dao.selected = { session = replacement }
        var sent = 0
        val api = api { _, bound -> assertEquals(original, bound); sent++; BasicResponse(true) }
        assertEquals(0, outbox.flush(api).sent)
        assertEquals(0, sent)
        assertEquals(1, dao.rows.size)
        dao.selected = {}
        // A new pass for another driver on the same vehicle must not claim the old payload.
        assertEquals(0, outbox.flush(api).sent)
        assertEquals(1, dao.rows.size)
        session = original
        assertEquals(1, outbox.flush(api).sent)
        assertTrue(dao.rows.isEmpty())
    }

    @Test fun sessionSwitchDuringSuccessOrPermanentErrorDoesNotDeleteRows() = runBlocking {
        for (status in listOf(200, 403)) {
            val dao = MemoryDao()
            var session = original
            val outbox = TelemetryOutbox(dao) { session }
            outbox.enqueue(request())
            val result = outbox.flush(api { _, bound ->
                assertEquals(original, bound)
                session = replacement
                if (status == 403) throw HttpException(Response.error<BasicResponse>(403, "{}".toResponseBody()))
                BasicResponse(true)
            })
            assertEquals(0, result.sent)
            assertEquals(1, dao.rows.size)
            assertEquals(0, dao.rows.values.single().attemptCount)
        }
    }

    @Test fun unauthorizedRowsSurviveAndNewTokenResumesSamePairing() = runBlocking {
        val dao = MemoryDao()
        var session = original
        val outbox = TelemetryOutbox(dao) { session }
        outbox.enqueue(request())
        var calls = 0
        val rejected = api { _, _ -> calls++; throw HttpException(Response.error<BasicResponse>(401, "{}".toResponseBody())) }
        assertTrue(outbox.flush(rejected).authBlocked)
        assertTrue(outbox.flush(rejected).authBlocked)
        assertEquals(1, calls)
        assertEquals(1, dao.rows.size)
        session = original.copy(token = "replacement-token")
        assertEquals(1, outbox.flush(api { _, bound -> assertEquals(session, bound); BasicResponse(true) }).sent)
        assertTrue(dao.rows.isEmpty())
    }

    @Test fun negativeAcknowledgmentAndCancellationPreservePayload() = runBlocking {
        val dao = MemoryDao()
        val outbox = TelemetryOutbox(dao) { original }
        outbox.enqueue(request())
        assertEquals(0, outbox.flush(api { _, _ -> BasicResponse(false) }).sent)
        assertEquals(1, dao.rows.size)
        val row = dao.rows.values.single()
        dao.rows[row.id] = row.copy(nextAttemptEpochMs = 0)
        try { outbox.flush(api { _, _ -> throw CancellationException("stopped") }); fail("Must propagate cancellation") }
        catch (_: CancellationException) { }
        assertEquals(1, dao.rows.size)
    }
}
