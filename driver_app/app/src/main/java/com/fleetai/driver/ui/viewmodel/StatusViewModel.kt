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
    private val _saving = MutableStateFlow(false)
    val saving: StateFlow<Boolean> = _saving
    private val _eldEnabled = MutableStateFlow(true)
    val eldEnabled: StateFlow<Boolean> = _eldEnabled

    init { viewModelScope.launch {
        try {
            val state = repository.getEldDeviceStatus()
            _dutyStatus.value = state.dutyStatus
            _eldEnabled.value = state.enabled
            if (!state.enabled) _message.value = "Pilot activity only / not a legal ELD log."
        } catch (_: Exception) { _message.value = "Unable to load current status. Check your connection." }
    } }

    fun setStatus(status: DutyStatus) {
        if (_saving.value) return
        if (status == DutyStatus.DRIVING && _eldEnabled.value) {
            _message.value = "Driving is automatic in ELD mode; manual Driving is unavailable."
            return
        }
        _saving.value = true
        viewModelScope.launch {
            try {
                repository.updateDutyStatus(status, "Status update")
                val saved = repository.getEldDeviceStatus()
                _dutyStatus.value = saved.dutyStatus
                _eldEnabled.value = saved.enabled
                _message.value = if (saved.pendingDutyUpload || saved.dutyStatus != status)
                    "Saved locally; server status has not confirmed this change yet."
                else "Activity status updated."
            } catch (cancelled: kotlinx.coroutines.CancellationException) { throw cancelled }
            catch (_: Exception) { _message.value = "Unable to confirm the change. Check your connection and refresh." }
            finally { _saving.value = false }
        }
    }

    fun notifyFleet(reason: String) {
        viewModelScope.launch {
            try {
                repository.notifyFleet(reason)
                _message.value = "Fleet manager notified."
            } catch (_: Exception) {
                _message.value = "Unable to notify fleet right now. The update was not confirmed."
            }
        }
    }

    fun clearMessage() {
        _message.value = ""
    }
}
