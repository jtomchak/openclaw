import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";

export const FAMILY_SYNC_DEFAULT_LIMIT = 100;
export const FAMILY_SYNC_MAX_LIMIT = 500;

export const FamilyRecordKindSchema = Type.Union([
  Type.Literal("feed_item"),
  Type.Literal("idea"),
  Type.Literal("goal"),
  Type.Literal("library_item"),
  Type.Literal("action_request"),
]);

export const FamilyRecordVisibilitySchema = Type.Union([
  Type.Literal("private"),
  Type.Literal("shared_with_organizers"),
]);

export const FamilyRecordLifecycleStateSchema = Type.Union([
  Type.Literal("proposed"),
  Type.Literal("active"),
  Type.Literal("completed"),
  Type.Literal("dismissed"),
  Type.Literal("archived"),
]);

export const FamilyRecordProvenanceSchema = closedObject({
  actorType: Type.Union([
    Type.Literal("teen"),
    Type.Literal("parent"),
    Type.Literal("agent"),
    Type.Literal("system"),
  ]),
  actorId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
  source: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
});

export const FamilyRecordSchema = closedObject({
  id: NonEmptyString,
  kind: FamilyRecordKindSchema,
  revision: Type.Integer({ minimum: 1 }),
  sequence: Type.Integer({ minimum: 1 }),
  visibility: FamilyRecordVisibilitySchema,
  lifecycleState: FamilyRecordLifecycleStateSchema,
  provenance: FamilyRecordProvenanceSchema,
  payload: Type.Unknown(),
  createdAtMs: Type.Integer({ minimum: 0 }),
  updatedAtMs: Type.Integer({ minimum: 0 }),
  deletedAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
});

export const FamilyListParamsSchema = closedObject({
  cursor: Type.Optional(Type.String({ maxLength: 128 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: FAMILY_SYNC_MAX_LIMIT })),
});

export const FamilyListResultSchema = closedObject({
  records: Type.Array(FamilyRecordSchema, { maxItems: FAMILY_SYNC_MAX_LIMIT }),
  cursor: NonEmptyString,
  hasMore: Type.Boolean(),
});

export const FamilyBootstrapParamsSchema = closedObject({});
export const FamilyBootstrapResultSchema = closedObject({
  records: Type.Array(FamilyRecordSchema, { maxItems: FAMILY_SYNC_MAX_LIMIT }),
  cursor: NonEmptyString,
  hasMore: Type.Boolean(),
  capabilities: Type.Array(NonEmptyString, { maxItems: 128 }),
});

export const FamilyMutationOperationSchema = Type.Union([
  Type.Literal("create"),
  Type.Literal("update"),
  Type.Literal("delete"),
]);

export const FamilyMutateParamsSchema = closedObject({
  operation: FamilyMutationOperationSchema,
  id: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  expectedRevision: Type.Optional(Type.Integer({ minimum: 1 })),
  idempotencyKey: Type.String({ minLength: 8, maxLength: 128 }),
  visibility: Type.Optional(FamilyRecordVisibilitySchema),
  lifecycleState: Type.Optional(FamilyRecordLifecycleStateSchema),
  payload: Type.Optional(Type.Unknown()),
});

export const FamilyMutateResultSchema = closedObject({
  record: FamilyRecordSchema,
  replayed: Type.Boolean(),
});

export type FamilyRecordKind = Static<typeof FamilyRecordKindSchema>;
export type FamilyRecord = Static<typeof FamilyRecordSchema>;
export type FamilyListParams = Static<typeof FamilyListParamsSchema>;
export type FamilyListResult = Static<typeof FamilyListResultSchema>;
export type FamilyBootstrapParams = Static<typeof FamilyBootstrapParamsSchema>;
export type FamilyBootstrapResult = Static<typeof FamilyBootstrapResultSchema>;
export type FamilySyncParams = FamilyListParams;
export type FamilySyncResult = FamilyListResult;
export type FamilyMutateParams = Static<typeof FamilyMutateParamsSchema>;
export type FamilyMutateResult = Static<typeof FamilyMutateResultSchema>;
