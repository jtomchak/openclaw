import Foundation
import Testing
@testable import OpenClaw

struct FamilyAgentDraftScreenTests {
    @Test func `draft maps parent route choices into the approved blueprint`() {
        var draft = FamilyAgentDraft()
        draft.displayName = "Juniper"
        draft.setRoute(.ollamaCloud, allowed: false)

        let blueprint = draft.blueprint(ownerProfileID: "profile-parent")

        #expect(blueprint.ownership.profileID == "profile-parent")
        #expect(blueprint.inferencePolicy.allowedRoutes == [.codex])
        #expect(blueprint.inferencePolicy.isParentManaged)
        #expect(blueprint.storage.agentDirectory == .dedicated)
        #expect(blueprint.storage.workspace == .dedicated)
        #expect(blueprint.access.crossAgentTools == .disabled)
        #expect(blueprint.access.sessionVisibility == .sameAgent)
        #expect(blueprint.capabilities.credentialMaterialAccess == .gatewayOnly)
        #expect(blueprint.isValid)
    }

    @Test func `prepare invite remains a local ready state`() {
        var draft = FamilyAgentDraft()

        draft.prepareInvite(ownerProfileID: "profile-parent")

        #expect(draft.preparationState == .ready)
    }

    @Test func `prepare invite rejects empty names and inference routes`() {
        var unnamed = FamilyAgentDraft()
        unnamed.displayName = "  "
        unnamed.prepareInvite(ownerProfileID: "profile-parent")
        guard case .invalid = unnamed.preparationState else {
            Issue.record("Expected empty display name validation")
            return
        }

        var routeless = FamilyAgentDraft()
        routeless.setRoute(.codex, allowed: false)
        routeless.setRoute(.ollamaCloud, allowed: false)
        routeless.prepareInvite(ownerProfileID: "profile-parent")
        guard case .invalid = routeless.preparationState else {
            Issue.record("Expected inference route validation")
            return
        }
        #expect(!routeless.blueprint(ownerProfileID: "profile-parent").isValid)
    }

    @Test func `screenshot argument opens the family agent settings route`() {
        let arguments = ["OpenClaw", FamilyAgentScreenshotMode.argument]

        #expect(RootTabs.initialDestination(arguments: arguments) == .settings)
        #expect(RootTabs.initialSettingsPath(arguments: arguments) == [.familyAgents])
    }

    @Test func `family agent screen stays local only`() throws {
        let source = try String(contentsOf: Self.screenSourceURL, encoding: .utf8)

        #expect(source.contains("blueprint.isValid"))
        #expect(source.contains("Gateway provisioning is not connected yet"))
        #expect(!source.contains("GatewayConnectionController"))
        #expect(!source.contains("GatewaySettingsStore"))
        #expect(!source.contains("saveGatewayCredentials"))
    }

    private static var screenSourceURL: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/Settings/FamilyAgentDraftScreen.swift")
    }
}
