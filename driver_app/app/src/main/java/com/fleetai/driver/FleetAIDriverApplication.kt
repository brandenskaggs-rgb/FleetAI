package com.fleetai.driver

import android.app.Application
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import com.fleetai.driver.data.sync.SyncWorker
import java.util.concurrent.TimeUnit

class FleetAIDriverApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        AppGraph.init(this)
        scheduleSync()
    }

    private fun scheduleSync() {
        val workManager = WorkManager.getInstance(this)

        val startupSync = OneTimeWorkRequestBuilder<SyncWorker>()
            .build()
        workManager.enqueueUniqueWork(
            "fleet_sync_startup",
            ExistingWorkPolicy.REPLACE,
            startupSync
        )

        val periodicSync = PeriodicWorkRequestBuilder<SyncWorker>(15, TimeUnit.MINUTES)
            .build()
        workManager.enqueueUniquePeriodicWork(
            "fleet_sync",
            ExistingPeriodicWorkPolicy.KEEP,
            periodicSync
        )
    }
}
