import { base64UrlDecode, decodeUtf8, sha256Base64Url, utf8 } from "./encoding.js";
import type { P256PublicJwk } from "./types.js";

export const DEVICE_JWK_HEADER = "X-OpenClaw-Device-JWK";
export const DEVICE_THUMBPRINT_HEADER = "X-OpenClaw-Device-Thumbprint";
export const PROOF_TIMESTAMP_HEADER = "X-OpenClaw-Proof-Timestamp";
export const PROOF_NONCE_HEADER = "X-OpenClaw-Proof-Nonce";
export const DEVICE_PROOF_HEADER = "X-OpenClaw-Device-Proof";
export const PROOF_MAX_CLOCK_SKEW_MS = 60_000;

function parseP256Jwk(raw: string): P256PublicJwk {
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("invalid device key");
  const record = parsed as Record<string, unknown>;
  if (
    record.kty !== "EC" ||
    record.crv !== "P-256" ||
    typeof record.x !== "string" ||
    typeof record.y !== "string"
  ) {
    throw new Error("invalid device key");
  }
  if (base64UrlDecode(record.x).byteLength !== 32 || base64UrlDecode(record.y).byteLength !== 32) {
    throw new Error("invalid device key");
  }
  return { crv: "P-256", kty: "EC", x: record.x, y: record.y };
}

export async function p256JwkThumbprint(jwk: P256PublicJwk): Promise<string> {
  return sha256Base64Url(utf8(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y })));
}

export async function canonicalDeviceProof(params: {
  audience: string;
  method: string;
  nonce: string;
  path: string;
  payload: Uint8Array;
  timestampMs: number;
}): Promise<Uint8Array> {
  const payloadHash = await sha256Base64Url(params.payload);
  return utf8(
    [
      "openclaw-agent-proof-v1",
      params.method.toUpperCase(),
      params.path,
      params.audience,
      String(params.timestampMs),
      params.nonce,
      payloadHash,
    ].join("\n"),
  );
}

export interface VerifiedDeviceProof {
  nonce: string;
  enrollmentKeyThumbprint: string;
  timestampMs: number;
}

export async function verifyDeviceProof(params: {
  audience: string;
  headers: Headers;
  method: string;
  nowMs: number;
  path: string;
  payload: Uint8Array;
}): Promise<VerifiedDeviceProof> {
  const rawJwk = params.headers.get(DEVICE_JWK_HEADER);
  const claimedThumbprint = params.headers.get(DEVICE_THUMBPRINT_HEADER);
  const rawTimestamp = params.headers.get(PROOF_TIMESTAMP_HEADER);
  const nonce = params.headers.get(PROOF_NONCE_HEADER);
  const rawSignature = params.headers.get(DEVICE_PROOF_HEADER);
  if (!rawJwk || !claimedThumbprint || !rawTimestamp || !nonce || !rawSignature)
    throw new Error("missing device proof");
  if (!/^[A-Za-z0-9_-]{16,128}$/u.test(nonce)) throw new Error("invalid device proof nonce");
  const timestampMs = Number(rawTimestamp);
  if (
    !Number.isSafeInteger(timestampMs) ||
    Math.abs(params.nowMs - timestampMs) > PROOF_MAX_CLOCK_SKEW_MS
  ) {
    throw new Error("expired device proof");
  }
  const jwk = parseP256Jwk(rawJwk);
  const enrollmentKeyThumbprint = await p256JwkThumbprint(jwk);
  if (claimedThumbprint !== enrollmentKeyThumbprint) throw new Error("device thumbprint mismatch");
  const signature = base64UrlDecode(rawSignature);
  if (signature.byteLength !== 64) throw new Error("invalid device proof signature");
  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  const canonical = await canonicalDeviceProof({ ...params, nonce, timestampMs });
  const valid = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    Uint8Array.from(signature).buffer,
    Uint8Array.from(canonical).buffer,
  );
  if (!valid) throw new Error("invalid device proof signature");
  return { enrollmentKeyThumbprint, nonce, timestampMs };
}

export function parseDeviceJwkHeader(headers: Headers): P256PublicJwk {
  const raw = headers.get(DEVICE_JWK_HEADER);
  if (!raw) throw new Error("missing device key");
  return parseP256Jwk(decodeUtf8(utf8(raw)));
}
