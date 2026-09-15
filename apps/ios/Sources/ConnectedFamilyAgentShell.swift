import Foundation
import OpenClawProtocol
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

    static var records: [FamilyRecord] {
        #if DEBUG
        [
            self.record(
                id: "feed-soccer",
                kind: .feedItem,
                title: "Soccer registration closes Friday",
                summary: "Your school email says the registration form and fee are due before the weekend."),
            self.record(
                id: "feed-week",
                kind: .feedItem,
                title: "A calmer plan for this week",
                summary: "Three open tasks are worth handling before Thursday."),
            self.record(
                id: "idea-day-plan",
                kind: .idea,
                title: "Turn your inbox into a plan for the day",
                summary: "Your agent can organize messages, calendar events, and open tasks into one short plan."),
            self.record(
                id: "goal-guitar",
                kind: .goal,
                title: "Learn one complete song",
                summary: "Two practice sessions completed this week."),
            self.record(
                id: "library-plan",
                kind: .libraryItem,
                title: "Salt Lake City trip plan",
                summary: "Ready · Updated today"),
        ]
        #else
        []
        #endif
    }

    private static func record(
        id: String,
        kind: FamilyRecordKind,
        title: String,
        summary: String) -> FamilyRecord
    {
        FamilyRecord(
            id: id,
            kind: kind,
            revision: 1,
            sequence: 1,
            visibility: ._private,
            lifecyclestate: kind == .idea ? .proposed : .active,
            provenance: FamilyRecordProvenance(actortype: AnyCodable("agent"), source: "fixture"),
            payload: AnyCodable([
                "title": AnyCodable(title),
                "summary": AnyCodable(summary),
            ]),
            createdatms: 1,
            updatedatms: 1)
    }
}

struct ConnectedFamilyAgentShell: View {
    @Environment(NodeAppModel.self) private var appModel
    @State private var selectedTab: ConnectedFamilyAgentTab
    @Namespace private var tabSelectionNamespace
    private let fixtureEnabled: Bool

    init(arguments: [String] = ProcessInfo.processInfo.arguments) {
        _selectedTab = State(initialValue: ConnectedFamilyAgentShellFixture.initialTab(arguments: arguments))
        self.fixtureEnabled = ConnectedFamilyAgentShellFixture.isEnabled(arguments: arguments)
    }

    var body: some View {
        self.selectedContent
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .safeAreaInset(edge: .bottom, spacing: 0) {
                self.tabBar
            }
            .background(OpenClawProBackground())
            .accessibilityIdentifier("FamilyAgent.Shell")
            .task {
                if !self.fixtureEnabled, self.appModel.familyDomainLoadState == .idle {
                    await self.appModel.refreshFamilyDomain()
                }
            }
    }

    @ViewBuilder
    private var selectedContent: some View {
        switch self.selectedTab {
        case .chat:
            NavigationStack {
                ChatProTab(openSettings: nil)
            }
        case .feed:
            self.domainSurface(tab: .feed, kind: .feedItem)
        case .ideas:
            self.domainSurface(tab: .ideas, kind: .idea)
        case .goals:
            self.domainSurface(tab: .goals, kind: .goal)
        case .library:
            self.domainSurface(tab: .library, kind: .libraryItem)
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
            Image(systemName: tab.symbol)
                .font(.system(size: 19, weight: .semibold))
                .symbolEffect(.bounce, value: self.selectedTab == tab)
                .accessibilityHidden(true)
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

    private func domainSurface(tab: ConnectedFamilyAgentTab, kind: FamilyRecordKind) -> some View {
        NavigationStack {
            Group {
                let records = self.records(kind: kind)
                if records.isEmpty {
                    self.emptyDomainSurface(tab: tab)
                } else {
                    ScrollView {
                        LazyVStack(spacing: 12) {
                            ForEach(records, id: \.id) { record in
                                FamilyDomainRecordCard(record: record, fallbackTitle: tab.title)
                            }
                        }
                        .padding(.horizontal, OpenClawProMetric.pagePadding)
                        .padding(.vertical, 14)
                        .padding(.bottom, OpenClawProMetric.bottomScrollInset)
                    }
                }
            }
            .background(OpenClawProBackground())
            .refreshable {
                await self.appModel.refreshFamilyDomain()
            }
            .navigationTitle("")
            .toolbar {
                ToolbarItem(placement: .principal) {
                    self.agentHeader(title: tab.title, subtitle: "", symbol: tab.symbol)
                }
            }
        }
    }

    @ViewBuilder
    private func emptyDomainSurface(tab: ConnectedFamilyAgentTab) -> some View {
        switch self.appModel.familyDomainLoadState {
        case .idle, .loading:
            ProgressView {
                Text("Refreshing ") + Text(verbatim: tab.title)
            }
        case let .failed(message):
            ContentUnavailableView {
                Label("Couldn’t refresh \(tab.title)", systemImage: "wifi.exclamationmark")
            } description: {
                Text(message)
            } actions: {
                Button("Try Again") {
                    Task { await self.appModel.refreshFamilyDomain() }
                }
            }
        case .ready:
            ContentUnavailableView(
                "Nothing here yet",
                systemImage: tab.symbol,
                description: Text(self.emptyDescription(tab: tab)))
        }
    }

    private func records(kind: FamilyRecordKind) -> [FamilyRecord] {
        let source = self.fixtureEnabled ? ConnectedFamilyAgentShellFixture.records : self.appModel.familyDomainRecords
        return source
            .filter { $0.kind == kind && $0.deletedatms == nil }
            .sorted { $0.updatedatms > $1.updatedatms }
    }

    private func emptyDescription(tab: ConnectedFamilyAgentTab) -> LocalizedStringKey {
        switch tab {
        case .chat: "Start a conversation with your agent."
        case .feed: "Your agent’s updates will appear here."
        case .ideas: "Personalized ideas will appear here."
        case .goals: "Accepted and proposed goals will appear here."
        case .library: "Artifacts and uploads will appear here."
        }
    }

    private func agentHeader(
        title: String,
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
                Text(verbatim: title)
                    .font(OpenClawType.caption2Medium)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                Text(self.agentStatus)
                    .font(OpenClawType.caption2Medium)
                    .foregroundStyle(self.appModel.gatewayConnected ? OpenClawBrand.accent : Color.secondary)
                    .lineLimit(1)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(Text(verbatim: "\(self.agentName), \(title)"))
        .accessibilityIdentifier("FamilyAgent.Header")
    }

    private var agentStatus: String {
        switch self.appModel.familyDomainLoadState {
        case .loading: String(localized: "Refreshing")
        case .failed: String(localized: "Needs connection")
        case .idle, .ready:
            if self.appModel.gatewayConnected {
                String(localized: "Connected")
            } else {
                String(localized: "Offline")
            }
        }
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

private struct FamilyDomainRecordCard: View {
    let record: FamilyRecord
    let fallbackTitle: String

    var body: some View {
        ProCard(padding: 16) {
            VStack(alignment: .leading, spacing: 6) {
                HStack(alignment: .firstTextBaseline) {
                    self.title
                        .font(OpenClawType.headline)
                    Spacer(minLength: 8)
                    Text(self.lifecycleLabel)
                        .font(OpenClawType.caption2Medium)
                        .foregroundStyle(.secondary)
                        .fixedSize()
                }
                if let subtitle = self.payloadString("subtitle") ?? self.payloadString("summary") {
                    Text(subtitle)
                        .font(OpenClawType.subhead)
                        .foregroundStyle(.secondary)
                }
                if self.record.visibility == .sharedWithOrganizers {
                    Label("Shared with family organizers", systemImage: "person.2.fill")
                        .font(OpenClawType.caption)
                        .foregroundStyle(OpenClawBrand.accent)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("FamilyAgent.Record.\(self.record.id)")
    }

    private var title: Text {
        if let title = self.payloadString("title") {
            return Text(verbatim: title)
        }
        return Text(self.fallbackTitle)
    }

    private var lifecycleLabel: String {
        switch self.record.lifecyclestate {
        case .proposed: String(localized: "Proposed")
        case .active: String(localized: "Active")
        case .completed: String(localized: "Completed")
        case .dismissed: String(localized: "Dismissed")
        case .archived: String(localized: "Archived")
        }
    }

    private func payloadString(_ key: String) -> String? {
        guard let payload = self.record.payload.value as? [String: AnyCodable],
              let value = payload[key]?.value as? String
        else { return nil }
        let normalized = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return normalized.isEmpty ? nil : normalized
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
