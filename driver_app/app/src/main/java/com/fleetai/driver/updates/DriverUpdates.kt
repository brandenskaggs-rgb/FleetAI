package com.fleetai.driver.updates

import android.os.SystemClock
import com.fleetai.driver.BuildConfig
import com.fleetai.driver.network.ApiClient
import java.net.URI
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

data class DriverReleaseResponse(val release: DriverRelease? = null)
data class DriverRelease(val channel: String, val versionCode: Int, val versionName: String, val url: String, val notes: String = "")
data class UpdateState(val checking: Boolean = false, val release: DriverRelease? = null, val message: String = "")

object DriverUpdatePolicy {
    fun allowed(release: DriverRelease, debug: Boolean, installedVersion: Int): Boolean {
        if (release.versionCode <= installedVersion || release.versionName.isBlank()) return false
        return if (!debug) {
            release.channel == "play" && release.url == "https://play.google.com/store/apps/details?id=com.fleetai.driver"
        } else {
            val uri = runCatching { URI(release.url) }.getOrNull() ?: return false
            release.channel == "pilot-debug" && uri.scheme == "https" && uri.host == "fleetaiops.com" &&
                uri.port == -1 && uri.userInfo == null && uri.query == null && uri.fragment == null &&
                Regex("/downloads/driver/[a-zA-Z0-9._-]+\\.apk").matches(uri.rawPath ?: "")
        }
    }
}

object DriverUpdates {
    private val lock = Mutex()
    private val mutable = MutableStateFlow(UpdateState())
    val state = mutable.asStateFlow()
    private var lastCheck: Long? = null

    suspend fun check(force: Boolean = false) = lock.withLock {
        val now = SystemClock.elapsedRealtime()
        if (!force && lastCheck?.let { now - it < 6 * 60 * 60 * 1000L } == true) return@withLock
        mutable.value = mutable.value.copy(checking = true, message = "Checking for updates...")
        try {
            val response = ApiClient.api.getDriverRelease(if (BuildConfig.DEBUG) "pilot-debug" else "play")
            val release = response.release?.takeIf { DriverUpdatePolicy.allowed(it, BuildConfig.DEBUG, BuildConfig.VERSION_CODE) }
            lastCheck = now
            mutable.value = UpdateState(release = release, message = when {
                release != null -> "Version ${release.versionName} is available. Update while parked."
                response.release == null -> "No release has been published to this update channel."
                response.release.versionCode <= BuildConfig.VERSION_CODE -> "You have the latest published version."
                else -> "Update information could not be verified. Contact Fleet AI support."
            })
        } catch (cancelled: CancellationException) {
            mutable.value = mutable.value.copy(checking = false)
            throw cancelled
        } catch (_: Exception) {
            mutable.value = UpdateState(message = "Could not check for updates. Your current app will keep working.")
        }
    }
}
