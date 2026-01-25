package com.fleetai.driver.obd

import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothSocket
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.nio.charset.Charset
import java.util.UUID

class ObdConnectionManager {
    private val adapter: BluetoothAdapter? = BluetoothAdapter.getDefaultAdapter()
    private var socket: BluetoothSocket? = null
    private var input: BufferedInputStream? = null
    private var output: BufferedOutputStream? = null

    fun hasBluetooth(): Boolean = adapter != null

    fun pairedDevices(): Set<BluetoothDevice> = adapter?.bondedDevices ?: emptySet()

    fun isConnected(): Boolean = socket?.isConnected == true

    suspend fun discoverSupportedPids(): Set<String> {
        val supported = mutableSetOf<String>()
        val groups = listOf("0100", "0120", "0140", "0160", "0180")
        groups.forEachIndexed { idx, cmd ->
            try {
                val resp = sendCommand(cmd) ?: return@forEachIndexed
                val bits = ObdParser.parseSupportedPids(resp)
                bits.forEach { pidHex ->
                    // pidHex already includes mode 01 prefix
                    supported.add(pidHex)
                }
            } catch (_: Exception) {
                // ignore
            }
        }
        return supported
    }

    suspend fun connect(device: BluetoothDevice): Boolean = withContext(Dispatchers.IO) {
        disconnect()
        val uuid = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB")
        val btSocket = device.createRfcommSocketToServiceRecord(uuid)
        btSocket.connect()
        socket = btSocket
        input = BufferedInputStream(btSocket.inputStream)
        output = BufferedOutputStream(btSocket.outputStream)
        initializeElm()
        true
    }

    suspend fun disconnect() = withContext(Dispatchers.IO) {
        runCatching { input?.close() }
        runCatching { output?.close() }
        runCatching { socket?.close() }
        input = null
        output = null
        socket = null
    }

    suspend fun readPid(command: String): String? = withContext(Dispatchers.IO) {
        val response = sendCommand(command) ?: return@withContext null
        parseObdResponse(response)
    }

    suspend fun readDtcs(): List<String> = withContext(Dispatchers.IO) {
        val response = sendCommand("03") ?: return@withContext emptyList()
        ObdParser.parseDtcs(response)
    }

    suspend fun readVin(): String? = withContext(Dispatchers.IO) {
        val resp = sendCommand("0902") ?: return@withContext null
        ObdParser.parseVin(resp)
    }

    suspend fun clearDtcs(): Boolean = withContext(Dispatchers.IO) {
        sendCommand("04") != null
    }

    private suspend fun initializeElm() {
        sendCommand("ATZ")
        sendCommand("ATE0")
        sendCommand("ATL0")
        sendCommand("ATS0")
        sendCommand("ATH0")
        sendCommand("ATSP0")
    }

    private suspend fun sendCommand(command: String): String? {
        val out = output ?: return null
        val inputStream = input ?: return null
        val payload = "${command}\r"
        out.write(payload.toByteArray(Charset.forName("US-ASCII")))
        out.flush()

        val buffer = ByteArray(512)
        val read = inputStream.read(buffer)
        if (read <= 0) return null
        return String(buffer, 0, read, Charset.forName("US-ASCII"))
    }

    private fun parseObdResponse(raw: String): String? {
        return raw.replace("\r", " ").replace(">", " ").trim().ifBlank { null }
    }
}
