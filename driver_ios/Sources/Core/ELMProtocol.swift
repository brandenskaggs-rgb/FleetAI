import Foundation

public struct PIDSpec {
    public let pid: Int
    public let key: String
    public let name: String
    public let unit: String
    public let interval: TimeInterval
    public let bytes: Int
    let scale: Double
    let offset: Double
    public var command: String { String(format: "01%02X", pid) }
    init(_ pid: Int, _ key: String, _ name: String, _ unit: String, _ interval: TimeInterval,
         _ bytes: Int = 1, _ scale: Double = 1, _ offset: Double = 0) {
        self.pid = pid; self.key = key; self.name = name; self.unit = unit; self.interval = interval
        self.bytes = bytes; self.scale = scale; self.offset = offset
    }
}

public enum ELMProtocol {
    // Metric keys and wire units match Android J1979Spec/ObdParser and Node ingestion.
    public static let sensors: [PIDSpec] = [
        PIDSpec(0x0C,"rpm","Engine speed","rpm",0.5,2,0.25),
        PIDSpec(0x0D,"speedKph","Vehicle speed","km/h",0.5),
        PIDSpec(0x04,"engineLoadPct","Engine load","%",1,1,100/255),
        PIDSpec(0x05,"coolantTempC","Coolant temperature","C",1,1,1,-40),
        PIDSpec(0x0B,"mapKpa","Manifold pressure","kPa",1),
        PIDSpec(0x0F,"intakeAirTempC","Intake temperature","C",1,1,1,-40),
        PIDSpec(0x10,"mafGramsPerSec","Mass air flow","g/s",1,2,0.01),
        PIDSpec(0x11,"throttlePosPct","Throttle position","%",1,1,100/255),
        PIDSpec(0x42,"batteryVoltageV","ECU voltage","V",1,2,0.001),
        PIDSpec(0x06,"shortTermFuelTrimBank1Pct","Short fuel trim B1","%",2,1,100/128,-100),
        PIDSpec(0x07,"longTermFuelTrimBank1Pct","Long fuel trim B1","%",4,1,100/128,-100),
        PIDSpec(0x08,"shortTermFuelTrimBank2Pct","Short fuel trim B2","%",2,1,100/128,-100),
        PIDSpec(0x09,"longTermFuelTrimBank2Pct","Long fuel trim B2","%",4,1,100/128,-100),
        PIDSpec(0x0A,"fuelPressureKpa","Fuel pressure","kPa",2,1,3),
        PIDSpec(0x22,"fuelRailPressureRelativeKpa","Relative rail pressure","kPa",1.5,2,0.079),
        PIDSpec(0x23,"fuelRailGaugePressureKpa","Rail gauge pressure","kPa",1.5,2,10),
        PIDSpec(0x2C,"commandedEgrPct","Commanded EGR","%",2.5,1,100/255),
        PIDSpec(0x2D,"egrErrorPct","EGR error","%",2.5,1,100/128,-100),
        PIDSpec(0x2E,"commandedEvapPurgePct","EVAP purge","%",3,1,100/255),
        PIDSpec(0x2F,"fuelLevelPct","Fuel level","%",5,1,100/255),
        PIDSpec(0x44,"commandedEquivalenceRatio","Equivalence ratio","lambda",2,2,2/65536),
        PIDSpec(0x52,"ethanolFuelPct","Ethanol content","%",10,1,100/255),
        PIDSpec(0x59,"fuelRailAbsolutePressureKpa","Absolute rail pressure","kPa",1.5,2,10),
        PIDSpec(0x5D,"fuelInjectionTimingDeg","Injection timing","deg",2,2,1/128,-210),
        PIDSpec(0x5E,"fuelRateLph","Fuel rate","L/h",2,2,0.05),
        PIDSpec(0x0E,"ignitionTimingAdvanceDeg","Ignition advance","deg",1,1,0.5,-64),
        PIDSpec(0x14,"o2B1S1VoltageV","Oxygen B1S1","V",1.5,2,0.005),
        PIDSpec(0x15,"o2B1S2VoltageV","Oxygen B1S2","V",1.5,2,0.005),
        PIDSpec(0x18,"o2B2S1VoltageV","Oxygen B2S1","V",1.5,2,0.005),
        PIDSpec(0x19,"o2B2S2VoltageV","Oxygen B2S2","V",1.5,2,0.005),
        PIDSpec(0x3C,"catalystTempB1S1C","Catalyst B1S1","C",3,2,0.1,-40),
        PIDSpec(0x3D,"catalystTempB2S1C","Catalyst B2S1","C",3,2,0.1,-40),
        PIDSpec(0x3E,"catalystTempB1S2C","Catalyst B1S2","C",3,2,0.1,-40),
        PIDSpec(0x3F,"catalystTempB2S2C","Catalyst B2S2","C",3,2,0.1,-40),
        PIDSpec(0x45,"relativeThrottlePosPct","Relative throttle","%",1,1,100/255),
        PIDSpec(0x47,"absoluteThrottleBPosPct","Throttle B","%",1,1,100/255),
        PIDSpec(0x48,"absoluteThrottleCPosPct","Throttle C","%",1,1,100/255),
        PIDSpec(0x49,"acceleratorPedalDPosPct","Accelerator D","%",1,1,100/255),
        PIDSpec(0x4A,"acceleratorPedalEPosPct","Accelerator E","%",1,1,100/255),
        PIDSpec(0x4B,"acceleratorPedalFPosPct","Accelerator F","%",1,1,100/255),
        PIDSpec(0x4C,"commandedThrottleActuatorPct","Commanded throttle","%",1,1,100/255),
        PIDSpec(0x5A,"relativeAcceleratorPedalPct","Relative accelerator","%",1,1,100/255),
        PIDSpec(0x61,"driverDemandTorquePct","Demanded torque","%",1,1,1,-125),
        PIDSpec(0x62,"actualTorquePct","Actual torque","%",1,1,1,-125),
        PIDSpec(0x63,"referenceTorqueNm","Reference torque","Nm",5,2),
        PIDSpec(0x1F,"engineRunTimeSec","Engine run time","s",5,2),
        PIDSpec(0x21,"distanceWithMilOnKm","Distance with MIL","km",15,2),
        PIDSpec(0x30,"warmupsSinceClear","Warm-ups since clear","count",30),
        PIDSpec(0x31,"distanceSinceClearKm","Distance since clear","km",15,2),
        PIDSpec(0x32,"evapSystemVaporPressurePa","EVAP pressure","Pa",5,2,0.25,-8192),
        PIDSpec(0x33,"barometricPressureKpa","Barometric pressure","kPa",5),
        PIDSpec(0x43,"absoluteLoadPct","Absolute load","%",2,2,100/255),
        PIDSpec(0x46,"ambientTempC","Ambient temperature","C",5,1,1,-40),
        PIDSpec(0x4D,"milRunTimeMin","MIL run time","min",15,2),
        PIDSpec(0x4E,"timeSinceClearMin","Time since clear","min",15,2),
        PIDSpec(0x53,"absoluteEvapVaporPressureKpa","Absolute EVAP pressure","kPa",5,2,0.005),
        PIDSpec(0x54,"evapSystemVaporPressureWidePa","Wide EVAP pressure","Pa",5,2,1,-32767),
        PIDSpec(0x5B,"hybridBatteryRemainingPct","Hybrid battery","%",5,1,100/255),
        PIDSpec(0x5C,"oilTempC","Oil temperature","C",2,1,1,-40),
        PIDSpec(0xA6,"odometerKm","Odometer","km",30,4,0.1)
    ]

    public static func allows(_ command: String) -> Bool {
        guard !command.contains(where: { $0.isNewline || $0 == "\0" }) else { return false }
        if ["ATZ","ATI","ATE0","ATL0","ATS1","ATH0","ATSP0","ATDP"].contains(command) { return true }
        // No raw console, custom headers, DTC clearing, actuator tests or write services.
        return sensors.contains { $0.command == command } || stride(from: 0, through: 0xA0, by: 0x20).contains { String(format: "01%02X", $0) == command }
    }

    public static func payload(_ response: String, pid: Int) -> [UInt8]? {
        // ATH0/ATS1 yields one response per line. Never join different ECU lines into a reading.
        for raw in response.uppercased().components(separatedBy: .newlines) {
            let line = raw.replacingOccurrences(of: ">", with: "").replacingOccurrences(of: " ", with: "").replacingOccurrences(of: "\t", with: "")
            guard line.count >= 4, line.count.isMultiple(of: 2), line.allSatisfy({ $0.isHexDigit }) else { continue }
            var bytes: [UInt8] = []; var index = line.startIndex
            while index < line.endIndex {
                let end = line.index(index, offsetBy: 2)
                guard let byte = UInt8(line[index..<end], radix: 16) else { return nil }
                bytes.append(byte); index = end
            }
            guard bytes[0] == 0x41, Int(bytes[1]) == pid else { continue }
            return Array(bytes.dropFirst(2))
        }
        return nil
    }

    public static func supported(_ response: String, base: Int) -> Set<Int>? {
        guard let b = payload(response, pid: base), b.count >= 4 else { return nil }
        let mask = b.prefix(4).reduce(UInt32(0)) { ($0 << 8) | UInt32($1) }
        return Set((1...32).filter { mask & (UInt32(1) << (32 - $0)) != 0 }.map { base + $0 })
    }

    public static func decode(_ response: String, spec: PIDSpec, at: Date) -> SensorReading? {
        guard let bytes = payload(response, pid: spec.pid), bytes.count >= spec.bytes else { return nil }
        let oxygen = [0x14,0x15,0x18,0x19].contains(spec.pid)
        let raw = oxygen ? UInt64(bytes[0]) : bytes.prefix(spec.bytes).reduce(UInt64(0)) { ($0 << 8) | UInt64($1) }
        let value = Double(raw) * spec.scale + spec.offset
        let ranges: [String: ClosedRange<Double>] = ["rpm":0...10000,"speedKph":0...300,
            "coolantTempC":(-50)...150,"oilTempC":(-50)...200,"intakeAirTempC":(-50)...150,
            "ambientTempC":(-50)...100,"batteryVoltageV":5...40,"mafGramsPerSec":0...1000,"fuelLevelPct":0...100]
        guard value.isFinite, ranges[spec.key]?.contains(value) ?? true else { return nil }
        return SensorReading(key: spec.key, value: value, capturedAt: at)
    }
}
