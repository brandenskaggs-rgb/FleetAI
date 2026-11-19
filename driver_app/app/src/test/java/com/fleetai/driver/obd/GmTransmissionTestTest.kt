package com.fleetai.driver.obd

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test

class GmTransmissionTestTest {
    @Test fun `requires Camaro LLT year and 11 bit CAN`() {
        assertNull(GmTransmissionTest.vehicleRejection("2G1FB1EV0A9123456", "ISO 15765-4 (CAN 11/500)"))
        for (vin in listOf(null, "", "2G1FB1EV0B9123456", "2G1FB1EW0A9123456", "2G1AB1EV0A9123456")) {
            assertNotNull(GmTransmissionTest.vehicleRejection(vin, "CAN 11/500"))
        }
        for (protocol in listOf("", "AUTO", "CAN 29/500", "CAN 11/250", "ISO 9141-2")) {
            assertNotNull(GmTransmissionTest.vehicleRejection("2G1FB1EV0A9123456", protocol))
        }
    }

    @Test fun `decodes vendor one byte offset without accepting unrelated packets`() {
        assertEquals(80.0, GmTransmissionTest.temperature("62 19 40 78")!!, 0.0)
        assertEquals(-40.0, GmTransmissionTest.temperature("62194000")!!, 0.0)
        assertEquals(215.0, GmTransmissionTest.temperature("621940FF")!!, 0.0)
        for (reply in listOf(null, "NO DATA", "7F2231", "621940", "6219400078", "62194178", "62 19 40\n78", "62194078\n62194079")) {
            assertNull(reply, GmTransmissionTest.temperature(reply))
        }
    }

    @Test fun `requires exact fresh zero speed packet`() {
        assertTrue(GmTransmissionTest.stationary("41 0D 00"))
        for (reply in listOf(null, "NO DATA", "410D01", "410D", "410D00\n410D10", "410D0010")) {
            assertFalse(GmTransmissionTest.stationary(reply))
        }
    }

    @Test fun `only documented read and header commands are sent and normal header restored`() = runBlocking {
        for (header in GmTransmissionTest.headers) {
            val commands = mutableListOf<String>()
            val result = GmTransmissionTest.attempt(header) { command ->
                commands += command
                when (command) { "010D" -> "410D00"; "221940" -> "62194078"; else -> "OK" }
            }
            assertEquals(listOf("ATSH7DF", "010D", "ATSH$header", "221940", "ATSH7DF"), commands)
            assertTrue(commands.all(ObdReadOnlyPolicy::allows))
            assertEquals(80.0, result.temperatureC!!, 0.0)
        }
    }

    @Test fun `moving or unreadable speed sends no enhanced request`() = runBlocking {
        for (speed in listOf(null, "410D20", "410D00\n410D20")) {
            val commands = mutableListOf<String>()
            val failure = runCatching {
                GmTransmissionTest.attempt("7E2") { command ->
                    commands += command
                    if (command == "010D") speed else "OK"
                }
            }.exceptionOrNull()
            assertTrue(failure is IllegalStateException)
            assertEquals(listOf("ATSH7DF", "010D"), commands)
        }
    }

    @Test fun `negative timeout malformed and header failures never become a temperature`() = runBlocking {
        for (response in listOf(null, "NO DATA", "7F2231", "621940", "621940\n78")) {
            val commands = mutableListOf<String>()
            val result = GmTransmissionTest.attempt("7E2") { command ->
                commands += command
                when (command) { "010D" -> "410D00"; "221940" -> response; else -> "OK" }
            }
            assertNull(result.temperatureC)
            assertEquals("ATSH7DF", commands.last())
        }
        val commands = mutableListOf<String>()
        val result = GmTransmissionTest.attempt("7E2") { command ->
            commands += command
            when (command) { "010D" -> "410D00"; "ATSH7E2" -> "?"; else -> "OK" }
        }
        assertNull(result.temperatureC)
        assertFalse("221940" in commands)
        assertEquals("ATSH7DF", commands.last())
    }

    @Test fun `transport exception still restores normal address`() = runBlocking {
        val commands = mutableListOf<String>()
        val failure = runCatching {
            GmTransmissionTest.attempt("7E2") { command ->
                commands += command
                when (command) {
                    "010D" -> "410D00"
                    "221940" -> throw java.io.IOException("Read failed")
                    else -> "OK"
                }
            }
        }.exceptionOrNull()
        assertTrue(failure is java.io.IOException)
        assertEquals("ATSH7DF", commands.last())
    }

    @Test fun `cancellation completes restoration before releasing caller`() = runBlocking {
        val entered = CompletableDeferred<Unit>()
        val commands = mutableListOf<String>()
        val job = launch {
            GmTransmissionTest.attempt("7E2") { command ->
                commands += command
                when (command) {
                    "010D" -> "410D00"
                    "221940" -> { entered.complete(Unit); awaitCancellation() }
                    else -> "OK"
                }
            }
        }
        entered.await()
        job.cancelAndJoin()
        assertEquals("ATSH7DF", commands.last())
    }

    @Test fun `failed restoration is a distinct fail closed error`() = runBlocking {
        for (throws in listOf(false, true)) {
            var restorations = 0
            val failure = runCatching {
                GmTransmissionTest.attempt("7E2") { command ->
                    when (command) {
                        "010D" -> "410D00"
                        "221940" -> "62194078"
                        "ATSH7DF" -> if (++restorations == 1) "OK" else {
                            if (throws) throw java.io.IOException("Disconnected") else null
                        }
                        else -> "OK"
                    }
                }
            }.exceptionOrNull()
            assertTrue(failure is GmTransmissionTest.RestoreFailed)
        }
    }

    @Test fun `rejects arbitrary test addresses before transport`() = runBlocking {
        val failure = runCatching {
            GmTransmissionTest.attempt("760") { fail("ABS must not be accessed"); null }
        }.exceptionOrNull()
        assertTrue(failure is IllegalArgumentException)
    }
}
