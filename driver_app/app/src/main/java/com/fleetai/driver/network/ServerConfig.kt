package com.fleetai.driver.network

import android.content.Context
import com.fleetai.driver.BuildConfig
import com.fleetai.driver.ServerPrefs
import java.net.URI

object ServerConfig {
    data class Result(val url: String?, val error: String?)

    private val localDevelopmentHosts = setOf("localhost", "127.0.0.1", "10.0.2.2")

    fun getBaseUrl(context: Context, allowDefault: Boolean = BuildConfig.DEBUG): String? {
        if (!BuildConfig.DEBUG) return normalize(BuildConfig.BASE_URL)
        val saved = ServerPrefs.getBaseUrl(context)
        if (!saved.isNullOrBlank()) {
            return normalize(saved)
        }
        if (!allowDefault) {
            return null
        }
        return normalize(ServerPrefs.DEFAULT_BASE_URL)
    }

    fun setBaseUrl(context: Context, baseUrl: String) {
        if (!BuildConfig.DEBUG) return
        val normalized = normalize(baseUrl)
        ServerPrefs.setBaseUrl(context, normalized)
    }

    fun validate(raw: String): Result {
        if (raw.isBlank()) return Result(null, "Server URL is required.")
        val normalized = try {
            normalize(raw)
        } catch (_: Exception) {
            return Result(null, "Enter a valid server URL.")
        }
        val parsed = try {
            URI(normalized)
        } catch (_: Exception) {
            return Result(null, "Enter a valid server URL.")
        }
        val host = parsed.host.orEmpty()
        if (host.isBlank()) return Result(null, "Enter a valid server URL.")
        if (host == "0.0.0.0" || host == "localhost" || host == "127.0.0.1") {
            return Result(null, "Use your computer's LAN IP (example 192.168.4.46), not 0.0.0.0 or localhost.")
        }
        return Result(normalized, null)
    }

    fun normalize(raw: String): String {
        val trimmed = raw.trim()
        val hasScheme = trimmed.startsWith("http://", ignoreCase = true) ||
            trimmed.startsWith("https://", ignoreCase = true)
        val parsed = URI(if (hasScheme) trimmed else "https://$trimmed")
        val parsedHost = parsed.host.orEmpty().lowercase()
        val host = if (parsedHost == "www.fleetaiops.com") "fleetaiops.com" else parsedHost
        if (host.isBlank()) return trimmed

        val isLocalDevelopment = host in localDevelopmentHosts
        val scheme = if (isLocalDevelopment) {
            parsed.scheme?.lowercase() ?: "http"
        } else {
            // Android blocks cleartext public traffic. Upgrade old saved HTTP
            // values so a bare fleetaiops.com entry reaches the TLS endpoint.
            "https"
        }
        val port = if (!isLocalDevelopment && parsed.scheme.equals("http", ignoreCase = true) && parsed.port == 80) {
            -1
        } else {
            parsed.port
        }
        val portPart = if (port > 0) ":$port" else ""
        return "$scheme://$host$portPart"
    }
}
