package com.fleetai.driver

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue

class DriverAppState {
    var deviceId by mutableStateOf("")
    var deviceToken by mutableStateOf("")
    var vehicleId by mutableStateOf("")
    var tripId by mutableStateOf("")
    var tripStartedAt by mutableStateOf("--")
    var tripEndedAt by mutableStateOf("--")
    var samplingRateSeconds by mutableIntStateOf(2)
    var uploadIntervalSeconds by mutableIntStateOf(10)
    var packetsSent by mutableIntStateOf(0)
    var lastUploadAt by mutableStateOf("--")
    var connectionStatus by mutableStateOf("Disconnected")
}
