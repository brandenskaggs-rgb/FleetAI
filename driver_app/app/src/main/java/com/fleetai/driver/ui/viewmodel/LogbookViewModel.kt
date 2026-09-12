package com.fleetai.driver.ui.viewmodel

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.fleetai.driver.data.local.AppPreferences
import com.fleetai.driver.data.model.DutyStatus
import com.fleetai.driver.data.model.HosEvent
import com.fleetai.driver.data.model.LogbookRules
import com.fleetai.driver.data.repository.DriverRepository
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale
import java.util.UUID

class LogbookViewModel(
    private val repository: DriverRepository,
    private val preferences: AppPreferences
) : ViewModel() {
    private val _events = MutableStateFlow<List<HosEvent>>(emptyList())
    val events: StateFlow<List<HosEvent>> = _events
    private val _message = MutableStateFlow("")
    val message: StateFlow<String> = _message
    private val _selectedDate = MutableStateFlow(LocalDate.now())
    val selectedDate: StateFlow<LocalDate> = _selectedDate
    private val _loading = MutableStateFlow(false)
    val loading: StateFlow<Boolean> = _loading
    private val _saving = MutableStateFlow(false)
    val saving: StateFlow<Boolean> = _saving
    private val _offline = MutableStateFlow(false)
    val offline: StateFlow<Boolean> = _offline
    private val _unreadable = MutableStateFlow(0)
    val unreadable: StateFlow<Int> = _unreadable
    private val _canCertify = MutableStateFlow(false)
    val canCertify: StateFlow<Boolean> = _canCertify
    private var loadJob: Job? = null
    private var loadGeneration = 0

    init { loadLogs() }

    fun clearMessage() { _message.value = "" }

    fun loadLogs(date: LocalDate = _selectedDate.value) {
        val today = LocalDate.now()
        if (date.isAfter(today) || date.isBefore(today.minusDays(7))) return
        loadJob?.cancel()
        val generation = ++loadGeneration
        if (date != _selectedDate.value) _events.value = emptyList()
        _selectedDate.value = date
        _canCertify.value = false
        _loading.value = true
        loadJob = viewModelScope.launch {
            try {
                val snapshot = repository.getLogbook(date.toString())
                _events.value = snapshot.events
                _offline.value = snapshot.offline
                _unreadable.value = snapshot.unreadableRecords
                val status = try { repository.getEldDeviceStatus() }
                catch (cancelled: CancellationException) { throw cancelled }
                catch (_: Exception) { null }
                _canCertify.value = status?.enabled == true && status.productionAuthorized && status.driverLoggedIn
                    && !snapshot.offline && snapshot.unreadableRecords == 0
                    && snapshot.events.none { it.pendingUpload }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                _offline.value = true
                _message.value = "Unable to load this day. Check your connection and try Refresh."
            } finally {
                if (generation == loadGeneration) _loading.value = false
            }
        }
    }

    fun recordDutyChange(status: DutyStatus, time: String, notes: String, onSaved: () -> Unit) {
        if (_saving.value) return
        if (status == DutyStatus.DRIVING) {
            _message.value = "Driving is recorded automatically; it cannot be added manually."
            return
        }
        val date = _selectedDate.value
        val instant = try { LogbookRules.changeTime(date, time, ZoneId.systemDefault()) }
        catch (error: IllegalArgumentException) { _message.value = error.message.orEmpty(); return }
        if (notes.trim().length !in 4..60) {
            _message.value = "Add a short reason (4 to 60 characters)."
            return
        }
        _saving.value = true
        viewModelScope.launch {
            try {
                val tenantId = preferences.tenantId.first()
                val vehicleId = preferences.vehicleId.first()
                val driverId = preferences.driverId.first()
                check(tenantId.isNotBlank() && vehicleId.isNotBlank() && driverId.isNotBlank())
                repository.addHosEvent(HosEvent(UUID.randomUUID().toString(), tenantId, vehicleId, driverId,
                    status, notes.trim(), instant.toString(), instant.toString(), date.toString()))
                _message.value = "Saved on this tablet. Upload status is shown beside the entry."
                onSaved()
                loadLogs(date)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                _message.value = "Could not save the entry. Check the driver and vehicle assignment."
            } finally {
                _saving.value = false
            }
        }
    }

    fun certify() {
        if (!_canCertify.value || _saving.value || _loading.value) return
        val date = _selectedDate.value
        _saving.value = true
        viewModelScope.launch {
            try {
                repository.certifyEldRecords(date.format(DateTimeFormatter.ofPattern("yyMMdd", Locale.US)))
                _message.value = "Certification saved for $date."
                loadLogs(date)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                _message.value = "Certification was not saved. Check the connection and ELD setup."
            } finally {
                _saving.value = false
            }
        }
    }
}
