export interface ReviewerVerdict {
  verdict: "pass" | "fail" | "needs_user_input";
  reasons: string[];
  retrySuggested: boolean;
  confidence: number;
}

export function parseReviewerVerdict(content: string): ReviewerVerdict {
  const parsed = parseJsonVerdict(content);
  if (parsed) return parsed;

  const normalized = content.toLowerCase();
  if (/needs_user_input|needs user input|需要用户|需要补充/.test(normalized)) {
    return {
      verdict: "needs_user_input",
      reasons: [content],
      retrySuggested: false,
      confidence: 0.45,
    };
  }

  if (/\bfail\b|不通过|failed|missing|缺少/.test(normalized)) {
    return {
      verdict: "fail",
      reasons: [content],
      retrySuggested: /retry|重试/.test(normalized),
      confidence: 0.45,
    };
  }

  return {
    verdict: "pass",
    reasons: [content],
    retrySuggested: false,
    confidence: 0.4,
  };
}

function parseJsonVerdict(content: string): ReviewerVerdict | null {
  const json = extractJson(content);
  if (!json) return null;
  try {
    const value = JSON.parse(json) as Partial<ReviewerVerdict>;
    if (value.verdict !== "pass" && value.verdict !== "fail" && value.verdict !== "needs_user_input") {
      return null;
    }
    return {
      verdict: value.verdict,
      reasons: Array.isArray(value.reasons) ? value.reasons.map(String) : [],
      retrySuggested: Boolean(value.retrySuggested),
      confidence: typeof value.confidence === "number" ? value.confidence : 0.6,
    };
  } catch {
    return null;
  }
}

function extractJson(content: string): string | null {
  const fenced = content.match(/```json\s*([\s\S]*?)```/);
  if (fenced) return fenced[1];
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  return content.slice(start, end + 1);
}
