package com.fleetai.driver.network

import retrofit2.http.Body
import retrofit2.http.GET
import retrofit2.http.POST
import retrofit2.http.Query

interface ApiService {
    @POST("auth/driverLogin")
    suspend fun loginDriver(@Body request: LoginRequest): LoginResponse

    @POST("pairings/claim")
    suspend fun claimPairing(@Body request: PairingClaimRequest): PairingClaimResponse

    @GET("drivers/me")
    suspend fun getDriverProfile(): DriverProfileResponse

    @GET("vehicles")
    suspend fun getVehicles(@Query("tenantId") tenantId: String): VehicleListResponse

    @POST("vehicles/select")
    suspend fun selectVehicle(@Body request: SelectVehicleRequest): BasicResponse

    @POST("logs/hos")
    suspend fun postHosLog(@Body request: DriverLogRequest): BasicResponse

    @GET("logs/hos")
    suspend fun getHosLogs(@Query("date") date: String): HosLogResponse

    @POST("telemetry/snapshot")
    suspend fun postTelemetrySnapshot(@Body request: TelemetrySnapshotRequest): BasicResponse

    @POST("alerts")
    suspend fun postAlert(@Body request: AlertRequest): BasicResponse

    @GET("vehicle/dtcs")
    suspend fun getDiagnosticCodes(): DtcResponse
}
