import Foundation
@testable import OpenClaw
import Testing

struct TrustedAgentProvisioningBlueprintTests {
    @Test func `personal blueprint defaults to the safe shared Gateway policy`() {
        let blueprint = TrustedAgentProvisioningBlueprint(ownerProfileID: "profile-ada")

        #expect(blueprint.ownership.profileID == "profile-ada")
        #expect(blueprint.isolationLevel == .sharedGatewayAgentBoundary)
        #expect(blueprint.storage.agentDirectory == .dedicated)
        #expect(blueprint.storage.workspace == .dedicated)
        #expect(blueprint.access.crossAgentTools == .disabled)
        #expect(blueprint.access.sessionVisibility == .sameAgent)
        #expect(blueprint.capabilities.connectorAuthorization == .trustedPerson)
        #expect(blueprint.capabilities.modelAuthorization == .trustedPerson)
        #expect(blueprint.capabilities.credentialMaterialAccess == .gatewayOnly)
        #expect(blueprint.inferencePolicy.allowedRoutes == [.codex, .ollamaCloud])
        #expect(blueprint.inferencePolicy.isParentManaged)
        #expect(blueprint.isValid)
    }

    @Test func `strict isolation is represented only by a dedicated Gateway host`() {
        let blueprint = TrustedAgentProvisioningBlueprint(
            ownerProfileID: "profile-ada",
            isolationLevel: .dedicatedGatewayHost,
        )

        #expect(blueprint.isolationLevel == .dedicatedGatewayHost)
        #expect(blueprint.isValid)
    }

    @Test func `validation rejects missing ownership and unsafe sharing`() {
        let blueprint = TrustedAgentProvisioningBlueprint(
            ownerProfileID: "  ",
            storage: .init(agentDirectory: .shared, workspace: .shared),
            access: .init(crossAgentTools: .enabled, sessionVisibility: .gatewayWide),
            capabilities: .init(
                connectorAuthorization: .gatewayAdministrator,
                modelAuthorization: .gatewayAdministrator,
                credentialMaterialAccess: .clientReadable,
            ),
            inferencePolicy: .init(allowedRoutes: [], isParentManaged: false),
        )

        #expect(
            Set(blueprint.validationIssues) ==
                Set(TrustedAgentProvisioningBlueprint.ValidationIssue.allCases),
        )
        #expect(!blueprint.isValid)
    }

    @Test func `blueprint round trips without credential material`() throws {
        let blueprint = TrustedAgentProvisioningBlueprint(
            ownerProfileID: "profile-grace",
            isolationLevel: .dedicatedGatewayHost,
        )

        let data = try JSONEncoder().encode(blueprint)
        let decoded = try JSONDecoder().decode(TrustedAgentProvisioningBlueprint.self, from: data)
        let object = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])

        #expect(decoded == blueprint)
        #expect(object["capabilities"] != nil)
        #expect(object.keys.allSatisfy { !$0.localizedCaseInsensitiveContains("secret") })
    }
}
