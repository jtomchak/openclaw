import Foundation
import SwiftUI

enum ConnectedFamilyAgentTab: String, CaseIterable, Identifiable {
    case chat
    case feed
    case ideas
    case goals
    case library

    var id: String {
        rawValue
    }

    var title: String {
        switch self {
        case .chat: String(localized: "Chat")
        case .feed: String(localized: "Feed")
        case .ideas: String(localized: "Ideas")
        case .goals: String(localized: "Goals")
        case .library: String(localized: "Library")
        }
    }

    var accessibilityLabel: String {
        self == .library ? String(localized: "Library and Artifacts") : self.title
    }

    var symbol: String {
        switch self {
        case .chat: "bubble.left.and.bubble.right.fill"
        case .feed: "rectangle.stack.fill"
        case .ideas: "lightbulb.fill"
        case .goals: "scope"
        case .library: "books.vertical.fill"
        }
    }
}

enum ConnectedFamilyAgentShellFixture {
    static let argument = "--openclaw-connected-family-agent-screenshot-mode"
    static let initialTabArgument = "--openclaw-connected-family-agent-tab"

    static func isEnabled(arguments: [String]) -> Bool {
        #if DEBUG
        arguments.contains(self.argument)
        #else
        false
        #endif
    }

    static func initialTab(arguments: [String]) -> ConnectedFamilyAgentTab {
        guard let flagIndex = arguments.firstIndex(of: initialTabArgument) else { return .chat }
        let valueIndex = arguments.index(after: flagIndex)
        guard arguments.indices.contains(valueIndex) else { return .chat }
        return ConnectedFamilyAgentTab(
            rawValue: arguments[valueIndex].trimmingCharacters(in: .whitespacesAndNewlines).lowercased()) ?? .chat
    }
}

struct ConnectedFamilyAgentShell: View {
    @Environment(NodeAppModel.self) private var appModel
    @State private var selectedTab: ConnectedFamilyAgentTab

    init(arguments: [String] = ProcessInfo.processInfo.arguments) {
        _selectedTab = State(initialValue: ConnectedFamilyAgentShellFixture.initialTab(arguments: arguments))
    }

    var body: some View {
        VStack(spacing: 0) {
            self.selectedContent
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            Divider()
            self.tabBar
        }
        .background(OpenClawProBackground())
        .accessibilityIdentifier("FamilyAgent.Shell")
    }

    @ViewBuilder
    private var selectedContent: some View {
        switch self.selectedTab {
        case .chat:
            NavigationStack {
                ChatProTab(openSettings: nil)
            }
        case .feed:
            self.starterSurface(
                title: "Feed",
                subtitle: "Catch up with what matters through a conversation with your agent.",
                symbol: "rectangle.stack.fill",
                cards: [
                    .init(
                        title: "Today’s update",
                        detail: "Ask for a concise summary of recent work and anything that needs your attention.",
                        prompt: "Give me a concise update on our recent work and anything that needs my attention."),
                    .init(
                        title: "Pick up where we left off",
                        detail: "Open a chat about the most useful next step.",
                        prompt: "Help me pick up where we left off and choose the most useful next step."),
                ])
        case .ideas:
            self.starterSurface(
                title: "Ideas",
                subtitle: "Turn a thought into a conversation, outline, or next experiment.",
                symbol: "lightbulb.fill",
                cards: [
                    .init(
                        title: "Explore an idea",
                        detail: "Develop a rough thought without pretending it has been saved elsewhere.",
                        prompt: "Help me explore a new idea. Start by asking what I have in mind."),
                    .init(
                        title: "Make it actionable",
                        detail: "Turn an idea into a small, realistic first step.",
                        prompt: "Help me turn one of my ideas into a small, realistic first step."),
                ])
        case .goals:
            self.starterSurface(
                title: "Goals",
                subtitle: "Use chat to clarify a goal and decide what to do next.",
                symbol: "scope",
                cards: [
                    .init(
                        title: "Shape a goal",
                        detail: "Describe the outcome, constraints, and a practical milestone.",
                        prompt: "Help me shape a goal by clarifying the outcome, constraints, and first milestone."),
                    .init(
                        title: "Plan this week",
                        detail: "Choose a manageable step for the next seven days.",
                        prompt: "Help me choose a manageable step toward my goal for the next seven days."),
                ])
        case .library:
            self.starterSurface(
                title: "Library & Artifacts",
                subtitle: "Ask your agent to find or create something in chat.",
                symbol: "books.vertical.fill",
                cards: [
                    .init(
                        title: "Find something",
                        detail: "Ask what is available in this agent’s workspace and connected tools.",
                        prompt: "Help me find a useful document or artifact related to what we have been working on."),
                    .init(
                        title: "Create an artifact",
                        detail: "Start a chat to draft a useful document, list, or plan.",
                        prompt: "Help me create a useful artifact. Ask what format and outcome I need."),
                ])
        }
    }

    private var tabBar: some View {
        HStack(spacing: 2) {
            ForEach(ConnectedFamilyAgentTab.allCases) { tab in
                Button {
                    self.selectedTab = tab
                } label: {
                    VStack(spacing: 4) {
                        Image(systemName: tab.symbol)
                            .font(.system(size: 17, weight: .semibold))
                            .accessibilityHidden(true)
                        Text(tab.title)
                            .font(OpenClawType.caption2Medium)
                            .lineLimit(1)
                            .minimumScaleFactor(0.72)
                    }
                    .foregroundStyle(self.selectedTab == tab ? OpenClawBrand.accent : .secondary)
                    .frame(maxWidth: .infinity, minHeight: 50)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(tab.accessibilityLabel)
                .accessibilityValue(self.selectedTab == tab ? "Selected" : "")
                .accessibilityIdentifier("FamilyAgent.Tab.\(tab.rawValue.capitalized)")
            }
        }
        .padding(.horizontal, 6)
        .padding(.top, 4)
        .safeAreaPadding(.bottom, 4)
        .background(.bar)
    }

    private func starterSurface(
        title: LocalizedStringKey,
        subtitle: LocalizedStringKey,
        symbol: String,
        cards: [FamilyAgentStarterCard]) -> some View
    {
        NavigationStack {
            ScrollView {
                LazyVStack(spacing: 14) {
                    ForEach(cards) { card in
                        Button {
                            self.openChat(prompt: card.prompt)
                        } label: {
                            ProCard(padding: 16) {
                                HStack(alignment: .top, spacing: 12) {
                                    Image(systemName: "arrow.up.right.bubble.fill")
                                        .font(.system(size: 20, weight: .semibold))
                                        .foregroundStyle(OpenClawBrand.accent)
                                        .accessibilityHidden(true)
                                    VStack(alignment: .leading, spacing: 5) {
                                        Text(card.title)
                                            .font(OpenClawType.headline)
                                            .foregroundStyle(.primary)
                                        Text(card.detail)
                                            .font(OpenClawType.subhead)
                                            .foregroundStyle(.secondary)
                                            .multilineTextAlignment(.leading)
                                        Text("Open chat")
                                            .font(OpenClawType.captionSemiBold)
                                            .foregroundStyle(OpenClawBrand.accent)
                                            .lineLimit(1)
                                            .minimumScaleFactor(0.75)
                                            .fixedSize(horizontal: true, vertical: false)
                                    }
                                    Spacer(minLength: 0)
                                }
                            }
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("FamilyAgent.\(self.selectedTab.rawValue).\(card.id)")
                    }

                    Text(
                        """
                        These are chat starters. OpenClaw does not save a separate feed, ideas list, goals list, or \
                        artifact library here yet.
                        """)
                        .font(OpenClawType.caption)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.leading)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 4)
                }
                .padding(.horizontal, OpenClawProMetric.pagePadding)
                .padding(.vertical, 14)
                .padding(.bottom, OpenClawProMetric.bottomScrollInset)
            }
            .background(OpenClawProBackground())
            .navigationTitle("")
            .toolbar {
                ToolbarItem(placement: .principal) {
                    self.agentHeader(title: title, subtitle: subtitle, symbol: symbol)
                }
            }
        }
    }

    private func agentHeader(
        title: LocalizedStringKey,
        subtitle _: LocalizedStringKey,
        symbol _: String) -> some View
    {
        HStack(spacing: 9) {
            Text(self.agentBadge)
                .font(OpenClawType.avatar(size: self.agentBadge.count > 2 ? 11 : 15))
                .foregroundStyle(.white)
                .frame(width: 30, height: 30)
                .background(OpenClawBrand.accent, in: Circle())
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 0) {
                Text(self.agentName)
                    .font(OpenClawType.subheadSemiBold)
                    .lineLimit(1)
                Text(title)
                    .font(OpenClawType.caption2Medium)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(Text(verbatim: "\(self.agentName), ") + Text(title))
        .accessibilityIdentifier("FamilyAgent.Header")
    }

    private var agentName: String {
        self.appModel.chatAgentName
    }

    private var agentBadge: String {
        AgentIdentityPresentation.badge(
            avatarText: self.appModel.chatAgentAvatarText,
            displayName: self.agentName)
    }

    private func openChat(prompt: String) {
        self.appModel.requestFamilyAgentChat(prompt: prompt)
        self.selectedTab = .chat
    }
}

private struct FamilyAgentStarterCard: Identifiable {
    let title: LocalizedStringKey
    let detail: LocalizedStringKey
    let prompt: String

    var id: String {
        self.prompt
    }
}

struct ConnectedFamilyAgentAccessGate: View {
    let state: NodeAppModel.ConnectedFamilyAgentState

    var body: some View {
        ContentUnavailableView {
            Label {
                Text(self.title)
                    .font(OpenClawType.title3SemiBold)
            } icon: {
                Image(systemName: "lock.shield.fill")
                    .font(.system(size: 28, weight: .semibold))
            }
        } description: {
            Text(self.detail)
                .font(OpenClawType.body)
        }
        .accessibilityIdentifier("FamilyAgent.AccessGate")
    }

    private var title: LocalizedStringKey {
        self.state == .verifying ? "Checking agent access" : "Agent access unavailable"
    }

    private var detail: LocalizedStringKey {
        self.state == .verifying
            ? "OpenClaw is verifying the agent assigned to this profile."
            : """
            OpenClaw could not verify that the assigned agent is in the selectable agent roster. Reconnect or ask \
            the Gateway owner for help.
            """
    }
}
