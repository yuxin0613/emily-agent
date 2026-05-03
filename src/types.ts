export type TaskStatus =
  | "pending"
  | "queued"
  | "running"
  | "blocked"
  | "needs_inspection"
  | "done"
  | "failed"
  | "cancelled"
  | "dead_letter";

export type AgentStatus = "idle" | "running" | "exited" | "stale";

export type ToolPermission =
  | "read_file"
  | "write_file"
  | "run_tests"
  | "shell"
  | "network"
  | "create_task"
  | "inspect_task"
  | "git_reset"
  | "delete_file";

export type PermissionMode = "read_only" | "workspace_write" | "danger_full_access";

export interface ToolDefinition {
  name: ToolPermission;
  description: string;
  permission: ToolPermission;
  category: "filesystem" | "process" | "network" | "task" | "vcs";
  sideEffects: "none" | "read" | "write" | "execute" | "network" | "destructive";
  requiresApproval: boolean;
  aliases: string[];
  instructions: string;
}

export interface ToolHintResolution {
  requested: string[];
  allowed: ToolDefinition[];
  denied: string[];
  unknown: string[];
  permissionMode?: PermissionMode;
}

export interface SkillDefinition {
  name: string;
  title: string;
  description: string;
  capabilities: string[];
  toolHints: ToolPermission[];
  aliases: string[];
  triggers: string[];
  antiTriggers: string[];
  instructions: string;
  source: "builtin" | "file";
}

export type SkillCandidateStatus = "proposed" | "approved" | "merged" | "rejected";
export type SkillProposalType = "create" | "update";

export interface SkillCandidate {
  id: string;
  status: SkillCandidateStatus;
  proposalType: SkillProposalType;
  workflowKey: string;
  name: string;
  title: string;
  description: string;
  trigger: string[];
  antiTrigger: string[];
  toolHints: ToolPermission[];
  body: string;
  targetSkillName: string | null;
  evidenceTaskIds: string[];
  evidenceEventIds: number[];
  frequency: number;
  successRate: number;
  workflowSimilarity: number;
  verificationQuality: number;
  volatility: number;
  overlapWithExisting: number;
  projectSpecificity: number;
  score: number;
  createdAt: string;
  updatedAt: string;
  decidedAt: string | null;
  decisionReason: string | null;
}

export interface SkillCandidateProposal {
  proposalType: SkillProposalType;
  workflowKey: string;
  name: string;
  title: string;
  description: string;
  trigger: string[];
  antiTrigger: string[];
  toolHints: ToolPermission[];
  body: string;
  targetSkillName?: string | null;
  evidenceTaskIds: string[];
  evidenceEventIds?: number[];
  frequency: number;
  successRate: number;
  workflowSimilarity: number;
  verificationQuality: number;
  volatility: number;
  overlapWithExisting: number;
  projectSpecificity: number;
  score: number;
}

export interface SkillHintResolution {
  requested: string[];
  matched: SkillDefinition[];
  unknown: string[];
  blocked?: string[];
  autoSelected?: string[];
}

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type Metadata = Record<string, JsonValue>;

export interface Task {
  id: string;
  role: string;
  status: TaskStatus;
  title: string;
  input: string;
  result: string | null;
  error: string | null;
  assignedAgentId: string | null;
  parentTaskId: string | null;
  metadata: Metadata;
  retryCount: number;
  maxRetries: number;
  leaseOwner: string | null;
  leaseToken: string | null;
  leaseExpiresAt: string | null;
  heartbeatAt: string | null;
  mainAckAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type RunStatus =
  | "running"
  | "reviewing"
  | "recovering"
  | "partially_done"
  | "waiting_user"
  | "done"
  | "failed"
  | "blocked"
  | "cancelled";

export interface Run {
  id: string;
  sessionId: string;
  source: string;
  userInput: string;
  status: RunStatus;
  startedAt: string;
  completedAt: string | null;
}

export type SessionStatus = "active" | "hidden" | "trashed" | "deleted";

export interface Session {
  id: string;
  title: string;
  status: SessionStatus;
  source: string;
  runCount: number;
  createdAt: string;
  updatedAt: string;
  lastActiveAt: string | null;
  hiddenAt: string | null;
  trashedAt: string | null;
  deleteAfter: string | null;
  archiveSummary: string | null;
  metadata: Metadata;
}

export type SessionMessageRole = "user" | "assistant" | "system" | "error";

export interface SessionMessage {
  id: string;
  sessionId: string;
  runId: string | null;
  role: SessionMessageRole;
  content: string;
  delegatedTo: string[];
  metadata: Metadata;
  createdAt: string;
}

export interface TaskDependency {
  taskId: string;
  dependsOnTaskId: string;
  dependencyType: "success" | "finished";
  createdAt: string;
}

export interface TaskGraph {
  id: string;
  runId: string | null;
  status: "pending" | "running" | "done" | "failed";
  createdAt: string;
  completedAt: string | null;
}

export interface TaskEvent {
  id: number;
  type: string;
  taskId: string | null;
  agentId: string | null;
  payload: Metadata;
  createdAt: string;
}

export interface TaskResult {
  status: "success" | "failed" | "needs_user_input" | "cancelled";
  summary: string;
  artifacts: Array<{
    type: string;
    uri?: string;
    title?: string;
    metadata?: Metadata;
  }>;
  memoryCandidates: Array<{
    scope?: string;
    kind?: string;
    content: string;
    metadata?: Metadata;
  }>;
  nextActions: string[];
}

export interface RuntimeAnomaly {
  id: string;
  severity: "info" | "warning" | "critical";
  code: string;
  message: string;
  taskId?: string;
  runId?: string;
  graphId?: string;
  repaired: boolean;
}

export type RuntimeEventType =
  | "run.started"
  | "run.status"
  | "run.completed"
  | "session.created"
  | "session.updated"
  | "session.hidden"
  | "session.restored"
  | "session.trashed"
  | "session.deleted"
  | "session.message.created"
  | "task.created"
  | "task.dependency.created"
  | "task.queued"
  | "task.waiting"
  | "task.running"
  | "task.heartbeat"
  | "task.heartbeat_ignored"
  | "task.stale_worker_ignored"
  | "task.done"
  | "task.failed"
  | "task.cancelled"
  | "task.cancel_ignored"
  | "task.dead_letter"
  | "task.acknowledged"
  | "agent.profile.created"
  | "task_graph.created"
  | "task_graph.status"
  | "task_graph.completed"
  | "task_graph.expansion_planned"
  | "task_graph.expanded"
  | "task_graph.waiting_user"
  | "tool.hints.resolved"
  | "skill.hints.resolved"
  | "skill.used"
  | "context.built"
  | "gateway.connected"
  | "gateway.request"
  | "gateway.response"
  | "security.audit"
  | "memory.candidate.created"
  | "memory.candidate.approved"
  | "memory.candidate.rejected"
  | "runtime.anomaly"
  | "runtime.maintenance"
  | "experience.updated";

export interface Timeline {
  run: Run | null;
  tasks: Task[];
  events: TaskEvent[];
}

export interface RoleDefinition {
  name: string;
  role: string;
  singleton: boolean;
  provider?: string;
  model?: string;
  temperature?: number;
  allowedTools: ToolPermission[];
  forbiddenTools: ToolPermission[];
  maxConcurrentTasks: number;
  capabilities: string[];
  skills: string[];
  skillAllowlist?: string[];
  outputContract?: string;
  instructions: string;
}

export interface MemoryRecallResult {
  shortTerm: Array<MemoryRecord & { score: number }>;
  files: Array<MemoryRecord & { score: number }>;
  semantic: Array<MemoryRecord & { score: number }>;
}

export interface MemoryRecord {
  id: string;
  scope: string;
  kind: string;
  content: string;
  metadata: Metadata;
  createdAt: string;
}

export interface MemoryCandidate {
  id: string;
  runId: string | null;
  taskId: string | null;
  scope: string;
  kind: string;
  content: string;
  status: "pending" | "approved" | "rejected";
  createdBy: string;
  createdAt: string;
  decidedAt: string | null;
}

export type ExperienceStatus = "active" | "archived" | "deprecated";

export type ExperienceType =
  | "lesson"
  | "failure"
  | "solution"
  | "preference"
  | "decision"
  | "procedure";

export type ExperienceUpdateAction = "create" | "replace" | "merge" | "skip" | "conflict" | "split" | "deprecate";

export interface Experience {
  id: string;
  revision: number;
  status: ExperienceStatus;
  scope: "project" | "user" | "agent" | "system";
  type: ExperienceType;
  topicKey: string;
  title: string;
  summary: string;
  problemPattern: string;
  solutionPattern: string;
  applicability: string;
  contraindications: string[];
  evidenceTaskIds: string[];
  evidenceEventIds: number[];
  confidence: number;
  importance: number;
  reuseCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ExperienceCandidate {
  scope: Experience["scope"];
  type: ExperienceType;
  topicKey: string;
  title: string;
  summary: string;
  problemPattern: string;
  solutionPattern: string;
  applicability?: string;
  contraindications?: string[];
  evidenceTaskIds: string[];
  evidenceEventIds?: number[];
  confidence: number;
  importance: number;
  changeReason: string;
}

export interface ExperienceRevision {
  id: string;
  experienceId: string;
  revision: number;
  title: string;
  summary: string;
  problemPattern: string;
  solutionPattern: string;
  applicability: string;
  contraindications: string[];
  confidence: number;
  importance: number;
  evidenceTaskIds: string[];
  evidenceEventIds: number[];
  changeReason: string;
  createdAt: string;
}

export interface ExperienceRecallResult extends Experience {
  score: number;
  vectorScore?: number;
  lexicalScore?: number;
  applicabilityScore?: number;
  feedbackScore?: number;
  recallReason?: string;
}

export type ExperienceFeedbackRating = "useful" | "wrong" | "outdated" | "duplicate";

export interface ExperienceFeedback {
  id: string;
  experienceId: string;
  rating: ExperienceFeedbackRating;
  comment: string;
  createdAt: string;
}
