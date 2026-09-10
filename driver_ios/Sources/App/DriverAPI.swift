import Foundation

final class NoRedirects: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        // A deployment redirect must not forward credentials, PINs or telemetry to another origin.
        completionHandler(nil)
    }
}

final class DriverAPI {
    private let redirects = NoRedirects()
    private lazy var transport: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.httpShouldSetCookies = false; config.httpCookieStorage = nil
        config.urlCache = nil; config.requestCachePolicy = .reloadIgnoringLocalCacheData
        config.timeoutIntervalForRequest = 20; config.timeoutIntervalForResource = 40
        return URLSession(configuration: config, delegate: redirects, delegateQueue: nil)
    }()
    func request(path: String, session: DriverSession? = nil, body: Data? = nil) async throws -> Data {
        let allowed = [DriverContract.claim, DriverContract.ingest, DriverContract.dvir, DriverContract.dtcs, DriverContract.hos, "/health"]
        guard allowed.contains(path), session != nil || [DriverContract.claim,"/health"].contains(path) else { throw DriverError.scopeMismatch }
        if let session { try session.validate(); guard session.origin == DriverContract.origin else { throw DriverError.scopeMismatch } }
        let url = DriverContract.origin.appendingPathComponent(String(path.dropFirst()))
        var req = URLRequest(url: url)
        req.httpMethod = body == nil ? "GET" : "POST"; req.httpBody = body
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        if body != nil { req.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        req.setValue("ios-0.1.0", forHTTPHeaderField: "X-FleetAI-App-Version")
        if let session {
            req.setValue("Bearer \(session.token)", forHTTPHeaderField: "Authorization")
            req.setValue(session.tenantId, forHTTPHeaderField: "X-Tenant-Id")
        }
        let (data, response) = try await transport.data(for: req)
        guard let http = response as? HTTPURLResponse else { throw DriverError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else { throw DriverError.http(http.statusCode) }
        guard data.count < 2_000_000,
              let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              (json["ok"] as? Bool) != false, (json["success"] as? Bool) != false else { throw DriverError.invalidResponse }
        return data
    }
}
