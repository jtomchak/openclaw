/// <reference path="./cloudflare-runtime.d.ts" />

import type {
  AgentInvitationsRedeemParams,
  AgentInvitationsRedeemResult,
  AgentInvitationsStatusResult,
} from "@openclaw/gateway-protocol/schema";
import { PROTOCOL_VERSION } from "@openclaw/gateway-protocol/version";

interface GatewayFrame {
  error?: { message?: string };
  event?: string;
  id?: string;
  ok?: boolean;
  payload?: unknown;
  type?: string;
}

interface RelayDeviceIdentity {
  deviceId: string;
  privateKey: JsonWebKey;
  publicKey: string;
}

function parseRelayDeviceIdentity(raw: string): RelayDeviceIdentity {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("invalid relay device identity");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid relay device identity");
  const identity = value as Partial<RelayDeviceIdentity>;
  if (
    typeof identity.deviceId !== "string" ||
    !/^[a-f0-9]{64}$/u.test(identity.deviceId) ||
    typeof identity.publicKey !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/u.test(identity.publicKey) ||
    !identity.privateKey ||
    identity.privateKey.kty !== "OKP" ||
    identity.privateKey.crv !== "Ed25519" ||
    typeof identity.privateKey.d !== "string" ||
    typeof identity.privateKey.x !== "string"
  ) {
    throw new Error("invalid relay device identity");
  }
  return identity as RelayDeviceIdentity;
}

function base64Url(bytes: ArrayBuffer): string {
  const input = new Uint8Array(bytes);
  let binary = "";
  for (const byte of input) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

async function signedRelayDevice(params: {
  challenge: GatewayFrame;
  identity: RelayDeviceIdentity;
  scopes: string[];
  token: string;
}): Promise<Record<string, unknown>> {
  const payload = params.challenge.payload as { nonce?: unknown; ts?: unknown } | undefined;
  const nonce = typeof payload?.nonce === "string" ? payload.nonce : "";
  const signedAtMs = typeof payload?.ts === "number" ? payload.ts : NaN;
  if (!nonce || !Number.isSafeInteger(signedAtMs)) throw new Error("Gateway challenge is invalid");
  const key = await crypto.subtle.importKey(
    "jwk",
    params.identity.privateKey,
    { name: "Ed25519" },
    false,
    ["sign"],
  );
  const authPayload = [
    "v3",
    params.identity.deviceId,
    "gateway-client",
    "backend",
    "operator",
    params.scopes.join(","),
    String(signedAtMs),
    params.token,
    nonce,
    "cloudflare-workers",
    "",
  ].join("|");
  const signature = await crypto.subtle.sign("Ed25519", key, new TextEncoder().encode(authPayload));
  return {
    id: params.identity.deviceId,
    nonce,
    publicKey: params.identity.publicKey,
    signature: base64Url(signature),
    signedAt: signedAtMs,
  };
}

export interface AgentGatewayRpc {
  redeem(params: AgentInvitationsRedeemParams): Promise<AgentInvitationsRedeemResult>;
  status(invitationId: string): Promise<AgentInvitationsStatusResult>;
}

function gatewayHttpUrl(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== "wss:" || url.username || url.password || url.hash)
    throw new Error("invalid Gateway URL");
  url.protocol = "https:";
  return url;
}

function frameText(data: string | ArrayBuffer): string {
  return typeof data === "string" ? data : new TextDecoder().decode(data);
}

async function openGatewaySocket(
  url: string,
  access: { clientId: string; clientSecret: string },
): Promise<{ challenge: Promise<GatewayFrame>; socket: WebSocket }> {
  const response = await fetch(gatewayHttpUrl(url), {
    headers: {
      "CF-Access-Client-Id": access.clientId,
      "CF-Access-Client-Secret": access.clientSecret,
      Upgrade: "websocket",
    },
  });
  const socket = response.webSocket;
  if (response.status !== 101 || !socket)
    throw new Error(`Gateway WebSocket unavailable (${response.status})`);
  const challenge = waitForFrame(
    socket,
    (frame) => frame.type === "event" && frame.event === "connect.challenge",
  );
  socket.accept();
  return { challenge, socket };
}

function waitForFrame(
  socket: WebSocket,
  predicate: (frame: GatewayFrame) => boolean,
): Promise<GatewayFrame> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("Gateway RPC timed out")), 10_000);
    const finish = (error?: Error, frame?: GatewayFrame) => {
      clearTimeout(timer);
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("close", onClose);
      socket.removeEventListener("error", onError);
      if (error) reject(error);
      else if (frame) resolve(frame);
    };
    const onMessage = (event: MessageEvent) => {
      try {
        const frame: unknown = JSON.parse(frameText(event.data as string | ArrayBuffer));
        if (
          frame &&
          typeof frame === "object" &&
          !Array.isArray(frame) &&
          predicate(frame as GatewayFrame)
        ) {
          finish(undefined, frame as GatewayFrame);
        }
      } catch {
        // Ignore non-protocol frames until the bounded timeout.
      }
    };
    const onClose = () => finish(new Error("Gateway RPC socket closed"));
    const onError = () => finish(new Error("Gateway RPC socket failed"));
    socket.addEventListener("message", onMessage);
    socket.addEventListener("close", onClose, { once: true });
    socket.addEventListener("error", onError, { once: true });
  });
}

async function request(socket: WebSocket, method: string, params: unknown): Promise<unknown> {
  const id = crypto.randomUUID();
  const responsePromise = waitForFrame(socket, (frame) => frame.type === "res" && frame.id === id);
  socket.send(JSON.stringify({ type: "req", id, method, params }));
  const response = await responsePromise;
  if (!response.ok) throw new Error(`Gateway rejected ${method}`);
  return response.payload;
}

async function callGateway(params: {
  gatewayToken: string;
  gatewayUrl: string;
  accessClientId: string;
  accessClientSecret: string;
  deviceIdentity: RelayDeviceIdentity;
  method: string;
  payload: unknown;
}): Promise<unknown> {
  const opened = await openGatewaySocket(params.gatewayUrl, {
    clientId: params.accessClientId,
    clientSecret: params.accessClientSecret,
  });
  const { socket } = opened;
  try {
    const challenge = await opened.challenge;
    const scopes = ["operator.admin"];
    await request(socket, "connect", {
      auth: { token: params.gatewayToken },
      caps: [],
      client: {
        id: "gateway-client",
        mode: "backend",
        platform: "cloudflare-workers",
        version: "1.0.0",
      },
      maxProtocol: PROTOCOL_VERSION,
      minProtocol: PROTOCOL_VERSION,
      role: "operator",
      scopes,
      device: await signedRelayDevice({
        challenge,
        identity: params.deviceIdentity,
        scopes,
        token: params.gatewayToken,
      }),
    });
    return await request(socket, params.method, params.payload);
  } finally {
    socket.close(1000, "complete");
  }
}

export function createAgentGatewayRpc(params: {
  accessClientId: string;
  accessClientSecret: string;
  deviceIdentity: string;
  gatewayToken: string;
  gatewayUrl: string;
}): AgentGatewayRpc {
  const deviceIdentity = parseRelayDeviceIdentity(params.deviceIdentity);
  return {
    async redeem(input) {
      return (await callGateway({
        accessClientId: params.accessClientId,
        accessClientSecret: params.accessClientSecret,
        deviceIdentity,
        gatewayToken: params.gatewayToken,
        gatewayUrl: params.gatewayUrl,
        method: "agent.invitations.redeem",
        payload: input,
      })) as AgentInvitationsRedeemResult;
    },
    async status(invitationId) {
      return (await callGateway({
        accessClientId: params.accessClientId,
        accessClientSecret: params.accessClientSecret,
        deviceIdentity,
        gatewayToken: params.gatewayToken,
        gatewayUrl: params.gatewayUrl,
        method: "agent.invitations.status",
        payload: { invitationId },
      })) as AgentInvitationsStatusResult;
    },
  };
}
