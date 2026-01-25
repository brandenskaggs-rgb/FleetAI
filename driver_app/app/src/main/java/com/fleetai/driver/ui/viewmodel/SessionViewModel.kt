package com.fleetai.driver.ui.viewmodel

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.fleetai.driver.data.local.AppPreferences
import com.fleetai.driver.data.model.DriverSession
import com.fleetai.driver.data.model.ThemeMode
import com.fleetai.driver.data.repository.DriverRepository
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.launch

class SessionViewModel(
    private val repository: DriverRepository,
    private val preferences: AppPreferences
) : ViewModel() {
    private val _state = MutableStateFlow(SessionState())
    val state: StateFlow<SessionState> = _state

    init {
        viewModelScope.launch {
            combine(
                preferences.token,
                preferences.tenantId,
                preferences.driverId,
                preferences.driverName,
                preferences.vehicleId,
                preferences.deviceId,
                preferences.themeMode,
                preferences.demoMode
            ) { values ->
                val token = values[0] as String
                val tenantId = values[1] as String
                val driverId = values[2] as String
                val driverName = values[3] as String
                val vehicleId = values[4] as String
                val deviceId = values[5] as String
                val themeMode = values[6] as ThemeMode
                val demoMode = values[7] as Boolean
                SessionState(
                    isLoggedIn = token.isNotBlank(),
                    tenantId = tenantId,
                    driverId = driverId,
                    driverName = driverName,
                    vehicleId = vehicleId,
                    deviceId = deviceId,
                    themeMode = themeMode,
                    demoMode = demoMode
                )
            }.collect { _state.value = it }
        }
        viewModelScope.launch {
            preferences.ensureDeviceId()
        }
    }

    fun login(companyCode: String, driverPin: String, onResult: (Boolean, String) -> Unit) {
        viewModelScope.launch {
            try {
                repository.login(companyCode, driverPin)
                onResult(true, "")
            } catch (ex: Exception) {
                val message = when {
                    ex.message?.contains("invalid_pin", ignoreCase = true) == true ->
                        "Invalid PIN. Check and try again."
                    else -> "Network unavailable. Try again when connected."
                }
                onResult(false, message)
            }
        }
    }

    fun claimPairing(pairingCode: String, deviceLabel: String, onResult: (Boolean, String) -> Unit) {
        viewModelScope.launch {
            if (pairingCode.length != 6) {
                onResult(false, "Invalid code. Check and try again.")
                return@launch
            }
            try {
                val deviceId = preferences.ensureDeviceId()
                repository.claimPairing(pairingCode, deviceId, deviceLabel)
                onResult(true, "Device paired successfully.")
            } catch (ex: Exception) {
                val message = when {
                    ex.message?.contains("expired", ignoreCase = true) == true ->
                        "Code expired. Ask dispatch to generate a new code."
                    ex.message?.contains("invalid", ignoreCase = true) == true ->
                        "Invalid code. Check and try again."
                    else -> "Network unavailable. Try again when connected."
                }
                onResult(false, message)
            }
        }
    }

    fun logout() {
        viewModelScope.launch {
            preferences.clearSession()
        }
    }

    fun setThemeMode(mode: ThemeMode) {
        viewModelScope.launch {
            repository.setThemeMode(mode)
        }
    }

    fun setDemoMode(enabled: Boolean) {
        viewModelScope.launch {
            repository.setDemoMode(enabled)
        }
    }
}

data class SessionState(
    val isLoggedIn: Boolean = false,
    val tenantId: String = "",
    val driverId: String = "",
    val driverName: String = "",
    val vehicleId: String = "",
    val deviceId: String = "",
    val themeMode: ThemeMode = ThemeMode.DARK,
    val demoMode: Boolean = false
)
