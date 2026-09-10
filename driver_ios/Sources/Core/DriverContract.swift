import Foundation

public enum DriverError: Error, LocalizedError {
    case invalidSession, invalidResponse, queueFull, scopeMismatch, unsafeCommand, timeout, disconnected
    case http(Int)
    public var errorDescription: String? {
        switch self {
        case .invalidSession: return "Pairing could not be restored. No stored data was removed."
        case .invalidResponse: return "The server or adapter returned an unexpected response."
        case .queueFull: return "Device storage queue is full. Connect to the internet to upload saved readings."
        case .scopeMismatch: return "Saved data belongs to a different device assignment. Upload was blocked."
        case .unsafeCommand: return "Only supported read-only diagnostic commands are allowed."
        case .timeout: return "The adapter did not respond. Reconnect before continuing."
        case .disconnected: return "Vehicle adapter disconnected. Saved readings are still on this device."
        case .http(401): return "Authorization was rejected. Check your pairing code and driver PIN, or ask your fleet manager to review this device's access. Saved data has not been deleted."
        case .http(403): return "This device is not authorized for that operation."
        case .http(404): return "Pairing code or requested record was not found."
        case .http(409): return "This pairing conflicts with an existing assignment. Ask your fleet manager to check it."
        case .http(410): return "This pairing code has expired. Request a new code."
        case .http(429): return "Too many requests. Wait before trying again."
        case .http(let code): return "The server could not complete the request (HTTP \(code))."
        }
    }
}

public struct DriverSession: Codable, Equatable {
    public let origin: URL
    public let tenantId: String
    public let vehicleId: String
    public let driverId: String
    public let driverName: String
    public let deviceId: String
    public let assignmentId: String
    public let token: String
    public var scope: String {
        [origin.absoluteString, tenantId, vehicleId, driverId, deviceId, assignmentId]
            .map { "\($0.utf8.count):\($0)" }.joined()
    }

    public func validate() throws {
        guard origin.scheme == "https", origin.host != nil, origin.user == nil, origin.password == nil,
              origin.query == nil, origin.fragment == nil, ["", "/"].contains(origin.path),
              [tenantId, vehicleId, driverId, deviceId, assignmentId, token].allSatisfy({ !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty })
        else { throw DriverError.invalidSession }
    }

    public static func fromClaim(_ data: Data, origin: URL, deviceId: String) throws -> DriverSession {
        struct Claim: Decodable {
            let tenantId: String?, orgId: String?, vehicleId: String, driverId: String
            let driverName: String?, assignmentId: String, deviceId: String?, deviceToken: String
        }
        let c = try JSONDecoder().decode(Claim.self, from: data)
        guard c.deviceId == nil || c.deviceId == deviceId else { throw DriverError.scopeMismatch }
        let result = DriverSession(origin: origin, tenantId: (c.tenantId?.isEmpty == false ? c.tenantId : c.orgId) ?? "",
            vehicleId: c.vehicleId, driverId: c.driverId, driverName: c.driverName ?? c.driverId,
            deviceId: deviceId, assignmentId: c.assignmentId, token: c.deviceToken)
        try result.validate()
        return result
    }
}

public struct SensorReading: Codable, Equatable {
    public let key: String
    public let value: Double
    public let capturedAt: Date
    public init(key: String, value: Double, capturedAt: Date) {
        self.key = key; self.value = value; self.capturedAt = capturedAt
    }
    public func isFresh(at now: Date, interval: TimeInterval) -> Bool {
        let age = now.timeIntervalSince(capturedAt)
        return age >= 0 && age <= max(15, interval * 3)
    }
}

public enum DriverContract {
    public static let origin = URL(string: "https://fleetaiops.com")!
    public static let claim = "/api/pairings/claim"
    public static let ingest = "/api/telemetry/ingest"
    public static let dvir = "/api/driver/dvir"
    public static let dtcs = "/api/vehicle/dtcs"
    public static let hos = "/api/eld/hos/status"

    public static func timestamp(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
    }

    // No cached readings, zero-fill, location substitutes or synthetic samples enter this payload.
    public static func telemetry(reading: SensorReading, session: DriverSession, batchId: String = UUID().uuidString) throws -> Data {
        try session.validate()
        guard reading.value.isFinite, ELMProtocol.sensors.contains(where: { $0.key == reading.key }) else { throw DriverError.invalidResponse }
        let time = timestamp(reading.capturedAt)
        let body: [String: Any] = [
            "batchId": batchId, "vehicleId": session.vehicleId, "driverId": session.driverId,
            "deviceId": session.deviceId, "protocol": "OBD2", "timestamp": time,
            "metrics": [reading.key: reading.value], "obdConnected": true, "busDataActive": true,
            "lastObdPacketAt": time,
            "meta": ["metricAgesMs": [reading.key: 0], "capturePlatform": "ios", "transport": "BLE"]
        ]
        return try JSONSerialization.data(withJSONObject: body, options: [.sortedKeys])
    }

    public static func telemetry(readings: [SensorReading], session: DriverSession) throws -> Data {
        guard let latest = readings.map(\.capturedAt).max(), !readings.isEmpty,
              Set(readings.map(\.key)).count == readings.count,
              readings.allSatisfy({ reading in reading.value.isFinite && ELMProtocol.sensors.contains(where: { $0.key == reading.key }) })
        else { throw DriverError.invalidResponse }
        let first = try telemetry(reading: readings[0], session: session)
        var body = try JSONSerialization.jsonObject(with: first) as! [String: Any]
        body["timestamp"] = timestamp(latest); body["lastObdPacketAt"] = timestamp(latest)
        body["metrics"] = Dictionary(uniqueKeysWithValues: readings.map { ($0.key, $0.value) })
        body["meta"] = ["metricAgesMs": Dictionary(uniqueKeysWithValues: readings.map { ($0.key, max(0, latest.timeIntervalSince($0.capturedAt) * 1000)) }),
                        "capturePlatform": "ios", "transport": "BLE"]
        return try JSONSerialization.data(withJSONObject: body, options: [.sortedKeys])
    }

    public static func validateOutbound(_ payload: Data, path: String, session: DriverSession) throws {
        try session.validate()
        guard let body = try JSONSerialization.jsonObject(with: payload) as? [String: Any] else { throw DriverError.invalidResponse }
        if path == ingest {
            guard (body["vehicleId"] as? String) == session.vehicleId,
                  (body["driverId"] as? String) == session.driverId,
                  (body["deviceId"] as? String) == session.deviceId else { throw DriverError.scopeMismatch }
            guard let batchId = body["batchId"] as? String, UUID(uuidString: batchId) != nil,
                  let metrics = body["metrics"] as? [String: Double], !metrics.isEmpty,
                  metrics.allSatisfy({ key, value in value.isFinite && ELMProtocol.sensors.contains { $0.key == key } })
            else { throw DriverError.invalidResponse }
        } else if path == dvir {
            guard let id = body["clientRecordId"] as? String, UUID(uuidString: id) != nil,
                  let items = body["inspectedItems"] as? [String], !items.isEmpty,
                  let name = body["signature"] as? String, !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            else { throw DriverError.invalidResponse }
        } else { throw DriverError.scopeMismatch }
    }
}
