import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.js";
import {
  beginAgentInvitationRevocation,
  bindAgentInvitationDevice,
  createAgentInvitation,
  reserveAgentInvitationRedemption,
} from "../state/agent-invitations.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { resolveAgentInvitationForGatewayConnect } from "./agent-invitation-connect.js";
import { isScopedAgentInvitationPolicy } from "./agent-invitation-policy.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let priorStateDir: string | undefined;

const cfg: OpenClawConfig = {
  agents: { list: [{ id: "restricted" }, { id: "sibling" }] },
  gateway: {
    roles: {
      default: "restricted-role",
      definitions: {
        "restricted-role": {
          agents: ["restricted"],
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
  process.env.OPENCLAW_STATE_DIR = tempDirs.make("openclaw-agent-invitation-connect-");
});

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  if (priorStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = priorStateDir;
  }
});

describe("agent invitation Gateway connect", () => {
  it("binds one device to one agent, denies sibling access, and fails closed after revocation", async () => {
    const created = createAgentInvitation({
      agentId: "restricted",
      role: "restricted-role",
      expiresAtMs: 2_000,
      nowMs: 1_000,
    });
    const reserved = reserveAgentInvitationRedemption({
      token: created.token,
      enrollmentKeyThumbprint: "thumb-a",
      nowMs: 1_001,
      validatePolicy: (invitation) => isScopedAgentInvitationPolicy({ cfg, ...invitation }),
    });
    expect(reserved.ok).toBe(true);
    if (!reserved.ok || !reserved.invitation.setupId) {
      return;
    }
    bindAgentInvitationDevice({
      setupId: reserved.invitation.setupId,
      deviceId: "device-a",
      gatewayPublicKey: "ed25519-key-a",
      nowMs: 1_002,
    });

    await expect(
      resolveAgentInvitationForGatewayConnect({
        cfg,
        authMethod: "device-token",
        deviceId: "device-a",
        gatewayPublicKey: "ed25519-key-a",
      }),
    ).resolves.toMatchObject({
      kind: "allowed",
      invitation: { agentId: "restricted", role: "restricted-role" },
    });
    expect(
      isScopedAgentInvitationPolicy({ cfg, agentId: "sibling", role: "restricted-role" }),
    ).toBe(false);

    beginAgentInvitationRevocation(created.invitation.invitationId, undefined, 1_003);
    await expect(
      resolveAgentInvitationForGatewayConnect({
        cfg,
        authMethod: "device-token",
        deviceId: "device-a",
        gatewayPublicKey: "ed25519-key-a",
      }),
    ).resolves.toEqual({ kind: "denied" });
  });
});
