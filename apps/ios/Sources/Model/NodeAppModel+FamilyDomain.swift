import Foundation
import OpenClawChatUI
import OpenClawProtocol

extension NodeAppModel {
    func refreshFamilyDomain() async {
        guard self.isConnectedFamilyAgentLocked else {
            self.familyDomainRecords = []
            self.familyDomainCapabilities = []
            self.familyDomainCursor = nil
            self.familyDomainLoadState = .idle
            return
        }

        self.familyDomainLoadState = .loading
        do {
            let data = try await self.operatorSession.request(
                OpenClawChatGatewayRequest(method: "family.bootstrap", timeoutMs: 15000))
            let result = try JSONDecoder().decode(FamilyBootstrapResult.self, from: data)
            guard self.isConnectedFamilyAgentLocked else { return }
            self.familyDomainRecords = result.records.filter { $0.deletedatms == nil }
            self.familyDomainCapabilities = result.capabilities
            self.familyDomainCursor = result.cursor
            self.familyDomainLoadState = .ready
        } catch {
            guard self.isConnectedFamilyAgentLocked else { return }
            self.familyDomainLoadState = .failed(Self.familyDomainErrorMessage(error))
        }
    }

    private static func familyDomainErrorMessage(_ error: Error) -> String {
        let message = error.localizedDescription.trimmingCharacters(in: .whitespacesAndNewlines)
        return message.isEmpty
            ? String(localized: "Family content could not be refreshed.")
            : message
    }
}
