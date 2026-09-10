import XCTest
@testable import FleetDriverCore

final class DriverCoreTests: XCTestCase {
    func session(_ org: String = "org-a", _ assignment: String = "assignment-a") -> DriverSession {
        DriverSession(origin: DriverContract.origin, tenantId: org, vehicleId: "vehicle-test", driverId: "driver-test",
                      driverName: "Test driver", deviceId: "device-test", assignmentId: assignment, token: "test-only-not-a-secret")
    }
    func testClaimValidationAndOrgFallback() throws {
        let data = Data(#"{"orgId":"org-a","vehicleId":"vehicle-test","driverId":"driver-test","assignmentId":"assignment-a","deviceId":"device-test","deviceToken":"test-token"}"#.utf8)
        let claimed = try DriverSession.fromClaim(data, origin: DriverContract.origin, deviceId: "device-test")
        XCTAssertEqual(claimed.tenantId, "org-a")
        XCTAssertThrowsError(try DriverSession.fromClaim(data, origin: DriverContract.origin, deviceId: "wrong-device"))
        XCTAssertThrowsError(try DriverSession.fromClaim(Data("{}".utf8), origin: DriverContract.origin, deviceId: "device-test"))
        XCTAssertThrowsError(try DriverSession.fromClaim(data, origin: URL(string: "http://fleetaiops.com")!, deviceId: "device-test"))
    }
    func testCommandAllowlist() {
        for denied in ["04","14FFFFFF","2E123400","31010000","ATSH7E0","010C\r04","010C\n","010C\0","04 ","ATMA","22FFFF"] {
            XCTAssertFalse(ELMProtocol.allows(denied), denied)
        }
        for spec in ELMProtocol.sensors { XCTAssertTrue(ELMProtocol.allows(spec.command)) }
        XCTAssertTrue(ELMProtocol.allows("0100")); XCTAssertTrue(ELMProtocol.allows("ATE0"))
    }
    func testPIDDecodingAndUnits() throws {
        let fixtures: [(String,String,Double)] = [
            ("rpm","41 0C 1A F8",1726), ("speedKph","41 0D 64",100),
            ("coolantTempC","41 05 82",90), ("batteryVoltageV","41 42 36 B0",14),
            ("shortTermFuelTrimBank1Pct","41 06 80",0),
            ("referenceTorqueNm","41 63 03 E8",1000), ("actualTorquePct","41 62 AF",50),
            ("o2B1S1VoltageV","41 14 80 FF",0.64), ("odometerKm","41 A6 00 00 03 E8",100)
        ]
        for (key, response, expected) in fixtures {
            let spec = try XCTUnwrap(ELMProtocol.sensors.first { $0.key == key })
            let reading = try XCTUnwrap(ELMProtocol.decode(response, spec: spec, at: Date()))
            XCTAssertEqual(reading.value, expected, accuracy: 0.00001, key)
        }
    }
    func testMissingTruncatedEchoAndMultipleECUResponses() throws {
        let rpm = try XCTUnwrap(ELMProtocol.sensors.first { $0.key == "rpm" })
        for bad in ["NO DATA", "STOPPED", "UNABLE TO CONNECT", "010C", "41 0C 1A", "41 05 80", "41 0C FF FF", "41 0C 1A\r41 0D F8"] {
            XCTAssertNil(ELMProtocol.decode(bad, spec: rpm, at: Date()), bad)
        }
        let reading = ELMProtocol.decode("010C\rSEARCHING...\r41 0C 1A F8\r41 0C 00 00\r>", spec: rpm, at: Date())
        XCTAssertEqual(reading?.value, 1726)
        XCTAssertEqual(ELMProtocol.decode("410C0000", spec: rpm, at: Date())?.value, 0)
    }
    func testCapabilityBitsDoNotInventSupport() {
        XCTAssertEqual(ELMProtocol.supported("41 00 80 00 00 01", base: 0), Set([1,32]))
        XCTAssertEqual(ELMProtocol.supported("41 20 00 00 00 01", base: 32), Set([64]))
        XCTAssertNil(ELMProtocol.supported("NO DATA", base: 0))
    }
    func testFreshnessAndOriginalTimestamps() throws {
        let t = Date(timeIntervalSince1970: 1700000000)
        let rpm = SensorReading(key: "rpm", value: 0, capturedAt: t)
        XCTAssertTrue(rpm.isFresh(at: t.addingTimeInterval(3), interval: 1))
        XCTAssertFalse(rpm.isFresh(at: t.addingTimeInterval(20), interval: 1))
        XCTAssertFalse(rpm.isFresh(at: t.addingTimeInterval(-1), interval: 1))
        let data = try DriverContract.telemetry(readings: [rpm, SensorReading(key: "coolantTempC", value: 90, capturedAt: t.addingTimeInterval(1))], session: session())
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let metrics = try XCTUnwrap(json["metrics"] as? [String: Double])
        XCTAssertEqual(metrics.count, 2); XCTAssertNil(metrics["batteryVoltageV"])
        XCTAssertEqual(json["timestamp"] as? String, DriverContract.timestamp(t.addingTimeInterval(1)))
        let meta = try XCTUnwrap(json["meta"] as? [String: Any])
        XCTAssertEqual((meta["metricAgesMs"] as? [String: Double])?["rpm"], 1000)
        XCTAssertThrowsError(try DriverContract.telemetry(readings: [], session: session()))
        XCTAssertThrowsError(try DriverContract.telemetry(readings: [rpm,rpm], session: session()))
        XCTAssertFalse(String(decoding: data, as: UTF8.self).contains(session().token))
    }
    func testOutboxSurvivesRestartAndSeparatesAssignments() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let first = try DurableOutbox(root: root)
        let payload = try DriverContract.telemetry(reading: SensorReading(key: "rpm", value: 800, capturedAt: Date()), session: session())
        try await first.enqueue(payload: payload, path: DriverContract.ingest, session: session())
        let restarted = try DurableOutbox(root: root)
        let entries = try await restarted.pending(session: session())
        XCTAssertEqual(entries.count, 1); XCTAssertEqual(entries[0].payload, payload)
        let otherOrg = try await restarted.pending(session: session("org-b"))
        let otherPairing = try await restarted.pending(session: session("org-a", "assignment-b"))
        XCTAssertTrue(otherOrg.isEmpty); XCTAssertTrue(otherPairing.isEmpty)
        do { try await restarted.acknowledge(entries[0], session: session("org-b")); XCTFail("Cross-org delete allowed") } catch {}
        try await restarted.acknowledge(entries[0], session: session())
        let remaining = try await restarted.count(scope: session().scope); XCTAssertEqual(remaining, 0)
    }
    func testRetryAndRejectionRetainSamePayloadAndId() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let queue = try DurableOutbox(root: root, limit: 1)
        let time = Date()
        let payload = try JSONSerialization.data(withJSONObject: ["clientRecordId": UUID().uuidString,
            "inspectedItems": ["Brakes: pass"], "signature": "Test driver"])
        try await queue.enqueue(payload: payload, path: DriverContract.dvir, session: session(), at: time)
        let entries = try await queue.pending(session: session(), at: time)
        let entry = try XCTUnwrap(entries.first)
        try await queue.failed(entry, session: session(), permanent: false, at: time)
        let waiting = try await queue.pending(session: session(), at: time); XCTAssertTrue(waiting.isEmpty)
        let retry = try await queue.pending(session: session(), at: time.addingTimeInterval(10))
        XCTAssertEqual(retry.first?.id, entry.id); XCTAssertEqual(retry.first?.payload, entry.payload)
        try await queue.failed(entry, session: session(), permanent: true, at: time)
        let rejected = try await queue.pending(session: session(), at: time.addingTimeInterval(600)); XCTAssertTrue(rejected.isEmpty)
        let remaining = try await queue.count(scope: session().scope); XCTAssertEqual(remaining, 1)
        do { try await queue.enqueue(payload: payload, path: DriverContract.dvir, session: session()); XCTFail("Full queue accepted a record") } catch {}
    }

    func testOldCaptureCannotPublishIntoOrStopNewRun() throws {
        var lifecycle = CaptureLifecycle()
        let old = try XCTUnwrap(lifecycle.begin())
        XCTAssertNil(lifecycle.begin())
        lifecycle.stop()
        let new = try XCTUnwrap(lifecycle.begin())
        XCTAssertFalse(lifecycle.isCurrent(old))
        XCTAssertTrue(lifecycle.isCurrent(new))
    }

    func testSavedAdapterIsScopedToTheAssignment() {
        let profile = AdapterProfile(scope: session().scope, peripheralId: UUID(), serviceUUID: "FFF0", writeUUID: "FFF2", notifyUUID: "FFF1")
        XCTAssertTrue(profile.matches(session()))
        XCTAssertFalse(profile.matches(session("other-org")))
        XCTAssertFalse(profile.matches(session("org-a", "other-assignment")))
        let invalid = AdapterProfile(scope: session().scope, peripheralId: UUID(), serviceUUID: "unknown", writeUUID: "FFF2", notifyUUID: "FFF1")
        XCTAssertFalse(invalid.matches(session()))
    }

    func testTelemetryBodyCannotCrossDeviceScope() throws {
        let valid = try DriverContract.telemetry(reading: SensorReading(key: "rpm", value: 750, capturedAt: Date()), session: session())
        var body = try XCTUnwrap(JSONSerialization.jsonObject(with: valid) as? [String: Any])
        try DriverContract.validateOutbound(valid, path: DriverContract.ingest, session: session())
        body["vehicleId"] = "wrong-vehicle"
        let changed = try JSONSerialization.data(withJSONObject: body)
        XCTAssertThrowsError(try DriverContract.validateOutbound(changed, path: DriverContract.ingest, session: session()))
        XCTAssertThrowsError(try DriverContract.validateOutbound(valid, path: "/api/other", session: session()))
        XCTAssertThrowsError(try DriverContract.telemetry(reading: SensorReading(key: "madeUpSensor", value: 0, capturedAt: Date()), session: session()))
    }

    func testScopeEncodingHasNoDelimiterCollision() {
        let first = DriverSession(origin: DriverContract.origin, tenantId: "a|b", vehicleId: "c", driverId: "d",
            driverName: "Test", deviceId: "device", assignmentId: "assignment", token: "test")
        let second = DriverSession(origin: DriverContract.origin, tenantId: "a", vehicleId: "b|c", driverId: "d",
            driverName: "Test", deviceId: "device", assignmentId: "assignment", token: "test")
        XCTAssertNotEqual(first.scope, second.scope)
    }
}
