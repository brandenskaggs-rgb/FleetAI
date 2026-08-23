package com.fleetai.driver.network

import retrofit2.http.Body
import retrofit2.http.GET
import retrofit2.http.POST
import retrofit2.http.Query

interface ApiService {
    @POST("api/auth/driverLogin")
    suspend fun loginDriver(@Body request: LoginRequest): LoginResponse

    @POST("api/pairings/claim")
    suspend fun claimPairing(@Body request: PairingClaimRequest): PairingClaimResponse

    @GET("api/drivers/me")
    suspend fun getDriverProfile(): DriverProfileResponse

    @GET("api/vehicles")
    suspend fun getVehicles(@Query("tenantId") tenantId: String): VehicleListResponse

    @POST("api/vehicles/select")
    suspend fun selectVehicle(@Body request: SelectVehicleRequest): BasicResponse

    @POST("api/logs/hos")
    suspend fun postHosLog(@Body request: DriverLogRequest): BasicResponse

    @GET("api/logs/hos")
    suspend fun getHosLogs(@Query("date") date: String): HosLogResponse

    @POST("api/driver/dvir")
    suspend fun submitDvir(@Body request: DvirSubmitRequest): DvirSubmitResponse

    @GET("api/eld/device/status")
    suspend fun getEldDeviceStatus(): EldDeviceStatusResponse

    @GET("api/eld/hos/status")
    suspend fun getEldHosStatus(): EldHosStatusResponse

    @POST("api/eld/login")
    suspend fun recordEldLogin(@Body request: Map<String, String> = emptyMap()): BasicResponse

    @POST("api/eld/logout")
    suspend fun recordEldLogout(@Body request: Map<String, String> = emptyMap()): BasicResponse

    @POST("api/eld/certifications")
    suspend fun certifyEldRecords(@Body request: EldCertificationRequest): BasicResponse

    @POST("api/telemetry/ingest")
    suspend fun ingestTelemetry(@Body request: TelemetryIngestRequest): BasicResponse

    @POST("api/telemetry/snapshot")
    suspend fun postTelemetrySnapshot(@Body request: TelemetrySnapshotRequest): BasicResponse

    @POST("api/alerts")
    suspend fun postAlert(@Body request: AlertRequest): BasicResponse

    @GET("api/vehicle/dtcs")
    suspend fun getDiagnosticCodes(): DtcResponse
}
