import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayRequestHandlerOptions } from "./types.js";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  mutate: vi.fn(),
  resolveProfile: vi.fn(),
}));

vi.mock("../../state/family-domain.js", () => ({
  FamilyDomainConflictError: class FamilyDomainConflictError extends Error {},
  FamilyDomainInvalidError: class FamilyDomainInvalidError extends Error {},
  listFamilyRecords: mocks.list,
  mutateFamilyRecord: mocks.mutate,
}));
vi.mock("./users-profile-access.js", () => ({
  resolveAuthenticatedProfileId: mocks.resolveProfile,
}));

import { familyDomainHandlers } from "./family-domain.js";

function options(method: string, params: Record<string, unknown>, assignedAgentId?: string) {
  const respond = vi.fn();
  return {
    respond,
    value: {
      req: { type: "req", id: "request-1", method, params },
      method,
      params,
      client: {
        connect: { scopes: ["operator.write", "operator.read"] },
        internal: assignedAgentId ? { assignedAgentId } : {},
      },
      respond,
      context: {},
    } as unknown as GatewayRequestHandlerOptions,
  };
}

async function invoke(
  method: keyof typeof familyDomainHandlers,
  value: GatewayRequestHandlerOptions,
) {
  await expectDefined(familyDomainHandlers[method], `${method} handler test invariant`)(value);
}

beforeEach(() => {
  mocks.list.mockReset().mockReturnValue({ records: [], cursor: "MA", hasMore: false });
  mocks.mutate.mockReset().mockReturnValue({ record: { id: "goal-1" }, replayed: false });
  mocks.resolveProfile.mockReset().mockReturnValue("profile-1");
});

describe("Family domain Gateway methods", () => {
  it("fails closed without an authenticated single-agent assignment", async () => {
    const missing = options("family.bootstrap", {});
    await invoke("family.bootstrap", missing.value);
    expect(missing.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "FORBIDDEN" }),
    );
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it("derives profile and agent scope from the authenticated connection", async () => {
    const request = options(
      "family.goals.mutate",
      {
        operation: "create",
        idempotencyKey: "create-goal-1",
        payload: { title: "Learn guitar" },
      },
      "teen-agent",
    );
    await invoke("family.goals.mutate", request.value);
    expect(mocks.mutate).toHaveBeenCalledWith(
      { agentId: "teen-agent", profileId: "profile-1", kind: "goal" },
      request.value.params,
    );
  });

  it("returns live granted scopes in bootstrap capabilities", async () => {
    const request = options("family.bootstrap", {}, "teen-agent");
    await invoke("family.bootstrap", request.value);
    expect(request.respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ capabilities: ["operator.read", "operator.write"] }),
      undefined,
    );
  });
});
