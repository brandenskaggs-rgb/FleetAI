package com.fleetai.driver.ui.viewmodel

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.fleetai.driver.data.local.AppPreferences
import com.fleetai.driver.data.model.DriverSession
import com.fleetai.driver.data.model.ThemeMode
import com.fleetai.driver.data.repository.DriverRepository
import com.fleetai.driver.BuildConfig
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.launch
import java.net.ConnectException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import android.util.Log

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
                Log.d("FleetAI", "[PAIR] login attempt")
                preferences.clearPairing()
                repository.login(companyCode, driverPin)
                Log.d("FleetAI", "[PAIR] login success")
                onResult(true, "")
            } catch (ex: Exception) {
                Log.d("FleetAI", "[PAIR] login failed ${ex.message}")
                val message = when {
                    ex.message?.contains("invalid_pin", ignoreCase = true) == true ->
                        "Invalid PIN. Check and try again."
                    ex.message?.contains("BASE_URL_NOT_CONFIGURED", ignoreCase = true) == true ->
                        "Configure server URL in Settings."
                    ex.message?.contains("LOCALHOST_BLOCKED", ignoreCase = true) == true ->
                        "Server URL cannot be localhost. Use LAN IP."
                    BuildConfig.DEBUG && ex is UnknownHostException ->
                        "DNS failed. Check server address."
                    BuildConfig.DEBUG && ex is ConnectException ->
                        "Connection refused. Check server and port."
                    BuildConfig.DEBUG && ex is SocketTimeoutException ->
                        "Connection timed out. Check Wi-Fi/hotspot."
                    else -> "Network unavailable. Try again when connected."
                }
                onResult(false, message)
            }
        }
    }

    fun claimPairing(pairingCode: String, driverPin: String, deviceLabel: String, onResult: (Boolean, String) -> Unit) {
        viewModelScope.launch {
            if (pairingCode.length < 6) {
                onResult(false, "Pairing code must be 6 characters.")
                return@launch
            }
            if (driverPin.length != 6) {
                onResult(false, "Driver PIN must be 6 digits.")
                return@launch
            }
            try {
                Log.d("FleetAI", "[PAIR] claim attempt")
                val deviceId = preferences.ensureDeviceId()
                repository.claimPairing(pairingCode, driverPin, deviceId, deviceLabel)
                Log.d("FleetAI", "[PAIR] claim success")
                onResult(true, "Device paired successfully.")
            } catch (ex: Exception) {
                Log.d("FleetAI", "[PAIR] claim failed ${ex.message}")
                val message = when {
                    ex.message?.contains("expired", ignoreCase = true) == true ->
                        "Code expired. Ask dispatch to generate a new code."
                    ex.message?.contains("invalid", ignoreCase = true) == true ->
                        if (ex.message?.contains("pin", ignoreCase = true) == true) "Driver PIN is incorrect." else "Invalid code. Check and try again."
                    ex.message?.contains("already_claimed", ignoreCase = true) == true ->
                        "This device code is already claimed. Ask dispatch to issue a new code."
                    ex.message?.contains("conflict", ignoreCase = true) == true ->
                        "Pairing conflict detected. Ask dispatch to replace the code."
                    BuildConfig.DEBUG && ex is UnknownHostException ->
                        "DNS failed. Check server address."
                    BuildConfig.DEBUG && ex is ConnectException ->
                        "Connection refused. Check server and port."
                    BuildConfig.DEBUG && ex is SocketTimeoutException ->
                        "Connection timed out. Check Wi-Fi/hotspot."
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
            runCatching { repository.setThemeMode(mode) }
        }
    }

    fun setDemoMode(enabled: Boolean) {
        viewModelScope.launch {
            runCatching { repository.setDemoMode(enabled) }
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
