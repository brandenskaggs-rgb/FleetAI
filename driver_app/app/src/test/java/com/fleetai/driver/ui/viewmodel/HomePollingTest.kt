package com.fleetai.driver.ui.viewmodel

import androidx.lifecycle.viewModelScope
import com.fleetai.driver.data.model.DutyStatus
import com.fleetai.driver.data.model.EldDeviceStatus
import com.fleetai.driver.data.repository.DriverRepository
import java.lang.reflect.Proxy
import kotlinx.coroutines.*
import kotlinx.coroutines.test.*
import org.junit.Assert.assertEquals
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class HomePollingTest {
    @Test fun homeOnlyPollsWhenObservedAndDoesNotLoopOnUnconfirmedLogin() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        var statusReads = 0
        var logins = 0
        val repo = Proxy.newProxyInstance(DriverRepository::class.java.classLoader,
            arrayOf(DriverRepository::class.java)) { _, method, _ ->
            when (method.name) {
                "getEldDeviceStatus" -> {
                    statusReads++
                    EldDeviceStatus(true, false, false, false, false, DutyStatus.OFF, false, "", 0)
                }
                "recordEldLogin" -> { logins++; Unit }
                "getEldHosStatus" -> throw java.io.IOException("offline fixture")
                else -> error("Unexpected call: " + method.name)
            }
        } as DriverRepository
        val vm = HomeViewModel(repo)
        try {
            runCurrent()
            assertEquals(1, statusReads)
            val screen = launch { vm.uiState.collect {} }
            advanceTimeBy(12_000)
            assertEquals(3, statusReads)
            assertEquals(1, logins)
            screen.cancel()
            advanceTimeBy(20_000)
            assertEquals(3, statusReads)
        } finally {
            vm.viewModelScope.cancel()
            Dispatchers.resetMain()
        }
    }
}
