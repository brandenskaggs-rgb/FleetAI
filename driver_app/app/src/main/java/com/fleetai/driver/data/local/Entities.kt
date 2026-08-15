package com.fleetai.driver.data.local

import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey

@Entity(tableName = "hos_events")
data class HosEventEntity(
    @PrimaryKey val id: String,
    val tenantId: String,
    val vehicleId: String,
    val status: String,
    val notes: String,
    val startTime: String,
    val endTime: String,
    val eventDate: String,
    val synced: Boolean
)

@Entity(tableName = "notifications")
data class NotificationEntity(
    @PrimaryKey val id: String,
    val tenantId: String,
    val vehicleId: String,
    val title: String,
    val message: String,
    val severity: String,
    val timestamp: String,
    val read: Boolean,
    val synced: Boolean
)

@Entity(tableName = "vehicles")
data class VehicleEntity(
    @PrimaryKey val id: String,
    val tenantId: String,
    val unitNumber: String,
    val vin: String,
    val make: String,
    val model: String
)

@Entity(tableName = "telemetry_outbox", indices = [Index("nextAttemptEpochMs")])
data class TelemetryOutboxEntity(
    @PrimaryKey val id: String,
    val payloadJson: String,
    val createdAtEpochMs: Long,
    val nextAttemptEpochMs: Long,
    val attemptCount: Int,
    val lastError: String
)
