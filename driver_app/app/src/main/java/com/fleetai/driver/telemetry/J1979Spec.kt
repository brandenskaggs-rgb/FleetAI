package com.fleetai.driver.telemetry

data class PidSpec(
    val command: String,
    val key: String,
    val name: String,
    val bytes: Int,
    val unit: String,
    val minIntervalMs: Long,
    val priority: Int = 2
)

/**
 * SAE J1979 Mode 01 signals Fleet AI can decode generically.
 *
 * The ECU capability bitmap remains authoritative: a signal is polled only
 * when the vehicle advertises it. Manufacturer-specific Mode 22/UDS identifiers
 * are intentionally excluded because their addresses and scaling vary by OEM,
 * model, powertrain, and model year.
 */
object J1979Spec {
    private val plausibleRanges = mapOf(
        "rpm" to 0.0..10_000.0,
        "speedKph" to 0.0..300.0,
        "coolantTempC" to -50.0..150.0,
        "oilTempC" to -50.0..200.0,
        "intakeAirTempC" to -50.0..150.0,
        "ambientTempC" to -50.0..100.0,
        "batteryVoltageV" to 5.0..40.0,
        "mafGramsPerSec" to 0.0..1_000.0,
        "fuelLevelPct" to 0.0..100.0
    )

    val core: List<PidSpec> = listOf(
        PidSpec("010C", "rpm", "Engine RPM", 2, "rpm", 250, 0),
        PidSpec("010D", "speedKph", "Vehicle speed", 1, "kph", 250, 0),
        PidSpec("0104", "engineLoadPct", "Calculated engine load", 1, "%", 750, 0),
        PidSpec("0105", "coolantTempC", "Coolant temperature", 1, "C", 1_000, 0),
        PidSpec("010B", "mapKpa", "Intake manifold pressure", 1, "kPa", 750, 0),
        PidSpec("010F", "intakeAirTempC", "Intake air temperature", 1, "C", 1_000, 0),
        PidSpec("0110", "mafGramsPerSec", "Mass air flow", 2, "g/s", 750, 0),
        PidSpec("0111", "throttlePosPct", "Throttle position", 1, "%", 500, 0),
        PidSpec("0142", "batteryVoltageV", "Control module voltage", 2, "V", 1_000, 0)
    )

    val fuelAndAir: List<PidSpec> = listOf(
        PidSpec("0106", "shortTermFuelTrimBank1Pct", "Short-term fuel trim B1", 1, "%", 2_000, 1),
        PidSpec("0107", "longTermFuelTrimBank1Pct", "Long-term fuel trim B1", 1, "%", 4_000, 1),
        PidSpec("0108", "shortTermFuelTrimBank2Pct", "Short-term fuel trim B2", 1, "%", 2_000, 1),
        PidSpec("0109", "longTermFuelTrimBank2Pct", "Long-term fuel trim B2", 1, "%", 4_000, 1),
        PidSpec("010A", "fuelPressureKpa", "Fuel pressure", 1, "kPa", 2_000, 1),
        PidSpec("0122", "fuelRailPressureRelativeKpa", "Fuel rail pressure (relative)", 2, "kPa", 1_500, 1),
        PidSpec("0123", "fuelRailGaugePressureKpa", "Fuel rail pressure (gauge)", 2, "kPa", 1_500, 1),
        PidSpec("012C", "commandedEgrPct", "Commanded EGR", 1, "%", 2_500, 1),
        PidSpec("012D", "egrErrorPct", "EGR error", 1, "%", 2_500, 1),
        PidSpec("012E", "commandedEvapPurgePct", "Commanded evaporative purge", 1, "%", 3_000, 1),
        PidSpec("012F", "fuelLevelPct", "Fuel level", 1, "%", 5_000, 1),
        PidSpec("0144", "commandedEquivalenceRatio", "Commanded equivalence ratio", 2, "lambda", 2_000, 1),
        PidSpec("0152", "ethanolFuelPct", "Ethanol fuel percentage", 1, "%", 10_000, 2),
        PidSpec("0159", "fuelRailAbsolutePressureKpa", "Fuel rail absolute pressure", 2, "kPa", 1_500, 1),
        PidSpec("015D", "fuelInjectionTimingDeg", "Fuel injection timing", 2, "deg", 2_000, 1),
        PidSpec("015E", "fuelRateLph", "Engine fuel rate", 2, "L/h", 2_000, 1)
    )

    val combustionAndExhaust: List<PidSpec> = listOf(
        PidSpec("010E", "ignitionTimingAdvanceDeg", "Ignition timing advance", 1, "deg", 1_000, 1),
        PidSpec("0114", "o2B1S1VoltageV", "Oxygen sensor B1S1", 2, "V", 1_500, 2),
        PidSpec("0115", "o2B1S2VoltageV", "Oxygen sensor B1S2", 2, "V", 1_500, 2),
        PidSpec("0118", "o2B2S1VoltageV", "Oxygen sensor B2S1", 2, "V", 1_500, 2),
        PidSpec("0119", "o2B2S2VoltageV", "Oxygen sensor B2S2", 2, "V", 1_500, 2),
        PidSpec("013C", "catalystTempB1S1C", "Catalyst temperature B1S1", 2, "C", 3_000, 2),
        PidSpec("013D", "catalystTempB2S1C", "Catalyst temperature B2S1", 2, "C", 3_000, 2),
        PidSpec("013E", "catalystTempB1S2C", "Catalyst temperature B1S2", 2, "C", 3_000, 2),
        PidSpec("013F", "catalystTempB2S2C", "Catalyst temperature B2S2", 2, "C", 3_000, 2)
    )

    val driverAndTorque: List<PidSpec> = listOf(
        PidSpec("0145", "relativeThrottlePosPct", "Relative throttle position", 1, "%", 1_000, 2),
        PidSpec("0147", "absoluteThrottleBPosPct", "Absolute throttle position B", 1, "%", 1_000, 2),
        PidSpec("0148", "absoluteThrottleCPosPct", "Absolute throttle position C", 1, "%", 1_000, 2),
        PidSpec("0149", "acceleratorPedalDPosPct", "Accelerator pedal position D", 1, "%", 750, 1),
        PidSpec("014A", "acceleratorPedalEPosPct", "Accelerator pedal position E", 1, "%", 750, 1),
        PidSpec("014B", "acceleratorPedalFPosPct", "Accelerator pedal position F", 1, "%", 750, 1),
        PidSpec("014C", "commandedThrottleActuatorPct", "Commanded throttle actuator", 1, "%", 750, 1),
        PidSpec("015A", "relativeAcceleratorPedalPct", "Relative accelerator pedal", 1, "%", 750, 1),
        PidSpec("0161", "driverDemandTorquePct", "Driver demand torque", 1, "%", 750, 1),
        PidSpec("0162", "actualTorquePct", "Actual engine torque", 1, "%", 750, 1),
        PidSpec("0163", "referenceTorqueNm", "Engine reference torque", 2, "Nm", 5_000, 2)
    )

    val lifecycleAndEnvironment: List<PidSpec> = listOf(
        PidSpec("011F", "engineRunTimeSec", "Engine run time", 2, "s", 5_000, 2),
        PidSpec("0121", "distanceWithMilOnKm", "Distance with MIL on", 2, "km", 15_000, 2),
        PidSpec("0130", "warmupsSinceClear", "Warm-ups since codes cleared", 1, "count", 30_000, 2),
        PidSpec("0131", "distanceSinceClearKm", "Distance since codes cleared", 2, "km", 15_000, 2),
        PidSpec("0132", "evapSystemVaporPressurePa", "Evaporative system pressure", 2, "Pa", 5_000, 2),
        PidSpec("0133", "barometricPressureKpa", "Barometric pressure", 1, "kPa", 5_000, 2),
        PidSpec("0143", "absoluteLoadPct", "Absolute engine load", 2, "%", 2_000, 2),
        PidSpec("0146", "ambientTempC", "Ambient air temperature", 1, "C", 5_000, 2),
        PidSpec("014D", "milRunTimeMin", "Run time with MIL on", 2, "min", 15_000, 2),
        PidSpec("014E", "timeSinceClearMin", "Time since codes cleared", 2, "min", 15_000, 2),
        PidSpec("0153", "absoluteEvapVaporPressureKpa", "Absolute evaporative pressure", 2, "kPa", 5_000, 2),
        PidSpec("0154", "evapSystemVaporPressureWidePa", "Evaporative pressure (wide)", 2, "Pa", 5_000, 2),
        PidSpec("015B", "hybridBatteryRemainingPct", "Hybrid battery remaining", 1, "%", 5_000, 2),
        PidSpec("015C", "oilTempC", "Engine oil temperature", 1, "C", 2_000, 1),
        PidSpec("01A6", "odometerKm", "Vehicle odometer", 4, "km", 30_000, 2)
    )

    val all: List<PidSpec> = core + fuelAndAir + combustionAndExhaust + driverAndTorque + lifecycleAndEnvironment

    fun pollingPlan(supported: Set<String>): List<PidSpec> {
        if (supported.isEmpty()) return all.filter { it.priority <= 1 }
        return all.filter { supported.contains(it.command.uppercase()) }
    }

    fun isPlausible(key: String, value: Double): Boolean =
        value.isFinite() && (plausibleRanges[key]?.contains(value) ?: true)
}
