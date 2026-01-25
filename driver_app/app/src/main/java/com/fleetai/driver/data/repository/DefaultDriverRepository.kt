package com.fleetai.driver.data.repository

import com.fleetai.driver.data.local.AppPreferences
import com.fleetai.driver.data.local.HosDao
import com.fleetai.driver.data.local.HosEventEntity
import com.fleetai.driver.data.local.NotificationDao
import com.fleetai.driver.data.local.NotificationEntity
import com.fleetai.driver.data.local.VehicleDao
import com.fleetai.driver.data.local.VehicleEntity
import com.fleetai.driver.data.model.ComplianceConfig
import com.fleetai.driver.data.model.DriverSession
import com.fleetai.driver.data.model.DtcCode
import com.fleetai.driver.data.model.DutyStatus
import com.fleetai.driver.data.model.HosEvent
import com.fleetai.driver.data.model.NotificationItem
import com.fleetai.driver.data.model.ThemeMode
import com.fleetai.driver.data.model.Vehicle
import com.fleetai.driver.network.AlertRequest
import com.fleetai.driver.network.ApiService
import com.fleetai.driver.network.DriverLogRequest
import com.fleetai.driver.network.MockApiService
import com.fleetai.driver.network.SelectVehicleRequest
import com.fleetai.driver.network.PairingClaimResponse
import kotlinx.coroutines.flow.first
import retrofit2.HttpException
import java.time.Instant
import java.util.UUID

class DefaultDriverRepository(
    private val api: ApiService,
    private val mockApi: MockApiService,
    private val preferences: AppPreferences,
    private val hosDao: HosDao,
    private val notificationDao: NotificationDao,
    private val vehicleDao: VehicleDao
) : DriverRepository {
    override suspend fun login(companyCode: String, driverPin: String): DriverSession {
        val useMock = preferences.demoMode.first()
        val response = if (useMock) {
            mockApi.loginDriver(companyCode, driverPin)
        } else {
            try {
                api.loginDriver(com.fleetai.driver.network.LoginRequest(companyCode, driverPin))
            } catch (ex: HttpException) {
                if (ex.code() == 401) {
                    throw IllegalArgumentException("invalid_pin")
                }
                throw ex
            }
        }
        val session = DriverSession(
            tenantId = response.tenantId,
            driverId = response.driverId,
            token = response.token,
            driverName = response.driverName
        )
        preferences.saveSession(session.tenantId, session.driverId, session.token, session.driverName)
        return session
    }

    override suspend fun claimPairing(pairingCode: String, deviceId: String, deviceLabel: String) {
        val useMock = preferences.demoMode.first()
        val response = if (useMock) {
            mockApi.claimPairing(pairingCode, deviceId, deviceLabel)
        } else {
            try {
                api.claimPairing(
                    com.fleetai.driver.network.PairingClaimRequest(
                        pairingCode = pairingCode,
                        deviceId = deviceId,
                        deviceLabel = deviceLabel
                    )
                )
            } catch (ex: HttpException) {
                val errorBody = ex.response()?.errorBody()?.string().orEmpty()
                when (ex.code()) {
                    404 -> throw IllegalArgumentException("invalid_code")
                    409 -> {
                        if (errorBody.contains("ALREADY_CLAIMED", ignoreCase = true)) {
                            throw IllegalStateException("already_claimed")
                        }
                        throw IllegalStateException("conflict")
                    }
                    410 -> throw IllegalStateException("expired_code")
                    else -> throw ex
                }
            }
        }
        preferences.savePairing(response.vehicleId, response.driverId)
        if (response is PairingClaimResponse && response.assignmentId != null) {
            preferences.saveAssignment(response.assignmentId)
        }
    }

    override suspend fun getVehicles(tenantId: String): List<Vehicle> {
        val vehicles = try {
            api.getVehicles(tenantId).vehicles
        } catch (_: Exception) {
            mockApi.getVehicles(tenantId).vehicles
        }
        val entities = vehicles.map {
            VehicleEntity(
                id = it.id,
                tenantId = tenantId,
                unitNumber = it.unitNumber,
                vin = it.vin,
                make = it.make,
                model = it.model
            )
        }
        vehicleDao.clearVehicles(tenantId)
        vehicleDao.insertVehicles(entities)
        return vehicles.map { Vehicle(it.id, it.unitNumber, it.vin, it.make, it.model) }
    }

    override suspend fun bindVehicle(vehicleId: String): Boolean {
        return try {
            api.selectVehicle(SelectVehicleRequest(vehicleId))
            preferences.saveVehicle(vehicleId)
            true
        } catch (_: Exception) {
            preferences.saveVehicle(vehicleId)
            true
        }
    }

    override suspend fun addHosEvent(event: HosEvent) {
        val entity = HosEventEntity(
            id = event.id,
            tenantId = event.tenantId,
            vehicleId = event.vehicleId,
            status = event.status.name,
            notes = event.notes,
            startTime = event.startTime,
            endTime = event.endTime,
            eventDate = event.eventDate,
            synced = false
        )
        hosDao.insertEvent(entity)
        try {
            api.postHosLog(
                DriverLogRequest(
                    date = event.eventDate,
                    startTime = event.startTime,
                    endTime = event.endTime,
                    dutyStatus = event.status.name,
                    notes = event.notes
                )
            )
            hosDao.markSynced(event.id)
        } catch (_: Exception) {
        }
    }

    override suspend fun getHosEvents(date: String): List<HosEvent> {
        val tenantId = preferences.tenantId.first()
        return hosDao.getEventsByDate(tenantId, date).map {
            HosEvent(
                id = it.id,
                tenantId = it.tenantId,
                vehicleId = it.vehicleId,
                status = DutyStatus.valueOf(it.status),
                notes = it.notes,
                startTime = it.startTime,
                endTime = it.endTime,
                eventDate = it.eventDate
            )
        }
    }

    override suspend fun addNotification(notification: NotificationItem) {
        val entity = NotificationEntity(
            id = notification.id,
            tenantId = notification.tenantId,
            vehicleId = notification.vehicleId,
            title = notification.title,
            message = notification.message,
            severity = notification.severity,
            timestamp = notification.timestamp,
            read = notification.read,
            synced = false
        )
        notificationDao.insertNotification(entity)
        try {
            api.postAlert(
                AlertRequest(
                    type = "driver",
                    severity = notification.severity,
                    message = notification.message,
                    vehicleId = notification.vehicleId
                )
            )
            notificationDao.markSynced(notification.id)
        } catch (_: Exception) {
        }
    }

    override suspend fun getNotifications(): List<NotificationItem> {
        val tenantId = preferences.tenantId.first()
        return notificationDao.getNotifications(tenantId).map {
            NotificationItem(
                id = it.id,
                tenantId = it.tenantId,
                vehicleId = it.vehicleId,
                title = it.title,
                message = it.message,
                severity = it.severity,
                timestamp = it.timestamp,
                read = it.read
            )
        }
    }

    override suspend fun markNotificationRead(notificationId: String) {
        notificationDao.markRead(notificationId)
    }

    override suspend fun getComplianceConfig(): ComplianceConfig {
        return ComplianceConfig(
            maxDriveMinutes = 11 * 60,
            maxShiftMinutes = 14 * 60,
            breakMinutesRequired = 30,
            breakIntervalMinutes = 8 * 60
        )
    }

    override suspend fun updateDutyStatus(status: DutyStatus, notes: String) {
        val tenantId = preferences.tenantId.first()
        val vehicleId = preferences.vehicleId.first()
        if (tenantId.isBlank() || vehicleId.isBlank()) {
            return
        }
        val timestamp = Instant.now().toString()
        addHosEvent(
            HosEvent(
                id = UUID.randomUUID().toString(),
                tenantId = tenantId,
                vehicleId = vehicleId,
                status = status,
                notes = notes,
                startTime = timestamp,
                endTime = timestamp,
                eventDate = timestamp.substringBefore('T')
            )
        )
    }

    override suspend fun notifyFleet(message: String) {
        val vehicleId = preferences.vehicleId.first()
        try {
            api.postAlert(
                AlertRequest(
                    type = "driver",
                    severity = "info",
                    message = message,
                    vehicleId = vehicleId
                )
            )
        } catch (_: Exception) {
        }
    }

    override suspend fun getDiagnosticCodes(): List<DtcCode> {
        val response = try  {
            api.getDiagnosticCodes().dtcs
        } catch (_: Exception) {
            mockApi.getDiagnosticCodes().dtcs
        }
        return response.map { DtcCode(it.code.toString(), it.description, it.severity) }
    }

    override suspend fun clearDiagnosticCodes(): Boolean {
        return true
    }

    override suspend fun setThemeMode(mode: ThemeMode) {
        preferences.setThemeMode(mode)
    }

    override suspend fun setDemoMode(enabled: Boolean) {
        preferences.setDemoMode(enabled)
    }

    override suspend fun syncPending() {
        val pendingEvents = hosDao.getPendingEvents()
        for (event in pendingEvents) {
            try {
                api.postHosLog(
                    DriverLogRequest(
                        date = event.eventDate,
                        startTime = event.startTime,
                        endTime = event.endTime,
                        dutyStatus = event.status,
                        notes = event.notes
                    )
                )
                hosDao.markSynced(event.id)
            } catch (_: Exception) {
            }
        }

        val pendingNotifications = notificationDao.getPendingNotifications()
        for (notification in pendingNotifications) {
            try {
                api.postAlert(
                    AlertRequest(
                        type = "driver",
                        severity = notification.severity,
                        message = notification.message,
                        vehicleId = notification.vehicleId
                    )
                )
                notificationDao.markSynced(notification.id)
            } catch (_: Exception) {
            }
        }
    }
}
