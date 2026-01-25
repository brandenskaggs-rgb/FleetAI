package com.fleetai.driver

import android.app.Application
import androidx.work.ExistingPeriodicWorkPolicy
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
        val workRequest = PeriodicWorkRequestBuilder<SyncWorker>(15, TimeUnit.MINUTES)
            .build()
        WorkManager.getInstance(this).enqueueUniquePeriodicWork(
            "fleet_sync",
            ExistingPeriodicWorkPolicy.KEEP,
            workRequest
        )
    }
}
