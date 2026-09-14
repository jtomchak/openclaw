import { describe, expect, it } from "vitest";
import type { GatewayOperatorRoleDefinition } from "../config/types.gateway.js";
import type { OpenClawConfig } from "../config/types.js";
import { isTrustedFamilyInvitePolicy } from "./family-invite-policy.js";

function config(role: GatewayOperatorRoleDefinition): OpenClawConfig {
  return {
    agents: { list: [{ id: "family" }, { id: "sibling" }] },
    gateway: { roles: { default: "family-role", definitions: { "family-role": role } } },
  };
}

const restrictiveRole: GatewayOperatorRoleDefinition = {
  agents: ["family"],
  scopes: ["operator.read", "operator.write"],
  sessions: { others: "none" },
  sandbox: "required",
};

const escapingRoles: GatewayOperatorRoleDefinition[] = [
  { ...restrictiveRole, agents: ["family", "sibling"] },
  { ...restrictiveRole, agents: "*" },
  { ...restrictiveRole, scopes: ["operator.read", "operator.admin"] },
  { ...restrictiveRole, sessions: { others: "view" } },
  { ...restrictiveRole, sandbox: "inherit" },
];

describe("family invite policy", () => {
  it("accepts only a restrictive role assigned to the requested existing agent", () => {
    expect(
      isTrustedFamilyInvitePolicy({
        cfg: config(restrictiveRole),
        agentId: "family",
        role: "family-role",
      }),
    ).toBe(true);
    expect(
      isTrustedFamilyInvitePolicy({
        cfg: config(restrictiveRole),
        agentId: "sibling",
        role: "family-role",
      }),
    ).toBe(false);
  });

  it.each(escapingRoles)("rejects a role that can escape its family-agent boundary", (role) => {
    expect(
      isTrustedFamilyInvitePolicy({
        cfg: config(role),
        agentId: "family",
        role: "family-role",
      }),
    ).toBe(false);
  });
});
