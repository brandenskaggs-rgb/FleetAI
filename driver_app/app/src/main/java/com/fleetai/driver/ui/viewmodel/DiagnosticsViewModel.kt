package com.fleetai.driver.ui.viewmodel

import android.content.Context
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.fleetai.driver.data.local.AppPreferences
import com.fleetai.driver.data.model.DtcCode
import com.fleetai.driver.data.repository.DriverRepository
import com.fleetai.driver.network.ApiClient
import com.fleetai.driver.network.ServerConfig
import com.fleetai.driver.obd.ObdService
import com.fleetai.driver.obd.GmTransmissionAttempt
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import java.util.concurrent.TimeUnit

class DiagnosticsViewModel(
    private val repository: DriverRepository,
    private val preferences: AppPreferences,
    private val appContext: Context
) : ViewModel() {
    private val obd = ObdService.manager

    private val _dtcs = MutableStateFlow<List<DtcCode>>(emptyList())
    val dtcs: StateFlow<List<DtcCode>> = _dtcs

    private val _message = MutableStateFlow("")
    val message: StateFlow<String> = _message
    private val _scanning = MutableStateFlow(false)
    val scanning: StateFlow<Boolean> = _scanning.asStateFlow()
    private val _transmissionTesting = MutableStateFlow(false)
    val transmissionTesting = _transmissionTesting.asStateFlow()
    private val _transmissionResults = MutableStateFlow<List<GmTransmissionAttempt>>(emptyList())
    val transmissionResults = _transmissionResults.asStateFlow()
    private val _transmissionMessage = MutableStateFlow("")
    val transmissionMessage = _transmissionMessage.asStateFlow()

    fun testTransmission(confirmed: Boolean) {
        if (!confirmed || _transmissionTesting.value || _scanning.value) return
        _transmissionTesting.value = true
        _transmissionResults.value = emptyList()
        _transmissionMessage.value = "Checking VIN, protocol and speed, then testing two read-only addresses..."
        viewModelScope.launch {
            try {
                _transmissionResults.value = obd.testGmTransmission(confirmed)
                _transmissionMessage.value = "Test completed at ${java.time.LocalTime.now().withNano(0)}. " +
                    "Normal polling restored. These are one-time test results, not live readings. " +
                    "They are not uploaded or used for predictions."
            } catch (cancelled: kotlinx.coroutines.CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                _transmissionMessage.value = if (error is com.fleetai.driver.obd.GmTransmissionTest.RestoreFailed) {
                    "Test stopped: adapter address could not be restored. Bluetooth disconnected for safety; " +
                        "reconnect the adapter. Your Fleet AI pairing is unchanged."
                } else error.message ?: "Transmission test could not finish. Check the adapter connection."
            } finally {
                _transmissionTesting.value = false
            }
        }
    }

    val apiDiagnostics: StateFlow<ApiClient.ApiDiagnostics> = ApiClient.diagnostics

    private val _networkMessage = MutableStateFlow("")
    val networkMessage: StateFlow<String> = _networkMessage.asStateFlow()

    private val httpClient = OkHttpClient.Builder()
        .connectTimeout(4, TimeUnit.SECONDS)
        .readTimeout(4, TimeUnit.SECONDS)
        .writeTimeout(4, TimeUnit.SECONDS)
        .build()

    init {
        scan()
    }

    fun scan() {
        if (_scanning.value || _transmissionTesting.value) return
        _scanning.value = true
        viewModelScope.launch {
            try {
                _message.value = "Scanning..."
                val connected = obd.isConnected()
                val codes = if (connected) {
                    obd.readDtcs().map { code ->
                        val read = obd.dtcSnapshot
                        val kinds = listOfNotNull(
                            "Confirmed".takeIf { read?.confirmed?.contains(code) == true },
                            "Pending".takeIf { read?.pending?.contains(code) == true },
                            "Permanent (may remain after repair)".takeIf { read?.permanent?.contains(code) == true })
                        DtcCode(code, kinds.joinToString(" / "), "unknown")
                    }
                } else {
                    repository.getDiagnosticCodes()
                }
                _dtcs.value = codes
                val read = obd.dtcSnapshot
                _message.value = when {
                    !connected -> "Adapter disconnected. Showing saved records, not a new scan."
                    read?.inconsistent == true -> "Check-engine status and returned codes disagree. This scan is incomplete; have the warning light investigated."
                    read?.status == "partial" -> "Partial engine/emissions read. Some requests had no valid response. Missing results do not mean no faults."
                    codes.isEmpty() -> "No generic engine/emissions codes returned in this read. This is not a mechanical inspection."
                    else -> "Engine/emissions codes returned."
                } + " TPMS and ABS modules are not covered by this read."
            } catch (cancelled: kotlinx.coroutines.CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                _message.value = "Unable to read codes. Check the connection and try again. Previous results are shown."
            } finally {
                _scanning.value = false
            }
        }
    }

    fun ping(path: String) {
        viewModelScope.launch {
            val baseUrl = ServerConfig.getBaseUrl(appContext, allowDefault = true)
            if (baseUrl.isNullOrBlank()) {
                _networkMessage.value = "Configure server URL in Settings."
                return@launch
            }
            val target = "${ServerConfig.normalize(baseUrl)}/${path.trimStart('/')}"
            _networkMessage.value = "Pinging $target"
            try {
                val result = withContext(Dispatchers.IO) {
                    val request = Request.Builder().url(target).get().build()
                    httpClient.newCall(request).execute().use {
                        val bodyPreview = it.body?.string()?.take(160).orEmpty()
                        "HTTP ${it.code}: ${bodyPreview.ifBlank { "ok" }}"
                    }
                }
                _networkMessage.value = result
            } catch (err: Exception) {
                _networkMessage.value = err.message ?: "Ping failed"
            }
        }
    }
}
