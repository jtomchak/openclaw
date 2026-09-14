import Foundation
import Testing
@testable import OpenClaw

struct ConnectedFamilyAgentShellTests {
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
        #expect(source.contains("ChatProTab(openSettings: nil)"))
        #expect(source.contains("requestFamilyAgentChat(prompt: prompt)"))
        #expect(source.contains("OpenClaw does not save a separate feed"))
        #expect(!source.contains("SettingsProTab("))
        #expect(!source.contains("RootSidebar("))
        #expect(!source.contains("AgentProTab("))
    }

    @Test func `unverified access is gated before the admin shell`() throws {
        let source = try Self.source("Sources/RootTabs.swift")
        let rootContent = try Self.extract(
            source,
            from: "private var rootContent",
            to: "private var uiTestReadinessMarker")

        #expect(rootContent.contains("case .locked:"))
        #expect(rootContent.contains("ConnectedFamilyAgentShell()"))
        #expect(rootContent.contains("case .verifying, .blocked:"))
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
