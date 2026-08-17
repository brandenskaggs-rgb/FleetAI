package com.fleetai.driver.network

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ServerConfigTest {
    @Test
    fun `bare public host defaults to https`() {
        assertEquals("https://fleetaiops.com", ServerConfig.normalize("fleetaiops.com"))
    }

    @Test
    fun `saved public http host is repaired to https`() {
        assertEquals("https://fleetaiops.com", ServerConfig.normalize("http://fleetaiops.com"))
        assertEquals("https://fleetaiops.com", ServerConfig.normalize("https://fleetaiops.com"))
    }

    @Test
    fun `unsupported www alias is canonicalized`() {
        assertEquals("https://fleetaiops.com", ServerConfig.normalize("www.fleetaiops.com"))
    }

    @Test
    fun `explicit local emulator endpoint keeps http`() {
        assertEquals("http://10.0.2.2:3000", ServerConfig.normalize("http://10.0.2.2:3000"))
    }

    @Test
    fun `validated production host returns secure URL`() {
        val result = ServerConfig.validate("fleetaiops.com")
        assertEquals("https://fleetaiops.com", result.url)
        assertNull(result.error)
    }
}
