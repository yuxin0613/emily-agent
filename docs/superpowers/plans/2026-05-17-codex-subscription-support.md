# Codex Subscription Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a first-class `codex` model provider that reuses local Codex ChatGPT login credentials.

**Architecture:** Keep Codex subscription auth separate from the existing OpenAI API-key provider. Add a focused auth-file helper and a `CodexModelProvider` that speaks the Responses endpoint, then wire it into provider registry, health checks, model setup, tests, and docs.

**Tech Stack:** Node.js 22, TypeScript, native `fetch`, existing `ProviderRegistry`, existing `ResilientModelProvider`, node test scripts.

---

## File Structure

- Create `src/llm/CodexAuth.ts`: read and validate Codex `auth.json` without exposing token values in errors.
- Create `src/llm/CodexModelProvider.ts`: implement the Responses call and response extraction.
- Modify `src/llm/ModelProvider.ts`: add `codex` provider type and `authJsonPath` config key.
- Modify `src/llm/ProviderRegistry.ts`: instantiate Codex provider, validate config, and add health checks.
- Modify `src/adapters/modelConfig.ts`: add the interactive Codex provider template and default model detection from `~/.codex/config.toml`.
- Modify `test/provider.test.ts`: cover config validation and health behavior.
- Create `test/codex-provider.test.ts`: cover auth errors and mock Responses success.
- Modify `test/model-config.test.ts`: cover model setup creating a Codex provider.
- Modify `package.json`: add the Codex provider test to the suite.
- Modify `README.md` and `user-guide.md`: document Codex subscription provider setup and safety boundaries.

## Task 1: Codex Auth Helper

**Files:**
- Create: `src/llm/CodexAuth.ts`
- Test: `test/codex-provider.test.ts`

- [ ] **Step 1: Write the failing auth tests**

Add tests that call `new CodexModelProvider(...).complete(...)` with a missing `authJsonPath` and assert a `ProviderCallError` with `code === "auth_error"`.

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/codex-provider.test.ts`

Expected: FAIL because `test/codex-provider.test.ts` or `CodexModelProvider` does not exist.

- [ ] **Step 3: Add auth helper**

Implement:

```ts
export interface CodexAuthCredentials {
  accessToken: string;
  accountId: string;
}

export async function readCodexAuthCredentials(authJsonPath?: string): Promise<CodexAuthCredentials>
```

The helper expands `~`, reads JSON, accepts `chatgpt` and `chatgptauthtokens` auth modes when present, and throws `ProviderCallError` with `auth_error` on missing data.

- [ ] **Step 4: Run test to verify it reaches the next missing implementation**

Run: `node test/codex-provider.test.ts`

Expected: FAIL because provider wiring or HTTP behavior is still missing.

## Task 2: Codex Model Provider

**Files:**
- Create: `src/llm/CodexModelProvider.ts`
- Modify: `src/llm/ModelProvider.ts`
- Test: `test/codex-provider.test.ts`

- [ ] **Step 1: Write the mock Responses success test**

Start a local HTTP server. Assert request headers include `authorization` and `ChatGPT-Account-ID`; respond with:

```json
{
  "output_text": "{\"summary\":\"codex ok\"}",
  "usage": {
    "input_tokens": 3,
    "output_tokens": 4,
    "total_tokens": 7
  }
}
```

Assert provider result contains raw content and usage.

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/codex-provider.test.ts`

Expected: FAIL because `CodexModelProvider` does not send the request yet.

- [ ] **Step 3: Implement provider**

Implement `complete()` with endpoint `${baseUrl}/responses`, request body containing `model`, `input` messages, and optional `temperature`. Extract content from `output_text` first, then from `output[].content[]`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/codex-provider.test.ts`

Expected: PASS.

## Task 3: Registry, Validation, And Health

**Files:**
- Modify: `src/llm/ProviderRegistry.ts`
- Modify: `src/llm/ModelProvider.ts`
- Test: `test/provider.test.ts`

- [ ] **Step 1: Add failing registry tests**

Add assertions that `runtime.addProvider({ id: "main-codex", type: "codex", model: "gpt-5.5", config: { authJsonPath } })` is accepted, `providerRegistry.createProvider("main-codex")` returns a model, and shallow health reports missing auth clearly.

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/provider.test.ts`

Expected: FAIL with invalid provider type.

- [ ] **Step 3: Wire registry**

Add `codex` handling to `createProvider`, `checkProvider`, validation, and allowed config keys.

- [ ] **Step 4: Run tests**

Run: `node test/provider.test.ts && node test/codex-provider.test.ts`

Expected: PASS.

## Task 4: Model Setup Template

**Files:**
- Modify: `src/adapters/modelConfig.ts`
- Test: `test/model-config.test.ts`

- [ ] **Step 1: Add failing model setup test**

Use the non-TTY model config flow with inputs `new`, `codex`, ``, `done` and assert the provider type is `codex`, model is read from a temp Codex config when present, and rendered output does not ask for an API key.

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/model-config.test.ts`

Expected: FAIL because the template is unknown.

- [ ] **Step 3: Add Codex template**

Add a `codex` template with default base URL `https://chatgpt.com/backend-api/codex`, default auth file `~/.codex/auth.json`, and model fallback read from `~/.codex/config.toml`.

- [ ] **Step 4: Run test**

Run: `node test/model-config.test.ts`

Expected: PASS.

## Task 5: Docs And Suite

**Files:**
- Modify: `README.md`
- Modify: `user-guide.md`
- Modify: `package.json`

- [ ] **Step 1: Add docs**

Document the Codex provider example, explain it uses local Codex ChatGPT login, and state that Emily stores only auth file path and endpoint settings.

- [ ] **Step 2: Add the new test to package script**

Insert `node test/codex-provider.test.ts` near `node test/provider.test.ts`.

- [ ] **Step 3: Run final verification**

Run: `npm run typecheck && npm test`

Expected: exit code 0.

