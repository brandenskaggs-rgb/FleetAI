package com.fleetai.driver

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Typeface
import android.os.Build
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.core.content.ContextCompat
import androidx.test.platform.app.InstrumentationRegistry
import com.fleetai.driver.data.local.AppPreferences
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.ExternalResource
import org.junit.rules.RuleChain
import java.io.File

/** Captures the shipped UI, not replacement composables or customer records. */
class PlayListingScreenshotsTest {
    private val compose = createAndroidComposeRule<MainActivity>()
    private val guard = object : ExternalResource() {
        override fun before() = runBlocking {
            check(Build.HARDWARE == "ranchu" || Build.HARDWARE == "goldfish")
            val prefs = AppPreferences(InstrumentationRegistry.getInstrumentation().targetContext)
            check(prefs.token.first().isBlank()) { "A clean, unpaired emulator is required." }
        }
        override fun after() = runBlocking {
            val prefs = AppPreferences(InstrumentationRegistry.getInstrumentation().targetContext)
            if (prefs.token.first().startsWith("demo_")) prefs.exitTrainingSession()
        }
    }
    @get:Rule val rules: RuleChain = RuleChain.outerRule(guard).around(compose)

    private fun save(bitmap: Bitmap, name: String) {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val folder = File(context.getExternalFilesDir(null), "play-listing").apply { mkdirs() }
        File(folder, "$name.png").outputStream().use {
            check(bitmap.compress(Bitmap.CompressFormat.PNG, 100, it))
        }
        bitmap.recycle()
    }

    private fun capture(name: String) {
        compose.waitForIdle()
        compose.onNodeWithText("Training demo / Sample data stays on this device. Not a legal ELD log.")
            .assertIsDisplayed()
        save(checkNotNull(InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot()), name)
    }

    @Test fun releaseScreensRemainUsableAndExplicitlyLabeled() {
        compose.waitUntil(15_000) { compose.onAllNodesWithText("Tablet details").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("Tablet details").performScrollTo().performClick()
        compose.onNodeWithText("View training demo").performScrollTo().performClick()
        compose.waitUntil(15_000) {
            compose.onAllNodesWithText("Training demo / Sample data stays on this device. Not a legal ELD log.")
                .fetchSemanticsNodes().isNotEmpty()
        }
        capture("01-home")
        for ((index, screen) in listOf("Sensors", "Logbook", "Inspect").withIndex()) {
            compose.onNode(hasText(screen) and isSelectable()).performClick()
            capture("0${index + 2}-${screen.lowercase()}")
        }
        val prefs = AppPreferences(InstrumentationRegistry.getInstrumentation().targetContext)
        runBlocking { assertTrue(prefs.trainingSession.first()) }
        renderBrandAssets()
    }

    private fun renderBrandAssets() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val icon = checkNotNull(ContextCompat.getDrawable(context, R.drawable.ic_launcher_foreground))
        val square = Bitmap.createBitmap(512, 512, Bitmap.Config.ARGB_8888)
        Canvas(square).apply { drawColor(Color.WHITE); icon.setBounds(0, 0, 512, 512); icon.draw(this) }
        save(square, "app-icon-512")
        val feature = Bitmap.createBitmap(1024, 500, Bitmap.Config.ARGB_8888)
        Canvas(feature).apply {
            drawColor(Color.WHITE)
            icon.setBounds(584, 30, 1024, 470)
            icon.draw(this)
            val ink = Paint(Paint.ANTI_ALIAS_FLAG).apply {
                color = Color.rgb(23, 34, 37)
                typeface = Typeface.create("sans-serif", Typeface.BOLD)
                textSize = 66f
            }
            drawText("Fleet AI Driver", 64f, 219f, ink)
            ink.typeface = Typeface.create("sans-serif", Typeface.NORMAL)
            ink.textSize = 27f
            drawText("Vehicle readings. Driver records.", 67f, 275f, ink)
        }
        save(feature, "feature-graphic-1024x500")
    }
}
