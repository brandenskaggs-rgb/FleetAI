package com.fleetai.driver.telemetry

import com.fleetai.driver.AppGraph
import com.fleetai.driver.BuildConfig
import com.fleetai.driver.j1939.CanFrame
import com.fleetai.driver.j1939.J1939DecodeResult
import com.fleetai.driver.j1939.UsbJ1939Diagnostics
import com.fleetai.driver.network.ApiClient
import com.fleetai.driver.network.CanFrameDto
import com.fleetai.driver.network.TelemetryAdapterDto
import com.fleetai.driver.network.TelemetryIngestRequest
import com.fleetai.driver.network.TelemetryDtcDto
import com.fleetai.driver.obd.ExtendedPidProfile
import java.time.Instant
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
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
    private data class MetricSnapshot(
        val metrics: Map<String, Any?> = emptyMap(),
        val updatedAt: Map<String, Long> = emptyMap(),
        val packetAt: Long = 0L
    )

    data class DebugState(
        val lastObdReadAt: Long = 0L,
        val lastSendAt: Long = 0L,
        val lastError: String = "",
        val supportedPidCount: Int = 0,
        val dongleMac: String = "",
        val errors: Int = 0,
        val protocol: String = "NONE",
        val rawFrameCount: Long = 0,
        val queuedBatches: Int = 0,
        val bitrate: Int? = null,
        val bytesReceived: Long = 0,
        val rejectedRecords: Long = 0,
        val reconnectCount: Int = 0,
        val busSilenceMs: Long = 0,
        val connectorProfile: String = "UNKNOWN",
        val adapterResponding: Boolean = false,
        val ecuResponding: Boolean = false,
        val adapterIdentity: String = "",
        val adapterVoltage: String = "",
        val detectedProtocol: String = "",
        val ecuState: String = "adapter_unavailable",
        val lastObdCommand: String = "",
        val lastObdResponse: String = ""
    )

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    @Volatile private var captureJob: Job? = null
    @Volatile private var flushJob: Job? = null
    @Volatile var debug = DebugState()
        private set
    @Volatile private var latestMetricSnapshot = MetricSnapshot()
    private val latestFrames = ConcurrentHashMap<String, CanFrameDto>()
    private val activeDtcs = ConcurrentHashMap.newKeySet<String>()
    private val latestMeta = ConcurrentHashMap<String, Any?>()
    @Volatile private var latestConnected = false
    @Volatile private var latestPacketAt = 0L
    @Volatile private var lastEnqueuedPacketAt = 0L
    @Volatile private var activeProtocol = "OBD2"
    @Volatile private var adapterMetadata: TelemetryAdapterDto? = null
    private val heartbeatKey = "heartbeatMs"

    fun start(protocol: String = "OBD2", adapter: TelemetryAdapterDto? = null) {
        stop()
        activeProtocol = protocol.uppercase()
        adapterMetadata = adapter
        latestMetricSnapshot = MetricSnapshot()
        latestFrames.clear()
        activeDtcs.clear()
        latestMeta.clear()
        latestConnected = if (activeProtocol == "OBD2") obd.isConnected() else false
        latestPacketAt = 0L
        lastEnqueuedPacketAt = 0L
        debug = debug.copy(lastError = "", protocol = activeProtocol, supportedPidCount = 0)
        captureJob = scope.launch {
            while (isActive) {
                enqueueCurrentBatch()
                delay(UPLOAD_INTERVAL_MS)
            }
        }
        flushJob = scope.launch {
            while (isActive) {
                flushOutbox()
                delay(OUTBOX_FLUSH_INTERVAL_MS)
            }
        }
    }

    fun updateObdCapabilities(supported: Set<String>) {
        val normalized = supported.map { it.replace(" ", "").uppercase() }.distinct().sorted()
        latestMeta["supportedPids"] = normalized
        debug = debug.copy(supportedPidCount = normalized.size)
    }

    fun updateVin(vin: String?) {
        if (vin.isNullOrBlank()) latestMeta.remove("vin") else latestMeta["vin"] = vin
    }

    fun updateLocation(location: DeviceLocation?) {
        if (location == null) {
            latestMeta.remove("latitude")
            latestMeta.remove("longitude")
            latestMeta.remove("locationCapturedAt")
            latestMeta.remove("locationAccuracyMeters")
            return
        }
        latestMeta["latitude"] = location.latitude
        latestMeta["longitude"] = location.longitude
        latestMeta["locationCapturedAt"] = location.capturedAtEpochMs
        latestMeta["locationAccuracyMeters"] = location.accuracyMeters.toDouble()
    }

    fun updateExtendedProfile(profile: ExtendedPidProfile?) {
        if (profile == null) {
            latestMeta.remove("extendedPidProfile")
            latestMeta.remove("extendedPidProfileName")
            latestMeta.remove("extendedPidSource")
            latestMeta.remove("extendedPidSourceScope")
            latestMeta.remove("extendedPidCount")
            return
        }
        latestMeta["extendedPidProfile"] = profile.id
        latestMeta["extendedPidProfileName"] = profile.name
        latestMeta["extendedPidSource"] = profile.source.name
        latestMeta["extendedPidSourceScope"] = profile.source.scope
        latestMeta["extendedPidCount"] = profile.sensors.size
    }

    private suspend fun enqueueCurrentBatch() {
        if (activeProtocol == "OBD2") refreshObdDiagnostics()
        val metricSnapshot = latestMetricSnapshot
        val packetAt = maxOf(latestPacketAt, metricSnapshot.packetAt)
        val hasFreshMetrics = metricSnapshot.packetAt > lastEnqueuedPacketAt && metricSnapshot.metrics.isNotEmpty()
        val metrics = if (hasFreshMetrics) metricSnapshot.metrics.toMutableMap() else mutableMapOf()
        metrics[heartbeatKey] = System.currentTimeMillis()
        val frames = drainFrameSample()
        val vehicleId = resolveVehicleId()
        if (vehicleId.isNullOrBlank() || (metrics.size == 1 && frames.isEmpty() && !latestConnected)) return
        val lastVehiclePacketAt = packetAt.takeIf { hasFreshMetrics || frames.isNotEmpty() }
            ?.takeIf { it > 0L }
            ?.let { Instant.ofEpochMilli(it) }
        val capturedAt = lastVehiclePacketAt ?: Instant.now()
        val busDataActive = frames.isNotEmpty() || metrics.any { (key, value) ->
            key != heartbeatKey && key != "vin" && value != null
        }
        val requestMeta = latestMeta.toMutableMap()
        if (hasFreshMetrics) {
            val now = System.currentTimeMillis()
            requestMeta["metricAgesMs"] = metricSnapshot.metrics.keys.associateWith { key ->
                (now - (metricSnapshot.updatedAt[key] ?: metricSnapshot.packetAt)).coerceAtLeast(0L)
            }
        }
        val request = TelemetryIngestRequest(
            batchId = UUID.randomUUID().toString(),
            vehicleId = vehicleId,
            driverId = resolveDriverId(),
            deviceId = resolveDeviceId(),
            protocol = activeProtocol,
            timestamp = capturedAt.toString(),
            metrics = metrics,
            frames = frames,
            dtc = TelemetryDtcDto(active = activeDtcs.toList().sorted()),
            meta = requestMeta,
            adapter = adapterMetadata,
            obdConnected = latestConnected,
            busDataActive = busDataActive,
            lastObdPacketAt = lastVehiclePacketAt?.toString()
        )
        try {
            AppGraph.telemetryOutbox.enqueue(request)
            if (hasFreshMetrics) lastEnqueuedPacketAt = metricSnapshot.packetAt
        } catch (error: Exception) {
            debug = debug.copy(
                lastError = error.message ?: "telemetry_queue_error",
                errors = debug.errors + 1
            )
        }
    }

    private suspend fun flushOutbox() {
        try {
            val result = AppGraph.telemetryOutbox.flush(ApiClient.api)
            debug = debug.copy(
                lastSendAt = if (result.sent > 0) System.currentTimeMillis() else debug.lastSendAt,
                lastError = if (result.failed == 0) "" else "Telemetry queued for retry",
                queuedBatches = result.remaining
            )
        } catch (error: Exception) {
            debug = debug.copy(
                lastError = error.message ?: "telemetry_flush_error",
                errors = debug.errors + 1
            )
        }
    }

    private fun refreshObdDiagnostics() {
        val diagnostics = obd.diagnosticsSnapshot()
        debug = debug.copy(
            adapterResponding = diagnostics.adapterResponding,
            ecuResponding = diagnostics.ecuResponding,
            adapterIdentity = diagnostics.adapterIdentity,
            adapterVoltage = diagnostics.adapterVoltage,
            detectedProtocol = diagnostics.detectedProtocol,
            ecuState = diagnostics.ecuState,
            lastObdCommand = diagnostics.lastCommand,
            lastObdResponse = diagnostics.lastResponse,
            lastError = diagnostics.failureReason
        )
        latestMeta["appVersion"] = BuildConfig.VERSION_NAME
        latestMeta["appVersionCode"] = BuildConfig.VERSION_CODE
        latestMeta["obdTransport"] = diagnostics.transport
        latestMeta["adapterResponding"] = diagnostics.adapterResponding
        latestMeta["ecuResponding"] = diagnostics.ecuResponding
        latestMeta["ecuState"] = diagnostics.ecuState
        setMetaText("adapterIdentity", diagnostics.adapterIdentity)
        setMetaText("adapterVoltage", diagnostics.adapterVoltage)
        setMetaText("detectedProtocol", diagnostics.detectedProtocol)
        setMetaText("obdLastCommand", diagnostics.lastCommand)
        setMetaText("obdLastResponse", diagnostics.lastResponse)
        setMetaText("obdFailureReason", diagnostics.failureReason)
    }

    private fun setMetaText(key: String, value: String) {
        if (value.isBlank()) latestMeta.remove(key) else latestMeta[key] = value
    }

    fun updateSnapshot(
        metrics: Map<String, Double?>,
        obdConnected: Boolean,
        packetAt: Long = System.currentTimeMillis(),
        metricUpdatedAt: Map<String, Long> = emptyMap()
    ) {
        val validMetrics = mutableMapOf<String, Any?>()
        val validUpdatedAt = mutableMapOf<String, Long>()
        metrics.forEach { (key, value) ->
            if (value != null && value.isFinite()) {
                validMetrics[key] = value
                validUpdatedAt[key] = metricUpdatedAt[key] ?: packetAt
            }
        }
        latestMetricSnapshot = MetricSnapshot(validMetrics, validUpdatedAt, packetAt)
        latestConnected = obdConnected
        if (validMetrics.isNotEmpty()) {
            latestPacketAt = packetAt
            debug = debug.copy(lastObdReadAt = packetAt)
        }
    }

    fun updateJ1939Frame(frame: CanFrame) {
        val timestamp = Instant.ofEpochMilli(frame.capturedAtEpochMs).toString()
        // Coalesce by CAN identifier between uploads. This retains every
        // observed PGN/source while bounding cellular and local storage load.
        val key = when (frame.pgn) {
            60160 -> "${frame.id}:${frame.data.firstOrNull()?.toInt()?.and(0xff) ?: 0}:${frame.capturedAtEpochMs / UPLOAD_INTERVAL_MS}"
            60416 -> "${frame.id}:cm:${frame.capturedAtEpochMs / UPLOAD_INTERVAL_MS}"
            else -> frame.id.toString()
        }
        latestFrames[key] = CanFrameDto(
            id = frame.id,
            data = frame.data.map { it.toInt() and 0xff },
            timestamp = timestamp,
            extended = frame.extended,
            priority = frame.priority,
            pgn = frame.pgn,
            sourceAddress = frame.sourceAddress,
            destinationAddress = frame.destinationAddress
        )
        latestConnected = true
        latestPacketAt = frame.capturedAtEpochMs
        debug = debug.copy(rawFrameCount = debug.rawFrameCount + 1, lastObdReadAt = frame.capturedAtEpochMs)
    }

    fun updateJ1939TransportDiagnostics(
        diagnostics: UsbJ1939Diagnostics,
        connectorProfile: String
    ) {
        val silence = if (diagnostics.lastFrameAtEpochMs > 0) {
            (System.currentTimeMillis() - diagnostics.lastFrameAtEpochMs).coerceAtLeast(0)
        } else {
            0
        }
        debug = debug.copy(
            bitrate = diagnostics.bitrate,
            bytesReceived = diagnostics.bytesReceived,
            rejectedRecords = diagnostics.rejectedRecords,
            reconnectCount = diagnostics.reconnectCount,
            busSilenceMs = silence,
            connectorProfile = connectorProfile,
            lastError = diagnostics.lastError.ifBlank { debug.lastError }
        )
        latestMeta["captureBitrate"] = diagnostics.bitrate
        latestMeta["captureBytes"] = diagnostics.bytesReceived
        latestMeta["captureRejectedRecords"] = diagnostics.rejectedRecords
        latestMeta["captureReconnectCount"] = diagnostics.reconnectCount
        latestMeta["captureBusSilenceMs"] = silence
        latestMeta["connectorProfile"] = connectorProfile
    }

    fun updateAdapter(adapter: TelemetryAdapterDto) {
        adapterMetadata = adapter
    }

    fun updateJ1939Decode(result: J1939DecodeResult) {
        if (result.pgn == 65226) {
            activeDtcs.clear()
            activeDtcs.addAll(result.activeDtcs)
        }
        result.vin?.let { latestMeta["vin"] = it }
        result.pgn?.let { latestMeta["lastPgn"] = it }
    }

    private fun drainFrameSample(): List<CanFrameDto> {
        val selected = latestFrames.entries.sortedBy { it.key }.take(MAX_FRAMES_PER_BATCH)
        selected.forEach { latestFrames.remove(it.key, it.value) }
        return selected.map { it.value }
    }

    fun stop() {
        val currentCapture = captureJob
        val currentFlush = flushJob
        captureJob = null
        flushJob = null
        currentCapture?.cancel()
        currentFlush?.cancel()
        scope.launch {
            runCatching { currentCapture?.cancelAndJoin() }
            runCatching { currentFlush?.cancelAndJoin() }
        }
    }

    companion object {
        private const val UPLOAD_INTERVAL_MS = 2_000L
        private const val OUTBOX_FLUSH_INTERVAL_MS = 500L
        private const val MAX_FRAMES_PER_BATCH = 256
    }
}
