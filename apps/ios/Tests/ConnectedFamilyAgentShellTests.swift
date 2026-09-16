import Foundation
import Testing
@testable import OpenClaw

struct ConnectedFamilyAgentShellTests {
    @Test func `family product build flag defaults closed`() {
        #expect(!FamilyProductBuildConfig.isEnabled(value: nil))
        #expect(!FamilyProductBuildConfig.isEnabled(value: "NO"))
        #expect(FamilyProductBuildConfig.isEnabled(value: "YES"))
        #expect(FamilyProductBuildConfig.isEnabled(value: true))
    }

    @Test func `fixture selects a deterministic connected family tab`() {
        let arguments = [
            "OpenClaw",
            ConnectedFamilyAgentShellFixture.argument,
            ConnectedFamilyAgentShellFixture.initialTabArgument,
            "goals",
        ]

        #expect(ConnectedFamilyAgentShellFixture.isEnabled(arguments: arguments))
        #expect(ConnectedFamilyAgentShellFixture.initialTab(arguments: arguments) == .goals)
        #expect(ConnectedFamilyAgentShellFixture.initialTab(arguments: ["OpenClaw"]) == .chat)
    }

    @Test func `family shell owns exactly five user destinations and reuses native chat`() throws {
        #expect(ConnectedFamilyAgentTab.allCases == [.chat, .feed, .ideas, .goals, .library])

        let source = try Self.source("Sources/ConnectedFamilyAgentShell.swift")
        #expect(source.contains("ChatProTab("))
        #expect(source.contains("accessibilityIdentifier: \"FamilyAgent.Chats\""))
        #expect(source.contains("openSettings: nil"))
        #expect(source.contains("familyPresentation: true"))
        #expect(source.contains("contentBottomInset: self.isKeyboardVisible ? 0 : Self.tabBarReservedHeight"))
        let chatViewSource = try Self.source("../shared/OpenClawKit/Sources/OpenClawChatUI/ChatView.swift")
        #expect(chatViewSource.contains("ChatThreeDotTypingIndicatorBubble"))
        #expect(source.contains("FamilyReconnectIndicator"))
        #expect(source.contains("accessibilityLabel(\"Reconnecting\")"))
        #expect(source.contains("domainSurface(tab: .feed, kind: .feedItem)"))
        #expect(source.contains("domainSurface(tab: .ideas, kind: .idea)"))
        #expect(source.contains("domainSurface(tab: .goals, kind: .goal)"))
        #expect(source.contains("domainSurface(tab: .library, kind: .libraryItem)"))
        #expect(source.contains("FamilyDomainRecordCard"))
        #expect(!source.contains("Family does not save a separate feed"))
        #expect(!source.contains("SettingsProTab("))
        #expect(!source.contains("RootSidebar("))
        #expect(!source.contains("AgentProTab("))
    }

    @Test func `family domain loads only for a verified assignment`() throws {
        let source = try Self.source("Sources/Model/NodeAppModel+FamilyDomain.swift")

        #expect(source.contains("guard self.isConnectedFamilyAgentLocked"))
        #expect(source.contains("method: \"family.bootstrap\""))
        #expect(source.contains("familyDomainCapabilities = result.capabilities"))
        #expect(source.contains("filter { $0.deletedatms == nil }"))
    }

    @Test func `family domain interactions preserve gateway authority`() throws {
        let modelSource = try Self.source("Sources/Model/NodeAppModel+FamilyDomain.swift")
        let shellSource = try Self.source("Sources/ConnectedFamilyAgentShell.swift")

        #expect(modelSource.contains("guard self.isConnectedFamilyAgentLocked"))
        #expect(modelSource.contains("expectedRevision"))
        #expect(modelSource.contains("idempotencyKey"))
        #expect(modelSource.contains("family.actions.mutate"))
        #expect(shellSource.contains("Discuss in Main Chat"))
        #expect(shellSource.contains("Accept goal"))
        #expect(shellSource.contains("Confirm complete"))
        #expect(shellSource.contains("Delete from Library"))
        #expect(shellSource.contains("FamilyActionCenterSheet"))
        #expect(shellSource.contains("includeDerivedTitles: true"))
        #expect(shellSource.contains("New side chat"))
        #expect(!shellSource.contains("TextField(\"Topic\""))
        #expect(!shellSource.contains("selectedAgentId ="))
    }

    @Test func `family product never exposes the OpenClaw admin shell`() throws {
        let source = try Self.source("Sources/RootTabs.swift")
        let familyRoot = try Self.extract(
            source,
            from: "private var familyProductContent",
            to: "private var openClawProductContent")

        #expect(familyRoot.contains("case .locked, .reconnecting"))
        #expect(familyRoot.contains("ConnectedFamilyAgentShell()"))
        #expect(familyRoot.contains("FamilyProductWelcomeView(connectionError:"))
        #expect(familyRoot.contains("ConnectedFamilyAgentAccessGate"))
        #expect(!familyRoot.contains("sidebarSplitContent"))
        #expect(!familyRoot.contains("SettingsProTab"))
        #expect(!familyRoot.contains("RootSidebar"))
    }

    @Test func `family invite handoff connects without routing through settings`() throws {
        let source = try Self.source("Sources/RootTabs.swift")
        let handoff = try Self.extract(
            source,
            from: "private func maybeOpenSettingsForGatewaySetup",
            to: "private func handleGatewaySetupRequest")
        let connection = try Self.extract(
            source,
            from: "private func connectFamilyProduct",
            to: "private func maybeRequestLocalNetworkAccess")

        #expect(handoff.contains("FamilyProductBuildConfig.isEnabled"))
        #expect(handoff.contains("connectFamilyProduct(using: link)"))
        #expect(connection.contains("GatewayOnboardingReset.prepareForBootstrapPairing"))
        #expect(connection.contains("gatewayController.connectManual"))
        #expect(connection.contains("GatewaySettingsStore.saveGatewayCredentials"))
        #expect(!connection.contains("SettingsProTab"))
        #expect(!connection.contains("selectSidebarDestination"))
    }

    @Test func `family product rejects ordinary OpenClaw deep links`() throws {
        let source = try Self.source("Sources/OpenClawApp.swift")
        let handler = try Self.extract(
            source,
            from: "func handleOpenURL",
            to: "private static func isSupportedOpenURL")

        #expect(handler.contains("handleFamilyInviteDeepLink"))
        #expect(handler.contains("guard !FamilyProductBuildConfig.isEnabled else { return }"))
        #expect(try #require(handler.range(of: "handleFamilyInviteDeepLink")?.lowerBound) <
            handler.range(of: "guard !FamilyProductBuildConfig.isEnabled")!.lowerBound)
    }

    @Test func `family product suppresses OpenClaw approval and settings presentation`() throws {
        let source = try Self.source("Sources/RootTabs.swift")
        let presentation = try Self.extract(
            source,
            from: "private func rootPresentation",
            to: "private func updateIdleTimer")
        let notifications = try Self.extract(
            source,
            from: "private func openNotificationSettings",
            to: "private func suppressExecApprovalPromptForNotificationSettings")
        let gatewayProblem = try Self.extract(
            source,
            from: "private func gatewayProblemPrimaryActionTitle",
            to: "private func evaluateOnboardingPresentation")

        #expect(presentation.contains("if FamilyProductBuildConfig.isEnabled"))
        #expect(presentation.contains("execApprovalPromptDialog"))
        #expect(presentation.contains("notificationPermissionGuidanceDialog"))
        #expect(notifications.contains("guard !FamilyProductBuildConfig.isEnabled else { return }"))
        #expect(gatewayProblem.contains("if FamilyProductBuildConfig.isEnabled"))
        #expect(gatewayProblem.contains("problem.retryable ? String(localized: \"Retry\") : nil"))
        #expect(gatewayProblem.contains("guard problem.retryable else { return }"))
    }

    @Test func `family shell uses a floating liquid glass tab bar with a material fallback`() throws {
        let source = try Self.source("Sources/ConnectedFamilyAgentShell.swift")

        #expect(source.contains(".overlay(alignment: .bottom)"))
        #expect(source.contains("if !self.isKeyboardVisible"))
        #expect(source.contains("UIResponder.keyboardWillShowNotification"))
        #expect(source.contains("OpenClawGlassControlGroup"))
        #expect(source.contains(".glassEffect(.regular.interactive(), in: .capsule)"))
        #expect(source.contains(".background(.ultraThinMaterial, in: Capsule())"))
        #expect(source.contains(".matchedGeometryEffect(id: \"FamilyAgent.Tab.Selection\""))
        #expect(source.contains(".accessibilityAddTraits(self.selectedTab == tab ? .isSelected : [])"))
        #expect(!source.contains("Text(tab.title)"))
        #expect(!source.contains("Divider()\n            self.tabBar"))
        #expect(!source.contains(".background(.bar)"))
    }

    @Test func `unverified access is gated before the admin shell`() throws {
        let source = try Self.source("Sources/RootTabs.swift")
        let rootContent = try Self.extract(
            source,
            from: "private var rootContent",
            to: "private var uiTestReadinessMarker")

        #expect(rootContent.contains("case .locked, .reconnecting:"))
        #expect(rootContent.contains("ConnectedFamilyAgentShell()"))
        #expect(rootContent.contains("case .verifying, .blocked, .unrestricted:"))
        #expect(rootContent.contains("ConnectedFamilyAgentAccessGate"))
        #expect(rootContent.contains("case .disconnected, .unrestricted:"))
        #expect(rootContent.contains("self.sidebarSplitContent"))
        #expect(!rootContent.contains("ChatProTab("))
    }

    @Test func `watch replay revalidates current family assignment before sending`() throws {
        let source = try Self.source("Sources/Model/WatchReplyCoordinator.swift")

        #expect(source.contains("familyAgentState.lockedAgentID"))
        #expect(source.contains("lockedAgentId: lockedAgentID"))
        #expect(source.contains("self.familyAgentState() == familyAgentState"))
        #expect(source.contains("caseInsensitiveCompare(command.context.agentId)"))
        #expect(source.contains("The assigned agent changed"))
        #expect(source.contains("releaseNotDispatched(claim)"))
    }

    @Test func `agent roster is loaded before required self assignment is admitted`() throws {
        let source = try Self.source("Sources/Model/NodeAppModel.swift")
        let refresh = try Self.extract(
            source,
            from: "private func refreshAgentsFromGateway",
            to: "func refreshGatewayOverviewIfConnected")
        let roster = try #require(refresh.range(of: "decode(AgentsListResult.self"))
        let usersSelf = try #require(refresh.range(of: "method: \"users.self\""))
        let assignment = try #require(refresh.range(of: "applyConnectedFamilyAgentState(familyState)"))

        #expect(roster.lowerBound < usersSelf.lowerBound)
        #expect(usersSelf.lowerBound < assignment.lowerBound)
        #expect(source.contains("container.contains(.assignedAgentID)"))
        #expect(source.contains(
            "let routedSessionKey = self.isConnectedFamilyAgentLocked ? self.mainSessionKey : sessionKey"))
    }

    private static func source(_ path: String) throws -> String {
        try String(contentsOf: self.iOSRoot.appendingPathComponent(path), encoding: .utf8)
    }

    private static var iOSRoot: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
    }

    private static func extract(_ source: String, from start: String, to end: String) throws -> String {
        let startRange = try #require(source.range(of: start))
        let tail = source[startRange.lowerBound...]
        let endRange = try #require(tail.range(of: end))
        return String(tail[..<endRange.lowerBound])
    }
}
