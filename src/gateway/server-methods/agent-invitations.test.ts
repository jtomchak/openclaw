import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

const mocks = vi.hoisted(() => ({
  beginRevocation: vi.fn(),
  bindDevice: vi.fn(),
  completeRevocation: vi.fn(),
  createInvitation: vi.fn(),
  readInvitation: vi.fn(),
  reserveRedemption: vi.fn(),
  ensureBootstrap: vi.fn(),
  readCompletion: vi.fn(),
  revokeBootstrap: vi.fn(),
  loadPairedDevice: vi.fn(),
  removePairedDevice: vi.fn(),
  resolveSetup: vi.fn(),
  encodeSetup: vi.fn(),
}));

vi.mock("../../state/agent-invitations.js", () => ({
  beginAgentInvitationRevocation: mocks.beginRevocation,
  bindAgentInvitationDevice: mocks.bindDevice,
  completeAgentInvitationRevocation: mocks.completeRevocation,
  createAgentInvitation: mocks.createInvitation,
  readAgentInvitation: mocks.readInvitation,
  reserveAgentInvitationRedemption: mocks.reserveRedemption,
}));
vi.mock("../../infra/device-bootstrap.js", () => ({
  ensureDevicePairSetupBootstrapToken: mocks.ensureBootstrap,
  readDevicePairSetupCompletion: mocks.readCompletion,
  revokeDeviceBootstrapTokenForSetupId: mocks.revokeBootstrap,
}));
vi.mock("../../infra/device-pairing-store.js", () => ({
  loadPairedDevicePairingStoreRecord: mocks.loadPairedDevice,
}));
vi.mock("../../infra/device-pairing.js", () => ({
  removePairedDevice: mocks.removePairedDevice,
}));
vi.mock("../../pairing/setup-code.js", () => ({
  encodePairingSetupCode: mocks.encodeSetup,
  resolvePairingSetupFromConfig: mocks.resolveSetup,
}));

import { agentInvitationHandlers } from "./agent-invitations.js";

const cfg: OpenClawConfig = {
  agents: { list: [{ id: "restricted" }] },
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

function invitation(overrides: Record<string, unknown> = {}) {
  return {
    invitationId: "invitation-1",
    agentId: "restricted",
    role: "restricted-role",
    state: "redeeming",
    createdAtMs: 1_000,
    expiresAtMs: 2_000,
    setupId: "setup-1",
    profileId: "profile-1",
    gatewayPublicKey: "gateway-public-key",
    enrollmentKeyThumbprint: "a".repeat(43),
    ...overrides,
  };
}

function createOptions(method: string, params: Record<string, unknown>) {
  const respond = vi.fn();
  const logGateway = { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() };
  const disconnectClientsForDevice = vi.fn();
  const options = {
    req: { type: "req", id: "req-1", method, params },
    params,
    client: null,
    isWebchatConnect: () => false,
    respond,
    context: {
      getRuntimeConfig: () => cfg,
      gatewayTlsFingerprint: "sha256:gateway-leaf",
      logGateway,
      disconnectClientsForDevice,
    },
  } as unknown as GatewayRequestHandlerOptions;
  return { options, respond, logGateway, disconnectClientsForDevice };
}

async function invoke(
  method: keyof typeof agentInvitationHandlers,
  options: GatewayRequestHandlerOptions,
) {
  await expectDefined(agentInvitationHandlers[method], `${method} handler test invariant`)(options);
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) {
    mock.mockReset();
  }
});

describe("agent invitation Gateway methods", () => {
  it("creates an invitation only for the configured restrictive agent role", async () => {
    mocks.createInvitation.mockReturnValue({
      invitation: invitation({ state: "pending" }),
      token: "secret-token",
    });
    const { options, respond, logGateway } = createOptions("agent.invitations.create", {
      agentId: "restricted",
      role: "restricted-role",
    });

    await invoke("agent.invitations.create", options);

    expect(respond).toHaveBeenCalledWith(
      true,
      {
        invitation: expect.not.objectContaining({ setupId: expect.anything() }),
        token: "secret-token",
      },
      undefined,
    );
    expect(logGateway.info).toHaveBeenCalledWith(
      "security audit: agent invitation created invitation=invitation-1 agent=restricted role=restricted-role",
    );
  });

  it("redeems through the existing pairing bootstrap without exposing internal bindings", async () => {
    mocks.reserveRedemption.mockReturnValue({ ok: true, invitation: invitation() });
    mocks.ensureBootstrap.mockResolvedValue({ status: "issued", token: "bootstrap-secret" });
    mocks.resolveSetup.mockResolvedValue({
      ok: true,
      setupId: "setup-1",
      payload: { url: "wss://gateway.example", bootstrapToken: "bootstrap-secret" },
      expiresAtMs: 3_000,
    });
    mocks.encodeSetup.mockReturnValue("SETUP-CODE");
    const { options, respond } = createOptions("agent.invitations.redeem", {
      token: "secret-token",
      enrollmentKeyThumbprint: "a".repeat(43),
      publicUrl: "wss://gateway.example",
    });

    await invoke("agent.invitations.redeem", options);

    expect(mocks.resolveSetup).toHaveBeenCalledWith(
      cfg,
      expect.objectContaining({ publicUrl: "wss://gateway.example" }),
    );
    const payload = respond.mock.calls[0]?.[1];
    expect(payload).toMatchObject({ setupId: "setup-1", setupCode: "SETUP-CODE" });
    expect(payload.invitation).not.toHaveProperty("setupId");
    expect(payload.invitation).not.toHaveProperty("profileId");
    expect(JSON.stringify(payload)).not.toContain("bootstrap-secret");
  });

  it("returns public status without setup, profile, or Gateway-key internals", async () => {
    mocks.readInvitation.mockReturnValue(invitation({ state: "active", deviceId: "device-1" }));
    const { options, respond } = createOptions("agent.invitations.status", {
      invitationId: "invitation-1",
    });

    await invoke("agent.invitations.status", options);

    const payload = respond.mock.calls[0]?.[1];
    expect(payload.invitation).toMatchObject({ state: "active", deviceId: "device-1" });
    expect(payload.invitation).not.toHaveProperty("setupId");
    expect(payload.invitation).not.toHaveProperty("profileId");
    expect(payload.invitation).not.toHaveProperty("gatewayPublicKey");
  });

  it("makes revocation durable before pairing cleanup and disconnect", async () => {
    const order: string[] = [];
    const active = invitation({ state: "active", deviceId: "device-1" });
    mocks.readInvitation.mockReturnValue(active);
    mocks.beginRevocation.mockImplementation(() => {
      order.push("durable-revocation");
      return { ...active, state: "revocation_pending" };
    });
    mocks.revokeBootstrap.mockImplementation(async () => {
      order.push("bootstrap-revocation");
      return { removed: 1 };
    });
    mocks.removePairedDevice.mockImplementation(async () => {
      order.push("pairing-removal");
      return active;
    });
    mocks.completeRevocation.mockImplementation(() => {
      order.push("complete");
      return { ...active, state: "revoked" };
    });
    const { options, respond, disconnectClientsForDevice } = createOptions(
      "agent.invitations.revoke",
      { invitationId: "invitation-1" },
    );
    disconnectClientsForDevice.mockImplementation(() => order.push("disconnect"));

    await invoke("agent.invitations.revoke", options);

    expect(order).toEqual([
      "durable-revocation",
      "bootstrap-revocation",
      "pairing-removal",
      "disconnect",
      "complete",
    ]);
    expect(respond).toHaveBeenCalledWith(
      true,
      { invitation: expect.objectContaining({ state: "revoked" }) },
      undefined,
    );
  });
});
