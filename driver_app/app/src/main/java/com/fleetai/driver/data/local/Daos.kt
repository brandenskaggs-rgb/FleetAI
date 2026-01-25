package com.fleetai.driver.data.local

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query

@Dao
interface HosDao {
    @Query("SELECT * FROM hos_events WHERE tenantId = :tenantId AND eventDate = :date ORDER BY startTime DESC")
    suspend fun getEventsByDate(tenantId: String, date: String): List<HosEventEntity>

    @Query("SELECT * FROM hos_events WHERE synced = 0")
    suspend fun getPendingEvents(): List<HosEventEntity>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertEvent(event: HosEventEntity)

    @Query("UPDATE hos_events SET synced = 1 WHERE id = :eventId")
    suspend fun markSynced(eventId: String)
}

@Dao
interface NotificationDao {
    @Query("SELECT * FROM notifications WHERE tenantId = :tenantId ORDER BY timestamp DESC")
    suspend fun getNotifications(tenantId: String): List<NotificationEntity>

    @Query("SELECT * FROM notifications WHERE synced = 0")
    suspend fun getPendingNotifications(): List<NotificationEntity>

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
