package com.fleetai.driver.data

import com.fleetai.driver.data.sync.SyncPass
import com.fleetai.driver.telemetry.TelemetryOutbox.FlushResult
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.launch
import kotlinx.coroutines.cancel
import org.junit.Assert.*
import org.junit.Test

class SyncPassTest {
    @Test fun failedLogsDoNotSkipTelemetryAndStillRetry() = runBlocking {
        var flushed = false
        val retry = SyncPass.needsRetry({ throw IllegalStateException("Rejected log") }, {
            flushed = true
            FlushResult(1, 0, 0)
        })
        assertTrue(flushed)
        assertTrue(retry)
    }

    @Test fun failedLogsDoNotStopMultiBatchDrain() = runBlocking {
        var batches = 0
        assertTrue(SyncPass.needsRetry({ throw IllegalStateException("Offline log") }, {
            batches++
            FlushResult(100, 0, if (batches < 3) 100 else 0)
        }))
        assertEquals(3, batches)
    }

    @Test fun successfulQueuesFinishWithoutRetry() = runBlocking {
        val order = mutableListOf<String>()
        assertFalse(SyncPass.needsRetry({ order.add("logs"); Unit }, {
            order.add("telemetry")
            FlushResult(0, 0, 0)
        }))
        assertEquals(listOf("logs", "telemetry"), order)
    }

    @Test fun remainingTelemetryIsDrained() = runBlocking {
        var batches = 0
        assertFalse(SyncPass.needsRetry({}, {
            batches++
            FlushResult(100, 0, if (batches == 1) 50 else 0)
        }))
        assertEquals(2, batches)
    }

    @Test fun passRemainsBoundedAndRequestsAnotherRun() = runBlocking {
        var batches = 0
        assertTrue(SyncPass.needsRetry({}, { batches++; FlushResult(100, 0, 100) }))
        assertEquals(5, batches)
        assertEquals(100, SyncPass.FLUSH_BATCH_SIZE)
    }

    @Test fun telemetryFailureRetriesAfterLogsRun() = runBlocking {
        var logsRan = false
        var batches = 0
        assertTrue(SyncPass.needsRetry({ logsRan = true }, { batches++; FlushResult(0, 1, 1) }))
        assertTrue(logsRan)
        assertEquals(1, batches)
    }

    @Test fun telemetryExceptionRequestsRetry() = runBlocking {
        assertTrue(SyncPass.needsRetry({}, { throw IllegalStateException("Network failure") }))
    }

    @Test fun blockedTelemetryDoesNotSpinOnCredentials() = runBlocking {
        var batches = 0
        assertFalse(SyncPass.needsRetry({}, { batches++; FlushResult(0, 1, 10, true) }))
        assertEquals(1, batches)
    }

    @Test fun blockedTelemetryDoesNotEraseFailedLogRetry() = runBlocking {
        assertTrue(SyncPass.needsRetry({ throw IllegalStateException("Rejected log") }, {
            FlushResult(0, 0, 10, true)
        }))
    }

    @Test fun cancelledLogSyncDoesNotStartAnotherQueue() = runBlocking {
        val cancellation = CancellationException("Worker stopped")
        var flushed = false
        try {
            SyncPass.needsRetry({ throw cancellation }, { flushed = true; FlushResult(0, 0, 0) })
            fail("Expected cancellation")
        } catch (actual: CancellationException) {
            assertSame(cancellation, actual)
        }
        assertFalse(flushed)
    }

    @Test fun cancelledTelemetryIsNotConvertedToRetry() = runBlocking {
        val cancellation = CancellationException("Worker stopped")
        try {
            SyncPass.needsRetry({}, { throw cancellation })
            fail("Expected cancellation")
        } catch (actual: CancellationException) {
            assertSame(cancellation, actual)
        }
    }

    @Test fun swallowedCancellationCannotReportSuccess() = runBlocking {
        var returned = false
        val worker = launch {
            SyncPass.needsRetry({}, { cancel(); FlushResult(0, 0, 0) })
            returned = true
        }
        worker.join()
        assertTrue(worker.isCancelled)
        assertFalse(returned)
    }
}
