package com.fleetai.driver

import android.os.Build
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
import androidx.test.platform.app.InstrumentationRegistry
import com.fleetai.driver.data.local.AppPreferences
import com.fleetai.driver.network.ApiClient
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.ExternalResource
import org.junit.rules.RuleChain

/** Explicit live reviewer-fleet acceptance test. Never uses customer fixtures or hardware. */
class ReviewerPairingReleaseTest {
    private val compose = createAndroidComposeRule<MainActivity>()
    private val args get() = InstrumentationRegistry.getArguments()
    private var reviewOrg = ""
    private val guard = object : ExternalResource() {
        override fun before() = runBlocking {
            assumeTrue("Live reviewer test is opt-in", args.getString("reviewerLiveTest") == "true")
            check(Build.HARDWARE == "ranchu" || Build.HARDWARE == "goldfish")
            check(!BuildConfig.DEBUG) { "Use the signed release build." }
            reviewOrg = args.getString("reviewOrgId").orEmpty()
            check(reviewOrg.startsWith("ORG_") && reviewOrg.length > 4)
            for (key in listOf("reviewPairingCode", "reviewDriverPin")) {
                check(args.getString(key).orEmpty().matches(Regex("[0-9]{6}"))) { "Missing reviewer credentials." }
            }
            val prefs = AppPreferences(InstrumentationRegistry.getInstrumentation().targetContext)
            check(prefs.token.first().isBlank()) { "Refusing to replace an existing session." }
        }

        override fun after() = runBlocking {
            val prefs = AppPreferences(InstrumentationRegistry.getInstrumentation().targetContext)
            if (reviewOrg.isNotBlank() && prefs.tenantId.first() == reviewOrg &&
                prefs.vehicleId.first() == "PLAY-REVIEW-01") prefs.clearSession()
        }
    }
    @get:Rule val rules: RuleChain = RuleChain.outerRule(guard).around(compose)

    @Test fun reviewerCanPairAndRestoreTheAssignedSession() {
        compose.waitUntil(20_000) {
            compose.onAllNodesWithText("1. Pairing code (6 digits)").fetchSemanticsNodes().isNotEmpty()
        }
        compose.onNode(hasText("1. Pairing code (6 digits)") and hasSetTextAction())
            .performScrollTo().performTextInput(args.getString("reviewPairingCode")!!)
        compose.onNode(hasText("2. Driver PIN (6 digits)") and hasSetTextAction())
            .performScrollTo().performTextInput(args.getString("reviewDriverPin")!!)
        compose.onNodeWithText("Pair tablet").performScrollTo().performClick()
        compose.waitUntil(30_000) {
            compose.onAllNodesWithText("Google Play Reviewer").fetchSemanticsNodes().isNotEmpty()
        }
        compose.onNodeWithText("Google Play Reviewer").assertIsDisplayed()
        val prefs = AppPreferences(InstrumentationRegistry.getInstrumentation().targetContext)
        runBlocking {
            assertTrue("Reviewer organization mismatch", prefs.tenantId.first() == reviewOrg)
            assertTrue("Reviewer vehicle mismatch", prefs.vehicleId.first() == "PLAY-REVIEW-01")
            assertTrue("Missing saved device token", prefs.token.first().isNotBlank())
            assertTrue("Live pairing must not be training", !prefs.trainingSession.first())
            val profile = ApiClient.api.getDriverProfile()
            assertTrue("Authenticated profile is outside reviewer fleet", profile.tenantId == reviewOrg)
            assertTrue("Authenticated driver mismatch", profile.driverId == prefs.driverId.first())
        }
        compose.activityRule.scenario.recreate()
        compose.waitUntil(30_000) {
            compose.onAllNodesWithText("Google Play Reviewer").fetchSemanticsNodes().isNotEmpty()
        }
        compose.onNodeWithText("Google Play Reviewer").assertIsDisplayed()
    }
}
