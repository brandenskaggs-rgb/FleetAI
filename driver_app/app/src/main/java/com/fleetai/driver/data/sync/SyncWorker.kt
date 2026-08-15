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
            AppGraph.telemetryOutbox.flush(ApiClient.api, limit = 100)
            Result.success()
        } catch (_: Exception) {
            Result.retry()
        }
    }
}
