/// <reference path="./cloudflare-runtime.d.ts" />

export interface P256PublicJwk {
  crv: "P-256";
  kty: "EC";
  x: string;
  y: string;
}

export interface RelayEnv {
  CF_ACCESS_CLIENT_ID: string;
  CF_ACCESS_CLIENT_SECRET: string;
  EDGE_TOKEN_AUDIENCE: string;
  EDGE_TOKEN_SIGNING_KEY: string;
  AGENT_RELAY_GUARD: DurableObjectNamespace;
  GATEWAY_WS_URL: string;
  APPLE_APP_ID: string;
  OPENCLAW_GATEWAY_TOKEN: string;
  RELAY_DEVICE_IDENTITY: string;
  RELAY_PUBLIC_URL: string;
}
