package com.fleetai.driver.obd

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

data class ExtendedPidSource(
    val name: String,
    val url: String,
    val scope: String
)

data class ExtendedPidDefinition(
    val command: String,
    val requestHeader: String,
    val responsePrefix: String,
    val key: String,
    val name: String,
    val unit: String,
    val formula: String,
    val expectedBytes: Int,
    val minValue: Double?,
    val maxValue: Double?,
    val minIntervalMs: Long,
    val priority: Int
)

data class ExtendedPidMatch(
    val wmi: Set<String>,
    val modelYearCodes: Set<String>,
    val engineVinCodes: Set<String>
) {
    fun matches(vin: String): Boolean {
        val normalized = vin.trim().uppercase()
        if (normalized.length != 17) return false
        return (wmi.isEmpty() || normalized.take(3) in wmi) &&
            (modelYearCodes.isEmpty() || normalized.substring(9, 10) in modelYearCodes) &&
            (engineVinCodes.isEmpty() || normalized.substring(7, 8) in engineVinCodes)
    }
}

data class ExtendedPidProfile(
    val id: String,
    val name: String,
    val match: ExtendedPidMatch,
    val source: ExtendedPidSource,
    val sensors: List<ExtendedPidDefinition>
)

data class ExtendedPidReading(
    val key: String,
    val name: String,
    val unit: String,
    val value: Double
)

object ExtendedPidSafety {
    private val hex = Regex("^[0-9A-F]+$")
    private val allowedReadServices = setOf(0x21, 0x22)

    fun validate(definition: ExtendedPidDefinition) {
        val command = normalizeHex(definition.command)
        require(command.length in 4..16 && command.length % 2 == 0) { "Invalid diagnostic command" }
        require(command.substring(0, 2).toInt(16) in allowedReadServices) {
            "Only read-only diagnostic services 21 and 22 are allowed"
        }
        val header = normalizeHex(definition.requestHeader)
        require(header.length == 3 || header.length == 8) { "Invalid CAN request header" }
        require(header != "7DF" && header != "18DB33F1") {
            "Extended PID requests must target a physical ECU address"
        }
        val prefix = normalizeHex(definition.responsePrefix)
        require(prefix.length >= 4 && prefix.length % 2 == 0) { "Invalid response prefix" }
        val positiveService = command.substring(0, 2).toInt(16) + 0x40
        val expectedPrefix = "%02X%s".format(positiveService, command.drop(2))
        require(prefix == expectedPrefix) { "Response prefix does not match the read command" }
        require(definition.key.matches(Regex("^[A-Za-z][A-Za-z0-9_]{1,63}$"))) { "Invalid metric key" }
        require(definition.formula.length in 1..160) { "Invalid formula length" }
        require(definition.expectedBytes in 1..32) { "Invalid expected byte count" }
        require(definition.minIntervalMs in 250..60_000) { "Invalid polling interval" }
        require(definition.priority in 0..3) { "Invalid priority" }
        if (definition.minValue != null && definition.maxValue != null) {
            require(definition.minValue < definition.maxValue) { "Invalid sensor range" }
        }
    }

    fun normalizeHex(value: String): String {
        val normalized = value.replace(" ", "").uppercase()
        require(normalized.isNotBlank() && hex.matches(normalized)) { "Expected hexadecimal value" }
        return normalized
    }
}

class ExtendedPidProfileCatalog private constructor(
    private val profiles: List<ExtendedPidProfile>
) {
    fun match(vin: String?): ExtendedPidProfile? {
        if (vin.isNullOrBlank()) return null
        return profiles.firstOrNull { it.match.matches(vin) }
    }

    companion object {
        fun load(context: Context): ExtendedPidProfileCatalog {
            val text = context.assets.open("obd/extended_pid_profiles.json")
                .bufferedReader()
                .use { it.readText() }
            val root = JSONObject(text)
            require(root.getInt("schemaVersion") == 1) { "Unsupported extended PID profile schema" }
            val parsed = root.getJSONArray("profiles").objects().map { parseProfile(it) }
            return ExtendedPidProfileCatalog(parsed)
        }

        private fun parseProfile(json: JSONObject): ExtendedPidProfile {
            val match = json.getJSONObject("match")
            val sourceJson = json.getJSONObject("source")
            val source = ExtendedPidSource(
                name = sourceJson.getString("name"),
                url = sourceJson.getString("url"),
                scope = sourceJson.getString("scope")
            )
            require(source.url.startsWith("https://")) { "Profile source must use HTTPS" }
            val sensors = json.getJSONArray("sensors").objects().map { sensor ->
                ExtendedPidDefinition(
                    command = sensor.getString("command"),
                    requestHeader = sensor.getString("requestHeader"),
                    responsePrefix = sensor.getString("responsePrefix"),
                    key = sensor.getString("key"),
                    name = sensor.getString("name"),
                    unit = sensor.getString("unit"),
                    formula = sensor.getString("formula"),
                    expectedBytes = sensor.getInt("expectedBytes"),
                    minValue = sensor.optionalDouble("minValue"),
                    maxValue = sensor.optionalDouble("maxValue"),
                    minIntervalMs = sensor.optLong("minIntervalMs", 2_000L),
                    priority = sensor.optInt("priority", 2)
                ).also(ExtendedPidSafety::validate)
            }
            return ExtendedPidProfile(
                id = json.getString("id"),
                name = json.getString("name"),
                match = ExtendedPidMatch(
                    wmi = match.getJSONArray("wmi").strings(),
                    modelYearCodes = match.getJSONArray("modelYearCodes").strings(),
                    engineVinCodes = match.getJSONArray("engineVinCodes").strings()
                ),
                source = source,
                sensors = sensors
            )
        }

        private fun JSONArray.objects(): List<JSONObject> =
            (0 until length()).map { getJSONObject(it) }

        private fun JSONArray.strings(): Set<String> =
            (0 until length()).map { getString(it).uppercase() }.toSet()

        private fun JSONObject.optionalDouble(name: String): Double? =
            if (has(name) && !isNull(name)) getDouble(name) else null
    }
}
