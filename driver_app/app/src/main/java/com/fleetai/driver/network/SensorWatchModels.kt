package com.fleetai.driver.network

data class SensorWatchResponse(val serverTime: String, val watch: SensorWatchDto? = null)
data class SensorWatchDto(
    val requestId: String,
    val vehicleId: String,
    val expiresAt: String,
    val status: String,
    val requestedKeys: List<String> = emptyList()
)
data class SensorWatchAck(val requestId: String, val supportedKeys: List<String>)
