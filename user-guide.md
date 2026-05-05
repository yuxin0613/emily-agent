# Emily AgentOS User Guide

This guide explains how to use Emily AgentOS as a local multi-agent runtime and as a base for other agent applications.

## 1. Install And Check

One-command install:

```bash
curl -fsSL https://raw.githubusercontent.com/yuxin0613/emily-agent/master/scripts/install.sh | bash
```

The repository is private until the 1.0 hardening pass is complete, so this command requires GitHub access to `yuxin0613/emily-agent`. If the public GitHub URL is different, set `EMILY_REPO_URL` before running the installer.

SQLite persistence uses `better-sqlite3`. Most Node 22 platforms install a prebuilt binary; unsupported platforms may need local native build tools.

After installation:

```bash
emily --doctor --deep
emily model
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

Providers are stored in `.emily/config.json`. Existing `.emily/providers.json` files are migrated automatically on startup.

Use `echo` for local architecture tests only. Use `openai` or `ollama` for real model work.

Agent runtime limits live in the same file. Emily uses one ordered main-agent context and role-bound subagents: `agents.mainAgents` must stay `1`, and `agents.maxSubagentsPerRole` must stay `1` in the current stable runtime. Use `agents.maxConcurrentSubagents` to cap how many subagents can run at once, and `agents.subagentIdleTtlSeconds` plus `agents.releaseSubagentsAfterTask` to control when idle subagent processes are released.

The easiest setup path is:

```bash
emily model
```

This opens an interactive provider/model setup flow. It configures the main agent first. After that, choose any role that needs a custom provider/model; pressing Enter for a role keeps it inherited from the main agent.

OpenAI-compatible example:

```json
{
  "defaultProviderId": "openai-main",
  "fallbackMode": "fallback",
  "agents": {
    "mainAgents": 1,
    "maxSubagentsPerRole": 1,
    "maxConcurrentSubagents": 4,
    "releaseSubagentsAfterTask": true,
    "subagentIdleTtlSeconds": 60
  },
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
2. create an initial task graph shaped like a mind map;
3. execute ready tasks by role;
4. dynamically expand tasks when more detail is needed;
5. replan failed branches when possible;
6. review results;
7. summarize the outcome.

Task graphs separate two ideas:

- `parentKey` is the decomposition relationship: goal -> module -> slice -> executable leaf.
- `dependsOn` is the execution relationship: a task waits for another task to finish or succeed.

Inspect recent graphs from the TUI:

```text
/dag list
/dag list active
/sub
/dag <root_id>
/graph
/node architecture
```

The TUI remains responsive while a long job is running. You can type read-only commands such as `/dag list`, `/sub`, `/status`, or `/timeline` immediately. A normal message enters the main-agent context queue and runs after the current main-agent turn finishes, so main-agent context is handled in order. The home panel has a Run Log area for recent subagent, task, graph, anomaly, and tool execution events. `/sub` shows which subagent is currently running, the configured role, the task name, and task id.

`/dag <root_id>` opens the interactive DAG editor. Use up/down arrows to select a task node. Editor commands start with `:`:

```text
:add_before prepare the inputs before this task
:add_after verify the output after this task
:update replace the selected task instructions
:del
```

Trusted write clients can add or edit branches before they execute:

```text
/graph-add architecture api_slice developer "API slice"
/graph-update api_slice input "Implement only the API leaf slice."
```

Running and completed nodes are locked for graph editing.

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

## 9. External LLM Wiki Skill

`llm-wiki` is not bundled as a builtin AgentOS skill. Keep the skill package in the `llm_wiki` project and mount it into AgentOS as an external skill folder.

The external skill folder can be shaped like either:

```text
llm-wiki/skill.md
llm-wiki/SKILL.md
```

Mount it by dropping or symlinking the folder under the configured skill directory, or by adding another skill root:

```bash
export EMILY_SKILL_DIRS="/path/to/emily-agent/skills:/path/to/llm_wiki/agentos-skills"
```

Then run `llm_wiki` as a separate service and point AgentOS at its API:

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

Keep `llm_wiki` as an independently deployed knowledge compiler. AgentOS only calls its API when an external skill and a role explicitly opt into the audited `llm_wiki` tool.

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
skills/<skill>/SKILL.md
```

Mount additional skill roots with `EMILY_SKILL_DIRS` when a skill package lives in another project.

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

Configure a real provider in `.emily/config.json`.

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

1. Set `EMILY_WEB_TOKEN` to a strong admin secret.
2. Use `EMILY_WEB_READ_TOKEN` or `EMILY_WEB_WRITE_TOKEN` for non-admin WebSocket/REST clients.
3. Configure a real model provider.
4. Keep raw API keys out of config files.
5. Review role tool permissions.
6. Keep `EMILY_HTTP_ALLOW_PRIVATE` disabled.
7. Run `npm run check`.
8. Run `npm audit --audit-level=moderate`.
9. Run `node src/index.ts --doctor --deep`.
10. Run `node src/index.ts --security-audit`.
11. Verify WebUI, TUI, and Gateway flows against your intended deployment.
