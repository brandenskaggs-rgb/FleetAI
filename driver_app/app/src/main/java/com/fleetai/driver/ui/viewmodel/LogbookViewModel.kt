package com.fleetai.driver.ui.viewmodel

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.fleetai.driver.data.local.AppPreferences
import com.fleetai.driver.data.model.DutyStatus
import com.fleetai.driver.data.model.HosEvent
import com.fleetai.driver.data.repository.DriverRepository
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import java.time.LocalDate
import java.time.LocalDateTime
import java.util.UUID

class LogbookViewModel(
    private val repository: DriverRepository,
    private val preferences: AppPreferences
) : ViewModel() {
    private val _events = MutableStateFlow<List<HosEvent>>(emptyList())
    val events: StateFlow<List<HosEvent>> = _events

    private val _message = MutableStateFlow("")
    val message: StateFlow<String> = _message

    init {
        loadLogs()
    }

    fun loadLogs(date: String = LocalDate.now().toString()) {
        viewModelScope.launch {
            val tenantId = preferences.tenantId.first()
            if (tenantId.isBlank()) {
                _message.value = "Login required."
                return@launch
            }
            _events.value = repository.getHosEvents(date)
        }
    }

    fun addEntry(
        status: DutyStatus,
        startTime: String,
        endTime: String,
        notes: String
    ) {
        if (status == DutyStatus.DRIVING) {
            _message.value = "Driving time is recorded automatically and cannot be added manually."
            return
        }
        viewModelScope.launch {
            val tenantId = preferences.tenantId.first()
            val vehicleId = preferences.vehicleId.first()
            if (tenantId.isBlank() || vehicleId.isBlank()) {
                _message.value = "Select a vehicle first."
                return@launch
            }
            val event = HosEvent(
                id = UUID.randomUUID().toString(),
                tenantId = tenantId,
                vehicleId = vehicleId,
                status = status,
                notes = notes,
                startTime = startTime.ifBlank { LocalDateTime.now().toString() },
                endTime = endTime.ifBlank { LocalDateTime.now().toString() },
                eventDate = LocalDate.now().toString()
            )
            try {
                repository.addHosEvent(event)
                _events.value = repository.getHosEvents(event.eventDate)
                _message.value = ""
            } catch (_: Exception) {
                _message.value = "Unable to save log entry right now."
            }
        }
    }

    fun certify(date: LocalDate = LocalDate.now()) {
        viewModelScope.launch {
            try {
                val eldDate = "%02d%02d%02d".format(date.year % 100, date.monthValue, date.dayOfMonth)
                repository.certifyEldRecords(eldDate)
                _message.value = "Daily log certified."
                loadLogs(date.toString())
            } catch (_: Exception) {
                _message.value = "Certification was not saved. Check ELD setup and connection."
            }
        }
    }
}
