---
summary: "Enroll one trusted family device into one Gateway agent through the optional Cloudflare relay"
read_when:
  - Enrolling an iPhone for a restricted family agent
  - Deploying or auditing the family relay Worker
title: "Trusted family-agent enrollment relay"
---

The family-agent enrollment flow gives one iPhone access to one existing agent on a
Gateway. The Gateway remains the only owner of user identity, role policy, device
pairing, and agent routing. The optional Cloudflare Worker validates short-lived edge
authorization and proxies WebSocket bytes; it never selects an agent or adds an agent
identity to traffic.

This feature is for people who trust the Gateway operator. A restricted role prevents a
family user from reaching sibling agents through supported Gateway APIs, but it does not
protect them from the administrator of the Gateway host. Use a separate Gateway and host
when host-administrator isolation is required.

## Before you begin

You need:

- an existing agent;
- an existing Gateway operator role whose `agents` list contains exactly that agent and
  whose scopes do not include `operator.admin`;
- a public HTTPS/WSS hostname for the Worker;
- a separate Cloudflare Tunnel hostname for the Gateway, protected by Access;
- an Apple associated-domain file served from that same hostname; and
- a server-held Gateway credential with `operator.admin` for the Worker's control-plane
  RPC connection.

The repository ships only placeholders such as `gateway.example.invalid`. Replace them
in your private deployment configuration. Never commit the Gateway credential, the edge
signing key, invitation values, setup codes, or device credentials.

## Trust and data flow

1. An administrator calls `family.invites.create` with an existing role and its one
   allowed agent. The Gateway stores a verifier for the opaque invitation in its shared
   SQLite state, not the invitation value.
2. The invitation is placed in an HTTPS universal-link fragment. URL fragments are
   available to the iOS app but are not sent in the HTTP request or normal edge access
   logs.
3. iOS creates a P-256 enrollment key. Physical devices use the Secure Enclave; the
   simulator and tests use the software fallback. The private key and enrollment receipt
   are stored in ThisDeviceOnly Keychain items.
4. The Worker verifies the signed request and sends the invitation and public-key
   thumbprint to `family.invites.redeem` over its authenticated Gateway connection.
5. The Gateway binds the invitation to that thumbprint, creates the restricted family
   profile, and asks the existing pairing owner for a short-lived setup code. This is a
   staged operation: SQLite reservation, asynchronous setup-code creation, then
   reconciliation. A failure is never reported as an atomic success.
6. iOS gives the setup code to the existing pairing flow. Pairing proves the Gateway's
   normal Ed25519 device identity; the stable setup ID binds that device to the P-256
   enrollment and family profile.
7. For a new relay WebSocket, iOS signs a fresh request proof. The Worker validates the
   audience, expiry, key thumbprint, nonce, replay state, and rate limits before tunneling
   bytes. It strips all relay authorization headers before connecting upstream.
8. The Gateway attaches the bound family profile and applies the current role definition.
   `users.self.assignedAgentId` is the client-visible routing authority. If the role no
   longer resolves to exactly one allowed agent, the connection fails closed.

The P-256 enrollment key and the Gateway's existing Ed25519 pairing key have separate
jobs. The relay key proves possession at the edge; it does not replace Gateway device
signatures.

## Deploy the Worker

The deployable workspace is `packages/family-relay`. Review its README and placeholder
`wrangler.jsonc`, then configure the two Worker secrets without writing them to a file:

```bash
cd packages/family-relay
pnpm exec wrangler secret put OPENCLAW_GATEWAY_TOKEN
pnpm exec wrangler secret put EDGE_TOKEN_SIGNING_KEY
pnpm exec wrangler secret put CF_ACCESS_CLIENT_ID
pnpm exec wrangler secret put CF_ACCESS_CLIENT_SECRET
```

Set `GATEWAY_WS_URL` to the Access-protected Tunnel hostname. Issue a Cloudflare Access
service token only to the Worker; it replaces client-supplied Access headers on every
control and proxy connection. Set the edge-token audience and Apple application identifier
for your deployment. Configure the iOS associated-domain build setting to the same host,
publish the matching Apple App Site Association response, and verify it from a signed
device before distributing invitations.

Run a local packaging check before deployment:

```bash
pnpm --filter @openclaw/family-relay check
pnpm --filter @openclaw/family-relay test
pnpm --filter @openclaw/family-relay exec wrangler deploy --dry-run
```

The dry run does not publish the Worker. Deployment and DNS changes are separate,
operator-authorized actions.

## Create and manage an invitation

Use an administrator-authenticated Gateway client. The create response is the only place
the invitation value is returned; treat it as a password and place it only in the
universal-link fragment.

The family invitation RPC group contains:

- `family.invites.create` — mint one expiring invitation for an existing restrictive
  role and its exact agent;
- `family.invites.redeem` — reserve or reconcile the invitation for one P-256 thumbprint
  and return the existing setup-code handoff;
- `family.invites.status` — return non-secret lifecycle and reconciliation state; and
- `family.invites.revoke` — durably deny future access, then remove the paired device and
  disconnect its sessions through the existing pairing lifecycle.

All four methods require `operator.admin`. The public Worker can redeem only because its
Gateway credential is held server-side. The credential is never returned to iOS or
forwarded on the proxied WebSocket.

Invitation redemption is single-use. A retry from the same P-256 thumbprint reconciles
the original setup handoff; another key is rejected. Revocation becomes authoritative in
SQLite first. If paired-device cleanup cannot finish, status reports pending
reconciliation and future connection checks still deny access.

## Operational limits

- An already-open proxied WebSocket may remain open until the Gateway-side device removal
  and disconnect completes. The durable binding blocks later connections immediately.
- Edge tokens are deliberately short lived and device-bound. Each WebSocket upgrade
  requires a unique signed nonce, allowing the native app's separate node and operator
  sockets without turning the token into Gateway authorization.
- The Worker uses Durable Objects for atomic nonce/JTI replay checks and rate admission.
  The long-lived outbound WebSocket remains in the top-level Worker because outgoing
  proxy sockets are not a hibernation path.
- Simulator tests do not prove Secure Enclave behavior. A representative simulator build
  proves compilation and the software fallback; final device enrollment requires a
  signed iPhone, the real associated domain, and a deployed Worker.

## Recovery

If setup-code creation fails after reservation, retry redemption from the same enrolled
device. The Gateway reconciles the stable setup ID instead of granting a second device.
If status remains in a pending reconciliation state, revoke the invitation and create a
new one only after the old record reports revoked. Do not copy Gateway tokens into the
iOS connection settings as a workaround.

See [Gateway pairing](/gateway/pairing), [operator scopes](/gateway/operator-scopes), and
[remote access](/gateway/remote) for the underlying contracts.
