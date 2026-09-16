/// <reference path="./cloudflare-runtime.d.ts" />

import type { AgentInvitation } from "@openclaw/gateway-protocol/schema";
import { describe, expect, it } from "vitest";
import {
  canonicalDeviceProof,
  DEVICE_JWK_HEADER,
  DEVICE_PROOF_HEADER,
  DEVICE_THUMBPRINT_HEADER,
  PROOF_NONCE_HEADER,
  PROOF_TIMESTAMP_HEADER,
  p256JwkThumbprint,
} from "./device-proof.js";
import { base64UrlEncode, utf8 } from "./encoding.js";
import type { AgentGatewayRpc } from "./gateway-rpc.js";
import { gatewayFetchURL, handleAgentRelayRequest, stripRelayHeaders } from "./index.js";
import type { P256PublicJwk, RelayEnv } from "./types.js";

async function deviceKey() {
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const exported = await crypto.subtle.exportKey("jwk", keys.publicKey);
  const jwk = { crv: "P-256", kty: "EC", x: exported.x!, y: exported.y! } satisfies P256PublicJwk;
  return { jwk, privateKey: keys.privateKey, thumbprint: await p256JwkThumbprint(jwk) };
}

function environment(): RelayEnv {
  const guard = {
    get: () => ({ fetch: async () => Response.json({ ok: true }) }),
    idFromName: () => ({}),
  } as DurableObjectNamespace;
  return {
    CF_ACCESS_CLIENT_ID: "fixture-client-id",
    CF_ACCESS_CLIENT_SECRET: "fixture-client-secret",
    EDGE_TOKEN_AUDIENCE: "openclaw-agent-relay",
    EDGE_TOKEN_SIGNING_KEY: base64UrlEncode(crypto.getRandomValues(new Uint8Array(32))),
    AGENT_RELAY_GUARD: guard,
    GATEWAY_WS_URL: "wss://gateway.example.invalid",
    APPLE_APP_IDS: "TEAMID1234.ai.openclaw.ios,TEAMID1234.ai.openclaw.ios.debug",
    OPENCLAW_GATEWAY_TOKEN: "synthetic-admin-token",
    RELAY_DEVICE_IDENTITY: JSON.stringify({
      deviceId: "a".repeat(64),
      privateKey: { crv: "Ed25519", d: "fixture-private", kty: "OKP", x: "fixture-public" },
      publicKey: "A".repeat(43),
    }),
    RELAY_PUBLIC_URL: "https://relay.example.invalid",
  };
}

function invitation(params: {
  enrollmentKeyThumbprint: string;
  state: AgentInvitation["state"];
}): AgentInvitation {
  return {
    agentId: "agent-a",
    createdAtMs: 1_800_000_000_000,
    enrollmentKeyThumbprint: params.enrollmentKeyThumbprint,
    expiresAtMs: 1_800_086_400_000,
    invitationId: "invitation-1",
    role: "invited-agent-a",
    state: params.state,
  };
}

async function signedPost(params: {
  audience?: string;
  body: Record<string, unknown>;
  key: Awaited<ReturnType<typeof deviceKey>>;
  path: string;
  timestampMs: number;
}): Promise<Request> {
  const rawBody = JSON.stringify(params.body);
  const nonce = `nonce-${crypto.randomUUID()}`;
  const canonical = await canonicalDeviceProof({
    audience: params.audience ?? "openclaw-agent-relay",
    method: "POST",
    nonce,
    path: params.path,
    payload: utf8(rawBody),
    timestampMs: params.timestampMs,
  });
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      params.key.privateKey,
      Uint8Array.from(canonical).buffer,
    ),
  );
  return new Request(`https://relay.example.invalid${params.path}`, {
    body: rawBody,
    headers: {
      "Content-Type": "application/json",
      [DEVICE_JWK_HEADER]: JSON.stringify(params.key.jwk),
      [DEVICE_PROOF_HEADER]: base64UrlEncode(signature),
      [DEVICE_THUMBPRINT_HEADER]: params.key.thumbprint,
      [PROOF_NONCE_HEADER]: nonce,
      [PROOF_TIMESTAMP_HEADER]: String(params.timestampMs),
    },
    method: "POST",
  });
}

describe("agent relay vertical slice", () => {
  it("binds one invitation to one device, denies a sibling key, and honors revocation", async () => {
    const nowMs = 1_800_000_000_000;
    const enrolled = await deviceKey();
    const sibling = await deviceKey();
    let state = "active";
    const rpc: AgentGatewayRpc = {
      async redeem(input) {
        expect(input).toMatchObject({ enrollmentKeyThumbprint: enrolled.thumbprint });
        return {
          invitation: invitation({
            enrollmentKeyThumbprint: enrolled.thumbprint,
            state: "redeeming",
          }),
          setupCode: "synthetic-setup-code",
          setupExpiresAtMs: nowMs + 60_000,
          setupId: "setup-1",
        };
      },
      async status(invitationId) {
        expect(invitationId).toBe("invitation-1");
        return {
          invitation: invitation({
            enrollmentKeyThumbprint: enrolled.thumbprint,
            state: state as AgentInvitation["state"],
          }),
        };
      },
    };
    const env = environment();
    const deviceJwk = JSON.stringify(enrolled.jwk);
    const redeem = await handleAgentRelayRequest(
      await signedPost({
        body: {
          invitationToken: "synthetic-invitation-token",
          deviceJwk,
          deviceThumbprint: enrolled.thumbprint,
        },
        key: enrolled,
        path: "/v1/invitations/redeem",
        timestampMs: nowMs,
      }),
      env,
      { gatewayRpc: rpc, nowMs: () => nowMs },
    );
    expect(redeem.status).toBe(200);
    expect(await redeem.json()).toEqual({
      expiresAtMs: nowMs + 60_000,
      invitationId: "invitation-1",
      setupCode: "synthetic-setup-code",
      setupId: "setup-1",
      status: "redeeming",
    });

    const edge = await handleAgentRelayRequest(
      await signedPost({
        body: { invitationId: "invitation-1", deviceJwk, deviceThumbprint: enrolled.thumbprint },
        key: enrolled,
        path: "/v1/edge-tokens",
        timestampMs: nowMs,
      }),
      env,
      { gatewayRpc: rpc, nowMs: () => nowMs },
    );
    expect(edge.status).toBe(200);
    const edgeBody = (await edge.json()) as Record<string, unknown>;
    expect(edgeBody.gatewayUrl).toBe("wss://relay.example.invalid/v1/gateway");
    expect(typeof edgeBody.edgeToken).toBe("string");

    const siblingJwk = JSON.stringify(sibling.jwk);
    const denied = await handleAgentRelayRequest(
      await signedPost({
        body: {
          invitationId: "invitation-1",
          deviceJwk: siblingJwk,
          deviceThumbprint: sibling.thumbprint,
        },
        key: sibling,
        path: "/v1/edge-tokens",
        timestampMs: nowMs,
      }),
      env,
      { gatewayRpc: rpc, nowMs: () => nowMs },
    );
    expect(denied.status).toBe(403);

    state = "revoked";
    const revoked = await handleAgentRelayRequest(
      await signedPost({
        body: { invitationId: "invitation-1", deviceJwk, deviceThumbprint: enrolled.thumbprint },
        key: enrolled,
        path: "/v1/edge-tokens",
        timestampMs: nowMs,
      }),
      env,
      { gatewayRpc: rpc, nowMs: () => nowMs },
    );
    expect(revoked.status).toBe(403);
  });

  it("serves the universal-link association and removes every relay credential upstream", async () => {
    const env = environment();
    const response = await handleAgentRelayRequest(
      new Request("https://relay.example.invalid/.well-known/apple-app-site-association"),
      env,
      { gatewayRpc: {} as AgentGatewayRpc },
    );
    expect(await response.json()).toEqual({
      applinks: {
        details: [
          {
            appIDs: ["TEAMID1234.ai.openclaw.ios", "TEAMID1234.ai.openclaw.ios.debug"],
            components: [{ "/": "/agent/invite" }],
          },
        ],
      },
    });
    const stripped = stripRelayHeaders(
      new Headers({
        Authorization: "Bearer secret",
        "CF-Access-Client-Id": "attacker-client-id",
        "CF-Access-Client-Secret": "attacker-client-secret",
        Upgrade: "websocket",
        "X-OpenClaw-Device-Proof": "proof",
        "X-OpenClaw-Device-JWK": "jwk",
        "Sec-WebSocket-Protocol": "openclaw",
      }),
    );
    expect(stripped.has("Authorization")).toBe(false);
    expect(stripped.has("CF-Access-Client-Id")).toBe(false);
    expect(stripped.has("CF-Access-Client-Secret")).toBe(false);
    expect(stripped.has("X-OpenClaw-Device-Proof")).toBe(false);
    expect(stripped.get("Upgrade")).toBe("websocket");
    expect(stripped.get("Sec-WebSocket-Protocol")).toBe("openclaw");
  });

  it("bridges the installed Family app's legacy invitation wire format", async () => {
    const nowMs = 1_800_000_000_000;
    const key = await deviceKey();
    const rpc: AgentGatewayRpc = {
      async redeem(input) {
        expect(input.token).toBe("synthetic-legacy-invitation-token");
        return {
          invitation: invitation({ enrollmentKeyThumbprint: key.thumbprint, state: "redeeming" }),
          setupCode: "synthetic-setup-code",
          setupExpiresAtMs: nowMs + 60_000,
          setupId: "setup-1",
        };
      },
      async status() {
        return {
          invitation: invitation({ enrollmentKeyThumbprint: key.thumbprint, state: "active" }),
        };
      },
    };
    const deviceJwk = JSON.stringify(key.jwk);
    const redeem = await handleAgentRelayRequest(
      await signedPost({
        audience: "openclaw-family-relay",
        body: {
          inviteToken: "synthetic-legacy-invitation-token",
          deviceJwk,
          deviceThumbprint: key.thumbprint,
        },
        key,
        path: "/v1/invites/redeem",
        timestampMs: nowMs,
      }),
      environment(),
      { gatewayRpc: rpc, nowMs: () => nowMs },
    );
    expect(await redeem.json()).toMatchObject({ inviteId: "invitation-1", status: "redeeming" });

    const edge = await handleAgentRelayRequest(
      await signedPost({
        audience: "openclaw-family-relay",
        body: { inviteId: "invitation-1", deviceJwk, deviceThumbprint: key.thumbprint },
        key,
        path: "/v1/edge-tokens",
        timestampMs: nowMs,
      }),
      environment(),
      { gatewayRpc: rpc, nowMs: () => nowMs },
    );
    expect(edge.status).toBe(200);
  });

  it("converts only a secure Gateway WebSocket URL into a Worker fetch URL", () => {
    expect(gatewayFetchURL("wss://gateway.example.invalid/openclaw?ignored=1").toString()).toBe(
      "https://gateway.example.invalid/openclaw",
    );
    expect(() => gatewayFetchURL("ws://gateway.example.invalid/openclaw")).toThrow();
  });

  it("rejects an oversized streaming body before buffering the full request", async () => {
    const chunk = new Uint8Array(9 * 1024);
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(chunk);
        if (pulls === 3) controller.close();
      },
    });
    const response = await handleAgentRelayRequest(
      new Request("https://relay.example.invalid/v1/invitations/redeem", {
        body,
        duplex: "half",
        method: "POST",
      } as RequestInit),
      environment(),
      { gatewayRpc: {} as AgentGatewayRpc },
    );
    expect(response.status).toBe(400);
    expect(pulls).toBeLessThanOrEqual(2);
  });

  it("fails closed when the deployed proof audience drifts from the client protocol", async () => {
    const nowMs = 1_800_000_000_000;
    const key = await deviceKey();
    const env = environment();
    env.EDGE_TOKEN_AUDIENCE = "misconfigured-audience";
    const response = await handleAgentRelayRequest(
      await signedPost({
        body: {
          invitationToken: "synthetic-invitation-token",
          deviceJwk: JSON.stringify(key.jwk),
          deviceThumbprint: key.thumbprint,
        },
        key,
        path: "/v1/invitations/redeem",
        timestampMs: nowMs,
      }),
      env,
      { gatewayRpc: {} as AgentGatewayRpc, nowMs: () => nowMs },
    );
    expect(response.status).toBe(400);
  });
});
