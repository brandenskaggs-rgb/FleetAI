package com.fleetai.driver.ui.viewmodel

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.fleetai.driver.data.local.AppPreferences
import com.fleetai.driver.data.model.Vehicle
import com.fleetai.driver.data.repository.DriverRepository
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch

class VehicleViewModel(
    private val repository: DriverRepository,
    private val preferences: AppPreferences
) : ViewModel() {
    private val _vehicles = MutableStateFlow<List<Vehicle>>(emptyList())
    val vehicles: StateFlow<List<Vehicle>> = _vehicles

    private val _message = MutableStateFlow("")
    val message: StateFlow<String> = _message

    fun loadVehicles() {
        viewModelScope.launch {
            val tenantId = preferences.tenantId.first()
            if (tenantId.isBlank()) {
                _message.value = "Login required."
                return@launch
            }
            _vehicles.value = repository.getVehicles(tenantId)
        }
    }

    fun selectVehicle(vehicleId: String, onSelected: () -> Unit) {
        viewModelScope.launch {
            repository.bindVehicle(vehicleId)
            onSelected()
        }
    }
}
