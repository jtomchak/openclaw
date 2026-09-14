import {
  ErrorCodes,
  errorShape,
  validateFamilyInvitesCreateParams,
  validateFamilyInvitesRedeemParams,
  validateFamilyInvitesRevokeParams,
  validateFamilyInvitesStatusParams,
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
  beginFamilyInviteRevocation,
  bindFamilyInviteDevice,
  completeFamilyInviteRevocation,
  createFamilyInvite,
  readFamilyInvite,
  reserveFamilyInviteRedemption,
  type FamilyInviteRecord,
} from "../../state/family-invites.js";
import { isTrustedFamilyInvitePolicy } from "../family-invite-policy.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

const DEFAULT_INVITE_TTL_MS = 24 * 60 * 60 * 1000;
const P256_THUMBPRINT_RE = /^[A-Za-z0-9_-]{43}$/u;

function publicInvite(invite: FamilyInviteRecord) {
  const { setupId: _setupId, profileId: _profileId, gatewayPublicKey: _key, ...value } = invite;
  return value;
}

function unavailable(
  respond: Parameters<GatewayRequestHandlers[string]>[0]["respond"],
  error: unknown,
) {
  respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatErrorMessage(error)));
}

export const familyInviteHandlers: GatewayRequestHandlers = {
  "family.invites.create": ({ context, params, respond }) => {
    if (
      !assertValidParams(
        params,
        validateFamilyInvitesCreateParams,
        "family.invites.create",
        respond,
      )
    ) {
      return;
    }
    const cfg = context.getRuntimeConfig();
    if (!isTrustedFamilyInvitePolicy({ cfg, agentId: params.agentId, role: params.role })) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "family invite requires an existing sandbox-required role limited to exactly the requested agent, no other sessions, and no operator.admin scope",
        ),
      );
      return;
    }
    try {
      const nowMs = Date.now();
      const result = createFamilyInvite({
        agentId: params.agentId,
        role: params.role,
        ...(params.displayName !== undefined ? { displayName: params.displayName } : {}),
        expiresAtMs: nowMs + (params.expiresInMs ?? DEFAULT_INVITE_TTL_MS),
        nowMs,
      });
      respond(true, { invite: publicInvite(result.invite), token: result.token }, undefined);
    } catch (error) {
      unavailable(respond, error);
    }
  },

  "family.invites.redeem": async ({ context, params, respond }) => {
    if (
      !assertValidParams(
        params,
        validateFamilyInvitesRedeemParams,
        "family.invites.redeem",
        respond,
      )
    ) {
      return;
    }
    if (!P256_THUMBPRINT_RE.test(params.publicKeyThumbprint)) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid device public-key thumbprint"),
      );
      return;
    }
    const cfg = context.getRuntimeConfig();
    try {
      const reserved = reserveFamilyInviteRedemption({
        token: params.token,
        publicKeyThumbprint: params.publicKeyThumbprint,
        validatePolicy: (invite) => isTrustedFamilyInvitePolicy({ cfg, ...invite }),
      });
      if (!reserved.ok) {
        const message =
          reserved.reason === "device_mismatch"
            ? "family invite is already bound to another device"
            : reserved.reason === "expired"
              ? "family invite has expired"
              : reserved.reason === "revoked"
                ? "family invite has been revoked"
                : reserved.reason === "invalid_policy"
                  ? "family invite role is no longer valid"
                  : "invalid family invite";
        respond(false, undefined, errorShape(ErrorCodes.FORBIDDEN, message));
        return;
      }
      if (!reserved.invite.setupId) {
        throw new Error("reserved family invitation is missing setup correlation");
      }
      const issued = await ensureDevicePairSetupBootstrapToken({
        setupId: reserved.invite.setupId,
        profile: PAIRING_SETUP_BOOTSTRAP_PROFILE,
      });
      if (issued.status === "completed") {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.FORBIDDEN, "family invite has already been enrolled"),
        );
        return;
      }
      const setup = await resolvePairingSetupFromConfig(cfg, {
        env: process.env,
        ...(params.relayUrl ? { publicUrl: params.relayUrl } : {}),
        bootstrapProfile: PAIRING_SETUP_BOOTSTRAP_PROFILE,
        issuedBootstrap: issued,
        localTlsFingerprint: context.gatewayTlsFingerprint,
      });
      if (!setup.ok) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, setup.error));
        return;
      }
      respond(
        true,
        {
          invite: publicInvite(reserved.invite),
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

  "family.invites.status": ({ params, respond }) => {
    if (
      !assertValidParams(
        params,
        validateFamilyInvitesStatusParams,
        "family.invites.status",
        respond,
      )
    ) {
      return;
    }
    try {
      const invite = readFamilyInvite(params.inviteId);
      if (!invite) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "family invite not found"),
        );
        return;
      }
      respond(true, { invite: publicInvite(invite) }, undefined);
    } catch (error) {
      unavailable(respond, error);
    }
  },

  "family.invites.revoke": async ({ context, params, respond }) => {
    if (
      !assertValidParams(
        params,
        validateFamilyInvitesRevokeParams,
        "family.invites.revoke",
        respond,
      )
    ) {
      return;
    }
    try {
      let current = readFamilyInvite(params.inviteId);
      if (!current) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "family invite not found"),
        );
        return;
      }
      if (!current.deviceId && current.setupId) {
        const completion = await readDevicePairSetupCompletion({ setupId: current.setupId });
        if (completion) {
          const pairedDevice = loadPairedDevicePairingStoreRecord(completion.deviceId);
          const paired = pairedDevice
            ? bindFamilyInviteDevice({
                setupId: current.setupId,
                deviceId: completion.deviceId,
                gatewayPublicKey: pairedDevice.publicKey,
              })
            : null;
          current = paired ?? current;
        }
      }
      const begun = beginFamilyInviteRevocation(params.inviteId);
      if (!begun) {
        throw new Error("family invite disappeared during revocation");
      }
      if (begun.setupId) {
        await revokeDeviceBootstrapTokenForSetupId({ setupId: begun.setupId });
      }
      if (begun.deviceId) {
        await removePairedDevice(begun.deviceId);
        context.disconnectClientsForDevice?.(begun.deviceId);
      }
      const invite = completeFamilyInviteRevocation(params.inviteId) ?? begun;
      respond(true, { invite: publicInvite(invite) }, undefined);
    } catch (error) {
      unavailable(respond, error);
    }
  },
};
