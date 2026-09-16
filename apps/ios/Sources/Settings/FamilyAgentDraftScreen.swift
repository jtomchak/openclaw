import SwiftUI

enum FamilyAgentScreenshotMode {
    static let argument = "--openclaw-family-agent-screenshot-mode"

    static func isEnabled(arguments: [String]) -> Bool {
        #if DEBUG
        arguments.contains(self.argument)
        #else
        false
        #endif
    }
}

struct FamilyAgentDraft: Equatable {
    enum Avatar: String, CaseIterable, Identifiable {
        case spark
        case heart
        case leaf

        var id: String {
            self.rawValue
        }

        var symbol: String {
            switch self {
            case .spark: "sparkles"
            case .heart: "heart.fill"
            case .leaf: "leaf.fill"
            }
        }

        var label: String {
            switch self {
            case .spark: String(localized: "Spark")
            case .heart: String(localized: "Heart")
            case .leaf: String(localized: "Leaf")
            }
        }
    }

    enum Accent: String, CaseIterable, Identifiable {
        case coral
        case teal
        case blue

        var id: String {
            self.rawValue
        }

        var color: Color {
            switch self {
            case .coral: OpenClawBrand.accent
            case .teal: OpenClawBrand.teal
            case .blue: OpenClawBrand.info
            }
        }

        var label: String {
            switch self {
            case .coral: String(localized: "Coral")
            case .teal: String(localized: "Teal")
            case .blue: String(localized: "Blue")
            }
        }
    }

    enum PreparationState: Equatable {
        case draft
        case invalid(String)
        case ready
    }

    var displayName = String(localized: "My Agent")
    var avatar = Avatar.spark
    var accent = Accent.coral
    var allowedRoutes = TrustedAgentProvisioningBlueprint.InferenceRoute.allCases
    var preparationState = PreparationState.draft

    func isRouteAllowed(_ route: TrustedAgentProvisioningBlueprint.InferenceRoute) -> Bool {
        self.allowedRoutes.contains(route)
    }

    mutating func setRoute(_ route: TrustedAgentProvisioningBlueprint.InferenceRoute, allowed: Bool) {
        self.allowedRoutes.removeAll { $0 == route }
        if allowed {
            self.allowedRoutes.append(route)
            self.allowedRoutes.sort { lhs, rhs in
                guard let lhsIndex = TrustedAgentProvisioningBlueprint.InferenceRoute.allCases.firstIndex(of: lhs),
                      let rhsIndex = TrustedAgentProvisioningBlueprint.InferenceRoute.allCases.firstIndex(of: rhs)
                else { return false }
                return lhsIndex < rhsIndex
            }
        }
        self.preparationState = .draft
    }

    func blueprint(ownerProfileID: String) -> TrustedAgentProvisioningBlueprint {
        TrustedAgentProvisioningBlueprint(
            ownerProfileID: ownerProfileID,
            inferencePolicy: .init(
                allowedRoutes: self.allowedRoutes,
                isParentManaged: true))
    }

    mutating func prepareInvite(ownerProfileID: String) {
        guard !self.displayName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            self.preparationState = .invalid(String(localized: "Add a display name before preparing the invite."))
            return
        }
        let blueprint = self.blueprint(ownerProfileID: ownerProfileID)
        guard blueprint.isValid else {
            self.preparationState = .invalid(String(localized: "Allow at least one inference route."))
            return
        }
        self.preparationState = .ready
    }
}

struct FamilyAgentDraftScreen: View {
    @State private var draft = FamilyAgentDraft()

    private static let localValidationOwnerProfileID = "local-parent-draft"

    var body: some View {
        ScrollView {
            LazyVStack(spacing: 16) {
                self.identityCard
                self.inferenceCard
                self.isolationCard
                self.settingsCard
                self.prepareCard
            }
            .padding(.horizontal, OpenClawProMetric.pagePadding)
            .padding(.vertical, 12)
            .padding(.bottom, OpenClawProMetric.bottomScrollInset)
        }
        .background(OpenClawProBackground())
        .accessibilityIdentifier("FamilyAgents.Draft")
    }

    private var identityCard: some View {
        ProCard(isProminent: true, padding: 16) {
            VStack(alignment: .leading, spacing: 16) {
                HStack(spacing: 14) {
                    Image(systemName: self.draft.avatar.symbol)
                        .font(.system(size: 28, weight: .semibold))
                        .foregroundStyle(.white)
                        .frame(width: 64, height: 64)
                        .background(self.draft.accent.color, in: Circle())
                        .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 3) {
                        Text("Family agent")
                            .font(OpenClawType.title3SemiBold)
                        Text("Prepared by a parent, personalized by the person invited.")
                            .font(OpenClawType.caption)
                            .foregroundStyle(.secondary)
                    }
                }

                VStack(alignment: .leading, spacing: 6) {
                    Text("Display name")
                        .font(OpenClawType.captionSemiBold)
                        .foregroundStyle(.secondary)
                    TextField(text: self.displayNameBinding) {
                        Text("Agent name")
                            .font(OpenClawType.body)
                    }
                    .font(OpenClawType.body)
                    .textInputAutocapitalization(.words)
                    .autocorrectionDisabled()
                    .padding(12)
                    .background(
                        Color(uiColor: .secondarySystemGroupedBackground),
                        in: RoundedRectangle(cornerRadius: 12))
                    .accessibilityIdentifier("FamilyAgents.DisplayName")
                }

                Picker(selection: self.avatarBinding) {
                    ForEach(FamilyAgentDraft.Avatar.allCases) { avatar in
                        Text(avatar.label)
                            .font(OpenClawType.captionSemiBold)
                            .tag(avatar)
                    }
                } label: {
                    Text("Avatar")
                        .font(OpenClawType.body)
                }
                .pickerStyle(.segmented)

                HStack(spacing: 18) {
                    Text("Color")
                        .font(OpenClawType.body)
                    Spacer()
                    ForEach(FamilyAgentDraft.Accent.allCases) { accent in
                        Button {
                            self.draft.accent = accent
                            self.draft.preparationState = .draft
                        } label: {
                            Circle()
                                .fill(accent.color)
                                .frame(width: 30, height: 30)
                                .overlay {
                                    if self.draft.accent == accent {
                                        Image(systemName: "checkmark")
                                            .font(.system(size: 12, weight: .bold))
                                            .foregroundStyle(.white)
                                    }
                                }
                        }
                        .buttonStyle(.plain)
                        .frame(minWidth: 44, minHeight: 44)
                        .accessibilityLabel(accent.label)
                        .accessibilityValue(self.draft.accent == accent ? "Selected" : "Not selected")
                    }
                }
            }
        }
    }

    private var inferenceCard: some View {
        ProCard(padding: 0) {
            VStack(spacing: 0) {
                self.cardHeader(
                    title: "Allowed inference",
                    detail: "The parent controls which routes this agent may use.")
                Divider().padding(.leading, 16)
                self.routeToggle(.codex, title: "Codex", detail: "OpenAI-backed coding and reasoning")
                Divider().padding(.leading, 60)
                self.routeToggle(.ollamaCloud, title: "Ollama Cloud", detail: "Allowed cloud-hosted Ollama models")
            }
        }
    }

    private var isolationCard: some View {
        ProCard(tint: OpenClawBrand.teal, padding: 16) {
            HStack(alignment: .top, spacing: 12) {
                SettingsIcon(systemName: "lock.shield.fill", color: OpenClawBrand.teal)
                VStack(alignment: .leading, spacing: 5) {
                    Text("Planned isolation in this Gateway")
                        .font(OpenClawType.headline)
                    Text(
                        """
                        The invite will require dedicated agent files and workspace, same-agent sessions, \
                        and disabled agent-to-agent tools.
                        """)
                        .font(OpenClawType.caption)
                        .foregroundStyle(.secondary)
                    Text("A shared Gateway is not an OS security boundary.")
                        .font(OpenClawType.captionSemiBold)
                        .foregroundStyle(OpenClawBrand.teal)
                }
            }
        }
    }

    private var settingsCard: some View {
        ProCard(padding: 0) {
            VStack(spacing: 0) {
                self.settingsRow(icon: "link", title: "Connectors", value: "Invitee authorizes")
                self.rowDivider
                self.settingsRow(icon: "iphone", title: "Devices", value: "None linked")
                self.rowDivider
                self.settingsRow(
                    icon: "cpu",
                    title: "Models",
                    value: .verbatim(
                        "\(self.draft.allowedRoutes.count) \(String(localized: "routes allowed"))"))
                self.rowDivider
                self.settingsRow(icon: "key.fill", title: "Secure credentials", value: "Gateway only")
                self.rowDivider
                self.settingsRow(icon: "hand.raised.fill", title: "Permissions", value: "Parent review")
                self.rowDivider
                self.settingsRow(icon: "message.fill", title: "Messaging", value: "Agent-only planned")
                self.rowDivider
                self.settingsRow(icon: "bell.fill", title: "Notifications", value: "Not configured")
                self.rowDivider
                self.settingsRow(icon: "paintpalette.fill", title: "Appearance", value: "Local draft")
                self.rowDivider
                self.settingsRow(icon: "externaldrive.fill", title: "Data controls", value: "Dedicated planned")
            }
        }
    }

    private var prepareCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            Button {
                self.draft.prepareInvite(ownerProfileID: Self.localValidationOwnerProfileID)
            } label: {
                Label {
                    Text("Prepare Invite")
                        .font(OpenClawType.subheadSemiBold)
                } icon: {
                    Image(systemName: "person.badge.plus")
                }
                .frame(maxWidth: .infinity)
            }
            .controlSize(.large)
            .openClawGlassButton(prominent: true)
            .accessibilityIdentifier("FamilyAgents.PrepareInvite")

            switch self.draft.preparationState {
            case .draft:
                Text("This stays on this screen. Nothing is sent to the Gateway yet.")
                    .font(OpenClawType.caption)
                    .foregroundStyle(.secondary)
            case let .invalid(message):
                Text(message)
                    .font(OpenClawType.captionSemiBold)
                    .foregroundStyle(OpenClawBrand.danger)
                    .accessibilityIdentifier("FamilyAgents.ValidationMessage")
            case .ready:
                Text(
                    """
                    Draft ready. Gateway provisioning is not connected yet, so no agent, invite, \
                    connector, or credential was created.
                    """)
                    .font(OpenClawType.captionSemiBold)
                    .foregroundStyle(OpenClawBrand.ok)
                    .accessibilityIdentifier("FamilyAgents.ReadyMessage")
            }
        }
    }

    private func cardHeader(title: LocalizedStringKey, detail: LocalizedStringKey) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(title)
                .font(OpenClawType.headline)
            Text(detail)
                .font(OpenClawType.caption)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
    }

    private func routeToggle(
        _ route: TrustedAgentProvisioningBlueprint.InferenceRoute,
        title: LocalizedStringKey,
        detail: LocalizedStringKey) -> some View
    {
        let systemName = route == .codex ? "chevron.left.forwardslash.chevron.right" : "cloud.fill"
        return Toggle(isOn: self.routeBinding(route)) {
            HStack(spacing: 12) {
                SettingsIcon(
                    systemName: systemName,
                    color: route == .codex ? OpenClawBrand.accent : OpenClawBrand.teal)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(OpenClawType.subheadSemiBold)
                    Text(detail)
                        .font(OpenClawType.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .tint(OpenClawBrand.accent)
        .padding(16)
    }

    private func settingsRow(
        icon: String,
        title: LocalizedStringKey,
        value: OpenClawTextValue) -> some View
    {
        HStack(spacing: 12) {
            Image(systemName: icon)
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(OpenClawBrand.accentForeground)
                .frame(width: 28)
                .accessibilityHidden(true)
            Text(title)
                .font(OpenClawType.subheadSemiBold)
            Spacer(minLength: 10)
            value.text
                .font(OpenClawType.caption)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.trailing)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 13)
    }

    private var rowDivider: some View {
        Divider().padding(.leading, 56)
    }

    private var displayNameBinding: Binding<String> {
        Binding(
            get: { self.draft.displayName },
            set: {
                self.draft.displayName = $0
                self.draft.preparationState = .draft
            })
    }

    private var avatarBinding: Binding<FamilyAgentDraft.Avatar> {
        Binding(
            get: { self.draft.avatar },
            set: {
                self.draft.avatar = $0
                self.draft.preparationState = .draft
            })
    }

    private func routeBinding(_ route: TrustedAgentProvisioningBlueprint.InferenceRoute) -> Binding<Bool> {
        Binding(
            get: { self.draft.isRouteAllowed(route) },
            set: { self.draft.setRoute(route, allowed: $0) })
    }
}
