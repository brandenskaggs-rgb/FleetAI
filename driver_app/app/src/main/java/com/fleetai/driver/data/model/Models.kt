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
    val remainingDriveMinutes: Int,
    val remainingShiftMinutes: Int,
    val breakMinutesRemaining: Int,
    val complianceWarning: String,
    val complianceBlocked: Boolean,
    val needsAcknowledgement: Boolean
)

data class SensorReading(
    val label: String,
    val value: String,
    val unit: String
)
