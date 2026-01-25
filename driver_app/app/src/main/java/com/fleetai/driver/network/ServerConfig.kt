package com.fleetai.driver.network

import android.content.Context
import android.net.Uri
import com.fleetai.driver.BuildConfig
import com.fleetai.driver.ServerPrefs

object ServerConfig {
    data class Result(val url: String?, val error: String?)

    fun getBaseUrl(context: Context, allowDefault: Boolean = BuildConfig.DEBUG): String? {
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
        val normalized = normalize(baseUrl)
        ServerPrefs.setBaseUrl(context, normalized)
    }

    fun validate(raw: String): Result {
        if (raw.isBlank()) return Result(null, "Server URL is required.")
        val normalized = normalize(raw)
        val parsed = try {
            Uri.parse(normalized)
        } catch (err: Exception) {
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
        var value = raw.trim()
        if (!value.startsWith("http://") && !value.startsWith("https://")) {
            value = "http://$value"
        }
        val parsed = Uri.parse(value)
        val host = parsed.host.orEmpty().lowercase()
        val portPart = if (parsed.port > 0) ":${parsed.port}" else ""
        val scheme = parsed.scheme ?: "http"
        return "${scheme}://$host$portPart"
    }
}
