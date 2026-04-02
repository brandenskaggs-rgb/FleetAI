package com.fleetai.driver.obd

import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice

class BleObdTransport : ObdTransport {
    override val name: String = "Bluetooth LE"

    private val adapter: BluetoothAdapter? = BluetoothAdapter.getDefaultAdapter()
    @Volatile private var connectedDevice: BluetoothDevice? = null

    override fun hasBluetooth(): Boolean = adapter != null

    override fun pairedDevices(): Set<BluetoothDevice> {
        return try {
            adapter?.bondedDevices ?: emptySet()
        } catch (_: SecurityException) {
            emptySet()
        } catch (_: Exception) {
            emptySet()
        }
    }

    override fun isConnected(): Boolean = connectedDevice != null

    override suspend fun connect(device: BluetoothDevice): Boolean {
        connectedDevice = null
        throw UnsupportedOperationException("BLE OBD transport is not implemented yet. Do not route production connections through BLE until GATT discovery, characteristics, and command exchange are completed.")
    }

    override suspend fun disconnect() {
        connectedDevice = null
    }

    override suspend fun sendCommand(command: String): String? {
        connectedDevice = null
        throw UnsupportedOperationException("BLE OBD transport is not implemented yet. GATT command exchange must be completed before launch use.")
    }
}
