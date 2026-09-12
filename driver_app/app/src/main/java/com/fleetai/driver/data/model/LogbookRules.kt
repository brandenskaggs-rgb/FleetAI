package com.fleetai.driver.data.model

import java.time.Instant
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.LocalTime
import java.time.ZoneId

object LogbookRules {
    fun dutyStatus(value: String): DutyStatus? = when (value.trim().uppercase()) {
        "OFF", "OFF_DUTY" -> DutyStatus.OFF
        "ON", "ON_DUTY" -> DutyStatus.ON
        "DRIVING" -> DutyStatus.DRIVING
        "SLEEPER", "SB", "SLEEPER_BERTH" -> DutyStatus.SLEEPER
        else -> null
    }

    fun label(status: DutyStatus): String = when (status) {
        DutyStatus.OFF -> "Off duty"
        DutyStatus.ON -> "On duty"
        DutyStatus.DRIVING -> "Driving"
        DutyStatus.SLEEPER -> "Sleeper berth"
    }

    fun changeTime(date: LocalDate, time: String, zone: ZoneId, now: Instant = Instant.now()): Instant {
        require(time.matches(Regex("(?:[01][0-9]|2[0-3]):[0-5][0-9]"))) { "Enter a time in 24-hour format, such as 14:30." }
        val today = now.atZone(zone).toLocalDate()
        require(!date.isAfter(today) && !date.isBefore(today.minusDays(7))) { "Choose today or one of the previous seven days." }
        val local = LocalDateTime.of(date, LocalTime.parse(time))
        val offsets = zone.rules.getValidOffsets(local)
        require(offsets.size == 1) { "This time is skipped or repeated by daylight saving. Contact your fleet manager to review the record." }
        val instant = local.toInstant(offsets.single())
        require(!instant.isAfter(now)) { "A duty change cannot be in the future." }
        return instant
    }

    fun visibleEvents(remote: List<HosEvent>, local: List<HosEvent>, offline: Boolean): List<HosEvent> =
        (if (offline) local else remote + local.filter { it.pendingUpload })
            .distinctBy { it.id }
            .sortedByDescending { it.startTime }
}
