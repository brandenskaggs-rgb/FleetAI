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
    val vehicleId: String,
    val driverId: String?,
    val deviceId: String,
    val orgId: String? = null,
    val protocol: String = "OBD2",
    val timestamp: String,
    val metrics: Map<String, Any?>,
    val derivedMetrics: Map<String, Any?> = emptyMap(),
    val obdConnected: Boolean = true,
    val lastObdPacketAt: String = timestamp
)
