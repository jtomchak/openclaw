import { describe, expect, it } from "vitest";
import {
  canonicalDeviceProof,
  DEVICE_JWK_HEADER,
  DEVICE_PROOF_HEADER,
  DEVICE_THUMBPRINT_HEADER,
  PROOF_NONCE_HEADER,
  PROOF_TIMESTAMP_HEADER,
  p256JwkThumbprint,
  verifyDeviceProof,
} from "./device-proof.js";
import { issueEdgeToken, verifyEdgeToken } from "./edge-token.js";
import { base64UrlEncode, utf8 } from "./encoding.js";
import type { P256PublicJwk } from "./types.js";

async function deviceKey() {
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const exported = await crypto.subtle.exportKey("jwk", keys.publicKey);
  const jwk = { crv: "P-256", kty: "EC", x: exported.x!, y: exported.y! } satisfies P256PublicJwk;
  return { jwk, privateKey: keys.privateKey, thumbprint: await p256JwkThumbprint(jwk) };
}

describe("family relay security contracts", () => {
  it("verifies the exact iOS P-256 proof bytes and rejects payload substitution", async () => {
    const key = await deviceKey();
    const timestampMs = 1_800_000_000_000;
    const payload = utf8('{"inviteId":"invite-1"}');
    const canonical = await canonicalDeviceProof({
      audience: "openclaw-family-relay",
      method: "POST",
      nonce: "nonce-0123456789",
      path: "/v1/edge-tokens",
      payload,
      timestampMs,
    });
    const signature = new Uint8Array(
      await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        key.privateKey,
        Uint8Array.from(canonical).buffer,
      ),
    );
    const headers = new Headers({
      [DEVICE_JWK_HEADER]: JSON.stringify(key.jwk),
      [DEVICE_PROOF_HEADER]: base64UrlEncode(signature),
      [DEVICE_THUMBPRINT_HEADER]: key.thumbprint,
      [PROOF_NONCE_HEADER]: "nonce-0123456789",
      [PROOF_TIMESTAMP_HEADER]: String(timestampMs),
    });
    await expect(
      verifyDeviceProof({
        audience: "openclaw-family-relay",
        headers,
        method: "POST",
        nowMs: timestampMs,
        path: "/v1/edge-tokens",
        payload,
      }),
    ).resolves.toMatchObject({
      publicKeyThumbprint: key.thumbprint,
    });
    await expect(
      verifyDeviceProof({
        audience: "openclaw-family-relay",
        headers,
        method: "POST",
        nowMs: timestampMs,
        path: "/v1/edge-tokens",
        payload: utf8("substituted"),
      }),
    ).rejects.toThrow();
  });

  it("issues short-lived device-bound tokens without an agent identity", async () => {
    const signingSecret = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
    const token = await issueEdgeToken({
      audience: "openclaw-family-relay",
      inviteId: "invite-1",
      nowMs: 1_800_000_000_000,
      signingSecret,
      thumbprint: "thumbprint-1",
    });
    const claims = await verifyEdgeToken({
      audience: "openclaw-family-relay",
      nowMs: 1_800_000_010_000,
      signingSecret,
      token,
    });
    expect(claims).toMatchObject({ sub: "invite-1", cnf: { jkt: "thumbprint-1" } });
    expect(JSON.stringify(claims)).not.toContain("agent");
    await expect(
      verifyEdgeToken({
        audience: "sibling-relay",
        nowMs: 1_800_000_010_000,
        signingSecret,
        token,
      }),
    ).rejects.toThrow();
    await expect(
      verifyEdgeToken({
        audience: "openclaw-family-relay",
        nowMs: 1_800_000_100_000,
        signingSecret,
        token,
      }),
    ).rejects.toThrow();
  });
});
