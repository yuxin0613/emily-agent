# Emily AgentOS User Guide

This guide explains how to use Emily AgentOS as a local multi-agent runtime and as a base for other agent applications.

## 1. Install And Check

One-command install:

```bash
curl -fsSL https://raw.githubusercontent.com/yuxinhuang/emily-agent/main/scripts/install.sh | bash
```

If the public GitHub URL is different, set `EMILY_REPO_URL` before running the installer.

SQLite persistence uses `better-sqlite3`. Most Node 22 platforms install a prebuilt binary; unsupported platforms may need local native build tools.

After installation:

```bash
emily --doctor --deep
emily
EMILY_WEB_TOKEN=change-me emily --web
```

Manual source checkout:

```bash
npm install
```

The installer command stores runtime data in `~/.emily/data` through `EMILY_DATA_DIR`. A manual checkout stores runtime data in the current repo's `.emily/` directory unless you set `EMILY_DATA_DIR` yourself.

Run the readiness check:

```bash
npm run check
npm audit --audit-level=moderate
node src/index.ts --doctor --deep
node src/index.ts --security-audit
```

If the security audit reports `provider.default_echo`, configure a production model provider before using the runtime for real work.

## 2. Choose An Interface

Terminal UI:

```bash
npm run tui
```

WebUI:

```bash
EMILY_WEB_TOKEN=change-me npm run web
```

Open:

```text
http://127.0.0.1:3000/?token=change-me
```

WebSocket gateway:

```text
ws://127.0.0.1:3000/gateway?token=change-me
```

Use the gateway when another application wants to drive AgentOS directly.

## 3. Configure Providers

Providers are stored in `.emily/providers.json`.

Use `echo` for local architecture tests only. Use `openai` or `ollama` for real model work.

OpenAI-compatible example:

```json
{
  "defaultProviderId": "openai-main",
  "fallbackMode": "fallback",
  "providers": [
    {
      "id": "openai-main",
      "type": "openai",
      "model": "gpt-4.1-mini",
      "config": {
        "baseUrl": "https://api.openai.com/v1",
        "apiKeyEnv": "OPENAI_API_KEY",
        "strictJson": true
      }
    }
  ]
}
```

Then run:

```bash
export OPENAI_API_KEY=...
node src/index.ts --doctor --deep
```

Provider rules:

- Store only environment variable names, not raw keys.
- Set role-specific providers only when needed.
- Subagents fallback to the main/default provider if their role provider is unavailable.
- Check usage with the provider dashboard or `provider.usage` command.

## 4. Work With Sessions

Sessions isolate conversation context.

Use `/new` when you want a fresh session.

Use `/clear` when you want a fresh session and want the old one hidden.

Restore hidden or trashed sessions explicitly from the WebUI or session commands.

Useful session operations:

```text
:resume latest
:export-session <sessionId>
:compact-preview <sessionId>
:session-usage <sessionId>
```

For external apps, use gateway methods:

- `sessions.list`
- `sessions.create`
- `sessions.clear`
- `sessions.restore`
- `sessions.trash`
- `sessions.resume_latest`
- `sessions.export`
- `sessions.compact_preview`
- `sessions.usage`

## 5. Ask For Long Tasks

For result-oriented work, include the desired delivery level:

```text
Build a small issue tracker to production level.
```

Delivery levels:

- `poc`: prove the idea.
- `uat`: ready for user acceptance testing.
- `production`: stronger tests, hardening, documentation, and operational checks.

If you omit the delivery level for an obvious long task, AgentOS may pause and ask you to choose one.

The runtime will:

1. create a run;
2. create an initial task graph;
3. execute ready tasks by role;
4. dynamically expand tasks when more detail is needed;
5. replan failed branches when possible;
6. review results;
7. summarize the outcome.

## 6. Understand Roles

Default roles:

- `planner`: decomposes goals and graph changes.
- `developer`: implements code and verification tasks.
- `researcher`: gathers context.
- `reviewer`: checks results against criteria.
- `inspector`: checks incomplete or suspicious tasks.
- `memory-curator`: extracts reusable experience.

Role files live at:

```text
agents/<role>/agent.md
```

Update a role when you want to change:

- allowed tools;
- forbidden tools;
- model/provider;
- output style;
- workflow constraints;
- skills.

## 7. Use Permission Modes

Every run or task can carry a permission mode.

Use `read_only` when the agent should inspect only.

Use `workspace_write` for normal coding work.

Use `danger_full_access` only when a trusted operator intentionally allows broader role-defined tools.

Even in `danger_full_access`, role `forbidden_tools` and tool approvals still apply.

## 8. Tools And Approvals

Tools are not granted by prompt text. They must pass `ToolGateway`.

Common tools:

- `read_file`
- `write_file`
- `run_tests`
- `web_search`
- `http_fetch`
- `browser`
- `github`
- `llm_wiki`
- `inspect_task`
- `create_task`

Approval-sensitive templates:

- `network_read`
- `network_write`
- `browser_interaction`
- `github_read`
- `github_write`
- `destructive_workspace`

HTTP tools block local/private network targets by default. For local development, prefer a precise allowlist:

```bash
EMILY_HTTP_EGRESS_ALLOWLIST=127.0.0.1 npm run web
```

Use `EMILY_HTTP_ALLOW_PRIVATE=true` only when you understand the SSRF tradeoff.

## 9. LLM Wiki Skill

Run `llm_wiki` as a separate service, then point AgentOS at its API:

```bash
export EMILY_LLM_WIKI_BASE_URL=http://127.0.0.1:6081
export EMILY_LLM_WIKI_TOKEN=your-shared-api-token
export EMILY_HTTP_EGRESS_ALLOWLIST=http://127.0.0.1:6081
```

Use the tool through CommandRegistry:

```json
{
  "tool": "llm_wiki",
  "role": "researcher",
  "permissionMode": "danger_full_access",
  "approval": {
    "approved": true,
    "template": "network_read",
    "reason": "query durable project knowledge"
  },
  "args": {
    "action": "query",
    "query": "AgentOS memory architecture",
    "topK": 5
  }
}
```

Supported actions:

- `query`, `health`, `status`, `concepts`: require `network_read`.
- `import_url`, `upload`, `analyze_page`: require `network_write`.

Keep `llm_wiki` as an independently deployed knowledge compiler. AgentOS only calls its API through the `llm-wiki` skill and audited `llm_wiki` tool.

## 10. GitHub Skill

The builtin `github` skill uses the `github` tool, which wraps structured GitHub operations and restricted `gh` commands.

Install and authenticate GitHub CLI:

```bash
gh auth login
gh auth status
```

Good GitHub tasks:

- inspect PR status;
- list issues;
- read CI state;
- comment on PRs or issues with approval;
- query repository metadata.

Use local file tools for detailed code review. GitHub metadata is not a replacement for reading the changed files.

## 11. Web Search

The builtin `web-search` skill uses `web_search` for discovery and `http_fetch` for specific URLs.

Providers:

- `duckduckgo`: default lightweight search.
- `endpoint`: custom endpoint via `EMILY_WEB_SEARCH_ENDPOINT`.
- `ollama`: Ollama experimental web search endpoint.

All search output is marked as untrusted external content. Treat snippets as leads, not facts.

## 12. Memory And Experience

Memory layers:

- short-term memory for active context;
- file memory for durable JSONL records;
- vector memory for semantic recall.

Experience is curated memory:

- daily extraction keeps only valuable lessons;
- similar experience is updated instead of duplicated;
- old revisions are archived;
- compressed vectors support fast recall.

Use experience for reusable decisions and best practices, not logs.

## 13. Skills

Builtin skills:

- `planning`
- `coding`
- `research`
- `web-search`
- `github`
- `review`
- `recovery`
- `memory-curation`

File skills live at:

```text
skills/<skill>/skill.md
```

Skill candidates are proposed from repeated successful workflows. Approve only skills that are reusable, stable, and worth keeping.

## 14. Runtime Operations

Doctor:

```bash
node src/index.ts --doctor --deep
```

Security audit:

```bash
node src/index.ts --security-audit
```

Maintenance:

Use the WebUI, gateway `maintenance.run`, or command registry.

Cron:

```bash
emily --cron
emily --cron-once
```

TUI commands:

```text
:cron
:cron-add "daily review" "0 9 * * *" "总结昨天的重要工作并沉淀经验"
:cron-pause <id>
:cron-resume <id>
:cron-run <id>
:cron-delete <id>
```

Gateway methods:

```json
{
  "type": "request",
  "id": "cron-1",
  "method": "cron.create",
  "params": {
    "name": "daily maintenance",
    "schedule": "@daily",
    "command": "maintenance.run"
  }
}
```

Provider usage:

```text
http://127.0.0.1:3000/providers/dashboard?token=<token>
```

Events:

```bash
curl 'http://127.0.0.1:3000/events?token=<token>'
```

## 15. Gateway Examples

Send chat:

```json
{
  "type": "request",
  "id": "1",
  "method": "chat.send",
  "params": {
    "message": "Review the current project for launch readiness",
    "sessionId": "launch",
    "permissionMode": "workspace_write"
  }
}
```

Run doctor:

```json
{
  "type": "request",
  "id": "2",
  "method": "doctor.run",
  "params": {
    "deep": true
  }
}
```

Cancel a run:

```json
{
  "type": "request",
  "id": "3",
  "method": "runs.cancel",
  "params": {
    "runId": "run-id",
    "reason": "operator cancelled"
  }
}
```

## 16. Troubleshooting

`provider.default_echo` appears:

Configure a real provider in `.emily/providers.json`.

WebUI says unauthorized:

Open with `?token=<token>` or enter the token when prompted.

HTTP tool cannot access localhost:

This is expected. Add `EMILY_HTTP_EGRESS_ALLOWLIST` for local development.

Node prints SQLite experimental warnings:

Upgrade to the current baseline. The runtime now uses `better-sqlite3` instead of Node's experimental `node:sqlite`, so direct `node src/index.ts ...` runs should stay quiet.

External vector tests are skipped:

Set `EMILY_VECTOR_INTEGRATION=true` and provide the needed vector database environment.

External provider tests are skipped:

Set `EMILY_PROVIDER_INTEGRATION=true` and provider environment variables.

## 17. Production Checklist

Before production use:

1. Set `EMILY_WEB_TOKEN` to a strong secret.
2. Configure a real model provider.
3. Keep raw API keys out of config files.
4. Review role tool permissions.
5. Keep `EMILY_HTTP_ALLOW_PRIVATE` disabled.
6. Run `npm run check`.
7. Run `npm audit --audit-level=moderate`.
8. Run `node src/index.ts --doctor --deep`.
9. Run `node src/index.ts --security-audit`.
10. Verify WebUI, TUI, and Gateway flows against your intended deployment.
