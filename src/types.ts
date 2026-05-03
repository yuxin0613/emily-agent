export type TaskStatus =
  | "pending"
  | "queued"
  | "running"
  | "blocked"
  | "needs_inspection"
  | "done"
  | "failed"
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
  leaseExpiresAt: string | null;
  heartbeatAt: string | null;
  mainAckAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TaskEvent {
  id: number;
  type: string;
  taskId: string | null;
  agentId: string | null;
  payload: Metadata;
  createdAt: string;
}

export interface RoleDefinition {
  role: string;
  singleton: boolean;
  allowedTools: ToolPermission[];
  forbiddenTools: ToolPermission[];
  maxConcurrentTasks: number;
  capabilities: string[];
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

export type ExperienceStatus = "active" | "archived" | "deprecated";

export type ExperienceType =
  | "lesson"
  | "failure"
  | "solution"
  | "preference"
  | "decision"
  | "procedure";

export type ExperienceUpdateAction = "create" | "replace" | "merge" | "skip";

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
  confidence: number;
  importance: number;
  evidenceTaskIds: string[];
  evidenceEventIds: number[];
  changeReason: string;
  createdAt: string;
}

export interface ExperienceRecallResult extends Experience {
  score: number;
}
