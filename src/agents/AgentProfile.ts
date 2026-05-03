import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Metadata, PermissionMode, RoleDefinition, Task } from "../types.ts";
import { filterToolsByPermissionMode, parsePermissionMode } from "../tools/PermissionMode.ts";

export interface AgentProfile {
  id: string;
  role: string;
  workspaceDir: string;
  stateDir: string;
  sessionScope: string;
  memoryScope: string;
  providerBinding: {
    provider?: string;
    model?: string;
    temperature?: number;
    fallback: "main-provider" | "role-provider";
  };
  toolPolicy: {
    allowedTools: string[];
    forbiddenTools: string[];
    effectiveAllowedTools: string[];
    permissionMode: PermissionMode;
  };
  skillAllowlist: string[];
  capabilities: string[];
  metadata: Metadata;
}

export async function createAgentProfile({
  agentId,
  definition,
  task,
  dataDir,
  workspaceDir = process.cwd(),
}: {
  agentId: string;
  definition: RoleDefinition;
  task: Task;
  dataDir: string;
  workspaceDir?: string;
}): Promise<AgentProfile> {
  const sessionScope = String(task.metadata.sessionId || "default");
  const permissionMode = parsePermissionMode(task.metadata.permissionMode);
  const profile: AgentProfile = {
    id: agentId,
    role: definition.name,
    workspaceDir,
    stateDir: path.join(dataDir, "agents", definition.name),
    sessionScope,
    memoryScope: String(task.metadata.memoryScope || sessionScope),
    providerBinding: {
      provider: definition.provider,
      model: definition.model,
      temperature: definition.temperature,
      fallback: definition.provider ? "role-provider" : "main-provider",
    },
    toolPolicy: {
      allowedTools: [...definition.allowedTools],
      forbiddenTools: [...definition.forbiddenTools],
      effectiveAllowedTools: filterToolsByPermissionMode(definition.allowedTools, permissionMode)
        .filter((tool) => !definition.forbiddenTools.includes(tool)),
      permissionMode,
    },
    skillAllowlist: [...(definition.skillAllowlist || [])],
    capabilities: [...definition.capabilities],
    metadata: {
      taskId: task.id,
      graphId: typeof task.metadata.graphId === "string" ? task.metadata.graphId : "",
      runId: typeof task.metadata.runId === "string" ? task.metadata.runId : "",
    },
  };
  await mkdir(profile.stateDir, { recursive: true });
  return profile;
}

export function renderAgentProfile(profile: AgentProfile): string[] {
  return [
    "Agent profile:",
    `- id: ${profile.id}`,
    `- role: ${profile.role}`,
    `- workspaceDir: ${profile.workspaceDir}`,
    `- stateDir: ${profile.stateDir}`,
    `- sessionScope: ${profile.sessionScope}`,
    `- memoryScope: ${profile.memoryScope}`,
    `- providerFallback: ${profile.providerBinding.fallback}`,
    `- permissionMode: ${profile.toolPolicy.permissionMode}`,
    `- allowedTools: ${profile.toolPolicy.allowedTools.join(", ") || "(none)"}`,
    `- effectiveAllowedTools: ${profile.toolPolicy.effectiveAllowedTools.join(", ") || "(none)"}`,
    `- forbiddenTools: ${profile.toolPolicy.forbiddenTools.join(", ") || "(none)"}`,
    `- skillAllowlist: ${profile.skillAllowlist.join(", ") || "(unrestricted)"}`,
  ];
}
