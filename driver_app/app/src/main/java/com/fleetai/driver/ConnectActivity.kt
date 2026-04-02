package com.fleetai.driver

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.lifecycle.lifecycleScope
import com.fleetai.driver.network.ApiClient
import com.fleetai.driver.network.ServerConfig
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.Socket
import java.net.SocketTimeoutException
import java.util.concurrent.TimeUnit

class ConnectActivity : ComponentActivity() {
    private val httpClient = OkHttpClient.Builder()
        .connectTimeout(4, TimeUnit.SECONDS)
        .readTimeout(4, TimeUnit.SECONDS)
        .writeTimeout(4, TimeUnit.SECONDS)
        .build()
    private var diagnosticsJob: Job? = null
    private var saveJob: Job? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_connect)

        val input = findViewById<EditText>(R.id.serverInput)
        val error = findViewById<TextView>(R.id.serverError)
        val save = findViewById<Button>(R.id.btnSaveServer)
        val test = findViewById<Button>(R.id.btnTestServer)
        val hostStatus = findViewById<TextView>(R.id.testHostStatus)
        val portStatus = findViewById<TextView>(R.id.testPortStatus)
        val httpStatus = findViewById<TextView>(R.id.testHttpStatus)
        val advice = findViewById<TextView>(R.id.testAdvice)

        input.setText(ServerConfig.getBaseUrl(this) ?: ServerPrefs.DEFAULT_BASE_URL)

        fun resetDiagnostics() {
            hostStatus.text = "Host reachable: --"
            portStatus.text = "Port open: --"
            httpStatus.text = "HTTP /health: --"
            advice.text = ""
        }

        test.setOnClickListener {
            error.text = ""
            resetDiagnostics()
            val raw = input.text?.toString()?.trim().orEmpty()
            val result = ServerConfig.validate(raw)
            if (result.error != null) {
                error.text = result.error
                return@setOnClickListener
            }
            val normalized = result.url ?: return@setOnClickListener
            diagnosticsJob?.cancel()
            runDiagnostics(normalized, hostStatus, portStatus, httpStatus, advice, test)
        }

        save.setOnClickListener {
            error.text = ""
            val raw = input.text?.toString()?.trim().orEmpty()
            val result = ServerConfig.validate(raw)
            if (result.error != null) {
                error.text = result.error
                return@setOnClickListener
            }
            val normalized = result.url ?: return@setOnClickListener
            saveJob?.cancel()
            save.isEnabled = false
            save.text = "Testing..."
            testConnection(normalized, error, save)
        }
    }

    private fun runDiagnostics(
        baseUrl: String,
        hostStatus: TextView,
        portStatus: TextView,
        httpStatus: TextView,
        advice: TextView,
        button: Button
    ) {
        button.isEnabled = false
        button.text = "Testing..."
        diagnosticsJob = lifecycleScope.launch {
            val result = withContext(Dispatchers.IO) {
                runDiagnosticsInternal(baseUrl)
            }
            hostStatus.text = "Host reachable: ${if (result.hostOk) "yes" else "no"}"
            portStatus.text = "Port open: ${if (result.portOk) "yes" else if (result.hostOk) "no" else "--"}"
            httpStatus.text = "HTTP /health: ${if (result.httpOk) "yes" else if (result.portOk) "no" else "--"}"
            advice.text = if (result.httpOk) "" else result.adviceMessage
            button.isEnabled = true
            button.text = "Test Connection"
        }
    }

    private fun testConnection(baseUrl: String, error: TextView, save: Button) {
        saveJob = lifecycleScope.launch {
            val result = withContext(Dispatchers.IO) {
                testConnectionInternal(baseUrl)
            }
            save.isEnabled = true
            save.text = "Save"
            if (!result.ok) {
                val detail = if (result.errorDetails.isNotBlank()) " (${result.errorDetails})" else ""
                error.text = "Can't reach Fleet AI server at $baseUrl$detail"
                return@launch
            }
            ServerConfig.setBaseUrl(this@ConnectActivity, baseUrl)
            ApiClient.setBaseUrl(this@ConnectActivity, baseUrl)
            val intent = Intent(this@ConnectActivity, MainActivity::class.java)
            intent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            startActivity(intent)
            finish()
        }
    }

    private data class DiagnosticsResult(
        val hostOk: Boolean,
        val portOk: Boolean,
        val httpOk: Boolean,
        val adviceMessage: String
    )

    private data class ConnectionTestResult(
        val ok: Boolean,
        val errorDetails: String = ""
    )

    private fun runDiagnosticsInternal(baseUrl: String): DiagnosticsResult {
        val parsed = Uri.parse(baseUrl)
        val host = parsed.host.orEmpty()
        val port = parsed.port.takeIf { it > 0 } ?: if (parsed.scheme == "https") 443 else 80

        var hostOk = false
        var portOk = false
        var httpOk = false
        var errorMsg = ""
        var adviceMsg = ""

        try {
            val address = InetAddress.getByName(host)
            hostOk = address.isReachable(2000)
        } catch (err: Exception) {
            errorMsg = err.message ?: "Host lookup failed."
            adviceMsg = "Bad hostname or DNS failure."
        }

        if (!hostOk) {
            return DiagnosticsResult(
                hostOk = false,
                portOk = false,
                httpOk = false,
                adviceMessage = adviceMsg.ifBlank { "Host is unreachable. Check Wi-Fi/hotspot." }
            )
        }

        try {
            Socket().use { socket ->
                socket.connect(InetSocketAddress(host, port), 3000)
                portOk = true
            }
        } catch (_: SocketTimeoutException) {
            errorMsg = "Socket timeout"
            adviceMsg = "Firewall blocked or not on same network."
        } catch (err: Exception) {
            errorMsg = err.message ?: "Connection failed."
            adviceMsg = "Server not running or wrong port."
        }

        if (!portOk) {
            return DiagnosticsResult(
                hostOk = true,
                portOk = false,
                httpOk = false,
                adviceMessage = adviceMsg.ifBlank { "Port is closed or blocked." }
            )
        }

        try {
            val target = Uri.parse(baseUrl).buildUpon().appendEncodedPath("health").build().toString()
            val req = Request.Builder().url(target).get().build()
            httpClient.newCall(req).execute().use {
                httpOk = it.isSuccessful
                if (!httpOk) {
                    val bodyPreview = it.body?.string()?.take(160).orEmpty()
                    errorMsg = "HTTP ${it.code}: ${bodyPreview.ifBlank { "no body" }}"
                    adviceMsg = "Health endpoint returned an error."
                }
            }
        } catch (err: Exception) {
            errorMsg = err.message ?: "HTTP request failed."
            adviceMsg = "Server may be up, but HTTP is blocked."
        }

        return DiagnosticsResult(
            hostOk = true,
            portOk = true,
            httpOk = httpOk,
            adviceMessage = if (httpOk) "" else "Error: $errorMsg. $adviceMsg"
        )
    }

    private fun testConnectionInternal(baseUrl: String): ConnectionTestResult {
        return try {
            val target = Uri.parse(baseUrl).buildUpon().appendEncodedPath("health").build().toString()
            val req = Request.Builder().url(target).get().build()
            httpClient.newCall(req).execute().use {
                if (it.isSuccessful) {
                    ConnectionTestResult(ok = true)
                } else {
                    val bodyPreview = it.body?.string()?.take(160).orEmpty()
                    ConnectionTestResult(
                        ok = false,
                        errorDetails = "HTTP ${it.code}: ${bodyPreview.ifBlank { "no body" }}"
                    )
                }
            }
        } catch (err: Exception) {
            ConnectionTestResult(ok = false, errorDetails = err.message ?: "HTTP request failed.")
        }
    }
}
