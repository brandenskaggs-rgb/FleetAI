package com.fleetai.driver.obd

import com.fleetai.driver.AppGraph

object ObdService {
    // Lazy so AppGraph.appContext is guaranteed initialized before first access
    val manager: ObdConnectionManager by lazy { ObdConnectionManager(AppGraph.appContext) }
}
