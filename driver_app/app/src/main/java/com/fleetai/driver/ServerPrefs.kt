package com.fleetai.driver

import android.content.Context

object ServerPrefs {
    const val PREFS_NAME = "fleetai_driver"
    const val KEY_BASE_URL = "base_url"
    const val DEFAULT_BASE_URL = "http://172.20.10.8:3000"

    fun getBaseUrl(context: Context): String? {
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        return prefs.getString(KEY_BASE_URL, null)?.trim().orEmpty().ifBlank { null }
    }

    fun setBaseUrl(context: Context, baseUrl: String) {
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        prefs.edit().putString(KEY_BASE_URL, baseUrl).apply()
    }
}
