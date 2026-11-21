package com.fleetai.driver

import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.unit.dp
import com.fleetai.driver.data.model.DtcCode
import com.fleetai.driver.data.repository.DriverRepository
import com.fleetai.driver.ui.screens.DiagnosticsScreen
import com.fleetai.driver.ui.viewmodel.DiagnosticsViewModel
import org.junit.Rule
import org.junit.Test
import java.lang.reflect.Proxy

class FaultCodesScreenTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()

    @Test fun showsDuplicateCodeStatusesAndCanRefreshWithoutAnAdapter() {
        val repo = Proxy.newProxyInstance(DriverRepository::class.java.classLoader,
            arrayOf(DriverRepository::class.java)) { _, method, _ ->
            check(method.name == "getDiagnosticCodes")
            listOf(DtcCode("P0430", "Confirmed", "warning"), DtcCode("P0430", "Permanent", "warning"))
        } as DriverRepository
        compose.activityRule.scenario.onActivity { activity ->
            val model = DiagnosticsViewModel(repo, AppGraph.preferences, activity.applicationContext)
            activity.setContent { DiagnosticsScreen(PaddingValues(0.dp), model) }
        }
        val list = compose.onNode(hasScrollToNodeAction())
        list.performScrollToNode(hasText("Confirmed"))
        list.performScrollToNode(hasText("Permanent"))
        list.performScrollToNode(hasText("Read fault codes"))
        compose.onNodeWithText("Read fault codes").performClick()
        compose.onNodeWithText("Adapter disconnected.", substring = true).assertExists()
        list.performScrollToNode(hasText("Permanent"))
    }
}
