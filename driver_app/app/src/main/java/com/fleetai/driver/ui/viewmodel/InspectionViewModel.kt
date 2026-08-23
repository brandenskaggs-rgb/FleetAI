package com.fleetai.driver.ui.viewmodel

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.fleetai.driver.data.local.AppPreferences
import com.fleetai.driver.data.model.DvirRecord
import com.fleetai.driver.data.repository.DriverRepository
import java.time.Instant
import java.util.UUID
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch

class InspectionViewModel(
    private val repository: DriverRepository,
    private val preferences: AppPreferences
) : ViewModel() {
    private val _message = MutableStateFlow("Select pass, defect, or N/A for every item before submitting.")
    val message: StateFlow<String> = _message

    private val _submitting = MutableStateFlow(false)
    val submitting: StateFlow<Boolean> = _submitting

    fun submit(
        type: String,
        odometer: Long,
        inspectedItems: List<String>,
        defects: String,
        signature: String
    ) {
        if (_submitting.value) return
        viewModelScope.launch {
            _submitting.value = true
            try {
                val tenantId = preferences.tenantId.first()
                val vehicleId = preferences.vehicleId.first()
                val driverId = preferences.driverId.first()
                if (tenantId.isBlank() || vehicleId.isBlank() || driverId.isBlank()) {
                    _message.value = "Pair this tablet to a driver and vehicle before submitting."
                    return@launch
                }
                val synced = repository.submitInspection(
                    DvirRecord(
                        id = UUID.randomUUID().toString(),
                        tenantId = tenantId,
                        vehicleId = vehicleId,
                        driverId = driverId,
                        type = if (type.equals("Post-trip", true)) "post" else "pre",
                        odometer = odometer,
                        inspectedItems = inspectedItems,
                        defects = defects,
                        signature = signature,
                        inspectedAt = Instant.now().toString()
                    )
                )
                _message.value = if (synced) {
                    "Inspection submitted to Fleet AI."
                } else {
                    "Inspection saved on this tablet and will upload when service returns."
                }
            } catch (_: Exception) {
                _message.value = "Inspection could not be saved. Check the required fields and try again."
            } finally {
                _submitting.value = false
            }
        }
    }
}
