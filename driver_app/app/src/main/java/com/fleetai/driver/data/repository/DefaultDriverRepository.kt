package com.fleetai.driver.data.repository

import com.fleetai.driver.data.local.AppPreferences
import com.fleetai.driver.data.local.HosDao
import com.fleetai.driver.data.local.DvirDao
import com.fleetai.driver.data.local.DvirEntity
import com.fleetai.driver.data.local.HosEventEntity
import com.fleetai.driver.data.local.NotificationDao
import com.fleetai.driver.data.local.NotificationEntity
import com.fleetai.driver.data.local.VehicleDao
import com.fleetai.driver.data.local.VehicleEntity
import com.fleetai.driver.data.model.ComplianceConfig
import com.fleetai.driver.data.model.DriverSession
import com.fleetai.driver.data.model.DtcCode
import com.fleetai.driver.data.model.DvirRecord
import com.fleetai.driver.data.model.DutyStatus
import com.fleetai.driver.data.model.EldDeviceStatus
import com.fleetai.driver.data.model.HosEvent
import com.fleetai.driver.data.model.LogbookRules
import com.fleetai.driver.data.model.LogbookSnapshot
import com.fleetai.driver.data.model.HosClockStatus
import com.fleetai.driver.data.model.NotificationItem
import com.fleetai.driver.data.model.ThemeMode
import com.fleetai.driver.data.model.Vehicle
import com.fleetai.driver.network.AlertRequest
import com.fleetai.driver.network.ApiService
import com.fleetai.driver.network.DriverLogRequest
import com.fleetai.driver.network.DvirSubmitRequest
import com.fleetai.driver.network.EldCertificationRequest
import com.fleetai.driver.network.MockApiService
import com.fleetai.driver.network.SelectVehicleRequest
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.CancellationException
import retrofit2.HttpException
import java.time.Instant
import java.util.UUID
import org.json.JSONArray

private fun dutyStatusApiValue(value: String): String = when (value.trim().uppercase()) {
    "OFF", "OFF_DUTY" -> "OFF_DUTY"
    "ON", "ON_DUTY" -> "ON_DUTY"
    "DRIVING" -> "DRIVING"
    "SLEEPER" -> "SLEEPER"
    "YARD_MOVE" -> "YARD_MOVE"
    "PERSONAL_CONVEYANCE" -> "PERSONAL_CONVEYANCE"
    else -> value.trim().uppercase()
}

class DefaultDriverRepository(
    private val api: ApiService,
    private val mockApi: MockApiService,
    private val preferences: AppPreferences,
    private val hosDao: HosDao,
    private val notificationDao: NotificationDao,
    private val vehicleDao: VehicleDao,
    private val dvirDao: DvirDao
) : DriverRepository {
    override suspend fun login(companyCode: String, driverPin: String): DriverSession {
        val useMock = preferences.trainingSession.first()
        check(!useMock) { "Exit training demo before signing in to a fleet." }
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

    override suspend fun claimPairing(pairingCode: String, driverPin: String, deviceId: String, deviceLabel: String) {
        val useMock = preferences.trainingSession.first()
        check(!useMock) { "Exit training demo before pairing with a fleet." }
        val response = if (useMock) {
            mockApi.claimPairing(pairingCode, driverPin, deviceId, deviceLabel)
        } else {
            try {
                api.claimPairing(
                    com.fleetai.driver.network.PairingClaimRequest(
                        pairingCode = pairingCode,
                        driverPin = driverPin,
                        deviceId = deviceId,
                        deviceLabel = deviceLabel
                    )
                )
            } catch (ex: HttpException) {
                val errorBody = ex.response()?.errorBody()?.string().orEmpty()
                when (ex.code()) {
                    400 -> throw IllegalArgumentException("invalid_request")
                    401 -> {
                        if (errorBody.contains("PIN_REQUIRED", ignoreCase = true)) {
                            throw IllegalArgumentException("pin_required")
                        }
                        throw IllegalArgumentException("invalid_pin")
                    }
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
        val token = response.deviceToken?.takeIf { it.isNotBlank() }
            ?: throw IllegalStateException("pairing_response_missing_token")
        val tenantId = response.tenantId.ifBlank { response.orgId }
        if (response.vehicleId.isBlank() || response.driverId.isBlank() || tenantId.isBlank()) {
            throw IllegalStateException("pairing_response_incomplete")
        }
        // Claim is the tablet's authentication bootstrap. Persist the entire
        // assignment in one DataStore edit so the UI never observes a token
        // without its driver/vehicle scope (or vice versa).
        preferences.saveClaimedSession(
            tenantId = tenantId,
            driverId = response.driverId,
            driverName = response.driverName.ifBlank { response.driverId },
            vehicleId = response.vehicleId,
            assignmentId = response.assignmentId,
            token = token
        )
    }

    override suspend fun getVehicles(tenantId: String): List<Vehicle> {
        val useMock = preferences.trainingSession.first()
        val vehicles = if (useMock) {
            mockApi.getVehicles(tenantId).vehicles
        } else {
            api.getVehicles(tenantId).vehicles
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
        val useMock = preferences.trainingSession.first()
        return try {
            if (!useMock) {
                api.selectVehicle(SelectVehicleRequest(vehicleId))
            }
            preferences.saveVehicle(vehicleId)
            true
        } catch (_: Exception) {
            false
        }
    }

    override suspend fun addHosEvent(event: HosEvent) {
        val training = preferences.trainingSession.first()
        if (training) requireTrainingScope(event.tenantId, event.driverId, event.vehicleId)
        val entity = HosEventEntity(
            id = event.id,
            tenantId = event.tenantId,
            vehicleId = event.vehicleId,
            driverId = event.driverId,
            status = event.status.name,
            notes = event.notes,
            startTime = event.startTime,
            endTime = event.endTime,
            eventDate = event.eventDate,
            synced = training
        )
        hosDao.insertEvent(entity)
        if (training) return
        try {
            val response = api.postHosLog(
                DriverLogRequest(
                    clientEventId = event.id,
                    date = event.eventDate,
                    startTime = event.startTime,
                    endTime = event.endTime,
                    dutyStatus = dutyStatusApiValue(event.status.name),
                    notes = event.notes
                )
            )
            check(response.success) { "Log upload was not acknowledged" }
            hosDao.markSynced(event.id)
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            // The durable row remains pending; the log screen must show it.
        }
    }

    override suspend fun getHosEvents(date: String): List<HosEvent> = getLogbook(date).events

    override suspend fun getLogbook(date: String): LogbookSnapshot {
        val tenantId = preferences.tenantId.first()
        val vehicleId = preferences.vehicleId.first()
        val driverId = preferences.driverId.first()
        check(tenantId.isNotBlank() && driverId.isNotBlank()) { "Driver login required" }
        var unreadable = 0
        val localEvents = hosDao.getEventsByDate(tenantId, driverId, date).mapNotNull {
            val status = LogbookRules.dutyStatus(it.status)
            if (status == null) { unreadable++; return@mapNotNull null }
            HosEvent(
                id = it.id,
                tenantId = it.tenantId,
                vehicleId = it.vehicleId,
                driverId = it.driverId,
                status = status,
                notes = it.notes,
                startTime = it.startTime,
                endTime = it.endTime,
                eventDate = it.eventDate,
                pendingUpload = !it.synced
            )
        }
        if (preferences.trainingSession.first()) return LogbookSnapshot(localEvents, offline = true, unreadable)
        return try {
            val remoteEvents = api.getHosLogs(date).events.filter { it.recordStatus == 1 }.mapNotNull { event ->
                val status = LogbookRules.dutyStatus(event.status)
                if (status == null) { unreadable++; return@mapNotNull null }
                HosEvent(
                    id = event.id.ifBlank { "remote-${event.timestamp}-${event.status}" },
                    tenantId = tenantId,
                    vehicleId = vehicleId,
                    driverId = driverId,
                    status = status,
                    notes = event.notes,
                    startTime = event.timestamp,
                    endTime = event.timestamp,
                    eventDate = date
                )
            }
            LogbookSnapshot(LogbookRules.visibleEvents(remoteEvents, localEvents, offline = false), false, unreadable)
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            LogbookSnapshot(LogbookRules.visibleEvents(emptyList(), localEvents, offline = true), true, unreadable)
        }
    }

    override suspend fun submitInspection(record: DvirRecord): Boolean {
        val training = preferences.trainingSession.first()
        if (training) requireTrainingScope(record.tenantId, record.driverId, record.vehicleId)
        val entity = DvirEntity(
            id = record.id,
            tenantId = record.tenantId,
            vehicleId = record.vehicleId,
            driverId = record.driverId,
            type = record.type,
            odometer = record.odometer,
            inspectedItemsJson = JSONArray(record.inspectedItems).toString(),
            defects = record.defects,
            signature = record.signature,
            inspectedAt = record.inspectedAt,
            synced = training
        )
        dvirDao.insert(entity)
        if (training) return true
        return try {
            api.submitDvir(entity.toRequest())
            dvirDao.markSynced(entity.id, entity.tenantId)
            true
        } catch (_: Exception) {
            false
        }
    }

    override suspend fun addNotification(notification: NotificationItem) {
        val training = preferences.trainingSession.first()
        if (training) requireTrainingScope(notification.tenantId, notification.driverId, notification.vehicleId)
        val entity = NotificationEntity(
            id = notification.id,
            tenantId = notification.tenantId,
            vehicleId = notification.vehicleId,
            driverId = notification.driverId,
            title = notification.title,
            message = notification.message,
            severity = notification.severity,
            timestamp = notification.timestamp,
            read = notification.read,
            synced = training
        )
        notificationDao.insertNotification(entity)
        if (training) return
        try {
            api.postAlert(
                AlertRequest(
                    clientAlertId = notification.id,
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
        val driverId = preferences.driverId.first()
        return notificationDao.getNotifications(tenantId, driverId).map {
            NotificationItem(
                id = it.id,
                tenantId = it.tenantId,
                vehicleId = it.vehicleId,
                driverId = it.driverId,
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

    override suspend fun getEldDeviceStatus(): EldDeviceStatus {
        if (preferences.trainingSession.first()) {
            val local = hosDao.latestEvent("DEMO", "DEMO_DRIVER", "DEMO_VEHICLE")
            return EldDeviceStatus(
                enabled = false, productionAuthorized = false, driverLoggedIn = true,
                carrierConfigured = false, driverConfigured = false,
                dutyStatus = local?.let { LogbookRules.dutyStatus(it.status) } ?: DutyStatus.OFF,
                vehicleMoving = false, lastTelemetryAt = "", activeDiagnosticCount = 0,
                trainingDemo = true
            )
        }
        val response = api.getEldDeviceStatus()
        check(response.ok) { "ELD status not confirmed" }
        var pendingDutyUpload = false
        var dutyStatus = when (response.state?.currentDutyCode) {
            2 -> DutyStatus.SLEEPER
            3 -> DutyStatus.DRIVING
            4 -> DutyStatus.ON
            else -> DutyStatus.OFF
        }
        // Disabled ELD has no authoritative duty state. Read the separate pilot activity history.
        if (!response.enabled) {
            val tenantId = preferences.tenantId.first()
            val driverId = preferences.driverId.first()
            val vehicleId = preferences.vehicleId.first()
            check(tenantId.isNotBlank() && driverId.isNotBlank() && vehicleId.isNotBlank())
            val local = hosDao.latestEvent(tenantId, driverId, vehicleId)
            val remote = api.getHosLogs("").events
                .filter { it.recordStatus == 1 && LogbookRules.dutyStatus(it.status) != null }
                .maxByOrNull { runCatching { Instant.parse(it.timestamp) }.getOrDefault(Instant.MIN) }
            val localAt = runCatching { Instant.parse(local?.startTime) }.getOrDefault(Instant.MIN)
            val remoteAt = runCatching { Instant.parse(remote?.timestamp) }.getOrDefault(Instant.MIN)
            if (local != null && localAt >= remoteAt) {
                dutyStatus = LogbookRules.dutyStatus(local.status) ?: dutyStatus
                pendingDutyUpload = !local.synced
            } else {
                dutyStatus = remote?.let { LogbookRules.dutyStatus(it.status) } ?: dutyStatus
            }
        }
        return EldDeviceStatus(
            enabled = response.enabled,
            productionAuthorized = response.productionAuthorized,
            driverLoggedIn = response.driverLoggedIn,
            carrierConfigured = response.carrierConfigured,
            driverConfigured = response.driverConfigured,
            dutyStatus = dutyStatus,
            vehicleMoving = response.enabled && response.state?.vehicleMoving == true,
            lastTelemetryAt = response.state?.lastTelemetryAt.orEmpty(),
            activeDiagnosticCount = response.activeDiagnostics.size,
            pendingDutyUpload = pendingDutyUpload
        )
    }

    override suspend fun getEldHosStatus(): HosClockStatus {
        check(!preferences.trainingSession.first()) { "Training demo does not calculate legal driving availability." }
        val response = api.getEldHosStatus()
        return HosClockStatus(
            ruleLabel = response.ruleLabel,
            sufficientHistory = response.sufficientHistory,
            driveRemainingMinutes = response.driveRemainingMinutes,
            windowRemainingMinutes = response.windowRemainingMinutes,
            breakRemainingMinutes = response.breakRemainingMinutes,
            cycleRemainingMinutes = response.cycleRemainingMinutes,
            drivingProhibitedReasons = response.drivingProhibitedReasons,
            violations = response.violations,
            warnings = response.warnings
        )
    }

    override suspend fun recordEldLogin() {
        if (preferences.trainingSession.first()) return
        api.recordEldLogin()
    }

    override suspend fun recordEldLogout() {
        if (preferences.trainingSession.first()) return
        api.recordEldLogout()
    }

    override suspend fun certifyEldRecords(recordDate: String) {
        check(!preferences.trainingSession.first()) { "Training records cannot be certified as legal ELD records." }
        check(api.certifyEldRecords(EldCertificationRequest(recordDate = recordDate)).success) {
            "Certification was not acknowledged"
        }
    }

    override suspend fun updateDutyStatus(status: DutyStatus, notes: String) {
        val tenantId = preferences.tenantId.first()
        val vehicleId = preferences.vehicleId.first()
        val driverId = preferences.driverId.first()
        if (tenantId.isBlank() || vehicleId.isBlank() || driverId.isBlank()) {
            throw IllegalStateException("session_or_vehicle_missing")
        }
        val timestamp = Instant.now().toString()
        addHosEvent(
            HosEvent(
                id = UUID.randomUUID().toString(),
                tenantId = tenantId,
                vehicleId = vehicleId,
                driverId = driverId,
                status = status,
                notes = notes,
                startTime = timestamp,
                endTime = timestamp,
                eventDate = java.time.LocalDate.now().toString()
            )
        )
    }

    override suspend fun notifyFleet(message: String) {
        val tenantId = preferences.tenantId.first()
        val vehicleId = preferences.vehicleId.first()
        val driverId = preferences.driverId.first()
        if (tenantId.isBlank() || vehicleId.isBlank() || driverId.isBlank()) {
            throw IllegalStateException("login_required")
        }
        addNotification(
            NotificationItem(
                id = UUID.randomUUID().toString(),
                tenantId = tenantId,
                vehicleId = vehicleId,
                driverId = driverId,
                title = "Driver Update",
                message = message,
                severity = "info",
                timestamp = Instant.now().toString(),
                read = false
            )
        )
    }

    override suspend fun getDiagnosticCodes(): List<DtcCode> {
        val useMock = preferences.trainingSession.first()
        val response = if (useMock) {
            mockApi.getDiagnosticCodes().dtcs
        } else {
            api.getDiagnosticCodes().dtcs
        }
        return response.map { DtcCode(it.code.toString(), it.description, it.severity) }
    }


    override suspend fun setThemeMode(mode: ThemeMode) {
        preferences.setThemeMode(mode)
    }

    override suspend fun setDemoMode(enabled: Boolean) {
        preferences.setDemoMode(enabled)
    }

    override suspend fun syncPending() {
        if (preferences.trainingSession.first()) return
        var hadFailure = false
        val tenantId = preferences.tenantId.first()
        val vehicleId = preferences.vehicleId.first()
        val driverId = preferences.driverId.first()
        if (tenantId.isBlank() || vehicleId.isBlank() || driverId.isBlank()) return

        val pendingEvents = hosDao.getPendingEvents(tenantId, vehicleId, driverId)
        for (event in pendingEvents) {
            try {
                val response = api.postHosLog(
                    DriverLogRequest(
                        clientEventId = event.id,
                        date = event.eventDate,
                        startTime = event.startTime,
                        endTime = event.endTime,
                        dutyStatus = dutyStatusApiValue(event.status),
                        notes = event.notes
                    )
                )
                check(response.success) { "Log upload was not acknowledged" }
                hosDao.markSynced(event.id)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                hadFailure = true
            }
        }

        val pendingNotifications = notificationDao.getPendingNotifications(tenantId, vehicleId, driverId)
        for (notification in pendingNotifications) {
            try {
                api.postAlert(
                    AlertRequest(
                        clientAlertId = notification.id,
                        type = "driver",
                        severity = notification.severity,
                        message = notification.message,
                        vehicleId = notification.vehicleId
                    )
                )
                notificationDao.markSynced(notification.id)
            } catch (_: Exception) {
                hadFailure = true
            }
        }


        val pendingInspections = dvirDao.getPending(tenantId, vehicleId, driverId)
        for (inspection in pendingInspections) {
            try {
                api.submitDvir(inspection.toRequest())
                dvirDao.markSynced(inspection.id, tenantId)
            } catch (_: Exception) {
                hadFailure = true
            }
        }

        if (hadFailure) {
            throw IllegalStateException("sync_pending_failed")
        }
    }

    private fun requireTrainingScope(tenantId: String, driverId: String, vehicleId: String) {
        check(tenantId == "DEMO" && driverId == "DEMO_DRIVER" && vehicleId == "DEMO_VEHICLE") {
            "Training records must use the sample driver and vehicle."
        }
    }

    private fun DvirEntity.toRequest() = DvirSubmitRequest(
        clientRecordId = id,
        type = type,
        odometer = odometer,
        inspectedItems = runCatching {
            val values = JSONArray(inspectedItemsJson)
            List(values.length()) { index -> values.optString(index) }.filter(String::isNotBlank)
        }.getOrDefault(emptyList()),
        defects = defects,
        signature = signature,
        inspectedAt = inspectedAt
    )
}
