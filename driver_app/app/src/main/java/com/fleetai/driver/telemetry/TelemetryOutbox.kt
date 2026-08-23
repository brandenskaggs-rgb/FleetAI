package com.fleetai.driver.telemetry

import com.fleetai.driver.data.local.TelemetryOutboxDao
import com.fleetai.driver.data.local.TelemetryOutboxEntity
import com.fleetai.driver.network.ApiService
import com.fleetai.driver.network.TelemetryIngestRequest
import com.squareup.moshi.Moshi
import com.squareup.moshi.kotlin.reflect.KotlinJsonAdapterFactory
import java.util.concurrent.atomic.AtomicLong
import java.security.MessageDigest
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import retrofit2.HttpException

/** Durable, idempotent hand-off between vehicle capture and the network. */
class TelemetryOutbox(
    private val dao: TelemetryOutboxDao,
    private val resolveTenantId: suspend () -> String,
    private val resolveVehicleId: suspend () -> String,
    private val resolveAuthToken: suspend () -> String
) {
    private val adapter = Moshi.Builder()
        .add(KotlinJsonAdapterFactory())
        .build()
        .adapter(TelemetryIngestRequest::class.java)
    private val flushMutex = Mutex()
    private val lastPrunedAt = AtomicLong(0L)
    @Volatile private var blockedTokenFingerprint: String? = null

    suspend fun enqueue(request: TelemetryIngestRequest) {
        val now = System.currentTimeMillis()
        val tenantId = resolveTenantId().trim()
        val vehicleId = resolveVehicleId().trim()
        if (tenantId.isBlank() || vehicleId.isBlank() || request.vehicleId != vehicleId) return
        dao.insert(
            TelemetryOutboxEntity(
                id = request.batchId,
                tenantId = tenantId,
                vehicleId = vehicleId,
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
        val tenantId = resolveTenantId().trim()
        val vehicleId = resolveVehicleId().trim()
        if (tenantId.isBlank() || vehicleId.isBlank()) return@withLock FlushResult(0, 0, 0)
        val token = resolveAuthToken().trim()
        val tokenFingerprint = token.takeIf { it.isNotBlank() }?.let(::fingerprint)
        val remaining = dao.count(tenantId, vehicleId)
        if (tokenFingerprint == null) return@withLock FlushResult(0, 0, remaining, authBlocked = true)
        if (blockedTokenFingerprint == tokenFingerprint) {
            return@withLock FlushResult(0, 0, remaining, authBlocked = true)
        }
        if (blockedTokenFingerprint != null && blockedTokenFingerprint != tokenFingerprint) {
            blockedTokenFingerprint = null
        }
        dao.deleteUnscoped()
        val now = System.currentTimeMillis()
        // Always deliver a small newest-first lane before draining history. A
        // multi-day offline backlog must never keep current ECU readings from
        // the live dashboard, while the oldest-first lane still preserves and
        // uploads historical samples.
        val newestLimit = minOf(LIVE_PRIORITY_BATCHES, limit)
        val newest = dao.pendingNewest(tenantId, vehicleId, now, newestLimit)
        val newestIds = newest.asSequence().map { it.id }.toHashSet()
        val oldest = if (newest.size < limit) {
            dao.pendingOldest(tenantId, vehicleId, now, limit - newest.size + newestIds.size)
                .filterNot { it.id in newestIds }
                .take(limit - newest.size)
        } else {
            emptyList()
        }
        val items = newest + oldest
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
                if (status == 401) {
                    blockedTokenFingerprint = tokenFingerprint
                    dao.markFailed(
                        item.id,
                        item.attemptCount + 1,
                        System.currentTimeMillis(),
                        "device_authorization_required"
                    )
                    failed += 1
                    break
                }
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
        FlushResult(sent, failed, dao.count(tenantId, vehicleId), authBlocked = blockedTokenFingerprint == tokenFingerprint)
    }

    data class FlushResult(val sent: Int, val failed: Int, val remaining: Int, val authBlocked: Boolean = false)

    companion object {
        private const val BASE_RETRY_MS = 1_000L
        private const val MAX_RETRY_MS = 5 * 60_000L
        private const val RETENTION_MS = 7 * 24 * 60 * 60_000L
        private const val PRUNE_INTERVAL_MS = 6 * 60 * 60_000L
        private const val MAX_QUEUED_BATCHES = 100_000
        private const val LIVE_PRIORITY_BATCHES = 5
        private val PERMANENT_CLIENT_ERRORS = setOf(400, 403, 404, 405, 410, 413, 415, 422)

        private fun fingerprint(token: String): String = MessageDigest.getInstance("SHA-256")
            .digest(token.toByteArray(Charsets.UTF_8))
            .joinToString("") { byte -> "%02x".format(byte) }
    }
}
