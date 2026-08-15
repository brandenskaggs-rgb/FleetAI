package com.fleetai.driver.telemetry

import com.fleetai.driver.data.local.TelemetryOutboxDao
import com.fleetai.driver.data.local.TelemetryOutboxEntity
import com.fleetai.driver.network.ApiService
import com.fleetai.driver.network.TelemetryIngestRequest
import com.squareup.moshi.Moshi
import com.squareup.moshi.kotlin.reflect.KotlinJsonAdapterFactory
import java.util.concurrent.atomic.AtomicLong
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import retrofit2.HttpException

/** Durable, idempotent hand-off between vehicle capture and the network. */
class TelemetryOutbox(private val dao: TelemetryOutboxDao) {
    private val adapter = Moshi.Builder()
        .add(KotlinJsonAdapterFactory())
        .build()
        .adapter(TelemetryIngestRequest::class.java)
    private val flushMutex = Mutex()
    private val lastPrunedAt = AtomicLong(0L)

    suspend fun enqueue(request: TelemetryIngestRequest) {
        val now = System.currentTimeMillis()
        dao.insert(
            TelemetryOutboxEntity(
                id = request.batchId,
                payloadJson = adapter.toJson(request),
                createdAtEpochMs = now,
                nextAttemptEpochMs = now,
                attemptCount = 0,
                lastError = ""
            )
        )
        val previousPrune = lastPrunedAt.get()
        if (now - previousPrune >= PRUNE_INTERVAL_MS && lastPrunedAt.compareAndSet(previousPrune, now)) {
            dao.deleteOlderThan(now - RETENTION_MS)
            dao.trimToNewest(MAX_QUEUED_BATCHES)
        }
    }

    suspend fun flush(api: ApiService, limit: Int = 25): FlushResult = flushMutex.withLock {
        var sent = 0
        var failed = 0
        val items = dao.pending(System.currentTimeMillis(), limit)
        for (item in items) {
            val request = runCatching { adapter.fromJson(item.payloadJson) }.getOrNull()
            if (request == null) {
                dao.delete(item.id)
                failed += 1
                continue
            }
            try {
                api.ingestTelemetry(request)
                dao.delete(item.id)
                sent += 1
            } catch (error: Exception) {
                val status = (error as? HttpException)?.code()
                if (status != null && status in PERMANENT_CLIENT_ERRORS) {
                    dao.delete(item.id)
                    failed += 1
                    continue
                }
                val attempts = item.attemptCount + 1
                val delayMs = (BASE_RETRY_MS * (1L shl attempts.coerceAtMost(8))).coerceAtMost(MAX_RETRY_MS)
                dao.markFailed(
                    item.id,
                    attempts,
                    System.currentTimeMillis() + delayMs,
                    (error.message ?: "network_error").take(240)
                )
                failed += 1
                // Preserve ordering. If the network is down, later requests
                // will fail too and should not consume battery retrying.
                break
            }
        }
        FlushResult(sent, failed, dao.count())
    }

    data class FlushResult(val sent: Int, val failed: Int, val remaining: Int)

    companion object {
        private const val BASE_RETRY_MS = 1_000L
        private const val MAX_RETRY_MS = 5 * 60_000L
        private const val RETENTION_MS = 7 * 24 * 60 * 60_000L
        private const val PRUNE_INTERVAL_MS = 6 * 60 * 60_000L
        private const val MAX_QUEUED_BATCHES = 100_000
        private val PERMANENT_CLIENT_ERRORS = setOf(400, 404, 405, 410, 413, 415, 422)
    }
}
