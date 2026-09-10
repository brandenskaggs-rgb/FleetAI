import Foundation
import Security

enum SessionVault {
    private static let service = "com.fleetai.driver.ios.v1"
    private static func query(_ account: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
    }
    static func read(_ account: String) throws -> Data? {
        var q = query(account); q[kSecReturnData as String] = true; q[kSecMatchLimit as String] = kSecMatchLimitOne
        var value: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &value)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = value as? Data else { throw DriverError.invalidSession }
        return data
    }
    static func store(_ data: Data, account: String) throws {
        let attributes: [String: Any] = [kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        let status = SecItemUpdate(query(account) as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            guard SecItemAdd(query(account).merging(attributes) { _, new in new } as CFDictionary, nil) == errSecSuccess else { throw DriverError.invalidSession }
        } else if status != errSecSuccess { throw DriverError.invalidSession }
    }
    static func deviceId() throws -> String {
        if let data = try read("device-id"), let id = String(data: data, encoding: .utf8), UUID(uuidString: id) != nil { return id }
        let id = UUID().uuidString(); try store(Data(id.utf8), account: "device-id"); return id
    }
    static func session() throws -> DriverSession? {
        guard let data = try read("session") else { return nil }
        let session = try JSONDecoder().decode(DriverSession.self, from: data)
        try session.validate(); return session
    }
    static func save(_ session: DriverSession) throws {
        try session.validate(); try store(JSONEncoder().encode(session), account: "session")
    }
}
