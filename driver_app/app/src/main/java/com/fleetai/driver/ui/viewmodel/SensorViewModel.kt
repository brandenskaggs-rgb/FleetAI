package com.fleetai.driver.ui.viewmodel

import android.bluetooth.BluetoothDevice
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.fleetai.driver.data.local.AppPreferences
import com.fleetai.driver.data.model.SensorReading
import com.fleetai.driver.obd.ObdParser
import com.fleetai.driver.obd.ObdService
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlin.random.Random

class SensorViewModel(private val preferences: AppPreferences) : ViewModel() {
    private val obd = ObdService.manager

    private val _status = MutableStateFlow("Not connected")
    val status: StateFlow<String> = _status

    private val _demoMode = MutableStateFlow(false)
    val demoMode: StateFlow<Boolean> = _demoMode

    private val _readings = MutableStateFlow<List<SensorReading>>(emptyList())
    val readings: StateFlow<List<SensorReading>> = _readings

    private var pollJob: Job? = null

    init {
        viewModelScope.launch {
            _demoMode.value = preferences.demoMode.first()
            if (_demoMode.value) {
                _status.value = "Demo mode"
                startDemo()
            }
        }
    }

    fun pairedDevices(): List<BluetoothDevice> = obd.pairedDevices().toList()

    fun hasBluetooth(): Boolean = obd.hasBluetooth()

    fun toggleDemo(enabled: Boolean) {
        viewModelScope.launch {
            preferences.setDemoMode(enabled)
            _demoMode.value = enabled
            if (enabled) {
                _status.value = "Demo mode"
                startDemo()
            } else {
                _status.value = "Not connected"
                stopPolling()
            }
        }
    }

    fun connect(device: BluetoothDevice) {
        viewModelScope.launch {
            try {
                _status.value = "Connecting..."
                obd.connect(device)
                _status.value = "Connected"
                startPolling()
            } catch (_: Exception) {
                _status.value = "Connection failed"
            }
        }
    }

    fun disconnect() {
        viewModelScope.launch {
            obd.disconnect()
            _status.value = "Not connected"
            stopPolling()
        }
    }

    private fun startPolling() {
        stopPolling()
        pollJob = viewModelScope.launch {
            while (true) {
                val rpm = obd.readPid("010C")?.let { ObdParser.parseRpm(it) }
                val speed = obd.readPid("010D")?.let { ObdParser.parseSpeed(it) }
                val coolant = obd.readPid("0105")?.let { ObdParser.parseCoolant(it) }
                val voltage = obd.readPid("0142")?.let { ObdParser.parseVoltage(it) }
                val intake = obd.readPid("010F")?.let { ObdParser.parseIntake(it) }
                _readings.value = listOf(
                    SensorReading("Coolant Temp", formatTemp(coolant), "F"),
                    SensorReading("RPM", formatNumber(rpm), "rpm"),
                    SensorReading("Speed", formatNumber(speed), "mph"),
                    SensorReading("Voltage", formatNumber(voltage), "V"),
                    SensorReading("Intake Temp", formatTemp(intake), "F"),
                    SensorReading("Oil Temp", "N/A", "F")
                )
                delay(2000)
            }
        }
    }

    private fun startDemo() {
        stopPolling()
        pollJob = viewModelScope.launch {
            while (true) {
                _readings.value = listOf(
                    SensorReading("Coolant Temp", demoValue(78.0, 96.0), "F"),
                    SensorReading("RPM", demoValue(900.0, 2100.0), "rpm"),
                    SensorReading("Speed", demoValue(0.0, 100.0), "mph"),
                    SensorReading("Voltage", demoValue(12.4, 14.2), "V"),
                    SensorReading("Intake Temp", demoValue(20.0, 45.0), "F"),
                    SensorReading("Oil Temp", demoValue(70.0, 105.0), "F")
                )
                delay(2000)
            }
        }
    }

    private fun stopPolling() {
        pollJob?.cancel()
        pollJob = null
    }

    private fun demoValue(min: Double, max: Double): String {
        return String.format("%.1f", Random.nextDouble(min, max))
    }

    private fun formatNumber(value: Double?): String = value?.let { String.format("%.0f", it) } ?: "N/A"

    private fun formatTemp(value: Double?): String = value?.let { String.format("%.0f", it) } ?: "N/A"
}
