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
import com.fleetai.driver.obd.ExtendedPidDefinition
import com.fleetai.driver.obd.ExtendedPidProfileCatalog
import com.fleetai.driver.obd.ObdParser
import com.fleetai.driver.obd.ObdService
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

data class ObdRuntimeSnapshot(
    val metrics: Map<String, Double> = emptyMap(),
    val metricUpdatedAt: Map<String, Long> = emptyMap(),
    val standardPlan: List<PidSpec> = emptyList(),
    val extendedPlan: List<ExtendedPidDefinition> = emptyList(),
    val lastPacketAt: Long = 0L
)

object ObdRuntime {
    enum class State { STOPPED, CONNECTING, LIVE, WAITING_FOR_ECU, RETRYING, ERROR }

    private val _state = MutableStateFlow(State.STOPPED)
    val state = _state.asStateFlow()
    private val _status = MutableStateFlow("OBD service stopped")
    val status = _status.asStateFlow()
    private val _snapshot = MutableStateFlow(ObdRuntimeSnapshot())
    val snapshot = _snapshot.asStateFlow()
    private val _debug = MutableStateFlow(TelemetrySender.DebugState(protocol = "OBD2"))
    val debug = _debug.asStateFlow()

    internal fun update(state: State, status: String) {
        _state.value = state
        _status.value = status
    }

    internal fun publish(snapshot: ObdRuntimeSnapshot) {
        _snapshot.value = snapshot
    }

    internal fun publishDebug(debug: TelemetrySender.DebugState) {
        _debug.value = debug
    }

    internal fun clear() {
        _snapshot.value = ObdRuntimeSnapshot()
        _debug.value = TelemetrySender.DebugState(protocol = "OBD2")
        update(State.STOPPED, "OBD service stopped")
    }
}

@SuppressLint("InlinedApi", "ImplicitSamInstance")
class ObdTelemetryService : Service() {
    private data class ReadResult(val values: Map<String, Double>, val error: String? = null)

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val obd = ObdService.manager
    private lateinit var sender: TelemetrySender
    private lateinit var locationTracker: DeviceLocationTracker
    private lateinit var extendedCatalog: ExtendedPidProfileCatalog
    private var managerJob: Job? = null
    private var locationJob: Job? = null
    private var requestedAddress = ""
    private var locationEnabled = false
    private val stopping = AtomicBoolean(false)

    override fun onCreate() {
        super.onCreate()
        sender = TelemetrySender(
            obd = obd,
            resolveVehicleId = { AppGraph.preferences.vehicleId.first().ifBlank { null } },
            resolveDriverId = { AppGraph.preferences.driverId.first().ifBlank { null } },
            resolveDeviceId = { AppGraph.preferences.ensureDeviceId() }
        )
        locationTracker = DeviceLocationTracker(applicationContext)
        extendedCatalog = ExtendedPidProfileCatalog.load(applicationContext)
        locationEnabled = runCatching { kotlinx.coroutines.runBlocking { AppGraph.preferences.locationSharingEnabled.first() } }
            .getOrDefault(false) && locationTracker.start()
        createNotificationChannel()
        promote("Preparing vehicle connection")
        watchLocationPreference()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopping.set(true)
            stopSelf()
            return START_NOT_STICKY
        }
        stopService(Intent(this, J1939TelemetryService::class.java))
        intent?.getStringExtra(EXTRA_DEVICE_ADDRESS)?.trim()?.takeIf(String::isNotBlank)?.let {
            requestedAddress = it
        }
        stopping.set(false)
        if (managerJob?.isActive != true) managerJob = scope.launch { runConnectionLoop() }
        return START_STICKY
    }

    private suspend fun runConnectionLoop() {
        var retryDelay = INITIAL_RETRY_MS
        while (scope.isActive && !stopping.get()) {
            val vehicleId = AppGraph.preferences.vehicleId.first()
            val address = requestedAddress.ifBlank { AppGraph.preferences.obdDeviceAddress.first() }
            if (vehicleId.isBlank() || address.isBlank()) {
                ObdRuntime.update(ObdRuntime.State.ERROR, "Pair a vehicle and choose an OBD adapter")
                updateNotification(ObdRuntime.status.value)
                delay(MAX_RETRY_MS)
                continue
            }
            val device = runCatching { obd.pairedDevices().firstOrNull { it.address == address } }.getOrNull()
            if (device == null) {
                ObdRuntime.update(ObdRuntime.State.ERROR, "Saved OBD adapter is not paired in Android settings")
                updateNotification(ObdRuntime.status.value)
                delay(MAX_RETRY_MS)
                continue
            }

            ObdRuntime.update(
                if (retryDelay == INITIAL_RETRY_MS) ObdRuntime.State.CONNECTING else ObdRuntime.State.RETRYING,
                if (retryDelay == INITIAL_RETRY_MS) "Connecting to OBD adapter" else "OBD disconnected - reconnecting"
            )
            updateNotification(ObdRuntime.status.value)
            val connected = runCatching { obd.connect(device) }.getOrDefault(false)
            if (!connected || !obd.isConnected()) {
                sender.updateSnapshot(emptyMap(), obdConnected = false)
                delay(retryDelay)
                retryDelay = (retryDelay * 2).coerceAtMost(MAX_RETRY_MS)
                continue
            }

            retryDelay = INITIAL_RETRY_MS
            sender.start()
            val supported = runCatching { obd.discoverSupportedPids() }.getOrDefault(emptySet())
            sender.updateObdCapabilities(supported)
            val plan = J1979Spec.pollingPlan(supported)
            val vin = runCatching { obd.readVin() }.getOrNull()
            sender.updateVin(vin)
            val extendedProfile = runCatching { extendedCatalog.match(vin) }.getOrNull()
            sender.updateExtendedProfile(extendedProfile)
            val extendedPlan = extendedProfile?.sensors.orEmpty()
            val disconnected = pollConnectedAdapter(plan, extendedPlan)
            sender.stop()
            sender.updateSnapshot(emptyMap(), obdConnected = false)
            if (disconnected) runCatching { obd.disconnect() }
            if (!stopping.get()) delay(retryDelay)
        }
    }

    private suspend fun pollConnectedAdapter(
        plan: List<PidSpec>,
        extendedPlan: List<ExtendedPidDefinition>
    ): Boolean {
        val latestValues = mutableMapOf<String, Double>()
        val updatedAt = mutableMapOf<String, Long>()
        val lastPolledAt = mutableMapOf<String, Long>()
        if (plan.isEmpty() && extendedPlan.isEmpty()) {
            ObdRuntime.publish(ObdRuntimeSnapshot(standardPlan = plan, extendedPlan = extendedPlan))
            ObdRuntime.update(ObdRuntime.State.WAITING_FOR_ECU, "ECU connected - no supported live PIDs advertised")
            updateNotification(ObdRuntime.status.value)
        }
        while (scope.isActive && !stopping.get() && obd.isConnected()) {
            val now = System.currentTimeMillis()
            val due = plan
                .filter { now - (lastPolledAt[it.command] ?: 0L) >= it.minIntervalMs }
                .sortedByDescending {
                    val overdue = (now - (lastPolledAt[it.command] ?: 0L)).toDouble() / it.minIntervalMs
                    overdue + (2 - it.priority) * 0.5
                }
                .take(if (extendedPlan.isEmpty()) 6 else 5)
            val extendedDue = extendedPlan
                .filter { now - (lastPolledAt[it.command] ?: 0L) >= it.minIntervalMs }
                .sortedByDescending {
                    val overdue = (now - (lastPolledAt[it.command] ?: 0L)).toDouble() / it.minIntervalMs
                    overdue + (3 - it.priority) * 0.5
                }
                .take(1)
            if (due.isEmpty() && extendedDue.isEmpty()) {
                delay(if (plan.isEmpty() && extendedPlan.isEmpty()) 1_000L else 100L)
                continue
            }

            var successfulReads = 0
            due.forEach { spec ->
                val result = readPidMetrics(spec.command)
                lastPolledAt[spec.command] = System.currentTimeMillis()
                result.values.forEach { (key, value) ->
                    successfulReads += 1
                    latestValues[key] = value
                    updatedAt[key] = System.currentTimeMillis()
                }
            }
            extendedDue.forEach { definition ->
                val reading = runCatching { obd.readExtendedPid(definition) }.getOrNull()
                lastPolledAt[definition.command] = System.currentTimeMillis()
                if (reading != null) {
                    successfulReads += 1
                    latestValues[reading.key] = reading.value
                    updatedAt[reading.key] = System.currentTimeMillis()
                }
            }
            expireStale(plan, extendedPlan, latestValues, updatedAt, now)
            val boostSourceAt = maxOf(updatedAt["mapKpa"] ?: 0L, updatedAt["barometricPressureKpa"] ?: 0L)
            deriveBoost(latestValues["mapKpa"], latestValues["barometricPressureKpa"])?.let {
                latestValues["boostPsi"] = it
                updatedAt["boostPsi"] = boostSourceAt
            }
            val lastPacketAt = updatedAt.values.maxOrNull() ?: 0L
            val liveCount = updatedAt.values.count { now - it <= ECU_DATA_SILENCE_MS }
            val live = successfulReads > 0 || (lastPacketAt > 0 && now - lastPacketAt <= ECU_DATA_SILENCE_MS)
            sender.updateLocation(locationTracker.latestFresh())
            sender.updateSnapshot(latestValues.toMap(), true, lastPacketAt, updatedAt.toMap())
            ObdRuntime.publish(
                ObdRuntimeSnapshot(latestValues.toMap(), updatedAt.toMap(), plan, extendedPlan, lastPacketAt)
            )
            ObdRuntime.publishDebug(sender.debug)
            val status = if (live && liveCount > 0) {
                "Live vehicle data - $liveCount of ${plan.size + extendedPlan.size} supported signals"
            } else {
                "Adapter connected - waiting for ECU data"
            }
            ObdRuntime.update(if (live) ObdRuntime.State.LIVE else ObdRuntime.State.WAITING_FOR_ECU, status)
            updateNotification(status)
            delay(100L)
        }
        return !obd.isConnected()
    }

    private suspend fun readPidMetrics(command: String): ReadResult {
        return try {
            val raw = obd.readPid(command) ?: return ReadResult(emptyMap(), "No response from adapter")
            val parsed = ObdParser.parsePid(command, raw)
            val valid = parsed.filter { (key, value) -> J1979Spec.isPlausible(key, value) }
            ReadResult(valid, if (valid.isEmpty()) "No validated ECU value" else null)
        } catch (error: Exception) {
            ReadResult(emptyMap(), error.message ?: "obd_read_error")
        }
    }

    private fun expireStale(
        plan: List<PidSpec>,
        extendedPlan: List<ExtendedPidDefinition>,
        values: MutableMap<String, Double>,
        updatedAt: MutableMap<String, Long>,
        now: Long
    ) {
        plan.forEach { spec ->
            if (now - (updatedAt[spec.key] ?: 0L) > (spec.minIntervalMs * 4).coerceIn(30_000L, 120_000L)) {
                values.remove(spec.key)
                updatedAt.remove(spec.key)
            }
        }
        extendedPlan.forEach { definition ->
            if (now - (updatedAt[definition.key] ?: 0L) > (definition.minIntervalMs * 4).coerceIn(30_000L, 120_000L)) {
                values.remove(definition.key)
                updatedAt.remove(definition.key)
            }
        }
    }

    private fun watchLocationPreference() {
        locationJob = scope.launch {
            AppGraph.preferences.locationSharingEnabled.collect { enabled ->
                locationEnabled = enabled && locationTracker.start()
                if (!enabled) locationTracker.stop()
                if (!locationEnabled) sender.updateLocation(null)
                promote(ObdRuntime.status.value)
            }
        }
    }

    private fun promote(text: String) {
        ServiceCompat.startForeground(
            this,
            NOTIFICATION_ID,
            notification(text),
            ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE or
                (if (locationEnabled) ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION else 0)
        )
    }

    private fun createNotificationChannel() {
        (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).createNotificationChannel(
            NotificationChannel(CHANNEL_ID, "Vehicle telemetry", NotificationManager.IMPORTANCE_LOW).apply {
                description = "Keeps the OBD adapter connected and saves vehicle sensor data"
            }
        )
    }

    private fun notification(text: String) = NotificationCompat.Builder(this, CHANNEL_ID)
        .setSmallIcon(R.drawable.ic_stat_fleet_ai)
        .setContentTitle("Fleet AI vehicle telemetry")
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
                2,
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
        stopping.set(true)
        sender.stop()
        sender.updateSnapshot(emptyMap(), obdConnected = false)
        locationTracker.stop()
        managerJob?.cancel()
        locationJob?.cancel()
        runCatching { kotlinx.coroutines.runBlocking { obd.disconnect() } }
        scope.cancel()
        ObdRuntime.clear()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    companion object {
        const val ACTION_START = "com.fleetai.driver.action.START_OBD"
        const val ACTION_STOP = "com.fleetai.driver.action.STOP_OBD"
        private const val EXTRA_DEVICE_ADDRESS = "obd_device_address"
        private const val CHANNEL_ID = "fleetai_obd_telemetry"
        private const val NOTIFICATION_ID = 1979
        private const val INITIAL_RETRY_MS = 2_000L
        private const val MAX_RETRY_MS = 30_000L
        private const val ECU_DATA_SILENCE_MS = 10_000L

        fun startIntent(context: Context, address: String = "") = Intent(context, ObdTelemetryService::class.java)
            .setAction(ACTION_START)
            .putExtra(EXTRA_DEVICE_ADDRESS, address)

        fun stopIntent(context: Context) = Intent(context, ObdTelemetryService::class.java).setAction(ACTION_STOP)

        private fun deriveBoost(map: Double?, baro: Double?): Double? {
            if (map == null) return null
            return ((map - (baro ?: 101.3)) / 6.89476).coerceAtLeast(0.0)
        }
    }
}
