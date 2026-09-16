# OpenClaw Agent Relay

This private workspace package is a minimal Cloudflare Worker front door for trusted-agent enrollment. It redeems a one-time agent invitation against an operator-owned OpenClaw Gateway, mints short-lived device-bound edge tokens, and admits an opaque WebSocket proxy only after proof-of-possession checks. The relay never chooses, carries, or injects an agent identity.

## Routes

- `GET /.well-known/apple-app-site-association` advertises `/agent/invite`.
- `GET /agent/invite` is a generic fallback page. Put the invitation secret in the URL fragment so it is delivered to the app but not sent in the HTTP request or access logs.
- `POST /v1/invitations/redeem` accepts the current iOS enrollment body and calls `agent.invitations.redeem` with the server-held Gateway credential.
- `POST /v1/invites/redeem` and the legacy `inviteId` edge-token body are supported only to enroll the already-distributed Family build; both are translated to the same agent-invitation Gateway API. Remove this bridge after the agent-protocol Family build is fully rolled out.
- `POST /v1/edge-tokens` checks `agent.invitations.status` before issuing a 45-second HS256 edge token bound to the enrolling P-256 key thumbprint.
- `GET /v1/gateway` requires a valid edge token and a fresh P-256 proof, consumes the proof nonce, rechecks invite status, strips relay credentials, and forwards the WebSocket upgrade to the configured Gateway. Subsequent frames are not inspected or rewritten. The short-lived token may authorize the app's separate node and operator sockets, but every upgrade requires a unique signed nonce.

Every signed request uses these exact canonical bytes:

```text
openclaw-agent-proof-v1
METHOD
PATH
AUDIENCE
TIMESTAMP_MS
NONCE
BASE64URL_SHA256(payload)
```

`AUDIENCE` is the fixed protocol value `openclaw-agent-relay`. The Worker rejects any
deployment whose `EDGE_TOKEN_AUDIENCE` differs, so it cannot silently drift from the iOS client.

For POST routes, `payload` is the exact request-body bytes. For the WebSocket route, it is the UTF-8 edge token. Sign with P-256 ECDSA/SHA-256 and send the raw 64-byte `r || s` signature as base64url in `X-OpenClaw-Device-Proof` alongside `X-OpenClaw-Device-JWK`, `X-OpenClaw-Device-Thumbprint`, `X-OpenClaw-Proof-Timestamp`, and `X-OpenClaw-Proof-Nonce`.

## Configure

`wrangler.jsonc` is the production relay configuration. `GATEWAY_WS_URL` must be `wss://`; `RELAY_PUBLIC_URL` must be the relay's public `https://` origin. Keep credentials out of that file.

Set secrets interactively:

```bash
pnpm --filter @openclaw/agent-relay exec wrangler secret put OPENCLAW_GATEWAY_TOKEN
pnpm --filter @openclaw/agent-relay exec wrangler secret put EDGE_TOKEN_SIGNING_KEY
pnpm --filter @openclaw/agent-relay exec wrangler secret put CF_ACCESS_CLIENT_ID
pnpm --filter @openclaw/agent-relay exec wrangler secret put CF_ACCESS_CLIENT_SECRET
```

`EDGE_TOKEN_SIGNING_KEY` is at least 32 random bytes encoded as unpadded base64url. Protect the Tunnel hostname with Cloudflare Access and issue a service token only to this Worker. The Worker replaces any client-supplied Access headers with that service token for both control RPCs and proxied WebSocket upgrades. The Gateway credential must be limited operationally to this relay and is used only for the two agent-invitation RPCs; it is never forwarded on the device WebSocket.

The `AgentRelayGuard` namespace uses SQLite-backed Durable Objects partitioned by IP address and device thumbprint. It persists bounded replay keys and rate windows. It is intentionally not one global rate-limit singleton.

## Verify without deploying

```bash
pnpm exec tsc --noEmit -p packages/agent-relay/tsconfig.json
pnpm test packages/agent-relay/src
pnpm --filter @openclaw/agent-relay exec wrangler deploy --dry-run
```

Do not treat a dry run as deployed proof. Custom-domain association, Cloudflare runtime behavior, upstream reachability, and revocation of an already-open socket require deployment/live integration. Revocation blocks token minting and future WebSocket upgrades; it does not terminate a connection that already passed admission.
