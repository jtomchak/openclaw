import type { OpenClawConfig } from "../config/types.js";
import { getBoundDeviceBootstrapContext } from "../infra/device-bootstrap.js";
import {
  readFamilyInviteBySetupId,
  readLatestFamilyInviteForDevice,
  resolveActiveFamilyInviteForDevice,
  type FamilyInviteRecord,
} from "../state/family-invites.js";
import { isTrustedFamilyInvitePolicy } from "./family-invite-policy.js";

/** Resolve family identity only from Gateway-proved device/bootstrap material. */
export type FamilyInviteConnectResolution =
  | { kind: "not-family" }
  | { kind: "denied" }
  | { kind: "allowed"; invite: FamilyInviteRecord };

export async function resolveFamilyInviteForGatewayConnect(params: {
  cfg: OpenClawConfig;
  authMethod: string | undefined;
  bootstrapToken?: string;
  deviceId: string;
  gatewayPublicKey: string;
}): Promise<FamilyInviteConnectResolution> {
  let invite: FamilyInviteRecord | null = null;
  if (params.authMethod === "bootstrap-token" && params.bootstrapToken) {
    const context = await getBoundDeviceBootstrapContext({
      token: params.bootstrapToken,
      deviceId: params.deviceId,
      publicKey: params.gatewayPublicKey,
    });
    invite = context?.setupId ? readFamilyInviteBySetupId(context.setupId) : null;
    if (invite?.state !== "redeeming" && invite?.state !== "active") {
      return invite ? { kind: "denied" } : { kind: "not-family" };
    }
  } else if (params.authMethod === "device-token") {
    const known = readLatestFamilyInviteForDevice(params.deviceId);
    if (!known) return { kind: "not-family" };
    invite = resolveActiveFamilyInviteForDevice({
      deviceId: params.deviceId,
      gatewayPublicKey: params.gatewayPublicKey,
    });
  } else {
    return { kind: "not-family" };
  }
  if (
    !invite?.profileId ||
    !isTrustedFamilyInvitePolicy({ cfg: params.cfg, agentId: invite.agentId, role: invite.role })
  ) {
    return { kind: "denied" };
  }
  return { kind: "allowed", invite };
}
