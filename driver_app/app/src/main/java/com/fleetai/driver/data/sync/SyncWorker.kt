package com.fleetai.driver.data.sync

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import com.fleetai.driver.AppGraph
import com.fleetai.driver.network.ApiClient

class SyncWorker(
    context: Context,
    params: WorkerParameters
) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        return try {
            AppGraph.repository.syncPending()
            repeat(MAX_FLUSH_ROUNDS) {
                val flush = AppGraph.telemetryOutbox.flush(ApiClient.api, limit = FLUSH_BATCH_SIZE)
                if (flush.failed > 0) return Result.retry()
                if (flush.remaining == 0) return Result.success()
            }
            // Keep the network-constrained work pending until the durable
            // queue is empty instead of waiting for the next 15-minute cycle.
            Result.retry()
        } catch (_: Exception) {
            Result.retry()
        }
    }

    companion object {
        private const val FLUSH_BATCH_SIZE = 100
        private const val MAX_FLUSH_ROUNDS = 5
    }
}
