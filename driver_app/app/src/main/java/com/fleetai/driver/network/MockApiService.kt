package com.fleetai.driver.network

import java.util.UUID

class MockApiService {
    fun loginDriver(companyCode: String, driverPin: String): LoginResponse {
        return LoginResponse(
            tenantId = "TENANT_${companyCode}",
            driverId = "DRIVER_${driverPin}",
            token = UUID.randomUUID().toString(),
            driverName = "Demo Driver"
        )
    }

    fun getVehicles(tenantId: String): VehicleListResponse {
        return VehicleListResponse(
            vehicles = listOf(
                VehicleDto("VEHICLE_001", "Unit 1", "1HGBH41JXMN109186", "Freightliner", "Cascadia"),
                VehicleDto("VEHICLE_002", "Unit 2", "2HGBH41JXMN109187", "Kenworth", "T680"),
                VehicleDto("VEHICLE_003", "Unit 3", "3HGBH41JXMN109188", "Volvo", "VNL")
            )
        )
    }

    fun getDiagnosticCodes(): DtcResponse {
        return DtcResponse(
            dtcs = listOf(
                DtcDto("P0420", "Catalyst efficiency below threshold", "medium"),
                DtcDto("P0128", "Coolant thermostat below temp", "low")
            )
        )
    }

    fun claimPairing(pairingCode: String, driverPin: String, deviceId: String, deviceLabel: String): PairingClaimResponse {
        if (pairingCode.length != 6 || !pairingCode.all { it.isDigit() }) {
            throw IllegalArgumentException("invalid")
        }
        if (driverPin.length != 6 || !driverPin.all { it.isDigit() }) {
            throw IllegalArgumentException("invalid_pin")
        }
        if (pairingCode.uppercase() == "000000") {
            throw IllegalStateException("expired")
        }
        return PairingClaimResponse(
            vehicleId = "VEHICLE_001",
            driverId = "DRIVER_1001",
            status = "active",
            tenantId = "TENANT_DEMO",
            driverName = "Demo Driver",
            assignmentId = "PAIR_DEMO",
            deviceId = deviceId,
            deviceLabel = deviceLabel,
            deviceToken = "dev_${UUID.randomUUID()}"
        )
    }
}
