package com.fleetai.driver.network

import android.content.Context
import android.util.Log
import com.fleetai.driver.BuildConfig
import com.fleetai.driver.network.ServerConfig
import com.fleetai.driver.data.local.AppPreferences
import com.squareup.moshi.Moshi
import com.squareup.moshi.kotlin.reflect.KotlinJsonAdapterFactory
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import okhttp3.OkHttpClient
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.logging.HttpLoggingInterceptor
import retrofit2.Retrofit
import retrofit2.converter.moshi.MoshiConverterFactory

object ApiClient {
    @Volatile
    private var preferences: AppPreferences? = null
    @Volatile
    private var appContext: Context? = null
    @Volatile
    private var baseOverride: String? = null

    data class ApiDiagnostics(
        val baseUrl: String = "",
        val lastMethod: String = "",
        val lastUrl: String = "",
        val lastStatus: String = "",
        val lastError: String = ""
    )

    private val _diagnostics = MutableStateFlow(ApiDiagnostics())
    val diagnostics: StateFlow<ApiDiagnostics> = _diagnostics

    private val moshi = Moshi.Builder()
        .add(KotlinJsonAdapterFactory())
        .build()

    private val loggingInterceptor = HttpLoggingInterceptor().apply {
        level = HttpLoggingInterceptor.Level.BASIC
    }

    private val httpClient = OkHttpClient.Builder()
        .addInterceptor { chain ->
            val request = chain.request()
            val ctx = appContext
            val baseUrl = ctx?.let { resolveBaseUrl(it) }
            if (baseUrl == null) {
                _diagnostics.value = _diagnostics.value.copy(
                    baseUrl = "",
                    lastMethod = request.method,
                    lastUrl = request.url.toString(),
                    lastStatus = "error",
                    lastError = "BASE_URL_NOT_CONFIGURED"
                )
                throw IllegalStateException("BASE_URL_NOT_CONFIGURED")
            }
            val newUrl = request.url.newBuilder()
                .scheme(baseUrl.scheme)
                .host(baseUrl.host)
                .port(baseUrl.port)
                .build()
            if (BuildConfig.DEBUG && (baseUrl.host == "localhost" || baseUrl.host == "127.0.0.1")) {
                _diagnostics.value = _diagnostics.value.copy(
                    baseUrl = baseUrl.toString(),
                    lastMethod = request.method,
                    lastUrl = newUrl.toString(),
                    lastStatus = "error",
                    lastError = "LOCALHOST_BLOCKED"
                )
                throw IllegalStateException("LOCALHOST_BLOCKED")
            }
            val builder = request.newBuilder().url(newUrl)
            val prefs = preferences
            if (prefs != null) {
                val token = runBlocking { prefs.token.first() }
                val tenantId = runBlocking { prefs.tenantId.first() }
                if (token.isNotBlank()) {
                    builder.header("Authorization", "Bearer $token")
                }
                if (tenantId.isNotBlank()) {
                    builder.header("X-Tenant-Id", tenantId)
                }
            }
            builder.header("X-FleetAI-BaseUrl", baseUrl.toString())
            builder.header("X-FleetAI-App-Version", BuildConfig.VERSION_NAME)
            builder.header("X-FleetAI-App-Version-Code", BuildConfig.VERSION_CODE.toString())
            Log.d("FleetAI", "[NET] ${request.method} ${newUrl}")
            _diagnostics.value = _diagnostics.value.copy(
                baseUrl = baseUrl.toString(),
                lastMethod = request.method,
                lastUrl = newUrl.toString(),
                lastStatus = "pending",
                lastError = ""
            )
            try {
                val response = chain.proceed(builder.build())
                val peek = if (!response.isSuccessful) response.peekBody(200).string() else ""
                Log.d("FleetAI", "[NET] <= ${response.code} ${newUrl}")
                if (!response.isSuccessful && peek.isNotBlank()) {
                    Log.d("FleetAI", "[NET] body ${peek}")
                }
                _diagnostics.value = _diagnostics.value.copy(
                    lastStatus = response.code.toString(),
                    lastError = if (response.isSuccessful) "" else peek
                )
                return@addInterceptor response
            } catch (ex: Exception) {
                Log.d("FleetAI", "[NET] !! ${request.method} ${newUrl} ${ex.message}")
                _diagnostics.value = _diagnostics.value.copy(
                    lastStatus = "error",
                    lastError = ex.message ?: "request_failed"
                )
                throw ex
            }
        }
        .addInterceptor(loggingInterceptor)
        .build()

    fun init(context: Context, preferences: AppPreferences) {
        this.appContext = context.applicationContext
        this.preferences = preferences
    }

    fun setBaseUrl(context: Context, baseUrl: String) {
        baseOverride = baseUrl
        ServerConfig.setBaseUrl(context, baseUrl)
    }

    private fun resolveBaseUrl(context: Context): HttpUrl? {
        val raw = baseOverride ?: ServerConfig.getBaseUrl(context, allowDefault = BuildConfig.DEBUG)
        if (raw.isNullOrBlank()) return null
        val normalized = ServerConfig.normalize(raw)
        return "${normalized}/".toHttpUrlOrNull()
    }

    val api: ApiService by lazy {
        Retrofit.Builder()
            .baseUrl(BuildConfig.BASE_URL)
            .client(httpClient)
            .addConverterFactory(MoshiConverterFactory.create(moshi))
            .build()
            .create(ApiService::class.java)
    }
}
