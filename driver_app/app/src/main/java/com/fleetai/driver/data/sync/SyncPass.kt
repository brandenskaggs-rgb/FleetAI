package com.fleetai.driver.data.sync

import com.fleetai.driver.telemetry.TelemetryOutbox
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive

internal object SyncPass {
    private const val MAX_FLUSH_ROUNDS = 5
    const val FLUSH_BATCH_SIZE = 100

    // A failed operational record must not prevent the independent telemetry queue from draining.
    suspend fun needsRetry(
        syncPending: suspend () -> Unit,
        flushTelemetry: suspend () -> TelemetryOutbox.FlushResult
    ): Boolean {
        var logsNeedRetry = false
        try {
            syncPending()
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            logsNeedRetry = true
        }

        try {
            repeat(MAX_FLUSH_ROUNDS) {
                currentCoroutineContext().ensureActive()
                val flush = flushTelemetry()
                currentCoroutineContext().ensureActive()
                // Do not spin on blocked credentials; preserve any unrelated log retry.
                if (flush.authBlocked) return logsNeedRetry
                if (flush.failed > 0) return true
                if (flush.remaining == 0) return logsNeedRetry
            }
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            return true
        }
        return true
    }
}
