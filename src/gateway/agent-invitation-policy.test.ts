import { describe, expect, it } from "vitest";
import type { GatewayOperatorRoleDefinition } from "../config/types.gateway.js";
import type { OpenClawConfig } from "../config/types.js";
import { isScopedAgentInvitationPolicy } from "./agent-invitation-policy.js";

function config(role: GatewayOperatorRoleDefinition): OpenClawConfig {
  return {
    agents: { list: [{ id: "restricted" }, { id: "sibling" }] },
    gateway: { roles: { default: "restricted-role", definitions: { "restricted-role": role } } },
  };
}

const restrictiveRole: GatewayOperatorRoleDefinition = {
  agents: ["restricted"],
  scopes: ["operator.read", "operator.write"],
  sessions: { others: "none" },
  sandbox: "required",
};

const escapingRoles: GatewayOperatorRoleDefinition[] = [
  { ...restrictiveRole, agents: ["restricted", "sibling"] },
  { ...restrictiveRole, agents: "*" },
  { ...restrictiveRole, scopes: ["operator.read", "operator.admin"] },
  { ...restrictiveRole, sessions: { others: "view" } },
  { ...restrictiveRole, sandbox: "inherit" },
];

describe("agent invitation policy", () => {
  it("accepts only a restrictive role assigned to the requested existing agent", () => {
    expect(
      isScopedAgentInvitationPolicy({
        cfg: config(restrictiveRole),
        agentId: "restricted",
        role: "restricted-role",
      }),
    ).toBe(true);
    expect(
      isScopedAgentInvitationPolicy({
        cfg: config(restrictiveRole),
        agentId: "sibling",
        role: "restricted-role",
      }),
    ).toBe(false);
  });

  it.each(escapingRoles)("rejects a role that can escape its agent boundary", (role) => {
    expect(
      isScopedAgentInvitationPolicy({
        cfg: config(role),
        agentId: "restricted",
        role: "restricted-role",
      }),
    ).toBe(false);
  });
});
