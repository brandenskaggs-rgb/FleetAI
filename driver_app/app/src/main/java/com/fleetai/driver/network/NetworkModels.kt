package com.fleetai.driver.network

data class LoginRequest(
    val companyCode: String,
    val driverPin: String
)

data class LoginResponse(
    val tenantId: String,
    val driverId: String,
    val token: String,
    val driverName: String
)

data class DriverProfileResponse(
    val tenantId: String,
    val driverId: String,
    val driverName: String
)

data class VehicleDto(
    val id: String,
    val unitNumber: String,
    val vin: String,
    val make: String,
    val model: String
)

data class VehicleListResponse(
    val vehicles: List<VehicleDto>
)

data class SelectVehicleRequest(
    val vehicleId: String
)

data class DriverLogRequest(
    val date: String,
    val startTime: String,
    val endTime: String,
    val dutyStatus: String,
    val notes: String
)

data class HosLogEventDto(
    val status: String,
    val notes: String,
    val timestamp: String
)

data class HosLogResponse(
    val events: List<HosLogEventDto>
)

data class TelemetrySnapshotRequest(
    val vehicleId: String,
    val timestamp: String,
    val odometer: Double?,
    val dtcs: List<String>?,
    val pids: TelemetryPidBlock
)

data class TelemetryPidBlock(
    val coolantTemp: Double?,
    val rpm: Double?,
    val speed: Double?,
    val oilTemp: Double?,
    val voltage: Double?,
    val fuelLevel: Double?
)

data class AlertRequest(
    val type: String,
    val severity: String,
    val message: String,
    val vehicleId: String?
)

data class DtcDto(
    val code: String,
    val description: String,
    val severity: String
)

data class DtcResponse(
    val dtcs: List<DtcDto>
)

data class BasicResponse(
    val success: Boolean
)
