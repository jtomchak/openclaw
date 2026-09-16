import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  validateFamilyAgentsAdoptParams,
  validateFamilyAgentsListParams,
  validateFamilyAgentsUpdateGrantsParams,
  validateFamilyInvitationsRegenerateParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { listAgentIds, resolveAgentConfig } from "../../agents/agent-scope.js";
import {
  FamilyAgentPolicyError,
  listDefaultFamilyAgentToolGrants,
  normalizeFamilyAgentToolGrants,
} from "../../agents/family-agent-policy.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createAsyncLock } from "../../infra/json-files.js";
import { normalizeAgentIdStrict } from "../../routing/session-key.js";
import {
  regenerateAgentInvitation,
  type AgentInvitationRecord,
} from "../../state/agent-invitations.js";
import {
  adoptFamilyAgent,
  FamilyAgentConflictError,
  listFamilyAgents,
  readFamilyAgent,
  updateFamilyAgentToolGrants,
} from "../../state/family-agents.js";
import { isScopedAgentInvitationPolicy } from "../agent-invitation-policy.js";
import { persistFamilyAgentPolicy } from "./family-agent-config.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

const DEFAULT_INVITATION_TTL_MS = 24 * 60 * 60 * 1000;
const withFamilyAgentMutation = createAsyncLock();

function publicInvitation(invitation: AgentInvitationRecord) {
  const { setupId: _setupId, profileId: _profileId, gatewayPublicKey: _key, ...value } = invitation;
  return value;
}

function resolveRelayBaseUrl(rawInput: string): URL {
  const raw = normalizeOptionalString(rawInput);
  if (!raw) {
    throw new Error("family relay URL is required to generate invite links");
  }
  const url = new URL(raw);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("family relay URL must be an HTTPS origin without a path");
  }
  return url;
}

export function formatFamilyInviteUrl(relayBaseUrl: URL, token: string): string {
  const url = new URL("/agent/invite", relayBaseUrl);
  url.hash = token;
  return url.toString();
}

function normalizedConfiguredAgentId(raw: string, configured: readonly string[]): string | null {
  const normalized = normalizeAgentIdStrict(raw);
  if (!normalized.ok || !configured.includes(normalized.value)) {
    return null;
  }
  return normalized.value;
}

export const familyAgentHandlers: GatewayRequestHandlers = {
  "family.agents.adopt": async ({ context, params, respond }) => {
    if (
      !assertValidParams(params, validateFamilyAgentsAdoptParams, "family.agents.adopt", respond)
    ) {
      return;
    }
    const cfg = context.getRuntimeConfig();
    const configured = listAgentIds(cfg);
    const agentId = normalizedConfiguredAgentId(params.agentId, configured);
    const managerAgentId = normalizedConfiguredAgentId(params.managerAgentId, configured);
    if (!agentId || !managerAgentId || agentId === managerAgentId) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "family adoption requires distinct configured agent and manager ids",
        ),
      );
      return;
    }
    if (!isScopedAgentInvitationPolicy({ cfg, agentId, role: params.invitationRole })) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "family invitation role must be sandbox-required and limited to the adopted agent",
        ),
      );
      return;
    }
    const toolGrants = normalizeFamilyAgentToolGrants(
      params.toolGrants ?? listDefaultFamilyAgentToolGrants(),
    );
    try {
      const result = await withFamilyAgentMutation(async () => {
        const existing = readFamilyAgent(agentId);
        if (
          existing &&
          (existing.managerAgentId !== managerAgentId ||
            existing.invitationRole !== params.invitationRole)
        ) {
          throw new FamilyAgentConflictError(
            `agent ${agentId} is already adopted by another family policy`,
          );
        }
        if (readFamilyAgent(managerAgentId)) {
          throw new FamilyAgentConflictError(
            `family member ${managerAgentId} cannot manage another family agent`,
          );
        }
        const relayUrl = resolveRelayBaseUrl(params.relayUrl).origin;
        await persistFamilyAgentPolicy({
          agentId,
          managerAgentId,
          invitationRole: params.invitationRole,
          toolGrants,
        });
        return adoptFamilyAgent({
          agentId,
          managerAgentId,
          invitationRole: params.invitationRole,
          displayName: params.displayName ?? resolveAgentConfig(cfg, agentId)?.name,
          relayUrl,
          toolGrants,
        });
      });
      context.logGateway.info(
        `security audit: family agent adopted agent=${agentId} manager=${managerAgentId} role=${params.invitationRole}`,
      );
      respond(true, result, undefined);
    } catch (error) {
      const code =
        error instanceof FamilyAgentConflictError || error instanceof FamilyAgentPolicyError
          ? ErrorCodes.INVALID_REQUEST
          : ErrorCodes.UNAVAILABLE;
      respond(false, undefined, errorShape(code, formatErrorMessage(error)));
    }
  },

  "family.agents.list": ({ params, respond }) => {
    if (!assertValidParams(params, validateFamilyAgentsListParams, "family.agents.list", respond)) {
      return;
    }
    respond(true, { familyAgents: listFamilyAgents() }, undefined);
  },

  "family.agents.updateGrants": async ({ context, params, respond }) => {
    if (
      !assertValidParams(
        params,
        validateFamilyAgentsUpdateGrantsParams,
        "family.agents.updateGrants",
        respond,
      )
    ) {
      return;
    }
    const familyAgent = readFamilyAgent(params.agentId);
    if (!familyAgent) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "family agent not found"));
      return;
    }
    const toolGrants = normalizeFamilyAgentToolGrants(params.toolGrants);
    try {
      const updated = await withFamilyAgentMutation(async () => {
        const current = readFamilyAgent(familyAgent.agentId);
        if (!current) {
          throw new Error("family agent disappeared during grant update");
        }
        await persistFamilyAgentPolicy({
          agentId: current.agentId,
          managerAgentId: current.managerAgentId,
          invitationRole: current.invitationRole,
          toolGrants,
        });
        return updateFamilyAgentToolGrants(current.agentId, toolGrants);
      });
      if (!updated) {
        throw new Error("family agent disappeared during grant update");
      }
      context.logGateway.info(
        `security audit: family agent grants updated agent=${familyAgent.agentId} manager=${familyAgent.managerAgentId}`,
      );
      respond(true, { familyAgent: updated }, undefined);
    } catch (error) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatErrorMessage(error)));
    }
  },

  "family.invitations.regenerate": ({ context, params, respond }) => {
    if (
      !assertValidParams(
        params,
        validateFamilyInvitationsRegenerateParams,
        "family.invitations.regenerate",
        respond,
      )
    ) {
      return;
    }
    const familyAgent = readFamilyAgent(params.agentId);
    if (!familyAgent) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "family agent not found"));
      return;
    }
    const cfg = context.getRuntimeConfig();
    if (
      !isScopedAgentInvitationPolicy({
        cfg,
        agentId: familyAgent.agentId,
        role: familyAgent.invitationRole,
      })
    ) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "family invitation role is no longer valid"),
      );
      return;
    }
    try {
      const relayBaseUrl = resolveRelayBaseUrl(familyAgent.relayUrl);
      const nowMs = Date.now();
      const result = regenerateAgentInvitation({
        agentId: familyAgent.agentId,
        role: familyAgent.invitationRole,
        displayName: familyAgent.displayName,
        expiresAtMs: nowMs + (params.expiresInMs ?? DEFAULT_INVITATION_TTL_MS),
        nowMs,
      });
      const inviteUrl = formatFamilyInviteUrl(relayBaseUrl, result.token);
      context.logGateway.info(
        `security audit: family invitation regenerated invitation=${result.invitation.invitationId} agent=${familyAgent.agentId} manager=${familyAgent.managerAgentId}`,
      );
      respond(true, { invitation: publicInvitation(result.invitation), inviteUrl }, undefined);
    } catch (error) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatErrorMessage(error)));
    }
  },
};
