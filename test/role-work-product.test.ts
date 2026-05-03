import assert from "node:assert/strict";
import { buildRoleWorkProduct } from "../src/agents/RoleWorkProduct.ts";
import { parseReviewerVerdict } from "../src/review/ReviewerVerdict.ts";
import { createDefaultToolRegistry } from "../src/tools/ToolRegistry.ts";

const registry = createDefaultToolRegistry();
const readFile = registry.get("read_file");
const writeFile = registry.get("write_file");
const runTests = registry.get("run_tests");

const baseTask = {
  id: "task-1",
  role: "developer",
  status: "running",
  title: "enhance role agents",
  input: "Enhance coding agent behavior in src/workers/subagentWorker.ts and src/agents/SubAgent.ts",
  result: null,
  error: null,
  assignedAgentId: "agent-1",
  parentTaskId: null,
  metadata: {
    acceptanceCriteria: ["Developer output includes codebase context.", "Verification is explicit."],
    deliveryLevel: "poc",
  },
  retryCount: 0,
  maxRetries: 1,
  leaseOwner: "agent-1",
  leaseToken: "lease-1",
  leaseExpiresAt: null,
  heartbeatAt: null,
  mainAckAt: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const memory = {
  shortTerm: [{ content: "Prefer scoped edits and npm run check.", score: 1 }],
  files: [],
  semantic: [],
};

const tools = {
  requested: ["read_file", "write_file", "run_tests"],
  allowed: [readFile, writeFile, runTests].filter(Boolean),
  denied: [],
  unknown: [],
};

const skills = {
  requested: ["coding"],
  matched: [{
    name: "coding",
    title: "Coding",
    description: "Implementation workflow",
    capabilities: ["coding"],
    toolHints: ["read_file", "write_file", "run_tests"],
    aliases: [],
    instructions: "Use scoped implementation.",
    source: "builtin",
  }],
  unknown: [],
};

const developer = buildRoleWorkProduct({
  role: "developer",
  task: baseTask,
  providerContent: "Provider says implement the worker wrapper.",
  relevantMemory: memory,
  toolResolution: tools,
  skillResolution: skills,
});

assert.match(developer, /# Developer Work Product/);
assert.match(developer, /Codebase Context/);
assert.match(developer, /src\/workers\/subagentWorker\.ts/);
assert.match(developer, /npm run check|npm test|Verification Plan/);
assert.match(developer, /Provider says implement/);

const researcher = buildRoleWorkProduct({
  role: "researcher",
  task: { ...baseTask, role: "researcher", input: "Research current session behavior in README.md" },
  providerContent: "Provider research notes.",
  relevantMemory: memory,
  toolResolution: {
    requested: ["read_file"],
    allowed: [readFile].filter(Boolean),
    denied: [],
    unknown: [],
  },
  skillResolution: { requested: ["research"], matched: [], unknown: [] },
});

assert.match(researcher, /# Research Work Product/);
assert.match(researcher, /Facts/);
assert.match(researcher, /Assumptions/);
assert.match(researcher, /README\.md/);

const reviewer = buildRoleWorkProduct({
  role: "reviewer",
  task: {
    ...baseTask,
    role: "reviewer",
    input: "Review sub-results: developer done: implemented requested behavior.",
  },
  providerContent: "Looks complete.",
  relevantMemory: memory,
  toolResolution: { requested: [], allowed: [], denied: [], unknown: [] },
  skillResolution: { requested: [], matched: [], unknown: [] },
});

const verdict = parseReviewerVerdict(reviewer);
assert.equal(verdict.verdict, "pass");
assert.equal(verdict.retrySuggested, false);
assert.ok(verdict.confidence >= 0.8);

const failedReview = buildRoleWorkProduct({
  role: "reviewer",
  task: {
    ...baseTask,
    role: "reviewer",
    input: "Review sub-results: developer failed: missing verification and blocked.",
  },
  providerContent: "Missing tests.",
  relevantMemory: memory,
  toolResolution: { requested: [], allowed: [], denied: [], unknown: [] },
  skillResolution: { requested: [], matched: [], unknown: [] },
});

assert.equal(parseReviewerVerdict(failedReview).verdict, "fail");

console.log("role work product test passed");
