package com.fleetai.driver.telemetry

import com.fleetai.driver.network.DriverApi
import com.fleetai.driver.network.TelemetryUploadRequest
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.format.DateTimeFormatter

class TelemetryUploader(
    private val api: DriverApi,
    private val onUpload: (count: Int, timestamp: String) -> Unit,
    private val onError: (Throwable) -> Unit
) {
    private val scope = CoroutineScope(Dispatchers.IO)
    private var job: Job? = null

    fun start(
        deviceId: String,
        vehicleId: String,
        tripId: String,
        samplingRateSeconds: Int,
        uploadIntervalSeconds: Int
    ) {
        stop()
        job = scope.launch {
            val buffer = mutableListOf<com.fleetai.driver.network.TelemetrySample>()
            val sampleDelay = (samplingRateSeconds.coerceAtLeast(1) * 1000L)
            val uploadDelay = (uploadIntervalSeconds.coerceAtLeast(2) * 1000L)
            var lastUpload = System.currentTimeMillis()

            while (isActive) {
                buffer.add(TelemetrySimulator.generateSample())
                delay(sampleDelay)

                val now = System.currentTimeMillis()
                if (now - lastUpload >= uploadDelay && buffer.isNotEmpty()) {
                    try {
                        api.uploadTelemetry(
                            TelemetryUploadRequest(
                                device_id = deviceId,
                                vehicle_id = vehicleId,
                                trip_id = tripId,
                                samples = buffer.toList()
                            )
                        )
                        val stamp = DateTimeFormatter.ISO_INSTANT.format(Instant.now())
                        onUpload(buffer.size, stamp)
                        buffer.clear()
                        lastUpload = now
                    } catch (ex: Exception) {
                        onError(ex)
                        buffer.clear()
                        lastUpload = now
                    }
                }
            }
        }
    }

    fun stop() {
        job?.cancel()
        job = null
    }
}
