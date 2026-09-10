import Foundation

/// Async work from a stopped capture must never publish into, or stop, a newer run.
public struct CaptureLifecycle {
    public private(set) var active: UUID?
    public init() {}
    public mutating func begin() -> UUID? {
        guard active == nil else { return nil }
        let id = UUID(); active = id; return id
    }
    public func isCurrent(_ id: UUID) -> Bool { active == id }
    public mutating func stop() { active = nil }
}

public struct AdapterProfile: Codable, Equatable {
    public let scope: String
    public let peripheralId: UUID
    public let serviceUUID: String
    public let writeUUID: String
    public let notifyUUID: String

    public func matches(_ session: DriverSession) -> Bool {
        scope == session.scope && [serviceUUID, writeUUID, notifyUUID].allSatisfy { value in
            let hex = value.replacingOccurrences(of: "-", with: "")
            return [4,8,32].contains(hex.count) && hex.allSatisfy { $0.isASCII && $0.isHexDigit }
        }
    }
}
