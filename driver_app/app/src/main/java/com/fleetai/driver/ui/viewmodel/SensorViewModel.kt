package com.fleetai.driver.ui.viewmodel

import android.bluetooth.BluetoothDevice
import android.util.Log
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.core.content.ContextCompat
import com.fleetai.driver.data.local.AppPreferences
import com.fleetai.driver.data.model.SensorReading
import com.fleetai.driver.data.model.SensorStatus
import com.fleetai.driver.data.model.Trend
import com.fleetai.driver.obd.ObdParser
import com.fleetai.driver.obd.ObdService
import com.fleetai.driver.obd.ExtendedPidDefinition
import com.fleetai.driver.obd.ExtendedPidProfileCatalog
import com.fleetai.driver.j1939.UsbJ1939Transport
import com.fleetai.driver.j1939.J1939BusProfile
import com.fleetai.driver.j1939.J1939ConnectorProfile
import com.fleetai.driver.telemetry.J1939Runtime
import com.fleetai.driver.telemetry.J1939TelemetryService
import com.fleetai.driver.telemetry.J1979Spec
import com.fleetai.driver.telemetry.PidSpec
import com.fleetai.driver.telemetry.TelemetrySender
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlin.random.Random

class SensorViewModel(private val preferences: AppPreferences) : ViewModel() {
    data class UnitPrefs(val tempF: Boolean = true, val speedMph: Boolean = true)
    private data class PidReadResult(val value: Double?, val error: String?)
    private data class PidMetricsReadResult(val values: Map<String, Double>, val error: String?)

    private val obd = ObdService.manager
    private val extendedPidCatalog by lazy {
        ExtendedPidProfileCatalog.load(com.fleetai.driver.AppGraph.appContext)
    }
    private val usbJ1939 = UsbJ1939Transport(com.fleetai.driver.AppGraph.appContext)
    private val sender = TelemetrySender(
        obd = obd,
        resolveVehicleId = { preferences.vehicleId.first().ifBlank { null } },
        resolveDriverId = { preferences.driverId.first().ifBlank { null } },
        resolveDeviceId = { preferences.ensureDeviceId() }
    )

    private val _status = MutableStateFlow("Not connected")
    val status: StateFlow<String> = _status

    private val _demoMode = MutableStateFlow(false)
    val demoMode: StateFlow<Boolean> = _demoMode

    private val _savedDevice = MutableStateFlow<String>("")
    val savedDevice: StateFlow<String> = _savedDevice

    private val _readings = MutableStateFlow<List<SensorReading>>(emptyList())
    val readings: StateFlow<List<SensorReading>> = _readings

    private val _debug = MutableStateFlow(sender.debug)
    val debug: StateFlow<TelemetrySender.DebugState> = _debug

    private val _unitPrefs = MutableStateFlow(UnitPrefs())
    val unitPrefs: StateFlow<UnitPrefs> = _unitPrefs

    private val _j1939BusProfile = MutableStateFlow(J1939BusProfile.AUTO)
    val j1939BusProfile: StateFlow<J1939BusProfile> = _j1939BusProfile

    private val _j1939ConnectorProfile = MutableStateFlow(J1939ConnectorProfile.UNKNOWN)
    val j1939ConnectorProfile: StateFlow<J1939ConnectorProfile> = _j1939ConnectorProfile

    private var pollJob: Job? = null
    private var debugJob: Job? = null
    private var j1939RuntimeJob: Job? = null
    private var j1939MetricsJob: Job? = null
    private val ema = mutableMapOf<String, Double>()
    private val history = mutableMapOf<String, MutableList<Double>>()
    private val lastGood = mutableMapOf<String, Pair<Double, Long>>()
    private val valueTtlMs = 30_000L
    private var lastReadError: String? = null

    init {
        viewModelScope.launch {
            _demoMode.value = preferences.demoMode.first()
            _savedDevice.value = preferences.obdDeviceAddress.first()
            _j1939BusProfile.value = preferences.j1939BusProfile.first()
            _j1939ConnectorProfile.value = preferences.j1939ConnectorProfile.first()
            if (_demoMode.value) {
                _status.value = "Demo mode"
                startDemo()
            } else if (_savedDevice.value.isNotBlank()) {
                reconnectSavedDevice()
            }
        }
        debugJob = viewModelScope.launch {
            // keep debug state flowing even if not connected
            while (isActive) {
                _debug.value = if (J1939Runtime.state.value == J1939Runtime.State.STOPPED) {
                    sender.debug
                } else {
                    J1939Runtime.debug.value.copy(protocol = "J1939", lastObdReadAt = J1939Runtime.lastFrameAt.value)
                }
                delay(1000)
            }
        }
        j1939RuntimeJob = viewModelScope.launch {
            J1939Runtime.state.collect { runtimeState ->
                if (runtimeState != J1939Runtime.State.STOPPED) {
                    _status.value = J1939Runtime.status.value
                    _debug.value = _debug.value.copy(protocol = "J1939")
                }
            }
        }
        j1939MetricsJob = viewModelScope.launch {
            J1939Runtime.metrics.collect { metrics ->
                if (metrics.isNotEmpty()) {
                    val timestamp = J1939Runtime.lastFrameAt.value
                    _readings.value = buildJ1939Readings(metrics, timestamp)
                    _debug.value = _debug.value.copy(protocol = "J1939", lastObdReadAt = timestamp)
                }
            }
        }
    }

    fun pairedDevices(): List<BluetoothDevice> = obd.pairedDevices().toList()

    fun hasBluetooth(): Boolean = obd.hasBluetooth()

    fun usbAdapters() = usbJ1939.attachedAdapters()

    fun connectUsbJ1939() {
        stopPolling(resetReadings = true)
        sender.stop()
        viewModelScope.launch { runCatching { obd.disconnect() } }
        _status.value = "Connecting J1939 interface..."
        ContextCompat.startForegroundService(
            com.fleetai.driver.AppGraph.appContext,
            J1939TelemetryService.startIntent(
                com.fleetai.driver.AppGraph.appContext,
                _j1939BusProfile.value,
                _j1939ConnectorProfile.value
            )
        )
    }

    fun setJ1939BusProfile(profile: J1939BusProfile) {
        _j1939BusProfile.value = profile
        viewModelScope.launch { preferences.setJ1939BusProfile(profile) }
    }

    fun setJ1939ConnectorProfile(profile: J1939ConnectorProfile) {
        _j1939ConnectorProfile.value = profile
        viewModelScope.launch { preferences.setJ1939ConnectorProfile(profile) }
    }

    fun toggleDemo(enabled: Boolean) {
        viewModelScope.launch {
            preferences.setDemoMode(enabled)
            _demoMode.value = enabled
            if (enabled) {
                com.fleetai.driver.AppGraph.appContext.startService(
                    J1939TelemetryService.stopIntent(com.fleetai.driver.AppGraph.appContext)
                )
                stopPolling(resetReadings = true)
                runCatching { obd.disconnect() }
                sender.stop()
                _status.value = "Demo mode"
                startDemo()
            } else {
                stopPolling(resetReadings = true)
                sender.stop()
                _status.value = "Not connected"
            }
        }
    }

    fun connect(device: BluetoothDevice) {
        viewModelScope.launch {
            try {
                com.fleetai.driver.AppGraph.appContext.startService(
                    J1939TelemetryService.stopIntent(com.fleetai.driver.AppGraph.appContext)
                )
                stopPolling(resetReadings = true)
                sender.stop()
                _status.value = "Connecting..."
                val connected = obd.connect(device)
                if (!connected || !obd.isConnected()) {
                    _status.value = "Connection failed"
                    return@launch
                }
                _status.value = "Connected"
                preferences.saveObdDeviceAddress(device.address)
                _savedDevice.value = device.address
                startPolling()
                sender.start()
            } catch (_: SecurityException) {
                _status.value = "Bluetooth permission required"
            } catch (_: Exception) {
                sender.stop()
                stopPolling(resetReadings = true)
                _status.value = "Connection failed"
            }
        }
    }

    fun disconnect() {
        viewModelScope.launch {
            sender.stop()
            com.fleetai.driver.AppGraph.appContext.startService(
                J1939TelemetryService.stopIntent(com.fleetai.driver.AppGraph.appContext)
            )
            runCatching { obd.disconnect() }
            _status.value = "Not connected"
            preferences.clearObdDeviceAddress()
            _savedDevice.value = ""
            stopPolling(resetReadings = true)
        }
    }

    fun toggleUnits(tempF: Boolean? = null, speedMph: Boolean? = null) {
        val current = _unitPrefs.value
        _unitPrefs.value = current.copy(
            tempF = tempF ?: current.tempF,
            speedMph = speedMph ?: current.speedMph
        )
    }

    private fun reconnectSavedDevice() {
        viewModelScope.launch {
            val address = _savedDevice.value
            if (address.isBlank()) return@launch
            val device = pairedDevices().firstOrNull { it.address == address }
            if (device == null) {
                _status.value = "Saved dongle not paired"
                return@launch
            }
            try {
                stopPolling(resetReadings = true)
                sender.stop()
                _status.value = "Reconnecting..."
                val connected = obd.connect(device)
                if (!connected || !obd.isConnected()) {
                    _status.value = "Reconnect failed"
                    return@launch
                }
                _status.value = "Connected"
                startPolling()
                sender.start()
            } catch (_: SecurityException) {
                _status.value = "Bluetooth permission required"
            } catch (_: Exception) {
                sender.stop()
                stopPolling(resetReadings = true)
                _status.value = "Reconnect failed"
            }
        }
    }

    private fun startPolling() {
        stopPolling()
        pollJob = viewModelScope.launch(Dispatchers.IO) {
            val supported = runCatching { obd.discoverSupportedPids() }.getOrDefault(emptySet())
            sender.updateObdCapabilities(supported)
            val plan = J1979Spec.pollingPlan(supported)
            val vin = runCatching { obd.readVin() }.getOrNull()
            val extendedProfile = runCatching { extendedPidCatalog.match(vin) }.getOrNull()
            val extendedPlan = extendedProfile?.sensors.orEmpty()
            sender.updateExtendedProfile(extendedProfile)
            val latestValues = mutableMapOf<String, Double>()
            val updatedAt = mutableMapOf<String, Long>()
            val lastPolledAt = mutableMapOf<String, Long>()
            if (plan.isEmpty()) {
                _status.value = "ECU connected - no supported live PIDs advertised"
            }
            while (isActive) {
                if (!obd.isConnected()) {
                    _status.value = "Not connected"
                    sender.updateSnapshot(emptyMap(), obdConnected = false)
                    delay(1000)
                    continue
                }
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
                    delay(100)
                    continue
                }
                var loopError: String? = null
                due.forEach { spec ->
                    val result = readPidMetrics(spec.command)
                    lastPolledAt[spec.command] = System.currentTimeMillis()
                    if (result.values.isNotEmpty()) {
                        result.values.forEach { (key, value) ->
                            latestValues[key] = value
                            updatedAt[key] = System.currentTimeMillis()
                        }
                    } else if (loopError == null) {
                        loopError = result.error
                    }
                }
                extendedDue.forEach { definition ->
                    val reading = runCatching { obd.readExtendedPid(definition) }.getOrNull()
                    lastPolledAt[definition.command] = System.currentTimeMillis()
                    if (reading != null) {
                        latestValues[reading.key] = reading.value
                        updatedAt[reading.key] = System.currentTimeMillis()
                    } else if (loopError == null) {
                        loopError = "No validated response for ${definition.name}"
                    }
                }
                if (loopError != null && loopError != lastReadError) {
                    Log.w("FleetAI", "[OBD] read error: $loopError")
                }
                lastReadError = loopError
                plan.forEach { spec ->
                    val age = now - (updatedAt[spec.key] ?: 0L)
                    val ttl = (spec.minIntervalMs * 4).coerceIn(15_000L, 60_000L)
                    if (age > ttl) latestValues.remove(spec.key)
                }
                extendedPlan.forEach { definition ->
                    val age = now - (updatedAt[definition.key] ?: 0L)
                    val ttl = (definition.minIntervalMs * 4).coerceIn(15_000L, 60_000L)
                    if (age > ttl) latestValues.remove(definition.key)
                }
                deriveBoost(latestValues["mapKpa"], latestValues["barometricPressureKpa"])?.let {
                    latestValues["boostPsi"] = it
                    updatedAt["boostPsi"] = now
                }
                sender.updateSnapshot(
                    metrics = latestValues.toMap(),
                    obdConnected = true,
                    packetAt = now
                )

                val liveSignalCount = latestValues.values.count { it.isFinite() }
                _status.value = if (liveSignalCount > 0) {
                    "Live vehicle data - $liveSignalCount of ${plan.size + extendedPlan.size} supported signals"
                } else {
                    "Adapter connected - waiting for ECU data"
                }

                val unit = _unitPrefs.value
                val liveReadings = plan.sortedWith(compareBy<PidSpec> { it.priority }.thenBy { it.name }).map { spec ->
                    var value = latestValues[spec.key]
                    var displayUnit = spec.unit
                    if (spec.key == "speedKph" && unit.speedMph) {
                        value = value?.times(0.621371)
                        displayUnit = "mph"
                    }
                    if (spec.key.endsWith("TempC") && unit.tempF) {
                        value = applyTempUnit(value, true)
                        displayUnit = "F"
                    }
                    val decimals = when (spec.unit) {
                        "rpm", "kph", "km", "count", "s", "min", "Nm" -> 0
                        "V", "lambda", "g/s", "L/h" -> 2
                        else -> 1
                    }
                    buildReading(spec.command, spec.name, value, displayUnit, updatedAt[spec.key] ?: 0L, decimals = decimals)
                }.toMutableList()
                extendedPlan.sortedWith(compareBy<ExtendedPidDefinition> { it.priority }.thenBy { it.name }).forEach { definition ->
                    var value = latestValues[definition.key]
                    var displayUnit = definition.unit
                    if (definition.key.endsWith("TempC") && unit.tempF) {
                        value = applyTempUnit(value, true)
                        displayUnit = "F"
                    }
                    liveReadings += buildReading(
                        definition.command,
                        definition.name,
                        value,
                        displayUnit,
                        updatedAt[definition.key] ?: 0L,
                        decimals = if (definition.unit == "V") 2 else 1
                    )
                }
                latestValues["boostPsi"]?.let {
                    liveReadings += buildReading("BOOST", "Boost", it, "psi", updatedAt["boostPsi"] ?: now, derived = true, decimals = 2)
                }
                _readings.value = liveReadings
                delay(if (lastReadError == null) 100L else 250L)
            }
        }
    }

    private suspend fun readPidMetrics(command: String): PidMetricsReadResult {
        return try {
            val raw = obd.readPid(command) ?: return PidMetricsReadResult(emptyMap(), "No response from adapter")
            val values = ObdParser.parsePid(command, raw)
            val error = if (values.isEmpty()) {
                when {
                    raw.contains("NO DATA", ignoreCase = true) -> "ECU returned NO DATA for $command"
                    raw.contains("UNABLE TO CONNECT", ignoreCase = true) -> "Adapter cannot reach the ECU"
                    raw.contains("BUS", ignoreCase = true) -> raw.take(80)
                    else -> "Unrecognized response for $command"
                }
            } else null
            PidMetricsReadResult(values, error)
        } catch (err: Exception) {
            PidMetricsReadResult(emptyMap(), err.message ?: "obd_read_error")
        }
    }

    private fun startDemo() {
        stopPolling()
        pollJob = viewModelScope.launch {
            while (isActive) {
                _readings.value = listOf(
                    SensorReading("0105", "Coolant Temp", demoValue(78.0, 96.0), "F", SensorStatus.LIVE, Trend.FLAT, null, null, System.currentTimeMillis()),
                    SensorReading("010C", "RPM", demoValue(900.0, 2100.0), "rpm", SensorStatus.LIVE, Trend.FLAT, null, null, System.currentTimeMillis()),
                    SensorReading("010D", "Speed", demoValue(0.0, 100.0), "mph", SensorStatus.LIVE, Trend.FLAT, null, null, System.currentTimeMillis()),
                    SensorReading("0142", "Voltage", demoValue(12.4, 14.2), "V", SensorStatus.LIVE, Trend.FLAT, null, null, System.currentTimeMillis()),
                    SensorReading("010F", "Intake Temp", demoValue(20.0, 45.0), "F", SensorStatus.LIVE, Trend.FLAT, null, null, System.currentTimeMillis()),
                    SensorReading("015C", "Oil Temp", demoValue(70.0, 105.0), "F", SensorStatus.LIVE, Trend.FLAT, null, null, System.currentTimeMillis())
                )
                delay(2000)
            }
        }
    }

    private fun stopPolling(resetReadings: Boolean = false) {
        pollJob?.cancel()
        pollJob = null
        lastReadError = null
        sender.updateSnapshot(emptyMap(), obdConnected = false)
        if (resetReadings) {
            _readings.value = emptyList()
            ema.clear()
            history.clear()
            lastGood.clear()
        }
    }

    private fun demoValue(min: Double, max: Double): String {
        return String.format("%.1f", Random.nextDouble(min, max))
    }

    private suspend fun readPidValue(pid: String, parser: (String) -> Double?): PidReadResult {
        return try {
            val raw = obd.readPid(pid) ?: return PidReadResult(null, "No response from adapter")
            val value = parser(raw)
            val error = if (value == null) {
                when {
                    raw.contains("NO DATA", ignoreCase = true) -> "ECU returned NO DATA"
                    raw.contains("UNABLE TO CONNECT", ignoreCase = true) -> "Adapter cannot reach the ECU"
                    raw.contains("BUS", ignoreCase = true) -> raw.take(80)
                    else -> "Unrecognized response for $pid"
                }
            } else {
                null
            }
            PidReadResult(value, error)
        } catch (err: Exception) {
            val message = err.message ?: "obd_read_error"
            PidReadResult(null, message)
        }
    }

    override fun onCleared() {
        stopPolling(resetReadings = true)
        sender.stop()
        j1939RuntimeJob?.cancel()
        j1939RuntimeJob = null
        j1939MetricsJob?.cancel()
        j1939MetricsJob = null
        usbJ1939.close()
        debugJob?.cancel()
        debugJob = null
        super.onCleared()
    }

    private fun buildReading(
        pid: String,
        label: String,
        raw: Double?,
        unit: String,
        ts: Long,
        derived: Boolean = false,
        decimals: Int = 1
    ): SensorReading {
        val smoothed = raw?.let { smooth(pid, it) }
        val status = when {
            raw == null -> SensorStatus.STALE
            System.currentTimeMillis() - ts > 3000 -> SensorStatus.STALE
            else -> SensorStatus.LIVE
        }
        val trend = trend(pid, smoothed ?: raw)
        val valueStr = when {
            (smoothed ?: raw) == null -> "—"
            else -> "%.${decimals}f".format(smoothed ?: raw)
        }
        return SensorReading(
            pid = pid,
            label = if (derived) "$label (Derived)" else label,
            value = valueStr,
            unit = unit,
            status = status,
            trend = trend,
            raw = raw,
            smoothed = smoothed,
            lastUpdated = ts
        )
    }

    private fun smooth(pid: String, value: Double): Double {
        val alpha = 0.15  // 15% new / 85% history — low enough to suppress BT noise
        val prev = ema[pid]
        val next = if (prev == null) value else alpha * value + (1 - alpha) * prev
        ema[pid] = next
        return next
    }

    private fun trend(pid: String, value: Double?): Trend {
        if (value == null) return Trend.FLAT
        val window = history.getOrPut(pid) { mutableListOf() }
        window.add(value)
        if (window.size > 5) window.removeAt(0)
        if (window.size < 3) return Trend.FLAT
        val delta = window.last() - window.first()
        return when {
            delta > 0.5 -> Trend.UP
            delta < -0.5 -> Trend.DOWN
            else -> Trend.FLAT
        }
    }

    private fun withLastGood(pid: String, value: Double?, ts: Long): Double? {
        if (value != null) {
            lastGood[pid] = value to ts
            return value
        }
        val cached = lastGood[pid] ?: return null
        return if (ts - cached.second <= valueTtlMs) cached.first else null
    }

    private fun applyTempUnit(valueC: Double?, tempF: Boolean): Double? {
        return valueC?.let { if (tempF) it * 9 / 5 + 32 else it }
    }

    private fun deriveBoost(map: Double?, baro: Double?): Double? {
        if (map == null) return null
        val baroVal = baro ?: 101.3
        val boost = (map - baroVal) / 6.89476
        return if (boost < 0) 0.0 else boost
    }

    private fun buildJ1939Readings(metrics: Map<String, Double>, now: Long): List<SensorReading> {
        val unit = _unitPrefs.value
        data class Display(val key: String, val spn: String, val label: String, val unit: String, val decimals: Int = 1)
        val displays = listOf(
            Display("rpm", "SPN 190", "Engine Speed", "rpm", 0),
            Display("speedKph", "SPN 84", "Road Speed", if (unit.speedMph) "mph" else "kph", 1),
            Display("coolantTempC", "SPN 110", "Coolant Temperature", if (unit.tempF) "F" else "C"),
            Display("oilTempC", "SPN 175", "Engine Oil Temperature", if (unit.tempF) "F" else "C"),
            Display("engineOilPressureKpa", "SPN 100", "Engine Oil Pressure", "kPa"),
            Display("fuelRateLph", "SPN 183", "Fuel Rate", "L/h", 2),
            Display("fuelLevelPct", "SPN 96", "Fuel Level", "%"),
            Display("batteryVoltageV", "SPN 168", "Battery Voltage", "V", 2),
            Display("engineHours", "SPN 247", "Engine Hours", "h"),
            Display("odometerKm", "SPN 245", "Total Distance", "km"),
            Display("egtC", "SPN 173", "Exhaust Temperature", if (unit.tempF) "F" else "C"),
            Display("ambientTempC", "SPN 171", "Ambient Temperature", if (unit.tempF) "F" else "C"),
            Display("brakePedalPositionPct", "SPN 521", "Brake Pedal Position", "%"),
            Display("serviceBrakeActive", "SPN 1121", "Service Brake Active", "state", 0),
            Display("absActive", "SPN 563", "ABS Active", "state", 0),
            Display("tractionControlBrakeActive", "SPN 562", "Traction Brake Active", "state", 0)
        )
        return displays.mapNotNull { display ->
            var value = metrics[display.key] ?: return@mapNotNull null
            if (display.key == "speedKph" && unit.speedMph) value *= 0.621371
            if (display.key.endsWith("TempC") && unit.tempF) value = value * 9 / 5 + 32
            buildReading(display.spn, display.label, value, display.unit, now, decimals = display.decimals)
        }
    }
}
