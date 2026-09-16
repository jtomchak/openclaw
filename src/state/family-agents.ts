import type { FamilyAgent } from "../../packages/gateway-protocol/src/schema/family-agents.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { ensureFamilyAgentsSchema } from "./openclaw-state-db-schema-additive.js";
import type {
  DB as OpenClawStateKyselyDatabase,
  FamilyAgents,
} from "./openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "./openclaw-state-db.js";

export class FamilyAgentConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FamilyAgentConflictError";
  }
}

function prepare(options: OpenClawStateDatabaseOptions) {
  const database = openOpenClawStateDatabase(options);
  runOpenClawStateWriteTransaction(
    ({ db }) => ensureFamilyAgentsSchema(db),
    { ...options, database },
    { operationLabel: "family-agents.schema.ensure" },
  );
  return database;
}

function normalizeToolGrants(grants: readonly string[]): string[] {
  return [...new Set(grants.map((value) => value.trim()).filter(Boolean))].toSorted();
}

function toRecord(row: FamilyAgents): FamilyAgent {
  const parsed = JSON.parse(row.tool_grants_json) as unknown;
  if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === "string")) {
    throw new Error(`family agent ${row.agent_id} has invalid tool grants`);
  }
  if (row.lifecycle_state !== "active" && row.lifecycle_state !== "setup_required") {
    throw new Error(`family agent ${row.agent_id} has invalid lifecycle state`);
  }
  return {
    agentId: row.agent_id,
    managerAgentId: row.manager_agent_id,
    invitationRole: row.invitation_role,
    relayUrl: row.relay_url,
    ...(row.display_name ? { displayName: row.display_name } : {}),
    toolGrants: normalizeToolGrants(parsed),
    lifecycleState: row.lifecycle_state,
    adoptedAtMs: row.adopted_at_ms,
    updatedAtMs: row.updated_at_ms,
  };
}

export function readFamilyAgent(
  agentId: string,
  options: OpenClawStateDatabaseOptions = {},
): FamilyAgent | null {
  const database = prepare(options);
  const kysely = getNodeSqliteKysely<OpenClawStateKyselyDatabase>(database.db);
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    kysely.selectFrom("family_agents").selectAll().where("agent_id", "=", agentId),
  );
  return row ? toRecord(row) : null;
}

export function listFamilyAgents(options: OpenClawStateDatabaseOptions = {}): FamilyAgent[] {
  const database = prepare(options);
  const kysely = getNodeSqliteKysely<OpenClawStateKyselyDatabase>(database.db);
  return executeSqliteQuerySync(
    database.db,
    kysely.selectFrom("family_agents").selectAll().orderBy("adopted_at_ms", "asc"),
  ).rows.map(toRecord);
}

export function listManagedFamilyAgents(
  managerAgentId: string,
  options: OpenClawStateDatabaseOptions = {},
): FamilyAgent[] {
  const database = prepare(options);
  const kysely = getNodeSqliteKysely<OpenClawStateKyselyDatabase>(database.db);
  return executeSqliteQuerySync(
    database.db,
    kysely
      .selectFrom("family_agents")
      .selectAll()
      .where("manager_agent_id", "=", managerAgentId)
      .orderBy("adopted_at_ms", "asc"),
  ).rows.map(toRecord);
}

export function adoptFamilyAgent(
  params: {
    agentId: string;
    managerAgentId: string;
    invitationRole: string;
    relayUrl: string;
    displayName?: string;
    toolGrants: readonly string[];
    lifecycleState?: FamilyAgent["lifecycleState"];
    nowMs?: number;
  },
  options: OpenClawStateDatabaseOptions = {},
): { familyAgent: FamilyAgent; adopted: boolean } {
  const nowMs = params.nowMs ?? Date.now();
  const toolGrants = normalizeToolGrants(params.toolGrants);
  const database = prepare(options);
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const kysely = getNodeSqliteKysely<OpenClawStateKyselyDatabase>(db);
      const existing = executeSqliteQueryTakeFirstSync(
        db,
        kysely.selectFrom("family_agents").selectAll().where("agent_id", "=", params.agentId),
      );
      if (existing) {
        const record = toRecord(existing);
        if (
          record.managerAgentId !== params.managerAgentId ||
          record.invitationRole !== params.invitationRole
        ) {
          throw new FamilyAgentConflictError(
            `agent ${params.agentId} is already adopted by another family policy`,
          );
        }
        const displayName = params.displayName?.trim() || null;
        const lifecycleState = params.lifecycleState ?? record.lifecycleState;
        if (
          record.displayName === (displayName ?? undefined) &&
          record.relayUrl === params.relayUrl &&
          record.lifecycleState === lifecycleState &&
          JSON.stringify(record.toolGrants) === JSON.stringify(toolGrants)
        ) {
          return { familyAgent: record, adopted: false };
        }
        const updated = executeSqliteQueryTakeFirstSync(
          db,
          kysely
            .updateTable("family_agents")
            .set({
              display_name: displayName,
              relay_url: params.relayUrl,
              tool_grants_json: JSON.stringify(toolGrants),
              lifecycle_state: lifecycleState,
              updated_at_ms: nowMs,
            })
            .where("agent_id", "=", params.agentId)
            .returningAll(),
        );
        if (!updated) {
          throw new Error(`family agent ${params.agentId} disappeared during adoption`);
        }
        return { familyAgent: toRecord(updated), adopted: false };
      }
      const row: FamilyAgents = {
        agent_id: params.agentId,
        manager_agent_id: params.managerAgentId,
        invitation_role: params.invitationRole,
        relay_url: params.relayUrl,
        display_name: params.displayName?.trim() || null,
        tool_grants_json: JSON.stringify(toolGrants),
        lifecycle_state: params.lifecycleState ?? "active",
        adopted_at_ms: nowMs,
        updated_at_ms: nowMs,
      };
      executeSqliteQuerySync(db, kysely.insertInto("family_agents").values(row));
      return { familyAgent: toRecord(row), adopted: true };
    },
    { ...options, database },
    { operationLabel: "family-agents.adopt" },
  );
}

export function updateFamilyAgentToolGrants(
  agentId: string,
  toolGrantsInput: readonly string[],
  options: OpenClawStateDatabaseOptions = {},
  nowMs = Date.now(),
): FamilyAgent | null {
  const toolGrants = normalizeToolGrants(toolGrantsInput);
  const database = prepare(options);
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const kysely = getNodeSqliteKysely<OpenClawStateKyselyDatabase>(db);
      const row = executeSqliteQueryTakeFirstSync(
        db,
        kysely
          .updateTable("family_agents")
          .set({ tool_grants_json: JSON.stringify(toolGrants), updated_at_ms: nowMs })
          .where("agent_id", "=", agentId)
          .returningAll(),
      );
      return row ? toRecord(row) : null;
    },
    { ...options, database },
    { operationLabel: "family-agents.update-tool-grants" },
  );
}
