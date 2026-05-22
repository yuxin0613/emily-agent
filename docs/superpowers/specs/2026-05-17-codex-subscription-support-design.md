# Codex Subscription Support Design

## Goal

Emily AgentOS should be able to use the local Codex ChatGPT subscription login as a model provider without requiring an OpenAI API key.

## Scope

This change adds a new `codex` provider type. The provider reads `~/.codex/auth.json` or a configured auth file path at request time, extracts the ChatGPT access token and account id, and calls the Codex Responses backend. It does not persist raw tokens in `.emily/config.json`.

Out of scope for this pass:

- Running or wrapping `codex exec`.
- Implementing the OAuth refresh flow directly in Emily.
- Replacing the existing OpenAI API-key provider.
- Adding a new UI surface beyond the existing model setup template and provider list.

## Architecture

The existing provider system stays intact:

- `ProviderType` gains `codex`.
- `ProviderRegistry.createProvider()` instantiates `CodexModelProvider` for `codex`.
- `CodexModelProvider` implements `ModelProvider.complete()` and returns the same `ModelCompleteResult` shape used by other providers.
- The resilient wrapper continues to handle retry, circuit breaking, strict JSON normalization, quotas, usage records, and cost estimates.

Codex authentication is read through a small helper rather than mixed into `OpenAIModelProvider`. The helper validates only the fields Emily needs:

- `tokens.access_token`
- `tokens.account_id`
- compatible `auth_mode`, when present

The default endpoint is `https://chatgpt.com/backend-api/codex/responses`. A provider config can override `config.baseUrl`, but the token and account id never move into provider config.

## Data Flow

1. User configures a Codex provider through `emily model` or `.emily/config.json`.
2. Runtime creates a resilient `CodexModelProvider`.
3. Each model call reads the latest auth file, so Emily can pick up token changes written by Codex.
4. The provider sends a Responses-style request with the configured model, a system message containing agent and role, and the user prompt.
5. The provider extracts text from `output_text` or structured `output[].content[]` responses.
6. Usage and errors flow back through the existing provider runtime.

## Error Handling

Missing, malformed, or incomplete Codex auth produces `ProviderCallError` with `auth_error`. HTTP status codes use the same classifier as OpenAI-compatible providers. Empty model output is left to the resilient wrapper, matching current provider behavior.

Shallow health checks verify the auth file can be read and contains the required token/account fields. Deep health checks issue a minimal `/responses` request and report the HTTP status.

## Configuration

Example:

```json
{
  "defaultProviderId": "main-codex",
  "providers": [
    {
      "id": "main-codex",
      "type": "codex",
      "model": "gpt-5.5",
      "config": {
        "authJsonPath": "~/.codex/auth.json",
        "baseUrl": "https://chatgpt.com/backend-api/codex",
        "strictJson": true,
        "maxRetries": 2
      }
    }
  ]
}
```

`authJsonPath` is optional and defaults to `~/.codex/auth.json`.

## Testing

Tests should cover:

- Provider config accepts `type: "codex"` and rejects raw secrets.
- Missing auth file fails with `auth_error`.
- Mock Codex Responses endpoint returns text and usage.
- Health checks handle shallow auth validation and deep HTTP validation.
- `emily model` can create a Codex provider without prompting for an API key.

