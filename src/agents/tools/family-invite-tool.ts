import { Type } from "typebox";
import { listManagedFamilyAgents } from "../../state/family-agents.js";
import { stringEnum } from "../schema/typebox.js";
import { type AnyAgentTool, jsonResult, readToolStringParam, ToolInputError } from "./common.js";
import { callInProcessGatewayTool, getInProcessGatewayToolContext } from "./in-process-gateway.js";

const FamilyInviteToolSchema = Type.Object({
  action: stringEnum(["list", "regenerate"]),
  agentId: Type.Optional(
    Type.String({ description: "Required for regenerate; must be a managed family agent id." }),
  ),
});

type RegenerateResult = {
  invitation: { invitationId: string; agentId: string; expiresAtMs: number; state: string };
  inviteUrl: string;
};

export function createFamilyInviteTool(managerAgentId: string): AnyAgentTool {
  return {
    label: "Family invites",
    name: "family_invite",
    description:
      "List family agents managed by this agent or regenerate a one-time invite link. Regeneration invalidates older unfinished links but keeps enrolled devices connected.",
    parameters: FamilyInviteToolSchema,
    execute: async (_toolCallId, args, signal) => {
      if (!args || typeof args !== "object" || Array.isArray(args)) {
        throw new ToolInputError("Family invite parameters must be an object.");
      }
      const params = Object.fromEntries(Object.entries(args));
      const action = readToolStringParam(params, "action", { required: true });
      const managed = listManagedFamilyAgents(managerAgentId);
      if (action === "list") {
        return jsonResult({ ok: true, familyAgents: managed });
      }
      if (action !== "regenerate") {
        throw new ToolInputError(`Unknown action: ${action}`);
      }
      const agentId = readToolStringParam(params, "agentId", { required: true });
      if (!managed.some((entry) => entry.agentId === agentId)) {
        return jsonResult({
          ok: false,
          code: "family_agent_not_managed",
          message: `Agent ${agentId} is not a family agent managed by ${managerAgentId}.`,
        });
      }
      const result = await callInProcessGatewayTool<RegenerateResult>(
        "family.invitations.regenerate",
        { agentId },
        { resolveGatewayContext: getInProcessGatewayToolContext, signal },
      );
      return jsonResult({ ok: true, ...result });
    },
  };
}
