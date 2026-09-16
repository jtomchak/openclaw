import type { Static } from "typebox";
import { Type } from "typebox";
import { AgentInvitationSchema } from "./agent-invitations.js";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";

const AgentId = Type.String({ minLength: 1, maxLength: 128 });
const RoleName = Type.String({ minLength: 1, maxLength: 128 });
const ToolId = Type.String({ minLength: 1, maxLength: 256 });

export const FamilyAgentLifecycleStateSchema = Type.Union([
  Type.Literal("active"),
  Type.Literal("setup_required"),
]);

export const FamilyAgentSchema = closedObject({
  agentId: AgentId,
  managerAgentId: AgentId,
  invitationRole: RoleName,
  relayUrl: NonEmptyString,
  displayName: Type.Optional(Type.String({ maxLength: 256 })),
  toolGrants: Type.Array(ToolId, { maxItems: 512, uniqueItems: true }),
  lifecycleState: FamilyAgentLifecycleStateSchema,
  adoptedAtMs: Type.Integer({ minimum: 0 }),
  updatedAtMs: Type.Integer({ minimum: 0 }),
});

export const FamilyAgentsAdoptParamsSchema = closedObject({
  agentId: AgentId,
  managerAgentId: AgentId,
  invitationRole: RoleName,
  relayUrl: NonEmptyString,
  displayName: Type.Optional(Type.String({ maxLength: 256 })),
  toolGrants: Type.Optional(Type.Array(ToolId, { maxItems: 512, uniqueItems: true })),
});
export const FamilyAgentsAdoptResultSchema = closedObject({
  familyAgent: FamilyAgentSchema,
  adopted: Type.Boolean(),
});

export const FamilyAgentsListParamsSchema = closedObject({});
export const FamilyAgentsListResultSchema = closedObject({
  familyAgents: Type.Array(FamilyAgentSchema),
});

export const FamilyAgentsUpdateGrantsParamsSchema = closedObject({
  agentId: AgentId,
  toolGrants: Type.Array(ToolId, { maxItems: 512, uniqueItems: true }),
});
export const FamilyAgentsUpdateGrantsResultSchema = closedObject({
  familyAgent: FamilyAgentSchema,
});

export const FamilyInvitationsRegenerateParamsSchema = closedObject({
  agentId: AgentId,
  expiresInMs: Type.Optional(Type.Integer({ minimum: 60_000, maximum: 7 * 24 * 60 * 60 * 1000 })),
});
export const FamilyInvitationsRegenerateResultSchema = closedObject({
  invitation: AgentInvitationSchema,
  inviteUrl: NonEmptyString,
});

export type FamilyAgent = Static<typeof FamilyAgentSchema>;
export type FamilyAgentsAdoptParams = Static<typeof FamilyAgentsAdoptParamsSchema>;
export type FamilyAgentsListParams = Static<typeof FamilyAgentsListParamsSchema>;
export type FamilyAgentsUpdateGrantsParams = Static<typeof FamilyAgentsUpdateGrantsParamsSchema>;
export type FamilyInvitationsRegenerateParams = Static<
  typeof FamilyInvitationsRegenerateParamsSchema
>;
