import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  applyFamilyAgentPolicyToConfig,
  applyFamilyAgentRuntimeBoundary,
  FAMILY_AGENT_HARD_DENY_TOOLS,
  listDefaultFamilyAgentToolGrants,
} from "./family-agent-policy.js";

describe("family agent policy", () => {
  it("preserves the adopted identity and workspace while enforcing the family boundary", () => {
    const config: OpenClawConfig = {
      agents: {
        entries: {
          walter: {
            name: "Walter",
            workspace: "/tmp/walter",
            tools: { profile: "coding", allow: ["web_search"] },
          },
          "dev-dude": {
            name: "Dev Dude",
            workspace: "/tmp/dev-dude",
            agentDir: "/tmp/agents/dev-dude",
            model: "openai/gpt-5.6-sol",
          },
        },
      },
    };
    const next = applyFamilyAgentPolicyToConfig({
      config,
      agentId: "dev-dude",
      managerAgentId: "walter",
      invitationRole: "dev-dude-invite",
      toolGrants: ["web_search", "exec", "gateway", "video_generate"],
    });
    const member = next.agents?.entries?.["dev-dude"];

    expect(member).toMatchObject({
      name: "Dev Dude",
      workspace: "/tmp/dev-dude",
      agentDir: "/tmp/agents/dev-dude",
      model: "openai/gpt-5.6-sol",
      sandbox: { mode: "all", scope: "agent", workspaceAccess: "rw" },
      family: {
        role: "member",
        managerAgentId: "walter",
        invitationRole: "dev-dude-invite",
      },
      tools: { allow: ["exec", "video_generate", "web_search"], elevated: { enabled: false } },
    });
    expect(member?.tools?.deny).toEqual(expect.arrayContaining([...FAMILY_AGENT_HARD_DENY_TOOLS]));
    expect(next.agents?.entries?.walter).toMatchObject({
      family: { role: "manager" },
      tools: { allow: ["family_invite", "web_search"] },
    });
    expect(next.tools).toBeUndefined();
    expect(applyFamilyAgentRuntimeBoundary(next, "dev-dude")?.tools).toMatchObject({
      sessions: { visibility: "agent" },
      agentToAgent: { enabled: false },
    });
    expect(applyFamilyAgentRuntimeBoundary(next, "walter")).toBe(next);
  });

  it("includes web, memory, automation, and media in the default grant preset", () => {
    expect(listDefaultFamilyAgentToolGrants()).toEqual(
      expect.arrayContaining([
        "web_search",
        "web_fetch",
        "memory_search",
        "memory_get",
        "automations",
        "view_image",
        "image_generate",
        "video_generate",
        "tts",
        "pdf",
      ]),
    );
  });

  it("refuses to promote an enrolled family member into a manager", () => {
    const config: OpenClawConfig = {
      agents: {
        entries: {
          manager: { family: { role: "manager" } },
          member: {
            family: {
              role: "member",
              managerAgentId: "manager",
              invitationRole: "member-invite",
            },
          },
          next: {},
        },
      },
    };

    expect(() =>
      applyFamilyAgentPolicyToConfig({
        config,
        agentId: "next",
        managerAgentId: "member",
        invitationRole: "next-invite",
        toolGrants: ["web_search"],
      }),
    ).toThrow("cannot manage another family agent");
  });

  it("refuses to adopt an existing family manager as a member", () => {
    const config: OpenClawConfig = {
      agents: {
        entries: {
          first: { family: { role: "manager" } },
          second: { family: { role: "manager" } },
        },
      },
    };

    expect(() =>
      applyFamilyAgentPolicyToConfig({
        config,
        agentId: "first",
        managerAgentId: "second",
        invitationRole: "first-invite",
        toolGrants: ["web_search"],
      }),
    ).toThrow("cannot be adopted as a member");
  });
});
