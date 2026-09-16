# Trusted-person agent onboarding

This document defines the trusted-person flow for adopting an existing OpenClaw agent as a family agent and inviting a device to it. The Swift `TrustedAgentProvisioningBlueprint` remains a client-side policy description and never contains credential material. Gateway family-agent RPCs own adoption, capability grants, and invitation rotation.

## Security model

The default blueprint provisions logical separation inside one trusted Gateway boundary:

- one explicit family manager;
- an existing dedicated agent directory and workspace;
- no agent-to-agent routing for family-member runs;
- same-agent session visibility for family-member runs;
- an explicit parent-approved tool allowlist;
- connector and model authorization performed by the invited person; and
- Gateway-owned credential storage and authorization flows, with no connector secret values returned to iOS.

Agent directories, workspaces, auth state, and sessions provide useful separation, but a shared Gateway is not an administrator or OS security boundary. The runtime applies session restrictions only to the family member, leaving the manager and unrelated agents unchanged. A person who needs strict OS separation must use a dedicated Gateway running under an appropriate OS or host boundary.

## Implemented adoption and invitation flow

1. An administrator calls `family.agents.adopt` for an existing configured agent, a configured manager, and a sandbox-required single-agent invitation role. Adoption preserves the agent's identity, model, workspace, agent directory, and history.
2. The Gateway applies the per-agent sandbox and explicit tool allowlist before recording the durable family relationship. Gateway, host-control, secret-management, publication, and family-management tools are always denied to the family member.
3. `family.agents.updateGrants` changes the approved-tool set. General capabilities such as web search, memory, automations, media, and approved plugin tools can be granted without granting Gateway administration.
4. `family.invitations.regenerate` revokes unfinished invitations for that family agent and creates one new invitation. Existing active device bindings remain valid.
5. The manager agent receives the model-facing `family_invite` tool. It can list only family agents it manages and regenerate an invite for one of those agents.
6. The invitee redeems the link through the existing enrollment flow. Credentials and invitation secrets remain Gateway-side; the link places the one-time token in the URL fragment so it is not sent as an HTTP request target.

All direct `family.*` Gateway methods require `operator.admin`. The family-member invitation role must not include that scope. The kid app uses the existing constrained enrollment and agent surfaces; it never receives family-management RPCs or host administration privileges.

Adoption records the family agent's relay URL. It must be an HTTPS origin without a path, port, credentials, query, or fragment. The Gateway validates the stored origin before revoking an unfinished invitation.

## Ownership and recovery

Family adoption is a durable SQLite journal keyed by agent ID. Repeating adoption under the same manager and invitation role reconciles the recorded display name, lifecycle, and tool grants. Attempting to transfer an adopted agent to another manager or role fails closed; ownership transfer needs a separate explicit contract.

Canonical runtime authorization remains in agent configuration. Adoption writes the restrictive config first, then records the family relationship. Grant updates follow the same order. A config write failure therefore cannot publish a more permissive durable family record.

Invitation rotation is one SQLite transaction: unfinished links are revoked and the replacement is inserted together. Active device bindings are deliberately outside that rotation.

## Staged roadmap

1. **Implemented:** durable existing-agent adoption, explicit grants, member-only runtime isolation, invitation rotation, manager tool, public protocol models, and focused state/Gateway tests.
2. **Parent app:** connect the Family Agents settings screen to the public RPCs and present share/copy controls without logging the invite token.
3. **Authorization expansion:** add connector-owned personal authorization flows where no safe existing flow is available.
4. **Proof and hardening:** exercise interrupted config writes, invite retries, ownership-transfer rejection, and dedicated-Gateway handoff through real end-to-end flows.
