package com.fleetai.driver.ui.viewmodel

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.fleetai.driver.data.model.ComplianceConfig
import com.fleetai.driver.data.model.DutyStatus
import com.fleetai.driver.data.model.HomeUiState
import com.fleetai.driver.data.repository.DriverRepository
import kotlinx.coroutines.Job
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
            remainingDriveMinutes = 0,
            remainingShiftMinutes = 0,
            breakMinutesRemaining = 0,
            complianceWarning = "",
            complianceBlocked = false,
            needsAcknowledgement = false
        )
    )
    val uiState: StateFlow<HomeUiState> = _uiState

    private var config: ComplianceConfig = ComplianceConfig(660, 840, 30, 480)
    private var driveMinutesUsed = 0
    private var shiftMinutesUsed = 0
    private var minutesSinceBreak = 0
    private var acknowledged = false
    private var timerJob: Job? = null

    init {
        viewModelScope.launch {
            config = repository.getComplianceConfig()
            refreshState()
        }
        startTimer()
    }

    private fun startTimer() {
        timerJob?.cancel()
        timerJob = viewModelScope.launch {
            while (true) {
                delay(60_000)
                val status = _uiState.value.dutyStatus
                if (status == DutyStatus.DRIVING) {
                    driveMinutesUsed += 1
                    shiftMinutesUsed += 1
                    minutesSinceBreak += 1
                } else if (status == DutyStatus.ON) {
                    shiftMinutesUsed += 1
                }
                refreshState()
            }
        }
    }

    private fun refreshState() {
        val remainingDrive = (config.maxDriveMinutes - driveMinutesUsed).coerceAtLeast(0)
        val remainingShift = (config.maxShiftMinutes - shiftMinutesUsed).coerceAtLeast(0)
        val breakRemaining = (config.breakMinutesRequired - minutesSinceBreak).coerceAtLeast(0)

        val breakDue = minutesSinceBreak >= config.breakIntervalMinutes
        val shiftOver = shiftMinutesUsed >= config.maxShiftMinutes
        val driveOver = driveMinutesUsed >= config.maxDriveMinutes

        val warning = when {
            shiftOver -> "Shift limit exceeded. End shift or acknowledge to continue."
            driveOver -> "Drive hours exceeded. Take a break or end shift."
            breakDue -> "Break required. Take a 30-minute break."
            else -> ""
        }

        _uiState.value = _uiState.value.copy(
            remainingDriveMinutes = remainingDrive,
            remainingShiftMinutes = remainingShift,
            breakMinutesRemaining = breakRemaining,
            complianceWarning = warning,
            complianceBlocked = shiftOver,
            needsAcknowledgement = shiftOver && !acknowledged
        )
    }

    fun acknowledgeCompliance() {
        acknowledged = true
        refreshState()
    }

    fun startDriving() {
        val state = _uiState.value
        if (state.complianceBlocked && !acknowledged) {
            refreshState()
            return
        }
        updateStatus(DutyStatus.DRIVING, "Driving")
    }

    fun takeBreak() {
        minutesSinceBreak = 0
        updateStatus(DutyStatus.OFF, "Break")
        viewModelScope.launch {
            repository.notifyFleet("Break started")
        }
    }

    fun takeLunch() {
        minutesSinceBreak = 0
        updateStatus(DutyStatus.OFF, "Lunch")
        viewModelScope.launch {
            repository.notifyFleet("Lunch started")
        }
    }

    fun endShift() {
        updateStatus(DutyStatus.OFF, "End shift")
        driveMinutesUsed = 0
        shiftMinutesUsed = 0
        minutesSinceBreak = 0
        acknowledged = false
        refreshState()
    }

    fun setDutyStatus(status: DutyStatus) {
        updateStatus(status, "Status update")
    }

    private fun updateStatus(status: DutyStatus, notes: String) {
        _uiState.value = _uiState.value.copy(dutyStatus = status)
        viewModelScope.launch {
            repository.updateDutyStatus(status, notes)
        }
    }
}
