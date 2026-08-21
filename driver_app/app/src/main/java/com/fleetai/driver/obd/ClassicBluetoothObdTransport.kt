package com.fleetai.driver.obd

import android.annotation.SuppressLint
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

class ClassicBluetoothObdTransport : ObdTransport {
    override val name: String = "Classic Bluetooth"

    private val adapter: BluetoothAdapter? = BluetoothAdapter.getDefaultAdapter()
    @Volatile private var socket: BluetoothSocket? = null
    @Volatile private var input: BufferedInputStream? = null
    @Volatile private var output: BufferedOutputStream? = null
    private val ioLock = Any()

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

    override fun isConnected(): Boolean = socket?.isConnected == true && input != null && output != null

    @SuppressLint("MissingPermission")
    override suspend fun connect(device: BluetoothDevice): Boolean = withContext(Dispatchers.IO) {
        disconnect()
        val uuid = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB")
        val btSocket = device.createRfcommSocketToServiceRecord(uuid)
        try {
            runCatching { adapter?.cancelDiscovery() }
            btSocket.connect()
            val nextInput = BufferedInputStream(btSocket.inputStream)
            val nextOutput = BufferedOutputStream(btSocket.outputStream)
            socket = btSocket
            input = nextInput
            output = nextOutput
            true
        } catch (err: Exception) {
            runCatching { btSocket.close() }
            input = null
            output = null
            socket = null
            throw err
        }
    }

    override suspend fun disconnect() {
        withContext(Dispatchers.IO) {
            val currentInput = input
            val currentOutput = output
            val currentSocket = socket
            input = null
            output = null
            socket = null
            runCatching { currentInput?.close() }
            runCatching { currentOutput?.close() }
            runCatching { currentSocket?.close() }
        }
    }

    override suspend fun sendCommand(command: String): String? = withContext(Dispatchers.IO) {
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
            return@withContext raw
        }
    }

    private fun drainInput(inputStream: BufferedInputStream) {
        while (inputStream.available() > 0) {
            val skipped = inputStream.skip(inputStream.available().toLong())
            if (skipped <= 0) break
        }
    }
}
