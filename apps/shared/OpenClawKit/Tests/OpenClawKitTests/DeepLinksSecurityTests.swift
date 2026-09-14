import Foundation
import OpenClawKit
import OpenClawProtocol
import Testing

private func setupCode(from payload: String) -> String {
    Data(payload.utf8)
        .base64EncodedString()
        .replacingOccurrences(of: "+", with: "-")
        .replacingOccurrences(of: "/", with: "_")
        .replacingOccurrences(of: "=", with: "")
}

private func gatewayLink(from raw: String) -> GatewayConnectDeepLink? {
    guard let url = URL(string: raw),
          case let .gateway(link)? = DeepLinkParser.parse(url)
    else { return nil }
    return link
}

struct DeepLinksSecurityTests {
    @Test func `family invite accepts only the configured HTTPS origin and fragment token`() throws {
        let link = try FamilyInviteDeepLink(
            url: #require(URL(string: "https://family-relay.example.invalid/family/invite#abc_DEF-123")),
            allowedHosts: ["family-relay.example.invalid"])

        #expect(link?.relayBaseURL.absoluteString == "https://family-relay.example.invalid")
        #expect(link?.inviteToken == "abc_DEF-123")
    }

    @Test(arguments: [
        "https://other.example.invalid/family/invite#abc_DEF-123",
        "http://family-relay.example.invalid/family/invite#abc_DEF-123",
        "https://family-relay.example.invalid:443/family/invite#abc_DEF-123",
        "https://user@family-relay.example.invalid/family/invite#abc_DEF-123",
        "https://family-relay.example.invalid/family/invite?token=abc_DEF-123",
        "https://family-relay.example.invalid/family/invite?source=mail#abc_DEF-123",
        "https://family-relay.example.invalid/family/invite/extra#abc_DEF-123",
        "https://family-relay.example.invalid/family/invite",
        "https://family-relay.example.invalid/family/invite#contains%20space",
    ])
    func `family invite rejects untrusted or ambiguous UR ls`(raw: String) throws {
        #expect(try FamilyInviteDeepLink(
            url: #require(URL(string: raw)),
            allowedHosts: ["family-relay.example.invalid"]) == nil)
    }

    @Test func `setup result initializer defaults optional fields`() {
        let result = DevicePairSetupCodeResult(
            setupid: "setup-1",
            setupcode: "code",
            qrdataurl: nil,
            gatewayurl: "wss://gateway.example.com",
            auth: AnyCodable("token"),
            urlsource: "config",
            expiresatms: 1_700_000_000_000)

        #expect(result.gatewayurls == nil)
        #expect(result.accessdowngraded == nil)
    }

    @Test func `dashboard deep link parses`() throws {
        let url = try #require(URL(string: "openclaw://dashboard"))
        #expect(DeepLinkParser.parse(url) == .dashboard)
    }

    @Test func `debug dashboard deep link parses`() throws {
        let url = try #require(URL(string: "openclaw-debug://dashboard"))
        #expect(DeepLinkParser.parse(url) == .dashboard)
    }

    @Test(arguments: ["openclaw", "openclaw-debug"])
    func `gateway add deep link preserves address and label`(scheme: String) throws {
        var components = try #require(URLComponents(string: "\(scheme)://gateway/add"))
        components.queryItems = [
            URLQueryItem(name: "url", value: "HTTPS://Gateway.Example:8443/openclaw%20gateway/"),
            URLQueryItem(name: "name", value: " Research & Design "),
        ]
        let route = try DeepLinkParser.parse(#require(components.url))
        guard case let .gatewayAdd(link) = route else {
            Issue.record("Expected a gateway-add intent")
            return
        }
        #expect(link.url.absoluteString == "https://gateway.example:8443/openclaw%20gateway/")
        #expect(link.name == "Research & Design")
        #expect(try GatewayConnectDeepLink.fromSetupInput(#require(components.url?.absoluteString)) == nil)
    }

    @Test(arguments: [
        "https://gateway.example/",
        "https://127.0.0.1:8443/",
        "https://openclaw.local/gateway",
        "https://gateway.example/operator%2Fteam",
    ])
    func `gateway add deep link does not require A deployment hostname`(address: String) throws {
        var components = try #require(URLComponents(string: "openclaw://gateway/add"))
        components.queryItems = [URLQueryItem(name: "url", value: address)]
        guard case let .gatewayAdd(link) = try DeepLinkParser.parse(#require(components.url)) else {
            Issue.record("Expected a gateway-add intent")
            return
        }
        #expect(link.url.absoluteString == address)
        #expect(link.name == nil)
    }

    @Test(arguments: [
        "http://gateway.example/",
        "http://127.0.0.1:18789/",
        "wss://gateway.example/",
        "file:///tmp/gateway",
        "https://user@gateway.example/",
        "https://gateway.example/?token=secret",
        "https://gateway.example/#secret",
        "https://gateway.example/?",
        "https://gateway.example/#",
        "https://gateway.example:0/",
        "https://gateway.example:65536/",
    ])
    func `gateway add deep link rejects non address metadata`(address: String) throws {
        var components = try #require(URLComponents(string: "openclaw://gateway/add"))
        components.queryItems = [URLQueryItem(name: "url", value: address)]
        #expect(try DeepLinkParser.parse(#require(components.url)) == nil)
    }

    @Test func `gateway add deep link rejects password credentials`() throws {
        var address = try #require(URLComponents(string: "https://gateway.example/"))
        address.user = "fixture-user"
        address.password = "fixture-password"
        var link = try #require(URLComponents(string: "openclaw://gateway/add"))
        link.queryItems = try [URLQueryItem(name: "url", value: #require(address.url).absoluteString)]
        #expect(try DeepLinkParser.parse(#require(link.url)) == nil)
    }

    @Test(arguments: [
        "openclaw://gateway/add?url=https%3A%2F%2Fgateway.example&token=secret",
        "openclaw://gateway/add?url=https%3A%2F%2Fgateway.example&password=secret",
        "openclaw://gateway/add?url=https%3A%2F%2Fgateway.example&url=https%3A%2F%2Fother.example",
        "openclaw://gateway/add?url=https%3A%2F%2Fgateway.example&name=One&name=Two",
        "openclaw://gateway/add?url=https%3A%2F%2Fgateway.example#secret",
        "openclaw://user@gateway/add?url=https%3A%2F%2Fgateway.example",
        "openclaw://gateway:443/add?url=https%3A%2F%2Fgateway.example",
        "openclaw://gateway/add?host=gateway.example&tls=1&token=secret",
    ])
    func `gateway add deep link rejects credentials and ambiguous parameters`(raw: String) throws {
        #expect(try DeepLinkParser.parse(#require(URL(string: raw))) == nil)
    }

    @Test func `gateway deep link uses tls default port when port missing`() {
        let link = gatewayLink(from: "openclaw://gateway?host=gateway.example.com&tls=1")
        #expect(link?.port == 443)
        #expect(link?.tls == true)
    }

    @Test func `gateway deep link uses plaintext default port when port missing`() {
        let link = gatewayLink(from: "openclaw://gateway?host=127.0.0.1&tls=0")
        #expect(link?.port == 18789)
        #expect(link?.tls == false)
    }

    @Test func `gateway deep link preserves explicit tls port`() {
        let link = gatewayLink(from: "openclaw://gateway?host=gateway.example.com&port=18789&tls=1")
        #expect(link?.port == 18789)
        #expect(link?.tls == true)
    }

    @Test func `gateway deep link rejects insecure non loopback ws`() throws {
        let url = try #require(URL(
            string: "openclaw://gateway?host=attacker.example&port=18789&tls=0&token=abc"))
        #expect(DeepLinkParser.parse(url) == nil)
    }

    @Test func `gateway deep link rejects insecure prefix bypass host`() throws {
        let url = try #require(URL(
            string: "openclaw://gateway?host=127.attacker.example&port=18789&tls=0&token=abc"))
        #expect(DeepLinkParser.parse(url) == nil)
    }

    @Test func `gateway deep link allows loopback ws`() throws {
        let url = try #require(URL(
            string: "openclaw://gateway?host=127.0.0.1&port=18789&tls=0&token=abc"))
        #expect(
            DeepLinkParser.parse(url) == .gateway(
                .init(
                    host: "127.0.0.1",
                    port: 18789,
                    tls: false,
                    bootstrapToken: nil,
                    token: "abc",
                    password: nil)))
    }

    @Test func `setup code rejects insecure non loopback ws`() {
        let payload = #"{"url":"ws://attacker.example:18789","bootstrapToken":"tok"}"#
        #expect(GatewayConnectDeepLink.fromSetupCode(setupCode(from: payload)) == nil)
    }

    @Test func `setup code rejects insecure prefix bypass host`() {
        let payload = #"{"url":"ws://127.attacker.example:18789","bootstrapToken":"tok"}"#
        #expect(GatewayConnectDeepLink.fromSetupCode(setupCode(from: payload)) == nil)
    }

    @Test func `setup code allows loopback ws`() {
        let payload = #"{"url":"ws://127.0.0.1:18789","bootstrapToken":"tok"}"#
        #expect(
            GatewayConnectDeepLink.fromSetupCode(setupCode(from: payload)) == .init(
                host: "127.0.0.1",
                port: 18789,
                tls: false,
                bootstrapToken: "tok",
                token: nil,
                password: nil))
    }

    @Test func `setup code accepts pairing URL wrapper without lowercasing payload`() {
        let payload = #"{"url":"wss://gateway.example:8443","bootstrapToken":"Bootstrap-AbC123"}"#
        let code = setupCode(from: payload)

        #expect(
            GatewayConnectDeepLink.fromSetupCode("oc-pair://\(code)") ==
                GatewayConnectDeepLink.fromSetupCode(code))
    }

    @Test func `setup code preserves primary gateway context path`() {
        let payload = #"{"url":"wss://gateway.example/openclaw-gw","bootstrapToken":"tok"}"#
        let link = GatewayConnectDeepLink.fromSetupCode(setupCode(from: payload))

        #expect(link?.contextPath == "/openclaw-gw")
        #expect(link?.websocketURL?.absoluteString == "wss://gateway.example:443/openclaw-gw")
    }

    @Test func `setup code decodes gateway context path exactly once`() {
        let payload = #"{"url":"wss://gateway.example/openclaw%20gateway","bootstrapToken":"tok"}"#
        let link = GatewayConnectDeepLink.fromSetupCode(setupCode(from: payload))

        #expect(link?.contextPath == "/openclaw%20gateway")
        #expect(link?.websocketURL?.absoluteString == "wss://gateway.example:443/openclaw%20gateway")
    }

    @Test func `setup code preserves escaped gateway path delimiter`() {
        let payload = #"{"url":"wss://gateway.example/openclaw%2Fgateway","bootstrapToken":"tok"}"#
        let link = GatewayConnectDeepLink.fromSetupCode(setupCode(from: payload))

        #expect(link?.contextPath == "/openclaw%2Fgateway")
        #expect(link?.websocketURL?.absoluteString == "wss://gateway.example:443/openclaw%2Fgateway")
    }

    @Test func `setup code preserves non UTF 8 gateway path octet`() {
        let payload = #"{"url":"wss://gateway.example/openclaw%FFgateway","bootstrapToken":"tok"}"#
        let link = GatewayConnectDeepLink.fromSetupCode(setupCode(from: payload))

        #expect(link?.contextPath == "/openclaw%FFgateway")
        #expect(link?.websocketURL?.absoluteString == "wss://gateway.example:443/openclaw%FFgateway")
    }

    @Test func `setup code allows private lan ws`() {
        let payload = #"{"url":"ws://192.168.1.20:18789","bootstrapToken":"tok"}"#
        #expect(
            GatewayConnectDeepLink.fromSetupCode(setupCode(from: payload)) == .init(
                host: "192.168.1.20",
                port: 18789,
                tls: false,
                bootstrapToken: "tok",
                token: nil,
                password: nil))
    }

    @Test func `setup code allows MDNS ws`() {
        let payload = #"{"url":"ws://openclaw.local:18789","bootstrapToken":"tok"}"#
        #expect(
            GatewayConnectDeepLink.fromSetupCode(setupCode(from: payload)) == .init(
                host: "openclaw.local",
                port: 18789,
                tls: false,
                bootstrapToken: "tok",
                token: nil,
                password: nil))
    }

    @Test func `setup code parses ordered gateway fallbacks`() throws {
        let payload = #"{"url":"ws://192.168.1.20:18789/lan-gw","urls":["ws://192.168.1.20:18789/lan-gw","wss://gateway.tailnet.ts.net:8443/tailnet-gw"],"bootstrapToken":"tok"}"#
        let link = GatewayConnectDeepLink.fromSetupCode(setupCode(from: payload))

        #expect(link?.connectionEndpoints == [
            .init(host: "192.168.1.20", port: 18789, tls: false, contextPath: "/lan-gw"),
            .init(host: "gateway.tailnet.ts.net", port: 8443, tls: true, contextPath: "/tailnet-gw"),
        ])
        #expect(try link?.selectingEndpoint(#require(link?.connectionEndpoints[1])) == .init(
            host: "gateway.tailnet.ts.net",
            port: 8443,
            tls: true,
            contextPath: "/tailnet-gw",
            bootstrapToken: "tok",
            token: nil,
            password: nil))
    }

    @Test func `setup code carries normalized TLS fingerprint`() {
        let fingerprint = (0..<32).map { _ in "AB" }.joined(separator: ":")
        let payload = #"{"url":"wss://gateway.example.com","tlsFingerprint":"SHA256:\#(fingerprint)"}"#
        let link = GatewayConnectDeepLink.fromSetupCode(setupCode(from: payload))

        #expect(link?.tlsFingerprintSha256 == fingerprint.replacingOccurrences(of: ":", with: "").lowercased())
    }

    @Test func `setup code rejects invalid TLS fingerprint`() {
        let payload = #"{"url":"wss://gateway.example.com","tlsFingerprint":"not-a-fingerprint"}"#

        #expect(GatewayConnectDeepLink.fromSetupCode(setupCode(from: payload)) == nil)
    }

    @Test func `setup code rejects expired payload`() {
        let payload = #"{"url":"wss://gateway.example.com","expiresAtMs":1}"#

        #expect(GatewayConnectDeepLink.fromSetupCode(setupCode(from: payload)) == nil)
    }

    @Test func `public initializer rejects malformed TLS fingerprint`() {
        let link = GatewayConnectDeepLink(
            host: "gateway.example.com",
            port: 443,
            tls: true,
            tlsFingerprintSha256: "not-a-fingerprint",
            bootstrapToken: nil,
            token: nil,
            password: nil)

        #expect(!link.isValidEndpoint)
    }

    @Test func `setup code rejects TLS fingerprint on plaintext endpoint`() {
        let fingerprint = String(repeating: "ab", count: 32)
        let payload = #"{"url":"ws://127.0.0.1:18789","tlsFingerprint":"\#(fingerprint)"}"#

        #expect(GatewayConnectDeepLink.fromSetupCode(setupCode(from: payload)) == nil)
    }

    @Test func `fallback endpoint does not inherit primary TLS fingerprint`() throws {
        let fingerprint = String(repeating: "ab", count: 32)
        let expiresAtMs: Int64 = 4_102_444_800_000
        let payload = #"{"url":"wss://direct.example.com","urls":["wss://direct.example.com","wss://proxy.example.com"],"tlsFingerprint":"\#(fingerprint)","expiresAtMs":\#(expiresAtMs)}"#
        let link = try #require(GatewayConnectDeepLink.fromSetupCode(setupCode(from: payload)))
        let fallback = try #require(link.fallbackEndpoints.first)
        let selectedFallback = link.selectingEndpoint(fallback)

        #expect(link.tlsFingerprintSha256 == fingerprint)
        #expect(link.expiresAtMs == expiresAtMs)
        #expect(selectedFallback.tlsFingerprintSha256 == nil)
        #expect(selectedFallback.expiresAtMs == expiresAtMs)
    }

    @Test func `rejected primary does not transfer TLS fingerprint to fallback`() throws {
        let fingerprint = String(repeating: "ab", count: 32)
        let payload = #"{"url":"ws://127.0.0.1:18789","urls":["wss://proxy.example.com"],"tlsFingerprint":"\#(fingerprint)"}"#
        let link = try #require(GatewayConnectDeepLink.fromSetupCode(setupCode(from: payload)))

        #expect(link.host == "proxy.example.com")
        #expect(link.tlsFingerprintSha256 == nil)
    }

    @Test func `legacy encoded gateway link decodes without fallbacks`() throws {
        let payload = #"{"host":"gateway.tailnet.ts.net","port":443,"tls":true}"#

        let link = try JSONDecoder().decode(
            GatewayConnectDeepLink.self,
            from: Data(payload.utf8))

        #expect(link.contextPath == nil)
        #expect(link.fallbackEndpoints.isEmpty)
    }

    @Test func `legacy encoded fallback endpoint decodes without context path`() throws {
        let payload = #"{"host":"gateway.example","port":443,"tls":true,"fallbackEndpoints":[{"host":"fallback.example","port":443,"tls":true}]}"#

        let link = try JSONDecoder().decode(
            GatewayConnectDeepLink.self,
            from: Data(payload.utf8))

        #expect(link.fallbackEndpoints == [
            .init(host: "fallback.example", port: 443, tls: true),
        ])
    }

    @Test func `setup code rejects gateway URL metadata`() {
        let urls = [
            "wss://user@gateway.example/openclaw-gw",
            "wss://gateway.example/openclaw-gw?mode=setup",
            "wss://gateway.example/openclaw-gw#fragment",
        ]

        for url in urls {
            let payload = #"{"url":"\#(url)","bootstrapToken":"tok"}"#
            #expect(GatewayConnectDeepLink.fromSetupCode(setupCode(from: payload)) == nil)
        }
    }

    @Test func `setup code drops insecure gateway fallbacks`() {
        let payload = #"{"url":"ws://attacker.example:18789","urls":["ws://attacker.example:18789","wss://gateway.tailnet.ts.net"],"bootstrapToken":"tok"}"#

        #expect(GatewayConnectDeepLink.fromSetupCode(setupCode(from: payload)) == .init(
            host: "gateway.tailnet.ts.net",
            port: 443,
            tls: true,
            bootstrapToken: "tok",
            token: nil,
            password: nil))
    }

    @Test func `setup code caps gateway endpoints`() throws {
        let urls = (0..<10).map { "wss://gateway-\($0).example.com" }
        let data = try JSONSerialization.data(withJSONObject: ["url": urls[0], "urls": urls])
        let payload = try #require(String(data: data, encoding: .utf8))

        let link = GatewayConnectDeepLink.fromSetupCode(setupCode(from: payload))

        #expect(link?.connectionEndpoints.count == 8)
        #expect(link?.connectionEndpoints.last?.host == "gateway-7.example.com")
    }

    @Test func `setup code rejects tailnet plaintext ws`() {
        let payload = #"{"url":"ws://gateway.tailnet.ts.net:18789","bootstrapToken":"tok"}"#
        #expect(GatewayConnectDeepLink.fromSetupCode(setupCode(from: payload)) == nil)
    }

    @Test func `setup code rejects cgnat plaintext ws`() {
        let payload = #"{"url":"ws://100.64.0.9:18789","bootstrapToken":"tok"}"#
        #expect(GatewayConnectDeepLink.fromSetupCode(setupCode(from: payload)) == nil)
    }

    @Test func `setup code parses host payload`() {
        let payload = #"{"host":"gateway.tailnet.ts.net","port":443,"tls":true,"bootstrapToken":"tok"}"#
        #expect(
            GatewayConnectDeepLink.fromSetupCode(setupCode(from: payload)) == .init(
                host: "gateway.tailnet.ts.net",
                port: 443,
                tls: true,
                bootstrapToken: "tok",
                token: nil,
                password: nil))
    }

    @Test func `setup code parses host payload with TLS default port`() {
        let payload = #"{"host":"gateway.tailnet.ts.net","tls":true,"bootstrapToken":"tok"}"#
        #expect(
            GatewayConnectDeepLink.fromSetupCode(setupCode(from: payload)) == .init(
                host: "gateway.tailnet.ts.net",
                port: 443,
                tls: true,
                bootstrapToken: "tok",
                token: nil,
                password: nil))
    }

    @Test func `setup code rejects insecure host payload`() {
        let payload = #"{"host":"gateway.tailnet.ts.net","port":18789,"tls":false,"bootstrapToken":"tok"}"#
        #expect(GatewayConnectDeepLink.fromSetupCode(setupCode(from: payload)) == nil)
    }

    @Test func `setup code allows private lan host payload`() {
        let payload = #"{"host":"openclaw.local","port":18789,"tls":false,"bootstrapToken":"tok"}"#
        #expect(
            GatewayConnectDeepLink.fromSetupCode(setupCode(from: payload)) == .init(
                host: "openclaw.local",
                port: 18789,
                tls: false,
                bootstrapToken: "tok",
                token: nil,
                password: nil))
    }

    @Test func `setup input parses full copied setup message`() {
        let payload = #"{"url":"wss://gateway.tailnet.ts.net","bootstrapToken":"tok"}"#
        let message = """
        Pairing setup code generated.

        Setup code:
        \(setupCode(from: payload))
        """
        #expect(
            GatewayConnectDeepLink.fromSetupInput(message) == .init(
                host: "gateway.tailnet.ts.net",
                port: 443,
                tls: true,
                bootstrapToken: "tok",
                token: nil,
                password: nil))
    }

    @Test func `setup input parses raw gateway URL`() {
        #expect(
            GatewayConnectDeepLink.fromSetupInput("wss://gateway.example.com:444") == .init(
                host: "gateway.example.com",
                port: 444,
                tls: true,
                bootstrapToken: nil,
                token: nil,
                password: nil))
    }
}
