package com.fleetai.driver.data.local

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query

@Dao
interface HosDao {
    @Query("SELECT * FROM hos_events WHERE tenantId = :tenantId AND driverId = :driverId AND eventDate = :date ORDER BY startTime DESC")
    suspend fun getEventsByDate(tenantId: String, driverId: String, date: String): List<HosEventEntity>

    @Query("SELECT * FROM hos_events WHERE tenantId = :tenantId AND vehicleId = :vehicleId AND driverId = :driverId AND synced = 0")
    suspend fun getPendingEvents(tenantId: String, vehicleId: String, driverId: String): List<HosEventEntity>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertEvent(event: HosEventEntity)

    @Query("UPDATE hos_events SET synced = 1 WHERE id = :eventId")
    suspend fun markSynced(eventId: String)
}

@Dao
interface NotificationDao {
    @Query("SELECT * FROM notifications WHERE tenantId = :tenantId AND driverId = :driverId ORDER BY timestamp DESC")
    suspend fun getNotifications(tenantId: String, driverId: String): List<NotificationEntity>

    @Query("SELECT * FROM notifications WHERE tenantId = :tenantId AND vehicleId = :vehicleId AND driverId = :driverId AND synced = 0")
    suspend fun getPendingNotifications(tenantId: String, vehicleId: String, driverId: String): List<NotificationEntity>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertNotification(notification: NotificationEntity)

    @Query("UPDATE notifications SET read = 1 WHERE id = :notificationId")
    suspend fun markRead(notificationId: String)

    @Query("UPDATE notifications SET synced = 1 WHERE id = :notificationId")
    suspend fun markSynced(notificationId: String)
}

@Dao
interface VehicleDao {
    @Query("SELECT * FROM vehicles WHERE tenantId = :tenantId ORDER BY unitNumber")
    suspend fun getVehicles(tenantId: String): List<VehicleEntity>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertVehicles(vehicles: List<VehicleEntity>)

    @Query("DELETE FROM vehicles WHERE tenantId = :tenantId")
    suspend fun clearVehicles(tenantId: String)
}

@Dao
interface TelemetryOutboxDao {
    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun insert(item: TelemetryOutboxEntity): Long

    @Query("SELECT * FROM telemetry_outbox WHERE tenantId = :tenantId AND vehicleId = :vehicleId AND nextAttemptEpochMs <= :now ORDER BY createdAtEpochMs DESC LIMIT :limit")
    suspend fun pendingNewest(tenantId: String, vehicleId: String, now: Long, limit: Int): List<TelemetryOutboxEntity>

    @Query("SELECT * FROM telemetry_outbox WHERE tenantId = :tenantId AND vehicleId = :vehicleId AND nextAttemptEpochMs <= :now ORDER BY createdAtEpochMs ASC LIMIT :limit")
    suspend fun pendingOldest(tenantId: String, vehicleId: String, now: Long, limit: Int): List<TelemetryOutboxEntity>

    @Query("DELETE FROM telemetry_outbox WHERE tenantId = '' OR vehicleId = ''")
    suspend fun deleteUnscoped(): Int

    @Query("DELETE FROM telemetry_outbox WHERE id = :id")
    suspend fun delete(id: String)

    @Query("UPDATE telemetry_outbox SET attemptCount = :attempts, nextAttemptEpochMs = :nextAttempt, lastError = :error WHERE id = :id")
    suspend fun markFailed(id: String, attempts: Int, nextAttempt: Long, error: String)

    @Query("SELECT COUNT(*) FROM telemetry_outbox WHERE tenantId = :tenantId AND vehicleId = :vehicleId")
    suspend fun count(tenantId: String, vehicleId: String): Int

    @Query("DELETE FROM telemetry_outbox WHERE createdAtEpochMs < :cutoff")
    suspend fun deleteOlderThan(cutoff: Long)

    @Query("DELETE FROM telemetry_outbox WHERE id IN (SELECT id FROM telemetry_outbox ORDER BY createdAtEpochMs DESC LIMIT -1 OFFSET :keepNewest)")
    suspend fun trimToNewest(keepNewest: Int)
}

@Dao
interface DvirDao {
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insert(record: DvirEntity)

    @Query("SELECT * FROM dvir_records WHERE tenantId = :tenantId AND vehicleId = :vehicleId AND driverId = :driverId AND synced = 0 ORDER BY inspectedAt ASC")
    suspend fun getPending(tenantId: String, vehicleId: String, driverId: String): List<DvirEntity>

    @Query("UPDATE dvir_records SET synced = 1 WHERE id = :id AND tenantId = :tenantId")
    suspend fun markSynced(id: String, tenantId: String)
}
