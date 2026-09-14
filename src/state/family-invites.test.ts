import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  beginFamilyInviteRevocation,
  bindFamilyInviteDevice,
  completeFamilyInviteRevocation,
  createFamilyInvite,
  reserveFamilyInviteRedemption,
  resolveActiveFamilyInviteForDevice,
} from "./family-invites.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "./openclaw-state-db.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function stateOptions() {
  return { path: join(tempDirs.make("openclaw-family-invites-"), "openclaw.sqlite") };
}

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

describe("family invite state", () => {
  it("binds one token idempotently to one thumbprint without storing the secret", () => {
    const options = stateOptions();
    const created = createFamilyInvite(
      { agentId: "family", role: "family", expiresAtMs: 2_000, nowMs: 1_000 },
      options,
    );
    const first = reserveFamilyInviteRedemption(
      { token: created.token, publicKeyThumbprint: "thumb-a", nowMs: 1_001 },
      options,
    );
    expect(first.ok).toBe(true);
    if (!first.ok) {
      return;
    }
    const retry = reserveFamilyInviteRedemption(
      { token: created.token, publicKeyThumbprint: "thumb-a", nowMs: 1_002 },
      options,
    );
    expect(retry).toMatchObject({
      ok: true,
      invite: { setupId: first.invite.setupId, profileId: first.invite.profileId },
    });
    expect(
      reserveFamilyInviteRedemption(
        { token: created.token, publicKeyThumbprint: "thumb-b", nowMs: 1_003 },
        options,
      ),
    ).toEqual({ ok: false, reason: "device_mismatch" });

    const row = openOpenClawStateDatabase(options)
      .db.prepare("SELECT token_hash FROM family_invites WHERE invite_id = ?")
      .get(created.invite.inviteId) as { token_hash: string };
    expect(row.token_hash).not.toBe(created.token);
    expect(row.token_hash).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("fails closed after DB-first revocation", () => {
    const options = stateOptions();
    const created = createFamilyInvite(
      { agentId: "family", role: "family", expiresAtMs: 2_000, nowMs: 1_000 },
      options,
    );
    const reserved = reserveFamilyInviteRedemption(
      { token: created.token, publicKeyThumbprint: "thumb-a", nowMs: 1_001 },
      options,
    );
    expect(reserved.ok).toBe(true);
    if (!reserved.ok || !reserved.invite.setupId) {
      return;
    }
    expect(
      bindFamilyInviteDevice(
        { setupId: reserved.invite.setupId, deviceId: "device-a", gatewayPublicKey: "key-a" },
        options,
      ),
    ).toMatchObject({ state: "active" });
    expect(
      resolveActiveFamilyInviteForDevice(
        { deviceId: "device-a", gatewayPublicKey: "key-a" },
        options,
      ),
    ).toMatchObject({ agentId: "family" });
    expect(
      resolveActiveFamilyInviteForDevice(
        { deviceId: "device-a", gatewayPublicKey: "sibling-key" },
        options,
      ),
    ).toBeNull();

    expect(beginFamilyInviteRevocation(created.invite.inviteId, options, 1_100)).toMatchObject({
      state: "revocation_pending",
    });
    expect(
      resolveActiveFamilyInviteForDevice(
        { deviceId: "device-a", gatewayPublicKey: "key-a" },
        options,
      ),
    ).toBeNull();
  });

  it("allows only one active invite per device but permits enrollment after revocation", () => {
    const options = stateOptions();
    const createReserved = (agentId: string, thumbprint: string) => {
      const created = createFamilyInvite(
        { agentId, role: `${agentId}-role`, expiresAtMs: 2_000, nowMs: 1_000 },
        options,
      );
      const reserved = reserveFamilyInviteRedemption(
        { token: created.token, publicKeyThumbprint: thumbprint, nowMs: 1_001 },
        options,
      );
      if (!reserved.ok || !reserved.invite.setupId) {
        throw new Error("test invite reservation failed");
      }
      return { created, setupId: reserved.invite.setupId };
    };
    const first = createReserved("family", "thumb-a");
    const second = createReserved("sibling", "thumb-b");
    bindFamilyInviteDevice(
      { setupId: first.setupId, deviceId: "device-a", gatewayPublicKey: "key-a" },
      options,
    );
    expect(() =>
      bindFamilyInviteDevice(
        { setupId: second.setupId, deviceId: "device-a", gatewayPublicKey: "key-a" },
        options,
      ),
    ).toThrow();

    beginFamilyInviteRevocation(first.created.invite.inviteId, options, 1_100);
    completeFamilyInviteRevocation(first.created.invite.inviteId, options, 1_101);
    expect(
      bindFamilyInviteDevice(
        { setupId: second.setupId, deviceId: "device-a", gatewayPublicKey: "key-a" },
        options,
      ),
    ).toMatchObject({ state: "active", agentId: "sibling" });
  });

  it("rejects expired and policy-invalid invitations before allocating a profile", () => {
    const options = stateOptions();
    const created = createFamilyInvite(
      { agentId: "family", role: "family", expiresAtMs: 1_001, nowMs: 1_000 },
      options,
    );
    expect(
      reserveFamilyInviteRedemption(
        { token: created.token, publicKeyThumbprint: "thumb-a", nowMs: 1_001 },
        options,
      ),
    ).toEqual({ ok: false, reason: "expired" });

    const live = createFamilyInvite(
      { agentId: "family", role: "family", expiresAtMs: 2_000, nowMs: 1_000 },
      options,
    );
    expect(
      reserveFamilyInviteRedemption(
        {
          token: live.token,
          publicKeyThumbprint: "thumb-a",
          nowMs: 1_001,
          validatePolicy: () => false,
        },
        options,
      ),
    ).toEqual({ ok: false, reason: "invalid_policy" });
  });
});
