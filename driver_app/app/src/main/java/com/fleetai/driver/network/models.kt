package com.fleetai.driver.network

data class RegisterDeviceRequest(
    val driver_name: String,
    val device_model: String
)

data class RegisterDeviceResponse(
    val device_id: String,
    val token: String
)

data class TripStartRequest(
    val device_id: String,
    val vehicle_id: String
)

data class TripStartResponse(
    val trip_id: String,
    val started_at: String
)

data class TripEndRequest(
    val trip_id: String
)

data class TripEndResponse(
    val trip_id: String,
    val ended_at: String
)

data class TelemetrySample(
    val ts: String,
    val speed: Double,
    val rpm: Double,
    val coolant_temp: Double,
    val fuel_level: Double,
    val voltage: Double,
    val odometer: Double
)

data class TelemetryUploadRequest(
    val device_id: String,
    val vehicle_id: String,
    val trip_id: String,
    val samples: List<TelemetrySample>
)

data class TelemetryUploadResponse(
    val received: Int,
    val stored: Boolean
)

data class DriverAlert(
    val id: String,
    val severity: String,
    val message: String,
    val created_at: String
)

data class AckResponse(
    val acknowledged: Boolean
)

data class DriverConfig(
    val sampling_rate_seconds: Int,
    val upload_interval_seconds: Int
)

data class PairingClaimRequest(
    val pairingCode: String,
    val driverPin: String,
    val deviceId: String,
    val deviceLabel: String
)

data class PairingClaimResponse(
    val vehicleId: String,
    val driverId: String,
    val status: String,
    val assignmentId: String? = null,
    val deviceId: String? = null,
    val deviceLabel: String? = null,
    // Device session token, returned once on a successful claim. ApiClient
    // sends it as `Authorization: Bearer` on every later request; telemetry
    // ingest and vehicle reads now require it.
    val deviceToken: String? = null
)

data class TelemetryIngestRequest(
    val batchId: String,
    val vehicleId: String,
    val driverId: String?,
    val deviceId: String,
    val orgId: String? = null,
    val protocol: String = "OBD2",
    val timestamp: String,
    val metrics: Map<String, Any?>,
    val frames: List<CanFrameDto> = emptyList(),
    val dtc: TelemetryDtcDto = TelemetryDtcDto(),
    val meta: Map<String, Any?> = emptyMap(),
    val adapter: TelemetryAdapterDto? = null,
    val derivedMetrics: Map<String, Any?> = emptyMap(),
    val obdConnected: Boolean = true,
    val lastObdPacketAt: String = timestamp
)

data class TelemetryDtcDto(
    val active: List<String> = emptyList(),
    val pending: List<String> = emptyList()
)

data class CanFrameDto(
    val id: Long,
    val data: List<Int>,
    val timestamp: String,
    val extended: Boolean = true,
    val priority: Int? = null,
    val pgn: Int? = null,
    val sourceAddress: Int? = null,
    val destinationAddress: Int? = null
)

data class TelemetryAdapterDto(
    val transport: String,
    val protocol: String,
    val manufacturer: String,
    val product: String,
    val serialNumber: String? = null,
    val listenOnly: Boolean = true,
    val bitrate: Int = 250000,
    val connectorProfile: String = "UNKNOWN"
)
