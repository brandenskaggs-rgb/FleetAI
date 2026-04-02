package com.fleetai.driver.telemetry

import android.util.Log
import com.fleetai.driver.network.ApiClient
import com.fleetai.driver.network.TelemetryIngestRequest
import java.time.Instant
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

class TelemetrySender(
    private val obd: com.fleetai.driver.obd.ObdConnectionManager,
    private val resolveVehicleId: suspend () -> String?,
    private val resolveDriverId: suspend () -> String?,
    private val resolveDeviceId: suspend () -> String
) {
    data class DebugState(
        val lastObdReadAt: Long = 0L,
        val lastSendAt: Long = 0L,
        val lastError: String = "",
        val supportedPidCount: Int = 0,
        val dongleMac: String = "",
        val errors: Int = 0
    )

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    @Volatile private var job: Job? = null
    @Volatile var debug = DebugState()
        private set

    private val latestMetrics = ConcurrentHashMap<String, Any?>()
    @Volatile private var latestObdConnected = false
    @Volatile private var latestObdPacketAt = 0L
    @Volatile private var cachedVin: String? = null
    private val heartbeatKey = "heartbeatMs"

    fun start() {
        stop()
        latestMetrics.clear()
        latestObdConnected = obd.isConnected()
        latestObdPacketAt = 0L
        debug = debug.copy(lastError = "")
        job = scope.launch {
            val api = ApiClient.api
            try {
                val supported = obd.discoverSupportedPids()
                debug = debug.copy(supportedPidCount = supported.size)
            } catch (ex: Exception) {
                debug = debug.copy(lastError = ex.message ?: "discover_pid_error", errors = debug.errors + 1)
            }
            try {
                cachedVin = obd.readVin()
            } catch (_: Exception) {
                cachedVin = null
            }
            while (isActive) {
                val metrics = latestMetrics.toMutableMap()
                val obdConnected = latestObdConnected
                cachedVin?.let { metrics["vin"] = it }
                metrics[heartbeatKey] = System.currentTimeMillis()
                val vehicleId = resolveVehicleId()
                val deviceId = resolveDeviceId()
                if (!vehicleId.isNullOrBlank() && (metrics.isNotEmpty() || obdConnected)) {
                    try {
                        val now = Instant.now().toString()
                        val lastPacketAt = if (latestObdPacketAt > 0L) {
                            Instant.ofEpochMilli(latestObdPacketAt).toString()
                        } else {
                            now
                        }
                        api.ingestTelemetry(
                            TelemetryIngestRequest(
                                vehicleId = vehicleId,
                                driverId = resolveDriverId(),
                                deviceId = deviceId,
                                protocol = if (debug.supportedPidCount > 0) "OBD2" else "J1939",
                                timestamp = now,
                                metrics = metrics,
                                obdConnected = obdConnected,
                                lastObdPacketAt = lastPacketAt
                            )
                        )
                        debug = debug.copy(lastSendAt = System.currentTimeMillis(), lastError = "")
                    } catch (ex: Exception) {
                        debug = debug.copy(lastError = ex.message ?: "send_error", errors = debug.errors + 1)
                        Log.d("FleetAI", "[TEL] send error ${ex.message}")
                    }
                }
                delay(1000)
            }
        }
    }

    fun updateSnapshot(metrics: Map<String, Double?>, obdConnected: Boolean, packetAt: Long = System.currentTimeMillis()) {
        latestMetrics.clear()
        metrics.forEach { (key, value) ->
            if (value != null) {
                latestMetrics[key] = value
            }
        }
        latestObdConnected = obdConnected
        latestObdPacketAt = packetAt
        if (metrics.isNotEmpty()) {
            debug = debug.copy(lastObdReadAt = packetAt)
        }
    }

    fun stop() {
        val current = job ?: return
        job = null
        current.cancel()
        scope.launch {
            runCatching { current.cancelAndJoin() }
        }
    }
}
