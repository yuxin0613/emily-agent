import { assessTaskComplexity } from "../planning/PlanSpec.ts";

export interface RouteMatch {
  role: string;
  reason: string;
  score: number;
  rule: string;
}

export interface AgentRouteDecision {
  input: string;
  selectedRoles: string[];
  matches: RouteMatch[];
  fallbackRole: string;
}

interface RouteRule {
  id: string;
  role: string;
  reason: string;
  weight: number;
  pattern: RegExp;
}

const ROUTE_RULES: RouteRule[] = [
  {
    id: "developer-code",
    role: "developer",
    reason: "request mentions implementation, code, APIs, UI, architecture, or project build work",
    weight: 4,
    pattern: /(code|bug|fix|实现|开发|报错|架构|node|api|webui|tui|应用|系统|平台|项目|功能|接口|测试|优化|修复)/i,
  },
  {
    id: "researcher-context",
    role: "researcher",
    reason: "request asks for research, comparison, explanation, or context gathering",
    weight: 3,
    pattern: /(research|compare|explain|调研|比较|对比|解释|分析|总结|建议|设计|借鉴)/i,
  },
  {
    id: "reviewer-review",
    role: "reviewer",
    reason: "request explicitly asks for review or quality gate",
    weight: 2,
    pattern: /(review|audit|check|审查|评审|验收|上线前|测试)/i,
  },
  {
    id: "memory-curator",
    role: "memory-curator",
    reason: "request focuses on memory, experience, or best-practice curation",
    weight: 2,
    pattern: /(memory|experience|skill|记忆|经验|技能|沉淀)/i,
  },
];

export class AgentRouter {
  route(input: string, options: { availableRoles?: string[]; includeReviewer?: boolean } = {}): AgentRouteDecision {
    const available = new Set(options.availableRoles || []);
    const assessment = assessTaskComplexity(input);
    const researchOnly = assessment.kind === "research_comparison" || assessment.kind === "research";
    const matches = ROUTE_RULES
      .filter((rule) => !available.size || available.has(rule.role))
      .filter((rule) => !(researchOnly && rule.role === "developer"))
      .filter((rule) => rule.pattern.test(input))
      .map((rule) => ({
        role: rule.role,
        reason: rule.reason,
        score: rule.weight,
        rule: rule.id,
      }))
      .sort((a, b) => b.score - a.score || a.role.localeCompare(b.role));

    const selected = new Set<string>(["planner"]);
    for (const match of matches) {
      if (match.role === "reviewer" && !options.includeReviewer) continue;
      if (match.role === "memory-curator") continue;
      selected.add(match.role);
    }
    if (selected.size === 1) selected.add("researcher");
    if (available.size) {
      for (const role of [...selected]) {
        if (role !== "planner" && !available.has(role)) selected.delete(role);
      }
    }

    return {
      input,
      selectedRoles: [...selected],
      matches,
      fallbackRole: selected.has("developer") ? "developer" : "researcher",
    };
  }
}
