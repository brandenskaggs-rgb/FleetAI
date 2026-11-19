package com.fleetai.driver.network

import java.io.IOException
import okhttp3.Request

/** One DataStore snapshot; never reconstruct a replay identity from separate flows. */
data class AuthenticatedSession(
    val tenantId: String,
    val driverId: String,
    val vehicleId: String,
    val token: String,
    val assignmentId: String = "",
    val training: Boolean = false
) {
    val canReplay: Boolean get() = !training && !token.startsWith("demo_") &&
        listOf(tenantId, driverId, vehicleId, token).all { it.isNotBlank() }

    fun owns(tenantId: String, vehicleId: String, driverId: String): Boolean =
        canReplay && this.tenantId == tenantId && this.vehicleId == vehicleId && this.driverId == driverId

    fun requireCurrent(current: AuthenticatedSession) {
        if (!canReplay || this != current) throw ReplaySessionChangedException()
    }

    override fun toString(): String = "AuthenticatedSession(redacted)"
}

class ReplaySessionChangedException : IOException("Replay session changed; records remain queued")

internal object SessionRequestAuthentication {
    fun authenticate(request: Request, current: AuthenticatedSession): Request {
        if (current.training || current.token.startsWith("demo_")) {
            throw IOException("Training demo is local only. Pair a fleet account for online features.")
        }
        val bound = request.tag(AuthenticatedSession::class.java)
        bound?.requireCurrent(current)
        // Use the checked immutable credentials, even if preferences change after this point.
        val session = bound ?: current
        return request.newBuilder()
            .removeHeader("Authorization")
            .removeHeader("X-Tenant-Id")
            .apply {
                if (session.token.isNotBlank()) header("Authorization", "Bearer ${session.token}")
                if (session.tenantId.isNotBlank()) header("X-Tenant-Id", session.tenantId)
            }.build()
    }
}

internal class SessionBoundUploader(
    private val api: ApiService,
    private val currentSession: suspend () -> AuthenticatedSession
) {
    private suspend fun <T> send(session: AuthenticatedSession, upload: suspend () -> T): T {
        session.requireCurrent(currentSession())
        val result = upload()
        session.requireCurrent(currentSession())
        return result
    }

    suspend fun postHosLog(session: AuthenticatedSession, request: DriverLogRequest) = send(session) {
        api.postHosLog(request, session).also { check(it.success) { "Log upload was not acknowledged" } }
    }

    suspend fun submitDvir(session: AuthenticatedSession, request: DvirSubmitRequest) = send(session) {
        api.submitDvir(request, session).also { check(it.ok || it.success) { "Inspection upload was not acknowledged" } }
    }

    suspend fun postAlert(session: AuthenticatedSession, request: AlertRequest) = send(session) {
        api.postAlert(request, session).also { check(it.success) { "Alert upload was not acknowledged" } }
    }

    suspend fun ingestTelemetry(session: AuthenticatedSession, request: TelemetryIngestRequest) = send(session) {
        api.ingestTelemetry(request, session).also { check(it.success) { "Telemetry upload was not acknowledged" } }
    }
}
