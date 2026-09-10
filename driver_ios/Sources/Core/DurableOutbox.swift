import Foundation
import CryptoKit

public actor DurableOutbox {
    public struct Entry: Codable {
        public let id: String
        public let scope: String
        public let path: String
        public let payload: Data
        public let createdAt: Date
        public var attempts: Int = 0
        public var retryAt: Date = .distantPast
        public var rejected: Bool = false
    }
    private let root: URL
    private let limit: Int
    private let manager = FileManager.default
    private var index: [String: [URL]] = [:]

    public init(root: URL, limit: Int = 100_000) throws {
        self.root = root; self.limit = limit
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }
    private func directory(_ scope: String) throws -> URL {
        let digest = SHA256.hash(data: Data(scope.utf8)).map { String(format: "%02x", $0) }.joined()
        let url = root.appendingPathComponent(digest, isDirectory: true)
        try manager.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }
    private func files(_ scope: String) throws -> [URL] {
        if let cached = index[scope] { return cached }
        let result = try manager.contentsOfDirectory(at: directory(scope), includingPropertiesForKeys: nil)
            .filter { $0.pathExtension == "json" }.sorted { $0.lastPathComponent < $1.lastPathComponent }
        index[scope] = result
        return result
    }
    private func url(_ entry: Entry) throws -> URL {
        try directory(entry.scope).appendingPathComponent(entry.id + ".json")
    }
    private func save(_ entry: Entry) throws {
        let target = try url(entry)
        try JSONEncoder().encode(entry).write(to: target, options: .atomic)
        if var known = index[entry.scope], !known.contains(target) {
            let position = known.firstIndex { $0.lastPathComponent > target.lastPathComponent } ?? known.endIndex
            known.insert(target, at: position); index[entry.scope] = known
        }
        #if os(iOS)
        try manager.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: target.path)
        #endif
        var resource = URLResourceValues(); resource.isExcludedFromBackup = true
        var file = target; try file.setResourceValues(resource)
    }
    public func count(scope: String) throws -> Int { try files(scope).count }
    public func enqueue(payload: Data, path: String, session: DriverSession, at: Date = Date()) throws {
        try session.validate()
        guard [DriverContract.ingest, DriverContract.dvir].contains(path) else { throw DriverError.scopeMismatch }
        guard payload.count < 256_000 else { throw DriverError.invalidResponse }
        try DriverContract.validateOutbound(payload, path: path, session: session)
        guard try files(session.scope).count < limit else { throw DriverError.queueFull }
        let id = String(format: "%020.0f", at.timeIntervalSince1970 * 1000) + "-" + UUID().uuidString
        try save(Entry(id: id, scope: session.scope, path: path, payload: payload, createdAt: at))
    }
    public func pending(session: DriverSession, at now: Date = Date()) throws -> [Entry] {
        try session.validate()
        // A small live lane prevents an offline backlog from hiding current readings.
        let all = try files(session.scope)
        let newest = Array(all.suffix(5).reversed())
        let selected = newest + all.filter { !newest.contains($0) }
        var entries: [Entry] = []
        for file in selected {
            let entry = try JSONDecoder().decode(Entry.self, from: Data(contentsOf: file))
            guard entry.scope == session.scope, entry.id == file.deletingPathExtension().lastPathComponent,
                  [DriverContract.ingest, DriverContract.dvir].contains(entry.path) else { throw DriverError.scopeMismatch }
            try DriverContract.validateOutbound(entry.payload, path: entry.path, session: session)
            if !entry.rejected && entry.retryAt <= now { entries.append(entry) }
            if entries.count == 25 { break }
        }
        return entries
    }
    public func acknowledge(_ entry: Entry, session: DriverSession) throws {
        guard entry.scope == session.scope else { throw DriverError.scopeMismatch }
        try manager.removeItem(at: url(entry))
        index[entry.scope]?.removeAll { $0.lastPathComponent == entry.id + ".json" }
    }
    public func failed(_ entry: Entry, session: DriverSession, permanent: Bool, at: Date = Date()) throws {
        guard entry.scope == session.scope else { throw DriverError.scopeMismatch }
        var updated = entry
        updated.attempts += 1
        updated.retryAt = at.addingTimeInterval(min(300, pow(2, Double(min(updated.attempts, 8)))))
        updated.rejected = permanent
        // Rejected records are retained for recovery, not silently discarded.
        try save(updated)
    }
}
