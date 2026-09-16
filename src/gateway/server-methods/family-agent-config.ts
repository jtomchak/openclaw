import { applyFamilyAgentPolicyToConfig } from "../../agents/family-agent-policy.js";
import { mutateConfigFileWithRetry } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

export async function persistFamilyAgentPolicy(params: {
  agentId: string;
  managerAgentId: string;
  invitationRole: string;
  toolGrants: readonly string[];
}): Promise<OpenClawConfig> {
  const result = await mutateConfigFileWithRetry({
    afterWrite: { mode: "auto" },
    mutate: (draft) => {
      const next = applyFamilyAgentPolicyToConfig({
        config: draft,
        agentId: params.agentId,
        managerAgentId: params.managerAgentId,
        invitationRole: params.invitationRole,
        toolGrants: params.toolGrants,
      });
      Object.assign(draft, next);
    },
  });
  return result.nextConfig;
}
