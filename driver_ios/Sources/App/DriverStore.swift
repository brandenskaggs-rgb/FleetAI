import Foundation
import Combine
import Network
import UIKit

@MainActor
final class DriverStore: ObservableObject {
    @Published private(set) var session: DriverSession?
    @Published private(set) var readings: [String: SensorReading] = [:]
    @Published private(set) var coolantHistory: [SensorReading] = []
    @Published private(set) var supported: [PIDSpec] = []
    @Published private(set) var collecting = false
    @Published private(set) var queued = 0
    @Published private(set) var lastUpload: Date?
    @Published private(set) var uploadState = "No readings uploaded"
    @Published private(set) var busy = false
    @Published private(set) var authorizationBlocked = false
    @Published var error = ""
    @Published var notice = ""
    @Published private(set) var diagnosticCodes: [[String: String]] = []
    @Published private(set) var hosStatus: [String: Any] = [:]
    let adapter = BLEVehicleAdapter()
    private let api = DriverAPI()
    private var outbox: DurableOutbox?
    private var polling: Task<Void, Never>?
    private var retries: Task<Void, Never>?
    private var flushing = false
    private var persisting = false
    private var pendingReadings: [String: SensorReading] = [:]
    private var lastPersist = Date.distantPast
    private let monitor = NWPathMonitor()
    private var restored = false
    private var capture = CaptureLifecycle()

    init() {
        do {
            var root = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask,
                                                   appropriateFor: nil, create: true).appendingPathComponent("FleetDriverOutbox", isDirectory: true)
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
            try FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: root.path)
            var values = URLResourceValues(); values.isExcludedFromBackup = true; try root.setResourceValues(values)
            outbox = try DurableOutbox(root: root)
        } catch { self.error = "Secure local storage could not be opened. Collection is disabled." }
        restoreSession()
        adapter.onDisconnect = { [weak self] in self?.stopReadings(disconnect: false) }
        monitor.pathUpdateHandler = { [weak self] path in
            if path.status == .satisfied { Task { @MainActor in await self?.flush() } }
        }
        monitor.start(queue: DispatchQueue(label: "fleetai.ios.network"))
        retries = Task { [weak self] in
            while !Task.isCancelled {
                await self?.flush()
                try? await Task.sleep(nanoseconds: 10_000_000_000)
            }
        }
    }
    func restoreSession() {
        guard session == nil else { return }
        do {
            session = try SessionVault.session(); restored = true
            if let session { try adapter.configureSavedProfile(session: session) }
        }
        catch { error = error.localizedDescription; restored = false }
    }
    func pair(code: String, pin: String) async {
        guard !busy, session == nil, restored, outbox != nil else { return }
        let code = code.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        guard (4...12).contains(code.count), code.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber) }),
              pin.count <= 32 else { error = "Enter the pairing code and PIN provided by your fleet manager."; return }
        busy = true; error = ""; defer { busy = false }
        do {
            let id = try SessionVault.deviceId()
            let body = try JSONSerialization.data(withJSONObject: ["pairingCode":code, "driverPin":pin,
                "deviceId":id, "deviceLabel":UIDevice.current.userInterfaceIdiom == .pad ? "Fleet AI iPad" : "Fleet AI iPhone"])
            let response = try await api.request(path: DriverContract.claim, body: body)
            let claimed = try DriverSession.fromClaim(response, origin: DriverContract.origin, deviceId: id)
            try SessionVault.save(claimed)
            session = claimed; notice = "Device paired"; await flush()
        } catch { self.error = error.localizedDescription }
    }
    func startReadings() {
        guard !collecting, session != nil, outbox != nil, adapter.ready, let run = capture.begin() else { return }
        collecting = true; error = ""; readings = [:]; supported = []; coolantHistory = []
        polling = Task { [weak self] in
            guard let self else { return }
            do {
                _ = try await adapter.command("ATZ")
                try checkCapture(run)
                let identity = try await adapter.command("ATI").uppercased()
                try checkCapture(run)
                guard identity.contains("ELM") || identity.contains("STN") || identity.contains("OBD") else { throw DriverError.invalidResponse }
                for command in ["ATE0","ATL0","ATS1","ATH0","ATSP0"] {
                    let response = try await adapter.command(command)
                    try checkCapture(run)
                    guard response.uppercased().contains("OK") else { throw DriverError.invalidResponse }
                }
                var capabilities = Set<Int>()
                for base in stride(from: 0, through: 0xA0, by: 0x20) {
                    let response = try await adapter.command(String(format: "01%02X", base))
                    try checkCapture(run)
                    guard let discovered = ELMProtocol.supported(response, base: base) else {
                        if base == 0 { throw DriverError.invalidResponse }
                        break
                    }
                    capabilities.formUnion(discovered)
                    if !discovered.contains(base + 32) { break }
                }
                supported = ELMProtocol.sensors.filter { capabilities.contains($0.pid) }
                guard !supported.isEmpty else { throw DriverError.invalidResponse }
                if let session { try adapter.rememberConfirmedInterface(session: session) }
                var lastAttempt: [Int: Date] = [:]
                while !Task.isCancelled {
                    try checkCapture(run)
                    let now = Date()
                    // Oldest relative deadline wins, so slow sensors cannot starve behind RPM.
                    let spec = supported.max { left, right in
                        now.timeIntervalSince(lastAttempt[left.pid] ?? now.addingTimeInterval(-60)) / left.interval <
                        now.timeIntervalSince(lastAttempt[right.pid] ?? now.addingTimeInterval(-60)) / right.interval
                    }!
                    if now.timeIntervalSince(lastAttempt[spec.pid] ?? .distantPast) < spec.interval {
                        try await Task.sleep(nanoseconds: 150_000_000); continue
                    }
                    lastAttempt[spec.pid] = now
                    let response = try await adapter.command(spec.command)
                    try checkCapture(run)
                    if let reading = ELMProtocol.decode(response, spec: spec, at: Date()) {
                        readings[spec.key] = reading; pendingReadings[spec.key] = reading
                        if spec.key == "coolantTempC" { coolantHistory.append(reading); coolantHistory = Array(coolantHistory.suffix(120)) }
                        if Date().timeIntervalSince(lastPersist) >= 2 {
                            try await persistReadings()
                            Task { await flush() }
                        }
                    }
                    try await Task.sleep(nanoseconds: 150_000_000)
                }
            } catch {
                if capture.isCurrent(run), !(error is CancellationError) { self.error = error.localizedDescription }
            }
            if capture.isCurrent(run) { stopReadings() }
        }
    }
    private func checkCapture(_ run: UUID) throws {
        try Task.checkCancellation()
        guard capture.isCurrent(run) else { throw CancellationError() }
    }
    private func persistReadings() async throws {
        guard let session, let outbox, !pendingReadings.isEmpty, !persisting else { return }
        persisting = true; defer { persisting = false }
        let pending = pendingReadings
        let payload = try DriverContract.telemetry(readings: Array(pending.values), session: session)
        try await outbox.enqueue(payload: payload, path: DriverContract.ingest, session: session)
        for (key, reading) in pending where pendingReadings[key] == reading { pendingReadings.removeValue(forKey: key) }
        lastPersist = Date(); queued = try await outbox.count(scope: session.scope)
    }
    func stopReadings(disconnect: Bool = true) {
        capture.stop()
        collecting = false; polling?.cancel(); polling = nil
        if disconnect { adapter.disconnect() }
        Task { do { try await persistReadings(); await flush() } catch { self.error = error.localizedDescription } }
    }
    func resumeUploads() async {
        // Explicit retry never erases the session or silently claims a new assignment.
        authorizationBlocked = false; await flush()
    }
    func flush() async {
        guard !flushing, let session, let outbox else { return }
        flushing = true; defer { flushing = false }
        do {
            queued = try await outbox.count(scope: session.scope)
            guard !authorizationBlocked else { return }
            let entries = try await outbox.pending(session: session)
            for entry in entries {
                do {
                    _ = try await api.request(path: entry.path, session: session, body: entry.payload)
                    try await outbox.acknowledge(entry, session: session)
                    lastUpload = Date(); uploadState = "Upload accepted"
                } catch {
                    if case DriverError.http(let status) = error {
                        if status == 401 || status == 403 {
                            authorizationBlocked = true; uploadState = "Access needs attention. Data retained."; return
                        }
                        let permanent = [400,404,405,410,413,415,422].contains(status)
                        try await outbox.failed(entry, session: session, permanent: permanent)
                        uploadState = permanent ? "A record was rejected and retained for review." : "Readings saved. Waiting to retry."
                    } else {
                        try await outbox.failed(entry, session: session, permanent: false)
                        uploadState = "Readings saved. Waiting for a connection."
                    }
                    break
                }
            }
            queued = try await outbox.count(scope: session.scope)
        } catch { self.error = "Local upload queue needs attention. \(error.localizedDescription)" }
    }
    func refreshDriverData() async {
        guard let session, !busy else { return }
        busy = true; defer { busy = false }
        do {
            let dtcs = try await api.request(path: DriverContract.dtcs, session: session)
            let response = try JSONSerialization.jsonObject(with: dtcs) as? [String: Any]
            let rows = (response?["dtcs"] as? [[String: Any]]) ?? []
            diagnosticCodes = rows.map { row in
                let code = (row["code"] as? String) ?? "Unknown code"
                let description = (row["description"] as? String) ?? ""
                let severity = (row["severity"] as? String) ?? ""
                return ["code": code, "description": description, "severity": severity]
            }
            let data = try await api.request(path: DriverContract.hos, session: session)
            hosStatus = (try JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
        } catch { self.error = error.localizedDescription }
    }
    func submitInspection(type: String, items: [String], defects: String, signature: String, odometer: String) async -> Bool {
        guard let session, let outbox, !busy else { return false }
        guard !signature.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, !items.isEmpty,
              let distance = Double(odometer), distance.isFinite, distance >= 0,
              signature.count <= 160, defects.count <= 2000 else { error = "Check your name, odometer and inspection results."; return false }
        busy = true; defer { busy = false }
        do {
            let body: [String: Any] = ["clientRecordId":UUID().uuidString(),"type":type,"odometer":distance,
                "inspectedItems":items,"defects":defects,"signature":signature,"inspectedAt":DriverContract.timestamp(Date())]
            try await outbox.enqueue(payload: JSONSerialization.data(withJSONObject: body), path: DriverContract.dvir, session: session)
            queued = try await outbox.count(scope: session.scope)
            notice = "Inspection saved on this device for upload."
            await flush(); return true
        } catch { self.error = error.localizedDescription; return false }
    }
}
