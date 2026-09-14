import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.js";
import {
  beginFamilyInviteRevocation,
  bindFamilyInviteDevice,
  createFamilyInvite,
  reserveFamilyInviteRedemption,
} from "../state/family-invites.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { resolveFamilyInviteForGatewayConnect } from "./family-invite-connect.js";
import { isTrustedFamilyInvitePolicy } from "./family-invite-policy.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let priorStateDir: string | undefined;

const cfg: OpenClawConfig = {
  agents: { list: [{ id: "family" }, { id: "sibling" }] },
  gateway: {
    roles: {
      default: "family-role",
      definitions: {
        "family-role": {
          agents: ["family"],
          scopes: ["operator.read", "operator.write"],
          sessions: { others: "none" },
          sandbox: "required",
        },
      },
    },
  },
};

beforeEach(() => {
  priorStateDir = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = tempDirs.make("openclaw-family-connect-");
});

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  if (priorStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = priorStateDir;
  }
});

describe("family invite Gateway connect", () => {
  it("binds one device to one agent, denies sibling access, and fails closed after revocation", async () => {
    const created = createFamilyInvite({
      agentId: "family",
      role: "family-role",
      expiresAtMs: 2_000,
      nowMs: 1_000,
    });
    const reserved = reserveFamilyInviteRedemption({
      token: created.token,
      publicKeyThumbprint: "thumb-a",
      nowMs: 1_001,
      validatePolicy: (invite) => isTrustedFamilyInvitePolicy({ cfg, ...invite }),
    });
    expect(reserved.ok).toBe(true);
    if (!reserved.ok || !reserved.invite.setupId) {
      return;
    }
    bindFamilyInviteDevice({
      setupId: reserved.invite.setupId,
      deviceId: "device-a",
      gatewayPublicKey: "ed25519-key-a",
      nowMs: 1_002,
    });

    await expect(
      resolveFamilyInviteForGatewayConnect({
        cfg,
        authMethod: "device-token",
        deviceId: "device-a",
        gatewayPublicKey: "ed25519-key-a",
      }),
    ).resolves.toMatchObject({
      kind: "allowed",
      invite: { agentId: "family", role: "family-role" },
    });
    expect(isTrustedFamilyInvitePolicy({ cfg, agentId: "sibling", role: "family-role" })).toBe(
      false,
    );

    beginFamilyInviteRevocation(created.invite.inviteId, undefined, 1_003);
    await expect(
      resolveFamilyInviteForGatewayConnect({
        cfg,
        authMethod: "device-token",
        deviceId: "device-a",
        gatewayPublicKey: "ed25519-key-a",
      }),
    ).resolves.toEqual({ kind: "denied" });
  });
});
