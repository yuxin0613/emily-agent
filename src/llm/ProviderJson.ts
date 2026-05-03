import type { JsonData, JsonOutputFormat } from "./ModelProvider.ts";

export interface NormalizedJsonOutput {
  content: string;
  json: JsonData;
  format: JsonOutputFormat;
  warnings: string[];
}

export function normalizeProviderJsonOutput(raw: string): NormalizedJsonOutput {
  const direct = parseJson(raw);
  if (direct.ok) return fromJson(direct.value, "json", []);

  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    const parsed = parseJson(fenced[1] || "");
    if (parsed.ok) return fromJson(parsed.value, "json_extracted", ["json_extracted_from_code_fence"]);
  }

  const extracted = extractJsonCandidate(raw);
  if (extracted) {
    const parsed = parseJson(extracted);
    if (parsed.ok) return fromJson(parsed.value, "json_extracted", ["json_extracted_from_text"]);
  }

  const content = raw.trim();
  return {
    content,
    json: {
      content,
      metadata: {
        fallback: true,
        reason: "llm_returned_non_json",
      },
    },
    format: "wrapped_text",
    warnings: ["llm_returned_non_json"],
  };
}

export function jsonInstruction(): string {
  return [
    "",
    "# Response Format",
    "Return only one valid JSON object. Do not wrap it in markdown.",
    "Required shape:",
    "{\"content\":\"string\",\"metadata\":{}}",
    "The content field must contain the useful answer for the caller.",
  ].join("\n");
}

function fromJson(value: JsonData, format: JsonOutputFormat, warnings: string[]): NormalizedJsonOutput {
  const content = extractContent(value);
  if (isObject(value)) {
    return {
      content,
      json: value,
      format,
      warnings,
    };
  }
  return {
    content,
    json: {
      content,
      value,
    },
    format,
    warnings: [...warnings, "json_value_wrapped_as_object"],
  };
}

function extractContent(value: JsonData): string {
  if (typeof value === "string") return value;
  if (!isObject(value)) return JSON.stringify(value);
  for (const key of ["content", "summary", "result", "message", "text"]) {
    const candidate = value[key];
    if (typeof candidate === "string") return candidate;
  }
  return JSON.stringify(value);
}

function parseJson(value: string): { ok: true; value: JsonData } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(value.trim()) as JsonData };
  } catch {
    return { ok: false };
  }
}

function extractJsonCandidate(raw: string): string | null {
  const start = firstJsonStart(raw);
  if (start < 0) return null;
  const open = raw[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < raw.length; index += 1) {
    const char = raw[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }
    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === open) depth += 1;
    if (char === close) {
      depth -= 1;
      if (depth === 0) return raw.slice(start, index + 1);
    }
  }
  return null;
}

function firstJsonStart(raw: string): number {
  const objectStart = raw.indexOf("{");
  const arrayStart = raw.indexOf("[");
  if (objectStart === -1) return arrayStart;
  if (arrayStart === -1) return objectStart;
  return Math.min(objectStart, arrayStart);
}

function isObject(value: JsonData): value is { [key: string]: JsonData } {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
