# Trusted-person agent onboarding

This document defines the first non-visual iOS foundation for inviting a trusted person to use a personal OpenClaw agent. The Swift `TrustedAgentProvisioningBlueprint` is a policy description for a later Invite UI; it does not provision anything by itself and it never contains credential material.

## Security model

The default blueprint provisions logical separation inside one trusted Gateway boundary:

- one explicit user-profile owner;
- a dedicated agent directory and workspace;
- `tools.agentToAgent.enabled: false`;
- `tools.sessions.visibility: "agent"`, represented in the client as same-agent visibility;
- connector and model authorization performed by the invited person;
- a parent-managed inference allowlist for Codex and/or Ollama Cloud routes; and
- Gateway-owned credential storage and authorization flows, with no connector secret values returned to iOS.

Agent directories, workspaces, auth state, and sessions provide useful separation, but a shared Gateway is not an administrator or OS security boundary. OpenClaw's default session visibility is Gateway-wide and agent-to-agent messaging is enabled unless explicitly narrowed. A person who needs strict separation must use the blueprint's dedicated-Gateway/host isolation level and be provisioned on a separate Gateway running under an appropriate OS or host boundary.

## Proposed end-to-end flow

1. The parent chooses the child, requested capabilities, and allowed Codex/Ollama Cloud inference routes. iOS creates and validates a blueprint locally.
2. The Gateway resolves or creates the durable user profile through its existing authenticated profile flow (`users.self`; administrative discovery and profile setup use the existing `users.list`, `users.linkEmail`, `users.setDisplayName`, and, when configured, `users.setRole` methods).
3. An administrator creates the dedicated agent with `agents.create`, supplying a unique workspace; the Gateway derives the agent directory from the new agent ID. `agents.update` can change identity, workspace, and model fields, while `agents.delete` is the compensating removal operation.
4. A future Gateway provisioning owner applies the shared-Gateway isolation settings needed by the blueprint: same-agent session visibility and disabled agent-to-agent tools. These settings are Gateway configuration today, and `agents.update` cannot change them, so the provisioning contract must reconcile their Gateway-wide effect instead of treating them as per-invite state.
5. The invitee connects with a verified durable profile. The client confirms the authenticated identity with `users.self` before offering personal authorization.
6. The invitee authorizes model accounts through `users.authConnect.catalog`, `users.authConnect.start`, `users.authConnect.answer`, `users.authConnect.status`, and `users.authConnect.cancel`. Personal GitHub authorization uses `users.github.status`, `users.github.authorize.start`, `users.github.authorize.poll`, `users.github.authorize.cancel`, and `users.github.disconnect`. Arbitrary app connectors do not yet have a generic personal-authorization RPC; each connector must use an existing connector-owned flow, or remain unavailable until the Gateway exposes one.
7. iOS receives only flow identifiers, catalog/status data, and success or failure. Credential values stay in Gateway-owned auth-profile and secret storage. The client must not call a reveal path or introduce a second credential store.
8. The Gateway returns a final projection containing the profile ID, agent ID, effective isolation settings, and authorization statuses. iOS compares that projection with the blueprint before presenting setup as complete.

## Missing atomic provisioning contract

The existing RPCs own some individual operations, but there is no single atomic contract that creates or resolves the profile, creates the agent paths, applies isolation policy, binds ownership, authorizes arbitrary personal connectors, and returns a reconciled result. The Invite UI must not disguise a sequence of successful partial writes as one transaction.

A future Gateway-owned provisioning operation should accept an idempotency key plus the validated blueprint, record step state durably, and return the same operation/result for retries. It should own authorization checks, path allocation, conflict detection, and the final effective-policy projection. Adding that RPC is deliberately outside this milestone.

## Rollback and idempotency

Until an atomic owner exists, a coordinator must persist a Gateway-side operation identity before the first write and reconcile current state before every retry. Retrying must reuse the same profile and agent identity rather than append another agent or workspace.

If a later step fails, rollback runs in reverse order and only removes resources created by that operation. `agents.delete` can compensate for a newly created agent, but an existing user profile, completed personal authorization, pre-existing config, or user-owned data must not be deleted. A failed cleanup remains a visible recoverable state with the exact unfinished step. The flow reaches complete only after a fresh read proves that the effective owner, paths, access controls, and authorization statuses match the blueprint.

## Staged roadmap

1. **Foundation (this milestone):** Codable blueprint, safe defaults, validation, tests, and this boundary document.
2. **Gateway contract:** design and add one authoritative, idempotent provisioning operation with durable progress, reconciliation, and scoped rollback.
3. **iOS service layer:** map the blueprint to that operation, resume interrupted work, and expose status without secret values.
4. **Invite UI:** add the Muse-style inviter and invitee experience, capability review, strict-isolation explanation, and recoverable progress states.
5. **Proof and hardening:** exercise interrupted/retried provisioning, ownership changes, connector cancellation, rollback failures, and dedicated-Gateway handoff through real end-to-end flows.
