import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ProviderCallError } from "./ModelProvider.ts";

export interface CodexAuthCredentials {
  accessToken: string;
  accountId: string;
}

interface CodexAuthFile {
  auth_mode?: unknown;
  tokens?: {
    access_token?: unknown;
    account_id?: unknown;
  };
}

const DEFAULT_CODEX_AUTH_PATH = "~/.codex/auth.json";
const CHATGPT_AUTH_MODES = new Set(["chatgpt", "chatgptauthtokens"]);

export async function readCodexAuthCredentials(authJsonPath = DEFAULT_CODEX_AUTH_PATH, providerId = "codex"): Promise<CodexAuthCredentials> {
  const resolvedPath = resolveCodexAuthPath(authJsonPath);
  let raw = "";
  try {
    raw = await readFile(resolvedPath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw codexAuthError(providerId, `Codex auth file not found: ${resolvedPath}. Run codex login to sign in with ChatGPT.`);
    }
    throw codexAuthError(providerId, `Unable to read Codex auth file: ${resolvedPath}.`);
  }

  let parsed: CodexAuthFile;
  try {
    parsed = JSON.parse(raw) as CodexAuthFile;
  } catch {
    throw codexAuthError(providerId, `Codex auth file is not valid JSON: ${resolvedPath}.`);
  }

  const mode = typeof parsed.auth_mode === "string" ? normalizeAuthMode(parsed.auth_mode) : "";
  if (mode && !CHATGPT_AUTH_MODES.has(mode)) {
    throw codexAuthError(providerId, `Codex auth file is not using ChatGPT auth mode: ${resolvedPath}.`);
  }

  const accessToken = typeof parsed.tokens?.access_token === "string" ? parsed.tokens.access_token.trim() : "";
  const accountId = typeof parsed.tokens?.account_id === "string" ? parsed.tokens.account_id.trim() : "";
  if (!accessToken) {
    throw codexAuthError(providerId, `Codex auth file is missing tokens.access_token: ${resolvedPath}.`);
  }
  if (!accountId) {
    throw codexAuthError(providerId, `Codex auth file is missing tokens.account_id: ${resolvedPath}.`);
  }

  return { accessToken, accountId };
}

export function resolveCodexAuthPath(authJsonPath = DEFAULT_CODEX_AUTH_PATH): string {
  if (authJsonPath === "~") return os.homedir();
  if (authJsonPath.startsWith("~/")) return path.join(os.homedir(), authJsonPath.slice(2));
  return path.resolve(authJsonPath);
}

function normalizeAuthMode(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function codexAuthError(providerId: string, message: string): ProviderCallError {
  return new ProviderCallError({
    providerId,
    code: "auth_error",
    message,
  });
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
