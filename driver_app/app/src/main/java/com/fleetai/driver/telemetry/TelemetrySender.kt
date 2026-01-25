package com.fleetai.driver.telemetry

import android.util.Log
import com.fleetai.driver.network.ApiClient
import com.fleetai.driver.network.TelemetryIngestRequest
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.format.DateTimeFormatter

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

    @Volatile private var job: Job? = null
    @Volatile var debug = DebugState()
        private set

    private val lastGood = ConcurrentHashMap<String, Pair<Double, Long>>() // key -> (value, ts)
    private val ema = ConcurrentHashMap<String, Double>() // smoothing
    private val ttlMs = 10_000L
    private val alpha = 0.35 // EMA smoothing for noisy signals
    private val heartbeatKey = "heartbeatMs"
    @Volatile private var cachedVin: String? = null

    fun start() {
        stop()
        job = CoroutineScope(Dispatchers.IO).launch {
            val api = ApiClient.api
            val supported = obd.discoverSupportedPids()
            debug = debug.copy(supportedPidCount = supported.size)
            // VIN read once on connect
            try {
                cachedVin = obd.readVin()
            } catch (_: Exception) {
                cachedVin = null
            }
            val pidPlan = J1979Spec.extendedSet().filter { supported.contains(it.pid) }
            while (isActive) {
                val loopStart = System.currentTimeMillis()
                val metrics = mutableMapOf<String, Any?>()
                val obdConnected = obd.isConnected()
                if (obdConnected) {
                    pidPlan.forEach { spec ->
                        try {
                            val raw = obd.readPid(spec.pid)
                            debug = debug.copy(lastObdReadAt = System.currentTimeMillis())
                            val parsed = when (spec.pid) {
                                "010C" -> com.fleetai.driver.obd.ObdParser.parseRpm(raw ?: "")
                                "010D" -> com.fleetai.driver.obd.ObdParser.parseSpeed(raw ?: "")
                                "0105" -> com.fleetai.driver.obd.ObdParser.parseCoolant(raw ?: "")
                                "010F" -> com.fleetai.driver.obd.ObdParser.parseIntake(raw ?: "")
                                "0142" -> com.fleetai.driver.obd.ObdParser.parseVoltage(raw ?: "")
                                "0110" -> com.fleetai.driver.obd.ObdParser.parseMaf(raw ?: "")
                                "0104" -> raw?.let { com.fleetai.driver.obd.ObdParser.parseLoad(it) }
                                "0111" -> raw?.let { com.fleetai.driver.obd.ObdParser.parseThrottle(it) }
                                "010B" -> raw?.let { com.fleetai.driver.obd.ObdParser.parseMap(it) }
                                else -> null
                            }
                            val now = System.currentTimeMillis()
                            val plausible = parsed?.let { applyPlausibility(spec.pid, it) }
                            if (plausible != null) {
                                val smoothed = smooth(spec.pid, plausible)
                                lastGood[spec.pid] = smoothed to now
                                metrics[nameForPid(spec.pid, spec.name)] = smoothed
                            } else {
                                val cached = lastGood[spec.pid]
                            if (cached != null && now - cached.second < ttlMs) {
                                metrics[nameForPid(spec.pid, spec.name)] = cached.first
                            }
                        }
                    } catch (ex: Exception) {
                        debug = debug.copy(lastError = ex.message ?: "pid_error", errors = debug.errors + 1)
                    }
                        delay(spec.minIntervalMs.coerceAtLeast(100L))
                    }
                }
                // include cached values even if not connected, within TTL
                val nowTs = System.currentTimeMillis()
                lastGood.forEach { (pid, pair) ->
                    if (nowTs - pair.second < ttlMs) {
                        metrics[nameForPid(pid, pid)] = pair.first
                    }
                }
                cachedVin?.let { metrics["vin"] = it }
                // ensure we always send a heartbeat metric so server accepts the payload even if nothing new
                metrics[heartbeatKey] = System.currentTimeMillis()
                val vehicleId = resolveVehicleId()
                val deviceId = resolveDeviceId()
                if (!vehicleId.isNullOrBlank()) {
                    try {
                        val now = Instant.now().toString()
                        api.ingestTelemetry(
                            TelemetryIngestRequest(
                                vehicleId = vehicleId,
                                driverId = resolveDriverId(),
                                deviceId = deviceId,
                                timestamp = now,
                                metrics = metrics,
                                obdConnected = obdConnected,
                                lastObdPacketAt = now
                            )
                        )
                        debug = debug.copy(lastSendAt = System.currentTimeMillis(), lastError = "")
                    } catch (ex: Exception) {
                        debug = debug.copy(lastError = ex.message ?: "send_error", errors = debug.errors + 1)
                        Log.d("FleetAI", "[TEL] send error ${ex.message}")
                    }
                }
                val elapsed = System.currentTimeMillis() - loopStart
                val sleep = (500 - elapsed).coerceAtLeast(50)
                delay(sleep)
            }
        }
    }

    fun stop() {
        job?.cancel()
        job = null
    }

    private fun smooth(key: String, value: Double): Double {
        val emaPrev = ema[key]
        val next = if (emaPrev == null) value else (alpha * value) + (1 - alpha) * emaPrev
        ema[key] = next
        return next
    }

    private fun nameForPid(pid: String, fallbackName: String): String {
        return when (pid) {
            "010C" -> "rpm"
            "010D" -> "speedKph"
            "0105" -> "coolantTempC"
            "010F" -> "intakeAirTempC"
            "0142" -> "batteryVoltageV"
            "0110" -> "mafGramsPerSec"
            "0104" -> "engineLoadPct"
            "0111" -> "throttlePosPct"
            "010B" -> "mapKpa"
            else -> fallbackName.lowercase().replace(" ", "_")
        }
    }

    private fun applyPlausibility(pid: String, value: Double): Double? {
        return when (pid) {
            "010C" -> if (value in 0.0..9000.0) value else null
            "010D" -> if (value in 0.0..260.0) value else null
            "0105", "010F" -> if (value in -40.0..200.0) value else null
            "0142" -> if (value in 6.0..18.5) value else null
            "0110" -> if (value in 0.0..500.0) value else null
            else -> value
        }
    }
}
