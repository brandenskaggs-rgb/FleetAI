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
    val accuracyMeters: Float,
    val speedMetersPerSecond: Float? = null,
    val bearingDegrees: Float? = null
)

class DeviceLocationTracker(context: Context) : LocationListener {
    private val appContext = context.applicationContext
    private val manager = appContext.getSystemService(Context.LOCATION_SERVICE) as LocationManager

    @Volatile
    var latest: DeviceLocation? = null
        private set
    @Volatile private var started = false

    @Synchronized
    fun start(): Boolean {
        if (started) return true
        val hasFine = ContextCompat.checkSelfPermission(appContext, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
        val hasCoarse = ContextCompat.checkSelfPermission(appContext, Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED
        if (!hasFine && !hasCoarse) return false
        val providers = listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER)
            .filter { runCatching { manager.isProviderEnabled(it) }.getOrDefault(false) }
        started = providers.map { provider ->
            val registered = runCatching { manager.requestLocationUpdates(provider, 1_000L, 5f, this) }.isSuccess
            if (registered) {
                runCatching { manager.getLastKnownLocation(provider) }.getOrNull()?.let(::onLocationChanged)
            }
            registered
        }.any { it }
        return started
    }

    @Synchronized
    fun stop() {
        runCatching { manager.removeUpdates(this) }
        started = false
        latest = null
    }

    fun latestFresh(maxAgeMs: Long = 120_000L, nowMs: Long = System.currentTimeMillis()): DeviceLocation? {
        return latest?.takeIf { location ->
            nowMs - location.capturedAtEpochMs in 0..maxAgeMs
        }
    }

    override fun onLocationChanged(location: Location) {
        if (!location.latitude.isFinite() || !location.longitude.isFinite()) return
        if (location.latitude !in -90.0..90.0 || location.longitude !in -180.0..180.0) return
        val capturedAt = location.time.takeIf { it > 0 } ?: System.currentTimeMillis()
        val current = latest
        if (current != null && capturedAt < current.capturedAtEpochMs) return
        if (current != null && capturedAt == current.capturedAtEpochMs && location.accuracy >= current.accuracyMeters) return
        latest = DeviceLocation(
            latitude = location.latitude,
            longitude = location.longitude,
            capturedAtEpochMs = capturedAt,
            accuracyMeters = location.accuracy.takeIf { it.isFinite() && it >= 0f } ?: 0f,
            speedMetersPerSecond = location.speed.takeIf { location.hasSpeed() && it.isFinite() && it >= 0f },
            bearingDegrees = location.bearing.takeIf { location.hasBearing() && it.isFinite() }
        )
    }

    @Deprecated("Deprecated in Android")
    override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) = Unit
}
