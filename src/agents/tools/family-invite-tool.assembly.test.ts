import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createOpenClawCodingTools } from "../agent-tools.js";
import "../test-helpers/fast-coding-tools.js";

vi.mock("../openclaw-plugin-tools.js", () => ({
  resolveOpenClawPluginToolsForOptions: () => [],
}));

const config: OpenClawConfig = {
  tools: { profile: "coding" },
  agents: {
    entries: {
      walter: { family: { role: "manager" } },
      "dev-dude": {
        family: {
          role: "member",
          managerAgentId: "walter",
          invitationRole: "dev-dude-invite",
        },
        tools: { profile: "full", allow: ["web_search", "family_invite"], deny: ["family_invite"] },
      },
    },
  },
};

function toolNames(agentId: string): string[] {
  return createOpenClawCodingTools({
    config,
    agentId,
    sessionKey: `agent:${agentId}:main`,
    senderIsOwner: true,
    modelProvider: "openai",
    modelId: "gpt-5.6-sol",
    disableMessageTool: true,
    wrapBeforeToolCallHook: false,
    toolConstructionPlan: {
      includeBaseCodingTools: false,
      includeShellTools: false,
      includeChannelTools: false,
      includeOpenClawTools: true,
      includePluginTools: false,
    },
  }).map((tool) => tool.name);
}

describe("family invite tool assembly", () => {
  beforeEach(() => {
    setActivePluginRegistry(createEmptyPluginRegistry());
  });

  it("is model-visible only to the configured family manager", () => {
    expect(toolNames("walter")).toContain("family_invite");
    expect(toolNames("dev-dude")).not.toContain("family_invite");
  });
});
