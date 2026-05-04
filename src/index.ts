import { createRuntime } from "./runtime/createRuntime.ts";
import { startTui } from "./adapters/tui.ts";
import { startWebServer } from "./adapters/web.ts";

const args = new Set(process.argv.slice(2));

if (args.has("--help") || args.has("-h")) {
  printHelp();
  process.exit(0);
}

const runtime = await createRuntime();

if (args.has("--security-audit")) {
  console.log(JSON.stringify(await runtime.securityAudit(), null, 2));
  await runtime.shutdown();
} else if (args.has("--doctor")) {
  console.log(JSON.stringify(await runtime.doctor({
    deep: args.has("--deep"),
    repair: args.has("--repair"),
  }), null, 2));
  await runtime.shutdown();
} else if (args.has("--cron-once")) {
  console.log(JSON.stringify(await runtime.cronScheduler.runDue(), null, 2));
  await runtime.shutdown();
} else if (args.has("--cron")) {
  console.log("Emily AgentOS cron scheduler running. Press Ctrl+C to stop.");
  await waitForShutdown();
  await runtime.shutdown();
} else if (args.has("--web")) {
  const port = Number(process.env.PORT || 3000);
  await startWebServer({ runtime, port });
} else {
  await startTui({ runtime });
}

function waitForShutdown(): Promise<void> {
  return new Promise((resolve) => {
    const done = () => resolve();
    process.once("SIGINT", done);
    process.once("SIGTERM", done);
  });
}

function printHelp(): void {
  console.log([
    "Emily AgentOS",
    "",
    "Usage:",
    "  emily                 start the terminal UI",
    "  emily --tui           start the terminal UI",
    "  emily --web           start the WebUI and Gateway",
    "  emily --cron          run the internal cron scheduler",
    "  emily --cron-once     run due cron jobs once",
    "  emily --doctor [--deep] [--repair]",
    "  emily --security-audit",
    "",
    "Environment:",
    "  EMILY_DATA_DIR        runtime state directory",
    "  EMILY_ROLE_DIR        role agent.md directory",
    "  EMILY_SKILL_DIR       skill directory",
    "  EMILY_WEB_TOKEN       WebUI/Gateway auth token",
    "  PORT                  WebUI port, default 3000",
  ].join("\n"));
}
