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

    @discardableResult
    func mutateFamilyRecord(
        _ record: FamilyRecord,
        lifecycleState: FamilyRecordLifecycleState? = nil,
        payload: AnyCodable? = nil,
        operation: FamilyMutationOperation = .update) async throws -> FamilyRecord
    {
        guard self.isConnectedFamilyAgentLocked else { throw URLError(.userAuthenticationRequired) }
        let method = switch record.kind {
        case .feedItem: "family.feed.mutate"
        case .idea: "family.ideas.mutate"
        case .goal: "family.goals.mutate"
        case .libraryItem: "family.library.mutate"
        case .actionRequest: "family.actions.mutate"
        }
        var params: [String: AnyCodable] = [
            "operation": AnyCodable(operation.rawValue),
            "id": AnyCodable(record.id),
            "expectedRevision": AnyCodable(record.revision),
            "idempotencyKey": AnyCodable(UUID().uuidString),
            "visibility": AnyCodable(record.visibility.rawValue),
            "lifecycleState": AnyCodable((lifecycleState ?? record.lifecyclestate).rawValue),
        ]
        if operation != .delete {
            params["payload"] = payload ?? record.payload
        }
        let data = try await self.operatorSession.request(
            OpenClawChatGatewayRequest(
                method: method,
                params: params,
                timeoutMs: 15000))
        let result = try JSONDecoder().decode(FamilyMutateResult.self, from: data)
        guard self.isConnectedFamilyAgentLocked else { throw CancellationError() }
        self.applyFamilyRecord(result.record)
        return result.record
    }

    private func applyFamilyRecord(_ record: FamilyRecord) {
        self.familyDomainRecords.removeAll { $0.id == record.id }
        if record.deletedatms == nil {
            self.familyDomainRecords.append(record)
        }
        self.familyDomainCursor = nil
        self.familyDomainLoadState = .ready
    }

    private static func familyDomainErrorMessage(_ error: Error) -> String {
        let message = error.localizedDescription.trimmingCharacters(in: .whitespacesAndNewlines)
        return message.isEmpty
            ? String(localized: "Family content could not be refreshed.")
            : message
    }
}
