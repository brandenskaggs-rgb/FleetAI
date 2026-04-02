package com.fleetai.driver.obd

import android.bluetooth.BluetoothDevice

interface ObdTransport {
    val name: String
    fun hasBluetooth(): Boolean
    fun pairedDevices(): Set<BluetoothDevice>
    fun isConnected(): Boolean
    suspend fun connect(device: BluetoothDevice): Boolean
    suspend fun disconnect()
    suspend fun sendCommand(command: String): String?
}
