import CryptoKit
import Foundation
import OpenClawKit
import Security

protocol FamilyInviteSigningKey: Sendable {
    var canonicalPublicJWK: String { get }
    var thumbprint: String { get }
    func signature(for data: Data) throws -> String
}

struct FamilyInviteDeviceKey: FamilyInviteSigningKey {
    private enum Backing: Sendable {
        case secureEnclave(SecureEnclave.P256.Signing.PrivateKey)
        case software(P256.Signing.PrivateKey)
    }

    private struct StoredKey: Codable {
        let kind: String
        let representation: String
    }

    private static let service = "ai.openclaw.family-enrollment-key"
    private static let account = "p256.v1"
    private let backing: Backing
    let canonicalPublicJWK: String
    let thumbprint: String

    static func loadOrCreate() throws -> Self {
        if let raw = GenericPasswordKeychainStore.loadString(service: self.service, account: self.account),
           let data = raw.data(using: .utf8),
           let stored = try? JSONDecoder().decode(StoredKey.self, from: data),
           let representation = Data(base64Encoded: stored.representation)
        {
            if stored.kind == "secureEnclave",
               let key = try? SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: representation)
            {
                return try Self(backing: .secureEnclave(key))
            }
            if stored.kind == "software",
               let key = try? P256.Signing.PrivateKey(rawRepresentation: representation)
            {
                return try Self(backing: .software(key))
            }
        }

        let backing: Backing
        let stored: StoredKey
        if SecureEnclave.isAvailable {
            let key = try SecureEnclave.P256.Signing.PrivateKey()
            backing = .secureEnclave(key)
            stored = StoredKey(
                kind: "secureEnclave",
                representation: key.dataRepresentation.base64EncodedString())
        } else {
            #if targetEnvironment(simulator)
            let key = P256.Signing.PrivateKey()
            backing = .software(key)
            stored = StoredKey(kind: "software", representation: key.rawRepresentation.base64EncodedString())
            #else
            throw FamilyInviteKeyError.secureEnclaveUnavailable
            #endif
        }
        let encoded = try JSONEncoder().encode(stored)
        guard let value = String(data: encoded, encoding: .utf8) else { throw FamilyInviteKeyError.storage }
        switch GenericPasswordKeychainStore.saveStringResult(
            value,
            service: self.service,
            account: self.account,
            accessible: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly)
        {
        case .success:
            return try Self(backing: backing)
        case .failure:
            throw FamilyInviteKeyError.storage
        }
    }

    static func softwareForTesting() throws -> Self {
        try Self(backing: .software(P256.Signing.PrivateKey()))
    }

    private init(backing: Backing) throws {
        self.backing = backing
        let publicBytes: Data = switch backing {
        case let .secureEnclave(key): key.publicKey.x963Representation
        case let .software(key): key.publicKey.x963Representation
        }
        guard publicBytes.count == 65, publicBytes.first == 4 else { throw FamilyInviteKeyError.invalidPublicKey }
        let x = Data(publicBytes[1..<33]).familyInviteBase64URL
        let y = Data(publicBytes[33..<65]).familyInviteBase64URL
        let jwk = #"{"crv":"P-256","kty":"EC","x":"\#(x)","y":"\#(y)"}"#
        self.canonicalPublicJWK = jwk
        self.thumbprint = Data(SHA256.hash(data: Data(jwk.utf8))).familyInviteBase64URL
    }

    func signature(for data: Data) throws -> String {
        let raw: Data = switch self.backing {
        case let .secureEnclave(key): try key.signature(for: data).rawRepresentation
        case let .software(key): try key.signature(for: data).rawRepresentation
        }
        return raw.familyInviteBase64URL
    }
}

enum FamilyInviteKeyError: Error {
    case invalidPublicKey
    case secureEnclaveUnavailable
    case storage
}

extension Data {
    fileprivate var familyInviteBase64URL: String {
        self.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
