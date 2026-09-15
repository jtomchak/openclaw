import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  FamilyDomainConflictError,
  decodeFamilyCursor,
  listFamilyRecords,
  mutateFamilyRecord,
} from "./family-domain.js";
import { closeOpenClawStateDatabaseForTest } from "./openclaw-state-db.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function stateOptions() {
  return { path: join(tempDirs.make("openclaw-family-domain-"), "openclaw.sqlite") };
}

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

describe("Family domain state", () => {
  it("isolates records by assigned agent and profile", () => {
    const options = stateOptions();
    mutateFamilyRecord(
      { agentId: "teen-agent", profileId: "teen", kind: "goal" },
      {
        operation: "create",
        id: "goal-1",
        idempotencyKey: "create-goal-1",
        payload: { title: "Learn guitar" },
      },
      options,
      1_000,
    );

    expect(
      listFamilyRecords(
        { agentId: "teen-agent", profileId: "teen", kind: "goal", limit: 10 },
        options,
      ).records,
    ).toHaveLength(1);
    expect(
      listFamilyRecords(
        { agentId: "sibling-agent", profileId: "teen", kind: "goal", limit: 10 },
        options,
      ).records,
    ).toEqual([]);
    expect(
      listFamilyRecords(
        { agentId: "teen-agent", profileId: "sibling", kind: "goal", limit: 10 },
        options,
      ).records,
    ).toEqual([]);
  });

  it("replays matching idempotency and rejects key reuse", () => {
    const options = stateOptions();
    const scope = { agentId: "teen-agent", profileId: "teen", kind: "idea" as const };
    const params = {
      operation: "create" as const,
      id: "idea-1",
      idempotencyKey: "create-idea-1",
      payload: { title: "Make a short film" },
    };

    const first = mutateFamilyRecord(scope, params, options, 1_000);
    const replay = mutateFamilyRecord(scope, params, options, 1_001);
    expect(first.replayed).toBe(false);
    expect(replay).toEqual({ ...first, replayed: true });
    expect(() =>
      mutateFamilyRecord(
        scope,
        { ...params, payload: { title: "Different request" } },
        options,
        1_002,
      ),
    ).toThrow(FamilyDomainConflictError);
  });

  it("requires the current revision and syncs durable tombstones", () => {
    const options = stateOptions();
    const scope = { agentId: "teen-agent", profileId: "teen", kind: "feed_item" as const };
    const created = mutateFamilyRecord(
      scope,
      {
        operation: "create",
        id: "feed-1",
        idempotencyKey: "create-feed-1",
        payload: { title: "Morning briefing" },
      },
      options,
      1_000,
    );
    const initial = listFamilyRecords({ ...scope, limit: 10 }, options);
    expect(decodeFamilyCursor(initial.cursor)).toBe(created.record.sequence);

    expect(() =>
      mutateFamilyRecord(
        scope,
        {
          operation: "update",
          id: "feed-1",
          expectedRevision: 2,
          idempotencyKey: "stale-feed-1",
          payload: { title: "Stale" },
        },
        options,
        1_001,
      ),
    ).toThrow(FamilyDomainConflictError);

    const removed = mutateFamilyRecord(
      scope,
      {
        operation: "delete",
        id: "feed-1",
        expectedRevision: 1,
        idempotencyKey: "delete-feed-1",
      },
      options,
      1_002,
    );
    const delta = listFamilyRecords({ ...scope, cursor: initial.cursor, limit: 10 }, options);
    expect(delta.records).toEqual([removed.record]);
    expect(removed.record).toMatchObject({ revision: 2, deletedAtMs: 1_002 });
  });

  it("does not allow a record id to move between collections", () => {
    const options = stateOptions();
    const created = mutateFamilyRecord(
      { agentId: "teen-agent", profileId: "teen", kind: "idea" },
      {
        operation: "create",
        id: "shared-id",
        idempotencyKey: "create-idea-2",
        payload: { title: "Idea" },
      },
      options,
      1_000,
    );

    expect(() =>
      mutateFamilyRecord(
        { agentId: "teen-agent", profileId: "teen", kind: "goal" },
        {
          operation: "update",
          id: created.record.id,
          expectedRevision: created.record.revision,
          idempotencyKey: "move-to-goal-1",
          payload: { title: "Goal" },
        },
        options,
        1_001,
      ),
    ).toThrow("another collection");
  });
});
