package com.fleetai.driver.ui.viewmodel

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.fleetai.driver.data.local.AppPreferences
import com.fleetai.driver.data.model.DtcCode
import com.fleetai.driver.data.repository.DriverRepository
import com.fleetai.driver.obd.ObdService
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch

class DiagnosticsViewModel(
    private val repository: DriverRepository,
    private val preferences: AppPreferences
) : ViewModel() {
    private val obd = ObdService.manager

    private val _dtcs = MutableStateFlow<List<DtcCode>>(emptyList())
    val dtcs: StateFlow<List<DtcCode>> = _dtcs

    private val _message = MutableStateFlow("")
    val message: StateFlow<String> = _message

    init {
        scan()
    }

    fun scan() {
        viewModelScope.launch {
            _message.value = "Scanning..."
            val codes = if (obd.isConnected()) {
                val obdCodes = obd.readDtcs()
                if (obdCodes.isEmpty()) {
                    emptyList()
                } else {
                    obdCodes.map { DtcCode(it, "OBD reported code", "medium") }
                }
            } else {
                repository.getDiagnosticCodes()
            }
            _dtcs.value = codes
            _message.value = if (codes.isEmpty()) "No active codes." else "Codes detected."
        }
    }

    fun clear() {
        viewModelScope.launch {
            if (obd.isConnected()) {
                obd.clearDtcs()
            }
            _dtcs.value = emptyList()
            _message.value = "Codes cleared."
        }
    }
}
