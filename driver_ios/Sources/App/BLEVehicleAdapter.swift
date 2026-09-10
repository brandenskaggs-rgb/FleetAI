import Foundation
import CoreBluetooth
import Combine

@MainActor
final class BLEVehicleAdapter: NSObject, ObservableObject, CBCentralManagerDelegate, CBPeripheralDelegate {
    struct Device: Identifiable { let id: UUID; let name: String; let peripheral: CBPeripheral }
    struct Endpoint: Identifiable {
        let id: String
        let service: CBUUID
        let characteristic: CBCharacteristic
        var label: String { "\(service.uuidString) / \(characteristic.uuid.uuidString)" }
    }
    @Published private(set) var devices: [Device] = []
    @Published private(set) var endpoints: [Endpoint] = []
    @Published private(set) var status = "Not connected"
    @Published private(set) var connected = false
    @Published private(set) var ready = false
    @Published private(set) var scanning = false
    @Published private(set) var selectedName = "Vehicle adapter"
    @Published private(set) var hasSavedAdapter = false
    private var central: CBCentralManager!
    private var peripheral: CBPeripheral?
    private var writeCharacteristic: CBCharacteristic?
    private var notifyCharacteristic: CBCharacteristic?
    private var pending: CheckedContinuation<String, Error>?
    private var pendingId: UUID?
    private var timeout: Task<Void, Never>?
    private var response = ""
    private var responseDeadline = Date.distantPast
    private var scanTimeout: Task<Void, Never>?
    private var savedProfile: AdapterProfile?
    private var restoringInterface = false
    var onDisconnect: (() -> Void)?

    override init() {
        super.init()
        // Constructed at launch so iOS may restore Bluetooth connection state.
        central = CBCentralManager(delegate: self, queue: .main,
            options: [CBCentralManagerOptionRestoreIdentifierKey: "fleetai.driver.ble.v1",
                      CBCentralManagerOptionShowPowerAlertKey: false])
    }
    var writers: [Endpoint] { endpoints.filter { $0.characteristic.properties.contains(.write) || $0.characteristic.properties.contains(.writeWithoutResponse) } }
    var readers: [Endpoint] { endpoints.filter { $0.characteristic.properties.contains(.notify) || $0.characteristic.properties.contains(.indicate) } }

    func configureSavedProfile(session: DriverSession) throws {
        guard let data = try SessionVault.read("adapter-profile") else { return }
        let profile = try JSONDecoder().decode(AdapterProfile.self, from: data)
        guard profile.matches(session) else { savedProfile = nil; hasSavedAdapter = false; return }
        savedProfile = profile; hasSavedAdapter = true
    }
    func rememberConfirmedInterface(session: DriverSession) throws {
        guard ready, let peripheral, let write = writeCharacteristic, let notify = notifyCharacteristic,
              let service = write.service, notify.service === service else { throw DriverError.disconnected }
        let profile = AdapterProfile(scope: session.scope, peripheralId: peripheral.identifier,
            serviceUUID: service.uuid.uuidString, writeUUID: write.uuid.uuidString, notifyUUID: notify.uuid.uuidString)
        guard profile.matches(session) else { throw DriverError.scopeMismatch }
        try SessionVault.store(JSONEncoder().encode(profile), account: "adapter-profile")
        savedProfile = profile; hasSavedAdapter = true
    }
    func reconnectSaved() {
        guard central.state == .poweredOn, let profile = savedProfile else {
            status = "Enable Bluetooth and complete the first adapter setup."; return
        }
        guard let known = central.retrievePeripherals(withIdentifiers: [profile.peripheralId]).first else {
            status = "Saved adapter is unavailable. Search again when it is powered on."; return
        }
        connect(Device(id: known.identifier, name: known.name ?? "Saved vehicle adapter", peripheral: known))
    }

    func scan() {
        guard central.state == .poweredOn else { status = "Enable Bluetooth access in Settings."; return }
        stopScan(); devices = []; scanning = true; status = "Looking for adapters"
        // Initial discovery is user initiated in the foreground; never connect by name alone.
        central.scanForPeripherals(withServices: nil, options: [CBCentralManagerScanOptionAllowDuplicatesKey: false])
        scanTimeout = Task { try? await Task.sleep(nanoseconds: 15_000_000_000); if !Task.isCancelled { stopScan() } }
    }
    func stopScan() { central.stopScan(); scanning = false; scanTimeout?.cancel(); scanTimeout = nil }
    func connect(_ device: Device) {
        disconnect(); peripheral = device.peripheral; peripheral?.delegate = self
        selectedName = device.name; status = "Connecting to \(device.name)"
        central.connect(device.peripheral, options: nil)
    }
    func disconnect() {
        stopScan(); ready = false; connected = false; endpoints = []; restoringInterface = false
        writeCharacteristic = nil; notifyCharacteristic = nil
        finish(.failure(DriverError.disconnected))
        if let peripheral { central.cancelPeripheralConnection(peripheral) }
        peripheral = nil; status = "Not connected"; onDisconnect?()
    }
    func selectEndpoints(writeId: String, notifyId: String) {
        guard let p = peripheral, connected, pending == nil,
              let write = writers.first(where: { $0.id == writeId }),
              let notify = readers.first(where: { $0.id == notifyId }), write.service == notify.service else {
            status = "Select write and notify characteristics from the adapter's documented service."; return
        }
        ready = false
        if let previous = notifyCharacteristic { p.setNotifyValue(false, for: previous) }
        writeCharacteristic = write.characteristic; notifyCharacteristic = notify.characteristic
        p.setNotifyValue(true, for: notify.characteristic)
        status = "Enabling adapter responses"
    }

    func command(_ command: String) async throws -> String {
        guard ELMProtocol.allows(command) else { throw DriverError.unsafeCommand }
        guard let p = peripheral, let write = writeCharacteristic, ready, p.state == .connected else { throw DriverError.disconnected }
        guard pending == nil else { throw DriverError.invalidResponse }
        let bytes = Data((command + "\r").utf8)
        let requestId = UUID()
        let type: CBCharacteristicWriteType = write.properties.contains(.write) ? .withResponse : .withoutResponse
        guard bytes.count <= p.maximumWriteValueLength(for: type) else { throw DriverError.invalidResponse }
        if type == .withoutResponse && !p.canSendWriteWithoutResponse { throw DriverError.disconnected }
        return try await withTaskCancellationHandler(operation: {
            try Task.checkCancellation()
            return try await withCheckedThrowingContinuation { continuation in
                response = ""; pending = continuation; pendingId = requestId
                responseDeadline = Date().addingTimeInterval(command == "ATZ" ? 5 : 4)
                timeout = Task {
                    try? await Task.sleep(nanoseconds: command == "ATZ" ? 5_000_000_000 : 4_000_000_000)
                    guard !Task.isCancelled else { return }
                    finish(.failure(DriverError.timeout))
                    // Do not let a late response be attributed to a subsequent PID.
                    disconnect(); status = "Adapter timed out. Reconnect to continue."
                }
                p.writeValue(bytes, for: write, type: type)
            }
        }, onCancel: { Task { @MainActor in
            if self.pendingId == requestId { self.disconnect() }
        } })
    }
    private func finish(_ result: Result<String, Error>) {
        timeout?.cancel(); timeout = nil
        let continuation = pending; pending = nil; pendingId = nil; response = ""
        continuation?.resume(with: result)
    }
    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        if central.state != .poweredOn { disconnect(); status = central.state == .unauthorized ? "Bluetooth permission is required." : "Bluetooth is unavailable." }
    }
    func centralManager(_ central: CBCentralManager, didDiscover peripheral: CBPeripheral, advertisementData: [String: Any], rssi RSSI: NSNumber) {
        guard !devices.contains(where: { $0.id == peripheral.identifier }) else { return }
        let name = (advertisementData[CBAdvertisementDataLocalNameKey] as? String) ?? peripheral.name ?? "Unnamed BLE device"
        devices.append(Device(id: peripheral.identifier, name: name, peripheral: peripheral))
    }
    func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        guard peripheral === self.peripheral else { return }
        connected = true; status = "Select adapter interface"; peripheral.discoverServices(nil)
    }
    func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) {
        guard peripheral === self.peripheral else { return }; disconnect(); status = "Could not connect. Check adapter power and other connected apps."
    }
    func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) {
        guard peripheral === self.peripheral else { return }; disconnect()
    }
    func centralManager(_ central: CBCentralManager, willRestoreState dict: [String: Any]) {
        guard let restored = (dict[CBCentralManagerRestoredStatePeripheralsKey] as? [CBPeripheral])?.first else { return }
        guard let savedProfile, savedProfile.peripheralId == restored.identifier else {
            central.cancelPeripheralConnection(restored); return
        }
        peripheral = restored; restored.delegate = self; selectedName = restored.name ?? "Vehicle adapter"
        if restored.state == .connected {
            connected = true; status = "Adapter restored. Confirm its interface to resume."; restored.discoverServices(nil)
        }
    }
    func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        guard peripheral === self.peripheral, error == nil else { return }
        endpoints = []
        for service in peripheral.services ?? [] { peripheral.discoverCharacteristics(nil, for: service) }
    }
    func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
        guard peripheral === self.peripheral, error == nil else { return }
        for c in service.characteristics ?? [] {
            let id = "\(service.uuid.uuidString)/\(c.uuid.uuidString)"
            if !endpoints.contains(where: { $0.id == id }) { endpoints.append(Endpoint(id: id, service: service.uuid, characteristic: c)) }
        }
        if !restoringInterface, let savedProfile, savedProfile.peripheralId == peripheral.identifier {
            let write = "\(savedProfile.serviceUUID)/\(savedProfile.writeUUID)"
            let notify = "\(savedProfile.serviceUUID)/\(savedProfile.notifyUUID)"
            if writers.contains(where: { $0.id == write }), readers.contains(where: { $0.id == notify }) {
                restoringInterface = true
                selectEndpoints(writeId: write, notifyId: notify)
            }
        }
    }
    func peripheral(_ peripheral: CBPeripheral, didUpdateNotificationStateFor characteristic: CBCharacteristic, error: Error?) {
        guard peripheral === self.peripheral, characteristic === notifyCharacteristic else { return }
        ready = error == nil && characteristic.isNotifying
        status = ready ? "Adapter ready. Start readings when parked." : "Adapter notifications could not be enabled."
    }
    func peripheral(_ peripheral: CBPeripheral, didWriteValueFor characteristic: CBCharacteristic, error: Error?) {
        guard peripheral === self.peripheral, characteristic === writeCharacteristic, error != nil else { return }
        finish(.failure(DriverError.disconnected)); disconnect()
    }
    func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
        guard peripheral === self.peripheral, characteristic === notifyCharacteristic, pending != nil else { return }
        guard Date() <= responseDeadline else { finish(.failure(DriverError.timeout)); disconnect(); return }
        guard error == nil, let data = characteristic.value, let chunk = String(data: data, encoding: .ascii) else {
            finish(.failure(DriverError.invalidResponse)); disconnect(); return
        }
        response += chunk
        if response.utf8.count > 8192 { finish(.failure(DriverError.invalidResponse)); disconnect(); return }
        if let end = response.firstIndex(of: ">") { finish(.success(String(response[..<end]))) }
    }
}
