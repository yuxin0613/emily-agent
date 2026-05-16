import type { PlanSpec, PlanTaskSpec } from "./PlanSpec.ts";

export interface ArtifactMaterializationRequirement {
  requiredFiles: string[];
  outputDirectory: string;
}

const ARTIFACT_EXTENSIONS = "html|css|js|jsx|ts|tsx|json|md|txt";

export function artifactRequirementForInput(input: string): ArtifactMaterializationRequirement | null {
  if (!requiresArtifactMaterialization(input)) return null;
  const outputDirectory = extractOutputDirectory(input);
  const explicitFiles = extractExplicitFilePaths(input);
  const requiredFiles = unique(
    explicitFiles.length
      ? explicitFiles.map((file) => outputDirectory && isBareFileName(file) ? joinToolPath(outputDirectory, file) : file)
      : defaultArtifactFiles(input, outputDirectory),
  );
  if (!requiredFiles.length) return null;
  return {
    requiredFiles,
    outputDirectory,
  };
}

export function ensureArtifactMaterializationPlan(plan: PlanSpec, input: string): PlanSpec {
  const requirement = artifactRequirementForInput(input);
  if (!requirement) return plan;

  const existingIndex = plan.tasks.findIndex((task) => task.key === "final_materialization" || task.metadata?.materializationTask === true);
  const finalKey = existingIndex >= 0 ? plan.tasks[existingIndex].key : uniqueTaskKey("final_materialization", new Set(plan.tasks.map((task) => task.key)));
  const nonReviewerDependencies = plan.tasks
    .filter((task) => task.key !== finalKey && task.role !== "reviewer")
    .map((task) => task.key);
  const existing = existingIndex >= 0 ? plan.tasks[existingIndex] : null;
  const finalTask = materializationTask({
    key: finalKey,
    base: existing || undefined,
    plan,
    input,
    requirement,
    dependsOn: unique([
      ...(existing?.dependsOn || []),
      ...nonReviewerDependencies,
    ]).filter((key) => key !== finalKey),
  });

  const tasks = existingIndex >= 0
    ? plan.tasks.map((task, index) => index === existingIndex ? finalTask : task)
    : [...plan.tasks, finalTask];

  return {
    ...plan,
    maxWaves: Math.max(plan.maxWaves, finalTask.wave),
    tasks: tasks.map((task) => {
      if (task.key === finalKey || task.role !== "reviewer") return task;
      return {
        ...task,
        dependsOn: unique([...task.dependsOn, finalKey]).filter((key) => key !== task.key),
      };
    }),
    review: {
      ...plan.review,
      required: true,
      criteria: unique([
        ...plan.review.criteria,
        ...requirement.requiredFiles.map((file) => `Required artifact exists and was written with write_file: ${file}`),
      ]),
    },
  };
}

function materializationTask({
  key,
  base,
  plan,
  input,
  requirement,
  dependsOn,
}: {
  key: string;
  base?: PlanTaskSpec;
  plan: PlanSpec;
  input: string;
  requirement: ArtifactMaterializationRequirement;
  dependsOn: string[];
}): PlanTaskSpec {
  const parentKey = base?.parentKey || preferredMaterializationParent(plan, key);
  return {
    key,
    role: "developer",
    title: base?.title || "final materialization",
    input: [
      `Goal: ${plan.goal}`,
      `Original user request: ${input}`,
      `Delivery level: ${plan.deliveryLevel}`,
      "",
      "Final artifact materialization task.",
      "This task must create the final runnable files, not only describe a design or partial slice.",
      "Return one executable JSON object with a top-level toolRequests array.",
      "Use write_file once for each required artifact file with complete final file contents.",
      "Do not claim completion unless every required file is written by write_file.",
      "",
      "Required artifact files:",
      ...requirement.requiredFiles.map((file) => `- ${file}`),
      "",
      "Required JSON shape:",
      JSON.stringify({
        toolRequests: requirement.requiredFiles.map((file) => ({
          tool: "write_file",
          args: {
            path: file,
            content: "complete file content",
          },
        })),
      }, null, 2),
    ].join("\n"),
    parentKey,
    dependsOn,
    dependencyType: "finished",
    acceptanceCriteria: [
      "Every required artifact file is written by a successful write_file tool execution.",
      "Every required artifact file exists on disk after execution.",
      "The generated artifacts satisfy the requested runnable application or file output.",
    ],
    toolHints: unique([...(base?.toolHints || []), "read_file", "write_file", "run_tests"]),
    skillHints: unique([...(base?.skillHints || []), "coding", "implementation"]),
    timeoutMs: base?.timeoutMs || 30000,
    maxRetries: Math.max(base?.maxRetries ?? 1, 1),
    maxResultChars: Math.max(base?.maxResultChars || 12000, 20000),
    maxMemoryCandidates: base?.maxMemoryCandidates ?? 1,
    wave: Math.max(base?.wave || 1, ...plan.tasks.map((task) => task.wave || 1)) + (base ? 0 : 1),
    expandable: false,
    expansionGoal: "",
    maxExpansionDepth: 0,
    permissionMode: base?.permissionMode || "danger_full_access",
    metadata: {
      ...(base?.metadata || {}),
      materializationTask: true,
      requiredFiles: requirement.requiredFiles,
      artifactOutputDirectory: requirement.outputDirectory,
    },
  };
}

function requiresArtifactMaterialization(input: string): boolean {
  return /(?:保存|保存到|输出到|写入|落盘|生成|编写|写一个|写代码|创建|新建).{0,80}(?:文件|代码|源码|网页|页面|HTML|html|index|artifact|file|code|source|应用|app|web)/i.test(input)
    || /(?:write|create|generate|scaffold|save|output).{0,80}(?:file|code|source|html|page|artifact|app|web)/i.test(input)
    || extractExplicitFilePaths(input).length > 0;
}

function extractOutputDirectory(text: string): string {
  const match = text.match(/(?:保存到|输出到|写入到|放到|存到|目录是|目录为|save\s+(?:to|under|in)|output\s+(?:to|under|in)|write\s+(?:to|under|in))\s*[:：]?\s*(~\/[^\s`'",，。；;]+|\/[^\s`'",，。；;]+|\.{1,2}\/[^\s`'",，。；;]+|[A-Za-z0-9_./-]+\/[^\s`'",，。；;]*)/i);
  if (!match?.[1]) return "";
  return match[1].replace(/[),.，。；;]+$/g, "").replace(/\/$/, "");
}

function extractExplicitFilePaths(text: string): string[] {
  const pattern = new RegExp(`~\\/[^\\s\`'"、,，]+\\.(?:${ARTIFACT_EXTENSIONS})|\\/[^\\s\`'"、,，]+\\.(?:${ARTIFACT_EXTENSIONS})|\\.{1,2}\\/[^\\s\`'"、,，]+\\.(?:${ARTIFACT_EXTENSIONS})|[A-Za-z0-9_.-]+\\.(?:${ARTIFACT_EXTENSIONS})`, "gi");
  const values: string[] = [];
  for (const match of text.matchAll(pattern)) {
    const value = (match[0] || "").replace(/[),.，。；;]+$/g, "");
    if (!value) continue;
    const start = match.index || 0;
    const end = start + match[0].length;
    if (!isFilePathBoundary(text[start - 1]) || !isFilePathBoundary(text[end])) continue;
    values.push(value);
  }
  return unique(values);
}

function isFilePathBoundary(value: string | undefined): boolean {
  return !value || /[\s`'",、，:：)，。；;()]/.test(value);
}

function defaultArtifactFiles(input: string, outputDirectory: string): string[] {
  const webLike = /(?:web|html|网页|前端|浏览器|纯前端|网站|app|应用)/i.test(input);
  if (webLike && outputDirectory) {
    return ["index.html", "styles.css", "app.js", "README.md"].map((file) => joinToolPath(outputDirectory, file));
  }
  if (outputDirectory) return [joinToolPath(outputDirectory, "README.md")];
  return [];
}

function preferredMaterializationParent(plan: PlanSpec, finalKey: string): string | undefined {
  const candidates = ["implementation_slices", "implementation", "interface_surface", "architecture", "scope", "goal"];
  for (const key of candidates) {
    if (key !== finalKey && plan.tasks.some((task) => task.key === key)) return key;
  }
  return plan.tasks.find((task) => task.key !== finalKey && task.role !== "reviewer")?.key;
}

function uniqueTaskKey(base: string, existing: Set<string>): string {
  if (!existing.has(base)) return base;
  for (let index = 2; index < 1000; index += 1) {
    const key = `${base}_${index}`;
    if (!existing.has(key)) return key;
  }
  throw new Error(`Unable to create unique task key for ${base}`);
}

function isBareFileName(value: string): boolean {
  return !value.startsWith("~/") && !value.startsWith("/") && !value.startsWith("./") && !value.startsWith("../") && !value.includes("/");
}

function joinToolPath(directory: string, fileName: string): string {
  return `${directory.replace(/\/+$/g, "")}/${fileName.replace(/^\/+/g, "")}`;
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
