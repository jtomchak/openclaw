import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";

const InviteId = Type.String({ minLength: 1, maxLength: 128 });
const AgentId = Type.String({ minLength: 1, maxLength: 128 });
const RoleName = Type.String({ minLength: 1, maxLength: 128 });
const Thumbprint = Type.String({ minLength: 16, maxLength: 256 });

export const FamilyInviteStateSchema = Type.Union([
  Type.Literal("pending"),
  Type.Literal("redeeming"),
  Type.Literal("active"),
  Type.Literal("revocation_pending"),
  Type.Literal("revoked"),
  Type.Literal("expired"),
]);

export const FamilyInviteSchema = closedObject({
  inviteId: InviteId,
  agentId: AgentId,
  role: RoleName,
  displayName: Type.Optional(Type.String({ maxLength: 256 })),
  state: FamilyInviteStateSchema,
  createdAtMs: Type.Integer({ minimum: 0 }),
  expiresAtMs: Type.Integer({ minimum: 0 }),
  redeemedAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
  revokedAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
  publicKeyThumbprint: Type.Optional(Thumbprint),
  deviceId: Type.Optional(NonEmptyString),
});

export const FamilyInvitesCreateParamsSchema = closedObject({
  agentId: AgentId,
  role: RoleName,
  displayName: Type.Optional(Type.String({ maxLength: 256 })),
  expiresInMs: Type.Optional(Type.Integer({ minimum: 60_000, maximum: 7 * 24 * 60 * 60 * 1000 })),
});
export const FamilyInvitesCreateResultSchema = closedObject({
  invite: FamilyInviteSchema,
  token: NonEmptyString,
});

export const FamilyInvitesRedeemParamsSchema = closedObject({
  token: NonEmptyString,
  publicKeyThumbprint: Thumbprint,
  relayUrl: Type.Optional(NonEmptyString),
});
export const FamilyInvitesRedeemResultSchema = closedObject({
  invite: FamilyInviteSchema,
  setupId: NonEmptyString,
  setupCode: NonEmptyString,
  setupExpiresAtMs: Type.Integer({ minimum: 0 }),
});

export const FamilyInvitesRevokeParamsSchema = closedObject({ inviteId: InviteId });
export const FamilyInvitesStatusParamsSchema = closedObject({ inviteId: InviteId });
export const FamilyInvitesStatusResultSchema = closedObject({ invite: FamilyInviteSchema });
export const FamilyInvitesRevokeResultSchema = closedObject({ invite: FamilyInviteSchema });

export type FamilyInvite = Static<typeof FamilyInviteSchema>;
export type FamilyInvitesCreateParams = Static<typeof FamilyInvitesCreateParamsSchema>;
export type FamilyInvitesCreateResult = Static<typeof FamilyInvitesCreateResultSchema>;
export type FamilyInvitesRedeemParams = Static<typeof FamilyInvitesRedeemParamsSchema>;
export type FamilyInvitesRedeemResult = Static<typeof FamilyInvitesRedeemResultSchema>;
export type FamilyInvitesRevokeParams = Static<typeof FamilyInvitesRevokeParamsSchema>;
export type FamilyInvitesStatusParams = Static<typeof FamilyInvitesStatusParamsSchema>;
export type FamilyInvitesStatusResult = Static<typeof FamilyInvitesStatusResultSchema>;
