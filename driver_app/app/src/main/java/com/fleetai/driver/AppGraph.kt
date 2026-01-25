package com.fleetai.driver

import android.content.Context
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import com.fleetai.driver.data.local.AppPreferences
import com.fleetai.driver.data.local.DriverDatabase
import com.fleetai.driver.data.repository.DefaultDriverRepository
import com.fleetai.driver.data.repository.DriverRepository
import com.fleetai.driver.network.ApiClient
import com.fleetai.driver.network.MockApiService
import com.fleetai.driver.ui.viewmodel.DiagnosticsViewModel
import com.fleetai.driver.ui.viewmodel.HomeViewModel
import com.fleetai.driver.ui.viewmodel.LogbookViewModel
import com.fleetai.driver.ui.viewmodel.NotificationsViewModel
import com.fleetai.driver.ui.viewmodel.RouteViewModel
import com.fleetai.driver.ui.viewmodel.SensorViewModel
import com.fleetai.driver.ui.viewmodel.SessionViewModel
import com.fleetai.driver.ui.viewmodel.SettingsViewModel
import com.fleetai.driver.ui.viewmodel.StatusViewModel
import com.fleetai.driver.ui.viewmodel.VehicleViewModel

object AppGraph {
    lateinit var repository: DriverRepository
        private set
    lateinit var preferences: AppPreferences
        private set

    fun init(context: Context) {
        preferences = AppPreferences(context)
        ApiClient.init(preferences)
        val db = DriverDatabase.create(context)
        repository = DefaultDriverRepository(
            api = ApiClient.api,
            mockApi = MockApiService(),
            preferences = preferences,
            hosDao = db.hosDao(),
            notificationDao = db.notificationDao(),
            vehicleDao = db.vehicleDao()
        )
    }

    val viewModelFactory = object : ViewModelProvider.Factory {
        @Suppress("UNCHECKED_CAST")
        override fun <T : ViewModel> create(modelClass: Class<T>): T {
            return when (modelClass) {
                HomeViewModel::class.java -> HomeViewModel(repository) as T
                LogbookViewModel::class.java -> LogbookViewModel(repository, preferences) as T
                StatusViewModel::class.java -> StatusViewModel(repository) as T
                DiagnosticsViewModel::class.java -> DiagnosticsViewModel(repository, preferences) as T
                VehicleViewModel::class.java -> VehicleViewModel(repository, preferences) as T
                SessionViewModel::class.java -> SessionViewModel(repository, preferences) as T
                SensorViewModel::class.java -> SensorViewModel(preferences) as T
                NotificationsViewModel::class.java -> NotificationsViewModel(repository, preferences) as T
                RouteViewModel::class.java -> RouteViewModel() as T
                SettingsViewModel::class.java -> SettingsViewModel(repository, preferences) as T
                else -> throw IllegalArgumentException("Unknown ViewModel: ${modelClass.name}")
            }
        }
    }
}
