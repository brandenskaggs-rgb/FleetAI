package com.fleetai.driver.ui.viewmodel

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.fleetai.driver.data.model.DutyStatus
import com.fleetai.driver.data.repository.DriverRepository
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch

class StatusViewModel(
    private val repository: DriverRepository
) : ViewModel() {
    private val _dutyStatus = MutableStateFlow(DutyStatus.OFF)
    val dutyStatus: StateFlow<DutyStatus> = _dutyStatus

    private val _message = MutableStateFlow("")
    val message: StateFlow<String> = _message

    fun setStatus(status: DutyStatus) {
        _dutyStatus.value = status
        viewModelScope.launch {
            repository.updateDutyStatus(status, "Status update")
        }
    }

    fun notifyFleet(reason: String) {
        viewModelScope.launch {
            repository.notifyFleet(reason)
            _message.value = "Fleet manager notified."
        }
    }

    fun clearMessage() {
        _message.value = ""
    }
}
