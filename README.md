# Emily AgentOS

Emily AgentOS is a local-first Node.js multi-agent runtime for building agent applications. It gives you a main agent for conversation and orchestration, isolated role subagents for execution, SQLite-backed task state, adaptive task graphs, provider routing, tools, skills, sessions, memory, and a WebSocket control plane for other applications.

The current codebase is prepared for a 1.0 baseline: source typecheck, full test suite, dependency audit, runtime doctor, and security audit all pass in the default local setup.

> Runtime note: the project runs TypeScript directly on Node.js 22.18+ using native type stripping. SQLite persistence uses the stable `better-sqlite3` driver instead of Node's experimental `node:sqlite`.

## Why This Exists

Most agent applications need the same hard parts before they can become product code:

- durable task execution rather than in-memory plans;
- subagent isolation without losing a single coherent user conversation;
- long-running task graphs that can expand while work is happening;
- memory that becomes reusable experience instead of unlimited logs;
- provider, tool, skill, and permission boundaries that can be audited;
- Web/TUI/WebSocket surfaces that reuse one runtime instead of forking behavior.

Emily AgentOS is that substrate. It is not only a chat app; it is a base runtime for other agent products.

## Highlights

- **Main agent + role subagents**: main agent handles the user, planning, delegation, recovery, and final summaries; subagents run as independent worker processes.
- **Adaptive task graph**: `PlanSpec` creates a mind-map-like DAG from coarse goals to executable leaves, `GraphPatchSpec` expands nodes as work completes, and the executor tracks dependencies, waves, retries, and exit criteria.
- **Long task support**: result-oriented requests can require a delivery level such as `poc`, `uat`, or `production` before execution starts.
- **Hermes-inspired TUI flow**: the terminal UI uses a transcript/composer layout with compact prompt glyphs, live thinking feedback, and command hints.
- **Interactive model setup**: `emily model` supports keyboard navigation, provider templates, default base URLs, API-key environment storage, model discovery, custom models, and role-specific overrides.
- **SQLite as source of truth**: tasks, runs, sessions, events, memory candidates, provider usage, skill candidates, and experience revisions are persisted.
- **Lease token safety**: worker heartbeat, finish, fail, and cancel paths require the current lease token, so stale workers cannot overwrite a retried task.
- **Provider registry**: main agent and each role can choose separate providers/models; subagents fall back to the main provider when role-specific provider selection cannot be used.
- **Memory and experience**: short-term memory, file memory, vector memory, daily experience extraction, update-over-duplicate semantics, and compressed recall.
- **Tools and skills**: declarative tools with hard permission filtering; builtin skills for planning, coding, research, web search, GitHub, review, recovery, and memory curation; external skill folders can be mounted without code changes.
- **Control plane**: TUI, WebUI, REST endpoints, SSE events, and typed WebSocket gateway share the same runtime commands.
- **Security defaults**: token-protected Web/API, origin checks for unsafe methods, bounded HTTP bodies, tool approvals, SSRF denylist, provider secret validation, and runtime security audit.

## Project Status

Emily AgentOS is approaching a 1.0 baseline. The runtime is useful today, but agent behavior, provider templates, and TUI details can still change while hardening continues.

The default install branch is `master`. Active development and preview testing happen on `dev`.

## Quick Start

Requirements:

- Node.js `>=22.18`
- npm
- native SQLite driver support via `better-sqlite3`; prebuilt binaries are used when available, while unsupported platforms may need local build tools
- optional: `gh` for GitHub tool actions
- optional: external model API key, Ollama, or OpenAI-compatible gateway

One-command install from the default branch:

```bash
curl -fsSL https://raw.githubusercontent.com/yuxin0613/emily-agent/master/scripts/install.sh | bash
```

Install or update from the development branch:

```bash
EMILY_BRANCH=dev \
  curl -fsSL https://raw.githubusercontent.com/yuxin0613/emily-agent/master/scripts/install.sh | bash
```

If you host AgentOS in another Git repository, override the clone URL and branch:

```bash
EMILY_REPO_URL=https://github.com/your-org/emily-agent.git \
EMILY_BRANCH=main \
  curl -fsSL https://raw.githubusercontent.com/yuxin0613/emily-agent/master/scripts/install.sh | bash
```

The installer clones or updates the repo under `~/.emily/emily-agent`, installs Node dependencies, and creates `~/.local/bin/emily`.

Update an existing install:

```bash
emily update
emily update --branch dev
```

Run after install:

```bash
emily --doctor --deep
emily model
emily update
emily
EMILY_WEB_TOKEN=change-me emily --web
```

Manual install:

Install dependencies:

```bash
npm install
```

Run the terminal UI:

```bash
npm run tui
```

Run the WebUI and Gateway:

```bash
EMILY_WEB_TOKEN=change-me npm run web
```

Open:

```text
http://127.0.0.1:3000/?token=change-me
```

Run the launch checks:

```bash
npm run check
npm audit --audit-level=moderate
node src/index.ts --doctor --deep
node src/index.ts --security-audit
```

## Terminal UI

Start the local TUI:

```bash
emily
```

or, from a source checkout:

```bash
npm run tui
```

The TUI is designed around a compact transcript/composer loop:

| Glyph | Meaning |
| --- | --- |
| `❯` | User input and the active prompt. |
| `┊` | Assistant output, progress, and live thinking state. |
| `·` | Run metadata such as run id, delegated agents, and elapsed time. |
| `⚡` | Tool output in views that expose tool events. |

Typical flow:

1. Type a message after `❯`.
2. Press Enter to send.
3. If the runtime is waiting on a model call, the TUI shows an animated `┊ thinking...` line.
4. Plain chat stays conversational; task-like requests can still invoke planner/subagent execution.
5. Use `/help` for common commands, `/help all` for advanced commands, and `exit` or `quit` to leave.

The home screen is a live runtime dashboard, not a static banner:

| Area | What It Shows |
| --- | --- |
| `Available Tools:` | Tool groups currently registered in the active runtime. |
| `Available Skills:` | Skill groups currently loaded from builtin and configured skill roots. |
| `Run Log:` | Recent subagent, task graph, anomaly, and tool execution events. When idle it shows a waiting hint. |
| Status bar | Current provider model and provider id, current TUI session id, pending/running task counts, and open graph count. Values change as provider configuration, sessions, and runtime state change. |

The prompt area is the only input target. The TUI enables bracketed paste in capable terminals, keeps pasted content in the bottom prompt buffer, wraps long pasted text across prompt lines, preserves pasted line breaks, and submits the message only when Enter is pressed.

Useful TUI commands:

| Command | Purpose |
| --- | --- |
| `/help all` | Show advanced runtime, task, skill, and cron commands. |
| `/new [title]` | Start a new visible session. |
| `/clear` | Hide the current session and create a fresh one. |
| `/status` | Show current session/runtime status. |
| `/sub` | Show running subagents, their configured roles, task names, and task ids. |
| `/providers` | List configured providers. |
| `/tools` | List available tools. |
| `/skills` | List available skills. |
| `/timeline [runId]` | Inspect the latest or selected run timeline. |
| `/dag list` | List recent DAG roots, including queued/running ones. |
| `/dag <root_id>` | Open the interactive DAG editor for one root. |
| `/graph [runId]` | Render the task DAG as a mind-map tree. |
| `/node <key> [runId]` | Inspect one task node by graph key or task id. |
| `/graph-add <parent> <key> <role> <title>` | Add a child node under an unexecuted branch. |
| `/graph-update <key> <field> <value>` | Edit an unexecuted node field such as `title`, `input`, `role`, or `dependsOn`. |
| `/mode [mode]` | Show or set permission mode. |

While a long-running job is active, the TUI keeps accepting input. Read-only commands such as `/dag list`, `/sub`, `/status`, and `/timeline` run immediately. A normal chat/task message is added to the main-agent context queue and runs after the current main-agent turn finishes, so the main agent does not process multiple user contexts at the same time. The home panel includes a Run Log column showing recent subagent, task, graph, anomaly, and tool execution events.

## Model Setup

Run:

```bash
emily model
```

The model setup flow is interactive:

1. Choose an existing provider or `Add a provider` with the arrow keys.
2. Choose a provider template.
3. Enter an API key when the selected provider needs one. Keys are written to the local environment file and provider config stores only `apiKeyEnv`.
4. Confirm or edit the default base URL.
5. Let Emily discover available models when the provider exposes a compatible model endpoint.
6. Pick a default model, enter a custom model name, or skip and keep the current model.
7. Optionally configure role-specific providers/models for subagents.

Common provider templates:

| Template | Default base URL |
| --- | --- |
| OpenAI | `https://api.openai.com/v1` |
| DeepSeek | `https://api.deepseek.com/v1` |
| Alibaba Cloud DashScope / Qwen | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| Moonshot / Kimi | `https://api.moonshot.cn/v1` |
| Zhipu / GLM | `https://open.bigmodel.cn/api/paas/v4` |
| Baidu Qianfan | `https://qianfan.baidubce.com/v2` |
| Tencent Hunyuan | `https://api.hunyuan.cloud.tencent.com/v1` |
| Volcengine Doubao / Ark | `https://ark.cn-beijing.volces.com/api/v3` |
| MiniMax | `https://api.minimax.chat/v1` |
| Ollama | `http://127.0.0.1:11434/v1` |
| Custom provider | User-provided OpenAI-compatible URL |

## Configuration

Runtime state lives under `.emily/` by default:

```text
.emily/
  emily.sqlite
  config.json
  memory/
    events.jsonl
    vector-index.json
```

Runtime settings in `.emily/config.json`:

| Key | Purpose |
| --- | --- |
| `toolCallTimeoutSeconds` | Maximum time to wait for any single tool execution before returning a failed tool result. Default: `3600`. |
| `agents.mainAgents` | Number of main agents. Must be `1`; the main agent owns ordered user context and orchestration. |
| `agents.maxSubagentsPerRole` | Subagent limit per role. Must be `1` in the current stable model. |
| `agents.maxConcurrentSubagents` | Global cap for simultaneously running subagents. Default: based on local CPU, capped at `4`. |
| `agents.releaseSubagentsAfterTask` | Whether idle subagent worker processes are released after they finish work. Default: `true`. |
| `agents.subagentIdleTtlSeconds` | Idle time before releasing a finished subagent. Use `0` to release immediately. Default: `60`. |

Example:

```json
{
  "defaultProviderId": "main-deepseek",
  "fallbackMode": "strict",
  "toolCallTimeoutSeconds": 3600,
  "agents": {
    "mainAgents": 1,
    "maxSubagentsPerRole": 1,
    "maxConcurrentSubagents": 4,
    "releaseSubagentsAfterTask": true,
    "subagentIdleTtlSeconds": 60
  },
  "providers": []
}
```

Useful environment variables:

| Variable | Purpose |
| --- | --- |
| `PORT` | Web server port. Default: `3000`. |
| `EMILY_DATA_DIR` | Runtime state directory. Installer launcher defaults this to `~/.emily/data`. |
| `EMILY_WEB_TOKEN` | Full admin Web/API/Gateway token. If omitted, a random token is printed at startup. |
| `EMILY_WEB_READ_TOKEN` | Optional read-scoped Web/API/Gateway token for dashboards and query-only clients. |
| `EMILY_WEB_WRITE_TOKEN` | Optional write-scoped Web/API/Gateway token for trusted automation clients that must not run future danger commands. |
| `EMILY_ROLE_DIR` | Override `agents/` role definition directory. |
| `EMILY_SKILL_DIR` | Override `skills/` skill directory. |
| `EMILY_SKILL_DIRS` | Add one or more external skill roots, separated by the platform path separator (`:` on macOS/Linux, `;` on Windows). |
| `EMILY_HTTP_EGRESS_ALLOWLIST` | Comma-separated HTTP egress allowlist for private/local destinations. |
| `EMILY_HTTP_ALLOW_PRIVATE` | Set to `true` only for local development that must access private hosts. |
| `EMILY_WEB_SEARCH_PROVIDER` | `duckduckgo`, `endpoint`, or `ollama`. |
| `EMILY_WEB_SEARCH_ENDPOINT` | Custom web search endpoint for `provider=endpoint`. |
| `EMILY_LLM_WIKI_BASE_URL` | Base URL for the separately deployed LLM Wiki API, for example `http://127.0.0.1:6081`. |
| `EMILY_LLM_WIKI_TOKEN` | Shared API token for LLM Wiki. Falls back to `LLM_WIKI_API_TOKEN` or `API_ACCESS_TOKEN`. |
| `EMILY_VECTOR_STORE` | `file`, `chroma`, `qdrant`, `milvus`, or `pgvector`. |
| `OPENAI_API_KEY` | Default key used by OpenAI-compatible provider examples. |

## Providers

Provider config is stored in `.emily/config.json`. The runtime stores `apiKeyEnv`, never raw API keys. Existing `.emily/providers.json` files are migrated to `config.json` on startup.

Example OpenAI-compatible provider:

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
        "strictJson": true,
        "maxRetries": 2
      }
    }
  ]
}
```

Provider safeguards:

- OpenAI providers must specify `config.apiKeyEnv`.
- Raw `apiKey`, `authorization`, `token`, and `secret` config keys are rejected.
- Base URLs must be `http` or `https` and cannot include credentials.
- Provider usage, cost estimates, quotas, latency, and failures are tracked in SQLite.
- Circuit breaker and retry/backoff are handled by `ProviderRuntime`.

## Roles And Subagents

Role definitions live at:

```text
agents/<role>/agent.md
```

Each role can define:

- provider/model/temperature;
- singleton behavior;
- allowed and forbidden tools;
- max concurrent tasks;
- capabilities;
- skills;
- output contract;
- operating instructions.

Run `emily model` to configure the main agent provider/model first, then optionally customize individual roles. Roles with no explicit provider/model automatically inherit the main agent provider/model.

Builtin role presets:

| Role | Purpose |
| --- | --- |
| `planner` | Break requests into plans and graph tasks. |
| `developer` | Implement code and run verification. |
| `researcher` | Gather context from memory/files/current inputs. |
| `reviewer` | Validate outputs against acceptance criteria. |
| `inspector` | Inspect incomplete or suspicious tasks after failure. |
| `memory-curator` | Promote valuable work into reusable experience. |

The multi-agent model is intentionally conservative. There is exactly one main agent, and every agent is bound to one role. Each role has at most one active subagent; new work for that role is queued instead of spawning duplicate role workers. A global `agents.maxConcurrentSubagents` cap limits how many role workers can run at the same time, and idle subagents are released after `agents.subagentIdleTtlSeconds` when `agents.releaseSubagentsAfterTask` is enabled.

## Planning And Task Graphs

The runtime supports both small tasks and long-running result-oriented work.

Core concepts:

- `run`: one user request.
- `task`: one role-owned unit of work.
- `task_graph`: DAG for a run.
- `parentKey`: decomposition edge for the mind-map hierarchy, from goal to module to slice to leaf task.
- `task_dependencies`: execution dependency edges between tasks.
- `PlanSpec`: initial structured plan, usually coarse for large work.
- `GraphPatchSpec`: dynamic graph update emitted while the graph is running, used to expand a parent node one level finer.
- `TaskGraphExecutor`: executes ready tasks, expands rolling graph nodes, replans failed branches, and finalizes run state.

The DAG deliberately separates two relationships:

- **Decomposition** uses `parentKey`. This is the product-thinking shape of the graph: start broad, then refine into smaller branches.
- **Execution gating** uses `dependsOn`. This controls when a node is allowed to run, and supports `success` or `finished` dependency semantics.

The graph is inspectable while a run is active and after it completes. `dag.list` shows recent roots, `dag.list active` filters to queued/running roots, `graph.view` renders the parent/child decomposition as a text mind map, `graph.node` shows one node with dependencies and children, and `graph.add`/`graph.add_before`/`graph.add_after`/`graph.update`/`graph.delete` allow the main runtime or trusted clients to adjust branches that have not executed yet. Running and completed nodes are immutable through these graph-edit commands.

The TUI also has an interactive DAG editor:

```text
/dag list
/dag <root_id>
```

Inside the editor, use the up/down arrows to select a task node. Commands start with `:`:

```text
:add_before describe work to insert before this node
:add_after describe work to insert after this node
:update replace this node's instructions
:del
```

Delivery levels:

- `poc`: prove the idea works.
- `uat`: complete enough for user acceptance testing.
- `production`: include stronger verification, hardening, and operational readiness.

If a request looks like a long task but does not specify a delivery level, the run can enter `waiting_user` and ask for clarification before work starts.

## Memory, Experience, And Skills

Memory has three layers:

- short-term in-memory recall;
- file-backed JSONL memory;
- vector memory with file fallback or external adapters.

External vector adapters:

- Chroma;
- Qdrant;
- Milvus;
- pgvector, either host-injected driver or driver-backed integration.

Experience is higher-value memory:

- daily builder keeps only a few important lessons;
- matching prefers updating existing experience over creating duplicates;
- active experiences keep compressed vectors for recall;
- old revisions are archived rather than lost.

Skills are reusable workflows:

- builtin skills: `planning`, `coding`, `research`, `web-search`, `github`, `review`, `recovery`, `memory-curation`;
- file skills: `skills/<skill>/skill.md` or `skills/<skill>/SKILL.md`;
- external skill folders can be mounted with `EMILY_SKILL_DIRS`, using the platform path separator, or by dropping/symlinking a skill folder under the configured skill directory;
- skill candidates are proposed from repeated successful work and require approval before becoming active files.

## Tools And Permission Modes

Tools are declared in `ToolRegistry` and enforced by `ToolGateway`.

Builtin tools:

| Tool | Purpose |
| --- | --- |
| `read_file` | Read workspace files. |
| `write_file` | Write workspace files. |
| `run_tests` | Run approved test commands. |
| `create_task` | Create follow-up tasks. |
| `inspect_task` | Inspect task state and trace. |
| `web_search` | Bounded web search via DuckDuckGo, custom endpoint, or Ollama. |
| `http_fetch` | Bounded HTTP/HTTPS fetch. |
| `browser` | Lightweight browser-style page actions. |
| `github` | Structured GitHub PR/issue actions and restricted `gh` allowlist. |
| `llm_wiki` | Query or ingest durable knowledge through an external LLM Wiki service. |
| `delete_file` | Destructive workspace delete with approval. |
| `git_reset` | Declared high-risk capability; not executed by builtin executor. |
| `shell` | Declared broad capability; not executed by builtin executor. |
| `network` | Declared broad capability; use narrower network tools instead. |

Permission mode is an additional guard:

| Mode | Allowed by mode |
| --- | --- |
| `read_only` | `read_file`, `inspect_task` |
| `workspace_write` | `read_file`, `write_file`, `run_tests`, `create_task`, `inspect_task` |
| `danger_full_access` | role-defined tools, still constrained by forbidden tools and approvals |

Final permission is always:

```text
role.allowed_tools ∩ permissionMode.allowed_tools - role.forbidden_tools
```

Approval-sensitive tools require exact templates such as `network_read`, `browser_interaction`, `github_read`, `github_write`, or `destructive_workspace`.

## Web, REST, And Gateway

Start the server:

```bash
EMILY_WEB_TOKEN=change-me npm run web
```

Common HTTP endpoints:

```bash
TOKEN=change-me
curl 'http://127.0.0.1:3000/health'
curl 'http://127.0.0.1:3000/doctor?deep=true' -H "x-emily-token: $TOKEN"
curl 'http://127.0.0.1:3000/commands' -H "x-emily-token: $TOKEN"
curl 'http://127.0.0.1:3000/tools' -H "x-emily-token: $TOKEN"
curl 'http://127.0.0.1:3000/skills' -H "x-emily-token: $TOKEN"
curl 'http://127.0.0.1:3000/providers' -H "x-emily-token: $TOKEN"
curl 'http://127.0.0.1:3000/cron' -H "x-emily-token: $TOKEN"
curl 'http://127.0.0.1:3000/events?token='"$TOKEN"
```

WebSocket gateway:

```text
ws://127.0.0.1:3000/gateway?token=change-me
```

Request shape:

```json
{
  "type": "request",
  "id": "client-generated-id",
  "method": "chat.send",
  "params": {
    "message": "Build a small app to production readiness",
    "sessionId": "default",
    "permissionMode": "workspace_write"
  }
}
```

Gateway methods include chat, sessions, provider management, roles, tools, skills, cron jobs, experiences, timeline, graph inspection/editing, diagnostics, doctor, maintenance, security audit, context, router, task cancel, run cancel, and command execution.

Token scopes:

- `EMILY_WEB_TOKEN` is full admin access.
- `EMILY_WEB_WRITE_TOKEN` can call explicit read and write routes/methods; generic `commands.run` remains read-capped.
- `EMILY_WEB_READ_TOKEN` can call read routes/methods only.

## Cron Jobs

AgentOS includes an internal cron scheduler. It runs while the TUI, WebUI, or `--cron` process is alive; it does not install system crontab entries. Cron jobs are stored in `.emily/cron.json` or `EMILY_DATA_DIR/cron.json`.

Supported schedules are standard five-field cron expressions:

```text
minute hour day-of-month month day-of-week
```

Aliases are also supported: `@hourly`, `@daily`, `@weekly`, and `@monthly`.

Create a scheduled chat job:

```bash
emily --web
curl -X POST 'http://127.0.0.1:3000/cron' \
  -H "x-emily-token: $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"name":"daily review","schedule":"0 9 * * *","message":"总结昨天的重要工作并沉淀经验","sessionId":"daily"}'
```

Create a scheduled command job:

```bash
curl -X POST 'http://127.0.0.1:3000/cron' \
  -H "x-emily-token: $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"name":"daily maintenance","schedule":"@daily","command":"maintenance.run"}'
```

Run only the cron daemon:

```bash
emily --cron
```

Trigger due jobs once, useful from a system cron if you prefer external scheduling:

```bash
emily --cron-once
```

## Sessions

Sessions isolate conversation context.

TUI commands:

- `/new`: create a new session;
- `/clear`: create a new session and hide the old one;
- `/resume latest`: resume the latest visible session;
- `/export-session <id>`: export a session;
- `/compact-preview <id>`: preview compaction;
- `/session-usage <id>`: inspect usage.

Hidden or trashed sessions are not implicitly reactivated. Restores are explicit. Trash lifecycle supports delayed deletion.

## Security Model

Default protections:

- Web/API/Gateway routes require token auth except `/` and `/health`.
- Optional read/write scoped tokens limit REST and Gateway methods by CommandRegistry permission.
- Unsafe HTTP methods check origin.
- WebUI and provider dashboard do not embed the server token.
- HTTP request bodies and list limits are bounded.
- HTTP tools reject loopback, private networks, link-local, and cloud metadata addresses by default.
- Workspace file tools resolve real paths and reject symlink escapes.
- GitHub raw API calls are classified conservatively; mutating calls require write approval.
- Planner metadata is allowlisted, and task permission modes are clamped to inherited mode.
- Subagent tool requests do not self-approve approvals from planner/model metadata.
- Provider config rejects raw secrets.

Before exposing the server beyond loopback:

1. Set a strong `EMILY_WEB_TOKEN`.
2. Put the service behind TLS and network ACLs.
3. Use `EMILY_WEB_READ_TOKEN` or `EMILY_WEB_WRITE_TOKEN` for non-admin applications instead of sharing the admin token.
4. Keep `EMILY_HTTP_ALLOW_PRIVATE` unset.
5. Configure a real provider and run `node src/index.ts --security-audit`.
6. Run `npm run check`.
7. Review roles that allow network, browser, GitHub, or destructive tools.

## Development

Run all local checks:

```bash
npm run check
```

The check command runs source typecheck and the full test suite:

- smoke/recovery/restart/state machine;
- provider and usage;
- tools and skills;
- sessions and WebUI hardening;
- gateway context;
- command registry;
- role work product;
- planner graph and calibration;
- dynamic tasks;
- mock parity;
- vector adapters;
- memory optimization;
- experience;
- policy;
- migration.

Integration tests are opt-in:

```bash
EMILY_VECTOR_INTEGRATION=true npm run check
EMILY_PROVIDER_INTEGRATION=true npm run check
```

Before submitting a change, prefer:

```bash
npm run typecheck
node test/ui.test.ts
node test/model-config.test.ts
node test/chat-routing.test.ts
```

Run the full suite when touching runtime behavior, persistence, providers, planning, security, or command routing:

```bash
npm run check
```

## Contributing

Contributions are welcome when they keep the runtime auditable and local-first.

Please read [CONTRIBUTING.md](./CONTRIBUTING.md) before opening a pull request. In short:

- branch from `dev` for active development;
- keep pull requests focused;
- include tests or a clear reason tests are not needed;
- avoid committing secrets, generated state, `.emily/` data, or unrelated formatting churn;
- document user-facing behavior changes in this README or `user-guide.md`.

## Security Reporting

Please do not open a public issue for a suspected vulnerability. Follow [SECURITY.md](./SECURITY.md) for private reporting, expected triage, and supported-version guidance.

## Project Layout

```text
src/
  adapters/      TUI, WebUI, REST, SSE, WebSocket gateway
  agents/        main/subagent support and role work product shaping
  commands/      CommandRegistry shared by adapters
  context/       context budget and recall assembly
  experience/    active experience, revisions, compressed vectors
  gateway/       WebSocket protocol
  llm/           providers, JSON normalization, usage, retries
  memory/        memory layers and vector store adapters
  planning/      PlanSpec and GraphPatchSpec parsing/validation
  recovery/      worker crash and stale task recovery
  roles/         agent.md loader and role manager
  security/      runtime security audit
  skills/        skill registry and candidate builder
  tasks/         SQLite task store, graph executor, role process manager
  tools/         tool registry, gateway, executor, permission modes
  workers/       subagent worker process
test/
  harness/       deterministic mock parity harness
agents/
  <role>/agent.md
skills/
  <skill>/skill.md or <skill>/SKILL.md
```

## 1.0 Readiness Checklist

Current local baseline:

- `npm run check`: passing.
- `npm audit --audit-level=moderate`: passing.
- `node src/index.ts --doctor --deep`: passing.
- `node src/index.ts --security-audit`: passing with only `provider.default_echo` info finding.

To deploy a real 1.0 environment, replace the default `echo` provider with a production provider and rerun the checklist above.

## User Guide

See [user-guide.md](./user-guide.md) for day-to-day usage, provider setup, sessions, long tasks, tools, skills, memory, and operations.

## Third-Party Projects

Emily AgentOS keeps third-party references explicit so downstream agent applications can audit provenance and licensing clearly.

Design references:

- [OpenClaw](https://github.com/openclaw/openclaw): referenced for the Ollama-backed search extension pattern (`ollama_search`) and the GitHub skill shape. Emily AgentOS implements these ideas as native `web_search`/`github` tools and file-loadable skills under its existing ToolGateway, approval, role, and audit model.
- [NousResearch Hermes Agent](https://github.com/nousresearch/hermes-agent): referenced for installer ergonomics, local agent runtime packaging conventions, `hermes model`-style provider setup, and terminal transcript/composer interaction patterns. Hermes Agent is MIT-licensed; Emily AgentOS keeps its own runtime architecture and does not vendor Hermes source.

Optional integrations:

- [Ollama](https://ollama.com/): optional local provider/search backend.
- [GitHub CLI](https://cli.github.com/): optional executor for structured GitHub PR and issue operations.
- [DuckDuckGo](https://duckduckgo.com/): optional bounded web search source.
- [Chroma](https://www.trychroma.com/), [Qdrant](https://qdrant.tech/), [Milvus](https://milvus.io/), and [pgvector](https://github.com/pgvector/pgvector): optional external vector memory adapters.
- `llm_wiki`: optional separately deployed knowledge service integration through an external `llm-wiki` skill package and the audited `llm_wiki` tool.

Unless otherwise stated, referenced projects are not vendored into this repository; their own licenses apply to their projects and services.

## License

MIT. See [LICENSE](./LICENSE).
