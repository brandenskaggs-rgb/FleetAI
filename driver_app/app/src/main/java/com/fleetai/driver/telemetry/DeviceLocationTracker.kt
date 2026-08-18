package com.fleetai.driver.telemetry

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Bundle
import androidx.core.content.ContextCompat

data class DeviceLocation(
    val latitude: Double,
    val longitude: Double,
    val capturedAtEpochMs: Long,
    val accuracyMeters: Float
)

class DeviceLocationTracker(context: Context) : LocationListener {
    private val appContext = context.applicationContext
    private val manager = appContext.getSystemService(Context.LOCATION_SERVICE) as LocationManager

    @Volatile
    var latest: DeviceLocation? = null
        private set

    fun start(): Boolean {
        if (ContextCompat.checkSelfPermission(appContext, Manifest.permission.ACCESS_FINE_LOCATION)
            != PackageManager.PERMISSION_GRANTED
        ) return false
        val providers = listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER)
            .filter { runCatching { manager.isProviderEnabled(it) }.getOrDefault(false) }
        providers.forEach { provider ->
            runCatching { manager.requestLocationUpdates(provider, 1_000L, 5f, this) }
            runCatching { manager.getLastKnownLocation(provider) }.getOrNull()?.let(::onLocationChanged)
        }
        return providers.isNotEmpty()
    }

    fun stop() {
        runCatching { manager.removeUpdates(this) }
    }

    override fun onLocationChanged(location: Location) {
        if (!location.latitude.isFinite() || !location.longitude.isFinite()) return
        latest = DeviceLocation(
            latitude = location.latitude,
            longitude = location.longitude,
            capturedAtEpochMs = location.time.takeIf { it > 0 } ?: System.currentTimeMillis(),
            accuracyMeters = location.accuracy
        )
    }

    @Deprecated("Deprecated in Android")
    override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) = Unit
}
