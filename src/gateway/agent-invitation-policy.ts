import { normalizeAgentId } from "@openclaw/normalization-core/agent-id";
import { listAgentIds } from "../agents/agent-scope-config.js";
import type { OpenClawConfig } from "../config/types.js";

/** Invitations may reference only an existing, fail-closed, single-agent role. */
export function isScopedAgentInvitationPolicy(params: {
  cfg: OpenClawConfig;
  agentId: string;
  role: string;
}): boolean {
  const agentId = normalizeAgentId(params.agentId);
  if (!agentId || !listAgentIds(params.cfg).includes(agentId)) {
    return false;
  }
  const definition = params.cfg.gateway?.roles?.definitions?.[params.role];
  return Boolean(
    definition &&
    definition.agents !== "*" &&
    definition.agents.length === 1 &&
    normalizeAgentId(definition.agents[0]) === agentId &&
    definition.sessions.others === "none" &&
    definition.sandbox === "required" &&
    !definition.scopes.includes("operator.admin"),
  );
}
