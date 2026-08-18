package com.fleetai.driver.ui.viewmodel

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.fleetai.driver.data.model.DutyStatus
import com.fleetai.driver.data.model.HomeUiState
import com.fleetai.driver.data.repository.DriverRepository
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch

class HomeViewModel(
    private val repository: DriverRepository
) : ViewModel() {
    private val _uiState = MutableStateFlow(
        HomeUiState(
            dutyStatus = DutyStatus.OFF,
            eldEnabled = false,
            productionAuthorized = false,
            carrierConfigured = false,
            driverConfigured = false,
            vehicleMoving = false,
            lastTelemetryAt = "",
            activeDiagnosticCount = 0,
            hosRuleLabel = "",
            hosHistorySufficient = false,
            driveRemainingMinutes = null,
            windowRemainingMinutes = null,
            breakRemainingMinutes = null,
            cycleRemainingMinutes = null,
            drivingProhibitedReasons = emptyList(),
            hosViolations = emptyList(),
            statusMessage = "Checking ELD status...",
            actionInProgress = false
        )
    )
    val uiState: StateFlow<HomeUiState> = _uiState

    init {
        viewModelScope.launch {
            while (true) {
                refreshEldStatus()
                delay(5_000)
            }
        }
    }

    fun refresh() {
        viewModelScope.launch { refreshEldStatus() }
    }

    fun takeBreak() = updateStatus(DutyStatus.OFF, "Break")

    fun takeLunch() = updateStatus(DutyStatus.OFF, "Lunch")

    fun endShift() = updateStatus(DutyStatus.OFF, "End shift")

    fun setDutyStatus(status: DutyStatus) {
        if (status == DutyStatus.DRIVING) {
            _uiState.value = _uiState.value.copy(
                statusMessage = "Driving is recorded automatically when vehicle speed reaches 5 mph."
            )
            return
        }
        updateStatus(status, "Driver status update")
    }

    private suspend fun refreshEldStatus() {
        try {
            val status = repository.getEldDeviceStatus()
            if (status.enabled && !status.driverLoggedIn) {
                repository.recordEldLogin()
                delay(250)
                return refreshEldStatus()
            }
            val hos = if (status.enabled) runCatching { repository.getEldHosStatus() }.getOrNull() else null
            val message = when {
                !status.carrierConfigured -> "Carrier ELD setup is incomplete. Contact fleet administration."
                !status.driverConfigured -> "Driver ELD profile is incomplete. Contact fleet administration."
                !status.enabled -> "ELD recording is not enabled for this tablet. Do not use it as the legal log."
                !status.productionAuthorized -> "Shadow mode is active. Keep the carrier's registered ELD in service."
                status.activeDiagnosticCount > 0 -> "ELD is recording with ${status.activeDiagnosticCount} active diagnostic event(s)."
                status.vehicleMoving -> "Vehicle motion detected. Driving time is being recorded automatically."
                else -> "ELD recording is active. Driving begins automatically at 5 mph."
            }
            _uiState.value = _uiState.value.copy(
                dutyStatus = status.dutyStatus,
                eldEnabled = status.enabled,
                productionAuthorized = status.productionAuthorized,
                carrierConfigured = status.carrierConfigured,
                driverConfigured = status.driverConfigured,
                vehicleMoving = status.vehicleMoving,
                lastTelemetryAt = status.lastTelemetryAt,
                activeDiagnosticCount = status.activeDiagnosticCount,
                hosRuleLabel = hos?.ruleLabel.orEmpty(),
                hosHistorySufficient = hos?.sufficientHistory == true,
                driveRemainingMinutes = hos?.driveRemainingMinutes,
                windowRemainingMinutes = hos?.windowRemainingMinutes,
                breakRemainingMinutes = hos?.breakRemainingMinutes,
                cycleRemainingMinutes = hos?.cycleRemainingMinutes,
                drivingProhibitedReasons = hos?.drivingProhibitedReasons.orEmpty(),
                hosViolations = hos?.violations.orEmpty(),
                statusMessage = message,
                actionInProgress = false
            )
        } catch (_: Exception) {
            _uiState.value = _uiState.value.copy(
                statusMessage = "ELD status is unavailable. Keep the current legal ELD in service.",
                actionInProgress = false
            )
        }
    }

    private fun updateStatus(status: DutyStatus, notes: String) {
        if (_uiState.value.actionInProgress) return
        _uiState.value = _uiState.value.copy(actionInProgress = true, statusMessage = "Saving duty status...")
        viewModelScope.launch {
            try {
                repository.updateDutyStatus(status, notes)
                refreshEldStatus()
            } catch (_: Exception) {
                _uiState.value = _uiState.value.copy(
                    actionInProgress = false,
                    statusMessage = "Duty status was not saved. Check the connection and ELD configuration."
                )
            }
        }
    }
}
