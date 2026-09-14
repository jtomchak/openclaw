import Foundation
import Observation
import OpenClawKit

enum FamilyInviteBuildConfig {
    static var relayHost: String {
        (Bundle.main.object(forInfoDictionaryKey: "OpenClawFamilyRelayHost") as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased() ?? "family-relay.example.invalid"
    }
}

@MainActor
@Observable
final class FamilyInviteEnrollmentCoordinator {
    static let screenshotArgument = "--openclaw-family-invite-screenshot-mode"

    enum State: Equatable {
        case idle
        case validating
        case preparingDevice
        case redeeming
        case requestingEdgeAccess
        case handingOff
        case complete
        case failed
    }

    private(set) var state: State = .idle
    private(set) var isPresented = false
    private let client: FamilyInviteRelayClient
    private let keyProvider: @Sendable () throws -> any FamilyInviteSigningKey
    private var generation: UInt64 = 0

    init(
        client: FamilyInviteRelayClient = FamilyInviteRelayClient(),
        keyProvider: @escaping @Sendable () throws -> any FamilyInviteSigningKey = {
            try FamilyInviteDeviceKey.loadOrCreate()
        })
    {
        self.client = client
        self.keyProvider = keyProvider
    }

    func enroll(_ invite: FamilyInviteDeepLink) async -> GatewayConnectDeepLink? {
        self.generation &+= 1
        let generation = self.generation
        self.isPresented = true
        self.state = .validating
        await Task.yield()
        guard generation == self.generation else { return nil }
        do {
            self.state = .preparingDevice
            let key = try self.keyProvider()
            guard generation == self.generation else { return nil }
            self.state = .redeeming
            let result = try await self.client.enroll(invite: invite, key: key)
            guard generation == self.generation else { return nil }
            self.state = .requestingEdgeAccess
            guard FamilyInviteEdgeCredentials.save(
                inviteId: result.inviteId,
                edgeToken: result.edgeToken,
                expiresAtMs: result.edgeExpiresAtMs,
                gatewayURL: result.gatewayURL)
            else { throw FamilyInviteKeyError.storage }
            self.state = .handingOff
            return result.setupLink
        } catch {
            guard generation == self.generation else { return nil }
            self.state = .failed
            return nil
        }
    }

    func markHandoffComplete() {
        self.state = .complete
    }

    func dismiss() {
        guard self.state == .complete || self.state == .failed else { return }
        self.isPresented = false
        self.state = .idle
    }

    #if DEBUG
    func presentScreenshotFixture() {
        self.isPresented = true
        self.state = .preparingDevice
    }
    #endif
}
