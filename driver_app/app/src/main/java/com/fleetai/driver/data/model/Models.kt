package com.fleetai.driver.data.model

enum class DutyStatus {
    OFF,
    ON,
    DRIVING,
    SLEEPER
}

enum class ThemeMode {
    DARK,
    LIGHT
}

data class DriverSession(
    val tenantId: String,
    val driverId: String,
    val token: String,
    val driverName: String
)

data class Vehicle(
    val id: String,
    val unitNumber: String,
    val vin: String,
    val make: String,
    val model: String
)

data class HosEvent(
    val id: String,
    val tenantId: String,
    val vehicleId: String,
    val status: DutyStatus,
    val notes: String,
    val startTime: String,
    val endTime: String,
    val eventDate: String
)

data class NotificationItem(
    val id: String,
    val tenantId: String,
    val vehicleId: String,
    val title: String,
    val message: String,
    val severity: String,
    val timestamp: String,
    val read: Boolean
)

data class DtcCode(
    val code: String,
    val description: String,
    val severity: String
)

data class ComplianceConfig(
    val maxDriveMinutes: Int,
    val maxShiftMinutes: Int,
    val breakMinutesRequired: Int,
    val breakIntervalMinutes: Int
)

data class HomeUiState(
    val dutyStatus: DutyStatus,
    val eldEnabled: Boolean,
    val productionAuthorized: Boolean,
    val carrierConfigured: Boolean,
    val driverConfigured: Boolean,
    val vehicleMoving: Boolean,
    val lastTelemetryAt: String,
    val activeDiagnosticCount: Int,
    val hosRuleLabel: String,
    val hosHistorySufficient: Boolean,
    val driveRemainingMinutes: Int?,
    val windowRemainingMinutes: Int?,
    val breakRemainingMinutes: Int?,
    val cycleRemainingMinutes: Int?,
    val drivingProhibitedReasons: List<String>,
    val hosViolations: List<String>,
    val statusMessage: String,
    val actionInProgress: Boolean
)

data class HosClockStatus(
    val ruleLabel: String,
    val sufficientHistory: Boolean,
    val driveRemainingMinutes: Int?,
    val windowRemainingMinutes: Int?,
    val breakRemainingMinutes: Int?,
    val cycleRemainingMinutes: Int?,
    val drivingProhibitedReasons: List<String>,
    val violations: List<String>,
    val warnings: List<String>
)

data class EldDeviceStatus(
    val enabled: Boolean,
    val productionAuthorized: Boolean,
    val driverLoggedIn: Boolean,
    val carrierConfigured: Boolean,
    val driverConfigured: Boolean,
    val dutyStatus: DutyStatus,
    val vehicleMoving: Boolean,
    val lastTelemetryAt: String,
    val activeDiagnosticCount: Int
)

enum class SensorStatus { LIVE, STALE, UNSUPPORTED }
enum class Trend { UP, DOWN, FLAT }

data class SensorReading(
    val pid: String,
    val label: String,
    val value: String,
    val unit: String,
    val status: SensorStatus,
    val trend: Trend,
    val raw: Double?,
    val smoothed: Double?,
    val lastUpdated: Long
)
