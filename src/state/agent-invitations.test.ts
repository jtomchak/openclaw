import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  beginAgentInvitationRevocation,
  bindAgentInvitationDevice,
  completeAgentInvitationRevocation,
  createAgentInvitation,
  reserveAgentInvitationRedemption,
  resolveActiveAgentInvitationForDevice,
} from "./agent-invitations.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "./openclaw-state-db.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function stateOptions() {
  return { path: join(tempDirs.make("openclaw-agent-invitations-"), "openclaw.sqlite") };
}

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

describe("agent invitation state", () => {
  it("binds one token idempotently to one enrollment key without storing the secret", () => {
    const options = stateOptions();
    const created = createAgentInvitation(
      { agentId: "restricted", role: "restricted", expiresAtMs: 2_000, nowMs: 1_000 },
      options,
    );
    const first = reserveAgentInvitationRedemption(
      { token: created.token, enrollmentKeyThumbprint: "thumb-a", nowMs: 1_001 },
      options,
    );
    expect(first.ok).toBe(true);
    if (!first.ok) {
      return;
    }
    const retry = reserveAgentInvitationRedemption(
      { token: created.token, enrollmentKeyThumbprint: "thumb-a", nowMs: 1_002 },
      options,
    );
    expect(retry).toMatchObject({
      ok: true,
      invitation: {
        setupId: first.invitation.setupId,
        profileId: first.invitation.profileId,
      },
    });
    expect(
      reserveAgentInvitationRedemption(
        { token: created.token, enrollmentKeyThumbprint: "thumb-b", nowMs: 1_003 },
        options,
      ),
    ).toEqual({ ok: false, reason: "device_mismatch" });

    const row = openOpenClawStateDatabase(options)
      .db.prepare("SELECT token_hash FROM agent_invitations WHERE invitation_id = ?")
      .get(created.invitation.invitationId) as { token_hash: string };
    expect(row.token_hash).not.toBe(created.token);
    expect(row.token_hash).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("fails closed after DB-first revocation", () => {
    const options = stateOptions();
    const created = createAgentInvitation(
      { agentId: "restricted", role: "restricted", expiresAtMs: 2_000, nowMs: 1_000 },
      options,
    );
    const reserved = reserveAgentInvitationRedemption(
      { token: created.token, enrollmentKeyThumbprint: "thumb-a", nowMs: 1_001 },
      options,
    );
    expect(reserved.ok).toBe(true);
    if (!reserved.ok || !reserved.invitation.setupId) {
      return;
    }
    expect(
      bindAgentInvitationDevice(
        {
          setupId: reserved.invitation.setupId,
          deviceId: "device-a",
          gatewayPublicKey: "key-a",
        },
        options,
      ),
    ).toMatchObject({ state: "active" });
    expect(
      resolveActiveAgentInvitationForDevice(
        { deviceId: "device-a", gatewayPublicKey: "key-a" },
        options,
      ),
    ).toMatchObject({ agentId: "restricted" });
    expect(
      resolveActiveAgentInvitationForDevice(
        { deviceId: "device-a", gatewayPublicKey: "sibling-key" },
        options,
      ),
    ).toBeNull();

    expect(
      beginAgentInvitationRevocation(created.invitation.invitationId, options, 1_100),
    ).toMatchObject({
      state: "revocation_pending",
    });
    expect(
      resolveActiveAgentInvitationForDevice(
        { deviceId: "device-a", gatewayPublicKey: "key-a" },
        options,
      ),
    ).toBeNull();
  });

  it("allows only one active invitation per device but permits enrollment after revocation", () => {
    const options = stateOptions();
    const createReserved = (agentId: string, thumbprint: string) => {
      const created = createAgentInvitation(
        { agentId, role: `${agentId}-role`, expiresAtMs: 2_000, nowMs: 1_000 },
        options,
      );
      const reserved = reserveAgentInvitationRedemption(
        { token: created.token, enrollmentKeyThumbprint: thumbprint, nowMs: 1_001 },
        options,
      );
      if (!reserved.ok || !reserved.invitation.setupId) {
        throw new Error("test invitation reservation failed");
      }
      return { created, setupId: reserved.invitation.setupId };
    };
    const first = createReserved("restricted", "thumb-a");
    const second = createReserved("sibling", "thumb-b");
    bindAgentInvitationDevice(
      { setupId: first.setupId, deviceId: "device-a", gatewayPublicKey: "key-a" },
      options,
    );
    expect(() =>
      bindAgentInvitationDevice(
        { setupId: second.setupId, deviceId: "device-a", gatewayPublicKey: "key-a" },
        options,
      ),
    ).toThrow();

    beginAgentInvitationRevocation(first.created.invitation.invitationId, options, 1_100);
    completeAgentInvitationRevocation(first.created.invitation.invitationId, options, 1_101);
    expect(
      bindAgentInvitationDevice(
        { setupId: second.setupId, deviceId: "device-a", gatewayPublicKey: "key-a" },
        options,
      ),
    ).toMatchObject({ state: "active", agentId: "sibling" });
  });

  it("rejects expired and policy-invalid invitations before allocating a profile", () => {
    const options = stateOptions();
    const created = createAgentInvitation(
      { agentId: "restricted", role: "restricted", expiresAtMs: 1_001, nowMs: 1_000 },
      options,
    );
    expect(
      reserveAgentInvitationRedemption(
        { token: created.token, enrollmentKeyThumbprint: "thumb-a", nowMs: 1_001 },
        options,
      ),
    ).toEqual({ ok: false, reason: "expired" });

    const live = createAgentInvitation(
      { agentId: "restricted", role: "restricted", expiresAtMs: 2_000, nowMs: 1_000 },
      options,
    );
    expect(
      reserveAgentInvitationRedemption(
        {
          token: live.token,
          enrollmentKeyThumbprint: "thumb-a",
          nowMs: 1_001,
          validatePolicy: () => false,
        },
        options,
      ),
    ).toEqual({ ok: false, reason: "invalid_policy" });
  });
});
