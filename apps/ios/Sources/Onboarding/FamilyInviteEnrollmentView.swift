import SwiftUI

struct FamilyInviteEnrollmentView: View {
    @Bindable var coordinator: FamilyInviteEnrollmentCoordinator

    var body: some View {
        NavigationStack {
            VStack(spacing: 20) {
                Image(systemName: self.coordinator
                    .state == .failed ? "exclamationmark.shield.fill" : "person.badge.key.fill")
                    .font(.system(size: 42, weight: .semibold))
                    .foregroundStyle(self.coordinator.state == .failed ? .orange : OpenClawBrand.accent)
                    .accessibilityHidden(true)
                Text(self.title)
                    .font(OpenClawType.title2)
                    .multilineTextAlignment(.center)
                Text(self.detail)
                    .font(OpenClawType.body)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                if self.coordinator.state != .failed, self.coordinator.state != .complete {
                    ProgressView()
                        .accessibilityLabel(Text("Enrollment in progress"))
                }
                if self.coordinator.state == .failed || self.coordinator.state == .complete {
                    Button {
                        self.coordinator.dismiss()
                    } label: {
                        Text("Close")
                            .font(OpenClawType.subheadSemiBold)
                    }
                    .buttonStyle(.borderedProminent)
                }
            }
            .padding(28)
            .frame(maxWidth: 520, maxHeight: .infinity)
            .navigationTitle("")
            .interactiveDismissDisabled(self.coordinator.state != .failed && self.coordinator.state != .complete)
            .accessibilityIdentifier("FamilyInvite.Enrollment")
        }
    }

    private var title: LocalizedStringKey {
        switch self.coordinator.state {
        case .complete: "Ready to connect"
        case .failed: "Invite unavailable"
        default: "Setting up your agent"
        }
    }

    private var detail: LocalizedStringKey {
        switch self.coordinator.state {
        case .complete: "Your trusted connection is ready. Continue in Gateway setup."
        case .failed: "This invite could not be used. Ask the Gateway owner for a new invite."
        default: "OpenClaw is securely binding this invitation to this device."
        }
    }
}
