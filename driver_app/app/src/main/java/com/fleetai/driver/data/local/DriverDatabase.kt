package com.fleetai.driver.data.local

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase

@Database(
    entities = [HosEventEntity::class, NotificationEntity::class, VehicleEntity::class, TelemetryOutboxEntity::class],
    version = 3,
    exportSchema = false
)
abstract class DriverDatabase : RoomDatabase() {
    abstract fun hosDao(): HosDao
    abstract fun notificationDao(): NotificationDao
    abstract fun vehicleDao(): VehicleDao
    abstract fun telemetryOutboxDao(): TelemetryOutboxDao

    companion object {
        fun create(context: Context): DriverDatabase {
            return Room.databaseBuilder(
                context,
                DriverDatabase::class.java,
                "fleet_driver.db"
            ).addMigrations(MIGRATION_2_3).build()
        }

        private val MIGRATION_2_3 = object : Migration(2, 3) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL(
                    """CREATE TABLE IF NOT EXISTS telemetry_outbox (
                        id TEXT NOT NULL PRIMARY KEY,
                        payloadJson TEXT NOT NULL,
                        createdAtEpochMs INTEGER NOT NULL,
                        nextAttemptEpochMs INTEGER NOT NULL,
                        attemptCount INTEGER NOT NULL,
                        lastError TEXT NOT NULL
                    )""".trimIndent()
                )
                db.execSQL("CREATE INDEX IF NOT EXISTS index_telemetry_outbox_nextAttemptEpochMs ON telemetry_outbox(nextAttemptEpochMs)")
            }
        }
    }
}
