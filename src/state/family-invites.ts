import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { FamilyInvite } from "../../packages/gateway-protocol/src/schema/family.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { ensureFamilyInvitesSchema } from "./openclaw-state-db-schema-additive.js";
import type {
  DB as OpenClawStateKyselyDatabase,
  FamilyInvites,
} from "./openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "./openclaw-state-db.js";
import { ensureUserProfileRoleSchema } from "./user-profiles-schema.js";
import { createUserProfileWithRoleInTransaction } from "./user-profiles.js";

export type FamilyInviteRecord = FamilyInvite & {
  setupId?: string;
  profileId?: string;
  gatewayPublicKey?: string;
};

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function toRecord(row: FamilyInvites, nowMs: number): FamilyInviteRecord {
  const state = row.state === "pending" && row.expires_at_ms <= nowMs ? "expired" : row.state;
  return {
    inviteId: row.invite_id,
    agentId: row.agent_id,
    role: row.role_name,
    ...(row.display_name ? { displayName: row.display_name } : {}),
    state: state as FamilyInvite["state"],
    createdAtMs: row.created_at_ms,
    expiresAtMs: row.expires_at_ms,
    ...(row.public_key_thumbprint ? { publicKeyThumbprint: row.public_key_thumbprint } : {}),
    ...(row.setup_id ? { setupId: row.setup_id } : {}),
    ...(row.profile_id ? { profileId: row.profile_id } : {}),
    ...(row.device_id ? { deviceId: row.device_id } : {}),
    ...(row.gateway_public_key ? { gatewayPublicKey: row.gateway_public_key } : {}),
    ...(row.redeemed_at_ms !== null ? { redeemedAtMs: row.redeemed_at_ms } : {}),
    ...(row.revoked_at_ms !== null ? { revokedAtMs: row.revoked_at_ms } : {}),
  };
}

function prepare(options: OpenClawStateDatabaseOptions) {
  const database = openOpenClawStateDatabase(options);
  runOpenClawStateWriteTransaction(
    ({ db }) => ensureFamilyInvitesSchema(db),
    { ...options, database },
    { operationLabel: "family-invites.schema.ensure" },
  );
  return database;
}

export function createFamilyInvite(
  params: {
    agentId: string;
    role: string;
    displayName?: string;
    expiresAtMs: number;
    nowMs?: number;
  },
  options: OpenClawStateDatabaseOptions = {},
): { invite: FamilyInviteRecord; token: string } {
  const nowMs = params.nowMs ?? Date.now();
  const token = randomBytes(32).toString("base64url");
  const row: FamilyInvites = {
    invite_id: randomUUID(),
    token_hash: hashToken(token),
    agent_id: params.agentId,
    role_name: params.role,
    display_name: params.displayName?.trim() || null,
    state: "pending",
    created_at_ms: nowMs,
    expires_at_ms: params.expiresAtMs,
    public_key_thumbprint: null,
    setup_id: null,
    profile_id: null,
    device_id: null,
    gateway_public_key: null,
    redeemed_at_ms: null,
    revoked_at_ms: null,
    updated_at_ms: nowMs,
  };
  const database = prepare(options);
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      const kysely = getNodeSqliteKysely<OpenClawStateKyselyDatabase>(db);
      executeSqliteQuerySync(db, kysely.insertInto("family_invites").values(row));
    },
    { ...options, database },
    { operationLabel: "family-invites.create" },
  );
  return { invite: toRecord(row, nowMs), token };
}

export type ReserveFamilyInviteResult =
  | { ok: true; invite: FamilyInviteRecord }
  | {
      ok: false;
      reason: "invalid" | "expired" | "revoked" | "device_mismatch" | "invalid_policy";
    };

export function reserveFamilyInviteRedemption(
  params: {
    token: string;
    publicKeyThumbprint: string;
    nowMs?: number;
    validatePolicy?: (invite: Pick<FamilyInviteRecord, "agentId" | "role">) => boolean;
  },
  options: OpenClawStateDatabaseOptions = {},
): ReserveFamilyInviteResult {
  const nowMs = params.nowMs ?? Date.now();
  const database = prepare(options);
  ensureUserProfileRoleSchema({ ...options, database }, database);
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const kysely = getNodeSqliteKysely<OpenClawStateKyselyDatabase>(db);
      const row = executeSqliteQueryTakeFirstSync(
        db,
        kysely
          .selectFrom("family_invites")
          .selectAll()
          .where("token_hash", "=", hashToken(params.token)),
      );
      if (!row) {
        return { ok: false as const, reason: "invalid" as const };
      }
      if (row.state === "revoked" || row.state === "revocation_pending") {
        return { ok: false as const, reason: "revoked" as const };
      }
      if (
        params.validatePolicy &&
        !params.validatePolicy({ agentId: row.agent_id, role: row.role_name })
      ) {
        return { ok: false as const, reason: "invalid_policy" as const };
      }
      if (row.expires_at_ms <= nowMs && row.state !== "active") {
        return { ok: false as const, reason: "expired" as const };
      }
      if (row.public_key_thumbprint && row.public_key_thumbprint !== params.publicKeyThumbprint) {
        return { ok: false as const, reason: "device_mismatch" as const };
      }
      if (row.setup_id && row.profile_id) {
        return { ok: true as const, invite: toRecord(row, nowMs) };
      }
      const setupId = randomUUID();
      const { profileId } = createUserProfileWithRoleInTransaction(db, {
        ...(row.display_name ? { displayName: row.display_name } : {}),
        role: row.role_name,
        nowMs,
      });
      const updated = executeSqliteQueryTakeFirstSync(
        db,
        kysely
          .updateTable("family_invites")
          .set({
            state: "redeeming",
            public_key_thumbprint: params.publicKeyThumbprint,
            setup_id: setupId,
            profile_id: profileId,
            redeemed_at_ms: nowMs,
            updated_at_ms: nowMs,
          })
          .where("invite_id", "=", row.invite_id)
          .where("state", "=", "pending")
          .returningAll(),
      );
      if (!updated) {
        throw new Error("family invitation changed during redemption");
      }
      return { ok: true as const, invite: toRecord(updated, nowMs) };
    },
    { ...options, database },
    { operationLabel: "family-invites.reserve-redemption" },
  );
}

export function readFamilyInvite(
  inviteId: string,
  options: OpenClawStateDatabaseOptions = {},
  nowMs = Date.now(),
): FamilyInviteRecord | null {
  const database = prepare(options);
  const kysely = getNodeSqliteKysely<OpenClawStateKyselyDatabase>(database.db);
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    kysely.selectFrom("family_invites").selectAll().where("invite_id", "=", inviteId),
  );
  return row ? toRecord(row, nowMs) : null;
}

export function readFamilyInviteBySetupId(
  setupId: string,
  options: OpenClawStateDatabaseOptions = {},
): FamilyInviteRecord | null {
  const database = prepare(options);
  const kysely = getNodeSqliteKysely<OpenClawStateKyselyDatabase>(database.db);
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    kysely.selectFrom("family_invites").selectAll().where("setup_id", "=", setupId),
  );
  return row ? toRecord(row, Date.now()) : null;
}

export function bindFamilyInviteDevice(
  params: { setupId: string; deviceId: string; gatewayPublicKey: string; nowMs?: number },
  options: OpenClawStateDatabaseOptions = {},
): FamilyInviteRecord | null {
  const nowMs = params.nowMs ?? Date.now();
  const database = prepare(options);
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const kysely = getNodeSqliteKysely<OpenClawStateKyselyDatabase>(db);
      const existing = executeSqliteQueryTakeFirstSync(
        db,
        kysely.selectFrom("family_invites").selectAll().where("setup_id", "=", params.setupId),
      );
      if (!existing || existing.state === "revoked" || existing.state === "revocation_pending") {
        return null;
      }
      if (
        (existing.device_id && existing.device_id !== params.deviceId) ||
        (existing.gateway_public_key && existing.gateway_public_key !== params.gatewayPublicKey)
      ) {
        return null;
      }
      const row = executeSqliteQueryTakeFirstSync(
        db,
        kysely
          .updateTable("family_invites")
          .set({
            state: "active",
            device_id: params.deviceId,
            gateway_public_key: params.gatewayPublicKey,
            updated_at_ms: nowMs,
          })
          .where("invite_id", "=", existing.invite_id)
          .returningAll(),
      );
      return row ? toRecord(row, nowMs) : null;
    },
    { ...options, database },
    { operationLabel: "family-invites.bind-device" },
  );
}

export function resolveActiveFamilyInviteForDevice(
  params: { deviceId: string; gatewayPublicKey: string },
  options: OpenClawStateDatabaseOptions = {},
): FamilyInviteRecord | null {
  const database = prepare(options);
  const kysely = getNodeSqliteKysely<OpenClawStateKyselyDatabase>(database.db);
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    kysely
      .selectFrom("family_invites")
      .selectAll()
      .where("device_id", "=", params.deviceId)
      .where("gateway_public_key", "=", params.gatewayPublicKey)
      .where("state", "=", "active"),
  );
  return row ? toRecord(row, Date.now()) : null;
}

export function readLatestFamilyInviteForDevice(
  deviceId: string,
  options: OpenClawStateDatabaseOptions = {},
): FamilyInviteRecord | null {
  const database = prepare(options);
  const kysely = getNodeSqliteKysely<OpenClawStateKyselyDatabase>(database.db);
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    kysely
      .selectFrom("family_invites")
      .selectAll()
      .where("device_id", "=", deviceId)
      .orderBy("updated_at_ms", "desc")
      .limit(1),
  );
  return row ? toRecord(row, Date.now()) : null;
}

export function beginFamilyInviteRevocation(
  inviteId: string,
  options: OpenClawStateDatabaseOptions = {},
  nowMs = Date.now(),
): FamilyInviteRecord | null {
  const database = prepare(options);
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const kysely = getNodeSqliteKysely<OpenClawStateKyselyDatabase>(db);
      const existing = executeSqliteQueryTakeFirstSync(
        db,
        kysely.selectFrom("family_invites").selectAll().where("invite_id", "=", inviteId),
      );
      if (!existing) {
        return null;
      }
      if (existing.state === "revoked" || existing.state === "revocation_pending") {
        return toRecord(existing, nowMs);
      }
      const state = existing.device_id ? "revocation_pending" : "revoked";
      const row = executeSqliteQueryTakeFirstSync(
        db,
        kysely
          .updateTable("family_invites")
          .set({ state, revoked_at_ms: nowMs, updated_at_ms: nowMs })
          .where("invite_id", "=", inviteId)
          .returningAll(),
      );
      return row ? toRecord(row, nowMs) : null;
    },
    { ...options, database },
    { operationLabel: "family-invites.begin-revocation" },
  );
}

export function completeFamilyInviteRevocation(
  inviteId: string,
  options: OpenClawStateDatabaseOptions = {},
  nowMs = Date.now(),
): FamilyInviteRecord | null {
  const database = prepare(options);
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const kysely = getNodeSqliteKysely<OpenClawStateKyselyDatabase>(db);
      const row = executeSqliteQueryTakeFirstSync(
        db,
        kysely
          .updateTable("family_invites")
          .set({ state: "revoked", revoked_at_ms: nowMs, updated_at_ms: nowMs })
          .where("invite_id", "=", inviteId)
          .where("state", "in", ["revocation_pending", "revoked"])
          .returningAll(),
      );
      return row ? toRecord(row, nowMs) : null;
    },
    { ...options, database },
    { operationLabel: "family-invites.complete-revocation" },
  );
}
