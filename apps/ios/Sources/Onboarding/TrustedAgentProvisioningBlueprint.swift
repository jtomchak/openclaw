import Foundation

/// A client-side description of the security properties an invite flow must provision.
///
/// The blueprint contains policy and identifiers only. Connector and model credentials remain
/// owned by the Gateway and are never represented by this type.
struct TrustedAgentProvisioningBlueprint: Codable, Equatable, Sendable {
    enum IsolationLevel: String, Codable, Sendable {
        /// Separate agent state inside one trusted Gateway boundary.
        case sharedGatewayAgentBoundary

        /// Administrator and OS-level separation on a dedicated Gateway or host.
        case dedicatedGatewayHost
    }

    enum ResourceScope: String, Codable, Sendable {
        case dedicated
        case shared
    }

    enum CrossAgentTools: String, Codable, Sendable {
        case disabled
        case enabled
    }

    enum SessionVisibility: String, Codable, Sendable {
        case sameAgent
        case gatewayWide
    }

    enum AuthorizationOwnership: String, Codable, Sendable {
        case trustedPerson
        case gatewayAdministrator
    }

    enum CredentialMaterialAccess: String, Codable, Sendable {
        case gatewayOnly
        case clientReadable
    }

    enum InferenceRoute: String, Codable, CaseIterable, Sendable {
        case codex
        case ollamaCloud
    }

    enum ValidationIssue: String, CaseIterable, Codable, Hashable, Sendable {
        case missingOwnerProfileID
        case agentDirectoryMustBeDedicated
        case workspaceMustBeDedicated
        case crossAgentToolsMustBeDisabled
        case sessionVisibilityMustBeSameAgent
        case connectorAuthorizationMustBePersonal
        case modelAuthorizationMustBePersonal
        case inferenceRoutesMustBeAllowed
        case credentialMaterialMustRemainOnGateway
    }

    struct Ownership: Codable, Equatable, Sendable {
        var profileID: String
    }

    struct Storage: Codable, Equatable, Sendable {
        var agentDirectory: ResourceScope
        var workspace: ResourceScope
    }

    struct Access: Codable, Equatable, Sendable {
        var crossAgentTools: CrossAgentTools
        var sessionVisibility: SessionVisibility
    }

    struct Capabilities: Codable, Equatable, Sendable {
        var connectorAuthorization: AuthorizationOwnership
        var modelAuthorization: AuthorizationOwnership
        var credentialMaterialAccess: CredentialMaterialAccess
    }

    struct InferencePolicy: Codable, Equatable, Sendable {
        var allowedRoutes: [InferenceRoute]
        var isParentManaged: Bool
    }

    var ownership: Ownership
    var isolationLevel: IsolationLevel
    var storage: Storage
    var access: Access
    var capabilities: Capabilities
    var inferencePolicy: InferencePolicy

    init(
        ownerProfileID: String,
        isolationLevel: IsolationLevel = .sharedGatewayAgentBoundary,
        storage: Storage = .init(agentDirectory: .dedicated, workspace: .dedicated),
        access: Access = .init(crossAgentTools: .disabled, sessionVisibility: .sameAgent),
        capabilities: Capabilities = .init(
            connectorAuthorization: .trustedPerson,
            modelAuthorization: .trustedPerson,
            credentialMaterialAccess: .gatewayOnly,
        ),
        inferencePolicy: InferencePolicy = .init(
            allowedRoutes: [.codex, .ollamaCloud],
            isParentManaged: true,
        ),
    ) {
        ownership = Ownership(profileID: ownerProfileID)
        self.isolationLevel = isolationLevel
        self.storage = storage
        self.access = access
        self.capabilities = capabilities
        self.inferencePolicy = inferencePolicy
    }

    var validationIssues: [ValidationIssue] {
        var issues: [ValidationIssue] = []

        if ownership.profileID.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            issues.append(.missingOwnerProfileID)
        }
        if storage.agentDirectory != .dedicated {
            issues.append(.agentDirectoryMustBeDedicated)
        }
        if storage.workspace != .dedicated {
            issues.append(.workspaceMustBeDedicated)
        }
        if access.crossAgentTools != .disabled {
            issues.append(.crossAgentToolsMustBeDisabled)
        }
        if access.sessionVisibility != .sameAgent {
            issues.append(.sessionVisibilityMustBeSameAgent)
        }
        if capabilities.connectorAuthorization != .trustedPerson {
            issues.append(.connectorAuthorizationMustBePersonal)
        }
        if capabilities.modelAuthorization != .trustedPerson {
            issues.append(.modelAuthorizationMustBePersonal)
        }
        let allowedRoutes = Set(inferencePolicy.allowedRoutes)
        if !inferencePolicy.isParentManaged ||
            allowedRoutes.isEmpty ||
            allowedRoutes.count != inferencePolicy.allowedRoutes.count
        {
            issues.append(.inferenceRoutesMustBeAllowed)
        }
        if capabilities.credentialMaterialAccess != .gatewayOnly {
            issues.append(.credentialMaterialMustRemainOnGateway)
        }

        return issues
    }

    var isValid: Bool {
        validationIssues.isEmpty
    }
}
