import type { OpenClawConfig } from "../config/types.js";
import { getBoundDeviceBootstrapContext } from "../infra/device-bootstrap.js";
import {
  readAgentInvitationBySetupId,
  readLatestAgentInvitationForDevice,
  resolveActiveAgentInvitationForDevice,
  type AgentInvitationRecord,
} from "../state/agent-invitations.js";
import { isScopedAgentInvitationPolicy } from "./agent-invitation-policy.js";

/** Resolve invitation identity only from Gateway-proved device/bootstrap material. */
export type AgentInvitationConnectResolution =
  | { kind: "not-invited" }
  | { kind: "denied" }
  | { kind: "allowed"; invitation: AgentInvitationRecord };

export async function resolveAgentInvitationForGatewayConnect(params: {
  cfg: OpenClawConfig;
  authMethod: string | undefined;
  bootstrapToken?: string;
  deviceId: string;
  gatewayPublicKey: string;
}): Promise<AgentInvitationConnectResolution> {
  let invitation: AgentInvitationRecord | null = null;
  if (params.authMethod === "bootstrap-token" && params.bootstrapToken) {
    const context = await getBoundDeviceBootstrapContext({
      token: params.bootstrapToken,
      deviceId: params.deviceId,
      publicKey: params.gatewayPublicKey,
    });
    invitation = context?.setupId ? readAgentInvitationBySetupId(context.setupId) : null;
    if (invitation?.state !== "redeeming" && invitation?.state !== "active") {
      return invitation ? { kind: "denied" } : { kind: "not-invited" };
    }
  } else if (params.authMethod === "device-token") {
    const known = readLatestAgentInvitationForDevice(params.deviceId);
    if (!known) {
      return { kind: "not-invited" };
    }
    invitation = resolveActiveAgentInvitationForDevice({
      deviceId: params.deviceId,
      gatewayPublicKey: params.gatewayPublicKey,
    });
  } else {
    return { kind: "not-invited" };
  }
  if (
    !invitation?.profileId ||
    !isScopedAgentInvitationPolicy({
      cfg: params.cfg,
      agentId: invitation.agentId,
      role: invitation.role,
    })
  ) {
    return { kind: "denied" };
  }
  return { kind: "allowed", invitation };
}
