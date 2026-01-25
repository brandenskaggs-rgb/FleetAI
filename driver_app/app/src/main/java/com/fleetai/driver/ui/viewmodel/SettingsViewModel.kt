package com.fleetai.driver.ui.viewmodel

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.fleetai.driver.data.local.AppPreferences
import com.fleetai.driver.data.model.ThemeMode
import com.fleetai.driver.data.repository.DriverRepository
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.launch

class SettingsViewModel(
    private val repository: DriverRepository,
    private val preferences: AppPreferences
) : ViewModel() {
    private val _state = MutableStateFlow(SettingsState())
    val state: StateFlow<SettingsState> = _state

    init {
        viewModelScope.launch {
            combine(
                preferences.tenantId,
                preferences.driverName,
                preferences.vehicleId,
                preferences.themeMode,
                preferences.demoMode
            ) { tenantId, driverName, vehicleId, themeMode, demoMode ->
                SettingsState(
                    tenantId = tenantId,
                    driverName = driverName,
                    vehicleId = vehicleId,
                    themeMode = themeMode,
                    demoMode = demoMode
                )
            }.collect { _state.value = it }
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

    fun logout() {
        viewModelScope.launch {
            preferences.clearSession()
        }
    }

    fun resetPairing() {
        viewModelScope.launch {
            preferences.clearPairing()
        }
    }
}

data class SettingsState(
    val tenantId: String = "",
    val driverName: String = "",
    val vehicleId: String = "",
    val themeMode: ThemeMode = ThemeMode.DARK,
    val demoMode: Boolean = false
)
