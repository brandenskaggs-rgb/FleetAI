package com.fleetai.driver.telemetry

import android.annotation.SuppressLint
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import com.fleetai.driver.AppGraph
import com.fleetai.driver.MainActivity
import com.fleetai.driver.R
import com.fleetai.driver.j1939.J1939BusProfile
import com.fleetai.driver.j1939.J1939ConnectorProfile
import com.fleetai.driver.j1939.J1939Decoder
import com.fleetai.driver.j1939.UsbJ1939Transport
import com.fleetai.driver.j1939.UsbJ1939Diagnostics
import com.fleetai.driver.network.TelemetryAdapterDto
import com.fleetai.driver.obd.ObdService
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking

object J1939Runtime {
    enum class State { STOPPED, CONNECTING, STREAMING, RETRYING, ERROR }

    private val _state = MutableStateFlow(State.STOPPED)
    val state = _state.asStateFlow()
    private val _status = MutableStateFlow("J1939 service stopped")
    val status = _status.asStateFlow()
    private val _metrics = MutableStateFlow<Map<String, Double>>(emptyMap())
    val metrics = _metrics.asStateFlow()
    private val _lastFrameAt = MutableStateFlow(0L)
    val lastFrameAt = _lastFrameAt.asStateFlow()
    private val _debug = MutableStateFlow(TelemetrySender.DebugState(protocol = "J1939"))
    val debug = _debug.asStateFlow()
    private val _transport = MutableStateFlow(UsbJ1939Diagnostics())
    val transport = _transport.asStateFlow()

    internal fun update(state: State, status: String) {
        _status.value = status
        _state.value = state
    }

    internal fun publish(metrics: Map<String, Double>, timestamp: Long) {
        _metrics.value = metrics.toMap()
        _lastFrameAt.value = timestamp
    }

    internal fun publishDebug(debug: TelemetrySender.DebugState) {
        _debug.value = debug
    }

    internal fun publishTransport(diagnostics: UsbJ1939Diagnostics) {
        _transport.value = diagnostics
    }

    internal fun clear() {
        _metrics.value = emptyMap()
        _lastFrameAt.value = 0L
        _transport.value = UsbJ1939Diagnostics()
        update(State.STOPPED, "J1939 service stopped")
    }
}

@SuppressLint("InlinedApi")
class J1939TelemetryService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private lateinit var transport: UsbJ1939Transport
    private lateinit var sender: TelemetrySender
    private lateinit var locationTracker: DeviceLocationTracker
    private var locationEnabled = false
    private val decoder = J1939Decoder()
    private var managerJob: Job? = null
    private var frameJob: Job? = null
    private var diagnosticsJob: Job? = null
    private val latestMetrics = mutableMapOf<String, Double>()
    private var busProfile = J1939BusProfile.AUTO
    private var connectorProfile = J1939ConnectorProfile.UNKNOWN
    private var profileProvided = false

    override fun onCreate() {
        super.onCreate()
        transport = UsbJ1939Transport(applicationContext)
        sender = TelemetrySender(
            obd = ObdService.manager,
            resolveVehicleId = { AppGraph.preferences.vehicleId.first().ifBlank { null } },
            resolveDriverId = { AppGraph.preferences.driverId.first().ifBlank { null } },
            resolveDeviceId = { AppGraph.preferences.ensureDeviceId() }
        )
        locationTracker = DeviceLocationTracker(applicationContext)
        locationEnabled = runBlocking { AppGraph.preferences.locationSharingEnabled.first() } && locationTracker.start()
        createNotificationChannel()
        ServiceCompat.startForeground(
            this,
            NOTIFICATION_ID,
            notification("Connecting to truck network"),
            ServiceInfo.FOREGROUND_SERVICE_TYPE_SHORT_SERVICE
        )
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopSelf()
            return START_NOT_STICKY
        }
        if (intent?.hasExtra(EXTRA_BUS_PROFILE) == true) {
            busProfile = J1939BusProfile.fromStored(intent.getStringExtra(EXTRA_BUS_PROFILE))
            connectorProfile = J1939ConnectorProfile.fromStored(intent.getStringExtra(EXTRA_CONNECTOR_PROFILE))
            profileProvided = true
        }
        if (managerJob?.isActive != true) startManager()
        return START_STICKY
    }

    private fun startManager() {
        diagnosticsJob = scope.launch {
            transport.diagnostics.collect { diagnostics ->
                J1939Runtime.publishTransport(diagnostics)
                sender.updateJ1939TransportDiagnostics(diagnostics, connectorProfile.name)
            }
        }
        frameJob = scope.launch {
            transport.frames.collect { frame ->
                sender.updateLocation(locationTracker.latest)
                sender.updateJ1939Frame(frame)
                val decoded = decoder.decode(frame)
                sender.updateJ1939Decode(decoded)
                latestMetrics.putAll(decoded.metrics)
                sender.updateSnapshot(latestMetrics, obdConnected = true, packetAt = frame.capturedAtEpochMs)
                J1939Runtime.publish(latestMetrics, frame.capturedAtEpochMs)
            }
        }
        managerJob = scope.launch {
            if (!profileProvided) {
                busProfile = AppGraph.preferences.j1939BusProfile.first()
                connectorProfile = AppGraph.preferences.j1939ConnectorProfile.first()
            }
            if (AppGraph.preferences.vehicleId.first().isBlank()) {
                J1939Runtime.update(J1939Runtime.State.ERROR, "Pair this tablet to a vehicle before starting J1939")
                stopSelf()
                return@launch
            }
            var senderStarted = false
            var retryDelay = 1_000L
            while (isActive) {
                if (!transport.isConnected()) {
                    J1939Runtime.update(
                        if (senderStarted) J1939Runtime.State.RETRYING else J1939Runtime.State.CONNECTING,
                        if (senderStarted) "J1939 disconnected - retrying" else "Connecting J1939 interface"
                    )
                    updateNotification(J1939Runtime.status.value)
                    val result = transport.connect(profile = busProfile)
                    if (result.isFailure) {
                        val failure = result.exceptionOrNull()
                        val message = failure?.message ?: "J1939 connection failed"
                        J1939Runtime.update(J1939Runtime.State.ERROR, message)
                        updateNotification(message)
                        if (failure is SecurityException) {
                            stopSelf()
                            return@launch
                        }
                        delay(retryDelay)
                        retryDelay = (retryDelay * 2).coerceAtMost(30_000L)
                        continue
                    }
                    val info = result.getOrThrow()
                    val adapter = TelemetryAdapterDto(
                        transport = "USB_SLCAN",
                        protocol = "J1939",
                        manufacturer = info.manufacturer,
                        product = info.product,
                        serialNumber = info.serialNumber,
                        bitrate = transport.activeBitrate ?: 250_000,
                        connectorProfile = connectorProfile.name
                    )
                    ServiceCompat.startForeground(
                        this@J1939TelemetryService,
                        NOTIFICATION_ID,
                        notification("Reading truck data in listen-only mode"),
                        ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE or
                            (if (locationEnabled) ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION else 0)
                    )
                    if (!senderStarted) {
                        sender.start(
                            "J1939",
                            adapter
                        )
                        senderStarted = true
                    } else {
                        sender.updateAdapter(adapter)
                    }
                    retryDelay = 1_000L
                    val bitrateLabel = "${(transport.activeBitrate ?: 0) / 1_000} kbit/s"
                    J1939Runtime.update(J1939Runtime.State.STREAMING, "J1939 live - $bitrateLabel listen only")
                    updateNotification("Reading truck data at $bitrateLabel in listen-only mode")
                }
                val lastFrameAt = transport.diagnostics.value.lastFrameAtEpochMs
                if (transport.isConnected() && lastFrameAt > 0 && System.currentTimeMillis() - lastFrameAt > BUS_STALE_MS) {
                    J1939Runtime.update(J1939Runtime.State.RETRYING, "Truck network silent - checking bus speed and connection")
                    updateNotification(J1939Runtime.status.value)
                    transport.disconnect()
                    delay(1_000)
                    continue
                }
                J1939Runtime.publishDebug(sender.debug)
                delay(1_000)
            }
        }
    }

    private fun createNotificationChannel() {
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, "Truck telemetry", NotificationManager.IMPORTANCE_LOW).apply {
                description = "Keeps the approved J1939 interface connected while driving"
            }
        )
    }

    private fun notification(text: String) = NotificationCompat.Builder(this, CHANNEL_ID)
        .setSmallIcon(R.drawable.ic_stat_fleet_ai)
        .setContentTitle("Fleet AI truck telemetry")
        .setContentText(text)
        .setContentIntent(
            PendingIntent.getActivity(
                this,
                0,
                Intent(this, MainActivity::class.java),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
        )
        .addAction(
            0,
            "Stop",
            PendingIntent.getService(
                this,
                1,
                stopIntent(this),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
        )
        .setOngoing(true)
        .setOnlyAlertOnce(true)
        .build()

    private fun updateNotification(text: String) {
        (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).notify(NOTIFICATION_ID, notification(text))
    }

    override fun onDestroy() {
        sender.stop()
        locationTracker.stop()
        managerJob?.cancel()
        frameJob?.cancel()
        diagnosticsJob?.cancel()
        transport.close()
        scope.cancel()
        J1939Runtime.clear()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onTimeout(startId: Int) {
        stopSelf(startId)
    }

    override fun onTimeout(startId: Int, fgsType: Int) {
        stopSelf(startId)
    }

    companion object {
        const val ACTION_START = "com.fleetai.driver.action.START_J1939"
        const val ACTION_STOP = "com.fleetai.driver.action.STOP_J1939"
        private const val CHANNEL_ID = "fleetai_truck_telemetry"
        private const val NOTIFICATION_ID = 1939
        private const val EXTRA_BUS_PROFILE = "j1939_bus_profile"
        private const val EXTRA_CONNECTOR_PROFILE = "j1939_connector_profile"
        private const val BUS_STALE_MS = 7_000L

        fun startIntent(
            context: Context,
            busProfile: J1939BusProfile = J1939BusProfile.AUTO,
            connectorProfile: J1939ConnectorProfile = J1939ConnectorProfile.UNKNOWN
        ) = Intent(context, J1939TelemetryService::class.java)
            .setAction(ACTION_START)
            .putExtra(EXTRA_BUS_PROFILE, busProfile.name)
            .putExtra(EXTRA_CONNECTOR_PROFILE, connectorProfile.name)
        fun stopIntent(context: Context) = Intent(context, J1939TelemetryService::class.java).setAction(ACTION_STOP)
    }
}
