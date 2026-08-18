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
    val id: String = "",
    val status: String = "",
    val notes: String = "",
    val timestamp: String = "",
    val recordStatus: Int = 1,
    val recordOrigin: Int = 1,
    val certified: Boolean = false
)

data class HosLogResponse(
    val events: List<HosLogEventDto>
)

data class EldDeviceStateDto(
    val currentDutyCode: Int? = null,
    val specialDrivingCode: Int? = null,
    val vehicleMoving: Boolean = false,
    val ignitionOn: Boolean = false,
    val lastTelemetryAt: String? = null,
    val lastRecordAt: String? = null,
    val lastEngineSyncAt: String? = null,
    val lastPositionAt: String? = null,
    val unidentifiedDrivingMinutes: Int = 0
)

data class EldDiagnosticDto(
    val kind: String = "",
    val code: String = "",
    val status: String = ""
)

data class EldDeviceStatusResponse(
    val ok: Boolean = false,
    val enabled: Boolean = false,
    val productionAuthorized: Boolean = false,
    val driverLoggedIn: Boolean = false,
    val state: EldDeviceStateDto? = null,
    val carrierConfigured: Boolean = false,
    val driverConfigured: Boolean = false,
    val activeDiagnostics: List<EldDiagnosticDto> = emptyList()
)

data class EldCertificationRequest(
    val recordDate: String,
    val annotation: String = "Driver certification"
)

data class EldHosStatusResponse(
    val ok: Boolean = false,
    val ruleProfile: String = "",
    val ruleLabel: String = "",
    val sufficientHistory: Boolean = false,
    val currentDutyCode: Int? = null,
    val driveRemainingMinutes: Int? = null,
    val windowRemainingMinutes: Int? = null,
    val breakRemainingMinutes: Int? = null,
    val cycleRemainingMinutes: Int? = null,
    val requiredRestMinutes: Int = 600,
    val drivingProhibitedReasons: List<String> = emptyList(),
    val violations: List<String> = emptyList(),
    val warnings: List<String> = emptyList()
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
