import assert from "node:assert/strict";
import path from "node:path";
import { readRoleDefinition } from "../src/roles/RoleDefinitionLoader.ts";
import { SkillRegistry } from "../src/skills/SkillRegistry.ts";
import { ToolGateway } from "../src/tools/ToolGateway.ts";
import { createDefaultToolRegistry } from "../src/tools/ToolRegistry.ts";
import type { PermissionMode, RoleDefinition, ToolPermission } from "../src/types.ts";

const skillDir = path.join(process.cwd(), "skills");
const roleDir = path.join(process.cwd(), "agents");
const skillRegistry = await SkillRegistry.create({ skillDir });
const toolRegistry = createDefaultToolRegistry();

const expectedSkills: Array<{
  name: string;
  source: "builtin" | "file";
  aliases: string[];
  minimumMode: PermissionMode;
  role?: string;
}> = [
  { name: "planning", source: "file", aliases: ["plan", "task-decomposition"], minimumMode: "read_only", role: "planner" },
  { name: "coding", source: "file", aliases: ["implementation", "developer"], minimumMode: "workspace_write", role: "developer" },
  { name: "research", source: "file", aliases: ["requirements", "analysis"], minimumMode: "read_only", role: "researcher" },
  { name: "web-search", source: "builtin", aliases: ["websearch", "search-web", "current-research"], minimumMode: "workspace_write", role: "researcher" },
  { name: "github", source: "builtin", aliases: ["gh", "pr", "pull-request", "issue", "github-review"], minimumMode: "danger_full_access" },
  { name: "review", source: "file", aliases: ["qa", "quality"], minimumMode: "read_only", role: "reviewer" },
  { name: "recovery", source: "file", aliases: ["inspect", "inspection"], minimumMode: "read_only", role: "inspector" },
  { name: "memory-curation", source: "file", aliases: ["experience", "memory-curator"], minimumMode: "read_only", role: "memory-curator" },
];

const listedSkillNames = new Set(skillRegistry.list().map((skill) => skill.name));
for (const expected of expectedSkills) {
  assert.ok(listedSkillNames.has(expected.name), `missing registered skill ${expected.name}`);
  const skill = skillRegistry.get(expected.name);
  assert.ok(skill, `skill ${expected.name} should resolve by canonical name`);
  assert.equal(skill.source, expected.source, `skill ${expected.name} should load from ${expected.source}`);
  assert.ok(skill.instructions.trim().length > 0, `skill ${expected.name} should render instructions`);
  for (const alias of expected.aliases) {
    const aliasMatches = skillRegistry.resolveHints([alias]).matched.map((match) => match.name);
    assert.ok(aliasMatches.includes(expected.name), `alias ${alias} should include ${expected.name}`);
  }
  for (const toolHint of skill.toolHints) {
    assert.ok(toolRegistry.resolve(toolHint), `skill ${expected.name} references unknown tool ${toolHint}`);
  }
  assert.ok(
    skillRegistry.renderSkillContext(skillRegistry.resolveHints([expected.name])).some((line) => line.includes(skill.title)),
    `skill ${expected.name} should render in skill context`,
  );
}

for (const expected of expectedSkills) {
  const skill = skillRegistry.get(expected.name);
  assert.ok(skill);
  const role = expected.role
    ? await readRoleDefinition(expected.role, { roleDir })
    : probeRoleForSkill(expected.name, skill.toolHints);
  const gateway = new ToolGateway(role, {
    registry: toolRegistry,
    permissionMode: expected.minimumMode,
  });
  const resolution = gateway.resolveHints(skill.toolHints);
  assert.deepEqual(resolution.unknown, [], `skill ${expected.name} should not request unknown tools`);
  assert.deepEqual(resolution.denied, [], `skill ${expected.name} should be usable in ${expected.minimumMode}`);
  assert.deepEqual(
    resolution.allowed.map((tool) => tool.name).sort(),
    unique(skill.toolHints).sort(),
    `skill ${expected.name} should expose all hinted tools in ${expected.minimumMode}`,
  );
}

for (const roleName of ["planner", "developer", "researcher", "reviewer", "inspector", "memory-curator"]) {
  const role = await readRoleDefinition(roleName, { roleDir });
  const skillResolution = skillRegistry.resolveHints(role.skills);
  assert.deepEqual(skillResolution.unknown, [], `role ${roleName} references unknown skills`);
  const gateway = new ToolGateway(role, { registry: toolRegistry, permissionMode: "workspace_write" });
  const toolHints = unique(skillResolution.matched.flatMap((skill) => skill.toolHints));
  const toolResolution = gateway.resolveHints(toolHints);
  assert.deepEqual(toolResolution.unknown, [], `role ${roleName} skill tools should all be registered`);
  assert.deepEqual(toolResolution.denied, [], `role ${roleName} skills should be usable in workspace_write`);
}

const researcher = await readRoleDefinition("researcher", { roleDir });
const researcherSkills = skillRegistry.resolveHints(researcher.skills);
const researcherToolHints = unique(researcherSkills.matched.flatMap((skill) => skill.toolHints));
const readOnlyResearcher = new ToolGateway(researcher, { registry: toolRegistry, permissionMode: "read_only" });
const readOnlyResearcherTools = readOnlyResearcher.resolveHints(researcherToolHints);
assert.deepEqual(readOnlyResearcherTools.allowed.map((tool) => tool.name), ["read_file"]);
assert.ok(readOnlyResearcherTools.denied.includes("web_search"));
assert.ok(readOnlyResearcherTools.denied.includes("http_fetch"));

function probeRoleForSkill(name: string, toolHints: ToolPermission[]): RoleDefinition {
  return {
    name: `${name}-probe`,
    role: `Probe role for ${name}.`,
    singleton: true,
    allowedTools: unique(toolHints),
    forbiddenTools: [],
    maxConcurrentTasks: 1,
    capabilities: [name],
    skills: [name],
    instructions: `Probe ${name} skill availability.`,
  };
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

console.log("skill availability test passed");
