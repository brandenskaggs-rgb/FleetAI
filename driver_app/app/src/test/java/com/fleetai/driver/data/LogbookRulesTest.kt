package com.fleetai.driver.data

import com.fleetai.driver.data.model.DutyStatus
import com.fleetai.driver.data.model.HosEvent
import com.fleetai.driver.data.model.LogbookRules
import org.junit.Assert.*
import org.junit.Test
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId

class LogbookRulesTest {
    private val zone = ZoneId.of("America/Chicago")
    private val now = Instant.parse("2026-09-11T20:00:00Z")
    private val date = LocalDate.parse("2026-09-11")
    private fun event(id: String, pending: Boolean = false) = HosEvent(id, "org-a", "unit-a", "driver-a",
        DutyStatus.ON, "Shift start", "2026-09-11T12:00:00Z", "2026-09-11T12:00:00Z", date.toString(), pending)

    @Test fun timeIncludesActualDateAndOffset() {
        assertEquals("2026-09-11T19:30:00Z", LogbookRules.changeTime(date, "14:30", zone, now).toString())
    }
    @Test fun malformedTimesAreRejected() {
        for (time in listOf("", "1:30", "24:00", "12:60", "12:00:00", "noon", "-1:00")) {
            assertThrows(IllegalArgumentException::class.java) { LogbookRules.changeTime(date, time, zone, now) }
        }
    }
    @Test fun futureTimesAreRejected() {
        assertThrows(IllegalArgumentException::class.java) { LogbookRules.changeTime(date, "15:01", zone, now) }
    }
    @Test fun historyBoundaryIncludesExactlyPreviousSevenDays() {
        assertEquals("2026-09-04T05:00:00Z", LogbookRules.changeTime(date.minusDays(7), "00:00", zone, now).toString())
        for (day in listOf(date.minusDays(8), date.plusDays(1))) {
            assertThrows(IllegalArgumentException::class.java) { LogbookRules.changeTime(day, "00:00", zone, now) }
        }
    }
    @Test fun skippedAndAmbiguousDaylightSavingTimesAreNotFabricated() {
        assertThrows(IllegalArgumentException::class.java) {
            LogbookRules.changeTime(LocalDate.parse("2026-03-08"), "02:30", zone, Instant.parse("2026-03-08T18:00:00Z"))
        }
        assertThrows(IllegalArgumentException::class.java) {
            LogbookRules.changeTime(LocalDate.parse("2026-11-01"), "01:30", zone, Instant.parse("2026-11-01T18:00:00Z"))
        }
    }
    @Test fun unknownDutyStatusNeverBecomesOffDuty() {
        for (status in listOf("", "unknown", "PERSONAL_CONVEYANCE", "YARD_MOVE")) assertNull(LogbookRules.dutyStatus(status))
        assertEquals(DutyStatus.OFF, LogbookRules.dutyStatus("OFF_DUTY"))
        assertEquals(DutyStatus.ON, LogbookRules.dutyStatus("ON_DUTY"))
        assertEquals(DutyStatus.SLEEPER, LogbookRules.dutyStatus("SB"))
        assertEquals(DutyStatus.DRIVING, LogbookRules.dutyStatus("driving"))
    }
    @Test fun pendingEntriesSurviveSuccessfulEmptyServerRead() {
        val local = listOf(event("pending", true), event("old-acknowledged"))
        assertEquals(listOf(local[0]), LogbookRules.visibleEvents(emptyList(), local, false))
    }
    @Test fun offlineReturnsOnlyLocalData() {
        val local = listOf(event("pending", true))
        assertEquals(local, LogbookRules.visibleEvents(listOf(event("remote")), local, true))
    }
    @Test fun matchingAcknowledgedIdIsNotDuplicated() {
        val remote = event("same")
        assertEquals(listOf(remote), LogbookRules.visibleEvents(listOf(remote), listOf(event("same", true)), false))
    }
    @Test fun entriesWithDifferentIdsRemainVisible() {
        assertEquals(2, LogbookRules.visibleEvents(listOf(event("remote")), listOf(event("pending", true)), false).size)
    }
}
