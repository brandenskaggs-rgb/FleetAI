package com.fleetai.driver.data

import androidx.lifecycle.viewModelScope
import com.fleetai.driver.data.model.DutyStatus
import com.fleetai.driver.data.model.EldDeviceStatus
import com.fleetai.driver.data.repository.DriverRepository
import com.fleetai.driver.ui.viewmodel.HomeViewModel
import com.fleetai.driver.ui.viewmodel.StatusViewModel
import kotlinx.coroutines.*
import kotlinx.coroutines.test.*
import org.junit.Assert.*
import org.junit.Test
import java.lang.reflect.Proxy

@OptIn(ExperimentalCoroutinesApi::class)
class DutyViewModelTest {
    private var status = EldDeviceStatus(false, false, false, false, false, DutyStatus.OFF, false, "", 0)
    private var failSave = false
    private var writes = 0
    private val repo = Proxy.newProxyInstance(DriverRepository::class.java.classLoader, arrayOf(DriverRepository::class.java)) { _, method, args ->
        when (method.name) {
            "getEldDeviceStatus" -> status
            "getEldHosStatus" -> throw IllegalStateException("No clock history")
            "updateDutyStatus" -> {
                if (failSave) throw IllegalStateException("Network rejected")
                writes++
                status = status.copy(dutyStatus = args!![0] as DutyStatus)
                Unit
            }
            else -> throw IllegalStateException("Unexpected call ${method.name}")
        }
    } as DriverRepository

    @Test fun pilotOnDutyDrivingAndBreakPersistAcrossRefresh() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        val vm = HomeViewModel(repo)
        try {
            runCurrent()
            assertTrue(vm.uiState.value.statusMessage.contains("No carrier ELD setup required"))
            vm.setDutyStatus(DutyStatus.ON); runCurrent()
            assertEquals(DutyStatus.ON, vm.uiState.value.dutyStatus)
            vm.setDutyStatus(DutyStatus.DRIVING); runCurrent()
            vm.refresh(); runCurrent()
            assertEquals(DutyStatus.DRIVING, vm.uiState.value.dutyStatus)
            vm.takeBreak(); runCurrent()
            assertEquals(DutyStatus.OFF, vm.uiState.value.dutyStatus)
            assertEquals(3, writes)
        } finally { vm.viewModelScope.cancel(); Dispatchers.resetMain() }
    }

    @Test fun eldStillRejectsManualDriving() = runTest {
        status = status.copy(enabled = true, driverLoggedIn = true)
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        val vm = HomeViewModel(repo)
        try {
            runCurrent(); vm.setDutyStatus(DutyStatus.DRIVING); runCurrent()
            assertEquals(0, writes)
            assertTrue(vm.uiState.value.statusMessage.contains("automatically"))
        } finally { vm.viewModelScope.cancel(); Dispatchers.resetMain() }
    }

    @Test fun failedStatusSaveDoesNotInventSuccessfulStatus() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        val vm = StatusViewModel(repo)
        try {
            runCurrent(); failSave = true
            vm.setStatus(DutyStatus.ON); runCurrent()
            assertEquals(DutyStatus.OFF, vm.dutyStatus.value)
            assertTrue(vm.message.value.contains("Unable to confirm"))
            assertFalse(vm.saving.value)
        } finally { vm.viewModelScope.cancel(); Dispatchers.resetMain() }
    }

    @Test fun pilotStatusScreenAllowsDrivingWithoutEldSetup() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        val vm = StatusViewModel(repo)
        try {
            runCurrent(); vm.setStatus(DutyStatus.DRIVING); runCurrent()
            assertEquals(DutyStatus.DRIVING, vm.dutyStatus.value)
            assertFalse(vm.eldEnabled.value)
            assertEquals(1, writes)
        } finally { vm.viewModelScope.cancel(); Dispatchers.resetMain() }
    }
}
