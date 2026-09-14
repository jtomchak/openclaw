import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";

const InvitationId = Type.String({ minLength: 1, maxLength: 128 });
const AgentId = Type.String({ minLength: 1, maxLength: 128 });
const RoleName = Type.String({ minLength: 1, maxLength: 128 });
const Thumbprint = Type.String({ minLength: 16, maxLength: 256 });

export const AgentInvitationStateSchema = Type.Union([
  Type.Literal("pending"),
  Type.Literal("redeeming"),
  Type.Literal("active"),
  Type.Literal("revocation_pending"),
  Type.Literal("revoked"),
  Type.Literal("expired"),
]);

export const AgentInvitationSchema = closedObject({
  invitationId: InvitationId,
  agentId: AgentId,
  role: RoleName,
  displayName: Type.Optional(Type.String({ maxLength: 256 })),
  state: AgentInvitationStateSchema,
  createdAtMs: Type.Integer({ minimum: 0 }),
  expiresAtMs: Type.Integer({ minimum: 0 }),
  redeemedAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
  revokedAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
  enrollmentKeyThumbprint: Type.Optional(Thumbprint),
  deviceId: Type.Optional(NonEmptyString),
});

export const AgentInvitationsCreateParamsSchema = closedObject({
  agentId: AgentId,
  role: RoleName,
  displayName: Type.Optional(Type.String({ maxLength: 256 })),
  expiresInMs: Type.Optional(Type.Integer({ minimum: 60_000, maximum: 7 * 24 * 60 * 60 * 1000 })),
});
export const AgentInvitationsCreateResultSchema = closedObject({
  invitation: AgentInvitationSchema,
  token: NonEmptyString,
});

export const AgentInvitationsRedeemParamsSchema = closedObject({
  token: NonEmptyString,
  enrollmentKeyThumbprint: Thumbprint,
  publicUrl: Type.Optional(NonEmptyString),
});
export const AgentInvitationsRedeemResultSchema = closedObject({
  invitation: AgentInvitationSchema,
  setupId: NonEmptyString,
  setupCode: NonEmptyString,
  setupExpiresAtMs: Type.Integer({ minimum: 0 }),
});

export const AgentInvitationsRevokeParamsSchema = closedObject({ invitationId: InvitationId });
export const AgentInvitationsStatusParamsSchema = closedObject({ invitationId: InvitationId });
export const AgentInvitationsStatusResultSchema = closedObject({
  invitation: AgentInvitationSchema,
});
export const AgentInvitationsRevokeResultSchema = closedObject({
  invitation: AgentInvitationSchema,
});

export type AgentInvitation = Static<typeof AgentInvitationSchema>;
export type AgentInvitationsCreateParams = Static<typeof AgentInvitationsCreateParamsSchema>;
export type AgentInvitationsCreateResult = Static<typeof AgentInvitationsCreateResultSchema>;
export type AgentInvitationsRedeemParams = Static<typeof AgentInvitationsRedeemParamsSchema>;
export type AgentInvitationsRedeemResult = Static<typeof AgentInvitationsRedeemResultSchema>;
export type AgentInvitationsRevokeParams = Static<typeof AgentInvitationsRevokeParamsSchema>;
export type AgentInvitationsStatusParams = Static<typeof AgentInvitationsStatusParamsSchema>;
export type AgentInvitationsStatusResult = Static<typeof AgentInvitationsStatusResultSchema>;
