import Foundation
import Testing
@testable import OpenClaw

@Suite struct FamilyInviteEdgeCredentialsTests {
    @Test func `default TLS port has one credential identity`() throws {
        let implicit = try #require(URL(string: "wss://relay.example.invalid/v1/gateway"))
        let explicit = try #require(URL(string: "wss://relay.example.invalid:443/v1/gateway"))

        #expect(FamilyInviteEdgeCredentials.normalizedGatewayURL(implicit) == implicit)
        #expect(FamilyInviteEdgeCredentials.normalizedGatewayURL(explicit) == implicit)
    }

    @Test func `credential identity rejects an unrelated route`() throws {
        let unrelated = try #require(URL(string: "wss://relay.example.invalid/sibling"))
        #expect(FamilyInviteEdgeCredentials.normalizedGatewayURL(unrelated) == nil)
    }
}
