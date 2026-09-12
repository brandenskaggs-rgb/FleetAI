package com.fleetai.driver

import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.material3.Surface
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.unit.dp
import androidx.test.platform.app.InstrumentationRegistry
import com.fleetai.driver.data.model.DutyStatus
import com.fleetai.driver.data.model.HosEvent
import com.fleetai.driver.data.model.LogbookSnapshot
import com.fleetai.driver.data.model.ThemeMode
import com.fleetai.driver.data.repository.DriverRepository
import com.fleetai.driver.ui.screens.LogbookScreen
import com.fleetai.driver.ui.theme.FleetAITheme
import com.fleetai.driver.ui.viewmodel.LogbookViewModel
import org.junit.Rule
import org.junit.Test
import java.lang.reflect.Proxy
import java.time.Instant
import java.io.File
import android.graphics.Bitmap

class LogbookScreenTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()

    private fun render(offline: Boolean = false) {
        // No fleet login, server mutation, real driver record or pairing change.
        val repo = Proxy.newProxyInstance(DriverRepository::class.java.classLoader,
            arrayOf(DriverRepository::class.java)) { _, method, args ->
            when (method.name) {
                "getLogbook" -> LogbookSnapshot(listOf(HosEvent("fixture", "test-org", "test-unit", "test-driver",
                    DutyStatus.ON, "Synthetic UI test / shift start", Instant.now().toString(), Instant.now().toString(),
                    args!![0].toString(), pendingUpload = true)), offline)
                "getEldDeviceStatus" -> throw IllegalStateException("Test: unavailable")
                "toString" -> "Offline test repository"
                else -> throw IllegalStateException("Unexpected test call: ${method.name}")
            }
        } as DriverRepository
        compose.activityRule.scenario.onActivity { activity ->
            val model = LogbookViewModel(repo, AppGraph.preferences)
            activity.setContent {
                FleetAITheme(ThemeMode.LIGHT) { Surface { LogbookScreen(PaddingValues(32.dp), model) } }
            }
        }
        compose.waitForIdle()
    }

    private fun screenshot(name: String) {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val bitmap = instrumentation.uiAutomation.takeScreenshot()
        File(instrumentation.targetContext.filesDir, "qa-$name.png").outputStream().use {
            bitmap.compress(Bitmap.CompressFormat.PNG, 100, it)
        }
        bitmap.recycle()
    }

    @Test fun pendingEntryAndPilotBoundaryAreVisible() {
        render()
        compose.onNodeWithText("Driver log").assertIsDisplayed()
        compose.onNodeWithText("Saved locally / awaiting server confirmation").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Review & certify").performScrollTo().assertIsNotEnabled()
        screenshot("logbook")
    }

    @Test fun formHasReadableChoicesAndNoManualDriving() {
        render()
        compose.onNodeWithText("Record duty change").performClick()
        compose.onNodeWithText("Time (24-hour, HH:mm)").assertIsDisplayed()
        compose.onNodeWithText("Off duty").assertIsDisplayed()
        compose.onNodeWithText("Sleeper berth").assertIsDisplayed()
        compose.onNodeWithText("Driving", useUnmergedTree = true).assertDoesNotExist()
        compose.onNodeWithText("Time (24-hour, HH:mm)").performTextReplacement("99:99")
        compose.onNodeWithText("Save entry").performClick()
        compose.onNodeWithText("Enter a time in 24-hour format, such as 14:30.").assertIsDisplayed()
        screenshot("logbook-form")
    }

    @Test fun offlineStateAndDayNavigationAreExplicit() {
        render(offline = true)
        compose.onNodeWithText("Offline / showing entries saved on this tablet only").assertIsDisplayed()
        compose.onNodeWithContentDescription("Next day").assertIsNotEnabled()
        compose.onNodeWithContentDescription("Previous day").performClick()
        compose.waitForIdle()
        compose.onNodeWithContentDescription("Next day").assertIsEnabled()
        repeat(6) { compose.onNodeWithContentDescription("Previous day").performClick(); compose.waitForIdle() }
        compose.onNodeWithContentDescription("Previous day").assertIsNotEnabled()
        screenshot("logbook-offline")
    }
}
