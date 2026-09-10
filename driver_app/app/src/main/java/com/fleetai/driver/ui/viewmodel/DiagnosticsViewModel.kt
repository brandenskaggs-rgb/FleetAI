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
        if (_scanning.value) return
        _scanning.value = true
        viewModelScope.launch {
            try {
                _message.value = "Scanning..."
                val codes = if (obd.isConnected()) {
                    obd.readDtcs().map { DtcCode(it, "OBD reported code", "medium") }
                } else {
                    repository.getDiagnosticCodes()
                }
                _dtcs.value = codes
                _message.value = if (codes.isEmpty()) {
                    "No codes returned. This is not a mechanical inspection."
                } else {
                    "Fault codes returned."
                }
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
