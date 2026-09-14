import CryptoKit
import Foundation
import OpenClawKit
import Security

private struct StoredFamilyInviteEdgeCredential: Codable {
    let invitationId: String
    let edgeToken: String
    let expiresAtMs: Int64
    let gatewayURL: String
}

enum FamilyInviteEdgeCredentials {
    private static let service = "ai.openclaw.family-edge-credential"

    static func save(invitationId: String, edgeToken: String, expiresAtMs: Int64, gatewayURL: URL) -> Bool {
        guard let normalizedURL = self.normalizedGatewayURL(gatewayURL),
              let account = self.account(for: normalizedURL),
              let data = try? JSONEncoder().encode(StoredFamilyInviteEdgeCredential(
                  invitationId: invitationId,
                  edgeToken: edgeToken,
                  expiresAtMs: expiresAtMs,
                  gatewayURL: normalizedURL.absoluteString)),
              let value = String(data: data, encoding: .utf8)
        else { return false }
        return GenericPasswordKeychainStore.saveString(
            value,
            service: self.service,
            account: account,
            accessible: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly)
    }

    static func upgradeHeaders(for gatewayURL: URL) -> [String: String] {
        guard gatewayURL.scheme?.lowercased() == "wss",
              gatewayURL.path == "/v1/gateway",
              let credential = self.load(for: gatewayURL),
              credential.expiresAtMs > Self.nowMs(),
              let key = try? FamilyInviteDeviceKey.loadOrCreate()
        else { return [:] }
        let timestamp = String(Self.nowMs())
        let nonce = Self.randomNonce()
        let audience = FamilyInviteRelayClient.audience
        let tokenHash = Data(SHA256.hash(data: Data(credential.edgeToken.utf8))).familyInviteCredentialBase64URL
        let canonical = "openclaw-agent-proof-v1\nGET\n/v1/gateway\n\(audience)\n\(timestamp)\n\(nonce)\n\(tokenHash)"
        guard let proof = try? key.signature(for: Data(canonical.utf8)) else { return [:] }
        return [
            "Authorization": "Bearer \(credential.edgeToken)",
            "X-OpenClaw-Device-JWK": key.canonicalPublicJWK,
            "X-OpenClaw-Device-Thumbprint": key.thumbprint,
            "X-OpenClaw-Proof-Timestamp": timestamp,
            "X-OpenClaw-Proof-Nonce": nonce,
            "X-OpenClaw-Device-Proof": proof,
        ]
    }

    static func refreshIfNeeded(for gatewayURL: URL) async {
        guard let credential = self.load(for: gatewayURL),
              credential.expiresAtMs <= self.nowMs() + 30000,
              let key = try? FamilyInviteDeviceKey.loadOrCreate(),
              let baseURL = self.relayBaseURL(for: gatewayURL),
              let edge = try? await FamilyInviteRelayClient().edgeToken(
                  invitationId: credential.invitationId,
                  baseURL: baseURL,
                  key: key),
              let refreshedURL = URL(string: edge.gatewayUrl),
              self.normalizedGatewayURL(refreshedURL) == self.normalizedGatewayURL(gatewayURL)
        else { return }
        _ = self.save(
            invitationId: credential.invitationId,
            edgeToken: edge.edgeToken,
            expiresAtMs: edge.expiresAtMs,
            gatewayURL: gatewayURL)
    }

    static func mergingUpgradeHeaders(_ headers: [String: String], for gatewayURL: URL) -> [String: String] {
        headers.merging(self.upgradeHeaders(for: gatewayURL)) { _, familyCredential in familyCredential }
    }

    @discardableResult
    static func clear(for gatewayURL: URL) -> Bool {
        guard let account = self.account(for: gatewayURL) else { return true }
        return GenericPasswordKeychainStore.delete(service: self.service, account: account)
    }

    static func clear(stableID: String) {
        guard let gatewayURL = GatewaySettingsStore.loadGatewayRegistry().entries
            .first(where: { GatewayStableIdentifier.matches($0.stableID, stableID) })
            .flatMap(Self.gatewayURL(for:))
        else { return }
        _ = self.clear(for: gatewayURL)
    }

    private static func load(for gatewayURL: URL) -> StoredFamilyInviteEdgeCredential? {
        guard let account = self.account(for: gatewayURL),
              let value = GenericPasswordKeychainStore.loadString(service: self.service, account: account),
              let data = value.data(using: .utf8),
              let credential = try? JSONDecoder().decode(StoredFamilyInviteEdgeCredential.self, from: data),
              credential.gatewayURL == self.normalizedGatewayURL(gatewayURL)?.absoluteString
        else { return nil }
        return credential
    }

    private static func account(for url: URL) -> String? {
        guard let normalized = self.normalizedGatewayURL(url), let host = normalized.host?.lowercased()
        else { return nil }
        let port = normalized.port.map { ":\($0)" } ?? ""
        return Data(SHA256.hash(data: Data("wss://\(host)\(port)/v1/gateway".utf8)))
            .familyInviteCredentialBase64URL
    }

    static func normalizedGatewayURL(_ url: URL) -> URL? {
        guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              components.scheme?.lowercased() == "wss",
              components.host != nil,
              components.path == "/v1/gateway",
              components.user == nil,
              components.password == nil,
              components.query == nil,
              components.fragment == nil
        else { return nil }
        components.scheme = "wss"
        components.host = components.host?.lowercased()
        if components.port == 443 { components.port = nil }
        return components.url
    }

    private static func relayBaseURL(for gatewayURL: URL) -> URL? {
        guard var components = URLComponents(url: gatewayURL, resolvingAgainstBaseURL: false) else { return nil }
        components.scheme = "https"
        components.path = ""
        components.query = nil
        components.fragment = nil
        return components.url
    }

    private static func gatewayURL(for entry: GatewaySettingsStore.GatewayRegistryEntry) -> URL? {
        guard entry.kind == .manual, let host = entry.host, let port = entry.port else { return nil }
        var components = URLComponents()
        components.scheme = entry.useTLS ? "wss" : "ws"
        components.host = host
        components.port = port
        components.percentEncodedPath = entry.contextPath ?? ""
        return components.url
    }

    private static func nowMs() -> Int64 {
        Int64(Date().timeIntervalSince1970 * 1000)
    }

    private static func randomNonce() -> String {
        var bytes = [UInt8](repeating: 0, count: 16)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
            return UUID().uuidString.replacingOccurrences(of: "-", with: "")
        }
        return Data(bytes).familyInviteCredentialBase64URL
    }
}

extension Data {
    fileprivate var familyInviteCredentialBase64URL: String {
        self.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
