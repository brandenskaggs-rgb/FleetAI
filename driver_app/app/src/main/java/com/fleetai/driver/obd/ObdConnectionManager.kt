package com.fleetai.driver.obd

import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothProfile
import android.bluetooth.BluetoothSocket
import android.content.Context
import android.os.Build
import android.util.Log
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.net.SocketTimeoutException
import java.nio.charset.Charset
import java.util.UUID

private const val TAG = "FleetAI.OBD"

class ObdConnectionManager(private val context: Context) {

    private val adapter: BluetoothAdapter? = BluetoothAdapter.getDefaultAdapter()

    // ── SPP (Classic Bluetooth) state ──────────────────────────────────────────
    @Volatile private var socket: BluetoothSocket? = null
    @Volatile private var input: BufferedInputStream? = null
    @Volatile private var output: BufferedOutputStream? = null
    private val sppLock = Any()

    // ── BLE GATT state ─────────────────────────────────────────────────────────
    @Volatile private var bleGatt: BluetoothGatt? = null
    @Volatile private var bleTxChar: BluetoothGattCharacteristic? = null
    @Volatile private var bleReady = false
    private val bleRxBuffer = StringBuilder()
    private val bleResponseChannel = Channel<String?>(Channel.UNLIMITED)
    private val bleRxLock = Any()

    // ── Active transport ───────────────────────────────────────────────────────
    private enum class Transport { NONE, SPP, BLE }
    @Volatile private var activeTransport = Transport.NONE

    companion object {
        // Veepeak OBDCheck BLE / ELM327 BLE clone profile
        private val BLE_SERVICE_UUID = UUID.fromString("0000FFE0-0000-1000-8000-00805F9B34FB")
        private val BLE_CHAR_UUID    = UUID.fromString("0000FFE1-0000-1000-8000-00805F9B34FB")
        private val CCCD_UUID        = UUID.fromString("00002902-0000-1000-8000-00805F9B34FB")
        private const val SPP_UUID              = "00001101-0000-1000-8000-00805F9B34FB"
        private const val BLE_SETUP_TIMEOUT_MS  = 12_000L
        private const val CMD_TIMEOUT_MS        = 3_000L
    }

    // ── GATT callback: one CompletableDeferred for the full setup phase ────────
    @Volatile private var gattReadyDeferred: CompletableDeferred<Boolean>? = null

    private val gattCallback = object : BluetoothGattCallback() {

        override fun onConnectionStateChange(gatt: BluetoothGatt, status: Int, newState: Int) {
            Log.d(TAG, "BLE state: status=$status newState=$newState")
            if (newState == BluetoothProfile.STATE_CONNECTED) {
                gatt.discoverServices()
            } else {
                bleReady = false
                gattReadyDeferred?.complete(false)
                gattReadyDeferred = null
            }
        }

        override fun onServicesDiscovered(gatt: BluetoothGatt, status: Int) {
            Log.d(TAG, "BLE services discovered: status=$status")
            if (status != BluetoothGatt.GATT_SUCCESS) {
                gattReadyDeferred?.complete(false)
                gattReadyDeferred = null
                return
            }
            val char = gatt.getService(BLE_SERVICE_UUID)?.getCharacteristic(BLE_CHAR_UUID)
            if (char == null) {
                Log.w(TAG, "BLE: OBD characteristic not found — device may not be ELM327 BLE")
                gattReadyDeferred?.complete(false)
                gattReadyDeferred = null
                return
            }
            bleTxChar = char
            gatt.setCharacteristicNotification(char, true)
            val desc = char.getDescriptor(CCCD_UUID)
            if (desc != null) {
                // Enable notifications; wait for onDescriptorWrite to complete setup
                @Suppress("DEPRECATION")
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    gatt.writeDescriptor(desc, BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE)
                } else {
                    desc.value = BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
                    @Suppress("DEPRECATION")
                    gatt.writeDescriptor(desc)
                }
            } else {
                // Some BLE OBD clones skip the CCCD — proceed without it
                bleReady = true
                gattReadyDeferred?.complete(true)
                gattReadyDeferred = null
            }
        }

        override fun onDescriptorWrite(gatt: BluetoothGatt, descriptor: BluetoothGattDescriptor, status: Int) {
            Log.d(TAG, "BLE descriptor write: status=$status")
            bleReady = status == BluetoothGatt.GATT_SUCCESS
            gattReadyDeferred?.complete(bleReady)
            gattReadyDeferred = null
        }

        // API < 33: deprecated signature still fires on older Android
        @Deprecated("Deprecated in Java")
        @Suppress("DEPRECATION")
        override fun onCharacteristicChanged(
            gatt: BluetoothGatt,
            characteristic: BluetoothGattCharacteristic
        ) {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
                handleBleRx(characteristic.value ?: return)
            }
        }

        // API 33+: new signature; the deprecated one is skipped on 13+ to avoid double-processing
        override fun onCharacteristicChanged(
            gatt: BluetoothGatt,
            characteristic: BluetoothGattCharacteristic,
            value: ByteArray
        ) {
            handleBleRx(value)
        }
    }

    private fun handleBleRx(bytes: ByteArray) {
        synchronized(bleRxLock) {
            bleRxBuffer.append(String(bytes, Charsets.US_ASCII))
            if (bleRxBuffer.contains('>')) {
                val response = bleRxBuffer.toString()
                bleRxBuffer.clear()
                bleResponseChannel.trySend(response)
            }
        }
    }

    // ── Public API ─────────────────────────────────────────────────────────────

    fun hasBluetooth(): Boolean = adapter != null

    fun pairedDevices(): Set<BluetoothDevice> {
        return try {
            adapter?.bondedDevices ?: emptySet()
        } catch (_: SecurityException) { emptySet() }
        catch (_: Exception) { emptySet() }
    }

    fun isConnected(): Boolean = when (activeTransport) {
        Transport.SPP  -> socket?.isConnected == true && input != null && output != null
        Transport.BLE  -> bleReady && bleGatt != null && bleTxChar != null
        Transport.NONE -> false
    }

    suspend fun connect(device: BluetoothDevice): Boolean {
        disconnect()
        return when (device.type) {
            BluetoothDevice.DEVICE_TYPE_LE -> connectBle(device)
            else -> connectSpp(device)  // classic, dual, or unknown → try SPP
        }
    }

    suspend fun disconnect() = withContext(Dispatchers.IO) {
        activeTransport = Transport.NONE
        // SPP cleanup
        val prevInput = input; val prevOutput = output; val prevSocket = socket
        input = null; output = null; socket = null
        runCatching { prevInput?.close() }
        runCatching { prevOutput?.close() }
        runCatching { prevSocket?.close() }
        // BLE cleanup
        bleReady = false
        bleTxChar = null
        val prevGatt = bleGatt
        bleGatt = null
        gattReadyDeferred?.complete(false)
        gattReadyDeferred = null
        runCatching { prevGatt?.disconnect() }
        runCatching { prevGatt?.close() }
        synchronized(bleRxLock) { bleRxBuffer.clear() }
        while (bleResponseChannel.tryReceive().isSuccess) { /* drain stale responses */ }
    }

    suspend fun readPid(command: String): String? = withContext(Dispatchers.IO) {
        sendCommand(command)
    }

    suspend fun readDtcs(): List<String> = withContext(Dispatchers.IO) {
        ObdParser.parseDtcs(sendCommand("03") ?: return@withContext emptyList())
    }

    suspend fun readVin(): String? = withContext(Dispatchers.IO) {
        ObdParser.parseVin(sendCommand("0902") ?: return@withContext null)
    }

    suspend fun clearDtcs(): Boolean = withContext(Dispatchers.IO) {
        sendCommand("04") != null
    }

    suspend fun discoverSupportedPids(): Set<String> {
        val supported = mutableSetOf<String>()
        listOf("0100", "0120", "0140", "0160", "0180").forEach { cmd ->
            try {
                val resp = sendCommand(cmd) ?: return@forEach
                ObdParser.parseSupportedPids(resp).forEach { supported.add(it) }
            } catch (_: Exception) { }
        }
        return supported
    }

    // ── BLE connect ────────────────────────────────────────────────────────────

    @SuppressLint("MissingPermission")
    private suspend fun connectBle(device: BluetoothDevice): Boolean = withContext(Dispatchers.IO) {
        Log.d(TAG, "Connecting BLE GATT: ${device.address}")
        val deferred = CompletableDeferred<Boolean>()
        gattReadyDeferred = deferred

        val gatt = device.connectGatt(context, false, gattCallback)
        bleGatt = gatt

        val ready = withTimeoutOrNull(BLE_SETUP_TIMEOUT_MS) { deferred.await() } ?: false
        if (!ready) {
            Log.w(TAG, "BLE GATT setup timed out or failed")
            runCatching { gatt.disconnect(); gatt.close() }
            bleGatt = null
            return@withContext false
        }

        activeTransport = Transport.BLE
        Log.d(TAG, "BLE connected, initializing ELM327")
        try { initializeElm() } catch (e: Exception) { Log.w(TAG, "ELM init error: ${e.message}") }
        true
    }

    // ── SPP connect ────────────────────────────────────────────────────────────

    @SuppressLint("MissingPermission")
    private suspend fun connectSpp(device: BluetoothDevice): Boolean = withContext(Dispatchers.IO) {
        Log.d(TAG, "Connecting SPP: ${device.address}")
        val btSocket = device.createRfcommSocketToServiceRecord(UUID.fromString(SPP_UUID))
        try {
            runCatching { adapter?.cancelDiscovery() }
            btSocket.connect()
            input = BufferedInputStream(btSocket.inputStream)
            output = BufferedOutputStream(btSocket.outputStream)
            socket = btSocket
            activeTransport = Transport.SPP
            initializeElm()
            true
        } catch (err: Exception) {
            Log.w(TAG, "SPP connect failed: ${err.message}")
            runCatching { btSocket.close() }
            input = null; output = null; socket = null
            throw err
        }
    }

    // ── ELM327 initialization ──────────────────────────────────────────────────

    private suspend fun initializeElm() {
        sendCommand("ATZ")
        delay(500)          // ELM327 takes ~300ms to reset and print its banner
        sendCommand("ATE0") // echo off
        sendCommand("ATL0") // linefeeds off
        sendCommand("ATS0") // spaces off — removes spaces between hex bytes
        sendCommand("ATH0") // headers off
        sendCommand("ATSP0") // auto-detect OBD protocol
    }

    // ── Command dispatch ───────────────────────────────────────────────────────

    private suspend fun sendCommand(command: String): String? = when (activeTransport) {
        Transport.BLE  -> sendCommandBle(command)
        Transport.SPP  -> sendCommandSpp(command)
        Transport.NONE -> null
    }

    @SuppressLint("MissingPermission")
    private suspend fun sendCommandBle(command: String): String? = withContext(Dispatchers.IO) {
        val char = bleTxChar ?: return@withContext null
        val gatt = bleGatt ?: return@withContext null

        // Drain stale responses before sending
        synchronized(bleRxLock) { bleRxBuffer.clear() }
        while (bleResponseChannel.tryReceive().isSuccess) { }

        val payload = "${command.trim()}\r".toByteArray(Charsets.US_ASCII)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            gatt.writeCharacteristic(char, payload, BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE)
        } else {
            @Suppress("DEPRECATION")
            char.writeType = BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE
            @Suppress("DEPRECATION")
            char.value = payload
            @Suppress("DEPRECATION")
            gatt.writeCharacteristic(char)
        }

        val response = withTimeoutOrNull(CMD_TIMEOUT_MS) { bleResponseChannel.receive() }
        if (response == null) Log.d(TAG, "BLE timeout for: $command")
        response?.let { parseObdResponse(it, command) }
    }

    private suspend fun sendCommandSpp(command: String): String? = withContext(Dispatchers.IO) {
        val out = output ?: return@withContext null
        val inputStream = input ?: return@withContext null
        synchronized(sppLock) {
            drainInput(inputStream)
            out.write("${command.trim()}\r".toByteArray(Charset.forName("US-ASCII")))
            out.flush()

            val response = StringBuilder()
            val buffer = ByteArray(256)
            val deadline = System.currentTimeMillis() + CMD_TIMEOUT_MS
            while (System.currentTimeMillis() < deadline) {
                val read = try {
                    inputStream.read(buffer)
                } catch (_: SocketTimeoutException) {
                    if (response.isNotEmpty()) break else continue
                }
                if (read <= 0) {
                    if (response.isNotEmpty()) break else continue
                }
                val chunk = String(buffer, 0, read, Charset.forName("US-ASCII"))
                response.append(chunk)
                if (chunk.contains(">")) break
            }

            val raw = response.toString()
            if (raw.isBlank()) return@withContext null
            parseObdResponse(raw, command)
        }
    }

    private fun drainInput(inputStream: BufferedInputStream) {
        while (inputStream.available() > 0) {
            if (inputStream.skip(inputStream.available().toLong()) <= 0) break
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
