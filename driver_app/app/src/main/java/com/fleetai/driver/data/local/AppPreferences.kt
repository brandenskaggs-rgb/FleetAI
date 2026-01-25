package com.fleetai.driver.data.local

import android.content.Context
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import com.fleetai.driver.data.model.ThemeMode
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import java.util.UUID

private val Context.appDataStore by preferencesDataStore(name = "fleet_driver_prefs")

class AppPreferences(private val context: Context) {
    private val tenantIdKey = stringPreferencesKey("tenant_id")
    private val driverIdKey = stringPreferencesKey("driver_id")
    private val tokenKey = stringPreferencesKey("auth_token")
    private val driverNameKey = stringPreferencesKey("driver_name")
    private val vehicleIdKey = stringPreferencesKey("vehicle_id")
    private val deviceIdKey = stringPreferencesKey("device_id")
    private val themeKey = stringPreferencesKey("theme_mode")
    private val demoModeKey = booleanPreferencesKey("demo_mode")

    val tenantId: Flow<String> = context.appDataStore.data.map { it[tenantIdKey] ?: "" }
    val driverId: Flow<String> = context.appDataStore.data.map { it[driverIdKey] ?: "" }
    val token: Flow<String> = context.appDataStore.data.map { it[tokenKey] ?: "" }
    val driverName: Flow<String> = context.appDataStore.data.map { it[driverNameKey] ?: "" }
    val vehicleId: Flow<String> = context.appDataStore.data.map { it[vehicleIdKey] ?: "" }
    val deviceId: Flow<String> = context.appDataStore.data.map { it[deviceIdKey] ?: "" }
    val themeMode: Flow<ThemeMode> = context.appDataStore.data.map {
        when (it[themeKey]) {
            ThemeMode.LIGHT.name -> ThemeMode.LIGHT
            else -> ThemeMode.DARK
        }
    }
    val demoMode: Flow<Boolean> = context.appDataStore.data.map { it[demoModeKey] ?: false }

    suspend fun saveSession(tenantId: String, driverId: String, token: String, driverName: String) {
        context.appDataStore.edit { prefs ->
            prefs[tenantIdKey] = tenantId
            prefs[driverIdKey] = driverId
            prefs[tokenKey] = token
            prefs[driverNameKey] = driverName
        }
    }

    suspend fun clearSession() {
        context.appDataStore.edit { prefs ->
            prefs.remove(tenantIdKey)
            prefs.remove(driverIdKey)
            prefs.remove(tokenKey)
            prefs.remove(driverNameKey)
            prefs.remove(vehicleIdKey)
        }
    }

    suspend fun saveVehicle(vehicleId: String) {
        context.appDataStore.edit { prefs ->
            prefs[vehicleIdKey] = vehicleId
        }
    }

    suspend fun savePairing(vehicleId: String, driverId: String) {
        context.appDataStore.edit { prefs ->
            prefs[vehicleIdKey] = vehicleId
            prefs[driverIdKey] = driverId
        }
    }

    suspend fun ensureDeviceId(): String {
        val existing = deviceId.first()
        if (existing.isNotBlank()) {
            return existing
        }
        val created = UUID.randomUUID().toString()
        context.appDataStore.edit { prefs ->
            prefs[deviceIdKey] = created
        }
        return created
    }

    suspend fun setThemeMode(mode: ThemeMode) {
        context.appDataStore.edit { prefs ->
            prefs[themeKey] = mode.name
        }
    }

    suspend fun setDemoMode(enabled: Boolean) {
        context.appDataStore.edit { prefs ->
            prefs[demoModeKey] = enabled
        }
    }
}
