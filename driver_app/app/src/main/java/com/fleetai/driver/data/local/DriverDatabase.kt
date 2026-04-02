package com.fleetai.driver.data.local

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase

@Database(
    entities = [HosEventEntity::class, NotificationEntity::class, VehicleEntity::class],
    version = 2,
    exportSchema = false
)
abstract class DriverDatabase : RoomDatabase() {
    abstract fun hosDao(): HosDao
    abstract fun notificationDao(): NotificationDao
    abstract fun vehicleDao(): VehicleDao

    companion object {
        fun create(context: Context): DriverDatabase {
            return Room.databaseBuilder(
                context,
                DriverDatabase::class.java,
                "fleet_driver.db"
            ).build()
        }
    }
}
