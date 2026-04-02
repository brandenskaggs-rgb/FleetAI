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
import kotlinx.coroutines.launch
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
        viewModelScope.launch {
            _message.value = "Scanning..."
            val codes = if (obd.isConnected()) {
                val obdCodes = obd.readDtcs()
                if (obdCodes.isEmpty()) {
                    emptyList()
                } else {
                    obdCodes.map { DtcCode(it, "OBD reported code", "medium") }
                }
            } else {
                repository.getDiagnosticCodes()
            }
            _dtcs.value = codes
            _message.value = if (codes.isEmpty()) "No active codes." else "Codes detected."
        }
    }

    fun clear() {
        viewModelScope.launch {
            if (obd.isConnected()) {
                val cleared = obd.clearDtcs()
                if (!cleared) {
                    _message.value = "Unable to clear codes. Check adapter connection and try again."
                    return@launch
                }
            } else {
                val cleared = repository.clearDiagnosticCodes()
                if (!cleared) {
                    _message.value = "Unable to clear codes right now."
                    return@launch
                }
            }
            _dtcs.value = emptyList()
            _message.value = "Codes cleared."
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
                val request = Request.Builder().url(target).get().build()
                val response = httpClient.newCall(request).execute()
                response.use {
                    val bodyPreview = it.body?.string()?.take(160).orEmpty()
                    _networkMessage.value = "HTTP ${it.code}: ${bodyPreview.ifBlank { "ok" }}"
                }
            } catch (err: Exception) {
                _networkMessage.value = err.message ?: "Ping failed"
            }
        }
    }
}
