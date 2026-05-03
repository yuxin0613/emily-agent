import type { RoleManager } from "../roles/RoleManager.ts";
import type { SkillRegistry } from "../skills/SkillRegistry.ts";
import type { TaskStore } from "../tasks/TaskStore.ts";
import type { ToolRegistry } from "../tools/ToolRegistry.ts";
import type { ProviderRegistry } from "../llm/ProviderRegistry.ts";
import type { ToolPermission } from "../types.ts";

export interface SecurityAuditFinding {
  id: string;
  severity: "info" | "warning" | "critical";
  title: string;
  detail: string;
  remediation: string;
}

export interface SecurityAuditReport {
  status: "pass" | "warn" | "fail";
  generatedAt: string;
  summary: {
    findings: number;
    critical: number;
    warnings: number;
    roles: number;
    providers: number;
    tools: number;
    skills: number;
  };
  findings: SecurityAuditFinding[];
}

const HIGH_RISK_TOOLS = new Set<ToolPermission>(["git_reset", "delete_file"]);
const APPROVAL_TOOLS = new Set<ToolPermission>(["shell", "network", "http_fetch", "web_search", "browser", "github"]);
const SECRET_KEY_PATTERN = /(apiKey|authorization|token|secret|password)/i;

export async function runSecurityAudit({
  roleManager,
  providerRegistry,
  toolRegistry,
  skillRegistry,
  taskStore,
  emit = true,
}: {
  roleManager: RoleManager;
  providerRegistry: ProviderRegistry;
  toolRegistry: ToolRegistry;
  skillRegistry: SkillRegistry;
  taskStore: TaskStore;
  emit?: boolean;
}): Promise<SecurityAuditReport> {
  const findings: SecurityAuditFinding[] = [];
  const roles = await roleManager.listRoles();
  const providers = providerRegistry.list();
  const tools = toolRegistry.list();
  const skills = skillRegistry.list();

  for (const role of roles) {
    for (const tool of role.allowedTools) {
      if (HIGH_RISK_TOOLS.has(tool)) {
        findings.push({
          id: `role.${role.name}.dangerous_tool.${tool}`,
          severity: "critical",
          title: `Role ${role.name} allows destructive tool ${tool}`,
          detail: "Destructive tools can discard user work or delete workspace files when exposed to a role.",
          remediation: "Remove the tool from allowed_tools and require an explicit audited approval path for destructive operations.",
        });
      }
      if (APPROVAL_TOOLS.has(tool)) {
        findings.push({
          id: `role.${role.name}.approval_tool.${tool}`,
          severity: "warning",
          title: `Role ${role.name} allows approval-sensitive tool ${tool}`,
          detail: "Shell and network access are powerful capabilities and should be reserved for narrowly scoped roles.",
          remediation: "Keep the tool only if the role truly needs it, and pair it with task-level tool hints and review.",
        });
      }
    }
    const unknownSkills = role.skills.filter((skill) => !skillRegistry.get(skill));
    if (unknownSkills.length) {
      findings.push({
        id: `role.${role.name}.unknown_skills`,
        severity: "warning",
        title: `Role ${role.name} references unknown skills`,
        detail: `Unknown skills: ${unknownSkills.join(", ")}`,
        remediation: "Install or remove the missing skills so role prompts are deterministic.",
      });
    }
  }

  for (const provider of providers) {
    if (provider.type === "echo" && provider.id === providerRegistry.defaultProviderId) {
      findings.push({
        id: "provider.default_echo",
        severity: "info",
        title: "Default provider is echo",
        detail: "Echo is useful for local tests but does not provide real model reasoning.",
        remediation: "Configure a production provider before using AgentOS for real workloads.",
      });
    }
    for (const key of Object.keys(provider.config || {})) {
      if (SECRET_KEY_PATTERN.test(key) && key !== "apiKeyEnv") {
        findings.push({
          id: `provider.${provider.id}.secret_config.${key}`,
          severity: "critical",
          title: `Provider ${provider.id} contains secret-like config key ${key}`,
          detail: "Provider configs should reference environment variables instead of storing credentials.",
          remediation: "Move the secret into an environment variable and keep only apiKeyEnv in providers.json.",
        });
      }
    }
  }

  const diagnostics = taskStore.diagnostics({ repair: false, emit: false });
  for (const anomaly of diagnostics.filter((item) => item.severity === "critical")) {
    findings.push({
      id: `diagnostics.${anomaly.code}.${anomaly.id}`,
      severity: "critical",
      title: `Runtime invariant failed: ${anomaly.code}`,
      detail: anomaly.message,
      remediation: "Run maintenance or diagnostics repair and inspect the affected task/run before accepting new work.",
    });
  }

  const critical = findings.filter((finding) => finding.severity === "critical").length;
  const warnings = findings.filter((finding) => finding.severity === "warning").length;
  const report: SecurityAuditReport = {
    status: critical ? "fail" : warnings ? "warn" : "pass",
    generatedAt: new Date().toISOString(),
    summary: {
      findings: findings.length,
      critical,
      warnings,
      roles: roles.length,
      providers: providers.length,
      tools: tools.length,
      skills: skills.length,
    },
    findings,
  };
  if (emit) {
    taskStore.addEvent({
      type: "security.audit",
      payload: {
        status: report.status,
        findings: report.summary.findings,
        critical,
        warnings,
      },
    });
  }
  return report;
}
