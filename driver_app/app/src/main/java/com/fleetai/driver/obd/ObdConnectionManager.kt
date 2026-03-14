package com.fleetai.driver.obd

import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothSocket
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.net.SocketTimeoutException
import java.nio.charset.Charset
import java.util.UUID

class ObdConnectionManager {
    private val adapter: BluetoothAdapter? = BluetoothAdapter.getDefaultAdapter()
    private var socket: BluetoothSocket? = null
    private var input: BufferedInputStream? = null
    private var output: BufferedOutputStream? = null
    private val ioLock = Any()

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
        sendCommand(command)
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

    private suspend fun sendCommand(command: String): String? = withContext(Dispatchers.IO) {
        val out = output ?: return@withContext null
        val inputStream = input ?: return@withContext null
        synchronized(ioLock) {
            drainInput(inputStream)
            val payload = "${command.trim()}\r"
            out.write(payload.toByteArray(Charset.forName("US-ASCII")))
            out.flush()

            val response = StringBuilder()
            val buffer = ByteArray(256)
            val deadline = System.currentTimeMillis() + 1800L
            while (System.currentTimeMillis() < deadline) {
                val read = try {
                    inputStream.read(buffer)
                } catch (_: SocketTimeoutException) {
                    if (response.isNotEmpty()) break
                    continue
                }
                if (read <= 0) {
                    if (response.isNotEmpty()) break
                    continue
                }
                val chunk = String(buffer, 0, read, Charset.forName("US-ASCII"))
                response.append(chunk)
                if (chunk.contains(">")) break
            }

            val raw = response.toString()
            if (raw.isBlank()) return@withContext null
            return@withContext parseObdResponse(raw, command)
        }
    }

    private fun drainInput(inputStream: BufferedInputStream) {
        while (inputStream.available() > 0) {
            val skipped = inputStream.skip(inputStream.available().toLong())
            if (skipped <= 0) break
        }
    }

    private fun parseObdResponse(raw: String, command: String): String? {
        val cleaned = raw
            .replace(">", " ")
            .replace("\r", "\n")
            .lines()
            .map { it.trim() }
            .filter { line ->
                line.isNotBlank() &&
                    !line.equals(command, ignoreCase = true) &&
                    !line.startsWith("SEARCHING", ignoreCase = true)
            }
            .joinToString(" ")
            .trim()
        return cleaned.ifBlank { null }
    }
}
