package com.fleetai.driver.network

import com.fleetai.driver.BuildConfig
import com.fleetai.driver.data.local.AppPreferences
import com.squareup.moshi.Moshi
import com.squareup.moshi.kotlin.reflect.KotlinJsonAdapterFactory
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.logging.HttpLoggingInterceptor
import retrofit2.Retrofit
import retrofit2.converter.moshi.MoshiConverterFactory

object ApiClient {
    @Volatile
    private var preferences: AppPreferences? = null

    private val moshi = Moshi.Builder()
        .add(KotlinJsonAdapterFactory())
        .build()

    private val loggingInterceptor = HttpLoggingInterceptor().apply {
        level = HttpLoggingInterceptor.Level.BASIC
    }

    private val httpClient = OkHttpClient.Builder()
        .addInterceptor { chain ->
            val prefs = preferences
            val request = chain.request()
            if (prefs == null) {
                return@addInterceptor chain.proceed(request)
            }
            val token = runBlocking { prefs.token.first() }
            val tenantId = runBlocking { prefs.tenantId.first() }
            val builder = request.newBuilder()
            if (token.isNotBlank()) {
                builder.header("Authorization", "Bearer $token")
            }
            if (tenantId.isNotBlank()) {
                builder.header("X-Tenant-Id", tenantId)
            }
            chain.proceed(builder.build())
        }
        .addInterceptor(loggingInterceptor)
        .build()

    fun init(preferences: AppPreferences) {
        this.preferences = preferences
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
