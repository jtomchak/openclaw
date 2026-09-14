/// <reference path="./cloudflare-runtime.d.ts" />

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
import type { FamilyGatewayRpc } from "./gateway-rpc.js";
import { gatewayFetchURL, handleFamilyRelayRequest, stripRelayHeaders } from "./index.js";
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
    EDGE_TOKEN_AUDIENCE: "openclaw-family-relay",
    EDGE_TOKEN_SIGNING_KEY: base64UrlEncode(crypto.getRandomValues(new Uint8Array(32))),
    FAMILY_RELAY_GUARD: guard,
    GATEWAY_WS_URL: "wss://gateway.example.invalid",
    IOS_APP_ID: "TEAMID.ai.openclaw.ios",
    OPENCLAW_GATEWAY_TOKEN: "synthetic-admin-token",
    RELAY_PUBLIC_URL: "https://relay.example.invalid",
  };
}

async function signedPost(params: {
  body: Record<string, unknown>;
  key: Awaited<ReturnType<typeof deviceKey>>;
  path: string;
  timestampMs: number;
}): Promise<Request> {
  const rawBody = JSON.stringify(params.body);
  const nonce = `nonce-${crypto.randomUUID()}`;
  const canonical = await canonicalDeviceProof({
    audience: "openclaw-family-relay",
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

describe("family relay vertical slice", () => {
  it("binds one invite to one device, denies a sibling key, and honors revocation", async () => {
    const nowMs = 1_800_000_000_000;
    const enrolled = await deviceKey();
    const sibling = await deviceKey();
    let state = "active";
    const rpc: FamilyGatewayRpc = {
      async redeem(input) {
        expect(input).toMatchObject({ publicKeyThumbprint: enrolled.thumbprint });
        return {
          invite: {
            inviteId: "invite-1",
            publicKeyThumbprint: enrolled.thumbprint,
            state: "redeeming",
          },
          setupCode: "synthetic-setup-code",
          setupExpiresAtMs: nowMs + 60_000,
          setupId: "setup-1",
        };
      },
      async status(inviteId) {
        expect(inviteId).toBe("invite-1");
        return { invite: { inviteId, publicKeyThumbprint: enrolled.thumbprint, state } };
      },
    };
    const env = environment();
    const deviceJwk = JSON.stringify(enrolled.jwk);
    const redeem = await handleFamilyRelayRequest(
      await signedPost({
        body: {
          inviteToken: "synthetic-invite-token",
          deviceJwk,
          deviceThumbprint: enrolled.thumbprint,
        },
        key: enrolled,
        path: "/v1/invites/redeem",
        timestampMs: nowMs,
      }),
      env,
      { gatewayRpc: rpc, nowMs: () => nowMs },
    );
    expect(redeem.status).toBe(200);
    expect(await redeem.json()).toEqual({
      expiresAtMs: nowMs + 60_000,
      inviteId: "invite-1",
      setupCode: "synthetic-setup-code",
      setupId: "setup-1",
      status: "redeeming",
    });

    const edge = await handleFamilyRelayRequest(
      await signedPost({
        body: { inviteId: "invite-1", deviceJwk, deviceThumbprint: enrolled.thumbprint },
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
    const denied = await handleFamilyRelayRequest(
      await signedPost({
        body: { inviteId: "invite-1", deviceJwk: siblingJwk, deviceThumbprint: sibling.thumbprint },
        key: sibling,
        path: "/v1/edge-tokens",
        timestampMs: nowMs,
      }),
      env,
      { gatewayRpc: rpc, nowMs: () => nowMs },
    );
    expect(denied.status).toBe(403);

    state = "revoked";
    const revoked = await handleFamilyRelayRequest(
      await signedPost({
        body: { inviteId: "invite-1", deviceJwk, deviceThumbprint: enrolled.thumbprint },
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
    const response = await handleFamilyRelayRequest(
      new Request("https://relay.example.invalid/.well-known/apple-app-site-association"),
      env,
      { gatewayRpc: {} as FamilyGatewayRpc },
    );
    expect(await response.json()).toMatchObject({
      applinks: { details: [{ components: [{ "/": "/family/invite" }] }] },
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
    const response = await handleFamilyRelayRequest(
      new Request("https://relay.example.invalid/v1/invites/redeem", {
        body,
        duplex: "half",
        method: "POST",
      } as RequestInit),
      environment(),
      { gatewayRpc: {} as FamilyGatewayRpc },
    );
    expect(response.status).toBe(400);
    expect(pulls).toBeLessThanOrEqual(2);
  });

  it("fails closed when the deployed proof audience drifts from the iOS protocol", async () => {
    const nowMs = 1_800_000_000_000;
    const key = await deviceKey();
    const env = environment();
    env.EDGE_TOKEN_AUDIENCE = "misconfigured-audience";
    const response = await handleFamilyRelayRequest(
      await signedPost({
        body: {
          inviteToken: "synthetic-invite-token",
          deviceJwk: JSON.stringify(key.jwk),
          deviceThumbprint: key.thumbprint,
        },
        key,
        path: "/v1/invites/redeem",
        timestampMs: nowMs,
      }),
      env,
      { gatewayRpc: {} as FamilyGatewayRpc, nowMs: () => nowMs },
    );
    expect(response.status).toBe(400);
  });
});
