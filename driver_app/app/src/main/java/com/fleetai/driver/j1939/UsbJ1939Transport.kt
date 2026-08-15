package com.fleetai.driver.j1939

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbManager
import android.os.Build
import com.hoho.android.usbserial.driver.UsbSerialPort
import com.hoho.android.usbserial.driver.UsbSerialProber
import java.io.Closeable
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull

data class UsbJ1939AdapterInfo(
    val deviceId: Int,
    val vendorId: Int,
    val productId: Int,
    val manufacturer: String,
    val product: String,
    val serialNumber: String?
)

data class UsbJ1939Diagnostics(
    val connected: Boolean = false,
    val bitrate: Int? = null,
    val bytesReceived: Long = 0,
    val framesReceived: Long = 0,
    val rejectedRecords: Long = 0,
    val reconnectCount: Int = 0,
    val connectedAtEpochMs: Long = 0,
    val lastFrameAtEpochMs: Long = 0,
    val lastError: String = ""
)

/**
 * USB host transport for SLCAN/Lawicel-compatible CAN interfaces.
 *
 * The adapter is opened at 250 or 500 kbit/s in listen-only mode. Fleet AI
 * intentionally refuses adapters that reject listen-only mode; silently
 * opening an active CAN controller is not acceptable on a production truck.
 */
class UsbJ1939Transport(private val context: Context) : Closeable {
    private val usbManager = context.getSystemService(Context.USB_SERVICE) as UsbManager
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val codec = SlcanCodec()
    private val _frames = MutableSharedFlow<CanFrame>(extraBufferCapacity = 2048)
    val frames: SharedFlow<CanFrame> = _frames
    private val _diagnostics = MutableStateFlow(UsbJ1939Diagnostics())
    val diagnostics: StateFlow<UsbJ1939Diagnostics> = _diagnostics.asStateFlow()

    @Volatile private var port: UsbSerialPort? = null
    @Volatile private var connectionJob: Job? = null
    @Volatile var adapterInfo: UsbJ1939AdapterInfo? = null
        private set
    @Volatile var lastError: String = ""
        private set
    @Volatile var activeBitrate: Int? = null
        private set

    fun attachedAdapters(): List<UsbJ1939AdapterInfo> =
        UsbSerialProber.getDefaultProber().findAllDrivers(usbManager).map { driver -> driver.device.toInfo() }

    suspend fun connect(
        deviceId: Int? = null,
        profile: J1939BusProfile = J1939BusProfile.AUTO
    ): Result<UsbJ1939AdapterInfo> = withContext(Dispatchers.IO) {
        disconnect()
        val driver = UsbSerialProber.getDefaultProber().findAllDrivers(usbManager)
            .firstOrNull { deviceId == null || it.device.deviceId == deviceId }
            ?: return@withContext Result.failure(IllegalStateException("No supported USB serial CAN adapter is attached"))
        val device = driver.device
        if (!usbManager.hasPermission(device) && !requestPermission(device)) {
            return@withContext Result.failure(SecurityException("USB permission was not granted"))
        }
        val connection = usbManager.openDevice(device)
            ?: return@withContext Result.failure(IllegalStateException("Android could not open the USB adapter"))
        val serialPort = driver.ports.firstOrNull()
            ?: return@withContext Result.failure(IllegalStateException("USB adapter has no serial port"))
        try {
            serialPort.open(connection)
            serialPort.setParameters(115200, 8, UsbSerialPort.STOPBITS_1, UsbSerialPort.PARITY_NONE)
            runCatching { serialPort.dtr = true }
            runCatching { serialPort.rts = true }
            val selectedBitrate = selectBitrate(serialPort, profile)
            port = serialPort
            adapterInfo = device.toInfo()
            activeBitrate = selectedBitrate
            lastError = ""
            _diagnostics.value = _diagnostics.value.copy(
                connected = true,
                bitrate = selectedBitrate,
                reconnectCount = _diagnostics.value.reconnectCount + 1,
                connectedAtEpochMs = System.currentTimeMillis(),
                lastError = ""
            )
            connectionJob = scope.launch { readLoop(serialPort) }
            Result.success(adapterInfo!!)
        } catch (error: Exception) {
            lastError = error.message ?: "USB J1939 connection failed"
            _diagnostics.value = _diagnostics.value.copy(connected = false, lastError = lastError)
            runCatching { serialPort.close() }
            runCatching { connection.close() }
            Result.failure(error)
        }
    }

    fun isConnected(): Boolean = port?.isOpen == true && connectionJob?.isActive == true

    suspend fun disconnect() = withContext(Dispatchers.IO) {
        val previousJob = connectionJob
        connectionJob = null
        previousJob?.cancel()
        val previousPort = port
        port = null
        if (previousPort != null) {
            runCatching { previousPort.write(SlcanCodec.CLOSE.toByteArray(Charsets.US_ASCII), WRITE_TIMEOUT_MS) }
            runCatching { previousPort.close() }
        }
        adapterInfo = null
        activeBitrate = null
        _diagnostics.value = _diagnostics.value.copy(connected = false, bitrate = null)
    }

    private fun configureListenOnly(serialPort: UsbSerialPort, bitrate: Int) {
        sendCommand(serialPort, SlcanCodec.CLOSE, "close")
        val bitrateCommand = when (bitrate) {
            250_000 -> SlcanCodec.SET_J1939_250K
            500_000 -> SlcanCodec.SET_J1939_500K
            else -> throw IllegalArgumentException("Unsupported J1939 bitrate: $bitrate")
        }
        sendCommand(serialPort, bitrateCommand, "set ${bitrate / 1_000} kbit/s")
        sendCommand(serialPort, SlcanCodec.ENABLE_TIMESTAMPS, "enable timestamps")
        sendCommand(serialPort, SlcanCodec.OPEN_LISTEN_ONLY, "open listen-only")
    }

    private fun selectBitrate(serialPort: UsbSerialPort, profile: J1939BusProfile): Int {
        val candidates = profile.bitrate?.let { listOf(it) } ?: listOf(250_000, 500_000)
        for (bitrate in candidates) {
            codec.reset()
            configureListenOnly(serialPort, bitrate)
            val observed = probeForJ1939(serialPort)
            if (observed.isNotEmpty()) {
                observed.forEach { _frames.tryEmit(it) }
                return bitrate
            }
        }
        throw IllegalStateException(
            "No valid J1939 traffic detected at ${candidates.joinToString(" or ") { "${it / 1_000} kbit/s" }}. " +
                "Check ignition, connector type, harness, and adapter."
        )
    }

    private fun probeForJ1939(serialPort: UsbSerialPort): List<CanFrame> {
        val deadline = System.currentTimeMillis() + PROBE_WINDOW_MS
        val bytes = ByteArray(4096)
        val observed = mutableListOf<CanFrame>()
        while (System.currentTimeMillis() < deadline && observed.size < PROBE_FRAME_TARGET) {
            val count = serialPort.read(bytes, PROBE_READ_TIMEOUT_MS)
            if (count <= 0) continue
            val result = codec.feedDetailed(bytes.copyOf(count))
            recordRead(count, result)
            observed += result.frames.filter { it.extended }
        }
        return observed
    }

    private fun sendCommand(serialPort: UsbSerialPort, command: String, operation: String) {
        serialPort.write(command.toByteArray(Charsets.US_ASCII), WRITE_TIMEOUT_MS)
        val response = ByteArray(64)
        val length = serialPort.read(response, COMMAND_TIMEOUT_MS)
        if (length <= 0) throw IllegalStateException("SLCAN adapter did not acknowledge: $operation")
        if (response.take(length).any { it.toInt() == 7 }) {
            throw IllegalStateException("SLCAN adapter rejected command: $operation")
        }
        if (response.take(length).none { it.toInt() == 13 }) {
            throw IllegalStateException("Invalid SLCAN acknowledgement: $operation")
        }
    }

    private suspend fun readLoop(serialPort: UsbSerialPort) {
        val bytes = ByteArray(4096)
        while (serialPort.isOpen) {
            try {
                val count = serialPort.read(bytes, READ_TIMEOUT_MS)
                if (count > 0) {
                    val chunk = bytes.copyOf(count)
                    val result = codec.feedDetailed(chunk)
                    recordRead(count, result)
                    result.frames.forEach { frame -> _frames.emit(frame) }
                }
            } catch (error: Exception) {
                lastError = error.message ?: "USB read failed"
                _diagnostics.value = _diagnostics.value.copy(connected = false, lastError = lastError)
                break
            }
            delay(1)
        }
    }

    private fun recordRead(byteCount: Int, result: SlcanCodec.FeedResult) {
        val lastFrameAt = result.frames.maxOfOrNull { it.capturedAtEpochMs } ?: _diagnostics.value.lastFrameAtEpochMs
        _diagnostics.value = _diagnostics.value.copy(
            bytesReceived = _diagnostics.value.bytesReceived + byteCount,
            framesReceived = _diagnostics.value.framesReceived + result.frames.size,
            rejectedRecords = _diagnostics.value.rejectedRecords + result.rejectedRecords,
            lastFrameAtEpochMs = lastFrameAt
        )
    }

    private suspend fun requestPermission(device: UsbDevice): Boolean {
        val deferred = CompletableDeferred<Boolean>()
        val action = "${context.packageName}.USB_PERMISSION.${device.deviceId}"
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(receiverContext: Context?, intent: Intent?) {
                if (intent?.action != action) return
                val returned = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    intent.getParcelableExtra(UsbManager.EXTRA_DEVICE, UsbDevice::class.java)
                } else {
                    @Suppress("DEPRECATION")
                    intent.getParcelableExtra(UsbManager.EXTRA_DEVICE)
                }
                if (returned?.deviceId == device.deviceId) {
                    deferred.complete(intent.getBooleanExtra(UsbManager.EXTRA_PERMISSION_GRANTED, false))
                }
            }
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            context.registerReceiver(receiver, IntentFilter(action), Context.RECEIVER_NOT_EXPORTED)
        } else {
            @Suppress("DEPRECATION")
            context.registerReceiver(receiver, IntentFilter(action))
        }
        return try {
            val flags = PendingIntent.FLAG_UPDATE_CURRENT or
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0
            val pendingIntent = PendingIntent.getBroadcast(context, device.deviceId, Intent(action).setPackage(context.packageName), flags)
            usbManager.requestPermission(device, pendingIntent)
            withTimeoutOrNull(PERMISSION_TIMEOUT_MS) { deferred.await() } ?: false
        } finally {
            runCatching { context.unregisterReceiver(receiver) }
        }
    }

    override fun close() {
        connectionJob?.cancel()
        connectionJob = null
        val previousPort = port
        port = null
        if (previousPort != null) {
            runCatching { previousPort.write(SlcanCodec.CLOSE.toByteArray(Charsets.US_ASCII), WRITE_TIMEOUT_MS) }
            runCatching { previousPort.close() }
        }
        adapterInfo = null
        activeBitrate = null
        _diagnostics.value = _diagnostics.value.copy(connected = false, bitrate = null)
        scope.cancel()
    }

    private fun UsbDevice.toInfo() = UsbJ1939AdapterInfo(
        deviceId = deviceId,
        vendorId = vendorId,
        productId = productId,
        manufacturer = runCatching { manufacturerName }.getOrNull().orEmpty(),
        product = runCatching { productName }.getOrNull().orEmpty(),
        serialNumber = runCatching { serialNumber }.getOrNull()
    )

    companion object {
        private const val WRITE_TIMEOUT_MS = 1_000
        private const val COMMAND_TIMEOUT_MS = 1_000
        private const val READ_TIMEOUT_MS = 250
        private const val PROBE_READ_TIMEOUT_MS = 200
        private const val PROBE_WINDOW_MS = 2_500L
        private const val PROBE_FRAME_TARGET = 3
        private const val PERMISSION_TIMEOUT_MS = 30_000L
    }
}
