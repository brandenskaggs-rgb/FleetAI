import SwiftUI
import Charts

@main
@MainActor
struct FleetDriverApp: App {
    @StateObject private var store = DriverStore()
    @Environment(\.scenePhase) private var phase
    var body: some Scene {
        WindowGroup {
            DriverRoot(store: store)
                .tint(Brand.ink)
                .onChange(of: phase) { value in
                    if value == .active { store.restoreSession(); Task { await store.flush() } }
                }
        }
    }
}

enum Brand {
    static let ink = Color(red: 0.09, green: 0.13, blue: 0.15)
    static let paper = Color(red: 0.95, green: 0.96, blue: 0.95)
    static let good = Color(red: 0.12, green: 0.42, blue: 0.32)
    static let warning = Color(red: 0.65, green: 0.30, blue: 0.09)
}

// Exact Link geometry shared with Android's fleet_ai_link.xml, not a new mark.
struct LinkMark: Shape {
    func path(in rect: CGRect) -> Path {
        var p = Path()
        let polygons: [[CGPoint]] = [
            [.init(x:0,y:760),.init(x:0,y:220),.init(x:220,y:0),.init(x:760,y:0),.init(x:760,y:240),.init(x:310,y:240),.init(x:240,y:310),.init(x:240,y:760)],
            [.init(x:240,y:1000),.init(x:780,y:1000),.init(x:1000,y:780),.init(x:1000,y:240),.init(x:760,y:240),.init(x:760,y:690),.init(x:690,y:760),.init(x:240,y:760)]
        ]
        for polygon in polygons {
            let points = polygon.map { CGPoint(x: rect.minX + $0.x * rect.width / 1000, y: rect.minY + $0.y * rect.height / 1000) }
            p.addLines(points); p.closeSubpath()
        }
        return p
    }
}

struct DriverRoot: View {
    @ObservedObject var store: DriverStore
    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                LinkMark().fill(Brand.ink).frame(width: 36, height: 36).accessibilityHidden(true)
                Text("Fleet AI").font(.title2.bold())
                Spacer()
                if let session = store.session { Text(session.driverName).font(.body).lineLimit(2) }
            }.padding().background(.white)
            if !store.error.isEmpty {
                HStack {
                    Image(systemName: "exclamationmark.triangle")
                    Text(store.error).font(.body).fixedSize(horizontal: false, vertical: true)
                    Button { store.error = "" } label: { Image(systemName: "xmark").frame(width: 44,height: 44) }.accessibilityLabel("Dismiss error")
                }.padding(.horizontal).foregroundStyle(Brand.warning).background(Brand.paper)
            }
            if store.session == nil { PairingView(store: store) }
            else {
                TabView {
                    NavigationStack { DriveView(store: store, adapter: store.adapter) }.tabItem { Label("Drive", systemImage: "steeringwheel") }
                    NavigationStack { SensorsView(store: store, adapter: store.adapter) }.tabItem { Label("Sensors", systemImage: "waveform.path.ecg") }
                    NavigationStack { InspectionView(store: store) }.tabItem { Label("Inspection", systemImage: "checklist") }
                    NavigationStack { ConnectionView(store: store, adapter: store.adapter) }.tabItem { Label("Connection", systemImage: "antenna.radiowaves.left.and.right") }
                }
            }
        }.foregroundStyle(Brand.ink).background(Brand.paper).preferredColorScheme(.light)
    }
}

struct PairingView: View {
    @ObservedObject var store: DriverStore
    @State private var code = ""
    @State private var pin = ""
    @State private var newDeviceConfirmed = false
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                Text("Your vehicle.\nYour connection.").font(.largeTitle.bold()).fixedSize(horizontal: false, vertical: true)
                Text("Device setup").font(.title3.weight(.semibold))
                VStack(alignment: .leading, spacing: 8) {
                    Text("Pairing code").font(.headline)
                    TextField("Code from fleet manager", text: $code).textInputAutocapitalization(.characters).autocorrectionDisabled()
                        .textContentType(.oneTimeCode).padding().background(.white)
                    Text("Driver PIN").font(.headline)
                    SecureField("Driver PIN", text: $pin).textContentType(.password).padding().background(.white)
                }
                Toggle("This is a new device assignment approved by my fleet manager.", isOn: $newDeviceConfirmed)
                Button { Task { await store.pair(code: code, pin: pin); pin = "" } } label: {
                    HStack { if store.busy { ProgressView().tint(.white) }; Text("Pair device").bold(); Image(systemName: "arrow.right") }.frame(maxWidth: .infinity).padding(12)
                }.buttonStyle(.borderedProminent).disabled(store.busy || code.isEmpty || !newDeviceConfirmed)
                Text("Existing Android pairings are not transferred. Use a separate pairing code for this Apple device.").font(.body).foregroundStyle(.secondary)
                Text("fleetaiops.com").font(.callout.monospaced()).foregroundStyle(.secondary)
                Button("Retry saved session") { store.restoreSession() }.frame(minHeight: 44)
            }.padding(24).frame(maxWidth: 540, alignment: .leading).frame(maxWidth: .infinity)
        }
    }
}

struct DriveView: View {
    @ObservedObject var store: DriverStore
    @ObservedObject var adapter: BLEVehicleAdapter
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                Text(store.session?.vehicleId ?? "Vehicle").font(.largeTitle.bold())
                Label(adapter.status, systemImage: adapter.connected ? "antenna.radiowaves.left.and.right" : "antenna.radiowaves.left.and.right.slash")
                    .foregroundStyle(adapter.connected ? Brand.good : Brand.warning)
                HStack(spacing: 16) {
                    Button { store.collecting ? store.stopReadings() : store.startReadings() } label: {
                        Label(store.collecting ? "Stop readings" : "Start readings", systemImage: store.collecting ? "stop.fill" : "play.fill").frame(minHeight: 44)
                    }.buttonStyle(.borderedProminent).disabled(!store.collecting && !adapter.ready)
                    Spacer()
                }
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 180), alignment: .leading)], spacing: 20) {
                        forMetric("rpm", at: context.date)
                        forMetric("speedKph", at: context.date)
                        forMetric("coolantTempC", at: context.date)
                        forMetric("batteryVoltageV", at: context.date)
                    }
                }
                VStack(alignment: .leading, spacing: 16) {
                    Text("Coolant trend").font(.title3.bold())
                    if store.coolantHistory.count > 1 {
                        Chart(Array(store.coolantHistory.enumerated()), id: \.offset) { item in
                            LineMark(x: .value("Time", item.element.capturedAt), y: .value("Temperature (F)", item.element.value * 9 / 5 + 32))
                                .foregroundStyle(Brand.good)
                        }.frame(height: 200).accessibilityLabel("Recent coolant readings in degrees Fahrenheit")
                    } else { Text("Waiting for measured coolant readings.").foregroundStyle(.secondary).frame(minHeight: 120) }
                }.padding(20).background(.white, in: RoundedRectangle(cornerRadius: 6))
                VStack(alignment: .leading, spacing: 8) {
                    Text("Data delivery").font(.title3.bold())
                    Text(store.uploadState)
                    Text("\(store.queued) saved records awaiting delivery or review").foregroundStyle(.secondary)
                    if let uploaded = store.lastUpload { Text("Last accepted \(uploaded.formatted(date: .omitted, time: .standard))").font(.callout) }
                    Button { Task { await store.resumeUploads() } } label: { Label("Retry uploads", systemImage: "arrow.clockwise").frame(minHeight: 44) }
                }
            }.padding(24)
        }.background(Brand.paper).navigationTitle("Drive").navigationBarTitleDisplayMode(.inline)
    }
    func forMetric(_ key: String, at date: Date) -> some View {
        let spec = ELMProtocol.sensors.first { $0.key == key }!
        return SensorTile(spec: spec, reading: store.readings[key], live: store.collecting && adapter.ready, at: date)
    }
}

struct SensorTile: View {
    let spec: PIDSpec
    let reading: SensorReading?
    let live: Bool
    let at: Date
    var body: some View {
        let fresh = live && (reading?.isFresh(at: at, interval: spec.interval) ?? false)
        VStack(alignment: .leading, spacing: 10) {
            Text(spec.name).font(.headline).fixedSize(horizontal: false, vertical: true)
            if let reading {
                let temp = spec.unit == "C"
                let speed = spec.key == "speedKph"
                let value = temp ? reading.value * 9 / 5 + 32 : speed ? reading.value / 1.609344 : reading.value
                HStack(alignment: .firstTextBaseline) {
                    Text(value.formatted(.number.precision(.fractionLength(0...1)))).font(.system(.largeTitle, design: .rounded).bold()).monospacedDigit()
                    Text(temp ? "\u{00B0}F" : speed ? "mph" : spec.unit).font(.body)
                }.foregroundStyle(fresh ? Brand.ink : .secondary)
                Text(fresh ? "Measured" : "Last reading, not live").font(.callout).foregroundStyle(fresh ? Brand.good : Brand.warning)
            } else {
                Text("\u{2014}").font(.largeTitle)
                Text("No reading received").font(.callout).foregroundStyle(.secondary)
            }
        }.frame(maxWidth: .infinity, minHeight: 140, alignment: .leading).padding(20).background(.white, in: RoundedRectangle(cornerRadius: 6))
    }
}

struct SensorsView: View {
    @ObservedObject var store: DriverStore
    @ObservedObject var adapter: BLEVehicleAdapter
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                Text("\(store.supported.count) supported measurements").font(.title2.bold())
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 210), alignment: .leading)], spacing: 16) {
                        ForEach(store.supported, id: \.key) { spec in
                            SensorTile(spec: spec, reading: store.readings[spec.key], live: store.collecting && adapter.ready, at: context.date)
                        }
                    }
                }
                if store.supported.isEmpty { Text("Connect the adapter and start readings to discover the vehicle's sensors.").foregroundStyle(.secondary) }
                Text("Diagnostic codes").font(.title2.bold())
                Button { Task { await store.refreshDriverData() } } label: { Label("Read fleet records", systemImage: "arrow.clockwise").frame(minHeight: 44) }.disabled(store.busy)
                if store.diagnosticCodes.isEmpty { Text("No codes loaded from fleet records.").foregroundStyle(.secondary) }
                ForEach(Array(store.diagnosticCodes.enumerated()), id: \.offset) { row in
                    VStack(alignment: .leading) { Text(row.element["code"] ?? "").font(.headline.monospaced()); Text(row.element["description"] ?? "") }.padding(.vertical, 8)
                }
                Text("Hours of service").font(.title2.bold())
                if store.hosStatus["sufficientHistory"] as? Bool == true {
                    Text(store.hosStatus["ruleLabel"] as? String ?? "Carrier hours of service")
                    if let remaining = store.hosStatus["driveRemainingMinutes"] as? Int { Text("Driving time remaining: \(remaining) min") }
                } else { Text("No verified hours-of-service summary loaded. Continue using your authorized ELD.").foregroundStyle(.secondary) }
            }.padding(24)
        }.background(Brand.paper).navigationTitle("Sensors").navigationBarTitleDisplayMode(.inline)
    }
}

struct ConnectionView: View {
    @ObservedObject var store: DriverStore
    @ObservedObject var adapter: BLEVehicleAdapter
    @State private var writeId = ""
    @State private var notifyId = ""
    var body: some View {
        Form {
            Section("Vehicle adapter") {
                Text(adapter.status).fixedSize(horizontal: false, vertical: true)
                if adapter.hasSavedAdapter && !adapter.connected {
                    Button { adapter.reconnectSaved() } label: {
                        Label("Reconnect saved adapter", systemImage: "arrow.clockwise")
                    }.disabled(store.collecting)
                }
                Button { adapter.scanning ? adapter.stopScan() : adapter.scan() } label: {
                    Label(adapter.scanning ? "Stop search" : "Find Bluetooth adapter", systemImage: "antenna.radiowaves.left.and.right")
                }.disabled(store.collecting)
                ForEach(adapter.devices) { device in
                    Button { writeId = ""; notifyId = ""; adapter.connect(device) } label: { Label(device.name, systemImage: "cable.connector") }.disabled(store.collecting)
                }
                if adapter.connected { Button("Disconnect adapter", role: .destructive) { store.stopReadings() } }
            }
            if adapter.connected {
                Section("Adapter interface") {
                    Text("Select the BLE characteristics specified for your adapter. Discovery alone does not confirm vehicle compatibility.").foregroundStyle(.secondary)
                    Picker("Write characteristic", selection: $writeId) {
                        Text("Select").tag("")
                        ForEach(adapter.writers) { Text($0.label).tag($0.id) }
                    }
                    Picker("Notify characteristic", selection: $notifyId) {
                        Text("Select").tag("")
                        ForEach(adapter.readers) { Text($0.label).tag($0.id) }
                    }
                    Button("Use this interface") { adapter.selectEndpoints(writeId: writeId, notifyId: notifyId) }
                        .disabled(writeId.isEmpty || notifyId.isEmpty || store.collecting)
                }
            }
            Section("Wired truck gateway") {
                Label("Not supported in this Apple build", systemImage: "cable.connector.slash")
                Text("A 9-pin connector is not an Apple data interface. Gateway model, Apple transport support and a documented protocol must be verified before connection.").foregroundStyle(.secondary)
            }
            Section("Device assignment") {
                LabeledContent("Vehicle", value: store.session?.vehicleId ?? "")
                LabeledContent("Driver", value: store.session?.driverName ?? "")
                LabeledContent("Server", value: "fleetaiops.com")
                Text("Pairing stays saved on this device across app updates. Reassignment is managed by your fleet manager.").foregroundStyle(.secondary)
            }
            Section("Capture status") {
                Text("Bluetooth collection in the background is controlled by iOS. Force-quitting, disabling Bluetooth or losing the adapter connection can stop collection. Saved records retry when the app can run.")
                Text("Apple pilot build 0.1.0. Not an ELD replacement.").foregroundStyle(.secondary)
            }
        }.navigationTitle("Connection").navigationBarTitleDisplayMode(.inline)
    }
}

struct InspectionView: View {
    @ObservedObject var store: DriverStore
    @State private var type = "pre"
    @State private var results: [String: String] = [:]
    @State private var defects = ""
    @State private var signature = ""
    @State private var odometer = ""
    private let items = ["Brakes","Steering","Lights and reflectors","Tires and wheels","Mirrors","Coupling equipment","Fluid leaks","Emergency equipment"]
    var body: some View {
        Form {
            Section("Vehicle inspection") {
                Picker("Inspection", selection: $type) { Text("Pre-trip").tag("pre"); Text("Post-trip").tag("post") }.pickerStyle(.segmented)
                TextField("Odometer (miles)", text: $odometer).keyboardType(.decimalPad)
                ForEach(items, id: \.self) { item in
                    Picker(item, selection: Binding(get: { results[item] ?? "" }, set: { results[item] = $0 })) {
                        Text("Not checked").tag(""); Text("Pass").tag("pass"); Text("Defect").tag("defect"); Text("Not applicable").tag("not_applicable")
                    }
                }
            }
            Section("Report") {
                TextField("Defect details", text: $defects, axis: .vertical).lineLimit(3...8)
                TextField("Driver name / signature", text: $signature).textContentType(.name)
                if !store.notice.isEmpty { Text(store.notice).foregroundStyle(Brand.good) }
                Button {
                    Task {
                        let submitted = await store.submitInspection(type: type,
                            items: items.map { "\($0): \(results[$0] ?? "")" }, defects: defects, signature: signature, odometer: odometer)
                        if submitted { results = [:]; defects = ""; signature = ""; odometer = "" }
                    }
                } label: { Label("Save inspection", systemImage: "checkmark.circle").frame(minHeight: 44) }
                    .disabled(store.busy || results.count != items.count || results.values.contains("") || signature.isEmpty || odometer.isEmpty || (results.values.contains("defect") && defects.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty))
            }
        }.navigationTitle("Inspection").navigationBarTitleDisplayMode(.inline)
    }
}
