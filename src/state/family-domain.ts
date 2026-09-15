import { createHash, randomUUID } from "node:crypto";
import { stableStringify } from "@openclaw/normalization-core";
import type {
  FamilyMutateParams,
  FamilyRecord,
  FamilyRecordKind,
} from "../../packages/gateway-protocol/src/schema/family-domain.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { ensureFamilyDomainSchema } from "./openclaw-state-db-schema-additive.js";
import type {
  DB as OpenClawStateKyselyDatabase,
  FamilyRecords,
} from "./openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "./openclaw-state-db.js";

const MAX_PAYLOAD_BYTES = 64 * 1024;

export class FamilyDomainConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FamilyDomainConflictError";
  }
}

export class FamilyDomainInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FamilyDomainInvalidError";
  }
}

function prepare(options: OpenClawStateDatabaseOptions) {
  const database = openOpenClawStateDatabase(options);
  runOpenClawStateWriteTransaction(
    ({ db }) => ensureFamilyDomainSchema(db),
    { ...options, database },
    { operationLabel: "family-domain.schema.ensure" },
  );
  return database;
}

function parseObject(value: string, label: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new FamilyDomainInvalidError(`${label} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function toRecord(row: FamilyRecords): FamilyRecord {
  return {
    id: row.record_id,
    kind: row.kind as FamilyRecordKind,
    revision: row.revision,
    sequence: row.change_sequence,
    visibility: row.visibility as FamilyRecord["visibility"],
    lifecycleState: row.lifecycle_state as FamilyRecord["lifecycleState"],
    provenance: parseObject(
      row.provenance_json,
      "stored Family provenance",
    ) as FamilyRecord["provenance"],
    payload: parseObject(row.payload_json, "stored Family payload"),
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
    ...(row.deleted_at_ms !== null ? { deletedAtMs: row.deleted_at_ms } : {}),
  };
}

function payloadJson(payload: unknown): string {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new FamilyDomainInvalidError("Family record payload must be a JSON object");
  }
  const json = stableStringify(payload);
  if (Buffer.byteLength(json, "utf8") > MAX_PAYLOAD_BYTES) {
    throw new FamilyDomainInvalidError(`Family record payload exceeds ${MAX_PAYLOAD_BYTES} bytes`);
  }
  return json;
}

function requestHash(kind: FamilyRecordKind, params: FamilyMutateParams): string {
  return createHash("sha256").update(stableStringify({ kind, params })).digest("hex");
}

export function encodeFamilyCursor(sequence: number): string {
  return Buffer.from(String(sequence), "utf8").toString("base64url");
}

export function decodeFamilyCursor(cursor: string | undefined): number {
  if (!cursor) {
    return 0;
  }
  const decoded = Buffer.from(cursor, "base64url").toString("utf8");
  if (!/^(?:0|[1-9][0-9]*)$/u.test(decoded)) {
    throw new FamilyDomainInvalidError("invalid Family sync cursor");
  }
  const sequence = Number(decoded);
  if (!Number.isSafeInteger(sequence)) {
    throw new FamilyDomainInvalidError("invalid Family sync cursor");
  }
  return sequence;
}

export function listFamilyRecords(
  scope: {
    agentId: string;
    profileId: string;
    kind?: FamilyRecordKind;
    cursor?: string;
    limit: number;
  },
  options: OpenClawStateDatabaseOptions = {},
): { records: FamilyRecord[]; cursor: string; hasMore: boolean } {
  const after = decodeFamilyCursor(scope.cursor);
  const database = prepare(options);
  const kysely = getNodeSqliteKysely<OpenClawStateKyselyDatabase>(database.db);
  let query = kysely
    .selectFrom("family_records")
    .selectAll()
    .where("agent_id", "=", scope.agentId)
    .where("profile_id", "=", scope.profileId)
    .where("change_sequence", ">", after);
  if (scope.kind) {
    query = query.where("kind", "=", scope.kind);
  }
  const rows = executeSqliteQuerySync(
    database.db,
    query.orderBy("change_sequence", "asc").limit(scope.limit + 1),
  ).rows;
  const hasMore = rows.length > scope.limit;
  const page = rows.slice(0, scope.limit);
  const sequence = page.at(-1)?.change_sequence ?? after;
  return { records: page.map(toRecord), cursor: encodeFamilyCursor(sequence), hasMore };
}

export function mutateFamilyRecord(
  scope: { agentId: string; profileId: string; kind: FamilyRecordKind },
  params: FamilyMutateParams,
  options: OpenClawStateDatabaseOptions = {},
  nowMs = Date.now(),
): { record: FamilyRecord; replayed: boolean } {
  const hash = requestHash(scope.kind, params);
  const database = prepare(options);
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const kysely = getNodeSqliteKysely<OpenClawStateKyselyDatabase>(db);
      const prior = executeSqliteQueryTakeFirstSync(
        db,
        kysely
          .selectFrom("family_mutations")
          .selectAll()
          .where("agent_id", "=", scope.agentId)
          .where("profile_id", "=", scope.profileId)
          .where("idempotency_key", "=", params.idempotencyKey),
      );
      if (prior) {
        if (prior.request_hash !== hash) {
          throw new FamilyDomainConflictError(
            "idempotency key was already used for another mutation",
          );
        }
        return { record: JSON.parse(prior.result_json) as FamilyRecord, replayed: true };
      }

      const id = params.id?.trim() || randomUUID();
      const existing = executeSqliteQueryTakeFirstSync(
        db,
        kysely
          .selectFrom("family_records")
          .selectAll()
          .where("agent_id", "=", scope.agentId)
          .where("profile_id", "=", scope.profileId)
          .where("record_id", "=", id),
      );
      if (params.operation === "create" && existing) {
        throw new FamilyDomainConflictError("Family record already exists");
      }
      if (params.operation !== "create" && !existing) {
        throw new FamilyDomainConflictError("Family record does not exist");
      }
      if (existing && existing.kind !== scope.kind) {
        throw new FamilyDomainConflictError("Family record belongs to another collection");
      }
      if (params.operation === "create" && params.expectedRevision !== undefined) {
        throw new FamilyDomainInvalidError("create must not include expectedRevision");
      }
      if (params.operation !== "create" && params.expectedRevision !== existing?.revision) {
        throw new FamilyDomainConflictError("Family record revision changed");
      }
      if (params.operation !== "delete" && params.payload === undefined) {
        throw new FamilyDomainInvalidError(`${params.operation} requires payload`);
      }

      const latest = executeSqliteQueryTakeFirstSync(
        db,
        kysely
          .selectFrom("family_records")
          .select("change_sequence")
          .orderBy("change_sequence", "desc")
          .limit(1),
      );
      const sequence = (latest?.change_sequence ?? 0) + 1;
      const revision = (existing?.revision ?? 0) + 1;
      const deletedAtMs = params.operation === "delete" ? nowMs : null;
      const row: FamilyRecords = {
        agent_id: scope.agentId,
        profile_id: scope.profileId,
        record_id: id,
        kind: scope.kind,
        revision,
        change_sequence: sequence,
        visibility: params.visibility ?? existing?.visibility ?? "private",
        lifecycle_state:
          params.lifecycleState ??
          existing?.lifecycle_state ??
          (scope.kind === "idea" ? "proposed" : "active"),
        provenance_json:
          existing?.provenance_json ??
          stableStringify({ actorType: "teen", actorId: scope.profileId, source: "family-app" }),
        payload_json:
          params.operation === "delete"
            ? (existing?.payload_json ?? "{}")
            : payloadJson(params.payload),
        created_at_ms: existing?.created_at_ms ?? nowMs,
        updated_at_ms: nowMs,
        deleted_at_ms: deletedAtMs,
      };
      if (existing) {
        executeSqliteQuerySync(
          db,
          kysely
            .updateTable("family_records")
            .set(row)
            .where("agent_id", "=", scope.agentId)
            .where("profile_id", "=", scope.profileId)
            .where("record_id", "=", id),
        );
      } else {
        executeSqliteQuerySync(db, kysely.insertInto("family_records").values(row));
      }
      const record = toRecord(row);
      executeSqliteQuerySync(
        db,
        kysely.insertInto("family_mutations").values({
          agent_id: scope.agentId,
          profile_id: scope.profileId,
          idempotency_key: params.idempotencyKey,
          request_hash: hash,
          result_json: stableStringify(record),
          created_at_ms: nowMs,
        }),
      );
      return { record, replayed: false };
    },
    { ...options, database },
    { operationLabel: "family-domain.mutate" },
  );
}
