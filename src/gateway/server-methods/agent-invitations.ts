import {
  ErrorCodes,
  errorShape,
  validateAgentInvitationsCreateParams,
  validateAgentInvitationsRedeemParams,
  validateAgentInvitationsRevokeParams,
  validateAgentInvitationsStatusParams,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  ensureDevicePairSetupBootstrapToken,
  readDevicePairSetupCompletion,
  revokeDeviceBootstrapTokenForSetupId,
} from "../../infra/device-bootstrap.js";
import { loadPairedDevicePairingStoreRecord } from "../../infra/device-pairing-store.js";
import { removePairedDevice } from "../../infra/device-pairing.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { encodePairingSetupCode, resolvePairingSetupFromConfig } from "../../pairing/setup-code.js";
import { PAIRING_SETUP_BOOTSTRAP_PROFILE } from "../../shared/device-bootstrap-profile.js";
import {
  beginAgentInvitationRevocation,
  bindAgentInvitationDevice,
  completeAgentInvitationRevocation,
  createAgentInvitation,
  readAgentInvitation,
  reserveAgentInvitationRedemption,
  type AgentInvitationRecord,
} from "../../state/agent-invitations.js";
import { isScopedAgentInvitationPolicy } from "../agent-invitation-policy.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

const DEFAULT_INVITATION_TTL_MS = 24 * 60 * 60 * 1000;
const SHA256_BASE64URL_RE = /^[A-Za-z0-9_-]{43}$/u;

function publicInvitation(invitation: AgentInvitationRecord) {
  const { setupId: _setupId, profileId: _profileId, gatewayPublicKey: _key, ...value } = invitation;
  return value;
}

function unavailable(
  respond: Parameters<GatewayRequestHandlers[string]>[0]["respond"],
  error: unknown,
) {
  respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatErrorMessage(error)));
}

export const agentInvitationHandlers: GatewayRequestHandlers = {
  "agent.invitations.create": ({ context, params, respond }) => {
    if (
      !assertValidParams(
        params,
        validateAgentInvitationsCreateParams,
        "agent.invitations.create",
        respond,
      )
    ) {
      return;
    }
    const cfg = context.getRuntimeConfig();
    if (!isScopedAgentInvitationPolicy({ cfg, agentId: params.agentId, role: params.role })) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "agent invitation requires an existing sandbox-required role limited to exactly the requested agent, no other sessions, and no operator.admin scope",
        ),
      );
      return;
    }
    try {
      const nowMs = Date.now();
      const result = createAgentInvitation({
        agentId: params.agentId,
        role: params.role,
        ...(params.displayName !== undefined ? { displayName: params.displayName } : {}),
        expiresAtMs: nowMs + (params.expiresInMs ?? DEFAULT_INVITATION_TTL_MS),
        nowMs,
      });
      context.logGateway.info(
        `security audit: agent invitation created invitation=${result.invitation.invitationId} agent=${result.invitation.agentId} role=${result.invitation.role}`,
      );
      respond(
        true,
        { invitation: publicInvitation(result.invitation), token: result.token },
        undefined,
      );
    } catch (error) {
      unavailable(respond, error);
    }
  },

  "agent.invitations.redeem": async ({ context, params, respond }) => {
    if (
      !assertValidParams(
        params,
        validateAgentInvitationsRedeemParams,
        "agent.invitations.redeem",
        respond,
      )
    ) {
      return;
    }
    if (!SHA256_BASE64URL_RE.test(params.enrollmentKeyThumbprint)) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid enrollment-key thumbprint"),
      );
      return;
    }
    const cfg = context.getRuntimeConfig();
    try {
      const reserved = reserveAgentInvitationRedemption({
        token: params.token,
        enrollmentKeyThumbprint: params.enrollmentKeyThumbprint,
        validatePolicy: (invitation) => isScopedAgentInvitationPolicy({ cfg, ...invitation }),
      });
      if (!reserved.ok) {
        const message =
          reserved.reason === "device_mismatch"
            ? "agent invitation is already bound to another enrollment key"
            : reserved.reason === "expired"
              ? "agent invitation has expired"
              : reserved.reason === "revoked"
                ? "agent invitation has been revoked"
                : reserved.reason === "invalid_policy"
                  ? "agent invitation role is no longer valid"
                  : "invalid agent invitation";
        respond(false, undefined, errorShape(ErrorCodes.FORBIDDEN, message));
        return;
      }
      if (!reserved.invitation.setupId) {
        throw new Error("reserved agent invitation is missing setup correlation");
      }
      const issued = await ensureDevicePairSetupBootstrapToken({
        setupId: reserved.invitation.setupId,
        profile: PAIRING_SETUP_BOOTSTRAP_PROFILE,
      });
      if (issued.status === "completed") {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.FORBIDDEN, "agent invitation has already been enrolled"),
        );
        return;
      }
      const setup = await resolvePairingSetupFromConfig(cfg, {
        env: process.env,
        ...(params.publicUrl ? { publicUrl: params.publicUrl } : {}),
        bootstrapProfile: PAIRING_SETUP_BOOTSTRAP_PROFILE,
        issuedBootstrap: issued,
        localTlsFingerprint: context.gatewayTlsFingerprint,
      });
      if (!setup.ok) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, setup.error));
        return;
      }
      context.logGateway.info(
        `security audit: agent invitation redemption reserved invitation=${reserved.invitation.invitationId} agent=${reserved.invitation.agentId} role=${reserved.invitation.role}`,
      );
      respond(
        true,
        {
          invitation: publicInvitation(reserved.invitation),
          setupId: setup.setupId,
          setupCode: encodePairingSetupCode(setup.payload),
          setupExpiresAtMs: setup.expiresAtMs,
        },
        undefined,
      );
    } catch (error) {
      unavailable(respond, error);
    }
  },

  "agent.invitations.status": ({ params, respond }) => {
    if (
      !assertValidParams(
        params,
        validateAgentInvitationsStatusParams,
        "agent.invitations.status",
        respond,
      )
    ) {
      return;
    }
    try {
      const invitation = readAgentInvitation(params.invitationId);
      if (!invitation) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "agent invitation not found"),
        );
        return;
      }
      respond(true, { invitation: publicInvitation(invitation) }, undefined);
    } catch (error) {
      unavailable(respond, error);
    }
  },

  "agent.invitations.revoke": async ({ context, params, respond }) => {
    if (
      !assertValidParams(
        params,
        validateAgentInvitationsRevokeParams,
        "agent.invitations.revoke",
        respond,
      )
    ) {
      return;
    }
    try {
      let current = readAgentInvitation(params.invitationId);
      if (!current) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "agent invitation not found"),
        );
        return;
      }
      if (!current.deviceId && current.setupId) {
        const completion = await readDevicePairSetupCompletion({ setupId: current.setupId });
        if (completion) {
          const pairedDevice = loadPairedDevicePairingStoreRecord(completion.deviceId);
          const paired = pairedDevice
            ? bindAgentInvitationDevice({
                setupId: current.setupId,
                deviceId: completion.deviceId,
                gatewayPublicKey: pairedDevice.publicKey,
              })
            : null;
          current = paired ?? current;
        }
      }
      const begun = beginAgentInvitationRevocation(params.invitationId);
      if (!begun) {
        throw new Error("agent invitation disappeared during revocation");
      }
      context.logGateway.info(
        `security audit: agent invitation revocation started invitation=${begun.invitationId} agent=${begun.agentId} device=${begun.deviceId ?? "unbound"}`,
      );
      if (begun.setupId) {
        await revokeDeviceBootstrapTokenForSetupId({ setupId: begun.setupId });
      }
      if (begun.deviceId) {
        await removePairedDevice(begun.deviceId);
        context.disconnectClientsForDevice?.(begun.deviceId);
      }
      const invitation = completeAgentInvitationRevocation(params.invitationId) ?? begun;
      context.logGateway.info(
        `security audit: agent invitation revoked invitation=${invitation.invitationId} agent=${invitation.agentId} device=${invitation.deviceId ?? "unbound"}`,
      );
      respond(true, { invitation: publicInvitation(invitation) }, undefined);
    } catch (error) {
      unavailable(respond, error);
    }
  },
};
