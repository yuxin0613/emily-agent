import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { MemoryRecallResult, Metadata, SkillHintResolution, Task, ToolHintResolution } from "../types.ts";

export interface RoleWorkProductInput {
  role: string;
  task: Task;
  providerContent: string;
  relevantMemory: MemoryRecallResult;
  toolResolution: ToolHintResolution;
  skillResolution: SkillHintResolution;
  workspaceDir?: string;
  canReadFiles?: boolean;
}

export function buildRoleWorkProduct({
  role,
  task,
  providerContent,
  relevantMemory,
  toolResolution,
  skillResolution,
  workspaceDir = process.cwd(),
  canReadFiles = true,
}: RoleWorkProductInput): string {
  if (role === "developer") {
    return buildDeveloperWorkProduct({ task, providerContent, relevantMemory, toolResolution, skillResolution, workspaceDir, canReadFiles });
  }
  if (role === "researcher") {
    return buildResearcherWorkProduct({ task, providerContent, relevantMemory, toolResolution, skillResolution, workspaceDir, canReadFiles });
  }
  if (role === "reviewer") {
    return buildReviewerWorkProduct({ task, providerContent });
  }
  return providerContent;
}

function buildDeveloperWorkProduct({
  task,
  providerContent,
  relevantMemory,
  toolResolution,
  skillResolution,
  workspaceDir = process.cwd(),
  canReadFiles = true,
}: Omit<RoleWorkProductInput, "role">): string {
  const acceptanceCriteria = readStringArray(task.metadata.acceptanceCriteria);
  const fileRefs = canReadFiles ? discoverRelevantFiles(task.input, workspaceDir, 8) : [];
  const packageInfo = canReadFiles ? readPackageInfo(workspaceDir) : null;
  const allowedTools = toolResolution.allowed.map((tool) => tool.name);
  const memoryHighlights = summarizeMemory(relevantMemory, 5);

  return [
    "# Developer Work Product",
    "",
    "## Task Understanding",
    `- Goal: ${firstMeaningfulLine(task.input)}`,
    `- Delivery level: ${stringMetadata(task.metadata, "deliveryLevel") || "(unspecified)"}`,
    `- Allowed tools: ${allowedTools.length ? allowedTools.join(", ") : "(none)"}`,
    `- Matched skills: ${skillResolution.matched.length ? skillResolution.matched.map((skill) => skill.name).join(", ") : "(none)"}`,
    "",
    "## Acceptance Criteria",
    ...(acceptanceCriteria.length ? acceptanceCriteria.map((item) => `- ${item}`) : ["- Produce a concrete implementation result or an actionable implementation plan."]),
    "",
    "## Codebase Context",
    ...formatPackageInfo(packageInfo, canReadFiles),
    ...formatFileContexts(fileRefs),
    "",
    "## Implementation Strategy",
    ...implementationStrategy(task.input, fileRefs),
    "",
    "## Verification Plan",
    ...verificationPlan(packageInfo, task.metadata),
    "",
    "## Risks And Blockers",
    ...developerRisks(task, toolResolution, fileRefs),
    "",
    "## Relevant Memory",
    ...(memoryHighlights.length ? memoryHighlights.map((item) => `- ${item}`) : ["- (none)"]),
    "",
    "## Provider Work Product",
    providerContent.trim() || "(provider returned no content)",
  ].join("\n");
}

function buildResearcherWorkProduct({
  task,
  providerContent,
  relevantMemory,
  toolResolution,
  skillResolution,
  workspaceDir = process.cwd(),
  canReadFiles = true,
}: Omit<RoleWorkProductInput, "role">): string {
  const fileRefs = canReadFiles ? discoverRelevantFiles(task.input, workspaceDir, 6) : [];
  const memoryHighlights = summarizeMemory(relevantMemory, 8);
  const packageInfo = canReadFiles ? readPackageInfo(workspaceDir) : null;

  return [
    "# Research Work Product",
    "",
    "## Research Question",
    `- ${firstMeaningfulLine(task.input)}`,
    "",
    "## Facts",
    ...researchFacts({ task, fileRefs, packageInfo, toolResolution, skillResolution, canReadFiles }),
    "",
    "## Assumptions",
    ...researchAssumptions(task.input),
    "",
    "## Decision-Relevant Context",
    ...(memoryHighlights.length ? memoryHighlights.map((item) => `- Memory: ${item}`) : ["- No relevant memory was found."]),
    ...formatFileContexts(fileRefs),
    "",
    "## Open Questions",
    ...openQuestions(task.input),
    "",
    "## Provider Work Product",
    providerContent.trim() || "(provider returned no content)",
  ].join("\n");
}

function buildReviewerWorkProduct({ task, providerContent }: Pick<RoleWorkProductInput, "task" | "providerContent">): string {
  const input = `${task.input}\n${providerContent}`;
  const reviewedEvidence = `${extractReviewedEvidence(task.input)}\n${providerContent}`;
  const reasons: string[] = [];
  const lower = reviewedEvidence.toLowerCase();
  const acceptanceCriteria = readStringArray(task.metadata.acceptanceCriteria);

  if (/(?:verdict|status)\s*[:=]\s*needs_user_input|needs user input from the user|需要用户|需要补充|clarification required/.test(lower)) {
    reasons.push("The reviewed output asks for user input before the graph can continue.");
  }
  if (hasExecutionFailureSignal(reviewedEvidence)) {
    reasons.push("A reviewed task reports failure or an execution error.");
  }
  if (hasCoverageBlockerSignal(reviewedEvidence)) {
    reasons.push("The reviewed output mentions missing coverage or blockers.");
  }
  if (!/sub-results?:|subagent|developer|researcher|planner|review/i.test(input)) {
    reasons.push("The review input does not include enough subagent result evidence.");
  }

  const verdict = reasons.some((reason) => /user input/i.test(reason))
    ? "needs_user_input"
    : reasons.length
      ? "fail"
      : "pass";
  const confidence = verdict === "pass" ? 0.82 : 0.72;

  const value = {
    verdict,
    reasons: reasons.length ? reasons : [
      "Reviewed output contains usable subagent evidence and no explicit blockers.",
      ...(acceptanceCriteria.length ? [`Acceptance criteria considered: ${acceptanceCriteria.join("; ")}`] : []),
    ],
    retrySuggested: verdict === "fail",
    confidence,
    checkedCriteria: acceptanceCriteria,
    reviewerNotes: providerContent.trim() || "(provider returned no additional review notes)",
  };

  return JSON.stringify(value, null, 2);
}

function extractReviewedEvidence(input: string): string {
  const marker = input.match(/Sub-results?:\s*([\s\S]*)/i);
  if (marker?.[1]) return marker[1];
  return input
    .replace(/pass\/fail\/needs_user_input/gi, "")
    .replace(/verdict.*needs_user_input/gi, "");
}

function hasExecutionFailureSignal(text: string): boolean {
  return signalLines(text).some((line) => {
    if (isNegatedSignalLine(line)) return false;
    return /\bfailed\b|\bfail\b|dead_letter|没有完成|任务执行失败|error:|exception|traceback/.test(line);
  });
}

function hasCoverageBlockerSignal(text: string): boolean {
  return signalLines(text).some((line) => {
    if (isNegatedSignalLine(line) || /^#+\s*risks?\s+and\s+blockers?\b/.test(line)) return false;
    if (/missing|缺少|未覆盖|blocked|阻塞/.test(line)) return true;
    return /\bblockers?\b/.test(line);
  });
}

function signalLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim().toLowerCase())
    .filter(Boolean);
}

function isNegatedSignalLine(line: string): boolean {
  return (
    /\b(no|not|without|none)\b.{0,48}\b(blocking|blocker|blockers|blocked|missing|failed|failure|error|exception)\b/.test(line) ||
    /\b(no|not|without|none)\b.{0,48}\brisk\b/.test(line) ||
    /(?:没有|无|未发现|无需).{0,24}(阻塞|缺少|失败|错误|异常|风险)/.test(line)
  );
}

function discoverRelevantFiles(input: string, workspaceDir: string, limit: number): FileContext[] {
  const refs = unique([
    ...extractFileReferences(input),
    ...defaultContextFiles(input),
  ]);
  const contexts: FileContext[] = [];
  for (const ref of refs) {
    const resolved = safeWorkspacePath(workspaceDir, ref);
    if (!resolved) continue;
    contexts.push(readFileContext(workspaceDir, resolved, ref));
    if (contexts.length >= limit) break;
  }
  return contexts;
}

function extractFileReferences(input: string): string[] {
  const matches = input.matchAll(/(?:^|[\s`'"])([A-Za-z0-9_./-]+\.(?:ts|tsx|js|jsx|json|md|css|html|sql|toml|ya?ml))(?:[:\s`'",)]|$)/g);
  return [...matches].map((match) => match[1]).filter(Boolean);
}

function defaultContextFiles(input: string): string[] {
  const lower = input.toLowerCase();
  const files = ["package.json", "README.md"];
  if (/webui|web ui|adapter|api|http|session/.test(lower)) files.push("src/adapters/web.ts", "src/adapters/webUi.ts");
  if (/tui|terminal|console/.test(lower)) files.push("src/adapters/tui.ts");
  if (/runtime|agent|session|memory|task/.test(lower)) files.push("src/runtime/createRuntime.ts", "src/tasks/TaskStore.ts");
  if (/review|verdict/.test(lower)) files.push("src/review/ReviewerVerdict.ts");
  return files;
}

function safeWorkspacePath(workspaceDir: string, ref: string): string | null {
  const resolved = path.resolve(workspaceDir, ref);
  const root = path.resolve(workspaceDir);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) return null;
  return resolved;
}

interface FileContext {
  ref: string;
  relativePath: string;
  exists: boolean;
  bytes: number;
  lines: number;
  exports: string[];
  functions: string[];
  imports: string[];
}

function readFileContext(workspaceDir: string, resolved: string, ref: string): FileContext {
  const relativePath = path.relative(workspaceDir, resolved) || ref;
  if (!existsSync(resolved)) {
    return {
      ref,
      relativePath,
      exists: false,
      bytes: 0,
      lines: 0,
      exports: [],
      functions: [],
      imports: [],
    };
  }
  const stat = statSync(resolved);
  if (!stat.isFile() || stat.size > 256 * 1024) {
    return {
      ref,
      relativePath,
      exists: false,
      bytes: stat.size,
      lines: 0,
      exports: [],
      functions: [],
      imports: [],
    };
  }
  const text = readFileSync(resolved, "utf8");
  return {
    ref,
    relativePath,
    exists: true,
    bytes: stat.size,
    lines: text.split(/\r?\n/).length,
    exports: collectMatches(text, /\bexport\s+(?:async\s+)?(?:class|function|const|let|var|interface|type)\s+([A-Za-z0-9_]+)/g, 8),
    functions: collectMatches(text, /\b(?:async\s+)?function\s+([A-Za-z0-9_]+)/g, 8),
    imports: collectMatches(text, /\bfrom\s+["']([^"']+)["']/g, 8),
  };
}

interface PackageInfo {
  exists: boolean;
  scripts: string[];
  dependencies: string[];
}

function readPackageInfo(workspaceDir: string): PackageInfo {
  const packagePath = path.join(workspaceDir, "package.json");
  if (!existsSync(packagePath)) return { exists: false, scripts: [], dependencies: [] };
  try {
    const pkg = JSON.parse(readFileSync(packagePath, "utf8")) as {
      scripts?: Record<string, string>;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    return {
      exists: true,
      scripts: Object.keys(pkg.scripts || {}).sort(),
      dependencies: unique([
        ...Object.keys(pkg.dependencies || {}),
        ...Object.keys(pkg.devDependencies || {}),
      ]).sort().slice(0, 12),
    };
  } catch {
    return { exists: true, scripts: [], dependencies: [] };
  }
}

function formatPackageInfo(info: PackageInfo | null, canReadFiles = true): string[] {
  if (!canReadFiles) return ["- File/package context not read because role lacks read_file permission."];
  if (!info) return ["- package.json: not read"];
  if (!info.exists) return ["- package.json: not found"];
  return [
    `- package.json scripts: ${info.scripts.length ? info.scripts.join(", ") : "(none)"}`,
    `- dependencies/devDependencies sampled: ${info.dependencies.length ? info.dependencies.join(", ") : "(none)"}`,
  ];
}

function formatFileContexts(files: FileContext[]): string[] {
  if (!files.length) return ["- No local files were identified from the task."];
  return files.map((file) => {
    if (!file.exists) return `- ${file.relativePath}: not found or not readable`;
    const details = [
      `${file.lines} lines`,
      file.exports.length ? `exports=${file.exports.join(",")}` : "",
      file.functions.length ? `functions=${file.functions.join(",")}` : "",
      file.imports.length ? `imports=${file.imports.join(",")}` : "",
    ].filter(Boolean).join("; ");
    return `- ${file.relativePath}: ${details}`;
  });
}

function implementationStrategy(input: string, fileRefs: FileContext[]): string[] {
  const lower = input.toLowerCase();
  const steps = [
    "- Preserve existing module boundaries and keep edits scoped to the assigned role.",
    "- Update tests near the changed behavior before broad refactors.",
  ];
  if (/session/.test(lower)) steps.push("- Treat session id as the isolation key for UI state, persisted messages, memory scope, and run lookup.");
  if (/webui|web ui/.test(lower)) steps.push("- Keep WebUI dynamic values rendered through DOM text nodes rather than raw innerHTML.");
  if (/review/.test(lower)) steps.push("- Keep reviewer output machine-parseable so MainAgent can enforce verdicts.");
  if (fileRefs.some((file) => !file.exists)) steps.push("- Confirm missing referenced files before claiming implementation completion.");
  return steps;
}

function verificationPlan(info: PackageInfo | null, metadata: Metadata): string[] {
  const explicit = readStringArray(metadata.verificationSteps);
  if (explicit.length) return explicit.map((item) => `- ${item}`);
  if (info?.scripts.includes("check")) return ["- Run `npm run check`."];
  if (info?.scripts.includes("test")) return ["- Run `npm test`."];
  return ["- Run the narrowest available test command for the touched module.", "- Manually inspect any UI or API behavior changed by the task."];
}

function developerRisks(task: Task, toolResolution: ToolHintResolution, fileRefs: FileContext[]): string[] {
  const risks = [];
  if (!toolResolution.allowed.some((tool) => tool.name === "write_file")) {
    risks.push("- This role invocation cannot write files; return an implementation plan instead of claiming edits.");
  }
  if (!toolResolution.allowed.some((tool) => tool.name === "run_tests")) {
    risks.push("- This role invocation cannot run tests; verification must be delegated or performed by the main agent.");
  }
  if (fileRefs.some((file) => !file.exists)) {
    risks.push("- Some referenced files were not found; paths may need clarification.");
  }
  if (!readStringArray(task.metadata.acceptanceCriteria).length) {
    risks.push("- Acceptance criteria are implicit; reviewer confidence should be lower.");
  }
  return risks.length ? risks : ["- No blocking risk detected from local context."];
}

function researchFacts({
  task,
  fileRefs,
  packageInfo,
  toolResolution,
  skillResolution,
  canReadFiles,
}: {
  task: Task;
  fileRefs: FileContext[];
  packageInfo: PackageInfo | null;
  toolResolution: ToolHintResolution;
  skillResolution: SkillHintResolution;
  canReadFiles: boolean | undefined;
}): string[] {
  return [
    `- Task role: ${task.role}; status at execution: ${task.status}.`,
    `- Allowed research tools: ${toolResolution.allowed.map((tool) => tool.name).join(", ") || "(none)"}.`,
    `- Matched skills: ${skillResolution.matched.map((skill) => skill.name).join(", ") || "(none)"}.`,
    canReadFiles
      ? `- package.json ${packageInfo?.exists ? `has scripts: ${packageInfo.scripts.join(", ") || "(none)"}` : "was not found"}.`
      : "- File/package context was not read because role lacks read_file permission.",
    `- Referenced local files found: ${fileRefs.filter((file) => file.exists).length}/${fileRefs.length}.`,
  ];
}

function researchAssumptions(input: string): string[] {
  const assumptions = ["- Current answer should rely on local repository context and recalled memory."];
  if (/latest|today|current|最新|今天/.test(input)) {
    assumptions.push("- The task may require current external information; network access must be explicit before treating facts as up to date.");
  }
  return assumptions;
}

function openQuestions(input: string): string[] {
  const questions = [];
  if (!/poc|uat|production|生产|验收|准出/.test(input.toLowerCase())) {
    questions.push("- What delivery level or exit standard should be used?");
  }
  if (/选择|比较|方案|tradeoff/i.test(input)) {
    questions.push("- Which constraints matter most: speed, correctness, cost, maintainability, or UX?");
  }
  return questions.length ? questions : ["- No blocking research question detected."];
}

function summarizeMemory(memory: MemoryRecallResult, limit: number): string[] {
  return [
    ...memory.shortTerm.map((item) => item.content),
    ...memory.files.map((item) => item.content),
    ...memory.semantic.map((item) => item.content),
  ].map((item) => truncate(item, 180)).filter(Boolean).slice(0, limit);
}

function firstMeaningfulLine(value: string): string {
  return truncate(value.split(/\r?\n/).find((line) => line.trim()) || value, 180);
}

function stringMetadata(metadata: Metadata, key: string): string {
  const value = metadata[key];
  return typeof value === "string" ? value : "";
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

function collectMatches(text: string, pattern: RegExp, limit: number): string[] {
  return unique([...text.matchAll(pattern)].map((match) => match[1]).filter(Boolean)).slice(0, limit);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function truncate(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
}
