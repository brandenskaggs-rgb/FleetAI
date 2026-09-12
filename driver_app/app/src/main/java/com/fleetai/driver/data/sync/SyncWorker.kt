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
        val needsRetry = SyncPass.needsRetry(
            syncPending = { AppGraph.repository.syncPending() },
            flushTelemetry = {
                AppGraph.telemetryOutbox.flush(ApiClient.api, limit = SyncPass.FLUSH_BATCH_SIZE)
            }
        )
        return if (needsRetry) Result.retry() else Result.success()
    }
}
