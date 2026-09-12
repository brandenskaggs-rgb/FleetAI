package com.fleetai.driver

import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.material3.Surface
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.unit.dp
import androidx.test.platform.app.InstrumentationRegistry
import com.fleetai.driver.data.model.DutyStatus
import com.fleetai.driver.data.model.EldDeviceStatus
import com.fleetai.driver.data.model.ThemeMode
import com.fleetai.driver.data.repository.DriverRepository
import com.fleetai.driver.ui.screens.StatusScreen
import com.fleetai.driver.ui.theme.FleetAITheme
import com.fleetai.driver.ui.viewmodel.StatusViewModel
import org.junit.Rule
import org.junit.Test
import java.lang.reflect.Proxy
import java.io.File
import android.graphics.Bitmap

class PilotStatusScreenTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()

    private fun render(enabled: Boolean) {
        var duty = DutyStatus.OFF
        val repo = Proxy.newProxyInstance(DriverRepository::class.java.classLoader,
            arrayOf(DriverRepository::class.java)) { _, method, args ->
            when (method.name) {
                "getEldDeviceStatus" -> EldDeviceStatus(enabled, false, false, false, false, duty, false, "", 0)
                "updateDutyStatus" -> { duty = args!![0] as DutyStatus; Unit }
                "toString" -> "Isolated pilot UI fixture"
                else -> throw IllegalStateException("Unexpected test call: ${method.name}")
            }
        } as DriverRepository
        compose.activityRule.scenario.onActivity { activity ->
            val model = StatusViewModel(repo)
            activity.setContent {
                FleetAITheme(ThemeMode.LIGHT) { Surface { StatusScreen(PaddingValues(32.dp), model) } }
            }
        }
        compose.waitForIdle()
    }

    @Test fun pilotCanRecordOnDutyDrivingAndBreakWithoutCarrierSetup() {
        render(false)
        compose.onNodeWithText("Pilot activity").assertIsDisplayed()
        compose.onNodeWithText("On duty").performScrollTo().performClick()
        compose.waitForIdle()
        compose.onNodeWithText("Current: On duty").assertIsDisplayed()
        compose.onNodeWithText("Driving").performScrollTo().performClick()
        compose.waitForIdle()
        compose.onNodeWithText("Current: Driving").assertIsDisplayed()
        compose.onNodeWithText("Off duty").performScrollTo().performClick()
        compose.waitForIdle()
        compose.onNodeWithText("Current: Off duty").assertIsDisplayed()
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val bitmap = instrumentation.uiAutomation.takeScreenshot()
        File(instrumentation.targetContext.filesDir, "qa-pilot-status.png").outputStream().use {
            bitmap.compress(Bitmap.CompressFormat.PNG, 100, it)
        }
        bitmap.recycle()
    }

    @Test fun eldManualDrivingRemainsDisabled() {
        render(true)
        compose.onNodeWithText("Duty status").assertIsDisplayed()
        compose.onNodeWithText("Driving").performScrollTo().assertIsNotEnabled()
    }
}
