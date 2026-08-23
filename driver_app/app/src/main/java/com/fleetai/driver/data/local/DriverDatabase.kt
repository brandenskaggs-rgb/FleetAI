package com.fleetai.driver.data.local

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase

@Database(
    entities = [
        HosEventEntity::class,
        NotificationEntity::class,
        VehicleEntity::class,
        TelemetryOutboxEntity::class,
        DvirEntity::class
    ],
    version = 4,
    exportSchema = false
)
abstract class DriverDatabase : RoomDatabase() {
    abstract fun hosDao(): HosDao
    abstract fun notificationDao(): NotificationDao
    abstract fun vehicleDao(): VehicleDao
    abstract fun telemetryOutboxDao(): TelemetryOutboxDao
    abstract fun dvirDao(): DvirDao

    companion object {
        fun create(context: Context): DriverDatabase {
            return Room.databaseBuilder(
                context,
                DriverDatabase::class.java,
                "fleet_driver.db"
            ).addMigrations(MIGRATION_2_3, MIGRATION_3_4).build()
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

        private val MIGRATION_3_4 = object : Migration(3, 4) {
            override fun migrate(db: SupportSQLiteDatabase) {
                // Version 3 outbox rows have no tenant identity and cannot be
                // uploaded safely after a device is re-paired.
                db.execSQL("ALTER TABLE telemetry_outbox ADD COLUMN tenantId TEXT NOT NULL DEFAULT ''")
                db.execSQL("ALTER TABLE telemetry_outbox ADD COLUMN vehicleId TEXT NOT NULL DEFAULT ''")
                db.execSQL("ALTER TABLE hos_events ADD COLUMN driverId TEXT NOT NULL DEFAULT ''")
                db.execSQL("ALTER TABLE notifications ADD COLUMN driverId TEXT NOT NULL DEFAULT ''")
                db.execSQL(
                    "CREATE INDEX IF NOT EXISTS index_telemetry_outbox_tenantId_vehicleId_nextAttemptEpochMs " +
                        "ON telemetry_outbox(tenantId, vehicleId, nextAttemptEpochMs)"
                )
                db.execSQL(
                    """CREATE TABLE IF NOT EXISTS dvir_records (
                        id TEXT NOT NULL PRIMARY KEY,
                        tenantId TEXT NOT NULL,
                        vehicleId TEXT NOT NULL,
                        driverId TEXT NOT NULL,
                        type TEXT NOT NULL,
                        odometer INTEGER NOT NULL,
                        inspectedItemsJson TEXT NOT NULL,
                        defects TEXT NOT NULL,
                        signature TEXT NOT NULL,
                        inspectedAt TEXT NOT NULL,
                        synced INTEGER NOT NULL
                    )""".trimIndent()
                )
                db.execSQL("CREATE INDEX IF NOT EXISTS index_dvir_records_tenantId_synced ON dvir_records(tenantId, synced)")
            }
        }
    }
}
