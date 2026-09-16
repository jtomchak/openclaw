import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { listCoreToolSections } from "./tool-catalog.js";

export const FAMILY_AGENT_HARD_DENY_TOOLS = [
  "gateway",
  "plugins",
  "nodes",
  "computer",
  "mobile_ui",
  "openclaw",
  "terminal",
  "portal",
  "screen",
  "secrets",
  "github_identity_status",
  "github_publish",
  "agents_list",
  "family_invite",
] as const;

const hardDeny = new Set<string>(FAMILY_AGENT_HARD_DENY_TOOLS);

export class FamilyAgentPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FamilyAgentPolicyError";
  }
}

/** Current general-purpose core tools granted by the default family preset. */
export function listDefaultFamilyAgentToolGrants(): string[] {
  return listCoreToolSections({ swarmEnabled: true, githubPublicationAvailable: true })
    .flatMap((section) => section.tools.map((tool) => tool.id))
    .filter((toolId) => !hardDeny.has(toolId))
    .toSorted();
}

export function normalizeFamilyAgentToolGrants(grants: readonly string[]): string[] {
  return [...new Set(grants.map((value) => value.trim()).filter(Boolean))]
    .filter((toolId) => !hardDeny.has(toolId))
    .toSorted();
}

/** Restricts session routing for one family member without changing unrelated agents globally. */
export function applyFamilyAgentRuntimeBoundary(
  config: OpenClawConfig | undefined,
  agentId: string,
): OpenClawConfig | undefined {
  if (!config || resolveFamilyRole(config, agentId) !== "member") {
    return config;
  }
  return {
    ...config,
    tools: {
      ...config.tools,
      sessions: { ...config.tools?.sessions, visibility: "agent" },
      agentToAgent: { ...config.tools?.agentToAgent, enabled: false },
    },
  };
}

function findEntryKey(config: OpenClawConfig, agentId: string): string | undefined {
  return Object.keys(config.agents?.entries ?? {}).find(
    (key) => normalizeAgentId(key) === normalizeAgentId(agentId),
  );
}

function resolveFamilyRole(
  config: OpenClawConfig,
  agentId: string,
): "manager" | "member" | undefined {
  const key = findEntryKey(config, agentId);
  return key ? config.agents?.entries?.[key]?.family?.role : undefined;
}

/** Applies the family boundary while preserving identity, model, workspace, and unrelated settings. */
export function applyFamilyAgentPolicyToConfig(params: {
  config: OpenClawConfig;
  agentId: string;
  managerAgentId: string;
  invitationRole: string;
  toolGrants: readonly string[];
}): OpenClawConfig {
  const key = findEntryKey(params.config, params.agentId);
  const managerKey = findEntryKey(params.config, params.managerAgentId);
  if (!key || !managerKey) {
    throw new FamilyAgentPolicyError("family agent or manager is not configured");
  }
  const entries = params.config.agents?.entries ?? {};
  const existing = entries[key];
  const manager = entries[managerKey];
  if (!existing || !manager) {
    throw new FamilyAgentPolicyError("family agent or manager config disappeared");
  }
  if (existing.family?.role === "manager") {
    throw new FamilyAgentPolicyError(
      `family manager ${params.agentId} cannot be adopted as a member`,
    );
  }
  if (manager.family?.role === "member") {
    throw new FamilyAgentPolicyError(
      `family member ${params.managerAgentId} cannot manage another family agent`,
    );
  }
  const { alsoAllow: _existingAlsoAllow, ...existingTools } = existing.tools ?? {};
  const managerTools = manager.tools?.allow
    ? {
        ...manager.tools,
        allow: [...new Set([...manager.tools.allow, "family_invite"])].toSorted(),
      }
    : {
        ...manager.tools,
        alsoAllow: [...new Set([...(manager.tools?.alsoAllow ?? []), "family_invite"])].toSorted(),
      };
  const toolGrants = normalizeFamilyAgentToolGrants(params.toolGrants);
  const deny = [
    ...new Set([...(existing.tools?.deny ?? []), ...FAMILY_AGENT_HARD_DENY_TOOLS]),
  ].toSorted();
  return {
    ...params.config,
    agents: {
      ...params.config.agents,
      entries: {
        ...entries,
        [key]: {
          ...existing,
          sandbox: {
            ...existing.sandbox,
            mode: "all",
            scope: "agent",
            workspaceAccess: "rw",
            browser: {
              ...existing.sandbox?.browser,
              enabled: true,
              allowHostControl: false,
            },
          },
          tools: {
            ...existingTools,
            profile: "full",
            allow: toolGrants,
            deny,
            elevated: {
              ...existing.tools?.elevated,
              enabled: false,
            },
          },
          subagents: {
            ...existing.subagents,
            allowAgents: [],
          },
          family: {
            role: "member",
            managerAgentId: params.managerAgentId,
            invitationRole: params.invitationRole,
          },
        },
        [managerKey]: {
          ...manager,
          tools: managerTools,
          family: { role: "manager" },
        },
      },
    },
  };
}
