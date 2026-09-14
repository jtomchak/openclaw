/// <reference path="./cloudflare-runtime.d.ts" />

import { verifyDeviceProof } from "./device-proof.js";
import { EDGE_TOKEN_TTL_SECONDS, issueEdgeToken, verifyEdgeToken } from "./edge-token.js";
import { utf8 } from "./encoding.js";
import { createFamilyGatewayRpc, type FamilyGatewayRpc } from "./gateway-rpc.js";
import { admitRelayRequest, FamilyRelayGuard, RelayAdmissionError } from "./relay-guard.js";
import type { RelayEnv } from "./types.js";

export { FamilyRelayGuard };

const MAX_BODY_BYTES = 16 * 1024;
export const FAMILY_RELAY_PROOF_AUDIENCE = "openclaw-family-relay";
const RELAY_HEADER_NAMES = [
  "authorization",
  "cf-access-client-id",
  "cf-access-client-secret",
  "x-openclaw-device-jwk",
  "x-openclaw-device-thumbprint",
  "x-openclaw-proof-timestamp",
  "x-openclaw-proof-nonce",
  "x-openclaw-device-proof",
] as const;

interface WorkerDeps {
  gatewayRpc?: FamilyGatewayRpc;
  nowMs?: () => number;
}

function json(value: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("Cache-Control", "no-store");
  headers.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(value), { ...init, headers });
}

function errorResponse(status: number): Response {
  const error =
    status === 429
      ? "rate_limited"
      : status === 409
        ? "replayed"
        : status === 404
          ? "not_found"
          : "invalid_request";
  return json({ error }, { status });
}

async function requestBody(request: Request): Promise<Uint8Array> {
  const declaredLength = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES)
    throw new Error("invalid body");
  if (!request.body) throw new Error("invalid body");

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BODY_BYTES) {
        await reader.cancel("body too large");
        throw new Error("invalid body");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (length === 0) throw new Error("invalid body");
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function parseObject(bytes: Uint8Array): Record<string, unknown> {
  const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("invalid body");
  return parsed as Record<string, unknown>;
}

function clientIp(request: Request): string {
  return request.headers.get("CF-Connecting-IP") ?? "unknown";
}

function relayGatewayUrl(env: RelayEnv): string {
  const url = publicRelayOrigin(env);
  url.protocol = "wss:";
  url.pathname = "/v1/gateway";
  return url.toString();
}

function publicRelayOrigin(env: RelayEnv): URL {
  const url = new URL(env.RELAY_PUBLIC_URL);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error("invalid relay URL");
  return url;
}

async function verifyPost(request: Request, env: RelayEnv, bytes: Uint8Array, nowMs: number) {
  if (env.EDGE_TOKEN_AUDIENCE !== FAMILY_RELAY_PROOF_AUDIENCE)
    throw new Error("invalid relay proof audience");
  return await verifyDeviceProof({
    audience: FAMILY_RELAY_PROOF_AUDIENCE,
    headers: request.headers,
    method: "POST",
    nowMs,
    path: new URL(request.url).pathname,
    payload: bytes,
  });
}

async function handleRedeem(
  request: Request,
  env: RelayEnv,
  rpc: FamilyGatewayRpc,
  nowMs: number,
): Promise<Response> {
  const bytes = await requestBody(request);
  const proof = await verifyPost(request, env, bytes, nowMs);
  const body = parseObject(bytes);
  const token = body.inviteToken;
  if (
    typeof token !== "string" ||
    token.length < 16 ||
    token.length > 4096 ||
    body.deviceThumbprint !== proof.publicKeyThumbprint ||
    body.deviceJwk !== request.headers.get("X-OpenClaw-Device-JWK")
  ) {
    return errorResponse(400);
  }
  await admitRelayRequest({
    env,
    ip: clientIp(request),
    limit: 10,
    nowMs,
    replayExpiresAtMs: nowMs + 120_000,
    replayKey: `redeem:${proof.nonce}`,
    thumbprint: proof.publicKeyThumbprint,
  });
  const result = await rpc.redeem({
    token,
    publicKeyThumbprint: proof.publicKeyThumbprint,
    relayUrl: publicRelayOrigin(env).origin,
  });
  if (result.invite.publicKeyThumbprint !== proof.publicKeyThumbprint) return errorResponse(403);
  return json({
    expiresAtMs: result.setupExpiresAtMs,
    inviteId: result.invite.inviteId,
    setupCode: result.setupCode,
    setupId: result.setupId,
    status: result.invite.state,
  });
}

async function handleEdgeToken(
  request: Request,
  env: RelayEnv,
  rpc: FamilyGatewayRpc,
  nowMs: number,
): Promise<Response> {
  const bytes = await requestBody(request);
  const proof = await verifyPost(request, env, bytes, nowMs);
  const body = parseObject(bytes);
  const inviteId = body.inviteId;
  if (
    typeof inviteId !== "string" ||
    inviteId.length < 1 ||
    inviteId.length > 128 ||
    body.deviceThumbprint !== proof.publicKeyThumbprint ||
    body.deviceJwk !== request.headers.get("X-OpenClaw-Device-JWK")
  ) {
    return errorResponse(400);
  }
  await admitRelayRequest({
    env,
    ip: clientIp(request),
    limit: 30,
    nowMs,
    replayExpiresAtMs: nowMs + 120_000,
    replayKey: `mint:${proof.nonce}`,
    thumbprint: proof.publicKeyThumbprint,
  });
  const status = await rpc.status(inviteId);
  if (
    !(["redeeming", "active"] as const).includes(status.invite.state as "redeeming" | "active") ||
    status.invite.publicKeyThumbprint !== proof.publicKeyThumbprint
  )
    return errorResponse(403);
  const edgeToken = await issueEdgeToken({
    audience: FAMILY_RELAY_PROOF_AUDIENCE,
    inviteId,
    nowMs,
    signingSecret: env.EDGE_TOKEN_SIGNING_KEY,
    thumbprint: proof.publicKeyThumbprint,
  });
  return json({
    edgeToken,
    expiresAtMs: (Math.floor(nowMs / 1000) + EDGE_TOKEN_TTL_SECONDS) * 1000,
    gatewayUrl: relayGatewayUrl(env),
  });
}

export function stripRelayHeaders(headers: Headers): Headers {
  const result = new Headers(headers);
  for (const name of RELAY_HEADER_NAMES) result.delete(name);
  result.delete("cf-connecting-ip");
  return result;
}

function gatewayAccessHeaders(env: RelayEnv, source: Headers): Headers {
  const headers = stripRelayHeaders(source);
  headers.set("CF-Access-Client-Id", env.CF_ACCESS_CLIENT_ID);
  headers.set("CF-Access-Client-Secret", env.CF_ACCESS_CLIENT_SECRET);
  return headers;
}

export function gatewayFetchURL(raw: string): URL {
  const upstream = new URL(raw);
  if (upstream.protocol !== "wss:" || upstream.username || upstream.password || upstream.hash)
    throw new Error("invalid Gateway URL");
  upstream.search = "";
  upstream.protocol = "https:";
  return upstream;
}

async function handleGateway(
  request: Request,
  env: RelayEnv,
  rpc: FamilyGatewayRpc,
  nowMs: number,
): Promise<Response> {
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return errorResponse(400);
  const authorization = request.headers.get("Authorization");
  if (!authorization?.startsWith("Bearer ")) return errorResponse(401);
  const edgeToken = authorization.slice("Bearer ".length);
  const claims = await verifyEdgeToken({
    audience: FAMILY_RELAY_PROOF_AUDIENCE,
    nowMs,
    signingSecret: env.EDGE_TOKEN_SIGNING_KEY,
    token: edgeToken,
  });
  const proof = await verifyDeviceProof({
    audience: FAMILY_RELAY_PROOF_AUDIENCE,
    headers: request.headers,
    method: "GET",
    nowMs,
    path: "/v1/gateway",
    payload: utf8(edgeToken),
  });
  if (claims.cnf.jkt !== proof.publicKeyThumbprint) return errorResponse(403);
  await admitRelayRequest({
    env,
    ip: clientIp(request),
    limit: 60,
    nowMs,
    replayExpiresAtMs: claims.exp * 1000,
    replayKey: `ws-proof:${proof.nonce}`,
    thumbprint: proof.publicKeyThumbprint,
  });
  const status = await rpc.status(claims.sub);
  if (
    !(["redeeming", "active"] as const).includes(status.invite.state as "redeeming" | "active") ||
    status.invite.publicKeyThumbprint !== proof.publicKeyThumbprint
  )
    return errorResponse(403);
  const upstream = gatewayFetchURL(env.GATEWAY_WS_URL);
  const upstreamRequest = new Request(upstream, {
    headers: gatewayAccessHeaders(env, request.headers),
    method: "GET",
  });
  return await fetch(upstreamRequest);
}

function aasa(env: RelayEnv): Response {
  return json({
    applinks: { details: [{ appIDs: [env.IOS_APP_ID], components: [{ "/": "/family/invite" }] }] },
  });
}

function invitePage(): Response {
  return new Response(
    "<!doctype html><meta charset=utf-8><title>OpenClaw Family Invite</title><p>Open this link in the OpenClaw app.</p>",
    {
      headers: {
        "Cache-Control": "no-store",
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
        "Content-Type": "text/html; charset=utf-8",
        "Referrer-Policy": "no-referrer",
      },
    },
  );
}

export async function handleFamilyRelayRequest(
  request: Request,
  env: RelayEnv,
  deps: WorkerDeps = {},
): Promise<Response> {
  const url = new URL(request.url);
  const rpc =
    deps.gatewayRpc ??
    createFamilyGatewayRpc({
      accessClientId: env.CF_ACCESS_CLIENT_ID,
      accessClientSecret: env.CF_ACCESS_CLIENT_SECRET,
      deviceIdentity: env.RELAY_DEVICE_IDENTITY,
      gatewayToken: env.OPENCLAW_GATEWAY_TOKEN,
      gatewayUrl: env.GATEWAY_WS_URL,
    });
  const nowMs = deps.nowMs?.() ?? Date.now();
  try {
    if (url.search) return errorResponse(400);
    if (request.method === "GET" && url.pathname === "/.well-known/apple-app-site-association")
      return aasa(env);
    if (request.method === "GET" && url.pathname === "/family/invite") return invitePage();
    if (request.method === "POST" && url.pathname === "/v1/invites/redeem")
      return await handleRedeem(request, env, rpc, nowMs);
    if (request.method === "POST" && url.pathname === "/v1/edge-tokens")
      return await handleEdgeToken(request, env, rpc, nowMs);
    if (request.method === "GET" && url.pathname === "/v1/gateway")
      return await handleGateway(request, env, rpc, nowMs);
    return errorResponse(404);
  } catch (error) {
    if (error instanceof RelayAdmissionError) return errorResponse(error.status);
    console.error(
      "family relay request failed",
      error instanceof Error ? error.message : "unknown",
    );
    return errorResponse(400);
  }
}

export default { fetch: handleFamilyRelayRequest } satisfies ExportedHandler<RelayEnv>;
