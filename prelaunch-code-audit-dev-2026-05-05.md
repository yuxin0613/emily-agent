# Emily AgentOS dev 分支上线前全量代码审计报告

审计日期：2026-05-05  
审计分支：dev，当前 HEAD 为 `201660d Restore planner-led plan-only timeout`  
审计范围：所选项目全仓库，重点覆盖安全、发布风险、代码质量、正确性、测试与上线准备。

## 结论

当前分支不建议直接上线，建议判定为 No-Go，主要原因不是发现了可远程直接利用的高危漏洞，而是上线验证链路没有在当前环境完成闭环：`npm test`、`node src/index.ts --security-audit`、`node src/index.ts --doctor --deep` 均被原生依赖 `better-sqlite3` 的 `invalid ELF header` 阻断；`npm audit` 又被网络 allowlist 阻断。因此上线前 README 中声明的 launch checks 当前没有完成。代码层面安全边界整体较完整，包括 Web token、Origin 校验、工具审批、SSRF 私网拦截、SQLite 迁移与 worker lease token 机制，但仍存在若干发布前必须确认或建议修复的问题。

## 审计方法与验证结果

已检查项目结构、入口、Web/Gateway 控制面、工具执行器、HTTP egress、任务 worker、SQLite 迁移、安装/更新脚本和测试配置。项目为 Node.js/TypeScript ESM 工程，要求 Node `>=22.18`，使用 `better-sqlite3` 作为持久化驱动。核心入口为 `src/index.ts`，Web 控制面在 `src/adapters/web.ts`，工具执行器在 `src/tools/ToolExecutor.ts`，任务 worker 管理在 `src/tasks/RoleAgentManager.ts`，SQLite schema 在 `src/tasks/TaskStore.ts`。

验证命令执行情况如下：`npm run typecheck` 成功完成；`npm test` 启动后在 `better-sqlite3/build/Release/better_sqlite3.node` 报 `invalid ELF header`，导致测试未完成；因为命令串使用 `&&`，后续 `node src/index.ts --security-audit`、`node src/index.ts --doctor --deep` 未执行。单独执行 `npm audit --audit-level=moderate --json` 时 registry audit endpoint 返回 403，原因是网络 allowlist 阻断。仓库包含 `package-lock.json`，但当前环境中的 `node_modules/better-sqlite3` 原生模块与运行平台不匹配，疑似 macOS/宿主产物被挂载到 Linux 执行环境，或依赖安装不是在目标运行平台完成。

## 阻断级问题

### R1：上线验证链路被原生依赖平台不匹配阻断

证据：`package.json` 将 `npm run check` 定义为 `npm run typecheck && npm test`；README 第 118-125 行要求上线检查运行 `npm run check`、`npm audit --audit-level=moderate`、`node src/index.ts --doctor --deep`、`node src/index.ts --security-audit`。实际执行时，`npm run typecheck` 通过，但 `npm test` 在加载 `better-sqlite3` 原生模块时报 `invalid ELF header`。相关依赖在 `package.json` 第 23-25 行声明，SQLite 打开逻辑在 `src/storage/Sqlite.ts` 第 5-10 行通过 `better-sqlite3` 加载原生 binding。

影响：核心测试、runtime doctor、安全审计都依赖 SQLite 初始化，无法完成就不能证明当前 dev 分支满足上线基线。若目标部署环境也复用错误平台的 `node_modules`，应用启动即失败。

建议：在目标上线平台或 CI runner 中重新安装依赖，优先使用 `npm ci`，确保 `better-sqlite3` 原生 binding 与平台 ABI 匹配。上线门禁应在干净环境重跑 `npm run check`、`node src/index.ts --security-audit`、`node src/index.ts --doctor --deep`，并保留日志。不要把宿主机 `node_modules` 作为跨平台构建产物发布。

### R2：依赖漏洞审计未完成

证据：`npm audit --audit-level=moderate --json` 返回 403，错误头包含 `x-proxy-error: blocked-by-allowlist`。README 第 121-122 行明确将 `npm audit --audit-level=moderate` 作为上线检查。

影响：当前无法确认 `better-sqlite3`、TypeScript、Node 类型包及其传递依赖是否存在 moderate 以上漏洞。虽然依赖数量较少，但上线前合规链路不完整。

建议：在允许访问 npm audit endpoint 的 CI 或发布环境中执行依赖审计；若内网有制品库，应使用同源安全扫描工具或 SCA 工具生成等价报告。将 audit 结果纳入 release checklist。

## 高优先级问题

### H1：Web token 会打印到 stdout，生产日志可能泄露管理凭据

证据：`src/adapters/web.ts` 第 657-658 行启动 Web server 后打印 `Emily Agent web token: ${authToken}`。鉴权逻辑第 683-693 行中，匹配 `authToken` 的调用者获得 `danger` 权限；第 609-616 行 `/chat` 可触发运行时处理用户消息；第 223-225 行 `/tools/execute` 可进入工具执行路径。

影响：如果生产部署将 stdout 汇聚到共享日志平台，拥有日志读取权限的人可获得完整 Web/API/Gateway 管理 token。虽然默认 host 是 `127.0.0.1`，但用户或部署包装层可能更改 host 或通过反向代理暴露服务，日志泄露会扩大攻击面。

建议：生产模式下不要打印完整 token。可以只在随机生成 token 且交互式本地运行时打印一次；如果 `EMILY_WEB_TOKEN` 已由环境变量提供，应只打印 token 来源和截断指纹，例如前后 4 位或 hash。README 中也应明确禁止使用 `change-me` 作为生产 token。

### H2：Web/Gateway 支持 query token，容易通过 URL、Referer、代理日志泄露

证据：`src/adapters/web.ts` 第 696-702 行从 `x-emily-token`、`Authorization: Bearer` 和 URL query `token` 三处读取 token。README 第 114-116 行示例使用 `http://127.0.0.1:3000/?token=change-me`。`/providers/dashboard`、WebSocket upgrade 等路径也通过相同 `authenticate` 逻辑认证。

影响：query token 常被浏览器历史、反向代理日志、监控、Referer 或截图泄露。对于拥有 `danger` 权限的 admin token，这属于上线前应降低的凭据暴露风险。

建议：生产或非 localhost 访问场景禁用 query token，仅允许 header 或 Bearer token。至少在文档中区分本地开发示例和生产建议，并在服务端对 `host !== 127.0.0.1/localhost` 时拒绝 query token。

### H3：公共只读端点暴露 runtime 健康与 gateway 协议信息

证据：`src/adapters/web.ts` 第 120-123 行 `/health` 无需认证即返回 `{ ok: true, runtime: runtime.health(), gateway: gatewayProtocolSpec() }`。`gatewayProtocolSpec` 在 `src/gateway/GatewayProtocol.ts` 第 195-216 行返回完整方法列表和消息格式。

影响：在默认 localhost 下影响有限；如果被代理到网络环境，未认证健康端点会暴露运行时状态、gateway 能力面和方法枚举，增加信息收集面。对上线环境而言，健康检查通常应返回最小化状态，详细诊断应走认证端点。

建议：将 `/health` 拆分为 unauthenticated liveness 和 authenticated readiness/detail。公网或共享网络部署时，未认证 `/health` 只返回 `{ ok: true }`，详细 `runtime.health()` 和 gateway spec 移到认证端点。

### H4：HTTP egress allowlist 的通配实现过宽，`*.example.com` 会匹配 `badexample.com`

证据：`src/tools/ToolExecutor.ts` 第 1016-1020 行解析 `EMILY_HTTP_EGRESS_ALLOWLIST`，当条目以 `*.` 开头时使用 `hostname.endsWith(normalized.slice(1))`。对于 `*.example.com`，`normalized.slice(1)` 为 `.example.com`，这一点通常可以避免 `badexample.com`；但该逻辑没有显式校验边界和规范化尾点、punycode/IDNA 场景，也未拒绝 allowlist 中的畸形通配值。更重要的是第 1013 行 `EMILY_HTTP_ALLOW_PRIVATE=true` 会全量绕过私网拦截。

影响：当前实现比普通 `endsWith('example.com')` 安全一些，但上线前仍建议补足边界测试，尤其是尾点域名、大小写、IDNA、IPv6 literal、重定向到私网等场景。HTTP 工具可被 agent 调用并支持 POST，虽然有显式审批和敏感 header 禁止，但 egress 策略是重要安全边界。

建议：为 allowlist 增加专门单测，覆盖 `example.com`、`sub.example.com`、`badexample.com`、`example.com.`、IDNA、重定向到私网、DNS 解析只返回私网等情况。生产环境禁止设置 `EMILY_HTTP_ALLOW_PRIVATE=true`，除非运行在完全隔离的本地开发环境。

## 中优先级问题

### M1：WebSocket 消息处理缺少每连接速率限制和并发限制

证据：`src/adapters/web.ts` 第 822-848 行每收到 gateway message 就 `JSON.parse` 并 `await dispatchGatewayRequest`，第 939-943 行虽限制 frame 最大 1MB，但没有 per-connection request rate、队列长度或并发上限。REST 侧 `readJson` 有 body size 限制，WebSocket 侧也有 frame 限制，但持续发送大量合法 frame 仍可能造成任务/命令压力。

影响：在 token 泄露、弱 token 或服务被代理暴露时，攻击者可以通过 gateway 持续发起只读或写操作，造成资源消耗。即使本地部署，也可能被同机恶意进程滥用。

建议：为 WebSocket connection 增加 in-flight 限制、消息速率限制和 idle timeout。对 `chat.send`、`tools.execute`、`maintenance.run` 等高成本方法做更严格的队列和超时控制。

### M2：安装脚本默认从 master 安装，而用户审计目标是 dev，发布流程需要明确分支策略

证据：README 第 38-40 行说明 default install branch 是 `master`，dev 用于 active development and preview testing；`scripts/install.sh` 第 11-12 行默认 `REPO_URL` 为 GitHub 仓库、`BRANCH` 为 `master`；README 第 58-63 行提供了通过 `EMILY_BRANCH=dev` 安装开发分支的方法。

影响：如果这次要上线 dev 分支，现有 installer 默认仍会安装 master，可能导致“审计的是 dev，上线的是 master”或反之的分支漂移。更新命令 `src/updater.ts` 第 20-29 行调用本地 install.sh 并带用户参数，如果未显式传 branch，仍受 installer 默认和环境变量影响。

建议：发布前明确 dev 是否要合并到 master，还是以 `--branch dev` 发布预览版本。CI/release 脚本应固定 branch 或 commit SHA，避免运行时依赖默认值。审计报告和 release notes 中记录实际发布 commit。

### M3：生产安装模式可能遗漏 TypeScript 运行时所需条件验证

证据：README 第 6 行说明项目直接在 Node.js 22.18+ 上运行 TypeScript native type stripping；`package.json` 第 8-10 行直接 `node src/index.ts`。`scripts/install.sh` 支持 `--production`，第 168-176 行会 `npm ci --omit=dev` 或 `npm install --omit=dev`。当前依赖中 TypeScript 是 devDependency，但运行不依赖 tsc；不过测试、类型检查和编辑体验依赖 devDependencies。

影响：`--production` 安装后不能执行完整 `npm run check`，而 README 又将 typecheck/test 作为 launch checks。对于上线包来说，生产安装与验证安装的依赖集合不同，容易出现“验证环境通过，生产环境缺工具”的差异。

建议：区分 build/verify 阶段和 runtime 阶段。上线流水线应先用完整依赖跑检查，再生成或安装 runtime 产物。如果继续直接运行 `.ts` 源码，应确认目标 Node 版本支持所用 TypeScript 语法，并在 install 后运行最小 smoke/doctor。

### M4：`/commands/run` 和 Gateway `commands.run` 名义上是 read，但仍需确认命令注册表权限覆盖完整

证据：REST `/commands/run` 在 `src/adapters/web.ts` 第 273-280 行强制 `maxPermission: "read"`；Gateway 在 `src/gateway/GatewayProtocol.ts` 第 243-247 行也将 `commands.run` 视为 read，再通过 `scopeRuntime` 第 223-230 行限制 `runtime.runCommand` 权限。

影响：这是合理的纵深防御设计，但它依赖 `CommandRegistry` 中每个命令的 permission 元数据准确。如果未来新增写命令但权限标错为 read，`commands.run` 会成为放大面。

建议：增加测试确保所有 mutating command 都不能在 `maxPermission: read` 下执行。测试命名可以围绕 command registry permission matrix，覆盖 providers、roles、cron、sessions、graph、diagnostics repair、maintenance、tool.execute 等命令。

## 代码质量与可维护性观察

整体工程结构清晰，runtime、adapters、tools、tasks、llm、memory、skills、security 分层明确；TypeScript strict 已开启；工具执行器对文件路径、HTTP URL、敏感 header、GitHub shell metacharacter 做了较多防护；RoleAgentManager 使用 lease token 防止 stale worker 覆盖重试任务；SQLite schema 使用迁移器集中维护，索引也较完整。测试脚本覆盖面看起来较广，包括 web-hardening、gateway-context、tool-executor、migration、updater、cron、policy、vector adapter 等，这对上线前质量是加分项。

主要可维护性风险在于 `src/adapters/web.ts` 和 `src/tools/ToolExecutor.ts` 文件体量较大、职责较多。Web adapter 同时处理路由、认证、SSE、WebSocket、HTML dashboard；ToolExecutor 同时处理文件、HTTP、浏览器解析、Web search、GitHub、LLM wiki、审批和 egress。建议中长期拆分为 route modules、gateway socket module、egress policy module、github tool module 等，降低安全修改时的回归风险。

## 上线前建议清单

必须完成的上线门禁包括：在目标平台干净安装依赖并修复 `better-sqlite3 invalid ELF header`；重跑并通过 `npm run check`；重跑并通过 `node src/index.ts --security-audit` 和 `node src/index.ts --doctor --deep`；在可访问 registry 或企业 SCA 环境完成依赖漏洞审计；确认发布分支和 commit SHA；确认生产 Web token 不使用 `change-me`，不在日志中明文输出；确认如果 WebUI/Gateway 被代理暴露，则禁用 query token 或至少限制到 localhost。

建议上线前修复或补测试的项目包括：为 WebSocket 增加速率/并发限制；将未认证 `/health` 输出最小化；补足 HTTP egress allowlist、重定向、私网解析相关单测；为 CommandRegistry 增加权限矩阵测试；将 Web adapter 和 ToolExecutor 的高风险模块逐步拆分。

## Go / No-Go

当前建议：No-Go。原因是上线前验证未闭环，且存在凭据日志输出、query token、公开健康信息等生产暴露场景下的安全加固项。若本次只是本地预览或内测，可在明确限制为 localhost、使用强随机 token、重新安装平台匹配依赖并通过 `npm run check` 后有条件发布；若是面向真实用户或共享网络环境的上线，建议先完成上述阻断项和高优先级修复。
