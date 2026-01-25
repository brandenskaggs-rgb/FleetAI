package com.fleetai.driver.notifications

import com.fleetai.driver.AppGraph
import com.fleetai.driver.data.model.NotificationItem
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import java.time.Instant
import java.util.UUID

class FleetMessagingService : FirebaseMessagingService() {
    override fun onMessageReceived(message: RemoteMessage) {
        val prefs = AppGraph.preferences
        val tenantId = runBlocking { prefs.tenantId.first() }
        val vehicleId = runBlocking { prefs.vehicleId.first() }
        if (tenantId.isBlank()) return

        val title = message.notification?.title ?: "Fleet Alert"
        val body = message.notification?.body ?: "New message"

        CoroutineScope(Dispatchers.IO).launch {
            val notification = NotificationItem(
                id = UUID.randomUUID().toString(),
                tenantId = tenantId,
                vehicleId = vehicleId,
                title = title,
                message = body,
                severity = "info",
                timestamp = Instant.now().toString(),
                read = false
            )
            AppGraph.repository.addNotification(notification)
        }
    }
}
