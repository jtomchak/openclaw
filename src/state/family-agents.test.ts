import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  adoptFamilyAgent,
  FamilyAgentConflictError,
  listManagedFamilyAgents,
  readFamilyAgent,
  updateFamilyAgentToolGrants,
} from "./family-agents.js";
import { closeOpenClawStateDatabaseForTest } from "./openclaw-state-db.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function stateOptions() {
  return { path: join(tempDirs.make("openclaw-family-agents-"), "openclaw.sqlite") };
}

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

describe("family agent state", () => {
  it("adopts an existing agent idempotently without transferring its manager", () => {
    const options = stateOptions();
    const first = adoptFamilyAgent(
      {
        agentId: "dev-dude",
        managerAgentId: "walter",
        invitationRole: "dev-dude-invite",
        relayUrl: "https://family.example.test",
        displayName: "Dev Dude",
        toolGrants: ["web_search", "memory_get", "web_search"],
        nowMs: 1_000,
      },
      options,
    );
    const replay = adoptFamilyAgent(
      {
        agentId: "dev-dude",
        managerAgentId: "walter",
        invitationRole: "dev-dude-invite",
        relayUrl: "https://family.example.test",
        displayName: "Dev Dude",
        toolGrants: ["memory_get", "web_search"],
        nowMs: 2_000,
      },
      options,
    );

    expect(first).toMatchObject({ adopted: true, familyAgent: { agentId: "dev-dude" } });
    expect(replay).toEqual({ ...first, adopted: false });
    expect(listManagedFamilyAgents("walter", options)).toEqual([first.familyAgent]);
    expect(() =>
      adoptFamilyAgent(
        {
          agentId: "dev-dude",
          managerAgentId: "other",
          invitationRole: "other-role",
          relayUrl: "https://family.example.test",
          toolGrants: [],
        },
        options,
      ),
    ).toThrow(FamilyAgentConflictError);
  });

  it("persists normalized approved-tool grants for the adopted agent", () => {
    const options = stateOptions();
    adoptFamilyAgent(
      {
        agentId: "dev-dude",
        managerAgentId: "walter",
        invitationRole: "dev-dude-invite",
        relayUrl: "https://family.example.test",
        toolGrants: ["web_search"],
        nowMs: 1_000,
      },
      options,
    );

    expect(
      updateFamilyAgentToolGrants(
        "dev-dude",
        ["video_generate", "web_search", "video_generate"],
        options,
        2_000,
      ),
    ).toMatchObject({ toolGrants: ["video_generate", "web_search"], updatedAtMs: 2_000 });
    expect(readFamilyAgent("dev-dude", options)).toMatchObject({
      toolGrants: ["video_generate", "web_search"],
    });
  });
});
