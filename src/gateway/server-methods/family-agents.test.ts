import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FamilyAgent } from "../../../packages/gateway-protocol/src/schema/family-agents.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { GatewayRequestContext, RespondFn } from "./types.js";

const mocks = vi.hoisted(() => ({
  adoptFamilyAgent: vi.fn(),
  listFamilyAgents: vi.fn(),
  persistFamilyAgentPolicy: vi.fn(),
  readFamilyAgent: vi.fn(),
  regenerateAgentInvitation: vi.fn(),
  updateFamilyAgentToolGrants: vi.fn(),
}));

vi.mock("../../state/family-agents.js", () => ({
  adoptFamilyAgent: mocks.adoptFamilyAgent,
  FamilyAgentConflictError: class FamilyAgentConflictError extends Error {},
  listFamilyAgents: mocks.listFamilyAgents,
  readFamilyAgent: mocks.readFamilyAgent,
  updateFamilyAgentToolGrants: mocks.updateFamilyAgentToolGrants,
}));

vi.mock("../../state/agent-invitations.js", () => ({
  regenerateAgentInvitation: mocks.regenerateAgentInvitation,
}));

vi.mock("./family-agent-config.js", () => ({
  persistFamilyAgentPolicy: mocks.persistFamilyAgentPolicy,
}));

import { familyAgentHandlers } from "./family-agents.js";

const familyAgent: FamilyAgent = {
  agentId: "dev-dude",
  managerAgentId: "walter",
  invitationRole: "dev-dude-invite",
  relayUrl: "https://family.example.test",
  displayName: "Dev Dude",
  toolGrants: ["memory_get", "web_search"],
  lifecycleState: "active",
  adoptedAtMs: 1_000,
  updatedAtMs: 1_000,
};

const config: OpenClawConfig = {
  agents: {
    entries: {
      walter: { name: "Walter" },
      cody: { name: "Cody" },
      "dev-dude": { name: "Dev Dude" },
    },
  },
  gateway: {
    roles: {
      definitions: {
        "dev-dude-invite": {
          agents: ["dev-dude"],
          scopes: ["operator.read", "operator.write"],
          sessions: { others: "none" },
          sandbox: "required",
        },
        "cody-invite": {
          agents: ["cody"],
          scopes: ["operator.read", "operator.write"],
          sessions: { others: "none" },
          sandbox: "required",
        },
      },
    },
  },
};

function context(): GatewayRequestContext {
  return {
    getRuntimeConfig: () => config,
    logGateway: { info: vi.fn() },
  } as unknown as GatewayRequestContext;
}

async function invoke(method: keyof typeof familyAgentHandlers, params: Record<string, unknown>) {
  const respond = vi.fn<RespondFn>();
  const handler = familyAgentHandlers[method];
  if (!handler) {
    throw new Error(`missing ${method} handler`);
  }
  await handler({
    req: { type: "req", id: "request-1", method, params },
    params,
    client: null,
    isWebchatConnect: () => false,
    respond,
    context: context(),
  });
  return respond;
}

describe("family agent handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.persistFamilyAgentPolicy.mockResolvedValue(config);
    mocks.adoptFamilyAgent.mockReturnValue({ familyAgent, adopted: true });
    mocks.readFamilyAgent.mockImplementation((agentId: string) =>
      agentId === "dev-dude" ? familyAgent : null,
    );
    mocks.regenerateAgentInvitation.mockReturnValue({
      invitation: {
        invitationId: "invite-1",
        agentId: "dev-dude",
        role: "dev-dude-invite",
        displayName: "Dev Dude",
        status: "pending",
        createdAtMs: 1_000,
        expiresAtMs: 2_000,
      },
      token: "secret-token",
    });
  });

  it("persists the restrictive config before recording an adopted existing agent", async () => {
    const respond = await invoke("family.agents.adopt", {
      agentId: "dev-dude",
      managerAgentId: "walter",
      invitationRole: "dev-dude-invite",
      relayUrl: "https://family.example.test",
      toolGrants: ["web_search", "memory_get"],
    });

    expect(mocks.persistFamilyAgentPolicy).toHaveBeenCalledWith({
      agentId: "dev-dude",
      managerAgentId: "walter",
      invitationRole: "dev-dude-invite",
      toolGrants: ["memory_get", "web_search"],
    });
    expect(mocks.persistFamilyAgentPolicy.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.adoptFamilyAgent.mock.invocationCallOrder[0] ?? 0,
    );
    expect(respond).toHaveBeenCalledWith(true, { familyAgent, adopted: true }, undefined);
  });

  it("validates relay configuration before rotating an invitation", async () => {
    mocks.readFamilyAgent.mockReturnValue({ ...familyAgent, relayUrl: "" });
    const respond = await invoke("family.invitations.regenerate", { agentId: "dev-dude" });

    expect(mocks.regenerateAgentInvitation).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "UNAVAILABLE",
        message: expect.stringContaining("family relay URL"),
      }),
    );
  });

  it("rejects ownership transfer before rewriting agent config", async () => {
    const respond = await invoke("family.agents.adopt", {
      agentId: "dev-dude",
      managerAgentId: "cody",
      invitationRole: "dev-dude-invite",
      relayUrl: "https://family.example.test",
    });

    expect(mocks.persistFamilyAgentPolicy).not.toHaveBeenCalled();
    expect(mocks.adoptFamilyAgent).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
  });

  it("rejects an enrolled member as another family agent's manager", async () => {
    const respond = await invoke("family.agents.adopt", {
      agentId: "cody",
      managerAgentId: "dev-dude",
      invitationRole: "cody-invite",
      relayUrl: "https://family.example.test",
    });

    expect(mocks.persistFamilyAgentPolicy).not.toHaveBeenCalled();
    expect(mocks.adoptFamilyAgent).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
  });

  it("returns the new token only inside the invite URL fragment", async () => {
    const respond = await invoke("family.invitations.regenerate", { agentId: "dev-dude" });

    expect(mocks.regenerateAgentInvitation).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "dev-dude", role: "dev-dude-invite" }),
    );
    expect(respond).toHaveBeenCalledWith(
      true,
      {
        invitation: expect.not.objectContaining({ token: expect.anything() }),
        inviteUrl: "https://family.example.test/agent/invite#secret-token",
      },
      undefined,
    );
  });
});
