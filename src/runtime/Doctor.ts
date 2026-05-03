import type { ProviderHealth } from "../llm/ModelProvider.ts";
import type { SecurityAuditReport } from "../security/SecurityAudit.ts";
import type { RuntimeAnomaly } from "../types.ts";

export interface DoctorReport {
  status: "pass" | "warn" | "fail";
  generatedAt: string;
  readOnly: boolean;
  deep: boolean;
  health: unknown;
  diagnostics: RuntimeAnomaly[];
  providerHealth: ProviderHealth[];
  security: SecurityAuditReport;
  memoryCandidates: {
    pending: number;
  };
  skillCandidates: {
    proposed: number;
  };
  sessions: {
    active: number;
    hidden: number;
    trashed: number;
  };
  gateway: {
    enabled: boolean;
    protocolVersion: number;
    methods: number;
  };
  repair?: {
    diagnostics: RuntimeAnomaly[];
    maintenance: unknown;
  };
}

export async function buildDoctorReport({
  deep = false,
  repair = false,
  health,
  diagnostics,
  checkProviders,
  securityAudit,
  pendingMemoryCandidates,
  proposedSkillCandidates,
  sessions,
  gateway,
  maintenance,
}: {
  deep?: boolean;
  repair?: boolean;
  health: () => unknown;
  diagnostics: (options?: { repair?: boolean; emit?: boolean }) => RuntimeAnomaly[];
  checkProviders: (options?: { deep?: boolean }) => Promise<ProviderHealth[]>;
  securityAudit: (options?: { emit?: boolean }) => Promise<SecurityAuditReport>;
  pendingMemoryCandidates: () => number;
  proposedSkillCandidates: () => number;
  sessions: () => { active: number; hidden: number; trashed: number };
  gateway: () => { enabled: boolean; protocolVersion: number; methods: number };
  maintenance: () => Promise<unknown>;
}): Promise<DoctorReport> {
  const report: DoctorReport = {
    status: "pass",
    generatedAt: new Date().toISOString(),
    readOnly: !repair,
    deep,
    health: health(),
    diagnostics: diagnostics({ repair: false, emit: false }),
    providerHealth: await checkProviders({ deep }),
    security: await securityAudit({ emit: false }),
    memoryCandidates: {
      pending: pendingMemoryCandidates(),
    },
    skillCandidates: {
      proposed: proposedSkillCandidates(),
    },
    sessions: sessions(),
    gateway: gateway(),
  };

  if (repair) {
    report.repair = {
      diagnostics: diagnostics({ repair: true, emit: true }),
      maintenance: await maintenance(),
    };
  }

  report.status = statusFrom(report);
  return report;
}

function statusFrom(report: DoctorReport): DoctorReport["status"] {
  if (report.security.status === "fail") return "fail";
  if (report.diagnostics.some((item) => item.severity === "critical")) return "fail";
  if (report.providerHealth.some((item) => !item.ok && !item.disabled)) return "warn";
  if (report.security.status === "warn") return "warn";
  if (report.diagnostics.some((item) => item.severity === "warning")) return "warn";
  return "pass";
}
