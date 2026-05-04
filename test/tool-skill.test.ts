import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRuntime } from "../src/runtime/createRuntime.ts";
import { readRoleDefinition, writeRoleDefinition } from "../src/roles/RoleDefinitionLoader.ts";
import { SkillRegistry } from "../src/skills/SkillRegistry.ts";
import { parseTaskResult } from "../src/tasks/TaskResult.ts";
import { ToolGateway } from "../src/tools/ToolGateway.ts";
import { createDefaultToolRegistry } from "../src/tools/ToolRegistry.ts";
import type { RoleDefinition } from "../src/types.ts";

const role: RoleDefinition = {
  name: "qa-tools",
  role: "Validate tool and skill behavior.",
  singleton: true,
  allowedTools: ["read_file", "write_file"],
  forbiddenTools: ["write_file"],
  maxConcurrentTasks: 1,
  capabilities: ["quality"],
  skills: ["review"],
  instructions: "Review the assigned task.",
};
const gateway = new ToolGateway(role, { registry: createDefaultToolRegistry() });
assert.equal(gateway.canUse("cat"), true);
assert.equal(gateway.canUse("write_file"), false);
assert.throws(() => gateway.assertAllowed("write_file"), /not allowed/);
const toolHints = gateway.resolveHints(["cat", "read_file", "write_file", "missing_tool"]);
assert.deepEqual(toolHints.allowed.map((tool) => tool.name), ["read_file"]);
assert.deepEqual(toolHints.denied, ["write_file"]);
assert.deepEqual(toolHints.unknown, ["missing_tool"]);
assert.ok(gateway.renderToolContext(toolHints).some((line) => line.includes("read_file")));

const skillDir = await mkdtemp(path.join(os.tmpdir(), "emily-agent-skills-"));
const pluginSkillDir = await mkdtemp(path.join(os.tmpdir(), "emily-agent-plugin-skills-"));
await mkdir(path.join(skillDir, "local-quality"), { recursive: true });
await writeFile(path.join(skillDir, "local-quality", "skill.md"), [
  "---",
  "name: \"local-quality\"",
  "title: \"Local Quality\"",
  "description: \"Local QA skill marker.\"",
  "capabilities:",
  "  - local quality",
  "tool_hints:",
  "  - write_file",
  "aliases:",
  "  - local-qa",
  "---",
  "LOCAL_QUALITY_SKILL_MARKER",
  "",
].join("\n"), "utf8");
await mkdir(path.join(pluginSkillDir, "llm-wiki"), { recursive: true });
await writeFile(path.join(pluginSkillDir, "llm-wiki", "SKILL.md"), [
  "---",
  "name: \"llm-wiki\"",
  "title: \"LLM Wiki\"",
  "description: \"External LLM Wiki adapter skill marker.\"",
  "capabilities:",
  "  - durable knowledge",
  "tool_hints:",
  "  - llm_wiki",
  "aliases:",
  "  - wiki",
  "  - llm_wiki",
  "---",
  "EXTERNAL_LLM_WIKI_SKILL_MARKER",
  "",
].join("\n"), "utf8");

const defaultOnlySkillRegistry = await SkillRegistry.create({ skillDir, includeBuiltIns: true });
assert.equal(defaultOnlySkillRegistry.get("llm-wiki"), null);

const skillRegistry = await SkillRegistry.create({ skillDirs: [skillDir, pluginSkillDir] });
assert.equal(skillRegistry.get("github")?.source, "builtin");
assert.equal(skillRegistry.get("web-search")?.source, "builtin");
assert.equal(skillRegistry.get("llm-wiki")?.source, "file");
const builtInSkillHints = skillRegistry.resolveHints(["github", "websearch"]);
assert.ok(builtInSkillHints.matched.some((skill) => skill.name === "github"));
assert.ok(builtInSkillHints.matched.some((skill) => skill.name === "web-search"));
const wikiSkillHints = skillRegistry.resolveHints(["wiki"]);
assert.ok(wikiSkillHints.matched.some((skill) => skill.name === "llm-wiki"));
const skillHints = skillRegistry.resolveHints(["local-qa", "review", "missing-skill"]);
assert.ok(skillHints.matched.some((skill) => skill.name === "local-quality"));
assert.ok(skillHints.matched.some((skill) => skill.name === "review"));
assert.deepEqual(skillHints.unknown, ["missing-skill"]);
assert.ok(skillRegistry.renderSkillContext(skillHints).some((line) => line.includes("LOCAL_QUALITY_SKILL_MARKER")));

const roleDir = await mkdtemp(path.join(os.tmpdir(), "emily-agent-tool-roles-"));
await writeRoleDefinition("qa-tools", {
  role: "Validate tool and skill behavior.",
  allowedTools: ["read_file"],
  forbiddenTools: ["delete_file"],
  capabilities: ["quality"],
  skills: ["local-quality"],
  instructions: "Review the assigned task and return concise QA notes.",
}, { roleDir });
const loadedRole = await readRoleDefinition("qa-tools", { roleDir });
assert.deepEqual(loadedRole.skills, ["local-quality"]);

const dataDir = await mkdtemp(path.join(os.tmpdir(), "emily-agent-tool-runtime-"));
const runtime = await createRuntime({
  dataDir,
  roleDir,
  skillDir,
  skillDirs: [skillDir, pluginSkillDir],
  providers: [{
    id: "main-echo",
    type: "echo",
    model: "tool-skill-model",
  }],
  defaultProviderId: "main-echo",
  mainProviderId: "main-echo",
});

assert.ok(runtime.listTools().some((tool) => tool.name === "read_file"));
assert.ok(runtime.listTools().some((tool) => tool.name === "web_search"));
assert.ok(runtime.listTools().some((tool) => tool.name === "llm_wiki"));
assert.ok(runtime.listSkills().some((skill) => skill.name === "github"));
assert.ok(runtime.listSkills().some((skill) => skill.name === "web-search"));
assert.ok(runtime.listSkills().some((skill) => skill.name === "llm-wiki"));
assert.ok(runtime.listSkills().some((skill) => skill.name === "local-quality"));

const task = runtime.taskStore.createTask({
  role: "qa-tools",
  title: "tool skill runtime",
  input: "Verify that tool and skill hints are resolved before the provider call.",
  metadata: {
    sessionId: "tool-skill",
    maxMemoryCandidates: 0,
    toolHints: ["cat", "delete_file", "missing_tool"],
    skillHints: ["review", "missing-skill"],
  },
});

const finished = await runtime.roleAgentManager.runTask(task, {
  timeoutMs: 10000,
});
const result = parseTaskResult(finished.result);
const metadata = result?.artifacts[0]?.metadata;
assert.equal(finished.status, "done");
assert.ok(metadata);
assert.deepEqual(metadata.tools?.allowed, ["read_file"]);
assert.ok(Array.isArray(metadata.tools?.denied) && metadata.tools.denied.includes("write_file"));
assert.ok(Array.isArray(metadata.tools?.denied) && metadata.tools.denied.includes("delete_file"));
assert.deepEqual(metadata.tools?.unknown, ["missing_tool"]);
assert.ok(Array.isArray(metadata.skills?.matched) && metadata.skills.matched.includes("local-quality"));
assert.ok(Array.isArray(metadata.skills?.matched) && metadata.skills.matched.includes("review"));
assert.deepEqual(metadata.skills?.unknown, ["missing-skill"]);

const trace = runtime.getTaskTrace(task.id);
assert.ok(trace.events.some((event) => event.type === "tool.hints.resolved"));
assert.ok(trace.events.some((event) => event.type === "skill.hints.resolved"));
assert.ok(trace.events.some((event) => event.type === "runtime.anomaly" && event.payload.code === "tool_hints_rejected"));
assert.ok(trace.events.some((event) => event.type === "runtime.anomaly" && event.payload.code === "skill_hints_unknown"));

await runtime.shutdown();

console.log("tool skill test passed");
