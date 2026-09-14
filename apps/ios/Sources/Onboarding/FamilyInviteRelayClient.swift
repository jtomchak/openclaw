import CryptoKit
import Foundation
import OpenClawKit
import Security

struct FamilyInviteEnrollmentResult: Sendable {
    let invitationId: String
    let setupLink: GatewayConnectDeepLink
    let edgeToken: String
    let edgeExpiresAtMs: Int64
    let gatewayURL: URL
}

enum FamilyInviteRelayError: Error {
    case invalidResponse
    case rejected
    case unavailable
}

final class FamilyInviteRelayClient: @unchecked Sendable {
    // Protocol constant shared with the relay. This is deliberately not deploy-time configurable:
    // changing a proof audience on only one side makes every signed request invalid.
    static let audience = "openclaw-agent-relay"
    private static let maximumResponseBytes = 64 * 1024
    typealias Request = @Sendable (URLRequest) async throws -> (Data, URLResponse)

    private struct RedeemBody: Encodable {
        let invitationToken: String
        let deviceJwk: String
        let deviceThumbprint: String
    }

    private struct EdgeBody: Encodable {
        let invitationId: String
        let deviceJwk: String
        let deviceThumbprint: String
    }

    private struct InviteEnvelope: Decodable {
        let invitationId: String
        let status: String?
    }

    private struct RedeemResponse: Decodable {
        let invitationId: String?
        let status: String?
        let setupCode: String?
        let setupId: String?
        let expiresAtMs: Int64?
        let setupExpiresAtMs: Int64?
        let invite: InviteEnvelope?

        var resolvedInvitationId: String? {
            self.invitationId ?? self.invite?.invitationId
        }
    }

    struct EdgeResponse: Decodable {
        let edgeToken: String
        let expiresAtMs: Int64
        let gatewayUrl: String
    }

    private let request: Request

    init(request: @escaping Request = { request in
        try await URLSession.shared.data(for: request)
    }) {
        self.request = request
    }

    func enroll(
        invite: FamilyInviteDeepLink,
        key: any FamilyInviteSigningKey) async throws -> FamilyInviteEnrollmentResult
    {
        let redeemBody = try JSONEncoder().encode(RedeemBody(
            invitationToken: invite.inviteToken,
            deviceJwk: key.canonicalPublicJWK,
            deviceThumbprint: key.thumbprint))
        let redeem: RedeemResponse = try await self.post(
            path: "/v1/invitations/redeem",
            baseURL: invite.relayBaseURL,
            body: redeemBody,
            key: key,
            bearerToken: nil)
        guard let invitationId = redeem.resolvedInvitationId,
              !invitationId.isEmpty,
              let setupCode = redeem.setupCode,
              let setupLink = GatewayConnectDeepLink.fromSetupCode(setupCode)
        else { throw FamilyInviteRelayError.rejected }

        let edge = try await self.edgeToken(invitationId: invitationId, baseURL: invite.relayBaseURL, key: key)
        guard edge.expiresAtMs > Int64(Date().timeIntervalSince1970 * 1000),
              !edge.edgeToken.isEmpty,
              let gatewayURL = URL(string: edge.gatewayUrl),
              gatewayURL.scheme?.lowercased() == "wss",
              gatewayURL.host?.lowercased() == invite.relayBaseURL.host?.lowercased(),
              gatewayURL.port == nil,
              gatewayURL.path == "/v1/gateway",
              gatewayURL.query == nil,
              gatewayURL.fragment == nil,
              gatewayURL.user == nil,
              gatewayURL.password == nil
        else { throw FamilyInviteRelayError.invalidResponse }

        let relaySetupLink = GatewayConnectDeepLink(
            host: gatewayURL.host ?? "",
            port: 443,
            tls: true,
            contextPath: gatewayURL.path,
            tlsFingerprintSha256: nil,
            expiresAtMs: setupLink.expiresAtMs,
            bootstrapToken: setupLink.bootstrapToken,
            token: setupLink.token,
            password: setupLink.password)
        guard relaySetupLink.isValidEndpoint else { throw FamilyInviteRelayError.invalidResponse }
        return FamilyInviteEnrollmentResult(
            invitationId: invitationId,
            setupLink: relaySetupLink,
            edgeToken: edge.edgeToken,
            edgeExpiresAtMs: edge.expiresAtMs,
            gatewayURL: gatewayURL)
    }

    func edgeToken(
        invitationId: String,
        baseURL: URL,
        key: any FamilyInviteSigningKey) async throws -> EdgeResponse
    {
        let body = try JSONEncoder().encode(EdgeBody(
            invitationId: invitationId,
            deviceJwk: key.canonicalPublicJWK,
            deviceThumbprint: key.thumbprint))
        return try await self.post(
            path: "/v1/edge-tokens",
            baseURL: baseURL,
            body: body,
            key: key,
            bearerToken: nil)
    }

    private func post<Response: Decodable>(
        path: String,
        baseURL: URL,
        body: Data,
        key: any FamilyInviteSigningKey,
        bearerToken: String?) async throws -> Response
    {
        guard var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else {
            throw FamilyInviteRelayError.invalidResponse
        }
        components.path = path
        guard let url = components.url else { throw FamilyInviteRelayError.invalidResponse }
        let timestamp = String(Int64(Date().timeIntervalSince1970 * 1000))
        let nonce = Self.randomNonce()
        let bodyHash = Data(SHA256.hash(data: body)).familyInviteRelayBase64URL
        let canonical = "openclaw-agent-proof-v1\nPOST\n\(path)\n\(Self.audience)\n\(timestamp)\n\(nonce)\n\(bodyHash)"
        let proof = try key.signature(for: Data(canonical.utf8))
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 15)
        request.httpMethod = "POST"
        request.httpBody = body
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(key.canonicalPublicJWK, forHTTPHeaderField: "X-OpenClaw-Device-JWK")
        request.setValue(key.thumbprint, forHTTPHeaderField: "X-OpenClaw-Device-Thumbprint")
        request.setValue(timestamp, forHTTPHeaderField: "X-OpenClaw-Proof-Timestamp")
        request.setValue(nonce, forHTTPHeaderField: "X-OpenClaw-Proof-Nonce")
        request.setValue(proof, forHTTPHeaderField: "X-OpenClaw-Device-Proof")
        if let bearerToken {
            request.setValue("Bearer \(bearerToken)", forHTTPHeaderField: "Authorization")
        }
        let (data, response): (Data, URLResponse)
        do {
            (data, response) = try await self.request(request)
        } catch {
            throw FamilyInviteRelayError.unavailable
        }
        guard data.count <= Self.maximumResponseBytes,
              let http = response as? HTTPURLResponse,
              (200..<300).contains(http.statusCode)
        else { throw FamilyInviteRelayError.rejected }
        guard let decoded = try? JSONDecoder().decode(Response.self, from: data) else {
            throw FamilyInviteRelayError.invalidResponse
        }
        return decoded
    }

    private static func randomNonce() -> String {
        var bytes = [UInt8](repeating: 0, count: 16)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
            return UUID().uuidString.replacingOccurrences(of: "-", with: "")
        }
        return Data(bytes).familyInviteRelayBase64URL
    }
}

extension Data {
    fileprivate var familyInviteRelayBase64URL: String {
        self.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
