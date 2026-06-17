package com.fleetai.driver

import android.content.Context

object ServerPrefs {
    const val PREFS_NAME = "fleetai_driver"
    const val KEY_BASE_URL = "base_url"

    // Build-time default. Set FLEETAI_BASE_URL in gradle.properties (or via -P at build time)
    // to point at the Railway deployment. Drivers can still override at runtime via the
    // connect screen.
    val DEFAULT_BASE_URL: String
        get() = BuildConfig.BASE_URL

    fun getBaseUrl(context: Context): String? {
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        return prefs.getString(KEY_BASE_URL, null)?.trim().orEmpty().ifBlank { null }
    }

    fun setBaseUrl(context: Context, baseUrl: String) {
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        prefs.edit().putString(KEY_BASE_URL, baseUrl).apply()
    }
}
