package com.fleetai.driver.network

import retrofit2.http.Body
import retrofit2.http.GET
import retrofit2.http.POST
import retrofit2.http.Path
import retrofit2.http.Query

interface DriverApi {
    @POST("api/driver/register-device")
    suspend fun registerDevice(@Body request: RegisterDeviceRequest): RegisterDeviceResponse

    @POST("api/driver/trips/start")
    suspend fun startTrip(@Body request: TripStartRequest): TripStartResponse

    @POST("api/driver/trips/end")
    suspend fun endTrip(@Body request: TripEndRequest): TripEndResponse

    @POST("api/driver/telemetry")
    suspend fun uploadTelemetry(@Body request: TelemetryUploadRequest): TelemetryUploadResponse

    @GET("api/driver/alerts")
    suspend fun listAlerts(@Query("vehicle_id") vehicleId: String): List<DriverAlert>

    @POST("api/driver/alerts/{id}/ack")
    suspend fun ackAlert(@Path("id") alertId: String): AckResponse

    @GET("api/driver/config")
    suspend fun getConfig(): DriverConfig
}
