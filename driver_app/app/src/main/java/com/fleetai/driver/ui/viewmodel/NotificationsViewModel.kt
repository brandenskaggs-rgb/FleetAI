package com.fleetai.driver.ui.viewmodel

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.fleetai.driver.data.local.AppPreferences
import com.fleetai.driver.data.model.NotificationItem
import com.fleetai.driver.data.repository.DriverRepository
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch

class NotificationsViewModel(
    private val repository: DriverRepository,
    private val preferences: AppPreferences
) : ViewModel() {
    private val _items = MutableStateFlow<List<NotificationItem>>(emptyList())
    val items: StateFlow<List<NotificationItem>> = _items

    init {
        refresh()
    }

    fun refresh() {
        viewModelScope.launch {
            _items.value = repository.getNotifications()
        }
    }

    fun markRead(notificationId: String) {
        viewModelScope.launch {
            repository.markNotificationRead(notificationId)
            _items.value = repository.getNotifications()
        }
    }
}
