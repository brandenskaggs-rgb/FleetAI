package com.fleetai.driver.data.repository

import com.fleetai.driver.data.model.ComplianceConfig
import com.fleetai.driver.data.model.DriverSession
import com.fleetai.driver.data.model.DtcCode
import com.fleetai.driver.data.model.DutyStatus
import com.fleetai.driver.data.model.EldDeviceStatus
import com.fleetai.driver.data.model.HosEvent
import com.fleetai.driver.data.model.HosClockStatus
import com.fleetai.driver.data.model.NotificationItem
import com.fleetai.driver.data.model.ThemeMode
import com.fleetai.driver.data.model.Vehicle

interface DriverRepository {
    suspend fun login(companyCode: String, driverPin: String): DriverSession
    suspend fun claimPairing(pairingCode: String, driverPin: String, deviceId: String, deviceLabel: String)
    suspend fun getVehicles(tenantId: String): List<Vehicle>
    suspend fun bindVehicle(vehicleId: String): Boolean

    suspend fun addHosEvent(event: HosEvent)
    suspend fun getHosEvents(date: String): List<HosEvent>

    suspend fun addNotification(notification: NotificationItem)
    suspend fun getNotifications(): List<NotificationItem>
    suspend fun markNotificationRead(notificationId: String)

    suspend fun getComplianceConfig(): ComplianceConfig
    suspend fun getEldDeviceStatus(): EldDeviceStatus
    suspend fun getEldHosStatus(): HosClockStatus
    suspend fun recordEldLogin()
    suspend fun recordEldLogout()
    suspend fun certifyEldRecords(recordDate: String)
    suspend fun updateDutyStatus(status: DutyStatus, notes: String)
    suspend fun notifyFleet(message: String)

    suspend fun getDiagnosticCodes(): List<DtcCode>
    suspend fun clearDiagnosticCodes(): Boolean

    suspend fun setThemeMode(mode: ThemeMode)
    suspend fun setDemoMode(enabled: Boolean)

    suspend fun syncPending()
}
