package com.fleetai.driver

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import androidx.activity.ComponentActivity
import com.fleetai.driver.network.ApiClient
import com.fleetai.driver.network.ServerConfig
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
        Thread {
            val host = Uri.parse(baseUrl).host.orEmpty()
        val parsed = Uri.parse(baseUrl)
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
                runOnUiThread {
                    hostStatus.text = "Host reachable: no"
                    portStatus.text = "Port open: --"
                    httpStatus.text = "HTTP /health: --"
                    advice.text = adviceMsg.ifBlank { "Host is unreachable. Check Wi-Fi/hotspot." }
                    button.isEnabled = true
                    button.text = "Test Connection"
                }
                return@Thread
            }

            try {
                Socket().use { socket ->
                    socket.connect(InetSocketAddress(host, port), 3000)
                    portOk = true
                }
            } catch (err: SocketTimeoutException) {
                errorMsg = "Socket timeout"
                adviceMsg = "Firewall blocked or not on same network."
            } catch (err: Exception) {
                errorMsg = err.message ?: "Connection failed."
                adviceMsg = "Server not running or wrong port."
            }

            if (!portOk) {
                runOnUiThread {
                    hostStatus.text = "Host reachable: yes"
                    portStatus.text = "Port open: no"
                    httpStatus.text = "HTTP /health: --"
                    advice.text = adviceMsg.ifBlank { "Port is closed or blocked." }
                    button.isEnabled = true
                    button.text = "Test Connection"
                }
                return@Thread
            }

            try {
                val target = Uri.parse(baseUrl).buildUpon().appendEncodedPath("health").build().toString()
                val req = Request.Builder().url(target).get().build()
                val res = httpClient.newCall(req).execute()
                res.use {
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

            runOnUiThread {
                hostStatus.text = "Host reachable: ${if (hostOk) "yes" else "no"}"
                portStatus.text = "Port open: ${if (portOk) "yes" else "no"}"
                httpStatus.text = "HTTP /health: ${if (httpOk) "yes" else "no"}"
                advice.text = if (httpOk) "" else "Error: $errorMsg. $adviceMsg"
                button.isEnabled = true
                button.text = "Test Connection"
            }
        }.start()
    }

    private fun testConnection(baseUrl: String, error: TextView, save: Button) {
        Thread {
            var ok = false
            var errorDetails = ""
            try {
                val target = Uri.parse(baseUrl).buildUpon().appendEncodedPath("health").build().toString()
                val req = Request.Builder().url(target).get().build()
                val res = httpClient.newCall(req).execute()
                res.use {
                    ok = it.isSuccessful
                    if (!ok) {
                        val bodyPreview = it.body?.string()?.take(160).orEmpty()
                        errorDetails = "HTTP ${it.code}: ${bodyPreview.ifBlank { "no body" }}"
                    }
                }
            } catch (err: Exception) {
                errorDetails = err.message ?: "HTTP request failed."
            }
            runOnUiThread {
                save.isEnabled = true
                save.text = "Save"
                if (!ok) {
                    val detail = if (errorDetails.isNotBlank()) " ($errorDetails)" else ""
                    error.text = "Can't reach Fleet AI server at $baseUrl$detail"
                    return@runOnUiThread
                }
                ServerConfig.setBaseUrl(this, baseUrl)
                ApiClient.setBaseUrl(this, baseUrl)
                val intent = Intent(this, MainActivity::class.java)
                intent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
                startActivity(intent)
                finish()
            }
        }.start()
    }
}
