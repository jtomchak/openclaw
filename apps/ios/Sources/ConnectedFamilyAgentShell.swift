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
    @Namespace private var tabSelectionNamespace

    init(arguments: [String] = ProcessInfo.processInfo.arguments) {
        _selectedTab = State(initialValue: ConnectedFamilyAgentShellFixture.initialTab(arguments: arguments))
    }

    var body: some View {
        self.selectedContent
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .safeAreaInset(edge: .bottom, spacing: 0) {
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
        OpenClawGlassControlGroup {
            HStack(spacing: 3) {
                ForEach(ConnectedFamilyAgentTab.allCases) { tab in
                    self.tabButton(tab)
                }
            }
            .padding(5)
            .modifier(FamilyAgentTabBarSurface())
        }
        .padding(.horizontal, 12)
        .padding(.top, 8)
        .padding(.bottom, 6)
    }

    private func tabButton(_ tab: ConnectedFamilyAgentTab) -> some View {
        Button {
            withAnimation(.snappy(duration: 0.3, extraBounce: 0.05)) {
                self.selectedTab = tab
            }
        } label: {
            VStack(spacing: 3) {
                Image(systemName: tab.symbol)
                    .font(.system(size: 17, weight: .semibold))
                    .symbolEffect(.bounce, value: self.selectedTab == tab)
                    .accessibilityHidden(true)
                Text(tab.title)
                    .font(OpenClawType.caption2Medium)
                    .lineLimit(1)
                    .minimumScaleFactor(0.72)
            }
            .foregroundStyle(self.selectedTab == tab ? .white : .secondary)
            .frame(maxWidth: .infinity, minHeight: 48)
            .contentShape(Capsule())
            .background {
                if self.selectedTab == tab {
                    Capsule()
                        .fill(OpenClawBrand.accent.gradient)
                        .matchedGeometryEffect(id: "FamilyAgent.Tab.Selection", in: self.tabSelectionNamespace)
                        .shadow(color: OpenClawBrand.accent.opacity(0.24), radius: 8, y: 3)
                }
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel(tab.accessibilityLabel)
        .accessibilityValue(self.selectedTab == tab ? "Selected" : "")
        .accessibilityAddTraits(self.selectedTab == tab ? .isSelected : [])
        .accessibilityIdentifier("FamilyAgent.Tab.\(tab.rawValue.capitalized)")
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
                        These are chat starters. Family does not save a separate feed, ideas list, goals list, or \
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

private struct FamilyAgentTabBarSurface: ViewModifier {
    func body(content: Content) -> some View {
        if #available(iOS 26.0, *) {
            content
                .glassEffect(.regular.interactive(), in: .capsule)
        } else {
            content
                .background(.ultraThinMaterial, in: Capsule())
                .overlay {
                    Capsule()
                        .strokeBorder(.white.opacity(0.12), lineWidth: 0.5)
                }
                .shadow(color: .black.opacity(0.16), radius: 16, y: 7)
        }
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
        self.state == .verifying ? "Checking your agent" : "Your agent is unavailable"
    }

    private var detail: LocalizedStringKey {
        self.state == .verifying
            ? "Family is securely verifying the agent assigned to this profile."
            : """
            Family could not verify your assigned agent. Reopen your invitation or ask the person who invited you \
            for help.
            """
    }
}

struct FamilyProductWelcomeView: View {
    let connectionError: String?

    var body: some View {
        ZStack {
            OpenClawProBackground()
            VStack(spacing: 22) {
                Image(systemName: "person.2.badge.key.fill")
                    .font(.system(size: 54, weight: .semibold))
                    .foregroundStyle(OpenClawBrand.accent.gradient)
                    .accessibilityHidden(true)
                VStack(spacing: 8) {
                    Text("Welcome to Family")
                        .font(OpenClawType.title1)
                        .multilineTextAlignment(.center)
                    Text("Open the invitation from your family organizer to securely connect your personal agent.")
                        .font(OpenClawType.body)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                }
                Label(
                    "Your conversations and connected services stay assigned to your agent.",
                    systemImage: "lock.shield.fill")
                    .font(OpenClawType.subhead)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                if let connectionError {
                    Text(connectionError)
                        .font(OpenClawType.subhead)
                        .foregroundStyle(OpenClawBrand.warn)
                        .multilineTextAlignment(.center)
                        .accessibilityIdentifier("FamilyProduct.ConnectionError")
                }
            }
            .padding(32)
            .frame(maxWidth: 520)
        }
        .accessibilityIdentifier("FamilyProduct.Welcome")
    }
}
