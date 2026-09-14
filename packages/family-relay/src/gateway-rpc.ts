/// <reference path="./cloudflare-runtime.d.ts" />

import { PROTOCOL_VERSION } from "@openclaw/gateway-protocol/version";
import type { FamilyInviteRedeemResult, FamilyInviteStatusResult } from "./types.js";

interface GatewayFrame {
  error?: { message?: string };
  event?: string;
  id?: string;
  ok?: boolean;
  payload?: unknown;
  type?: string;
}

export interface FamilyGatewayRpc {
  redeem(params: {
    publicKeyThumbprint: string;
    relayUrl?: string;
    token: string;
  }): Promise<FamilyInviteRedeemResult>;
  status(inviteId: string): Promise<FamilyInviteStatusResult>;
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
  if (response.status !== 101 || !socket) throw new Error("Gateway WebSocket unavailable");
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
  method: string;
  payload: unknown;
}): Promise<unknown> {
  const opened = await openGatewaySocket(params.gatewayUrl, {
    clientId: params.accessClientId,
    clientSecret: params.accessClientSecret,
  });
  const { socket } = opened;
  try {
    await opened.challenge;
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
      scopes: ["operator.admin"],
    });
    return await request(socket, params.method, params.payload);
  } finally {
    socket.close(1000, "complete");
  }
}

export function createFamilyGatewayRpc(params: {
  accessClientId: string;
  accessClientSecret: string;
  gatewayToken: string;
  gatewayUrl: string;
}): FamilyGatewayRpc {
  return {
    async redeem(input) {
      return (await callGateway({
        accessClientId: params.accessClientId,
        accessClientSecret: params.accessClientSecret,
        gatewayToken: params.gatewayToken,
        gatewayUrl: params.gatewayUrl,
        method: "family.invites.redeem",
        payload: input,
      })) as FamilyInviteRedeemResult;
    },
    async status(inviteId) {
      return (await callGateway({
        accessClientId: params.accessClientId,
        accessClientSecret: params.accessClientSecret,
        gatewayToken: params.gatewayToken,
        gatewayUrl: params.gatewayUrl,
        method: "family.invites.status",
        payload: { inviteId },
      })) as FamilyInviteStatusResult;
    },
  };
}
